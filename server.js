// ============================================================
// G CAPITAL AI — WhatsApp Bridge (Baileys)
// ============================================================
// Express + Baileys server, multi-tenant (one session per businessId).
// Matches EXACTLY the contract already used by whatsapp-connect (Supabase):
//
//   POST /session/:businessId/start   { phoneNumber? }  -> { pairingCode? } or starts QR
//   GET  /session/:businessId/qr                        -> { qr: "data:image/png;base64,..." }
//   GET  /session/:businessId/status                    -> { status, phone }
//   POST /session/:businessId/stop
//   POST /session/:businessId/send        { phone, text }
//   POST /session/:businessId/send-media  { phone, url, mimetype, caption, fileName }
//
// All routes require the header:  x-bridge-key: whatsapp-QR
//
// NEW in this version (Sep 2, 2026):
//   - Coexistence: if the owner writes from their own phone (fromMe), notifies
//     human-takeover-ping so the AI stays silent for exactly 2 minutes on that chat.
//   - Filters groups (@g.us), channels/newsletters (@broadcast, @newsletter) and status@broadcast
//     BEFORE forwarding anything — the AI never receives junk.
//   - Forwards every real incoming message (text/image/audio/document) to whatsapp-webhook
//     in the format it already expects (business_id, phone, message, push_name, media_url, media_type).
//   - sendPresenceUpdate('composing') before every send, like the rest of the platform.
//   - Automatic reconnection with simple backoff; does NOT reconnect if the reason is a real logout
//     (in that case you must re-pair from the dashboard).
// ============================================================

import express from "express";
import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  downloadMediaMessage,
  fetchLatestBaileysVersion,
} from "@whiskeysockets/baileys";
import { createClient } from "@supabase/supabase-js";
import QRCode from "qrcode";
import pino from "pino";
import fs from "fs/promises";

// ---------- Config (environment variables in Render) ----------
const PORT = process.env.PORT || 3000;
const BRIDGE_KEY = process.env.BRIDGE_API_KEY || "whatsapp-QR";
const SUPABASE_URL = process.env.SUPABASE_URL || "https://wkpvlgfirechfeppfutg.supabase.co";
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const WHATSAPP_WEBHOOK_URL = `${SUPABASE_URL}/functions/v1/whatsapp-webhook`;
const HUMAN_TAKEOVER_PING_URL = `${SUPABASE_URL}/functions/v1/human-takeover-ping`;
const WHATSAPP_BRIDGE_SECRET = process.env.WHATSAPP_BRIDGE_SECRET || ""; // optional, if you also configure it in whatsapp-webhook

if (!SUPABASE_SERVICE_ROLE_KEY) {
  console.error("FALTA SUPABASE_SERVICE_ROLE_KEY en las variables de entorno de Render.");
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
const logger = pino({ level: process.env.LOG_LEVEL || "warn" });

// ---------- In-memory state: one Baileys session per business ----------
/** @type {Map<string, { sock: any, qr: string|null, status: string, phone: string|null, connecting: boolean }>} */
const sessions = new Map();

function getSessionState(businessId) {
  if (!sessions.has(businessId)) {
    sessions.set(businessId, { sock: null, qr: null, status: "disconnected", phone: null, connecting: false });
  }
  return sessions.get(businessId);
}

// JIDs to ALWAYS ignore: groups, channels/newsletters, status broadcasts.
function isIgnorableJid(jid) {
  if (!jid) return true;
  return jid.endsWith("@g.us") || jid.endsWith("@broadcast") || jid.endsWith("@newsletter") || jid === "status@broadcast";
}

function jidToPhone(jid) {
  return (jid || "").split("@")[0].split(":")[0];
}

// ---------- WhatsApp session on Render's PERSISTENT DISK (mounted at /data) ----------
// Uses Baileys' native, battle-tested method. Requires a persistent disk in Render
// (Dashboard → this service → Disks → Add Disk → mount path /data) to survive restarts.
const SESSION_ROOT = process.env.SESSION_DIR || "/data/sessions";
async function updateWamClientStatus(businessId, status, phone) {
  try {
    await supabase.from("wam_clients").upsert(
      { business_id: businessId, status, phone: phone || null, updated_at: new Date().toISOString() },
      { onConflict: "business_id" }
    );
  } catch (err) {
    logger.error({ err }, "No se pudo actualizar wam_clients");
  }
}

async function pingHumanTakeover(businessId, phone) {
  try {
    await fetch(HUMAN_TAKEOVER_PING_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ business_id: businessId, phone }),
    });
  } catch (err) {
    logger.warn({ err }, "human-takeover-ping failed (non-blocking)");
  }
}

async function uploadMediaToSupabase(businessId, buffer, ext, contentType) {
  const fileName = `whatsapp-media/${businessId}/${Date.now()}.${ext}`;
  const { error } = await supabase.storage.from("generated-content").upload(fileName, buffer, { contentType });
  if (error) {
    logger.error({ error }, "Fallo subiendo media de WhatsApp a Supabase");
    return null;
  }
  const { data } = supabase.storage.from("generated-content").getPublicUrl(fileName);
  return data.publicUrl;
}

async function forwardIncomingToAI(businessId, payload) {
  try {
    const headers = { "Content-Type": "application/json" };
    if (WHATSAPP_BRIDGE_SECRET) headers["x-bridge-secret"] = WHATSAPP_BRIDGE_SECRET;
    const res = await fetch(WHATSAPP_WEBHOOK_URL, { method: "POST", headers, body: JSON.stringify(payload) });
    const data = await res.json().catch(() => ({}));
    return data;
  } catch (err) {
    logger.error({ err }, "No se pudo reenviar el mensaje a whatsapp-webhook");
    return null;
  }
}

// ---------- Extracts text / media type from a Baileys message ----------
function extractMessageContent(msg) {
  const m = msg.message;
  if (!m) return { text: "", mediaType: null };

  if (m.conversation) return { text: m.conversation, mediaType: null };
  if (m.extendedTextMessage?.text) return { text: m.extendedTextMessage.text, mediaType: null };
  if (m.imageMessage) return { text: m.imageMessage.caption || "", mediaType: "image" };
  if (m.audioMessage) return { text: "", mediaType: "audio" };
  if (m.documentMessage) return { text: m.documentMessage.caption || m.documentMessage.fileName || "", mediaType: "document" };
  if (m.videoMessage) return { text: m.videoMessage.caption || "", mediaType: "document" }; // treated as a document for simplicity
  return { text: "", mediaType: null };
}

// ---------- Creates/starts a session for a business ----------
async function startSession(businessId, phoneNumberForPairing) {
  const state = getSessionState(businessId);
  if (state.connecting) return state;
  state.connecting = true;

  const { state: authState, saveCreds } = await useMultiFileAuthState(`${SESSION_ROOT}/${businessId}`);
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    auth: authState,
    printQRInTerminal: false,
    logger,
    browser: ["G Capital AI", "Chrome", "1.0"],
  });

  state.sock = sock;
  state.status = "qr_pending";

  // Pairing by code (no QR) — requested only once, right after creating the socket.
  if (phoneNumberForPairing && !authState.creds.registered) {
    try {
      const code = await sock.requestPairingCode(phoneNumberForPairing.replace(/[^0-9]/g, ""));
      state.pairingCode = code;
    } catch (err) {
      logger.error({ err }, "Could not generate pairing code");
    }
  }

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      state.qr = await QRCode.toDataURL(qr);
      state.status = "qr_pending";
    }

    if (connection === "open") {
      state.status = "connected";
      state.qr = null;
      state.phone = jidToPhone(sock.user?.id);
      state.connecting = false;
      await updateWamClientStatus(businessId, "connected", state.phone);
      logger.info(`[${businessId}] WhatsApp conectado (${state.phone})`);
    }

    if (connection === "close") {
      state.connecting = false;
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const loggedOut = statusCode === DisconnectReason.loggedOut || statusCode === 401;

      if (loggedOut) {
        state.status = "disconnected";
        await updateWamClientStatus(businessId, "disconnected", state.phone);
        try { await fs.rm(`${SESSION_ROOT}/${businessId}`, { recursive: true, force: true }); } catch (_) {}
        logger.warn(`[${businessId}] Session closed by WhatsApp — saved session deleted. Must re-pair from the dashboard (new QR/code).`);
      } else {
        state.status = "reconnecting";
        await updateWamClientStatus(businessId, "reconnecting", state.phone);
        setTimeout(() => startSession(businessId), 3000);
      }
    }
  });

  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    if (type !== "notify") return;

    for (const msg of messages) {
      const jid = msg.key.remoteJid;
      if (isIgnorableJid(jid)) continue;
      if (!msg.message) continue;

      const phone = jidToPhone(jid);

      // COEXISTENCE: the owner wrote from their own phone -> pause the AI for 2 minutes.
      if (msg.key.fromMe) {
        pingHumanTakeover(businessId, phone).catch(() => {});
        continue; // don't forward the owner's own messages as if they were from the customer
      }

      const { text, mediaType } = extractMessageContent(msg);
      const pushName = msg.pushName || null;

      let mediaUrl = null;
      if (mediaType) {
        try {
          const buffer = await downloadMediaMessage(msg, "buffer", {}, { logger });
          const extMap = { image: "jpg", audio: "ogg", document: "pdf" };
          const contentTypeMap = { image: "image/jpeg", audio: "audio/ogg", document: "application/octet-stream" };
          mediaUrl = await uploadMediaToSupabase(businessId, buffer, extMap[mediaType] || "bin", contentTypeMap[mediaType]);
        } catch (err) {
          logger.error({ err }, "No se pudo descargar/subir el archivo multimedia entrante");
        }
      }

      const aiResult = await forwardIncomingToAI(businessId, {
        business_id: businessId,
        phone,
        message: text,
        push_name: pushName,
        media_url: mediaUrl,
        media_type: mediaType,
      });

      if (aiResult?.reply) {
        try {
          await sock.presenceSubscribe(jid).catch(() => {});
          await sock.sendPresenceUpdate("composing", jid);
          await new Promise((r) => setTimeout(r, 1200));
          await sock.sendMessage(jid, { text: aiResult.reply });
          await sock.sendPresenceUpdate("paused", jid);
        } catch (err) {
          logger.error({ err }, "No se pudo enviar la respuesta de la IA");
        }
      }
    }
  });

  return state;
}

// ---------- Express ----------
const app = express();
app.use(express.json({ limit: "20mb" }));

function requireBridgeKey(req, res, next) {
  if (req.headers["x-bridge-key"] !== BRIDGE_KEY) {
    return res.status(401).json({ error: "unauthorized" });
  }
  next();
}

app.get("/", (_req, res) => res.json({ ok: true, service: "G Capital AI WhatsApp Bridge" }));

app.post("/session/:businessId/start", requireBridgeKey, async (req, res) => {
  const { businessId } = req.params;
  const { phoneNumber } = req.body || {};
  try {
    const state = await startSession(businessId, phoneNumber);
    if (phoneNumber && state.pairingCode) {
      return res.json({ ok: true, pairingCode: state.pairingCode });
    }
    return res.json({ ok: true, status: state.status });
  } catch (err) {
    logger.error({ err }, "Error starting session");
    res.status(500).json({ error: "Could not start the WhatsApp session." });
  }
});

app.get("/session/:businessId/qr", requireBridgeKey, (req, res) => {
  const state = getSessionState(req.params.businessId);
  res.json({ qr: state.qr || null, status: state.status });
});

app.get("/session/:businessId/status", requireBridgeKey, (req, res) => {
  const state = getSessionState(req.params.businessId);
  res.json({ status: state.status, phone: state.phone });
});

app.post("/session/:businessId/stop", requireBridgeKey, async (req, res) => {
  const { businessId } = req.params;
  const state = getSessionState(businessId);
  try {
    if (state.sock) await state.sock.logout().catch(() => {});
  } finally {
    state.sock = null;
    state.status = "disconnected";
    await updateWamClientStatus(businessId, "disconnected", state.phone);
    try {
      await fs.rm(`${SESSION_ROOT}/${businessId}`, { recursive: true, force: true });
    } catch (err) {
      logger.error({ err }, "Could not delete session folder in /stop (non-blocking)");
    }
    res.json({ ok: true });
  }
});

app.post("/session/:businessId/send", requireBridgeKey, async (req, res) => {
  const { businessId } = req.params;
  const { phone, text } = req.body || {};
  const state = getSessionState(businessId);
  if (!state.sock || state.status !== "connected") {
    return res.status(409).json({ error: "This WhatsApp session is not connected." });
  }
  try {
    const jid = `${phone}@s.whatsapp.net`;
    await state.sock.sendPresenceUpdate("composing", jid);
    await new Promise((r) => setTimeout(r, 1000));
    await state.sock.sendMessage(jid, { text });
    res.json({ ok: true });
  } catch (err) {
    logger.error({ err }, "Error enviando mensaje");
    res.status(500).json({ error: "No se pudo enviar el mensaje." });
  }
});

app.post("/session/:businessId/send-media", requireBridgeKey, async (req, res) => {
  const { businessId } = req.params;
  const { phone, url, mimetype, caption, fileName } = req.body || {};
  const state = getSessionState(businessId);
  if (!state.sock || state.status !== "connected") {
    return res.status(409).json({ error: "This WhatsApp session is not connected." });
  }
  try {
    const jid = `${phone}@s.whatsapp.net`;
    const isImage = (mimetype || "").startsWith("image/");
    const isAudio = (mimetype || "").startsWith("audio/");
    const payload = isImage
      ? { image: { url }, caption: caption || undefined }
      : isAudio
      ? { audio: { url }, mimetype: mimetype || "audio/ogg", ptt: true }
      : { document: { url }, mimetype: mimetype || "application/octet-stream", fileName: fileName || "archivo", caption: caption || undefined };
    await state.sock.sendMessage(jid, payload);
    res.json({ ok: true });
  } catch (err) {
    logger.error({ err }, "Error enviando media");
    res.status(500).json({ error: "No se pudo enviar el archivo." });
  }
});

app.listen(PORT, () => {
  console.log(`G Capital AI WhatsApp Bridge escuchando en el puerto ${PORT}`);
});
