import test from "node:test";
import assert from "node:assert/strict";
import { detectCustomerLanguage } from "../src/languageDetector.js";

test("detects Spanish business text", () => {
  const result = detectCustomerLanguage({
    text: "Necesito información sobre el precio y una cita para mañana."
  });

  assert.equal(result.language, "es");
  assert.equal(result.source, "detector");
});

test("detects English business text", () => {
  const result = detectCustomerLanguage({
    text: "I need a roof estimate and an appointment for tomorrow."
  });

  assert.equal(result.language, "en");
  assert.equal(result.source, "detector");
});

test("uses a strong Spanish short-message hint", () => {
  const result = detectCustomerLanguage({ text: "Sí" });

  assert.equal(result.language, "es");
  assert.equal(result.source, "detector");
});

test("uses a strong English short-message hint", () => {
  const result = detectCustomerLanguage({ text: "yes" });

  assert.equal(result.language, "en");
  assert.equal(result.source, "detector");
});

test("falls back to active session language for ambiguous short text", () => {
  const result = detectCustomerLanguage({
    text: "ok",
    sessionLanguage: "es"
  });

  assert.equal(result.language, "es");
  assert.equal(result.source, "session");
});

test("uses quoted context when text is absent", () => {
  const result = detectCustomerLanguage({
    text: "",
    quotedLanguage: "en"
  });

  assert.equal(result.language, "en");
  assert.equal(result.source, "quoted_context");
});

test("returns unknown when there is no reliable signal or context", () => {
  const result = detectCustomerLanguage({ text: "" });

  assert.equal(result.language, null);
  assert.equal(result.source, "unknown");
});
