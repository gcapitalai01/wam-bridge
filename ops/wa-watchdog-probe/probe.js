// Independent, read-only synthetic probe; never sends a WhatsApp message.
export function createProbe(env, notify, http = fetch) {
 return async req => {
  const secret=env('WHATSAPP_BRIDGE_SECRET') || '';
  const got=req.headers.get('x-bridge-secret') || '';
  let diff=secret.length ^ got.length;
  for(let i=0;i<secret.length;i++) diff |= secret.charCodeAt(i) ^ (got.charCodeAt(i)||0);
  if(!secret || diff) return Response.json({error:'unauthorized'},{status:401});
  if(req.method!=='POST') return Response.json({error:'method'},{status:405});
  const base='https://gcapitalai-whatsapp-bridge.onrender.com';
  const businessId='f6f4f162-5e25-475c-9f4e-978b1d618eb2';
  let code=null, snapshot=null;
  try {
   const headers={'x-bridge-secret':secret};
   const [health,status]=await Promise.all(['/ops/watchdog',`/session/${businessId}/status`].map(async p=>{
    const r=await http(base+p,{headers,signal:AbortSignal.timeout(10000)});
    if(!r.ok) throw Error(r.status===401?'probe_auth_failed':'bridge_unreachable');
    return r.json();
   }));
   snapshot={ticks:health.ticks,latencyMs:health.latencyMs,counters:health.counters,alertFailures:health.alertFailures,status:status.status};
   if(!Number.isFinite(health.lastTick) || Date.now()-health.lastTick>10000) code='watchdog_stalled';
   else if(status.status!=='connected') code='owner_session_offline';
  } catch(e) {code=e.message==='probe_auth_failed'?'probe_auth_failed':'bridge_unreachable';}
  if(code) {
   const r=await notify(new Request('https://internal/alert',{method:'POST',headers:{'x-bridge-secret':secret},body:JSON.stringify({code,businessId})}));
   return Response.json({ok:false,code,alertAccepted:r.ok},{status:503});
  }
  try {
   const key=env('SUPABASE_SERVICE_ROLE_KEY');
   const r=await http(`${env('SUPABASE_URL')}/rest/v1/admin_error_log`,{method:'POST',headers:{apikey:key,Authorization:`Bearer ${key}`,'Content-Type':'application/json'},body:JSON.stringify({business_id:businessId,source:'wa-watchdog-probe',message:'healthy',context:JSON.stringify(snapshot)}),signal:AbortSignal.timeout(10000)});
   if(!r.ok) return Response.json({ok:false,code:'probe_log_failed'},{status:503});
  } catch {return Response.json({ok:false,code:'probe_log_failed'},{status:503});}
  return Response.json({ok:true,status:'connected',ticks:snapshot.ticks});
 };
}
