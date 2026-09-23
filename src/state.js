// Supabase adapter for WhatsApp Bridge.
// Tables: wa_chat_state, wam_messages, wam_clients, bot_sent_messages, processed_webhook_events.
// RPCs: wa_mute_human, wa_enqueue, wa_claim_batch, wa_can_send, wa_due_batches,
// wa_finish_processing, wa_recover_stale_processing, wa_acquire_client_lease,
// wa_renew_client_lease, wa_release_client_lease.
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

    // Atomic cross-instance idempotency claim. The unique (source, external_event_id)
    // index is the authority; 23505 means another process already claimed it.
    async claimInboundEvent(key, waMessageId) {
      const externalEventId = `${key.businessId}:${key.connectionId}:${key.chatJid}:${waMessageId}`;
      const { error } = await supabase.from("processed_webhook_events").insert({
        source: "wam-bridge-inbound",
        external_event_id: externalEventId,
      });
      if (!error) return true;
      if (error.code === "23505") return false;
      throw new Error(`claimInboundEvent: ${error.message}`);
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

    async resolveQuoted(key, quoted) {
      if (!quoted?.stanzaId) return null;
      const { data, error } = await supabase.from("wam_messages").select("sender, text, is_business_context, detected_language")
        .eq("business_id", key.businessId).eq("connection_id", key.connectionId).eq("chat_jid", key.chatJid)
        .eq("wa_message_id", quoted.stanzaId).limit(1);
      if (error) throw new Error(`resolveQuoted: ${error.message}`);
      const row = data?.[0];
      if (!row) return { verified: false, isBusinessContext: false, text: quoted.inlineText, language: null, waMessageId: quoted.stanzaId };
      return {
        verified: true,
        isBusinessContext: (row.sender === "bot" || row.sender === "human") && !!row.is_business_context,
        text: row.text, language: row.detected_language, waMessageId: quoted.stanzaId,
      };
    },

    async muteForHuman(key, muteSeconds) {
      const seconds = Math.min(300, Math.max(1, Number(muteSeconds) || 300));
      return rpc("wa_mute_human", { ...k(key), p_mute_seconds: seconds });
    },

    async enqueue(key, item, { activate, reason, ttlSeconds, debounceMs }) {
      const rows = await rpc("wa_enqueue", {
        ...k(key), p_item: item, p_activate: activate, p_reason: reason,
        p_ttl_seconds: ttlSeconds, p_debounce_ms: debounceMs, p_max_items: 20,
      });
      const r = rows?.[0];
      return { accepted: !!r?.accepted, debounceVersion: Number(r?.debounce_version), dueAt: r?.debounce_due_at };
    },

    async claimBatch(key, debounceVersion) {
      const rows = await rpc("wa_claim_batch", { ...k(key), p_debounce_version: debounceVersion });
      const r = rows?.[0];
      return r ? { items: r.items || [], processingVersion: Number(r.processing_version) } : null;
    },

    async canSend(key, processingVersion) {
      return !!(await rpc("wa_can_send", { ...k(key), p_processing_version: processingVersion }));
    },

    async persistLanguage(key, { language, confidence, source }) {
      const { error } = await supabase.from("wa_chat_state").upsert({
        business_id: key.businessId, connection_id: key.connectionId, chat_jid: key.chatJid,
        detected_language: language, language_confidence: confidence, language_source: source,
        language_updated_at: new Date().toISOString(), updated_at: new Date().toISOString(),
      }, { onConflict: "business_id,connection_id,chat_jid" });
      if (error) throw new Error(`persistLanguage: ${error.message}`);
    },

    async finishProcessing(key, processingVersion) {
      return !!(await rpc("wa_finish_processing", { ...k(key), p_processing_version: processingVersion }));
    },

    async commitProcessingForSend(key, processingVersion) {
      return !!(await rpc("wa_commit_processing_for_send", {
        ...k(key),
        p_processing_version: processingVersion,
      }));
    },

    async recoverStaleProcessing(staleSeconds = 120, limit = 50) {
      return (await rpc("wa_recover_stale_processing", {
        p_stale_seconds: staleSeconds,
        p_limit: limit,
      })) || [];
    },

    async acquireClientLease(businessId, ownerInstance, leaseSeconds = 45) {
      return !!(await rpc("wa_acquire_client_lease", {
        p_business: businessId,
        p_owner_instance: ownerInstance,
        p_lease_seconds: leaseSeconds,
      }));
    },

    async renewClientLease(businessId, ownerInstance, leaseSeconds = 45) {
      return !!(await rpc("wa_renew_client_lease", {
        p_business: businessId,
        p_owner_instance: ownerInstance,
        p_lease_seconds: leaseSeconds,
      }));
    },

    async releaseClientLease(businessId, ownerInstance) {
      return !!(await rpc("wa_release_client_lease", {
        p_business: businessId,
        p_owner_instance: ownerInstance,
      }));
    },

    async dueBatches(limit = 50) {
      return (await rpc("wa_due_batches", { p_limit: limit })) || [];
    },

    async getSettings(businessId) {
      const { data, error } = await supabase.from("wam_clients").select("settings").eq("business_id", businessId).maybeSingle();
      if (error) throw new Error(`getSettings: ${error.message}`);
      const settings = data?.settings || {};
      const activation = settings.activation_filter || settings.whatsapp_activation || {};
      const requestedMute = Number(activation.manual_mute_seconds ?? activation.human_mute_seconds ?? 300);
      return {
        enabled: activation.enabled !== false,
        business_session_ttl_seconds: activation.business_session_ttl_seconds ?? 900,
        debounce_seconds: activation.debounce_seconds ?? 4,
        human_mute_seconds: Math.min(300, Math.max(1, Number.isFinite(requestedMute) ? requestedMute : 300)),
        tenantKeywords: settings.business_keywords || activation.keywords || [],
        industryKeywords: settings.industry_keywords || activation.industry_keywords || [],
        tenantDefaultLanguage: settings.default_language || null,
      };
    },
  };
}
