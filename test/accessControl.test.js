import test from "node:test";
import assert from "node:assert/strict";
import { evaluateWhatsAppAccess, createCachedAccessCheck } from "../src/accessControl.js";

test("unregistered business cannot connect", () => {
  assert.equal(evaluateWhatsAppAccess({ businessExists: false }).allowed, false);
});

test("deleted business cannot connect", () => {
  assert.equal(evaluateWhatsAppAccess({ businessExists: true, deletedAt: new Date().toISOString() }).allowed, false);
});

test("active business subscription status can connect", () => {
  const result = evaluateWhatsAppAccess({ businessExists: true, businessSubscriptionStatus: "active" });
  assert.equal(result.allowed, true);
  assert.equal(result.reason, "ACTIVE_PAID_SUBSCRIPTION");
});

test("active subscription row can connect", () => {
  assert.equal(evaluateWhatsAppAccess({ businessExists: true, hasActiveSubscription: true }).allowed, true);
});

test("admin WhatsApp override can connect without paid status", () => {
  const result = evaluateWhatsAppAccess({ businessExists: true, adminOverride: true });
  assert.equal(result.allowed, true);
  assert.equal(result.reason, "ADMIN_OVERRIDE");
});

test("trial does not connect unless admin overrides it", () => {
  assert.equal(evaluateWhatsAppAccess({ businessExists: true, businessSubscriptionStatus: "trial" }).allowed, false);
  assert.equal(evaluateWhatsAppAccess({ businessExists: true, businessSubscriptionStatus: "trial", adminOverride: true }).allowed, true);
});

test("cached access check reuses the result within the TTL", async () => {
  let calls = 0;
  const check = createCachedAccessCheck(async () => { calls++; return { allowed: true, reason: "ACTIVE_PAID_SUBSCRIPTION" }; }, 60000);
  await check("biz1"); await check("biz1"); await check("biz1");
  assert.equal(calls, 1);
});

test("cached access check re-queries a different business independently", async () => {
  let calls = 0;
  const check = createCachedAccessCheck(async (id) => { calls++; return { allowed: id === "biz1" }; }, 60000);
  await check("biz1"); await check("biz2");
  assert.equal(calls, 2);
});

test("cached access check fails closed and does not cache a thrown lookup error", async () => {
  let calls = 0;
  const check = createCachedAccessCheck(async () => { calls++; throw new Error("db down"); }, 60000);
  const r1 = await check("biz1");
  const r2 = await check("biz1");
  assert.equal(r1.allowed, false);
  assert.equal(r2.allowed, false);
  assert.equal(calls, 2); // not cached, since the lookup itself failed
});
