// G Capital AI — WhatsApp Bridge.
// Production inbound path: Baileys -> idempotency/fromMe -> business-intent gate ->
// debounce/state validation -> central Brain -> verified WhatsApp send.
import express from "express";
import crypto from "crypto";
import { createClient } from "@supabase/supabase-js";
import pino from "pino";
import { generateMessageIDV2, jidNormalizedUser } from "@whiskeysockets/baileys";

import { createSessionManager } from "./src/sessionManager.js";
import { createState } from "./src/state.js";
import { createPipeline } from "./src/pipeline.js";
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

// Crash safety net. Baileys' internal retry/relay machinery is known to
// occasionally throw an unhandled Boom error deep inside a mutex-wrapped
// promise (e.g. a "Connection Closed"/precondition-required error while
// retrying a message send). Left unhandled, that kills the ENTIRE Node
// process -- dropping every connected business's WhatsApp socket on this
// instance at once, not just the one that hit the glitch, and forcing a
// fresh multi-second lease takeover for all of them. Logging and staying
// alive is strictly safer here: each business's own session/reconnect
// logic already handles its own recovery independently.
process.on("uncaughtException", (err) => {
  logger.error({ err }, "uncaughtException: process kept alive");
});
process.on("unhandledRejection", (reason) => {
  logger.error({ reason }, "unhandledRejection: process kept alive");
});
const checkWhatsAppAccess = createWhatsAppAccessControl(supabase, logger);
const checkWhatsAppAccessCached = createCachedAccessCheck(checkWhatsAppAccess, 60000);
const state = createState(supabase, logger);

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

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const detail = data?.error || data?.code || data?.reason || `HTTP ${res.status}`;
    throw new Error(`whatsapp-webhook ${res.status}: ${detail}`);
  }
  return data;
}

let sessionManager;

async function sendRegistered(key, payload, forcedMessageId = null) {
  const st = sessionManager.getState(key.businessId);
  if (!st?.sock || st.status !== "connected") {
    throw new Error("WhatsApp session is not connected.");
  }

  const content = typeof payload === "string" ? { text: payload } : payload;
  const messageId = forcedMessageId || generateMessageIDV2(st.sock.user?.id);

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

const inboundPipeline = createPipeline({
  state,
  log: logger,
  checkAccess: checkWhatsAppAccessCached,
  ai: async ({ key, items, text, language, pushName, signal }) => {
    const phone = String(key.chatJid || "").endsWith("@s.whatsapp.net")
      ? String(key.chatJid).split("@")[0].split(":")[0]
      : null;
    const data = await forwardIncomingToAI({
      business_id: key.businessId,
      connection_id: key.connectionId,
      chat_jid: key.chatJid,
      phone,
      message: text,
      messages: (items || []).map((item) => ({
        id: item.id,
        type: item.type,
        text: item.text,
      })),
      push_name: pushName || null,
      detected_language: language || null,
    }, signal);
    return typeof data?.reply === "string" ? data.reply.trim() : "";
  },
  send: {
    prepareId: async (key) => {
      const st = sessionManager?.getState(key.businessId);
      if (!st?.sock || st.status !== "connected") {
        throw new Error("WhatsApp session is not connected.");
      }
      return generateMessageIDV2(st.sock.user?.id);
    },
    deliver: async (key, content, messageId) => {
      const st = sessionManager?.getState(key.businessId);
      if (!st?.sock || st.status !== "connected") {
        throw new Error("WhatsApp session is not connected.");
      }
      const payload = typeof content === "string" ? { text: content } : content;
      await st.sock.sendMessage(key.chatJid, payload, { messageId });
    },
  },
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
    const connectionId = sock.user?.id ? jidNormalizedUser(sock.user.id) : null;
    if (!connectionId) return;

    for (const raw of messages || []) {
      try {
        const result = await inboundPipeline.handle(raw, {
          businessId,
          connectionId,
          upsertType: type,
        });
        logger.debug?.({
          businessId,
          classification: result?.classification || null,
          allowed: result?.decision?.allowed ?? null,
          reason: result?.decision?.reason || null,
        }, "WhatsApp inbound classified");
      } catch (err) {
        logger.error({ err, businessId }, "WhatsApp inbound flow failed");
      }
    }
  },
});

// Adaptive, non-overlapping sweep. A plain setInterval fires every 2s
// regardless of whether the previous call finished -- if Supabase has a
// transient slowdown and one sweep takes >2s, the next one piles on top of
// it, and a brief hiccup turns into a self-inflicted request storm that
// looks like "everything is timing out". This version never starts a new
// sweep while one is in flight, and backs off (capped) on repeated
// failures instead of hammering an already-struggling backend.
const SWEEP_BASE_MS = 2000;
const SWEEP_MAX_MS = 30000;
let sweepDelayMs = SWEEP_BASE_MS;
let sweepInFlight = false;
let sweepTimer = null;

async function runSweepOnce() {
  if (sweepInFlight) return; // previous sweep still running; skip this tick
  sweepInFlight = true;
  try {
    await inboundPipeline.sweep();
    sweepDelayMs = SWEEP_BASE_MS; // recovered: back to normal cadence
  } catch (err) {
    logger.error({ err }, "WhatsApp inbound recovery sweep failed");
    sweepDelayMs = Math.min(sweepDelayMs * 2, SWEEP_MAX_MS);
  } finally {
    sweepInFlight = false;
    sweepTimer = setTimeout(runSweepOnce, sweepDelayMs);
    sweepTimer.unref?.();
  }
}
sweepTimer = setTimeout(runSweepOnce, sweepDelayMs);
sweepTimer.unref?.();

async function sendViaBridge(businessId, phone, payload, forcedMessageId = null) {
  const st = sessionManager.getState(businessId);
  if (!st?.sock || st.status !== "connected") {
    throw new Error("This WhatsApp session is not connected on this bridge instance.");
  }

  const connectionId = jidNormalizedUser(st.sock.user.id);
  const chatJid = `${String(phone).replace(/[^0-9]/g, "")}@s.whatsapp.net`;
  return sendRegistered({ businessId, connectionId, chatJid }, payload, forcedMessageId);
}

const OUTBOUND_PENDING_TTL_MS = 5 * 60 * 1000;

async function claimOutboundIdempotency(businessId, idempotencyKey, phone, proposedMessageId) {
  const key = String(idempotencyKey || "").trim().slice(0, 240);
  if (!key) return { state: "new", messageId: proposedMessageId, idempotencyKey: null };

  const row = {
    business_id: businessId,
    idempotency_key: key,
    phone: String(phone).replace(/[^0-9]/g, ""),
    message_id: proposedMessageId,
    status: "processing",
    updated_at: new Date().toISOString(),
  };
  const { data: inserted, error: insertErr } = await supabase
    .from("wam_outbound_idempotency")
    .insert(row)
    .select("id,business_id,idempotency_key,phone,message_id,status,error,updated_at,sent_at")
    .maybeSingle();

  if (!insertErr && inserted) {
    return { state: "new", messageId: inserted.message_id, idempotencyKey: key };
  }
  if (insertErr?.code !== "23505") {
    throw new Error(`outbound idempotency claim failed: ${insertErr?.message || "unknown"}`);
  }

  const { data: existing, error: readErr } = await supabase
    .from("wam_outbound_idempotency")
    .select("id,business_id,idempotency_key,phone,message_id,status,error,updated_at,sent_at")
    .eq("business_id", businessId)
    .eq("idempotency_key", key)
    .maybeSingle();
  if (readErr || !existing) {
    throw new Error(`outbound idempotency read failed: ${readErr?.message || "missing row"}`);
  }

  if (existing.status === "sent") {
    return { state: "sent", messageId: existing.message_id, idempotencyKey: key };
  }

  if (existing.message_id) {
    const { data: recorded } = await supabase
      .from("wam_messages")
      .select("id")
      .eq("business_id", businessId)
      .eq("wa_message_id", existing.message_id)
      .eq("direction", "out")
      .limit(1)
      .maybeSingle();
    if (recorded?.id) {
      await supabase.from("wam_outbound_idempotency").update({
        status: "sent",
        sent_at: existing.sent_at || new Date().toISOString(),
        error: null,
        updated_at: new Date().toISOString(),
      }).eq("id", existing.id);
      return { state: "sent", messageId: existing.message_id, idempotencyKey: key };
    }
  }

  if (existing.status === "processing") {
    const ageMs = Date.now() - new Date(existing.updated_at).getTime();
    if (Number.isFinite(ageMs) && ageMs <= OUTBOUND_PENDING_TTL_MS) {
      return { state: "processing", messageId: existing.message_id, idempotencyKey: key };
    }
    await supabase.from("wam_outbound_idempotency").update({
      status: "uncertain",
      error: existing.error || "stale_processing_without_delivery_receipt",
      updated_at: new Date().toISOString(),
    }).eq("id", existing.id);
  }

  return { state: "uncertain", messageId: existing.message_id, idempotencyKey: key };
}

async function finishOutboundIdempotency(businessId, idempotencyKey, status, messageId, error = null) {
  if (!idempotencyKey) return;
  const patch = {
    status,
    message_id: messageId || null,
    error: error ? String(error).slice(0, 2000) : null,
    updated_at: new Date().toISOString(),
    sent_at: status === "sent" ? new Date().toISOString() : null,
  };
  await supabase.from("wam_outbound_idempotency")
    .update(patch)
    .eq("business_id", businessId)
    .eq("idempotency_key", idempotencyKey);
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
  const { phone, text, idempotencyKey } = req.body || {};
  if (!phone || !text) {
    return res.status(400).json({ error: "phone and text are required" });
  }

  const access = await checkWhatsAppAccessCached(req.params.businessId);
  if (!access?.allowed) {
    return res.status(403).json({ error: access?.reason || "PAID_PLAN_REQUIRED" });
  }

  const st = sessionManager.getState(req.params.businessId);
  if (!st?.sock || st.status !== "connected") {
    return res.status(409).json({ error: "WhatsApp session is not connected." });
  }

  const proposedMessageId = generateMessageIDV2(st.sock.user?.id);
  let claim;
  try {
    claim = await claimOutboundIdempotency(
      req.params.businessId,
      idempotencyKey,
      phone,
      proposedMessageId
    );
  } catch (err) {
    logger.error({ err }, "outbound idempotency failed");
    return res.status(500).json({ error: "Could not secure outbound send." });
  }

  if (claim.state === "sent") {
    return res.json({ ok: true, messageId: claim.messageId, replayed: true });
  }
  if (claim.state === "processing") {
    return res.status(202).json({ ok: false, pending: true, messageId: claim.messageId });
  }
  if (claim.state === "uncertain") {
    return res.status(409).json({
      ok: false,
      uncertain: true,
      messageId: claim.messageId,
      error: "Previous send outcome is uncertain; automatic resend blocked.",
    });
  }

  try {
    const messageId = await sendViaBridge(
      req.params.businessId,
      phone,
      { text },
      claim.messageId
    );
    await finishOutboundIdempotency(
      req.params.businessId,
      claim.idempotencyKey,
      "sent",
      messageId,
      null
    );
    res.json({ ok: true, messageId });
  } catch (err) {
    await finishOutboundIdempotency(
      req.params.businessId,
      claim.idempotencyKey,
      "uncertain",
      claim.messageId,
      err?.message || String(err)
    );
    logger.error({ err }, "send failed");
    res.status(409).json({
      error: err?.message || String(err),
      uncertain: !!claim.idempotencyKey,
      messageId: claim.messageId,
    });
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
