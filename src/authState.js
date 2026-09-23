// Baileys auth state persisted in Supabase.
// Signal key operations are serialized per business so concurrent crypto updates
// cannot overwrite each other with stale state.
import { initAuthCreds, BufferJSON, WAProto } from "@whiskeysockets/baileys";
const proto = WAProto;

export async function useSupabaseAuthState(supabase, businessId) {
  let keyQueue = Promise.resolve();

  const withKeyLock = (fn) => {
    const run = keyQueue.then(fn, fn);
    keyQueue = run.then(() => undefined, () => undefined);
    return run;
  };

  const encode = (value) =>
    JSON.parse(JSON.stringify(value, BufferJSON.replacer));

  const decode = (value) =>
    JSON.parse(JSON.stringify(value), BufferJSON.reviver);

  async function readData(key) {
    const { data, error } = await supabase
      .from("wam_auth_state")
      .select("value")
      .eq("business_id", businessId)
      .eq("data_key", key)
      .maybeSingle();

    if (error) throw new Error(`wam_auth_state read: ${error.message}`);
    return data ? decode(data.value) : null;
  }

  async function writeData(key, value) {
    const { error } = await supabase.from("wam_auth_state").upsert(
      {
        business_id: businessId,
        data_key: key,
        value: encode(value),
        updated_at: new Date().toISOString(),
      },
      { onConflict: "business_id,data_key" }
    );

    if (error) throw new Error(`wam_auth_state write: ${error.message}`);
  }

  const creds = (await readData("creds")) || initAuthCreds();

  const keys = {
    get: (type, ids) =>
      withKeyLock(async () => {
        const out = {};

        // Reads intentionally stay inside the same lock used by set().
        // A Signal decrypt must never observe half of a concurrent key mutation.
        for (const id of ids) {
          let value = await readData(`${type}-${id}`);
          if (type === "app-state-sync-key" && value) {
            value = proto.Message.AppStateSyncKeyData.fromObject(value);
          }
          if (value) out[id] = value;
        }

        return out;
      }),

    set: (data) =>
      withKeyLock(async () => {
        const upserts = [];
        const deletes = [];
        const now = new Date().toISOString();

        for (const category of Object.keys(data || {})) {
          for (const id of Object.keys(data[category] || {})) {
            const value = data[category][id];
            const dataKey = `${category}-${id}`;

            if (value) {
              upserts.push({
                business_id: businessId,
                data_key: dataKey,
                value: encode(value),
                updated_at: now,
              });
            } else {
              deletes.push(dataKey);
            }
          }
        }

        // A single batched UPSERT avoids Promise.all races between key writes.
        if (upserts.length) {
          const { error } = await supabase
            .from("wam_auth_state")
            .upsert(upserts, { onConflict: "business_id,data_key" });
          if (error) throw new Error(`wam_auth_state key upsert: ${error.message}`);
        }

        if (deletes.length) {
          const { error } = await supabase
            .from("wam_auth_state")
            .delete()
            .eq("business_id", businessId)
            .in("data_key", deletes);
          if (error) throw new Error(`wam_auth_state key delete: ${error.message}`);
        }
      }),
  };

  return {
    state: { creds, keys },

    // Baileys mutates the same creds object; serializing this row is sufficient.
    saveCreds: () => writeData("creds", creds),

    clearAll: async () => {
      // Wait for any in-flight Signal key operation before clearing the session.
      await withKeyLock(async () => {
        const { error } = await supabase
          .from("wam_auth_state")
          .delete()
          .eq("business_id", businessId);
        if (error) throw new Error(`wam_auth_state clear: ${error.message}`);
      });
    },
  };
}
