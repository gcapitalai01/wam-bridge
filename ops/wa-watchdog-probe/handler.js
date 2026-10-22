export function createAlertHandler(env, http = fetch) {
  const json = (b, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });
  return async req => {
    if (req.method !== 'POST') return json({ error: 'method' }, 405);
    const expected = env('WHATSAPP_BRIDGE_SECRET') || '';
    const got = req.headers.get('x-bridge-secret') || '';
    let different = expected.length ^ got.length;
    for (let i = 0; i < expected.length; i++) different |= expected.charCodeAt(i) ^ (got.charCodeAt(i) || 0);
    if (!expected || different) return json({ error: 'unauthorized' }, 401);
    const body = await req.json().catch(() => null);
    const code = body?.code;
    if (typeof code !== 'string' || !/^[a-z][a-z0-9_]{2,60}$/.test(code)) return json({ error: 'invalid_event' }, 400);
    const bid = /^[0-9a-f-]{36}$/i.test(body?.businessId || '') ? body.businessId : null;
    const base = env('SUPABASE_URL'), key = env('SUPABASE_SERVICE_ROLE_KEY');
    const headers = { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' };
    async function db(path, options = {}) {
      const r = await http(`${base}/rest/v1/admin_error_log${path}`, { ...options, headers, signal: AbortSignal.timeout(10000) });
      if (!r.ok) throw new Error('log_unavailable');
      return r;
    }
    try {
      const since = new Date(Date.now() - 900000).toISOString();
      const previous = await (await db(`?select=id&source=eq.wa-watchdog-mail&message=eq.${code}&created_at=gte.${since}&limit=1`)).json();
      if (previous.length) return json({ ok: true, deduplicated: true });
      await db('', { method: 'POST', body: JSON.stringify({ source: 'wa-watchdog', business_id: bid, message: code, context: 'Operational event; no customer content or credentials.' }) });
      const hourly = await (await db(`?select=id&source=eq.wa-watchdog-mail&created_at=gte.${new Date(Date.now()-3600000).toISOString()}&limit=10`)).json();
      if (hourly.length >= 10) return json({ ok: true, rateLimited: true });
      const token = env('SENDER_API_TOKEN');
      if (!token) throw new Error('mail_unavailable');
      const text = `G CAPITAL AI — vigilancia WhatsApp\nEvento: ${code}\nHora UTC: ${new Date().toISOString()}\n${bid ? `Negocio: ${bid}\n` : ''}Las credenciales y sesiones se conservan. Una entrega no confirmada no implica que el destinatario esté conectado. Revisa /ops/watchdog y los registros de Render para el detalle técnico.`;
      const mail = await http('https://api.sender.net/v2/message/send', {
        method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ from: { email: 'info@gcapitalai.com', name: 'G CAPITAL AI Monitor' }, to: { email: 'alexusa0110@gmail.com', name: 'Alex' }, subject: `[WhatsApp Monitor] ${code}`, text, html: `<pre>${text}</pre>` }),
        signal: AbortSignal.timeout(10000),
      });
      if (!mail.ok) throw new Error('mail_rejected');
      await db('', { method: 'POST', body: JSON.stringify({ source: 'wa-watchdog-mail', business_id: bid, message: code, context: 'Sender accepted notification.' }) });
      return json({ ok: true, emailAccepted: true });
    } catch { return json({ error: 'alert_delivery_failed' }, 503); }
  };
}
