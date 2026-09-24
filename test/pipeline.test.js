import { test } from "node:test";
import assert from "node:assert/strict";
import { createPipeline } from "../src/pipeline.js";

function fakeState(settingsOverride = {}) {
  const outbound = new Set();
  const messages = [];
  const chats = new Map();
  const claims = new Set();
  const k = (key) => `${key.businessId}|${key.connectionId}|${key.chatJid}`;
  const defaultSettings = { enabled: true, business_session_ttl_seconds: 900, debounce_seconds: 4, human_mute_seconds: 300, tenantKeywords: [], industryKeywords: [], tenantDefaultLanguage: null, ...settingsOverride };

  return {
    outbound, messages, chats, claims,
    async isBotOutbound(_key, id) { return outbound.has(id); },
    async registerOutbound(_key, id) { outbound.add(id); },
    async claimInboundEvent(key, id) {
      const ck = `${k(key)}|${id}`;
      if (claims.has(ck)) return false;
      claims.add(ck);
      return true;
    },
    async recordMessage(key, m) { messages.push({ key: k(key), ...m }); },
    async getChatState(key) { return chats.get(k(key)) || null; },
    async resolveQuoted() { return null; },
    async muteForHuman(key, seconds) {
      const safeSeconds = Math.min(300, seconds);
      const row = { muted_until: new Date(Date.now() + safeSeconds * 1000).toISOString(), business_session_active_until: null, pending_batch: [], processing_batch: [] };
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
      if (!row || row.debounceVersion !== version || !row.pending_batch?.length || row.processing_batch?.length) return null;
      const items = row.pending_batch;
      row.pending_batch = [];
      row.processing_batch = items;
      row.processingVersion = (row.processingVersion || 0) + 1;
      return { items, processingVersion: row.processingVersion };
    },
    async canSend(key, pv) { const row = chats.get(k(key)); return !!row && row.processingVersion === pv; },
    async commitProcessingForSend(key, pv) {
      const row = chats.get(k(key));
      if (!row || row.processingVersion !== pv) return false;
      if (row.muted_until && new Date(row.muted_until).getTime() > Date.now()) return false;
      row.processing_batch = [];
      row.processingCleared = true;
      row.processingVersion += 1;
      return true;
    },
    async persistLanguage(key, lang) { const row = chats.get(k(key)) || {}; row.detected_language = lang.language; chats.set(k(key), row); },
    async finishProcessing(key, pv) {
      const row = chats.get(k(key));
      if (row && row.processingVersion === pv) {
        row.processingCleared = true;
        row.processing_batch = [];
      }
      return true;
    },
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

test("Human fromMe real message => max 5-minute mute, cancels pending debounce, no AI on flush", async () => {
  const state = fakeState();
  let aiCalls = 0;
  const pipeline = createPipeline({ state, ai: async () => { aiCalls++; return "r"; }, send: { prepareId: async () => "id", deliver: async () => {} } });
  const opts = { businessId: "b1", connectionId: "c1" };
  await pipeline.handle(raw("do you have availability", { id: "M1" }), opts);
  const key = { businessId: "b1", connectionId: "c1", chatJid: "5215500000000@s.whatsapp.net" };
  const preFlushRow = state.chats.get("b1|c1|5215500000000@s.whatsapp.net");
  const r = await pipeline.handle(raw("ok", { id: "HUMAN1", fromMe: true }), opts);
  assert.equal(r.classification, "HUMAN_MANUAL");
  const mutedUntil = new Date(state.chats.get("b1|c1|5215500000000@s.whatsapp.net").muted_until).getTime();
  assert.ok(mutedUntil - Date.now() <= 300500);
  assert.ok(mutedUntil > Date.now());
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

test("English business message => allowed, session in English, then '3pm' stays contextual", async () => {
  const state = fakeState();
  const pipeline = createPipeline({ state, ai: async () => "Sure, that works.", send: { prepareId: async () => "id", deliver: async () => {} } });
  const opts = { businessId: "b1", connectionId: "c1" };
  await pipeline.handle(raw("what is the price for an installation", { id: "EN1" }), opts);
  const key = { businessId: "b1", connectionId: "c1", chatJid: "5215500000000@s.whatsapp.net" };
  const row1 = state.chats.get("b1|c1|5215500000000@s.whatsapp.net");
  assert.equal(row1.detected_language, "en");
  await pipeline.flush(key, row1.debounceVersion);
  const r2 = await pipeline.handle(raw("3pm", { id: "EN2" }), opts);
  assert.equal(r2.decision.allowed, true);
  assert.equal(r2.decision.reason, "ACTIVE_BUSINESS_SESSION");
});

test("Spanish business message => session in Spanish, later '3pm' keeps business context and Spanish session language", async () => {
  const state = fakeState();
  const seenLangs = [];
  const pipeline = createPipeline({ state, ai: async ({ language }) => { seenLangs.push(language); return "Claro, listo."; }, send: { prepareId: async () => "id", deliver: async () => {} } });
  const opts = { businessId: "b1", connectionId: "c1" };
  await pipeline.handle(raw("cuanto cuesta la instalacion", { id: "ES1" }), opts);
  const key = { businessId: "b1", connectionId: "c1", chatJid: "5215500000000@s.whatsapp.net" };
  const row1 = state.chats.get("b1|c1|5215500000000@s.whatsapp.net");
  assert.equal(row1.detected_language, "es");
  await pipeline.flush(key, row1.debounceVersion);
  // "mañana" (tomorrow) has no strong-enough signal on its own to override the
  // stored session language via the detector, so it exercises the same
  // session-language fallback path as a bare "3pm" would, deterministically.
  const r2 = await pipeline.handle(raw("mañana", { id: "ES2" }), opts);
  assert.equal(r2.decision.allowed, true);
  assert.equal(r2.decision.reason, "ACTIVE_BUSINESS_SESSION");
  const row2 = state.chats.get("b1|c1|5215500000000@s.whatsapp.net");
  await pipeline.flush(key, row2.debounceVersion);
  // The session language stays Spanish across turns.
  assert.equal(seenLangs[1], "es");
});

test("settings.enabled === false stops before AI/debounce, even for a clear business keyword", async () => {
  const state = fakeState({ enabled: false });
  let aiCalls = 0;
  const pipeline = createPipeline({ state, ai: async () => { aiCalls++; return "x"; }, send: { prepareId: async () => "id", deliver: async () => {} } });
  const r = await pipeline.handle(raw("how much does it cost"), { businessId: "b1", connectionId: "c1" });
  assert.equal(r.decision.allowed, false);
  assert.equal(r.decision.reason, "AUTOMATION_DISABLED");
  assert.equal(state.chats.get("b1|c1|5215500000000@s.whatsapp.net")?.pending_batch, undefined);
  assert.equal(aiCalls, 0);
});

test("Revoked payment/admin access => zero AI, zero send, even after activation passed", async () => {
  const state = fakeState();
  let aiCalls = 0, sendCalls = 0;
  const pipeline = createPipeline({
    state, checkAccess: async () => ({ allowed: false, reason: "PAID_PLAN_REQUIRED" }),
    ai: async () => { aiCalls++; return "x"; },
    send: { prepareId: async () => { sendCalls++; return "id"; }, deliver: async () => {} },
  });
  const opts = { businessId: "b1", connectionId: "c1" };
  await pipeline.handle(raw("how much does it cost"), opts);
  const key = { businessId: "b1", connectionId: "c1", chatJid: "5215500000000@s.whatsapp.net" };
  const row = state.chats.get("b1|c1|5215500000000@s.whatsapp.net");
  const result = await pipeline.flush(key, row.debounceVersion);
  assert.equal(result.status, "ACCESS_BLOCKED");
  assert.equal(aiCalls, 0);
  assert.equal(sendCalls, 0);
});

test("History-sync append of an old fromMe message => HISTORY, never a human mute", async () => {
  const state = fakeState();
  const pipeline = createPipeline({ state, ai: async () => "x", send: { prepareId: async () => "id", deliver: async () => {} } });
  const r = await pipeline.handle(raw("old outbound text", { fromMe: true, id: "OLD1" }), { businessId: "b1", connectionId: "c1", upsertType: "append" });
  assert.equal(r.classification, "HISTORY");
  assert.equal(state.chats.size, 0); // no mute row created
});

test("successful send commits and clears crash-recovery batch before external delivery", async () => {
  const state = fakeState();
  const pipeline = createPipeline({ state, ai: async () => "reply", send: { prepareId: async () => "id", deliver: async () => {} } });
  const opts = { businessId: "b1", connectionId: "c1" };
  await pipeline.handle(raw("what is the price"), opts);
  const key = { businessId: "b1", connectionId: "c1", chatJid: "5215500000000@s.whatsapp.net" };
  const row = state.chats.get("b1|c1|5215500000000@s.whatsapp.net");
  await pipeline.flush(key, row.debounceVersion);
  assert.equal(row.processingCleared, true);
});


test("Two pipeline instances sharing the same DB claim process one inbound event only", async () => {
  const state = fakeState();
  const send = { prepareId: async () => "id", deliver: async () => {} };
  const p1 = createPipeline({ state, ai: async () => "r", send });
  const p2 = createPipeline({ state, ai: async () => "r", send });
  const msg = raw("what is the price", { id: "RACE1" });
  const opts = { businessId: "b1", connectionId: "c1" };
  const first = await p1.handle(msg, opts);
  const second = await p2.handle(msg, opts);
  assert.equal(first.classification, "CUSTOMER");
  assert.equal(second.classification, "DUPLICATE");
});


test("AI failure leaves claimed batch recoverable instead of clearing it", async () => {
  const state = fakeState();
  const pipeline = createPipeline({
    state,
    ai: async () => { throw new Error("temporary ai failure"); },
    send: { prepareId: async () => "id", deliver: async () => {} },
  });
  const opts = { businessId: "b1", connectionId: "c1" };
  await pipeline.handle(raw("what is the price", { id: "RECOVER1" }), opts);
  const key = { businessId: "b1", connectionId: "c1", chatJid: "5215500000000@s.whatsapp.net" };
  const row = state.chats.get("b1|c1|5215500000000@s.whatsapp.net");
  await assert.rejects(() => pipeline.flush(key, row.debounceVersion), /temporary ai failure/);
  assert.equal(row.processing_batch.length, 1);
  assert.notEqual(row.processingCleared, true);
});


test("Fresh direct append keeps the full business-intent gate and can enter debounce", async () => {
  const state = fakeState();
  const pipeline = createPipeline({ state, ai: async () => "reply", send: { prepareId: async () => "id", deliver: async () => {} } });
  const r = raw("what is the price", { id: "APPEND-FRESH" });
  const result = await pipeline.handle(r, { businessId: "b1", connectionId: "c1", upsertType: "append" });
  assert.equal(result.classification, "CUSTOMER");
  assert.equal(result.decision.allowed, true);
  const row = state.chats.get("b1|c1|5215500000000@s.whatsapp.net");
  assert.equal(row.pending_batch.length, 1);
});

test("Fresh personal append is still blocked before AI/debounce", async () => {
  const state = fakeState();
  let aiCalls = 0;
  const pipeline = createPipeline({ state, ai: async () => { aiCalls++; return "reply"; }, send: { prepareId: async () => "id", deliver: async () => {} } });
  const r = raw("hola", { id: "APPEND-PERSONAL" });
  const result = await pipeline.handle(r, { businessId: "b1", connectionId: "c1", upsertType: "append" });
  assert.equal(result.decision.allowed, false);
  assert.equal(result.decision.reason, "PERSONAL_MESSAGE");
  assert.equal(aiCalls, 0);
});
