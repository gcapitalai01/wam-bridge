// Supabase adapter. Uses only existing tables/RPCs — no new schema.
// Tables: wa_chat_state, wam_messages, wam_clients, bot_sent_messages.
// RPCs (already deployed): wa_mute_human, wa_enqueue, wa_claim_batch, wa_can_send, wa_due_batches.
const phoneOf = (jid) => String(jid || "").split("@")[0].split(":")[0];

export function createState(supabase, log = console) {
  const rpc = async (fn, args) => {
    const { data, error } = await supabase.rpc(fn, args);
    if (error) throw new Error(`${fn}: ${error.message}`);
    return data;
  };
  const k = (key) => ({ p_business: key.businessId, p_conn: key.connectionId, p_jid: key.chatJid });

  return {
    async isBotOutbound(key, messageId) {
      const { data, error } = await supabase.from("bot_sent_messages").select("id")
        .eq("business_id", key.businessId).eq("channel", "whatsapp").eq("external_id", messageId).limit(1);
      if (error) throw new Error(`isBotOutbound: ${error.message}`);
      return (data || []).length > 0;
    },

    async registerOutbound(key, messageId) {
      const { error } = await supabase.from("bot_sent_messages").insert({
        business_id: key.businessId, channel: "whatsapp", external_id: messageId,
        connection_id: key.connectionId, chat_jid: key.chatJid,
      });
      if (error) throw new Error(`registerOutbound: ${error.message}`);
    },

    // Idempotency: a row with this wa_message_id already recorded for this chat => duplicate.
    async wasSeen(key, waMessageId) {
      const { data, error } = await supabase.from("wam_messages").select("id")
        .eq("business_id", key.businessId).eq("connection_id", key.connectionId)
        .eq("chat_jid", key.chatJid).eq("wa_message_id", waMessageId).limit(1);
      if (error) throw new Error(`wasSeen: ${error.message}`);
      return (data || []).length > 0;
    },

    async recordMessage(key, { direction, sender, waMessageId, text, isBusinessContext = false, gateReason = null,
      mediaType = null, detectedLanguage = null, languageConfidence = null, languageSource = null,
      quotedWaMessageId = null, quotedIsBusinessContext = null }) {
      const { error } = await supabase.from("wam_messages").insert({
        business_id: key.businessId, connection_id: key.connectionId, chat_jid: key.chatJid,
        phone: phoneOf(key.chatJid), direction, sender, wa_message_id: waMessageId,
        text: text || null, media_type: mediaType, is_business_context: isBusinessContext, gate_reason: gateReason,
        detected_language: detectedLanguage, language_confidence: languageConfidence, language_source: languageSource,
        quoted_wa_message_id: quotedWaMessageId, quoted_is_business_context: !!quotedIsBusinessContext,
      });
      if (error) log.warn?.({ error }, "recordMessage failed (non-blocking)");
    },

    async getChatState(key) {
      const { data, error } = await supabase.from("wa_chat_state").select("*")
        .eq("business_id", key.businessId).eq("connection_id", key.connectionId).eq("chat_jid", key.chatJid).maybeSingle();
      if (error) throw new Error(`getChatState: ${error.message}`);
      return data;
    },

    // Resolve the quoted message against wam_messages (verified) — no re-invention if not found.
    async resolveQuoted(key, quoted) {
      if (!quoted?.stanzaId) return null;
      const { data } = await supabase.from("wam_messages").select("sender, text, is_business_context, detected_language")
        .eq("business_id", key.businessId).eq("connection_id", key.connectionId).eq("chat_jid", key.chatJid)
        .eq("wa_message_id", quoted.stanzaId).limit(1);
      const row = data?.[0];
      if (!row) return { verified: false, isBusinessContext: false, text: quoted.inlineText, language: null, waMessageId: quoted.stanzaId };
      return {
        verified: true,
        isBusinessContext: (row.sender === "bot" || row.sender === "human") && !!row.is_business_context,
        text: row.text, language: row.detected_language, waMessageId: quoted.stanzaId,
      };
    },

    async muteForHuman(key, muteSeconds) {
      return rpc("wa_mute_human", { ...k(key), p_mute_seconds: muteSeconds });
    },

    // Activates business session + pushes into the 4s debounce buffer (existing RPC covers both).
    async enqueue(key, item, { activate, reason, ttlSeconds, debounceMs }) {
      const rows = await rpc("wa_enqueue", {
        ...k(key), p_item: item, p_activate: activate, p_reason: reason,
        p_ttl_seconds: ttlSeconds, p_debounce_ms: debounceMs, p_max_items: 20,
      });
      const r = rows?.[0];
      return { accepted: !!r?.accepted, debounceVersion: Number(r?.debounce_version), dueAt: r?.debounce_due_at };
    },

    // Re-read Supabase state before AI: atomically claims the batch only if still the latest version.
    async claimBatch(key, debounceVersion) {
      const rows = await rpc("wa_claim_batch", { ...k(key), p_debounce_version: debounceVersion });
      const r = rows?.[0];
      return r ? { items: r.items || [], processingVersion: Number(r.processing_version) } : null;
    },

    // Re-read state again before sending.
    async canSend(key, processingVersion) {
      return !!(await rpc("wa_can_send", { ...k(key), p_processing_version: processingVersion }));
    },

    // UPSERT (not UPDATE): the first business message for a brand-new chat has
    // no wa_chat_state row yet, so a plain UPDATE would silently affect zero
    // rows and the session language would never be stored.
    async persistLanguage(key, { language, confidence, source }) {
      const { error } = await supabase.from("wa_chat_state").upsert({
        business_id: key.businessId, connection_id: key.connectionId, chat_jid: key.chatJid,
        detected_language: language, language_confidence: confidence, language_source: source,
        language_updated_at: new Date().toISOString(), updated_at: new Date().toISOString(),
      }, { onConflict: "business_id,connection_id,chat_jid" });
      if (error) log.warn?.({ error }, "persistLanguage failed (non-blocking)");
    },

    // Clears processing_started_at once a claimed batch finishes/cancels/fails,
    // guarded by processing_version so a stale clear can never clobber a newer
    // claim that has already moved the version forward.
    async clearProcessing(key, processingVersion) {
      const { error } = await supabase.from("wa_chat_state").update({
        processing_started_at: null, updated_at: new Date().toISOString(),
      }).eq("business_id", key.businessId).eq("connection_id", key.connectionId).eq("chat_jid", key.chatJid)
        .eq("processing_version", processingVersion);
      if (error) log.warn?.({ error }, "clearProcessing failed (non-blocking)");
    },

    async dueBatches(limit = 50) {
      return (await rpc("wa_due_batches", { p_limit: limit })) || [];
    },

    async getSettings(businessId) {
      const { data } = await supabase.from("wam_clients").select("settings").eq("business_id", businessId).maybeSingle();
      const settings = data?.settings || {};
      const activation = settings.activation_filter || settings.whatsapp_activation || {};
      return {
        enabled: activation.enabled !== false,
        business_session_ttl_seconds: activation.business_session_ttl_seconds ?? 900,
        debounce_seconds: activation.debounce_seconds ?? 4,
        human_mute_seconds: activation.manual_mute_seconds ?? activation.human_mute_seconds ?? 1800,
        tenantKeywords: settings.business_keywords || activation.keywords || [],
        industryKeywords: settings.industry_keywords || activation.industry_keywords || [],
        tenantDefaultLanguage: settings.default_language || null,
      };
    },
  };
}
