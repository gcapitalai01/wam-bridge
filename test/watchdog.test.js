import test from 'node:test';
import assert from 'node:assert/strict';
import { createWatchdog } from '../src/watchdog.js';
import { createAlertHandler } from '../ops/wa-watchdog-alert/handler.js';
test('recovery circuit allows six attempts then cools down without deleting sessions', () => {
 let t=1000; const w=createWatchdog({now:()=>t});
 for(let i=0;i<6;i++) assert.equal(w.recoveryDelay('a'),0);
 assert.equal(w.recoveryDelay('a'),900000); assert.equal(w.recoveryDelay('b'),0);
 t+=900001; assert.equal(w.recoveryDelay('a'),0);
});
test('server acknowledgement is not delivery; delivery receipt measures latency',()=>{
 let t=1000; const w=createWatchdog({now:()=>t});w.sent('a','m');t+=250;
 w.receipt('a','m',2);assert.equal(w.snapshot().pendingDeliveries,1);
 w.receipt('a','m',3);assert.equal(w.snapshot().pendingDeliveries,0);assert.equal(w.snapshot().latencyMs.delivery.p95,250);
});
test('missing receipts alert once and never resend; alerts contain no customer data',async()=>{
 let t=1000;const events=[];const w=createWatchdog({now:()=>t,alert:async e=>events.push(e)});
 w.sent('a','private-message-id');t+=121000;w.tick();w.tick();await Promise.resolve();
 assert.equal(w.snapshot().counters.delivery_unconfirmed,1);assert.ok(!JSON.stringify(events).includes('private-message-id'));
});
test('alert failures cannot break watchdog',async()=>{
 const w=createWatchdog({alert:async()=>{throw new Error('fail')}});w.incident('test_event');await new Promise(r=>setImmediate(r));assert.equal(w.snapshot().alertFailures,1);w.tick();assert.equal(w.snapshot().ticks,1);
});
test('alert endpoint rejects unauthorized calls before any provider request',async()=>{
 const handler=createAlertHandler(()=> 'secret',()=>{throw Error('must not call')});
 assert.equal((await handler(new Request('https://test',{method:'POST',body:'{}'}))).status,401);
});
test('alert endpoint uses fixed owner and excludes arbitrary payload and secrets',async()=>{
 const calls=[];const handler=createAlertHandler(k=>({WHATSAPP_BRIDGE_SECRET:'private',SUPABASE_URL:'https://db',SUPABASE_SERVICE_ROLE_KEY:'dbkey',SENDER_API_TOKEN:'mailkey'}[k]),async(url,options)=>{calls.push({url,options});return new Response(options.method==='POST'?'{}':'[]')});
 const r=await handler(new Request('https://test',{method:'POST',headers:{'x-bridge-secret':'private'},body:JSON.stringify({code:'watchdog_started',to:'attacker@example.com',message:'CUSTOMER_SECRET'})}));
 assert.equal(r.status,200);const mail=JSON.parse(calls.find(c=>c.url.includes('sender.net')).options.body);assert.equal(mail.to.email,'alexusa0110@gmail.com');assert.ok(!JSON.stringify(mail).includes('CUSTOMER_SECRET'));
});
