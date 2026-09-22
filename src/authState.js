// Baileys multi-file auth state persisted in Supabase (table wam_auth_state) —
// no local disk, Render's filesystem is ephemeral.
import { initAuthCreds, BufferJSON, WAProto } from "@whiskeysockets/baileys";
const proto = WAProto;

export async function useSupabaseAuthState(supabase, businessId) {
  async function readData(key) {
    const { data, error } = await supabase.from("wam_auth_state").select("value")
      .eq("business_id", businessId).eq("data_key", key).maybeSingle();
    if (error) throw new Error(`wam_auth_state read: ${error.message}`);
    return data ? JSON.parse(JSON.stringify(data.value), BufferJSON.reviver) : null;
  }
  async function writeData(key, value) {
    const json = JSON.parse(JSON.stringify(value, BufferJSON.replacer));
    const { error } = await supabase.from("wam_auth_state").upsert(
      { business_id: businessId, data_key: key, value: json, updated_at: new Date().toISOString() },
      { onConflict: "business_id,data_key" }
    );
    if (error) throw new Error(`wam_auth_state write: ${error.message}`);
  }
  async function removeData(key) {
    await supabase.from("wam_auth_state").delete().eq("business_id", businessId).eq("data_key", key);
  }

  const creds = (await readData("creds")) || initAuthCreds();

  return {
    state: {
      creds,
      keys: {
        get: async (type, ids) => {
          const out = {};
          for (const id of ids) {
            let value = await readData(`${type}-${id}`);
            if (type === "app-state-sync-key" && value) value = proto.Message.AppStateSyncKeyData.fromObject(value);
            if (value) out[id] = value;
          }
          return out;
        },
        set: async (data) => {
          const tasks = [];
          for (const category in data) {
            for (const id in data[category]) {
              const value = data[category][id];
              tasks.push(value ? writeData(`${category}-${id}`, value) : removeData(`${category}-${id}`));
            }
          }
          await Promise.all(tasks);
        },
      },
    },
    saveCreds: () => writeData("creds", creds),
    clearAll: async () => { await supabase.from("wam_auth_state").delete().eq("business_id", businessId); },
  };
}
