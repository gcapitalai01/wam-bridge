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
