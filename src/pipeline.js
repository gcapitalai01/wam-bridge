// Inbound pipeline — exact order:
// 1 receive -> 2 idempotency -> 3 classify fromMe -> 4 mute if human outbound ->
// 5 normalize -> 6 detect language -> 7 evaluateBusinessIntent -> 8 stop if !allowed ->
// 9 update session state -> 10 start/reset debounce -> 11 re-read state -> 12 AI ->
// 13 re-read state -> 14 send in customer language -> 15 register outbound id.
//
// businessIntentGate.js and languageDetector.js are used exactly as published — no
// changes, no re-implementation of their logic here.
import { extractMessage, isIgnorableJid } from "./messageUtils.js";
import { evaluateBusinessIntent } from "./businessIntentGate.js";
import { detectCustomerLanguage } from "./languageDetector.js";

const HUMAN_FROM_ME_MAX_AGE_MS = 2 * 60 * 1000;
const TEXTLESS_MEDIA = new Set(["audio", "image", "video", "document", "sticker"]);
const keyStr = (k) => `${k.businessId}|${k.connectionId}|${k.chatJid}`;

export function createPipeline({ state, ai, send, log = console, now = () => Date.now(), onHumanMessage }) {
  const timers = new Map();
  const inflight = new Map();
  const seen = new Set(); // best-effort in-process idempotency, on top of the wam_messages check

  function cancelPending(key) {
    const ks = keyStr(key);
    const t = timers.get(ks);
    if (t) { clearTimeout(t.timer); timers.delete(ks); }
    const ac = inflight.get(ks);
    if (ac) { ac.abort(); inflight.delete(ks); }
  }

  function schedule(key, version, dueAt) {
    const ks = keyStr(key);
    const prev = timers.get(ks);
    if (prev) clearTimeout(prev.timer);
    const delay = Math.max(0, new Date(dueAt).getTime() - now()) + 25;
    const timer = setTimeout(() => {
      timers.delete(ks);
      flush(key, version).catch((e) => log.error?.({ e }, "flush failed"));
    }, delay);
    timer.unref?.();
    timers.set(ks, { timer, version });
  }

  async function sendRegistered(key, content) {
    const id = await send.prepareId(key);
    await state.registerOutbound(key, id);        // step 15, done BEFORE the actual send
    await send.deliver(key, content, id);
    return id;
  }

  // Steps 11-14 (fires when the 4s debounce window elapses).
  async function flush(key, debounceVersion) {
    const batch = await state.claimBatch(key, debounceVersion);   // 11: re-read state before AI
    if (!batch?.items?.length) return { status: "SKIPPED" };      // 12: state no longer valid -> stop

    const last = batch.items[batch.items.length - 1];
    const language = last.language || "en";
    const text = batch.items.map((i) => i.text).filter(Boolean).join("\n");

    const ks = keyStr(key);
    const ac = new AbortController();
    inflight.set(ks, ac);
    let reply;
    try {
      reply = await ai({ key, items: batch.items, text, language, signal: ac.signal });
    } catch (e) {
      if (ac.signal.aborted) return { status: "CANCELLED" };
      throw e;
    } finally {
      if (inflight.get(ks) === ac) inflight.delete(ks);
    }
    if (ac.signal.aborted || !reply) return { status: reply ? "CANCELLED" : "NO_REPLY" };

    if (!(await state.canSend(key, batch.processingVersion))) return { status: "CANCELLED" }; // 13: re-read before send
    const id = await sendRegistered(key, reply);                                              // 14+15
    await state.recordMessage(key, { direction: "out", sender: "bot", waMessageId: id, text: reply, isBusinessContext: true, detectedLanguage: language, languageSource: "reply" });
    return { status: "SENT", messageId: id };
  }

  async function handle(raw, { businessId, connectionId, upsertType = "notify" }) {
    // 1. receive
    const norm = extractMessage(raw);
    if (!norm || isIgnorableJid(norm.chatJid)) return { classification: "IGNORED" };
    if (upsertType !== "notify" && !norm.fromMe) return { classification: "HISTORY" };
    const key = { businessId, connectionId, chatJid: norm.chatJid };

    // 2. idempotency
    const memKey = `${keyStr(key)}|${norm.id}`;
    if (seen.has(memKey)) return { classification: "DUPLICATE" };
    seen.add(memKey);
    if (seen.size > 5000) seen.delete(seen.values().next().value);
    if (await state.wasSeen(key, norm.id)) return { classification: "DUPLICATE" };

    // 3. classify fromMe
    if (norm.fromMe) {
      if (await state.isBotOutbound(key, norm.id)) return { classification: "BOT_OUTBOUND" };
      if (norm.messageType === "system") return { classification: "SYSTEM_EVENT" };
      if (norm.timestampMs && now() - norm.timestampMs > HUMAN_FROM_ME_MAX_AGE_MS) return { classification: "STALE_FROM_ME" };
      // 4. real human outbound -> 30-minute mute, kill pending debounce/AI
      const settings = await state.getSettings(businessId);
      cancelPending(key);
      await state.muteForHuman(key, settings.human_mute_seconds);
      await state.recordMessage(key, { direction: "out", sender: "human", waMessageId: norm.id, text: norm.text, mediaType: norm.messageType === "text" ? null : norm.messageType });
      onHumanMessage?.(key);
      return { classification: "HUMAN_MANUAL" };
    }

    // 5. normalize is done (norm); load chat state + settings + quoted context
    const chatState = await state.getChatState(key);
    const settings = await state.getSettings(businessId);
    const isMuted = !!chatState?.muted_until && new Date(chatState.muted_until).getTime() > now();

    let quotedContext = null;
    if (!isMuted && norm.quoted) quotedContext = await state.resolveQuoted(key, norm.quoted);

    // 6. detect customer language (before the gate, as required)
    const langInput = {
      text: norm.text,
      sessionLanguage: chatState?.detected_language || null,
      quotedLanguage: quotedContext?.language || null,
      tenantDefaultLanguage: settings.tenantDefaultLanguage,
    };
    const lang = detectCustomerLanguage(langInput);
    if (lang.language && norm.messageType !== "system") {
      await state.persistLanguage(key, lang);
    }

    // 7. evaluateBusinessIntent
    const gate = evaluateBusinessIntent({
      text: norm.text,
      messageType: norm.messageType,
      isSystemEvent: norm.messageType === "system",
      isMuted,
      businessSessionActiveUntil: chatState?.business_session_active_until || null,
      now: new Date(now()),
      quotedContext: quotedContext ? { verified: quotedContext.verified, isBusinessContext: quotedContext.isBusinessContext } : null,
      tenantKeywords: settings.tenantKeywords,
      industryKeywords: settings.industryKeywords,
      mediaIntent: null, // no transcription/vision provider wired — never invent business intent for media
    });

    if (norm.messageType !== "system") {
      await state.recordMessage(key, {
        direction: "in", sender: "customer", waMessageId: norm.id, text: norm.text,
        mediaType: TEXTLESS_MEDIA.has(norm.messageType) ? norm.messageType : null,
        isBusinessContext: gate.allowed, gateReason: gate.reason,
        detectedLanguage: lang.language, languageConfidence: lang.confidence, languageSource: lang.source,
        quotedWaMessageId: quotedContext?.waMessageId || null, quotedIsBusinessContext: quotedContext?.isBusinessContext ?? null,
      });
    }

    // 8. STOP COMPLETELY if not allowed — no debounce, no AI, no fallback, no reply.
    if (!gate.allowed) return { classification: "CUSTOMER", decision: { ...gate, businessId, chatJid: norm.chatJid, messageId: norm.id } };

    // 9 + 10. update business-session state and start/reset the 4s debounce (one atomic call).
    const item = { id: norm.id, type: norm.messageType, text: norm.text, language: lang.language, reason: gate.reason };
    const q = await state.enqueue(key, item, {
      activate: gate.activateSession, reason: gate.reason,
      ttlSeconds: settings.business_session_ttl_seconds, debounceMs: settings.debounce_seconds * 1000,
    });
    if (!q.accepted) return { classification: "CUSTOMER", decision: { allowed: false, reason: "MUTED" } }; // muted mid-flight
    schedule(key, q.debounceVersion, q.dueAt);
    return { classification: "CUSTOMER", decision: { ...gate, businessId, chatJid: norm.chatJid, messageId: norm.id } };
  }

  async function sweep(ownedBusinessIds) {
    const rows = await state.dueBatches(50);
    for (const r of rows) {
      if (ownedBusinessIds && !ownedBusinessIds.has(r.business_id)) continue;
      const key = { businessId: r.business_id, connectionId: r.connection_id, chatJid: r.chat_jid };
      if (timers.has(keyStr(key))) continue;
      await flush(key, Number(r.debounce_version)).catch((e) => log.error?.({ e }, "sweep flush failed"));
    }
  }

  return { handle, flush, sweep, sendRegistered };
}
