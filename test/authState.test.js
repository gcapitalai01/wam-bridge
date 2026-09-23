import test from "node:test";
import assert from "node:assert/strict";
import { useSupabaseAuthState } from "../src/authState.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
            eq(col, value) {
              filters[col] = value;
              return this;
            },
            async maybeSingle() {
              const key = `${filters.business_id}|${filters.data_key}`;
              const row = rows.get(key);
              return { data: row ? { value: row.value } : null, error: null };
            },
          };
        },

        async upsert(input) {
          const list = Array.isArray(input) ? input : [input];
          const marker = list[0]?.value?.marker;
          if (marker === 1) await sleep(50);
          if (marker === 2) await sleep(1);

          for (const row of list) {
            rows.set(`${row.business_id}|${row.data_key}`, row);
          }
          return { error: null };
        },

        delete() {
          const filters = {};
          return {
            eq(col, value) {
              filters[col] = value;
              return this;
            },
            async in(col, values) {
              for (const value of values) {
                rows.delete(`${filters.business_id}|${value}`);
              }
              return { error: null };
            },
            then(resolve) {
              for (const key of [...rows.keys()]) {
                if (key.startsWith(`${filters.business_id}|`)) rows.delete(key);
              }
              return Promise.resolve({ error: null }).then(resolve);
            },
          };
        },
      };
    },
  };
}

test("Signal key writes are serialized so stale slow writes cannot win", async () => {
  const db = fakeSupabase();
  const { state } = await useSupabaseAuthState(db, "business-1");

  const first = state.keys.set({ session: { alice: { marker: 1 } } });
  const second = state.keys.set({ session: { alice: { marker: 2 } } });
  await Promise.all([first, second]);

  const stored = db.rows.get("business-1|session-alice");
  assert.equal(stored.value.marker, 2);

  const got = await state.keys.get("session", ["alice"]);
  assert.equal(got.alice.marker, 2);
});
