// Baileys auth state persisted in Supabase.
// Kept intentionally simple to match the older Bridge flow that was stable.
import { initAuthCreds, BufferJSON, WAProto } from "@whiskeysockets/baileys";
const proto = WAProto;

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

  const creds = (await readData("creds")) || initAuthCreds();

  return {
    state: {
      creds,
      keys: {
        get: async (type, ids) => {
          const out = {};
          await Promise.all(
            ids.map(async (id) => {
              let value = await readData(`${type}-${id}`);
              if (type === "app-state-sync-key" && value) {
                value = proto.Message.AppStateSyncKeyData.fromObject(value);
              }
              if (value) out[id] = value;
            })
          );
          return out;
        },

        set: async (data) => {
          const tasks = [];
          for (const category of Object.keys(data || {})) {
            for (const id of Object.keys(data[category] || {})) {
              const value = data[category][id];
              const key = `${category}-${id}`;
              tasks.push(value ? writeData(key, value) : removeData(key));
            }
          }
          await Promise.all(tasks);
        },
      },
    },

    saveCreds: () => writeData("creds", creds),

    clearAll: async () => {
      const { error } = await supabase
        .from(table)
        .delete()
        .eq("business_id", businessId);
      if (error) throw new Error(`wam_auth_state clear: ${error.message}`);
    },
  };
}
