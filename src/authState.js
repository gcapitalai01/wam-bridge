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

export async function useSupabaseAuthState(supabase, businessId, ownerInstance) {
  const table = "wam_auth_state";
  if (!ownerInstance) throw new Error("ownerInstance is required for fenced auth persistence");

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

  async function writeBatch(entries) {
    const {data,error} = await supabase.rpc("wa_auth_write_batch_if_owner", {
      p_business:businessId,p_owner_instance:ownerInstance,p_entries:entries,
    });
    if(error) throw new Error(`wam_auth_state batch write: ${error.code || "database_error"}`);
    if(data !== true) throw Object.assign(new Error("AUTH_WRITE_LEASE_LOST"),{code:"AUTH_WRITE_LEASE_LOST"});
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
              value = proto.Message.AppStateSyncKeyData.create(value);
            }
            if (value) out[id] = value;
          }
          return out;
        }),

        set: (data) => {
          // Snapshot before waiting: Baileys may mutate the original objects later.
          const entries=[];
          for(const [category,values] of Object.entries(data || {})) {
            for(const [id,value] of Object.entries(values || {})) {
              entries.push({key:`${category}-${id}`,value:value == null ? null : encode(value),delete:value == null});
            }
          }
          return withAuthLock(businessId,()=>writeBatch(entries));
        },
      },
    },

    saveCreds: () => {
      const snapshot=encode(creds);
      return withAuthLock(businessId,()=>writeBatch([{key:"creds",value:snapshot,delete:false}]));
    },
    flush: () => withAuthLock(businessId,async()=>{}),

    clearAll: () => withAuthLock(businessId, async () => {
      const { data, error } = await supabase.rpc("wa_auth_clear_if_owner", {
        p_business: businessId,
        p_owner_instance: ownerInstance,
      });
      if (error) throw new Error(`wam_auth_state fenced clear: ${error.message}`);
      if (data !== true) {
        throw Object.assign(new Error("AUTH_WRITE_LEASE_LOST"), {
          code: "AUTH_WRITE_LEASE_LOST",
        });
      }
    }),
  };
}
