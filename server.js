// G Capital AI — WhatsApp Bridge.
// Intentionally simple: live direct message -> central Brain -> one WhatsApp reply.
// No business-intent gate, debounce, language gate, manual mute, or session TTL.
import express from "express";
import crypto from "crypto";
import { createClient } from "@supabase/supabase-js";
import pino from "pino";
import { generateMessageIDV2, jidNormalizedUser } from "@whiskeysockets/baileys";

import { createSessionManager } from "./src/sessionManager.js";
import { createState } from "./src/state.js";
import { extractMessage, isIgnorableJid } from "./src/messageUtils.js";
import { createWhatsAppAccessControl, createCachedAccessCheck } from "./src/accessControl.js";

const PORT = process.env.PORT || 10000;
const SUPABASE_URL = process.env.SUPABASE_URL || "https://wkpvlgfirechfeppfutg.supabase.co";
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const WHATSAPP_WEBHOOK_URL =
  process.env.WHATSAPP_WEBHOOK_URL || `${SUPABASE_URL}/functions/v1/whatsapp-webhook`;
const WHATSAPP_BRIDGE_SECRET = process.env.WHATSAPP_BRIDGE_SECRET || "";

// One private secret is enough. BRIDGE_API_KEY can still override it later.
const BRIDGE_KEY = process.env.BRIDGE_API_KEY || WHATSAPP_BRIDGE_SECRET;
const BRIDGE_KEY_OK = BRIDGE_KEY.length >= 24;
const BRIDGE_INSTANCE_ID =
  process.env.RENDER_INSTANCE_ID || `local-${crypto.randomUUID()}`;

const startupErrors = [];
if (!SUPABASE_SERVICE_ROLE_KEY) startupErrors.push("Missing SUPABASE_SERVICE_ROLE_KEY.");
if (!WHATSAPP_BRIDGE_SECRET) startupErrors.push("Missing WHATSAPP_BRIDGE_SECRET.");
if (!BRIDGE_KEY_OK) startupErrors.push("Missing or invalid bridge key (must be >=24 chars).");
if (startupErrors.length) {
  for (const msg of startupErrors) console.error(msg);
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
const logger = pino({ level: process.env.LOG_LEVEL || "info" });
const checkWhatsAppAccess = createWhatsAppAccessControl(supabase, logger);
const checkWhatsAppAccessCached = createCachedAccessCheck(checkWhatsAppAccess, 60000);
const state = createState(supabase, logger);

const jidToPhone = (jid) => String(jid || "").split("@")[0].split(":")[0];

function customerPhone(msg, fallbackJid) {
  const candidates = [
    msg?.key?.remoteJidAlt,
    msg?.key?.participantPn,
    msg?.key?.participantAlt,
    fallbackJid,
  ].filter(Boolean);
  const pn = candidates.find((jid) => String(jid).endsWith("@s.whatsapp.net"));
  return jidToPhone(pn || candidates[0] || "");
}

async function forwardIncomingToAI(payload) {
  const res = await fetch(WHATSAPP_WEBHOOK_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-bridge-secret": WHATSAPP_BRIDGE_SECRET,
    },
    body: JSON.stringify(payload),
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const detail = data?.error || data?.code || data?.reason || `HTTP ${res.status}`;
    throw new Error(`whatsapp-webhook ${res.status}: ${detail}`);
  }
  return data;
}

let sessionManager;

async function sendRegistered(key, payload) {
  const st = sessionManager.getState(key.businessId);
  if (!st?.sock || st.status !== "connected") {
    throw new Error("WhatsApp session is not connected.");
  }

  const content = typeof payload === "string" ? { text: payload } : payload;
  const messageId = generateMessageIDV2(st.sock.user?.id);

  // Register before send so the resulting fromMe echo can never loop back into AI.
  await state.registerOutbound(key, messageId);
  await st.sock.sendMessage(key.chatJid, content, { messageId });

  if (content?.text) {
    await state.recordMessage(key, {
      direction: "out",
      sender: "bot",
      waMessageId: messageId,
      text: content.text,
    });
  }

  return messageId;
}

sessionManager = createSessionManager({
  supabase,
  logger,
  canConnect: checkWhatsAppAccess,
  instanceId: BRIDGE_INSTANCE_ID,
  acquireLease: (businessId, instanceId, leaseSeconds) =>
    state.acquireClientLease(businessId, instanceId, leaseSeconds),
  renewLease: (businessId, instanceId, leaseSeconds) =>
    state.renewClientLease(businessId, instanceId, leaseSeconds),
  releaseLease: (businessId, instanceId) =>
    state.releaseClientLease(businessId, instanceId),
  onClientStatus: (businessId, status, phone) =>
    supabase.from("wam_clients").upsert({
      business_id: businessId,
      status,
      phone: phone || null,
      updated_at: new Date().toISOString(),
    }, { onConflict: "business_id" }),

  onMessages: async (businessId, sock, { messages, type }) => {
    // Only real-time messages. History/offline append must never trigger replies.
    if (type !== "notify") return;

    const connectionId = sock.user?.id ? jidNormalizedUser(sock.user.id) : null;
    if (!connectionId) return;

    for (const raw of messages || []) {
      const remoteJid = raw?.key?.remoteJid || "";
      if (isIgnorableJid(remoteJid)) continue;

      const norm = extractMessage(raw);
      if (!norm) {
        logger.warn({
          businessId,
          upsertType: type,
          remoteJid,
          fromMe: !!raw?.key?.fromMe,
          messageId: raw?.key?.id || null,
          hasMessage: !!raw?.message,
          messageStubType: raw?.messageStubType ?? null,
        }, "WhatsApp message could not be decoded");
        continue;
      }

      const key = {
        businessId,
        connectionId,
        chatJid: norm.chatJid,
      };

      // The only inbound blocker: exact duplicate message id.
      const claimed = await state.claimInboundEvent(key, norm.id);
      if (!claimed) continue;

      // Ignore everything sent by this WhatsApp account itself.
      // Bot messages are pre-registered; owner/manual messages are simply ignored.
      if (norm.fromMe) {
        const botEcho = await state.isBotOutbound(key, norm.id).catch(() => false);
        logger.debug({
          businessId,
          chatJid: norm.chatJid,
          messageId: norm.id,
          botEcho,
        }, botEcho ? "bot outbound echo ignored" : "owner manual message ignored");
        continue;
      }

      const text = String(norm.text || "").trim();
      if (!text) {
        logger.info({
          businessId,
          chatJid: norm.chatJid,
          messageId: norm.id,
          messageType: norm.messageType,
        }, "non-text WhatsApp message ignored");
        continue;
      }

      await state.recordMessage(key, {
        direction: "in",
        sender: "customer",
        waMessageId: norm.id,
        text,
        mediaType: norm.messageType === "text" ? null : norm.messageType,
      });

      const phone = customerPhone(raw, norm.chatJid);
      logger.info({
        businessId,
        chatJid: norm.chatJid,
        messageId: norm.id,
        phone,
      }, "WhatsApp inbound forwarding to Brain");

      try {
        const data = await forwardIncomingToAI({
          business_id: businessId,
          connection_id: connectionId,
          chat_jid: norm.chatJid,
          phone,
          message: text,
          messages: [{
            id: norm.id,
            type: norm.messageType,
            text,
          }],
          push_name: norm.pushName || null,
        });

        const reply = typeof data?.reply === "string" ? data.reply.trim() : "";
        if (!reply) {
          logger.warn({
            businessId,
            chatJid: norm.chatJid,
            messageId: norm.id,
            reason: data?.reason || data?.error || null,
          }, "Brain returned no WhatsApp reply");
          continue;
        }

        const outboundId = await sendRegistered(key, { text: reply });
        logger.info({
          businessId,
          chatJid: norm.chatJid,
          inboundMessageId: norm.id,
          outboundMessageId: outboundId,
        }, "WhatsApp AI reply sent");
      } catch (err) {
        logger.error({
          err,
          businessId,
          chatJid: norm.chatJid,
          messageId: norm.id,
        }, "WhatsApp Brain/reply flow failed");
      }
    }
  },
});

async function sendViaBridge(businessId, phone, payload) {
  const st = sessionManager.getState(businessId);
  if (!st?.sock || st.status !== "connected") {
    throw new Error("This WhatsApp session is not connected on this bridge instance.");
  }

  const connectionId = jidNormalizedUser(st.sock.user.id);
  const chatJid = `${String(phone).replace(/[^0-9]/g, "")}@s.whatsapp.net`;
  return sendRegistered({ businessId, connectionId, chatJid }, payload);
}

const app = express();
app.use(express.json({ limit: "20mb" }));

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function requireBridgeKey(req, res, next) {
  const got = Buffer.from(String(
    req.headers["x-bridge-key"] || req.headers["x-bridge-secret"] || ""
  ));
  const exp = Buffer.from(BRIDGE_KEY);

  if (got.length !== exp.length || !crypto.timingSafeEqual(got, exp)) {
    return res.status(401).json({ error: "unauthorized" });
  }
  if (req.params.businessId && !UUID_RE.test(req.params.businessId)) {
    return res.status(400).json({ error: "invalid businessId" });
  }
  next();
}

app.get("/", (_req, res) =>
  res.json({ ok: true, service: "G Capital AI WhatsApp Bridge" })
);

app.post("/session/:businessId/start", requireBridgeKey, async (req, res) => {
  const { phoneNumber } = req.body || {};
  try {
    const st = await sessionManager.startSession(req.params.businessId, phoneNumber);
    if (phoneNumber && st.pairingCode) {
      return res.json({ ok: true, pairingCode: st.pairingCode });
    }
    res.json({ ok: true, status: st.status });
  } catch (err) {
    logger.error({ err }, "start session failed");
    if (err?.code === "WHATSAPP_NOT_AUTHORIZED") {
      return res.status(403).json({ error: err.accessReason || "PAID_PLAN_REQUIRED" });
    }
    if (err?.code === "SESSION_OWNED_ELSEWHERE") {
      return res.status(409).json({ error: "SESSION_OWNED_ELSEWHERE" });
    }
    res.status(500).json({ error: "Could not start the WhatsApp session." });
  }
});

app.get("/session/:businessId/qr", requireBridgeKey, (req, res) => {
  const st = sessionManager.getState(req.params.businessId);
  res.json({ qr: st.qr || null, status: st.status });
});

app.get("/session/:businessId/status", requireBridgeKey, (req, res) => {
  const st = sessionManager.getState(req.params.businessId);
  res.json({ status: st.status, phone: st.phone });
});

app.post("/session/:businessId/stop", requireBridgeKey, async (req, res) => {
  try {
    await sessionManager.stopSession(req.params.businessId);
    res.json({ ok: true });
  } catch (err) {
    logger.error({ err }, "stop session failed");
    res.status(500).json({ error: "Could not stop the session." });
  }
});

app.post("/session/:businessId/send", requireBridgeKey, async (req, res) => {
  const { phone, text } = req.body || {};
  if (!phone || !text) {
    return res.status(400).json({ error: "phone and text are required" });
  }

  const access = await checkWhatsAppAccessCached(req.params.businessId);
  if (!access?.allowed) {
    return res.status(403).json({ error: access?.reason || "PAID_PLAN_REQUIRED" });
  }

  try {
    res.json({
      ok: true,
      messageId: await sendViaBridge(req.params.businessId, phone, { text }),
    });
  } catch (err) {
    logger.error({ err }, "send failed");
    res.status(409).json({ error: err.message });
  }
});

app.post("/session/:businessId/send-media", requireBridgeKey, async (req, res) => {
  const { phone, url, mimetype, caption, fileName } = req.body || {};
  if (!phone || !url) {
    return res.status(400).json({ error: "phone and url are required" });
  }

  const access = await checkWhatsAppAccessCached(req.params.businessId);
  if (!access?.allowed) {
    return res.status(403).json({ error: access?.reason || "PAID_PLAN_REQUIRED" });
  }

  const isImage = (mimetype || "").startsWith("image/");
  const isAudio = (mimetype || "").startsWith("audio/");
  const payload = isImage
    ? { image: { url }, caption: caption || undefined }
    : isAudio
      ? { audio: { url }, mimetype: mimetype || "audio/ogg", ptt: true }
      : {
          document: { url },
          mimetype: mimetype || "application/octet-stream",
          fileName: fileName || "archivo",
          caption: caption || undefined,
        };

  try {
    res.json({
      ok: true,
      messageId: await sendViaBridge(req.params.businessId, phone, payload),
    });
  } catch (err) {
    logger.error({ err }, "send-media failed");
    res.status(409).json({ error: err.message });
  }
});

const httpServer = app.listen(PORT, () => {
  console.log(`G Capital AI WhatsApp Bridge listening on port ${PORT}`);
  sessionManager.resumeAll().catch((err) =>
    logger.error({ err }, "resumeAll failed")
  );
});

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.warn({ signal }, "bridge shutting down");
  httpServer.close();
  await sessionManager.shutdownAll().catch((err) =>
    logger.error({ err }, "shutdownAll failed")
  );
  process.exit(0);
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
