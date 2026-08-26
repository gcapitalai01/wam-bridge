import makeWASocket, { DisconnectReason, fetchLatestWaWebVersion, downloadMediaMessage } from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import QRCode from 'qrcode';
import pino from 'pino';
import { useSupabaseAuthState } from './authState.js';

const logger = pino({ level: 'warn' });

// In-memory registry of live sockets + latest QR per business (single-process, fine for Render free tier)
const sessions = new Map(); // business_id -> { sock, qr, status }
const reconnectAttempts = new Map(); // business_id -> consecutive failed-reconnect count, for backoff

async function logError(supabase, businessId, context, error) {
  try {
    await supabase.from('admin_error_log').insert({
      business_id: businessId,
      source: 'whatsapp-qr-bridge',
      context,
      message: String(error?.message || error),
      created_at: new Date().toISOString(),
    });
  } catch (_) { /* never throw from logging */ }
}

async function setClientStatus(supabase, businessId, status, extra = {}) {
  await supabase.from('wam_clients').upsert(
    { business_id: businessId, status, updated_at: new Date().toISOString(), ...extra },
    { onConflict: 'business_id' }
  );
}

// Baileys' underlying WebSocket needs to actually finish connecting to WhatsApp's
// servers before requestPairingCode() can succeed — calling it right after
// makeWASocket() (same tick) throws "Connection Closed". Poll for readyState===1
// (OPEN) with a sane timeout instead of guessing with a fixed delay.
function waitForSocketReady(sock, timeoutMs = 12000) {
  return new Promise((resolve) => {
    const start = Date.now();
    const check = setInterval(() => {
      const ready = sock.ws?.socket?.readyState === 1;
      if (ready || Date.now() - start > timeoutMs) {
        clearInterval(check);
        resolve(ready);
      }
    }, 200);
  });
}

async function requestPairingCode(supabase, businessId, sock, phoneNumber) {
  const ready = await waitForSocketReady(sock);
  if (!ready) throw new Error('WhatsApp socket did not become ready in time');
  const cleanNumber = phoneNumber.replace(/[^0-9]/g, '');
  return sock.requestPairingCode(cleanNumber);
}

async function forwardToBrain({ supabaseUrl, businessId, from, text, pushName, mediaUrl, mediaType }) {
  const bridgeSecret = process.env.WHATSAPP_BRIDGE_SECRET; // must match the edge function's secret
  const resp = await fetch(`${supabaseUrl}/functions/v1/whatsapp-webhook`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(bridgeSecret ? { 'x-bridge-secret': bridgeSecret } : {}),
    },
    body: JSON.stringify({
      business_id: businessId,
      phone: from,
      message: text,
      push_name: pushName || null,
      media_url: mediaUrl || null,
      media_type: mediaType || null, // 'image' | 'audio' | 'document'
    }),
  });
  if (!resp.ok) {
    const body = await resp.text().catch(() => '');
    throw new Error(`whatsapp-webhook HTTP ${resp.status}: ${body.slice(0, 300)}`);
  }
  const data = await resp.json();
  return data.reply ?? null;
}

// Detects which kind of media (if any) is in an inbound message, downloads the raw bytes
// straight from WhatsApp's CDN, and uploads them to Supabase Storage — never to Render's
// disk, which is ephemeral and gets wiped on every deploy/restart anyway.
async function uploadInboundMedia(supabase, sock, msg, businessId) {
  const m = msg.message;
  const kind = m.imageMessage ? 'image' : m.audioMessage ? 'audio' : (m.documentMessage || m.documentWithCaptionMessage) ? 'document' : null;
  if (!kind) return null;

  const buffer = await downloadMediaMessage(msg, 'buffer', {}, { logger, reuploadRequest: sock.updateMediaMessage });
  const mediaMsg = m.imageMessage || m.audioMessage || m.documentMessage || m.documentWithCaptionMessage?.message?.documentMessage;
  const mimetype = mediaMsg?.mimetype || 'application/octet-stream';
  const extFromMime = mimetype.split('/')[1]?.split(';')[0] || 'bin';
  const originalName = mediaMsg?.fileName;
  const ext = originalName?.match(/\.[a-zA-Z0-9]+$/)?.[0] || `.${extFromMime}`;
  const path = `${businessId}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}${ext}`;

  const { error } = await supabase.storage.from('whatsapp-inbound').upload(path, buffer, { contentType: mimetype });
  if (error) throw error;
  const { data: urlData } = supabase.storage.from('whatsapp-inbound').getPublicUrl(path);
  return { url: urlData.publicUrl, type: kind, mimetype };
}

export async function startSession({ supabase, supabaseUrl, serviceKey, businessId, phoneNumber }) {
  const existing = sessions.get(businessId);
  if (existing && existing.sock) {
    // Already running — if a phone number was just given and no code exists yet, request one on the live socket.
    if (phoneNumber && !existing.sock.authState?.creds?.registered) {
      try {
        existing.pairingCode = await requestPairingCode(supabase, businessId, existing.sock, phoneNumber);
        existing.pairingRequestedAt = Date.now();
      } catch (err) {
        await logError(supabase, businessId, 'requestPairingCode', err);
      }
    }
    return existing;
  }

  const { state, saveCreds, clearAll } = await useSupabaseAuthState(supabase, businessId);
  const { version } = await fetchLatestWaWebVersion({});

  const sock = makeWASocket({
    version,
    auth: state,
    logger,
    printQRInTerminal: false,
    browser: ['G Capital AI', 'Chrome', '1.0.0'],
  });

  const entry = { sock, qr: null, pairingCode: null, pairingRequestedAt: null, status: 'connecting' };
  sessions.set(businessId, entry);
  await setClientStatus(supabase, businessId, 'connecting');

  // PRIMARY METHOD: pairing code — the customer types this code into their own phone
  // (WhatsApp > Linked Devices > Link with phone number), no second screen/camera needed.
  // FALLBACK: if no phone number was given, or the pairing code request fails, the
  // 'qr' event below still fires normally and the dashboard can show the QR instead.
  if (phoneNumber && !state.creds.registered) {
    try {
      entry.pairingCode = await requestPairingCode(supabase, businessId, sock, phoneNumber);
      entry.pairingRequestedAt = Date.now();
      entry.status = 'pairing_pending';
      await setClientStatus(supabase, businessId, 'pairing_pending');
    } catch (err) {
      await logError(supabase, businessId, 'requestPairingCode', err);
      // no return — falls through to QR fallback via connection.update below
    }
  }

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      entry.qr = await QRCode.toDataURL(qr);
      // Only surface QR-driven status if we're not already mid pairing-code flow.
      if (entry.status !== 'pairing_pending' && !entry.pairingCode) {
        entry.status = 'qr_pending';
        await setClientStatus(supabase, businessId, 'qr_pending');
      }
    }

    if (connection === 'open') {
      entry.qr = null;
      entry.pairingCode = null;
      entry.status = 'connected';
      reconnectAttempts.delete(businessId);
      const phone = sock.user?.id?.split(':')[0] || null;
      await setClientStatus(supabase, businessId, 'connected', { phone });
    }

    if (connection === 'close') {
      const statusCode = new Boom(lastDisconnect?.error)?.output?.statusCode;
      const loggedOut = statusCode === DisconnectReason.loggedOut;
      entry.pairingCode = null;

      if (loggedOut) {
        entry.status = 'disconnected';
        await setClientStatus(supabase, businessId, 'disconnected');
        await clearAll();
        sessions.delete(businessId);
        reconnectAttempts.delete(businessId);
        await logError(supabase, businessId, 'connection.close', 'Session logged out — must re-scan QR');
      } else {
        // Transient drop (network blip, Render redeploy, WA server hiccup, etc.) — never give up.
        // Backs off gradually (4s, 8s, 16s... capped at 60s) so a flaky network doesn't hammer WhatsApp's servers.
        entry.status = 'reconnecting';
        await setClientStatus(supabase, businessId, 'reconnecting');
        const attempt = (reconnectAttempts.get(businessId) || 0) + 1;
        reconnectAttempts.set(businessId, attempt);
        const delay = Math.min(4000 * Math.pow(2, attempt - 1), 60000);
        sessions.delete(businessId);
        await logError(supabase, businessId, 'connection.close', lastDisconnect?.error || 'unknown disconnect');
        setTimeout(() => {
          startSession({ supabase, supabaseUrl, serviceKey, businessId }).catch((e) =>
            logError(supabase, businessId, 'reconnect.failed', e)
          );
        }, delay).unref?.();
      }
    }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;

    for (const msg of messages) {
      try {
        if (!msg.message || msg.key.fromMe) continue;
        const from = msg.key.remoteJid;
        if (!from || from.endsWith('@g.us') || from === 'status@broadcast') continue; // ignore groups/status

        const text =
          msg.message.conversation ||
          msg.message.extendedTextMessage?.text ||
          msg.message.imageMessage?.caption ||
          msg.message.documentMessage?.caption ||
          null;

        let media = null;
        try {
          media = await uploadInboundMedia(supabase, sock, msg, businessId);
        } catch (mediaErr) {
          await logError(supabase, businessId, 'uploadInboundMedia', mediaErr);
        }

        if (!text && !media) continue; // nothing usable (e.g. a reaction, a status update, etc.)

        const phoneNumber = from.split('@')[0];

        await supabase.from('wam_messages').insert({
          business_id: businessId,
          direction: 'in',
          phone: phoneNumber,
          text,
          media_url: media?.url || null,
          media_type: media?.type || null,
          created_at: new Date().toISOString(),
        });

        const reply = await forwardToBrain({
          supabaseUrl,
          businessId,
          from: phoneNumber,
          text,
          pushName: msg.pushName,
          mediaUrl: media?.url || null,
          mediaType: media?.type || null,
        });

        if (reply) {
          await sock.sendMessage(from, { text: reply });
          await supabase.from('wam_messages').insert({
            business_id: businessId,
            direction: 'out',
            phone: phoneNumber,
            text: reply,
            created_at: new Date().toISOString(),
          });
        }
      } catch (err) {
        await logError(supabase, businessId, 'messages.upsert', err);
      }
    }
  });

  return entry;
}

export function getSession(businessId) {
  return sessions.get(businessId) || null;
}

// Called once on server boot. Sessions live only in memory — if Render restarts/redeploys
// the process, WhatsApp would otherwise stay silently offline until someone opens the
// dashboard and clicks reconnect. This finds every business that was connected (or mid-connect)
// before the restart and resumes them automatically, using their saved Supabase auth state.
export async function resumeAllSessions({ supabase, supabaseUrl, serviceKey }) {
  try {
    const { data: rows, error } = await supabase
      .from('wam_clients')
      .select('business_id, status')
      .in('status', ['connected', 'connecting', 'reconnecting', 'pairing_pending', 'qr_pending']);
    if (error) throw error;
    if (!rows?.length) return;

    console.log(`Resuming ${rows.length} WhatsApp session(s) after restart...`);
    for (const row of rows) {
      startSession({ supabase, supabaseUrl, serviceKey, businessId: row.business_id }).catch((e) =>
        logError(supabase, row.business_id, 'resumeAllSessions', e)
      );
    }
  } catch (err) {
    console.error('resumeAllSessions failed:', err);
  }
}

export async function sendTextMessage({ businessId, phone, text }) {
  const entry = sessions.get(businessId);
  if (!entry?.sock) throw new Error('No active WhatsApp session for this business.');
  if (entry.status !== 'connected') throw new Error(`WhatsApp session is not connected (status: ${entry.status}).`);
  const jid = phone.includes('@') ? phone : `${phone.replace(/[^0-9]/g, '')}@s.whatsapp.net`;
  const result = await entry.sock.sendMessage(jid, { text });
  return { externalMessageId: result?.key?.id || null };
}

// Used by the AI's send_catalog_item tool — sends a business's product photo, price-list
// PDF, or voice note (whatever's saved in business_assets) straight from its Supabase URL.
export async function sendMediaMessage({ businessId, phone, url, mimetype, caption, fileName }) {
  const entry = sessions.get(businessId);
  if (!entry?.sock) throw new Error('No active WhatsApp session for this business.');
  if (entry.status !== 'connected') throw new Error(`WhatsApp session is not connected (status: ${entry.status}).`);
  const jid = phone.includes('@') ? phone : `${phone.replace(/[^0-9]/g, '')}@s.whatsapp.net`;

  let content;
  if (mimetype?.startsWith('image/')) {
    content = { image: { url }, caption: caption || undefined };
  } else if (mimetype?.startsWith('audio/')) {
    content = { audio: { url }, mimetype, ptt: false };
  } else {
    content = { document: { url }, mimetype: mimetype || 'application/pdf', fileName: fileName || 'catalogo.pdf', caption: caption || undefined };
  }

  const result = await entry.sock.sendMessage(jid, content);
  return { externalMessageId: result?.key?.id || null };
}

export async function stopSession({ supabase, businessId }) {
  const entry = sessions.get(businessId);
  if (entry?.sock) {
    try { await entry.sock.logout(); } catch (_) {}
  }
  sessions.delete(businessId);
  await setClientStatus(supabase, businessId, 'disconnected');
}
