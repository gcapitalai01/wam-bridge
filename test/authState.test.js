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

      if (fn === "wa_auth_write_if_owner") {
        const marker = args.p_value?.marker;
        const delay = writeDelayForMarker[marker] || 0;
        if (delay) await sleep(delay);
        const key = `${args.p_business}|${args.p_data_key}`;
        if (args.p_delete) rows.delete(key);
        else rows.set(key, { value: args.p_value });
        return { data: true, error: null };
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
