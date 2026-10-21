import test from "node:test";
import assert from "node:assert/strict";
import { getSentMessage, sendWithRetryCache } from "../src/sentCache.js";

test("retry payload exists before sendMessage resolves", async () => {
  const id = "retry-inflight-1";
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const sock = { async sendMessage(jid, content, options) {
    assert.equal(jid, "123@s.whatsapp.net");
    assert.equal(options.messageId, id);
    assert.deepEqual(getSentMessage(id), { conversation: "Hello" });
    await gate;
    return { key: { id }, message: { extendedTextMessage: { text: "Hello" } } };
  } };
  const promise = sendWithRetryCache(sock, "123@s.whatsapp.net", { text: "Hello" }, id);
  assert.deepEqual(getSentMessage(id), { conversation: "Hello" });
  release();
  await promise;
  assert.deepEqual(getSentMessage(id), { extendedTextMessage: { text: "Hello" } });
});

test("a send error never triggers a duplicate send and preserves retry fallback", async () => {
  const id = "retry-failure-2";
  let calls = 0;
  const sock = { async sendMessage() { calls++; throw new Error("network interrupted"); } };
  await assert.rejects(sendWithRetryCache(sock, "123@s.whatsapp.net", { text: "Test" }, id));
  assert.equal(calls, 1);
  assert.deepEqual(getSentMessage(id), { conversation: "Test" });
});

test("messageId is mandatory for idempotent retries", async () => {
  await assert.rejects(sendWithRetryCache({ sendMessage() { throw new Error("must not send"); } }, "123@s.whatsapp.net", { text: "X" }, null), /messageId/);
});
