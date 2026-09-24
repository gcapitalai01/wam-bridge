export function evaluateWhatsAppAccess({
  businessExists = false,
  deletedAt = null,
  businessSubscriptionStatus = null,
  hasActiveSubscription = false,
  validTrial = false,
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

  if (businessSubscriptionStatus === "trial" && validTrial) {
    return { allowed: true, reason: "ACTIVE_TRIAL" };
  }

  return { allowed: false, reason: "PAID_PLAN_REQUIRED" };
}

export function createWhatsAppAccessControl(supabase, log = console) {
  return async function checkWhatsAppAccess(businessId) {
    const { data: business, error: businessError } = await supabase
      .from("businesses")
      .select("id, deleted_at, subscription_status, trial_days, created_at")
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

    const trialDays = Math.max(0, Number(business.trial_days) || 0);
    const trialStartedAt = Date.parse(business.created_at || "");
    const validTrial = business.subscription_status === "trial"
      && trialDays > 0
      && Number.isFinite(trialStartedAt)
      && Date.now() < trialStartedAt + trialDays * 86400000;

    const access = evaluateWhatsAppAccess({
      businessExists: true,
      deletedAt: business.deleted_at,
      businessSubscriptionStatus: business.subscription_status,
      hasActiveSubscription: (subscriptionResult.data || []).length > 0,
      validTrial,
      adminOverride: overrideResult.data?.enabled === true,
    });

    log.info?.({ businessId, accessReason: access.reason }, "WhatsApp access evaluated");
    return access;
  };
}

// Wraps any checkWhatsAppAccess-shaped function with a short in-memory cache so
// per-message inbound automation and every /send call don't hammer the DB.
// A lookup failure (thrown error) is NOT cached and fails closed (blocked),
// so a transient DB error can never be mistaken for a cached "allowed".
export function createCachedAccessCheck(checkFn, ttlMs = 60000) {
  const cache = new Map(); // businessId -> { access, expiresAt }
  return async function cachedCheck(businessId) {
    const now = Date.now();
    const hit = cache.get(businessId);
    if (hit && hit.expiresAt > now) return hit.access;
    try {
      const access = await checkFn(businessId);
      cache.set(businessId, { access, expiresAt: now + ttlMs });
      return access;
    } catch (err) {
      cache.delete(businessId);
      return { allowed: false, reason: "ACCESS_CHECK_FAILED" };
    }
  };
}
