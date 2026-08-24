import { initAuthCreds, BufferJSON, proto } from '@whiskeysockets/baileys';

/**
 * Custom Baileys auth state backed by Supabase table `wam_auth_state`.
 * Table columns: business_id (text, pk part), data_key (text, pk part), value (jsonb)
 * Needed because Render free tier disk is ephemeral — without this, every
 * redeploy/restart would force the client to re-scan the QR code.
 */
export async function useSupabaseAuthState(supabase, businessId) {
  const table = 'wam_auth_state';

  async function readData(key) {
    const { data, error } = await supabase
      .from(table)
      .select('value')
      .eq('business_id', businessId)
      .eq('data_key', key)
      .maybeSingle();
    if (error) throw error;
    if (!data) return null;
    return JSON.parse(JSON.stringify(data.value), BufferJSON.reviver);
  }

  async function writeData(key, value) {
    const serialized = JSON.parse(JSON.stringify(value, BufferJSON.replacer));
    const { error } = await supabase
      .from(table)
      .upsert(
        { business_id: businessId, data_key: key, value: serialized, updated_at: new Date().toISOString() },
        { onConflict: 'business_id,data_key' }
      );
    if (error) throw error;
  }

  async function removeData(key) {
    await supabase.from(table).delete().eq('business_id', businessId).eq('data_key', key);
  }

  const creds = (await readData('creds')) || initAuthCreds();

  return {
    state: {
      creds,
      keys: {
        get: async (type, ids) => {
          const result = {};
          await Promise.all(
            ids.map(async (id) => {
              let value = await readData(`${type}-${id}`);
              if (type === 'app-state-sync-key' && value) {
                value = proto.Message.AppStateSyncKeyData.fromObject(value);
              }
              if (value) result[id] = value;
            })
          );
          return result;
        },
        set: async (data) => {
          const tasks = [];
          for (const category in data) {
            for (const id in data[category]) {
              const value = data[category][id];
              const key = `${category}-${id}`;
              tasks.push(value ? writeData(key, value) : removeData(key));
            }
          }
          await Promise.all(tasks);
        },
      },
    },
    saveCreds: async () => {
      await writeData('creds', creds);
    },
    clearAll: async () => {
      await supabase.from(table).delete().eq('business_id', businessId);
    },
  };
}
