import test from "node:test";
import assert from "node:assert/strict";
import { useSupabaseAuthState } from "../src/authState.js";

function fakeSupabase() {
  const rows = new Map();

  return {
    rows,
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
        async upsert(row) {
          rows.set(`${row.business_id}|${row.data_key}`, row);
          return { error: null };
        },
        delete() {
          const filters = {};
          return {
            eq(col, value) {
              filters[col] = value;
              // Final eq in removeData executes through await on this thenable.
              return this;
            },
            then(resolve) {
              if (filters.data_key) {
                rows.delete(`${filters.business_id}|${filters.data_key}`);
              } else {
                for (const key of [...rows.keys()]) {
                  if (key.startsWith(`${filters.business_id}|`)) rows.delete(key);
                }
              }
              return Promise.resolve({ error: null }).then(resolve);
            },
          };
        },
      };
    },
  };
}

test("Supabase auth store persists and reloads Signal keys", async () => {
  const db = fakeSupabase();
  const first = await useSupabaseAuthState(db, "business-1");

  await first.state.keys.set({
    session: { alice: { marker: 7 } },
    "app-state-sync-version": { main: { version: 3 } },
  });
  await first.saveCreds();

  const second = await useSupabaseAuthState(db, "business-1");
  const got = await second.state.keys.get("session", ["alice"]);

  assert.equal(got.alice.marker, 7);
  assert.ok(db.rows.has("business-1|creds"));
});

test("clearAll removes only this business auth state", async () => {
  const db = fakeSupabase();
  const one = await useSupabaseAuthState(db, "business-1");
  const two = await useSupabaseAuthState(db, "business-2");

  await one.state.keys.set({ session: { a: { x: 1 } } });
  await two.state.keys.set({ session: { b: { x: 2 } } });
  await one.clearAll();

  assert.equal([...db.rows.keys()].some((k) => k.startsWith("business-1|")), false);
  assert.equal([...db.rows.keys()].some((k) => k.startsWith("business-2|")), true);
});
