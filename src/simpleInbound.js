import { extractMessage, isIgnorableJid } from "./messageUtils.js";

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

    const phone = resolveCustomerPhone(raw, norm.chatJid);
    log.info?.({
      businessId,
      chatJid: norm.chatJid,
      messageId: norm.id,
      messageType: norm.messageType,
      phone,
      upsertType,
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
