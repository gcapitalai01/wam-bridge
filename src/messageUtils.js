// Baileys raw-message extraction. Pure glue — no business/language decisions here
// (those live in businessIntentGate.js and languageDetector.js, reused as-is).

function unwrap(m) {
  let cur = m;
  for (let i = 0; i < 5 && cur; i++) {
    const inner = cur.ephemeralMessage?.message || cur.viewOnceMessage?.message ||
      cur.viewOnceMessageV2?.message || cur.viewOnceMessageV2Extension?.message ||
      cur.documentWithCaptionMessage?.message;
    if (!inner) break;
    cur = inner;
  }
  return cur || null;
}

const SYSTEM_KEYS = ["protocolMessage", "reactionMessage", "senderKeyDistributionMessage", "pollUpdateMessage"];

export function normalizeJid(jid) {
  if (!jid) return "";
  const [user, server] = String(jid).split("@");
  return `${user.split(":")[0]}@${server || "s.whatsapp.net"}`;
}

export function isIgnorableJid(jid) {
  if (!jid) return true;
  return jid.endsWith("@g.us") || jid.endsWith("@broadcast") || jid.endsWith("@newsletter") || jid === "status@broadcast";
}

function inlineQuotedText(q) {
  if (!q) return "";
  const c = unwrap(q) || {};
  return c.conversation || c.extendedTextMessage?.text || c.imageMessage?.caption || c.documentMessage?.caption || "";
}

export function extractMessage(raw) {
  const content = unwrap(raw?.message);
  if (!raw?.key?.remoteJid || !raw.key.id || !content) return null;

  let messageType = "unsupported";
  let text = "";
  let node = null;

  if (typeof content.conversation === "string") { messageType = "text"; text = content.conversation; }
  else if (content.extendedTextMessage) { messageType = "text"; node = content.extendedTextMessage; text = node.text || ""; }
  else if (content.imageMessage) { messageType = "image"; node = content.imageMessage; text = node.caption || ""; }
  else if (content.videoMessage) { messageType = "video"; node = content.videoMessage; text = node.caption || ""; }
  else if (content.audioMessage) { messageType = "audio"; node = content.audioMessage; }
  else if (content.stickerMessage) { messageType = "sticker"; node = content.stickerMessage; }
  else if (content.documentMessage) { messageType = "document"; node = content.documentMessage; text = node.caption || ""; }
  else if (SYSTEM_KEYS.some((k) => content[k])) { messageType = "system"; }

  const ci = node?.contextInfo;
  const quoted = ci?.stanzaId ? { stanzaId: ci.stanzaId, participant: ci.participant ? normalizeJid(ci.participant) : null, inlineText: inlineQuotedText(ci.quotedMessage) } : null;

  const ts = Number(raw.messageTimestamp?.low ?? raw.messageTimestamp ?? 0);
  return {
    id: raw.key.id,
    chatJid: raw.key.remoteJid,
    fromMe: !!raw.key.fromMe,
    messageType,
    text,
    quoted,
    pushName: raw.pushName || null,
    timestampMs: ts ? ts * 1000 : null,
  };
}
