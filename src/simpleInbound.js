import { extractMessage, isIgnorableJid } from "./messageUtils.js";

const jidToPhone = (jid) => String(jid || "").split("@")[0].split(":")[0];

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
    if (upsertType !== "notify") return { status: "HISTORY_IGNORED" };

    const remoteJid = raw?.key?.remoteJid || "";
    if (isIgnorableJid(remoteJid)) return { status: "JID_IGNORED" };

    const norm = extractMessage(raw);
    if (!norm) {
      log.warn?.({
        businessId,
        upsertType,
        remoteJid,
        fromMe: !!raw?.key?.fromMe,
        messageId: raw?.key?.id || null,
        hasMessage: !!raw?.message,
        messageStubType: raw?.messageStubType ?? null,
      }, "WhatsApp message could not be decoded");
      return { status: "UNDECRYPTABLE_OR_UNSUPPORTED" };
    }

    const key = { businessId, connectionId, chatJid: norm.chatJid };

    // Atomic database claim is the authority. If WhatsApp retries the same
    // message, only the first copy can ever reach the Brain.
    const claimed = await state.claimInboundEvent(key, norm.id);
    if (!claimed) return { status: "DUPLICATE" };

    // Never answer this account's own outbound/manual messages.
    if (norm.fromMe) {
      const botEcho = await state.isBotOutbound(key, norm.id).catch(() => false);
      return { status: botEcho ? "BOT_ECHO" : "OWNER_MESSAGE" };
    }

    const text = String(norm.text || "").trim();
    if (!text) return { status: "NON_TEXT_IGNORED" };

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
      phone,
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
