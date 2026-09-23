// G Capital AI — WhatsApp Bridge.
import express from "express";
import crypto from "crypto";
import { createClient } from "@supabase/supabase-js";
import pino from "pino";
import { generateMessageIDV2, jidNormalizedUser } from "@whiskeysockets/baileys";

import { createSessionManager } from "./src/sessionManager.js";
import { createState } from "./src/state.js";
import { createPipeline } from "./src/pipeline.js";
import { isIgnorableJid } from "./src/messageUtils.js";
import { createWhatsAppAccessControl, createCachedAccessCheck } from "./src/accessControl.js";

const PORT = process.env.PORT || 10000;
const SUPABASE_URL = process.env.SUPABASE_URL || "https://wkpvlgfirechfeppfutg.supabase.co";
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const WHATSAPP_WEBHOOK_URL =
  process.env.WHATSAPP_WEBHOOK_URL || `${SUPABASE_URL}/functions/v1/whatsapp-webhook`;
const HUMAN_TAKEOVER_PING_URL =
  process.env.HUMAN_TAKEOVER_PING_URL || `${SUPABASE_URL}/functions/v1/human-takeover-ping`;
const WHATSAPP_BRIDGE_SECRET = process.env.WHATSAPP_BRIDGE_SECRET || "";

// One manual secret is enough for initial production: BRIDGE_API_KEY may be
// separated later, but if absent we reuse the private bridge secret server-side.
// It is never exposed to the browser.
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
  console.error("Refusing to start with missing/invalid required environment variables.");
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
const logger = pino({ level: process.env.LOG_LEVEL || "warn" });
const checkWhatsAppAccess = createWhatsAppAccessControl(supabase, logger);
const checkWhatsAppAccessCached = createCachedAccessCheck(checkWhatsAppAccess, 60000);
const jidToPhone = (jid) => (jid || "").split("@")[0].split(":")[0];

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

async function forwardIncomingToAI(payload, signal) {
  const res = await fetch(WHATSAPP_WEBHOOK_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-bridge-secret": WHATSAPP_BRIDGE_SECRET,
    },
    body: JSON.stringify(payload),
    signal,
  });
  if (!res.ok) throw new Error(`whatsapp-webhook HTTP ${res.status}`);
  return res.json().catch(() => ({}));
}

const state = createState(supabase, logger);
let sessionManager;

const pipeline = createPipeline({
  state,
  log: logger,
  checkAccess: checkWhatsAppAccessCached,
  ai: async ({ key, items, text, language, pushName, signal }) => {
    const last = items[items.length - 1] || {};
    const data = await forwardIncomingToAI({
      business_id: key.businessId,
      connection_id: key.connectionId,
      chat_jid: key.chatJid,
      phone: jidToPhone(key.chatJid),
      message: text,
      messages: items.map((i) => ({
        id: i.id,
        type: i.type,
        text: i.text,
        reason: i.reason,
      })),
      push_name: pushName || last.pushName || null,
      activation_reason: last.reason || null,
      reply_language: language,
      media_url: null,
      media_type: null,
    }, signal);
    return data?.reply || null;
  },
  send: {
    prepareId: async (key) => {
      const st = sessionManager.getState(key.businessId);
      if (!st?.sock || st.status !== "connected") throw new Error("session not connected");
      return generateMessageIDV2(st.sock.user?.id);
    },
    deliver: async (key, content, messageId) => {
      const st = sessionManager.getState(key.businessId);
      if (!st?.sock || st.status !== "connected") throw new Error("session not connected");
      const payload = typeof content === "string" ? { text: content } : content;

      if (payload.text) {
        await st.sock.presenceSubscribe(key.chatJid).catch(() => {});
        await st.sock.sendPresenceUpdate("composing", key.chatJid).catch(() => {});
        await new Promise((r) => setTimeout(r, 1200));
      }

      await st.sock.sendMessage(key.chatJid, payload, { messageId });

      if (payload.text) {
        await st.sock.sendPresenceUpdate("paused", key.chatJid).catch(() => {});
      }
    },
  },
  onHumanMessage: (key) =>
    pingHumanTakeover(key.businessId, jidToPhone(key.chatJid)).catch(() => {}),
});

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
    if (type !== "notify" && type !== "append") return;

    const ownJid = sock.user?.id ? jidNormalizedUser(sock.user.id) : null;
    if (!ownJid) return;

    for (const msg of messages) {
      if (isIgnorableJid(msg.key?.remoteJid)) continue;
      const r = await pipeline.handle(msg, {
        businessId,
        connectionId: ownJid,
        upsertType: type,
      });
      if (r?.decision) logger.info({ decision: r.decision }, "inbound decision");
    }
  },
});

// Recovery loop:
// - restore claimed batches abandoned by a crashed/terminated process;
// - flush due debounce batches only for WhatsApp sessions owned by this instance.
setInterval(async () => {
  try {
    await state.recoverStaleProcessing(120, 50);
  } catch (err) {
    logger.error({ err }, "stale processing recovery failed");
  }

  const owned = new Set(
    [...sessionManager.sessions.entries()]
      .filter(([, v]) => v.status === "connected")
      .map(([id]) => id)
  );

  if (owned.size) {
    pipeline.sweep(owned).catch((err) => logger.error({ err }, "sweep failed"));
  }
}, 5000).unref?.();

async function sendViaBridge(businessId, phone, payload) {
  const st = sessionManager.getState(businessId);
  if (!st?.sock || st.status !== "connected") {
    throw new Error("This WhatsApp session is not connected on this bridge instance.");
  }
  const connectionId = jidNormalizedUser(st.sock.user.id);
  const chatJid = `${String(phone).replace(/[^0-9]/g, "")}@s.whatsapp.net`;
  return pipeline.sendRegistered({ businessId, connectionId, chatJid }, payload);
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
