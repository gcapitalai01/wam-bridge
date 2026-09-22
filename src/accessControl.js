export function evaluateWhatsAppAccess({
  businessExists = false,
  deletedAt = null,
  businessSubscriptionStatus = null,
  hasActiveSubscription = false,
  adminOverride = false,
} = {}) {
  if (!businessExists || deletedAt) {
    return { allowed: false, reason: "BUSINESS_NOT_REGISTERED" };
  }

  if (adminOverride) {
    return { allowed: true, reason: "ADMIN_OVERRIDE" };
  }

  if (hasActiveSubscription || businessSubscriptionStatus === "active") {
    return { allowed: true, reason: "ACTIVE_PAID_SUBSCRIPTION" };
  }

  return { allowed: false, reason: "PAID_PLAN_REQUIRED" };
}

export function createWhatsAppAccessControl(supabase, log = console) {
  return async function checkWhatsAppAccess(businessId) {
    const { data: business, error: businessError } = await supabase
      .from("businesses")
      .select("id, deleted_at, subscription_status")
      .eq("id", businessId)
      .maybeSingle();

    if (businessError) throw new Error(`whatsapp access business lookup: ${businessError.message}`);

    if (!business || business.deleted_at) {
      return evaluateWhatsAppAccess({
        businessExists: !!business,
        deletedAt: business?.deleted_at || null,
      });
    }

    const [subscriptionResult, overrideResult] = await Promise.all([
      supabase
        .from("subscriptions")
        .select("id")
        .eq("business_id", businessId)
        .eq("status", "active")
        .limit(1),
      supabase
        .from("business_features")
        .select("enabled")
        .eq("business_id", businessId)
        .eq("feature_key", "whatsapp")
        .maybeSingle(),
    ]);

    if (subscriptionResult.error) {
      throw new Error(`whatsapp access subscription lookup: ${subscriptionResult.error.message}`);
    }

    if (overrideResult.error) {
      throw new Error(`whatsapp access override lookup: ${overrideResult.error.message}`);
    }

    const access = evaluateWhatsAppAccess({
      businessExists: true,
      deletedAt: business.deleted_at,
      businessSubscriptionStatus: business.subscription_status,
      hasActiveSubscription: (subscriptionResult.data || []).length > 0,
      adminOverride: overrideResult.data?.enabled === true,
    });

    log.info?.({ businessId, accessReason: access.reason }, "WhatsApp access evaluated");
    return access;
  };
}
