// ============================================================
// G CAPITAL AI — WhatsApp Bridge (Baileys)
// ============================================================
// Servidor Express + Baileys, multi-negocio (una sesión por businessId).
// Respeta EXACTAMENTE el contrato que ya usa whatsapp-connect (Supabase):
//
//   POST /session/:businessId/start   { phoneNumber? }  -> { pairingCode? } o inicia QR
//   GET  /session/:businessId/qr                        -> { qr: "data:image/png;base64,..." }
//   GET  /session/:businessId/status                    -> { status, phone }
//   POST /session/:businessId/stop
//   POST /session/:businessId/send        { phone, text }
//   POST /session/:businessId/send-media  { phone, url, mimetype, caption, fileName }
//
// Todas las rutas requieren el header:  x-bridge-key: whatsapp-QR
//
// NUEVO en esta versión (2 sep 2026):
//   - Coexistencia: si el dueño escribe desde su propio celular (fromMe), avisa a
//     human-takeover-ping para que la IA se calle 2 minutos exactos en ese chat.
//   - Filtra grupos (@g.us), canales/newsletters (@broadcast, @newsletter) y status@broadcast
//     ANTES de reenviar nada — nunca le llega basura a la IA.
//   - Reenvía cada mensaje entrante real (texto/imagen/audio/documento) a whatsapp-webhook
//     con el formato que ya espera (business_id, phone, message, push_name, media_url, media_type).
//   - sendPresenceUpdate('composing') antes de cada envío, como el resto de la plataforma.
//   - Reconexión automática con backoff simple; NO se reconecta si el motivo es logout real
//     (ahí hay que volver a emparejar desde el dashboard).
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

// ---------- Config (variables de entorno en Render) ----------
const PORT = process.env.PORT || 3000;
const BRIDGE_KEY = process.env.BRIDGE_API_KEY || "whatsapp-QR";
const SUPABASE_URL = process.env.SUPABASE_URL || "https://wkpvlgfirechfeppfutg.supabase.co";
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const WHATSAPP_WEBHOOK_URL = `${SUPABASE_URL}/functions/v1/whatsapp-webhook`;
const HUMAN_TAKEOVER_PING_URL = `${SUPABASE_URL}/functions/v1/human-takeover-ping`;
const WHATSAPP_BRIDGE_SECRET = process.env.WHATSAPP_BRIDGE_SECRET || ""; // opcional, si lo configuras también en whatsapp-webhook

if (!SUPABASE_SERVICE_ROLE_KEY) {
  console.error("FALTA SUPABASE_SERVICE_ROLE_KEY en las variables de entorno de Render.");
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
const logger = pino({ level: process.env.LOG_LEVEL || "warn" });

// ---------- Estado en memoria: una sesión Baileys por negocio ----------
/** @type {Map<string, { sock: any, qr: string|null, status: string, phone: string|null, connecting: boolean }>} */
const sessions = new Map();

function getSessionState(businessId) {
  if (!sessions.has(businessId)) {
    sessions.set(businessId, { sock: null, qr: null, status: "disconnected", phone: null, connecting: false });
  }
  return sessions.get(businessId);
}

// JIDs a ignorar SIEMPRE: grupos, canales/newsletters, difusión de estados.
function isIgnorableJid(jid) {
  if (!jid) return true;
  return jid.endsWith("@g.us") || jid.endsWith("@broadcast") || jid.endsWith("@newsletter") || jid === "status@broadcast";
}

function jidToPhone(jid) {
  return (jid || "").split("@")[0].split(":")[0];
}

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
    logger.warn({ err }, "human-takeover-ping falló (no bloqueante)");
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

// ---------- Extrae texto / tipo de media de un mensaje Baileys ----------
function extractMessageContent(msg) {
  const m = msg.message;
  if (!m) return { text: "", mediaType: null };

  if (m.conversation) return { text: m.conversation, mediaType: null };
  if (m.extendedTextMessage?.text) return { text: m.extendedTextMessage.text, mediaType: null };
  if (m.imageMessage) return { text: m.imageMessage.caption || "", mediaType: "image" };
  if (m.audioMessage) return { text: "", mediaType: "audio" };
  if (m.documentMessage) return { text: m.documentMessage.caption || m.documentMessage.fileName || "", mediaType: "document" };
  if (m.videoMessage) return { text: m.videoMessage.caption || "", mediaType: "document" }; // se trata como documento por simplicidad
  return { text: "", mediaType: null };
}

// ---------- Crea/arranca una sesión para un negocio ----------
async function startSession(businessId, phoneNumberForPairing) {
  const state = getSessionState(businessId);
  if (state.connecting) return state;
  state.connecting = true;

  const { state: authState, saveCreds } = await useMultiFileAuthState(`./sessions/${businessId}`);
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    auth: authState,
    printQRInTerminal: false,
    logger,
    markOnlineOnConnect: true,
    browser: ["G Capital AI", "Chrome", "1.0"],
  });

  state.sock = sock;
  state.status = "qr_pending";

  // Emparejamiento por código (sin QR) — se pide una sola vez, justo después de crear el socket.
  if (phoneNumberForPairing && !authState.creds.registered) {
    try {
      const code = await sock.requestPairingCode(phoneNumberForPairing.replace(/[^0-9]/g, ""));
      state.pairingCode = code;
    } catch (err) {
      logger.error({ err }, "No se pudo generar el código de emparejamiento");
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
        logger.warn(`[${businessId}] Sesión cerrada por WhatsApp — hay que volver a emparejar desde el dashboard.`);
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

      // COEXISTENCIA: el dueño escribió desde su propio celular -> pausar la IA 2 minutos.
      if (msg.key.fromMe) {
        pingHumanTakeover(businessId, phone).catch(() => {});
        continue; // no reenviar los propios mensajes del dueño como si fueran del cliente
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
    logger.error({ err }, "Error iniciando sesión");
    res.status(500).json({ error: "No se pudo iniciar la sesión de WhatsApp." });
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
    res.json({ ok: true });
  }
});

app.post("/session/:businessId/send", requireBridgeKey, async (req, res) => {
  const { businessId } = req.params;
  const { phone, text } = req.body || {};
  const state = getSessionState(businessId);
  if (!state.sock || state.status !== "connected") {
    return res.status(409).json({ error: "Esta sesión de WhatsApp no está conectada." });
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
    return res.status(409).json({ error: "Esta sesión de WhatsApp no está conectada." });
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
