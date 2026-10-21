import test from "node:test";
import assert from "node:assert/strict";
import { useSupabaseAuthState } from "../src/authState.js";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function fakeSupabase({ writeDelayForMarker = {} } = {}) {
  const rows = new Map();
  const owners = new Map();

  return {
    rows,
    setOwner(businessId, owner) {
      owners.set(businessId, owner);
    },
    from(table) {
      assert.equal(table, "wam_auth_state");
      return {
        select() {
          const filters = {};
          return {
            eq(col, value) { filters[col] = value; return this; },
            async maybeSingle() {
              const row = rows.get(`${filters.business_id}|${filters.data_key}`);
              return { data: row ? { value: row.value } : null, error: null };
            },
          };
        },
      };
    },
    async rpc(fn, args) {
      const currentOwner = owners.get(args.p_business);
      if (currentOwner !== args.p_owner_instance) return { data: false, error: null };

      if (fn === "wa_auth_write_batch_if_owner") {
        const entries=args.p_entries;
        const delay=writeDelayForMarker[entries[0]?.value?.marker] || 0;
        if(delay) await sleep(delay);
        if(owners.get(args.p_business)!==args.p_owner_instance) return {data:false,error:null};
        for(const e of entries){
          const key=`${args.p_business}|${e.key}`;
          if(e.delete) rows.delete(key);else rows.set(key,{value:e.value});
        }
        return {data:true,error:null};
      }

      if (fn === "wa_auth_clear_if_owner") {
        for (const key of [...rows.keys()]) {
          if (key.startsWith(`${args.p_business}|`)) rows.delete(key);
        }
        return { data: true, error: null };
      }

      return { data: null, error: { message: `unexpected rpc ${fn}` } };
    },
  };
}

test("Supabase auth store persists and reloads Signal keys under active owner", async () => {
  const db = fakeSupabase();
  db.setOwner("business-1", "instance-a:session-1");

  const first = await useSupabaseAuthState(db, "business-1", "instance-a:session-1");
  await first.state.keys.set({
    session: { alice: { marker: 7 } },
    "app-state-sync-version": { main: { version: 3 } },
  });
  await first.saveCreds();

  const second = await useSupabaseAuthState(db, "business-1", "instance-a:session-1");
  const got = await second.state.keys.get("session", ["alice"]);

  assert.equal(got.alice.marker, 7);
  assert.ok(db.rows.has("business-1|creds"));
});

test("Signal key writes are serialized so stale slow writes cannot win", async () => {
  const db = fakeSupabase({ writeDelayForMarker: { 1: 30, 2: 0 } });
  db.setOwner("business-1", "instance-a:session-1");
  const store = await useSupabaseAuthState(db, "business-1", "instance-a:session-1");

  const slow = store.state.keys.set({ session: { alice: { marker: 1 } } });
  await sleep(5);
  const fast = store.state.keys.set({ session: { alice: { marker: 2 } } });

  await Promise.all([slow, fast]);
  const got = await store.state.keys.get("session", ["alice"]);

  assert.equal(got.alice.marker, 2);
});

test("stale session generation cannot overwrite a replacement socket", async () => {
  const db = fakeSupabase();
  db.setOwner("business-1", "instance-a:session-old");

  const oldStore = await useSupabaseAuthState(db, "business-1", "instance-a:session-old");
  await oldStore.state.keys.set({ session: { alice: { marker: 1 } } });

  db.setOwner("business-1", "instance-a:session-new");
  const newStore = await useSupabaseAuthState(db, "business-1", "instance-a:session-new");
  await newStore.state.keys.set({ session: { alice: { marker: 2 } } });

  await assert.rejects(
    oldStore.state.keys.set({ session: { alice: { marker: 3 } } }),
    (err) => err?.code === "AUTH_WRITE_LEASE_LOST"
  );

  const got = await newStore.state.keys.get("session", ["alice"]);
  assert.equal(got.alice.marker, 2);
});

test("clearAll is fenced and cannot erase auth owned by a newer session", async () => {
  const db = fakeSupabase();
  db.setOwner("business-1", "instance-a:session-old");
  const oldStore = await useSupabaseAuthState(db, "business-1", "instance-a:session-old");
  await oldStore.state.keys.set({ session: { alice: { marker: 1 } } });

  db.setOwner("business-1", "instance-a:session-new");
  const newStore = await useSupabaseAuthState(db, "business-1", "instance-a:session-new");
  await newStore.state.keys.set({ session: { bob: { marker: 2 } } });

  await assert.rejects(
    oldStore.clearAll(),
    (err) => err?.code === "AUTH_WRITE_LEASE_LOST"
  );

  assert.equal(db.rows.has("business-1|session-bob"), true);
});

 test("queued key snapshots cannot be changed by later caller mutation",async()=>{
 const db=fakeSupabase({writeDelayForMarker:{1:25}});db.setOwner("b","o");
 const a=await useSupabaseAuthState(db,"b","o");
 const slow=a.state.keys.set({session:{one:{marker:1}}});
 const input={session:{two:{marker:2}}};const queued=a.state.keys.set(input);input.session.two.marker=99;
 await Promise.all([slow,queued]);assert.equal(db.rows.get("b|session-two").value.marker,2);
 });
 test("flush waits for durable pending key writes",async()=>{
 const db=fakeSupabase({writeDelayForMarker:{1:25}});db.setOwner("b","o");const a=await useSupabaseAuthState(db,"b","o");
 const write=a.state.keys.set({session:{one:{marker:1}}});await a.flush();assert.equal(db.rows.get("b|session-one").value.marker,1);await write;
 });


test("v7 auth categories persist across reloads and remain tenant isolated", async () => {
 const db=fakeSupabase(); db.setOwner("b1","o1"); db.setOwner("b2","o2");
 const a=await useSupabaseAuthState(db,"b1","o1");
 const values={"lid-mapping":{"123":"456","456_reverse":"123"},"device-list":{"123":[0,99]},"tctoken":{"123":{token:Buffer.from([1,2,3])}},"app-state-sync-key":{"key1":{keyData:Buffer.from([4,5,6])}}};
 await a.state.keys.set(values);
 const reload=await useSupabaseAuthState(db,"b1","o1");
 for(const [category,entries] of Object.entries(values)) {
 const got=await reload.state.keys.get(category,Object.keys(entries));
 for(const id of Object.keys(entries)) assert.ok(got[id]);
 }
 assert.deepEqual((await reload.state.keys.get("tctoken",["123"]))["123"].token,Buffer.from([1,2,3]));
 const b=await useSupabaseAuthState(db,"b2","o2");
 assert.deepEqual(await b.state.keys.get("lid-mapping",["123"]),{});
});

test("real Signal roundtrip survives PN to LID migration and durable store reload", async () => {
 const {makeLibSignalRepository}=await import('../node_modules/@whiskeysockets/baileys/lib/Signal/libsignal.js');
 const {addTransactionCapability,Curve,generateSignalPubKey}=await import('@whiskeysockets/baileys');
 const log={trace(){},debug(){},info(){},warn(){},error(){}};
 const db=fakeSupabase();db.setOwner('alice','a');db.setOwner('bob','b');
 const a=await useSupabaseAuthState(db,'alice','a'),b=await useSupabaseAuthState(db,'bob','b');
 await a.saveCreds();await b.saveCreds();
 const create=store=>makeLibSignalRepository({creds:store.state.creds,keys:addTransactionCapability(store.state.keys,log,{maxCommitRetries:1,delayBetweenTriesMs:0})},log);
 let ar=create(a),br=create(b);
 const pre=Curve.generateKeyPair();await b.state.keys.set({'pre-key':{'1':pre}});
 await ar.injectE2ESession({jid:'222@s.whatsapp.net',session:{registrationId:b.state.creds.registrationId,identityKey:generateSignalPubKey(b.state.creds.signedIdentityKey.public),signedPreKey:{keyId:b.state.creds.signedPreKey.keyId,publicKey:generateSignalPubKey(b.state.creds.signedPreKey.keyPair.public),signature:b.state.creds.signedPreKey.signature},preKey:{keyId:1,publicKey:generateSignalPubKey(pre.public)}}});
 const first=await ar.encryptMessage({jid:'222@s.whatsapp.net',data:Buffer.from('first')});
 assert.equal((await br.decryptMessage({jid:'111@s.whatsapp.net',...first})).toString(),'first');
 const existing=(await a.state.keys.get('session',['222.0']))['222.0'];
 await a.state.keys.set({'session':{'222.99':existing,'222_128.99':existing},'device-list':{'222':['0','99']}});await b.state.keys.set({'device-list':{'111':['0']}});
 await ar.lidMapping.storeLIDPNMappings([{pn:'222@s.whatsapp.net',lid:'888@lid'}]);
 await br.lidMapping.storeLIDPNMappings([{pn:'111@s.whatsapp.net',lid:'999@lid'}]);
 await ar.migrateSession('222@s.whatsapp.net','888@lid');
 assert.ok((await a.state.keys.get('session',['888_129.99']))['888_129.99']);
 assert.ok((await a.state.keys.get('session',['222.99']))['222.99']);await br.migrateSession('111@s.whatsapp.net','999@lid');
 ar=create(await useSupabaseAuthState(db,'alice','a'));br=create(await useSupabaseAuthState(db,'bob','b'));
 for(let i=0;i<5;i++){
 const out=await ar.encryptMessage({jid:'888@lid',data:Buffer.from('out'+i)});
 assert.equal((await br.decryptMessage({jid:'999@lid',...out})).toString(),'out'+i);
 const reply=await br.encryptMessage({jid:'999@lid',data:Buffer.from('reply'+i)});
 assert.equal((await ar.decryptMessage({jid:'888@lid',...reply})).toString(),'reply'+i);
 }
});
