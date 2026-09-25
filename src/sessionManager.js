import { extractMessage, isIgnorableJid } from "./messageUtils.js";
import { evaluateBusinessIntent } from "./businessIntentGate.js";

const PERSONAL_AUTOREPLY =
  "Hola, este numero usa un asistente para clientes. Si buscas informacion de nuestros servicios, cuentame en que te ayudo. Si es un tema personal, en breve te contactan directamente.";
const BUSINESS_SESSION_TTL_SECONDS = 900; // 15 min contextual continuity
const HUMAN_MUTE_SECONDS = 300; // hard cap 5 min, matches state.muteForHuman

const jidToPhone = (jid) => String(jid || "").split("@")[0].split(":")[0];
const LIVE_APPEND_MAX_AGE_MS = 5 * 60 * 1000;
const CLOCK_SKEW_MS = 60 * 1000;

export function resolveCustomerPhone(raw, fallbackJid) {
  const candidates = [
    raw?.key?.remoteJidAlt,
    raw?.key?.participantPn,
    raw?.key?.participantAlt,
    fallbackJid,
  ].filter(Boolean);
  const pn = candidates.find((jid) => String(jid).endsWith("@s.whatsapp.net"));
  return jidToPhone(pn || candidates[0] || "");
}

function isFreshAppend(norm, now = Date.now()) {
  if (!norm?.timestampMs) return false;
  const age = now - norm.timestampMs;
  return age >= -CLOCK_SKEW_MS && age <= LIVE_APPEND_MAX_AGE_MS;
}

export function createSimpleInboundHandler({
  state,
  forwardIncomingToAI,
  sendRegistered,
  log = console,
}) {
  return async function handleSimpleInbound({
    businessId,
    connectionId,
    raw,
    upsertType = "notify",
  }) {
    const remoteJid = raw?.key?.remoteJid || "";
    const messageId = raw?.key?.id || null;

    if (isIgnorableJid(remoteJid)) {
      log.debug?.({ businessId, upsertType, remoteJid, messageId }, "WhatsApp inbound ignored by JID");
      return { status: "JID_IGNORED" };
    }

    const norm = extractMessage(raw);
    if (!norm) {
      // Important: do NOT claim/dedupe this event. Baileys can later retry and
      // deliver the same WhatsApp message id after Signal sessions recover.
      log.warn?.({
        businessId,
        upsertType,
        remoteJid,
        fromMe: !!raw?.key?.fromMe,
        messageId,
        hasMessage: !!raw?.message,
        messageStubType: raw?.messageStubType ?? null,
        rawMessageKeys: raw?.message ? Object.keys(raw.message) : [],
      }, "WhatsApp message could not be decoded; leaving unclaimed for retry");
      return { status: "UNDECRYPTABLE_OR_UNSUPPORTED" };
    }

    if (upsertType !== "notify") {
      const allowedFreshAppend = upsertType === "append" && !norm.fromMe && isFreshAppend(norm);
      if (!allowedFreshAppend) {
        log.debug?.({
          businessId,
          upsertType,
          chatJid: norm.chatJid,
          messageId: norm.id,
          fromMe: norm.fromMe,
          timestampMs: norm.timestampMs,
        }, "WhatsApp history append ignored");
        return { status: "HISTORY_IGNORED" };
      }
    }

    const key = { businessId, connectionId, chatJid: norm.chatJid };

    // Never answer this account's own outbound/manual messages. Also do not
    // claim them as inbound, because the claim table is only for customer text
    // that is eligible to reach the Brain.
    if (norm.fromMe) {
      const botEcho = await state.isBotOutbound(key, norm.id).catch(() => false);
      if (!botEcho && typeof state.muteForHuman === "function") {
        // Real human takeover: mute the AI here for up to 5 minutes so it never
        // talks over the business owner/agent. Auto-reactivates after that.
        await state.muteForHuman(key, HUMAN_MUTE_SECONDS).catch((e) => log.warn?.({ e }, "muteForHuman failed"));
      }
      return { status: botEcho ? "BOT_ECHO" : "OWNER_MESSAGE" };
    }

    const text = String(norm.text || "").trim();
    if (!text) {
      // Do not poison dedupe with media/system/non-text stubs. A later retry can
      // carry a caption/text for the same id depending on Baileys decrypt state.
      log.info?.({
        businessId,
        upsertType,
        chatJid: norm.chatJid,
        messageId: norm.id,
        messageType: norm.messageType,
      }, "WhatsApp inbound ignored because no text was available");
      return { status: "NON_TEXT_IGNORED" };
    }

    // Atomic database claim happens only after the message is confirmed usable.
    // This prevents undecryptable/system/fromMe events from blocking a later
    // valid retry with the same WhatsApp message id.
    const claimed = await state.claimInboundEvent(key, norm.id);
    if (!claimed) return { status: "DUPLICATE" };

    await state.recordMessage(key, {
      direction: "in",
      sender: "customer",
      waMessageId: norm.id,
      text,
      mediaType: norm.messageType === "text" ? null : norm.messageType,
    });

    const chatState = typeof state.getChatState === "function"
      ? await state.getChatState(key).catch(() => null)
      : null;
    const isMuted = !!chatState?.muted_until && new Date(chatState.muted_until).getTime() > Date.now();
    const gate = evaluateBusinessIntent({
      text,
      messageType: norm.messageType,
      isMuted,
      businessSessionActiveUntil: chatState?.business_session_active_until || null,
    });

    if (isMuted) {
      log.info?.({ businessId, chatJid: norm.chatJid, messageId: norm.id }, "WhatsApp inbound skipped: human is handling this chat");
      return { status: "MUTED" };
    }

    if (!gate.allowed) {
      // Not a customer inquiry (greeting/friend/family/off-topic). Never call
      // the Brain for this. Send one short, static, non-AI notice instead.
      log.info?.({ businessId, chatJid: norm.chatJid, messageId: norm.id, reason: gate.reason }, "WhatsApp inbound classified as personal, not forwarded to Brain");
      try {
        const outboundId = await sendRegistered(key, { text: PERSONAL_AUTOREPLY });
        await state.recordMessage(key, { direction: "out", sender: "bot", waMessageId: outboundId, text: PERSONAL_AUTOREPLY, isBusinessContext: false, gateReason: gate.reason });
      } catch (e) {
        log.warn?.({ e }, "personal auto-reply send failed (non-blocking)");
      }
      return { status: "PERSONAL_MESSAGE" };
    }

    if (gate.activateSession && typeof state.activateSession === "function") {
      await state.activateSession(key, BUSINESS_SESSION_TTL_SECONDS, gate.reason).catch((e) => log.warn?.({ e }, "activateSession failed"));
    }

    const phone = resolveCustomerPhone(raw, norm.chatJid);
    log.info?.({
      businessId,
      chatJid: norm.chatJid,
      messageId: norm.id,
      messageType: norm.messageType,
      phone,
      upsertType,
      gateReason: gate.reason,
    }, "WhatsApp inbound forwarding to Brain");

    const data = await forwardIncomingToAI({
      business_id: businessId,
      connection_id: connectionId,
      chat_jid: norm.chatJid,
      phone,
      message: text,
      messages: [{ id: norm.id, type: norm.messageType, text }],
      push_name: norm.pushName || null,
    });

    const reply = typeof data?.reply === "string" ? data.reply.trim() : "";
    if (!reply) {
      log.warn?.({
        businessId,
        chatJid: norm.chatJid,
        messageId: norm.id,
        reason: data?.reason || data?.error || null,
      }, "Brain returned no WhatsApp reply");
      return { status: "NO_REPLY" };
    }

    const outboundId = await sendRegistered(key, { text: reply });
    return { status: "SENT", inboundId: norm.id, outboundId };
  };
}
