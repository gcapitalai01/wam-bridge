import test from "node:test";
import assert from "node:assert/strict";
import { createSimpleInboundHandler } from "../src/simpleInbound.js";

function raw(text, {
  id = "M1",
  fromMe = false,
  remoteJid = "15551234567@s.whatsapp.net",
  timestampMs = Date.now(),
  message = undefined,
} = {}) {
  return {
    key: { remoteJid, id, fromMe },
    message: message === undefined ? { conversation: text } : message,
    messageTimestamp: Math.floor(timestampMs / 1000),
    pushName: "Customer",
  };
}

function fakeState() {
  const claims = new Set();
  const outbound = new Set();
  const messages = [];
  return {
    claims,
    outbound,
    messages,
    async claimInboundEvent(key, id) {
      const k = `${key.businessId}|${key.connectionId}|${key.chatJid}|${id}`;
      if (claims.has(k)) return false;
      claims.add(k);
      return true;
    },
    async isBotOutbound(_key, id) {
      return outbound.has(id);
    },
    async recordMessage(_key, msg) {
      messages.push(msg);
    },
  };
}

test("same inbound message id reaches Brain and WhatsApp exactly once", async () => {
  const state = fakeState();
  let brainCalls = 0;
  let sends = 0;

  const handle = createSimpleInboundHandler({
    state,
    forwardIncomingToAI: async () => {
      brainCalls += 1;
      return { reply: "Respuesta" };
    },
    sendRegistered: async () => {
      sends += 1;
      return "OUT-1";
    },
    log: {},
  });

  const event = raw("Hola", { id: "DUP-1" });
  const opts = {
    businessId: "b1",
    connectionId: "c1",
    raw: event,
    upsertType: "notify",
  };

  const first = await handle(opts);
  const second = await handle(opts);
  const third = await handle(opts);

  assert.equal(first.status, "SENT");
  assert.equal(second.status, "DUPLICATE");
  assert.equal(third.status, "DUPLICATE");
  assert.equal(brainCalls, 1);
  assert.equal(sends, 1);
});

test("fromMe never calls Brain, sends a reply, or claims inbound", async () => {
  const state = fakeState();
  let brainCalls = 0;
  let sends = 0;

  const handle = createSimpleInboundHandler({
    state,
    forwardIncomingToAI: async () => {
      brainCalls += 1;
      return { reply: "x" };
    },
    sendRegistered: async () => {
      sends += 1;
      return "OUT";
    },
    log: {},
  });

  const result = await handle({
    businessId: "b1",
    connectionId: "c1",
    raw: raw("manual owner text", { id: "OWN-1", fromMe: true }),
    upsertType: "notify",
  });

  assert.equal(result.status, "OWNER_MESSAGE");
  assert.equal(brainCalls, 0);
  assert.equal(sends, 0);
  assert.equal(state.claims.size, 0);
});

test("groups and old history append never reach Brain", async () => {
  const state = fakeState();
  let brainCalls = 0;

  const handle = createSimpleInboundHandler({
    state,
    forwardIncomingToAI: async () => {
      brainCalls += 1;
      return { reply: "x" };
    },
    sendRegistered: async () => "OUT",
    log: {},
  });

  const group = await handle({
    businessId: "b1",
    connectionId: "c1",
    raw: raw("hello", { id: "G1", remoteJid: "120363000@g.us" }),
    upsertType: "notify",
  });
  const history = await handle({
    businessId: "b1",
    connectionId: "c1",
    raw: raw("old message", { id: "H1", timestampMs: Date.now() - 10 * 60 * 1000 }),
    upsertType: "append",
  });

  assert.equal(group.status, "JID_IGNORED");
  assert.equal(history.status, "HISTORY_IGNORED");
  assert.equal(brainCalls, 0);
});

test("fresh direct append can reach Brain once", async () => {
  const state = fakeState();
  let brainCalls = 0;
  let sends = 0;

  const handle = createSimpleInboundHandler({
    state,
    forwardIncomingToAI: async () => {
      brainCalls += 1;
      return { reply: "Respuesta append" };
    },
    sendRegistered: async () => {
      sends += 1;
      return "OUT-APPEND";
    },
    log: {},
  });

  const result = await handle({
    businessId: "b1",
    connectionId: "c1",
    raw: raw("precio", { id: "APPEND-1" }),
    upsertType: "append",
  });

  assert.equal(result.status, "SENT");
  assert.equal(brainCalls, 1);
  assert.equal(sends, 1);
});

test("Brain returning no reply causes no WhatsApp send", async () => {
  const state = fakeState();
  let sends = 0;

  const handle = createSimpleInboundHandler({
    state,
    forwardIncomingToAI: async () => ({ reply: null }),
    sendRegistered: async () => {
      sends += 1;
      return "OUT";
    },
    log: {},
  });

  const result = await handle({
    businessId: "b1",
    connectionId: "c1",
    raw: raw("Hola", { id: "NOREPLY-1" }),
    upsertType: "notify",
  });

  assert.equal(result.status, "NO_REPLY");
  assert.equal(sends, 0);
});

test("undecryptable messages are not claimed so a later Baileys retry can pass", async () => {
  const state = fakeState();
  let brainCalls = 0;

  const handle = createSimpleInboundHandler({
    state,
    forwardIncomingToAI: async () => {
      brainCalls += 1;
      return { reply: "ok" };
    },
    sendRegistered: async () => "OUT",
    log: {},
  });

  const bad = await handle({
    businessId: "b1",
    connectionId: "c1",
    raw: raw("", { id: "RETRY-1", message: null }),
    upsertType: "notify",
  });
  const good = await handle({
    businessId: "b1",
    connectionId: "c1",
    raw: raw("Hola quiero precio", { id: "RETRY-1" }),
    upsertType: "notify",
  });

  assert.equal(bad.status, "UNDECRYPTABLE_OR_UNSUPPORTED");
  assert.equal(good.status, "SENT");
  assert.equal(brainCalls, 1);
  assert.equal(state.claims.size, 1);
});

test("non-text messages are not claimed and do not block a later text retry", async () => {
  const state = fakeState();
  let brainCalls = 0;

  const handle = createSimpleInboundHandler({
    state,
    forwardIncomingToAI: async () => {
      brainCalls += 1;
      return { reply: "ok" };
    },
    sendRegistered: async () => "OUT",
    log: {},
  });

  const noText = await handle({
    businessId: "b1",
    connectionId: "c1",
    raw: raw("", { id: "MEDIA-1", message: { imageMessage: {} } }),
    upsertType: "notify",
  });
  const withText = await handle({
    businessId: "b1",
    connectionId: "c1",
    raw: raw("", { id: "MEDIA-1", message: { imageMessage: { caption: "quiero precio" } } }),
    upsertType: "notify",
  });

  assert.equal(noText.status, "NON_TEXT_IGNORED");
  assert.equal(withText.status, "SENT");
  assert.equal(brainCalls, 1);
  assert.equal(state.claims.size, 1);
});
