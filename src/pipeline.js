// Inbound pipeline — exact order:
// 1 receive -> 2 atomic idempotency -> 3 classify fromMe -> 4 mute if human outbound ->
// 5 normalize -> 6 detect language -> 7 evaluateBusinessIntent -> 8 stop if !allowed ->
// 9 update session state -> 10 start/reset debounce -> 11 re-read state -> 12 AI ->
// 13 re-read state -> 14 send in customer language -> 15 register outbound id.
import { extractMessage, isIgnorableJid } from "./messageUtils.js";
import { detectCustomerLanguage } from "./languageDetector.js";

const HUMAN_FROM_ME_MAX_AGE_MS = 2 * 60 * 1000;
const LIVE_APPEND_MAX_AGE_MS = 5 * 60 * 1000;
const CLOCK_SKEW_MS = 60 * 1000;
const TEXTLESS_MEDIA = new Set(["audio", "image", "video", "document", "sticker"]);
const keyStr = (k) => `${k.businessId}|${k.connectionId}|${k.chatJid}`;

function isFreshAppend(norm, nowMs) {
  if (!norm?.timestampMs) return false;
  const age = nowMs - norm.timestampMs;
  return age >= -CLOCK_SKEW_MS && age <= LIVE_APPEND_MAX_AGE_MS;
}

export function createPipeline({ state, ai, send, log = console, now = () => Date.now(), onHumanMessage, checkAccess }) {
  const timers = new Map();
  const inflight = new Map();
  const seen = new Set(); // fast local cache; Supabase atomic claim is authoritative across instances.

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
    await state.registerOutbound(key, id);
    await send.deliver(key, content, id);
    return id;
  }

  async function flush(key, debounceVersion) {
    const batch = await state.claimBatch(key, debounceVersion);
    if (!batch?.items?.length) return { status: "SKIPPED" };

    let finishOnExit = true;
    const ks = keyStr(key);
    const ac = new AbortController();
    inflight.set(ks, ac);

    try {
      if (checkAccess) {
        const access = await checkAccess(key.businessId);
        if (!access?.allowed) return { status: "ACCESS_BLOCKED", reason: access?.reason };
      }

      const last = batch.items[batch.items.length - 1];
      const pushName = last.pushName || null;
      const language = last.language || "en";
      const text = batch.items.map((i) => i.text).filter(Boolean).join("\n");

      let reply;
      try {
        reply = await ai({ key, items: batch.items, text, language, pushName, signal: ac.signal });
      } catch (e) {
        if (ac.signal.aborted) return { status: "CANCELLED" };
        // Unknown/transient AI failure: keep processing_batch so stale recovery
        // can safely retry later. No external WhatsApp send happened yet.
        finishOnExit = false;
        throw e;
      }

      if (ac.signal.aborted || !reply) {
        return { status: ac.signal.aborted ? "CANCELLED" : "NO_REPLY" };
      }

      // Final atomic guard + commit BEFORE the external send.
      // Once committed, a process crash can cause at most a missed reply, never
      // a duplicate reply from stale-batch recovery.
      let committed;
      try {
        committed = await state.commitProcessingForSend(key, batch.processingVersion);
      } catch (e) {
        finishOnExit = false;
        throw e;
      }
      if (!committed || ac.signal.aborted) return { status: "CANCELLED" };

      finishOnExit = false; // commitProcessingForSend already cleared the batch.

      const id = await sendRegistered(key, reply);
      await state.recordMessage(key, {
        direction: "out", sender: "bot", waMessageId: id, text: reply,
        isBusinessContext: true, detectedLanguage: language, languageSource: "session",
      });
      return { status: "SENT", messageId: id };
    } finally {
      if (inflight.get(ks) === ac) inflight.delete(ks);
      if (finishOnExit && state.finishProcessing) {
        await state.finishProcessing(key, batch.processingVersion)
          .catch((e) => log.error?.({ e }, "finishProcessing failed"));
      }
    }
  }

  async function handle(raw, { businessId, connectionId, upsertType = "notify" }) {
    const norm = extractMessage(raw);
    if (!norm || isIgnorableJid(norm.chatJid)) return { classification: "IGNORED" };
    if (upsertType !== "notify") {
      const allowedFreshAppend = upsertType === "append" && !norm.fromMe && isFreshAppend(norm, now());
      if (!allowedFreshAppend) return { classification: "HISTORY" };
    }

    const key = { businessId, connectionId, chatJid: norm.chatJid };

    // Atomic idempotency across processes/instances.
    const memKey = `${keyStr(key)}|${norm.id}`;
    if (seen.has(memKey)) return { classification: "DUPLICATE" };
    const claimed = await state.claimInboundEvent(key, norm.id);
    if (!claimed) {
      seen.add(memKey);
      return { classification: "DUPLICATE" };
    }
    seen.add(memKey);
    if (seen.size > 5000) seen.delete(seen.values().next().value);

    if (norm.fromMe) {
      if (await state.isBotOutbound(key, norm.id)) return { classification: "BOT_OUTBOUND" };
      if (norm.messageType === "system") return { classification: "SYSTEM_EVENT" };
      if (norm.timestampMs && now() - norm.timestampMs > HUMAN_FROM_ME_MAX_AGE_MS) return { classification: "STALE_FROM_ME" };

      const settings = await state.getSettings(businessId);
      cancelPending(key);
      await state.muteForHuman(key, settings.human_mute_seconds);
      await state.recordMessage(key, {
        direction: "out", sender: "human", waMessageId: norm.id, text: norm.text,
        mediaType: norm.messageType === "text" ? null : norm.messageType,
      });
      onHumanMessage?.(key);
      return { classification: "HUMAN_MANUAL" };
    }

    const chatState = await state.getChatState(key);
    const settings = await state.getSettings(businessId);

    if (settings.enabled === false) {
      return { classification: "CUSTOMER", decision: { allowed: false, reason: "AUTOMATION_DISABLED" } };
    }

    const isMuted = !!chatState?.muted_until && new Date(chatState.muted_until).getTime() > now();

    let quotedContext = null;
    if (!isMuted && norm.quoted) quotedContext = await state.resolveQuoted(key, norm.quoted);

    const lang = detectCustomerLanguage({
      text: norm.text,
      sessionLanguage: chatState?.detected_language || null,
      quotedLanguage: quotedContext?.language || null,
      tenantDefaultLanguage: settings.tenantDefaultLanguage,
    });
    if (lang.language && norm.messageType !== "system") {
      await state.persistLanguage(key, lang);
    }

    if (norm.messageType === "system") return { classification: "IGNORED" };

    // No business/personal gate: every real inbound message (except a
    // human-mute window) goes straight to the AI, like Wasenger/RespondIO/
    // GoHighLevel. What the AI says for greetings/FAQs/off-topic messages is
    // controlled entirely by the system prompt on the Brain side, not by
    // blocking anything here.
    await state.recordMessage(key, {
      direction: "in", sender: "customer", waMessageId: norm.id, text: norm.text,
      mediaType: TEXTLESS_MEDIA.has(norm.messageType) ? norm.messageType : null,
      isBusinessContext: true, gateReason: "NO_GATE",
      detectedLanguage: lang.language, languageConfidence: lang.confidence, languageSource: lang.source,
      quotedWaMessageId: quotedContext?.waMessageId || null,
      quotedIsBusinessContext: quotedContext?.isBusinessContext ?? null,
    });

    if (isMuted) {
      return { classification: "CUSTOMER", decision: { allowed: false, reason: "MUTED", businessId, chatJid: norm.chatJid, messageId: norm.id } };
    }

    const item = {
      id: norm.id, type: norm.messageType, text: norm.text, language: lang.language,
      reason: "NO_GATE", pushName: norm.pushName || null,
    };
    const q = await state.enqueue(key, item, {
      activate: true,
      reason: "NO_GATE",
      ttlSeconds: settings.business_session_ttl_seconds,
      debounceMs: settings.debounce_seconds * 1000,
    });
    if (!q.accepted) {
      return { classification: "CUSTOMER", decision: { allowed: false, reason: "MUTED" } };
    }

    schedule(key, q.debounceVersion, q.dueAt);
    return {
      classification: "CUSTOMER",
      decision: { allowed: true, reason: "NO_GATE", businessId, chatJid: norm.chatJid, messageId: norm.id },
    };
  }

  async function sweep(ownedBusinessIds) {
    const rows = await state.dueBatches(50);
    for (const r of rows) {
      if (ownedBusinessIds && !ownedBusinessIds.has(r.business_id)) continue;
      const key = { businessId: r.business_id, connectionId: r.connection_id, chatJid: r.chat_jid };
      if (timers.has(keyStr(key))) continue;
      await flush(key, Number(r.debounce_version))
        .catch((e) => log.error?.({ e }, "sweep flush failed"));
    }
  }

  return { handle, flush, sweep, sendRegistered };
}
