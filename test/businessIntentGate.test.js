import test from "node:test";
import assert from "node:assert/strict";
import { evaluateBusinessIntent } from "../src/businessIntentGate.js";

const future = new Date(Date.now() + 15 * 60 * 1000).toISOString();
const past = new Date(Date.now() - 1000).toISOString();

test("ignores greeting", () => {
  assert.equal(evaluateBusinessIntent({ text: "Hey" }).allowed, false);
});

test("ignores personal small talk", () => {
  const result = evaluateBusinessIntent({ text: "How are you?" });
  assert.equal(result.allowed, false);
  assert.equal(result.reason, "PERSONAL_MESSAGE");
});

test("activates English pricing intent", () => {
  const result = evaluateBusinessIntent({ text: "How much does it cost?" });
  assert.equal(result.allowed, true);
  assert.equal(result.reason, "DIRECT_BUSINESS_PATTERN");
});

test("activates Spanish pricing intent", () => {
  assert.equal(evaluateBusinessIntent({ text: "Cuánto cuesta?" }).allowed, true);
});

test("activates industry keyword", () => {
  const result = evaluateBusinessIntent({
    text: "I need a roof estimate",
    industryKeywords: ["roof", "roofer", "roofing"]
  });
  assert.equal(result.allowed, true);
});

test("activates booking intent", () => {
  assert.equal(evaluateBusinessIntent({ text: "Can I book tomorrow?" }).allowed, true);
});

test("active business session accepts yes", () => {
  const result = evaluateBusinessIntent({
    text: "yes",
    businessSessionActiveUntil: future
  });
  assert.equal(result.allowed, true);
  assert.equal(result.reason, "ACTIVE_BUSINESS_SESSION");
});

test("active business session accepts tomorrow at 3", () => {
  const result = evaluateBusinessIntent({
    text: "tomorrow at 3pm",
    businessSessionActiveUntil: future
  });
  assert.equal(result.allowed, true);
});

test("expired business session rejects yes", () => {
  assert.equal(evaluateBusinessIntent({
    text: "yes",
    businessSessionActiveUntil: past
  }).allowed, false);
});

test("active session still ignores how are you", () => {
  const result = evaluateBusinessIntent({
    text: "How are you?",
    businessSessionActiveUntil: future
  });
  assert.equal(result.allowed, false);
  assert.equal(result.reason, "PERSONAL_MESSAGE");
});

test("photo without context is ignored", () => {
  const result = evaluateBusinessIntent({ messageType: "image" });
  assert.equal(result.allowed, false);
  assert.equal(result.reason, "UNSUPPORTED_MEDIA");
});

test("audio without context is ignored", () => {
  assert.equal(evaluateBusinessIntent({ messageType: "audio" }).allowed, false);
});

test("sticker is ignored", () => {
  assert.equal(evaluateBusinessIntent({ messageType: "sticker" }).allowed, false);
});

test("photo quoting verified business content is allowed", () => {
  const result = evaluateBusinessIntent({
    messageType: "image",
    quotedContext: { verified: true, isBusinessContext: true }
  });
  assert.equal(result.allowed, true);
  assert.equal(result.reason, "BUSINESS_QUOTE_CONTEXT");
});

test("yes quoting verified business pricing is allowed", () => {
  const result = evaluateBusinessIntent({
    text: "yes",
    quotedContext: { verified: true, isBusinessContext: true }
  });
  assert.equal(result.allowed, true);
});

test("media extraction must be very high confidence", () => {
  assert.equal(evaluateBusinessIntent({
    messageType: "audio",
    mediaIntent: { allowed: true, confidence: 0.75 }
  }).allowed, false);

  assert.equal(evaluateBusinessIntent({
    messageType: "audio",
    mediaIntent: { allowed: true, confidence: 0.95 }
  }).allowed, true);
});

test("muted chat is always silent", () => {
  const result = evaluateBusinessIntent({
    text: "I need an appointment",
    isMuted: true
  });
  assert.equal(result.allowed, false);
  assert.equal(result.reason, "MUTED");
});

test("system event is ignored", () => {
  assert.equal(evaluateBusinessIntent({
    text: "appointment",
    isSystemEvent: true
  }).allowed, false);
});

test("personal-looking numbers outside business context are ignored", () => {
  assert.equal(evaluateBusinessIntent({ text: "$50" }).allowed, false);
  assert.equal(evaluateBusinessIntent({ text: "3pm" }).allowed, false);
});

test("active business session accepts an address", () => {
  assert.equal(evaluateBusinessIntent({
    text: "1234 Main Street Denver",
    businessSessionActiveUntil: future
  }).allowed, true);
});

test("tenant-specific business keyword can activate", () => {
  const result = evaluateBusinessIntent({
    text: "Do you do balayage?",
    tenantKeywords: ["balayage"]
  });
  assert.equal(result.allowed, true);
  assert.equal(result.reason, "BUSINESS_KEYWORD");
});

test("unrelated family-style chat remains silent", () => {
  const samples = [
    "Pick up milk on your way home",
    "The kids are already asleep",
    "Send me that meme",
    "Call me when you get home"
  ];

  for (const text of samples) {
    assert.equal(evaluateBusinessIntent({ text }).allowed, false, text);
  }
});
