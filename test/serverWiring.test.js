import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("production server wires WhatsApp inbound through the gated pipeline", async () => {
  const source = await readFile(new URL("../server.js", import.meta.url), "utf8");
  assert.match(source, /import \{ createPipeline \} from "\.\/src\/pipeline\.js";/);
  assert.match(source, /const inboundPipeline = createPipeline\(/);
  assert.match(source, /inboundPipeline\.handle\(/);
  assert.match(source, /checkAccess: checkWhatsAppAccessCached/);
  assert.doesNotMatch(source, /createSimpleInboundHandler/);
  assert.doesNotMatch(source, /handleSimpleInbound/);
});


test("text replies disable optional automatic link previews", async () => {
  const source = await readFile(new URL("../server.js", import.meta.url), "utf8");
  assert.match(source, /function safeTextContent\(payload\)/);
  assert.match(source, /return \{ \.\.\.content, linkPreview: null \}/);
  assert.match(source, /const content = safeTextContent\(payload\)/);
  assert.match(source, /const payload = safeTextContent\(content\)/);
});


test("safeTextContent does not recurse and is used by all text send paths", async () => {
  const source = await readFile(new URL("../server.js", import.meta.url), "utf8");
  assert.match(source, /function safeTextContent\(payload\) \{\s*const content = typeof payload === "string" \? \{ text: payload \} : payload;/s);
  assert.doesNotMatch(source, /function safeTextContent\(payload\) \{\s*const content = safeTextContent\(payload\)/s);
  assert.match(source, /async function sendRegistered[\s\S]*?const content = safeTextContent\(payload\)/);
  assert.match(source, /deliver: async[\s\S]*?const payload = safeTextContent\(content\)/);
});
