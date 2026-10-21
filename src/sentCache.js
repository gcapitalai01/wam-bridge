// Recent outbound messages, so Baileys can re-send them on retry receipts.
const MAX = 3000;
const cache = new Map();
export function rememberSentMessage(id, message) {
  if (!id || !message) return;
  cache.delete(id);
  cache.set(id, message);
  while (cache.size > MAX) cache.delete(cache.keys().next().value);
}
export function getSentMessage(id) {
  return cache.get(id);
}

// Make retry payload available BEFORE awaiting network send: retry receipts
// may arrive while Baileys is still sending, especially on unstable sessions.
// Never send twice here: Baileys owns retry receipts and message idempotency.
export async function sendWithRetryCache(sock, chatJid, content, messageId) {
  if (!messageId) throw new Error("messageId is required");
  if (typeof content?.text === "string") {
    rememberSentMessage(messageId, { conversation: content.text });
  }
  const sent = await sock.sendMessage(chatJid, content, { messageId });
  rememberSentMessage(sent?.key?.id || messageId,
    sent?.message || (typeof content?.text === "string" ? { conversation: content.text } : null));
  return sent;
}
