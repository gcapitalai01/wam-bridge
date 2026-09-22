import { test } from "node:test";
import assert from "node:assert/strict";
import { createPipeline } from "../src/pipeline.js";

function fakeState() {
  const outbound = new Set();
  const messages = [];
  const chats = new Map();
  const k = (key) => `${key.businessId}|${key.connectionId}|${key.chatJid}`;
  const defaultSettings = { enabled: true, business_session_ttl_seconds: 900, debounce_seconds: 4, human_mute_seconds: 1800, tenantKeywords: [], industryKeywords: [], tenantDefaultLanguage: null };

  return {
    outbound, messages, chats,
    async isBotOutbound(_key, id) { return outbound.has(id); },
    async registerOutbound(_key, id) { outbound.add(id); },
    async wasSeen(key, id) { return messages.some((m) => m.key === k(key) && m.waMessageId === id); },
    async recordMessage(key, m) { messages.push({ key: k(key), ...m }); },
    async getChatState(key) { return chats.get(k(key)) || null; },
    async resolveQuoted() { return null; },
    async muteForHuman(key, seconds) {
      const row = { muted_until: new Date(Date.now() + seconds * 1000).toISOString(), business_session_active_until: null, pending_batch: [] };
      chats.set(k(key), row); return row;
    },
    async enqueue(key, item, { activate, reason, ttlSeconds, debounceMs }) {
      const kk = k(key);
      let row = chats.get(kk) || { pending_batch: [] };
      if (row.muted_until && new Date(row.muted_until).getTime() > Date.now()) return { accepted: false, debounceVersion: row.debounceVersion || 0 };
      row.pending_batch = [...(row.pending_batch || []), item];
      row.debounceVersion = (row.debounceVersion || 0) + 1;
      row.dueAt = Date.now() + debounceMs;
      if (activate) { row.business_session_active_until = new Date(Date.now() + ttlSeconds * 1000).toISOString(); row.business_session_reason = reason; }
      chats.set(kk, row);
      return { accepted: true, debounceVersion: row.debounceVersion, dueAt: row.dueAt };
    },
    async claimBatch(key, version) {
      const kk = k(key); const row = chats.get(kk);
      if (!row || row.debounceVersion !== version || !row.pending_batch?.length) return null;
      const items = row.pending_batch; row.pending_batch = [];
      row.processingVersion = (row.processingVersion || 0) + 1;
      return { items, processingVersion: row.processingVersion };
    },
    async canSend(key, pv) { const row = chats.get(k(key)); return !!row && row.processingVersion === pv; },
    async persistLanguage(key, lang) { const row = chats.get(k(key)) || {}; row.detected_language = lang.language; chats.set(k(key), row); },
    async dueBatches() { return []; },
    async getSettings() { return defaultSettings; },
  };
}

function raw(text, { id = "M1", fromMe = false, type = "conversation" } = {}) {
  const message = type === "sticker" ? { stickerMessage: {} } : type === "image" ? { imageMessage: { caption: text || "" } } : { conversation: text };
  return { key: { remoteJid: "5215500000000@s.whatsapp.net", id, fromMe }, message, messageTimestamp: Math.floor(Date.now() / 1000), pushName: "Test" };
}

test("Personal/small-talk message: STOP COMPLETELY — no debounce, no AI, no reply", async () => {
  const state = fakeState();
  let aiCalls = 0, sent = 0;
  const pipeline = createPipeline({ state, ai: async () => { aiCalls++; return "x"; }, send: { prepareId: async () => "id", deliver: async () => { sent++; } } });
  const r = await pipeline.handle(raw("hey how are you"), { businessId: "b1", connectionId: "c1" });
  assert.equal(r.decision.allowed, false);
  const row = state.chats.get("b1|c1|5215500000000@s.whatsapp.net");
  assert.equal(row?.business_session_active_until, undefined); // no session opened
  assert.equal(row?.pending_batch, undefined);                  // no debounce entry
  assert.equal(aiCalls, 0);
  assert.equal(sent, 0);
});

test("Business keyword => allowed true, session updated, debounce scheduled", async () => {
  const state = fakeState();
  const pipeline = createPipeline({ state, ai: async () => "reply", send: { prepareId: async () => "id", deliver: async () => {} } });
  const r = await pipeline.handle(raw("what is the price for a roof repair"), { businessId: "b1", connectionId: "c1" });
  assert.equal(r.decision.allowed, true);
  const row = state.chats.get("b1|c1|5215500000000@s.whatsapp.net");
  assert.ok(row.business_session_active_until);
  assert.equal(row.pending_batch.length, 1);
});

test("Human fromMe real message => 30-minute mute, cancels pending debounce, no AI on flush", async () => {
  const state = fakeState();
  let aiCalls = 0;
  const pipeline = createPipeline({ state, ai: async () => { aiCalls++; return "r"; }, send: { prepareId: async () => "id", deliver: async () => {} } });
  const opts = { businessId: "b1", connectionId: "c1" };
  await pipeline.handle(raw("do you have availability", { id: "M1" }), opts);
  const key = { businessId: "b1", connectionId: "c1", chatJid: "5215500000000@s.whatsapp.net" };
  const preFlushRow = state.chats.get("b1|c1|5215500000000@s.whatsapp.net");
  const r = await pipeline.handle(raw("ok", { id: "HUMAN1", fromMe: true }), opts);
  assert.equal(r.classification, "HUMAN_MANUAL");
  assert.ok(state.chats.get("b1|c1|5215500000000@s.whatsapp.net").muted_until);
  // Flushing the pre-mute debounce version must not call the AI (claimBatch sees pending_batch cleared / muted).
  await pipeline.flush(key, preFlushRow.debounceVersion);
  assert.equal(aiCalls, 0);
});

test("Bot outbound echo (registered id) => not muted, not treated as customer message", async () => {
  const state = fakeState();
  state.outbound.add("BOTMSG1");
  const pipeline = createPipeline({ state, ai: async () => "x", send: { prepareId: async () => "id", deliver: async () => {} } });
  const r = await pipeline.handle(raw("hi", { id: "BOTMSG1", fromMe: true }), { businessId: "b1", connectionId: "c1" });
  assert.equal(r.classification, "BOT_OUTBOUND");
  assert.equal(state.chats.size, 0);
});

test("Duplicate WhatsApp event => processed once", async () => {
  const state = fakeState();
  let calls = 0;
  const pipeline = createPipeline({ state, ai: async () => { calls++; return "r"; }, send: { prepareId: async () => "id", deliver: async () => {} } });
  const r = raw("price please", { id: "DUP1" });
  const opts = { businessId: "b1", connectionId: "c1" };
  const first = await pipeline.handle(r, opts);
  const second = await pipeline.handle(r, opts);
  assert.equal(first.classification, "CUSTOMER");
  assert.equal(second.classification, "DUPLICATE");
});

test("Full flush: reply carries the detected language and registers outbound id in bot_sent_messages", async () => {
  const state = fakeState();
  const seenLangs = [];
  const pipeline = createPipeline({
    state,
    ai: async ({ language }) => { seenLangs.push(language); return "gracias por tu mensaje"; },
    send: { prepareId: async () => "OUT_ID_1", deliver: async () => {} },
  });
  const opts = { businessId: "b1", connectionId: "c1" };
  await pipeline.handle(raw("cuanto cuesta la instalacion", { id: "M1" }), opts);
  const key = { businessId: "b1", connectionId: "c1", chatJid: "5215500000000@s.whatsapp.net" };
  const row = state.chats.get("b1|c1|5215500000000@s.whatsapp.net");
  const result = await pipeline.flush(key, row.debounceVersion);
  assert.equal(result.status, "SENT");
  assert.equal(seenLangs[0], "es");
  assert.ok(state.outbound.has("OUT_ID_1"));
});

test("Photo without verified business quote => STOP COMPLETELY (UNSUPPORTED_MEDIA)", async () => {
  const state = fakeState();
  let aiCalls = 0;
  const pipeline = createPipeline({ state, ai: async () => { aiCalls++; return "x"; }, send: { prepareId: async () => "id", deliver: async () => {} } });
  const r = await pipeline.handle(raw("", { type: "image" }), { businessId: "b1", connectionId: "c1" });
  assert.equal(r.decision.allowed, false);
  assert.equal(r.decision.reason, "UNSUPPORTED_MEDIA");
  assert.equal(aiCalls, 0);
});

test("Sticker => STOP COMPLETELY", async () => {
  const state = fakeState();
  const pipeline = createPipeline({ state, ai: async () => "x", send: { prepareId: async () => "id", deliver: async () => {} } });
  const r = await pipeline.handle(raw("", { type: "sticker" }), { businessId: "b1", connectionId: "c1" });
  assert.equal(r.decision.allowed, false);
});

test("Active business session + bare contextual reply (\"3pm\") continues", async () => {
  const state = fakeState();
  state.chats.set("b1|c1|5215500000000@s.whatsapp.net", { business_session_active_until: new Date(Date.now() + 60000).toISOString(), pending_batch: [] });
  const pipeline = createPipeline({ state, ai: async () => "ok", send: { prepareId: async () => "id", deliver: async () => {} } });
  const r = await pipeline.handle(raw("3pm"), { businessId: "b1", connectionId: "c1" });
  assert.equal(r.decision.allowed, true);
  assert.equal(r.decision.reason, "ACTIVE_BUSINESS_SESSION");
});

test("Active business session does NOT mean reply to everything (random small talk still stops)", async () => {
  const state = fakeState();
  state.chats.set("b1|c1|5215500000000@s.whatsapp.net", { business_session_active_until: new Date(Date.now() + 60000).toISOString(), pending_batch: [] });
  const pipeline = createPipeline({ state, ai: async () => "ok", send: { prepareId: async () => "id", deliver: async () => {} } });
  const r = await pipeline.handle(raw("hey how are you"), { businessId: "b1", connectionId: "c1" });
  assert.equal(r.decision.allowed, false);
});

test("Message while muted => STOP COMPLETELY even with a business keyword", async () => {
  const state = fakeState();
  state.chats.set("b1|c1|5215500000000@s.whatsapp.net", { muted_until: new Date(Date.now() + 60000).toISOString(), pending_batch: [] });
  const pipeline = createPipeline({ state, ai: async () => "ok", send: { prepareId: async () => "id", deliver: async () => {} } });
  const r = await pipeline.handle(raw("how much does it cost"), { businessId: "b1", connectionId: "c1" });
  assert.equal(r.decision.allowed, false);
  assert.equal(r.decision.reason, "MUTED");
});
