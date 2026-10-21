// libsignal writes session objects through console, bypassing Pino redaction.
const secret = /^(?:priv(?:ate)?key|private|secret|rootKey|chainKey|messageKeys|ephemeralKeyPair|currentRatchet|signedIdentityKey|noiseKey|signedPreKey|advSecretKey|creds|auth|value|session|_chains|pendingPreKey)$/i;
export function redactLog(value, seen = new WeakSet()) {
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) return "[REDACTED_BYTES]";
  if (typeof value === "string") return value.replace(/<Buffer[^>]*>/g,"[REDACTED_BYTES]").replace(/Bearer\s+\S+/gi,"Bearer [REDACTED]");
  if (!value || typeof value !== "object") return value;
  if (seen.has(value)) return "[CIRCULAR]";
  seen.add(value);
  if (value instanceof Error) return {name:value.name,message:redactLog(value.message),code:value.code};
  if (Array.isArray(value)) return value.map(x=>redactLog(x,seen));
  return Object.fromEntries(Object.entries(value).map(([k,v])=>[k,secret.test(k)?"[REDACTED]":redactLog(v,seen)]));
}
export function installSafeConsole(target = console) {
  for (const level of ["log","info","warn","error","debug","trace","dir"]) {
    const original=target[level]?.bind(target);
    if(original) target[level]=(...args)=>original(...args.map(x=>redactLog(x)));
  }
}
installSafeConsole();
