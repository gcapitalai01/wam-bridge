import { detectAll } from "tinyld";

const SHORT_LANGUAGE_HINTS = new Map([
  ["sí", "es"],
  ["si", "es"],
  ["hola", "es"],
  ["gracias", "es"],
  ["mañana", "es"],
  ["precio", "es"],
  ["cita", "es"],
  ["cuánto", "es"],
  ["cuanto", "es"],
  ["quiero", "es"],
  ["necesito", "es"],
  ["yes", "en"],
  ["hello", "en"],
  ["hi", "en"],
  ["thanks", "en"],
  ["tomorrow", "en"],
  ["price", "en"],
  ["appointment", "en"],
  ["quote", "en"],
  ["cost", "en"],
  ["need", "en"],
  ["want", "en"]
]);

function normalizeText(value) {
  return String(value || "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function resolveContextLanguage({
  sessionLanguage,
  quotedLanguage,
  tenantDefaultLanguage
}) {
  if (sessionLanguage) {
    return {
      language: sessionLanguage,
      confidence: 1,
      source: "session"
    };
  }

  if (quotedLanguage) {
    return {
      language: quotedLanguage,
      confidence: 1,
      source: "quoted_context"
    };
  }

  if (tenantDefaultLanguage) {
    return {
      language: tenantDefaultLanguage,
      confidence: 1,
      source: "tenant_default"
    };
  }

  return {
    language: null,
    confidence: 0,
    source: "unknown"
  };
}

function detectShortLanguageHint(text) {
  const tokens = text
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter(Boolean);

  for (const token of tokens) {
    const language = SHORT_LANGUAGE_HINTS.get(token);
    if (language) {
      return {
        language,
        confidence: 0.98,
        source: "detector"
      };
    }
  }

  return null;
}

export function detectCustomerLanguage({
  text,
  sessionLanguage = null,
  quotedLanguage = null,
  tenantDefaultLanguage = null
}) {
  const normalizedText = normalizeText(text);

  if (!normalizedText) {
    return resolveContextLanguage({
      sessionLanguage,
      quotedLanguage,
      tenantDefaultLanguage
    });
  }

  const shortHint = detectShortLanguageHint(normalizedText);
  if (shortHint) return shortHint;

  const candidates = detectAll(normalizedText)
    .filter((candidate) => candidate?.lang && Number.isFinite(candidate?.accuracy))
    .slice(0, 3);

  if (!candidates.length) {
    return resolveContextLanguage({
      sessionLanguage,
      quotedLanguage,
      tenantDefaultLanguage
    });
  }

  const [top, second] = candidates;
  const wordCount = normalizedText.split(/\s+/).filter(Boolean).length;
  const isShort = normalizedText.length < 18 || wordCount < 3;
  const minimumConfidence = isShort ? 0.55 : 0.38;
  const minimumMargin = isShort ? 0.12 : 0.05;
  const secondAccuracy = second?.accuracy ?? 0;
  const margin = top.accuracy - secondAccuracy;

  if (top.accuracy >= minimumConfidence && margin >= minimumMargin) {
    return {
      language: top.lang,
      confidence: Number(top.accuracy.toFixed(4)),
      source: "detector"
    };
  }

  return resolveContextLanguage({
    sessionLanguage,
    quotedLanguage,
    tenantDefaultLanguage
  });
}
