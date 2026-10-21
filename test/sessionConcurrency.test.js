import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {randomUUID} from 'node:crypto';
import {redactLog,installSafeConsole} from '../src/safeLogging.js';
function setup(){
 let time=1000,sockets=0,acquires=0,release=0,flush=0;
 const intervals=[];const events={};
 class Clock extends Date {static now(){return time}}
 const context=vm.createContext({Date:Clock,randomUUID,console,Map,Set,Promise,Math,Error,Number,
 setInterval(fn){const t={fn,unref(){}};intervals.push(t);return t},clearInterval(t){if(t)t.off=true},setTimeout(){return {unref(){}}},clearTimeout(){},
 fetchLatestBaileysVersion:async()=>({version:[2,3,4]}),Browsers:{ubuntu:()=>[]},QRCode:{},DisconnectReason:{loggedOut:401},jidNormalizedUser:x=>x,getSentMessage:()=>null,
 useSupabaseAuthState:async()=>({state:{creds:{registered:true},keys:{}},saveCreds:async()=>{},flush:async()=>{flush++}}),
 makeWASocket:()=>{sockets++;return {ev:{on:(name,fn)=>events[name]=fn},end(){}}}
 });
 const source=fs.readFileSync(new URL('../src/sessionManager.js',import.meta.url),'utf8').replace(/^import[\s\S]*?;\s*$/mg,'').replace('export function','function');
 vm.runInContext(source,context);
 const manager=context.createSessionManager({supabase:{},logger:{info(){},warn(){},error(){},debug(){}},instanceId:'instance',acquireLease:async()=>{acquires++;await Promise.resolve();return true},renewLease:()=>new Promise(()=>{}),releaseLease:async()=>{assert.ok(flush>0);release++}});
 return {manager,events,intervals,advance:(n)=>time+=n,stats:()=>({sockets,acquires,release,flush})};
}
test('concurrent starts share exactly one socket and lease',async()=>{
 const h=setup();await Promise.all(Array.from({length:20},()=>h.manager.startSession('b')));
 assert.equal(h.stats().sockets,1);assert.equal(h.stats().acquires,1);await h.manager.shutdownAll();assert.equal(h.stats().release,1);
 await assert.rejects(h.manager.startSession('b'),/SHUTTING_DOWN/);
});
test('hung lease renewal cannot keep socket alive beyond local deadline',async()=>{
 const h=setup();await h.manager.startSession('b');h.intervals[0].fn();h.advance(37000);h.intervals[1].fn();assert.equal(h.manager.sessions.size,0);
 await h.manager.shutdownAll();
});
test('remote logout preserves auth; close drains before releasing lease',async()=>{
 const h=setup();await h.manager.startSession('b');await h.events['connection.update']({connection:'close',lastDisconnect:{error:{output:{statusCode:401}}}});
 assert.equal(h.stats().flush,1);assert.equal(h.stats().release,1);assert.equal(h.manager.sessions.size,0);
});
test('nested Signal objects and console dumps cannot expose private bytes',()=>{
 const raw={session:{rootKey:Buffer.from('SECRET')},nested:{privKey:'PRIVATE',bytes:Buffer.from('SECRET')},normal:'ok'};
 const output=JSON.stringify(redactLog(raw));assert.ok(!output.includes('SECRET'));assert.ok(!output.includes('PRIVATE'));assert.ok(output.includes('ok'));
 const calls=[];const sink={info(...args){calls.push(args)}};installSafeConsole(sink);sink.info('Closing session:',raw);assert.ok(!JSON.stringify(calls).includes('PRIVATE'));
});
