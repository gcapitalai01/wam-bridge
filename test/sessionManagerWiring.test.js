import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("session manager retries deploy lease takeover without duplicate timers", async () => {
  const source = await readFile(new URL("../src/sessionManager.js", import.meta.url), "utf8");
  assert.match(source, /const resumeRetryTimers = new Map\(\)/);
  assert.match(source, /if \(resumeRetryTimers\.has\(businessId\)\) return/);
  assert.match(source, /if \(e\?\.code === "SESSION_OWNED_ELSEWHERE"\) \{\s*scheduleResumeRetry\(row\.business_id\)/s);
  assert.match(source, /clearResumeRetry\(businessId\);\s*st\.lastLeaseRenewedAt/s);
  assert.match(source, /clearResumeRetry\(businessId\);\s*clearLeaseTimer\(st\)/s);
});


test("production socket disables optional Baileys init queries", async () => {
  const source = await readFile(new URL("../src/sessionManager.js", import.meta.url), "utf8");
  assert.match(source, /fireInitQueries:\s*false/);
});


test("bulk session resume is bounded and Baileys version lookup is cached per process", async () => {
  const source = await readFile(new URL("../src/sessionManager.js", import.meta.url), "utf8");
  assert.match(source, /const RESUME_CONCURRENCY = 5/);
  assert.match(source, /const RESUME_STAGGER_MS = 250/);
  assert.match(source, /let baileysVersionPromise = null/);
  assert.match(source, /const version = await getBaileysVersion\(\)/);
  assert.match(source, /const workerCount = Math\.min\(RESUME_CONCURRENCY, rows\.length\)/);
  assert.match(source, /await Promise\.all\(Array\.from\(\{ length: workerCount \}, \(\) => resumeWorker\(\)\)\)/);
});
