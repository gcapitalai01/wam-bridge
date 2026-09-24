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
