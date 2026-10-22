// Local-only 1s inspection. No customer payloads, network polling or key deletion.
export function createWatchdog({ now = Date.now, alert = async () => {}, maxAttempts = 6, windowMs = 300000, cooldownMs = 900000 } = {}) {
  const budgets = new Map(), incidents = new Map(), pending = new Map();
  const counters = {}; const latencies = {};
  const alertQueue = new Map();
  let lastTick = now(), ticks = 0, alertFailures = 0;
  function count(code) { counters[code] = (counters[code] || 0) + 1; }
  function observe(stage, ms) {
    const a = latencies[stage] ||= []; a.push(Math.max(0, ms)); if (a.length > 200) a.shift();
  }
  function incident(code, businessId = null) {
    count(code); const key = `${businessId}:${code}`; const t = now();
    if (incidents.has(key) && t - incidents.get(key) < cooldownMs) return;
    incidents.set(key, t);
    if (incidents.size > 1000) incidents.delete(incidents.keys().next().value);
    const job = { event: { code, businessId, at: new Date(t).toISOString() }, attempts: 0, nextAt: t, busy: false };
    if (alertQueue.size >= 100) { alertFailures++; return; }
    alertQueue.set(key, job); dispatch(key, job);
  }
  function dispatch(key, job) {
    if (job.busy) return;
    job.busy = true; job.attempts++;
    Promise.resolve().then(() => alert(job.event)).then(() => alertQueue.delete(key)).catch(() => {
      alertFailures++;
      if (job.attempts >= 3) alertQueue.delete(key);
      else job.nextAt = now() + 30000 * job.attempts;
    }).finally(() => { job.busy = false; });
  }
  function recoveryDelay(businessId) {
    const t = now(); const b = budgets.get(businessId) || { attempts: [], until: 0 };
    budgets.set(businessId, b);
    if (b.until > t) return b.until - t;
    b.attempts = b.attempts.filter(x => t - x < windowMs);
    if (b.attempts.length >= maxAttempts) {
      b.until = t + cooldownMs; incident('recovery_circuit_open', businessId); return cooldownMs;
    }
    b.attempts.push(t); return 0;
  }
  function deferOwnership(businessId) {
    const b = budgets.get(businessId);
    if (b) b.attempts.pop();
  }
  function sent(businessId, id) {
    if (!id) return;
    pending.set(`${businessId}:${id}`, { businessId, at: now() });
    if (pending.size > 10000) { pending.delete(pending.keys().next().value); incident('delivery_tracking_capacity'); }
  }
  function receipt(businessId, id, status) {
    const key = `${businessId}:${id}`, p = pending.get(key);
    if (!p) return;
    if (status >= 3) { observe('delivery', now() - p.at); pending.delete(key); count('delivered'); }
    else if (status === 0) { pending.delete(key); incident('delivery_failed', businessId); }
  }
  function tick() {
    const t = now(); if (t - lastTick > 5000) incident('event_loop_delayed'); lastTick = t; ticks++;
    for (const [key, job] of alertQueue) if (!job.busy && t >= job.nextAt) dispatch(key, job);
    for (const [key, p] of pending) if (t - p.at > 120000) {
      // An offline recipient is not evidence of a broken socket. Never resend blindly.
      pending.delete(key); incident('delivery_unconfirmed', p.businessId);
    }
  }
  function snapshot() {
    return { intervalMs: 1000, ticks, lastTick, alertFailures, queuedAlerts: alertQueue.size, pendingDeliveries: pending.size, counters: { ...counters }, latencyMs: Object.fromEntries(Object.entries(latencies).map(([k,a]) => { const s=[...a].sort((x,y)=>x-y); return [k,{count:s.length,p95:s[Math.ceil(s.length*.95)-1],max:s.at(-1)}]; })) };
  }
  return { count, observe, incident, recoveryDelay, deferOwnership, sent, receipt, tick, snapshot };
}
