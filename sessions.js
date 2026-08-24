import makeWASocket, { DisconnectReason, fetchLatestBaileysVersion } from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import QRCode from 'qrcode';
import pino from 'pino';
import { useSupabaseAuthState } from './authState.js';

const logger = pino({ level: 'warn' });

// In-memory registry of live sockets + latest QR per business (single-process, fine for Render free tier)
const sessions = new Map(); // business_id -> { sock, qr, status }

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

async function forwardToBrain({ supabaseUrl, businessId, from, text, pushName }) {
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
    }),
  });
  if (!resp.ok) {
    const body = await resp.text().catch(() => '');
    throw new Error(`whatsapp-webhook HTTP ${resp.status}: ${body.slice(0, 300)}`);
  }
  const data = await resp.json();
  return data.reply ?? null;
}

export async function startSession({ supabase, supabaseUrl, serviceKey, businessId, phoneNumber }) {
  const existing = sessions.get(businessId);
  if (existing && existing.sock) {
    // Already running — if a phone number was just given and no code exists yet, request one on the live socket.
    if (phoneNumber && !existing.pairingCode && !existing.sock.authState?.creds?.registered) {
      try {
        const cleanNumber = phoneNumber.replace(/[^0-9]/g, '');
        existing.pairingCode = await existing.sock.requestPairingCode(cleanNumber);
        existing.pairingRequestedAt = Date.now();
      } catch (err) {
        await logError(supabase, businessId, 'requestPairingCode', err);
      }
    }
    return existing;
  }

  const { state, saveCreds, clearAll } = await useSupabaseAuthState(supabase, businessId);
  const { version } = await fetchLatestBaileysVersion();

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
      const cleanNumber = phoneNumber.replace(/[^0-9]/g, '');
      entry.pairingCode = await sock.requestPairingCode(cleanNumber);
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
      if (entry.status !== 'pairing_pending') {
        entry.status = 'qr_pending';
        await setClientStatus(supabase, businessId, 'qr_pending');
      }
    }

    if (connection === 'open') {
      entry.qr = null;
      entry.pairingCode = null;
      entry.status = 'connected';
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
        await logError(supabase, businessId, 'connection.close', 'Session logged out — must re-scan QR');
      } else {
        // Transient drop (network, restart, ban-check, etc.) — try to reconnect.
        entry.status = 'reconnecting';
        await setClientStatus(supabase, businessId, 'reconnecting');
        sessions.delete(businessId);
        await logError(supabase, businessId, 'connection.close', lastDisconnect?.error || 'unknown disconnect');
        setTimeout(() => {
          startSession({ supabase, supabaseUrl, serviceKey, businessId }).catch((e) =>
            logError(supabase, businessId, 'reconnect.failed', e)
          );
        }, 4000);
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
          null;
        if (!text) continue; // non-text media: log only, no auto-reply for now

        const phoneNumber = from.split('@')[0];

        await supabase.from('wam_messages').insert({
          business_id: businessId,
          direction: 'in',
          phone: phoneNumber,
          text,
          created_at: new Date().toISOString(),
        });

        const reply = await forwardToBrain({
          supabaseUrl,
          businessId,
          from: phoneNumber,
          text,
          pushName: msg.pushName,
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

export async function stopSession({ supabase, businessId }) {
  const entry = sessions.get(businessId);
  if (entry?.sock) {
    try { await entry.sock.logout(); } catch (_) {}
  }
  sessions.delete(businessId);
  await setClientStatus(supabase, businessId, 'disconnected');
}
