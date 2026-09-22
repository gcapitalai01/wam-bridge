const STRONG_BUSINESS_TERMS = [
  "price", "pricing", "cost", "quote", "estimate", "appointment", "schedule",
  "booking", "book", "availability", "available", "service", "services",
  "hours", "location", "address", "consultation", "repair", "installation",
  "order", "buy", "purchase", "payment", "reservation", "menu",
  "precio", "precios", "cuesta", "cotización", "cotizacion", "estimado",
  "cita", "agendar", "agenda", "reservar", "reserva", "disponibilidad",
  "disponible", "servicio", "servicios", "horario", "ubicación", "ubicacion",
  "dirección", "direccion", "consulta", "reparación", "reparacion",
  "instalación", "instalacion", "orden", "comprar", "compra", "pago", "menú", "menu",
  "preço", "preco", "orçamento", "orcamento", "agendamento", "marcar",
  "disponibilidade", "serviço", "servico", "horário", "horario", "endereço", "endereco",
  "consulta", "reparo", "instalação", "instalacao", "comprar", "pagamento",
  "prix", "devis", "rendez-vous", "disponibilité", "disponibilite",
  "service", "horaires", "adresse", "consultation", "réparation", "reparation",
  "installation", "acheter", "paiement"
];

const PERSONAL_PATTERNS = [
  /^(hey|hi|hello|hola|buenas|qué tal|que tal|sup|yo)[!.?\s]*$/iu,
  /^(how are you|how r u|what'?s up|whats up|cómo estás|como estas|cómo vas|como vas)[!.?\s]*$/iu,
  /^(good morning|good afternoon|good night|buenos días|buenos dias|buenas tardes|buenas noches)[!.?\s]*$/iu,
  /^(love you|i love you|te amo|te quiero)[!.?\s]*$/iu,
  /^(lol|lmao|haha|jaja|jajaja|😂+|🤣+)[!.?\s]*$/iu
];

const CONTINUATION_PATTERNS = [
  /^(yes|yeah|yep|no|nope|sí|si|ok|okay|dale|perfecto|perfect|sure|claro|correcto)$/iu,
  /^(today|tomorrow|tonight|hoy|mañana|manana|esta tarde|esta noche)$/iu,
  /^\d{1,2}(:\d{2})?\s*(am|pm)?$/iu,
  /^(at\s+)?\d{1,2}(:\d{2})?\s*(am|pm)$/iu,
  /^(a las\s+)?\d{1,2}(:\d{2})?\s*(am|pm)?$/iu,
  /^(that one|this one|the first one|the second one|ese|esa|este|esta|el primero|la primera)$/iu,
  /^(send it|send me that|mándalo|mandalo|envíalo|envialo)$/iu,
  /^(cash|card|credit card|debit card|efectivo|tarjeta)$/iu
];

const DIRECT_BUSINESS_PATTERNS = [
  /\bhow much (is|are|does|do|for)\b/iu,
  /\bwhat('?s| is) the (price|cost)\b/iu,
  /\bcan i (book|schedule|come in|make an appointment)\b/iu,
  /\bi (need|want|would like) (a |an |to )?(quote|estimate|appointment|service|repair|installation|consultation)\b/iu,
  /\bdo you (have|offer|provide)\b/iu,
  /\bare you available\b/iu,
  /\bwhat time do you (open|close)\b/iu,
  /\bwhere are you located\b/iu,
  /\bgive me an? (estimate|quote)\b/iu,
  /\bcu[aá]nto (cuesta|sale|vale)\b/iu,
  /\bcu[aá]l es el precio\b/iu,
  /\bquiero (agendar|reservar|hacer una cita|comprar|cotizar)\b/iu,
  /\bnecesito (una |un )?(cita|cotizaci[oó]n|estimado|servicio|reparaci[oó]n|instalaci[oó]n|consulta)\b/iu,
  /\btienen (disponibilidad|citas|servicio)\b/iu,
  /\best[aá]n disponibles\b/iu,
  /\ba qu[eé] hora (abren|cierran)\b/iu,
  /\bd[oó]nde est[aá]n ubicados\b/iu,
  /\bdame (una |un )?(cotizaci[oó]n|estimado|precio)\b/iu
];

const TIME_OR_DATE_PATTERN = /\b(mon|tue|wed|thu|fri|sat|sun|monday|tuesday|wednesday|thursday|friday|saturday|sunday|lunes|martes|miércoles|miercoles|jueves|viernes|sábado|sabado|domingo|today|tomorrow|hoy|mañana|manana)\b|\b\d{1,2}([:\/]\d{1,2})?\s*(am|pm)?\b/iu;
const MONEY_PATTERN = /(?:\$|usd|dollars?|dólares?|dolares?)\s*\d+|\d+\s*(?:usd|dollars?|dólares?|dolares?)/iu;

function normalize(value) {
  return String(value || "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function containsTerm(text, term) {
  const escaped = term.replace(/[.*+?^$()|[\]\\{}]/g, "\\$&");
  return new RegExp("(^|[^\\p{L}\\p{N}])" + escaped + "([^\\p{L}\\p{N}]|$)", "iu").test(text);
}

function matchesAny(text, patterns) {
  return patterns.some((pattern) => pattern.test(text));
}

function hasStrongBusinessTerm(text, extraTerms = []) {
  const terms = [...STRONG_BUSINESS_TERMS, ...extraTerms]
    .map(normalize)
    .filter(Boolean);

  return terms.some((term) => containsTerm(text, term));
}

function isContextualContinuation(text) {
  if (!text) return false;
  if (matchesAny(text, CONTINUATION_PATTERNS)) return true;
  if (TIME_OR_DATE_PATTERN.test(text)) return true;
  if (MONEY_PATTERN.test(text)) return true;
  if (/^\d{1,6}\s+.{3,}$/u.test(text)) return true;
  if (/^[+]?\d[\d\s().-]{6,}$/u.test(text)) return true;
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(text)) return true;
  return false;
}

export function evaluateBusinessIntent({
  text = "",
  messageType = "text",
  isSystemEvent = false,
  isMuted = false,
  businessSessionActiveUntil = null,
  now = new Date(),
  quotedContext = null,
  tenantKeywords = [],
  industryKeywords = [],
  mediaIntent = null
} = {}) {
  if (isSystemEvent) {
    return { allowed: false, reason: "SYSTEM_EVENT", confidence: 1, activateSession: false };
  }

  if (isMuted) {
    return { allowed: false, reason: "MUTED", confidence: 1, activateSession: false };
  }

  const normalizedText = normalize(text);
  const sessionActive = businessSessionActiveUntil
    ? new Date(businessSessionActiveUntil).getTime() > new Date(now).getTime()
    : false;

  const quotedBusinessContext = Boolean(
    quotedContext?.verified && quotedContext?.isBusinessContext
  );

  const isMedia = ["image", "audio", "video", "sticker", "document"].includes(messageType);

  if (isMedia) {
    if (quotedBusinessContext) {
      return {
        allowed: true,
        reason: "BUSINESS_QUOTE_CONTEXT",
        confidence: 0.99,
        activateSession: true
      };
    }

    if (mediaIntent?.allowed === true && Number(mediaIntent?.confidence) >= 0.9) {
      return {
        allowed: true,
        reason: "MEDIA_BUSINESS_INTENT",
        confidence: Number(mediaIntent.confidence),
        activateSession: true
      };
    }

    return {
      allowed: false,
      reason: "UNSUPPORTED_MEDIA",
      confidence: 1,
      activateSession: false
    };
  }

  if (!normalizedText) {
    return { allowed: false, reason: "EMPTY_MESSAGE", confidence: 1, activateSession: false };
  }

  if (quotedBusinessContext) {
    return {
      allowed: true,
      reason: "BUSINESS_QUOTE_CONTEXT",
      confidence: 0.99,
      activateSession: true
    };
  }

  if (matchesAny(normalizedText, DIRECT_BUSINESS_PATTERNS)) {
    return {
      allowed: true,
      reason: "DIRECT_BUSINESS_PATTERN",
      confidence: 0.98,
      activateSession: true
    };
  }

  const extraTerms = [...tenantKeywords, ...industryKeywords];
  if (hasStrongBusinessTerm(normalizedText, extraTerms)) {
    return {
      allowed: true,
      reason: "BUSINESS_KEYWORD",
      confidence: 0.94,
      activateSession: true
    };
  }

  if (matchesAny(normalizedText, PERSONAL_PATTERNS)) {
    return {
      allowed: false,
      reason: "PERSONAL_MESSAGE",
      confidence: 0.98,
      activateSession: false
    };
  }

  if (sessionActive && isContextualContinuation(normalizedText)) {
    return {
      allowed: true,
      reason: "ACTIVE_BUSINESS_SESSION",
      confidence: 0.92,
      activateSession: true
    };
  }

  return {
    allowed: false,
    reason: "NO_BUSINESS_SIGNAL",
    confidence: 0.9,
    activateSession: false
  };
}
