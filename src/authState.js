// Baileys auth state persisted in Supabase.
// Signal key operations must be serialized per business_id. Parallel key writes
// can make Baileys persist stale sessions after reconnects, producing Bad MAC /
// "No matching sessions found" decrypt failures.
import { initAuthCreds, BufferJSON, WAProto } from "@whiskeysockets/baileys";
const proto = WAProto;

const authLocks = new Map();

async function withAuthLock(businessId, fn) {
  const previous = authLocks.get(businessId) || Promise.resolve();
  let release;
  const current = new Promise((resolve) => { release = resolve; });
  const tail = previous.catch(() => {}).then(() => current);
  authLocks.set(businessId, tail);

  await previous.catch(() => {});
  try {
    return await fn();
  } finally {
    release();
    if (authLocks.get(businessId) === tail) authLocks.delete(businessId);
  }
}

export async function useSupabaseAuthState(supabase, businessId) {
  const table = "wam_auth_state";

  const encode = (value) =>
    JSON.parse(JSON.stringify(value, BufferJSON.replacer));

  const decode = (value) =>
    JSON.parse(JSON.stringify(value), BufferJSON.reviver);

  async function readData(key) {
    const { data, error } = await supabase
      .from(table)
      .select("value")
      .eq("business_id", businessId)
      .eq("data_key", key)
      .maybeSingle();

    if (error) throw new Error(`wam_auth_state read: ${error.message}`);
    return data ? decode(data.value) : null;
  }

  async function writeData(key, value) {
    const { error } = await supabase
      .from(table)
      .upsert(
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

  async function removeData(key) {
    const { error } = await supabase
      .from(table)
      .delete()
      .eq("business_id", businessId)
      .eq("data_key", key);

    if (error) throw new Error(`wam_auth_state delete: ${error.message}`);
  }

  const creds = (await withAuthLock(businessId, () => readData("creds"))) || initAuthCreds();

  return {
    state: {
      creds,
      keys: {
        get: (type, ids) => withAuthLock(businessId, async () => {
          const out = {};
          for (const id of ids || []) {
            let value = await readData(`${type}-${id}`);
            if (type === "app-state-sync-key" && value) {
              value = proto.Message.AppStateSyncKeyData.fromObject(value);
            }
            if (value) out[id] = value;
          }
          return out;
        }),

        set: (data) => withAuthLock(businessId, async () => {
          for (const category of Object.keys(data || {})) {
            for (const id of Object.keys(data[category] || {})) {
              const value = data[category][id];
              const key = `${category}-${id}`;
              if (value) await writeData(key, value);
              else await removeData(key);
            }
          }
        }),
      },
    },

    saveCreds: () => withAuthLock(businessId, () => writeData("creds", creds)),

    clearAll: () => withAuthLock(businessId, async () => {
      const { error } = await supabase
        .from(table)
        .delete()
        .eq("business_id", businessId);
      if (error) throw new Error(`wam_auth_state clear: ${error.message}`);
    }),
  };
}
