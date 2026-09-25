// One Baileys socket per business_id per active lease owner.
// Auth lives in Supabase so deploys/restarts can reconnect without relinking.
import makeWASocket, {
  Browsers,
  DisconnectReason,
  fetchLatestBaileysVersion,
  jidNormalizedUser,
  makeCacheableSignalKeyStore,
} from "@whiskeysockets/baileys";
import QRCode from "qrcode";
import { useSupabaseAuthState } from "./authState.js";

export function createSessionManager({
  supabase,
  logger,
  onMessages,
  onClientStatus,
  canConnect,
  acquireLease,
  renewLease,
  releaseLease,
  instanceId,
  leaseSeconds = 45,
}) {
  const sessions = new Map();
  const reconnectAttempts = new Map();
  const resumeRetryTimers = new Map();
  const leaseRenewMs = Math.max(5000, Math.floor((leaseSeconds * 1000) / 3));
  // Fast, capped-exponential retry for lease takeover. Starts quick (a few
  // seconds) so a normal redeploy hands the lease back over almost instantly
  // once the old instance's lease actually expires or it releases on
  // shutdown, instead of waiting out one fixed ~lease-length interval.
  // Backs off up to leaseSeconds*1000 if acquisition keeps failing, so a
  // genuinely stuck business does not hammer the DB forever.
  const LEASE_RETRY_FLOOR_MS = 3000;
  const LEASE_RETRY_CEILING_MS = Math.max(LEASE_RETRY_FLOOR_MS, leaseSeconds * 1000);
  const leaseRetryBackoff = new Map(); // businessId -> current retry delay ms

  function nextLeaseRetryDelay(businessId) {
    const current = leaseRetryBackoff.get(businessId) || LEASE_RETRY_FLOOR_MS;
    const jitter = Math.floor(current * 0.2 * Math.random());
    leaseRetryBackoff.set(businessId, Math.min(current * 2, LEASE_RETRY_CEILING_MS));
    return current + jitter;
  }

  function resetLeaseRetryDelay(businessId) {
    leaseRetryBackoff.delete(businessId);
  }

  function clearResumeRetry(businessId) {
    const timer = resumeRetryTimers.get(businessId);
    if (timer) clearTimeout(timer);
    resumeRetryTimers.delete(businessId);
  }

  function scheduleResumeRetry(businessId, delayMsOverride) {
    if (resumeRetryTimers.has(businessId)) return;
    const delayMs = delayMsOverride ?? nextLeaseRetryDelay(businessId);
    const timer = setTimeout(async () => {
      resumeRetryTimers.delete(businessId);
      try {
        await startSession(businessId);
      } catch (e) {
        // Compute the NEXT delay exactly once per failed attempt and reuse
        // it for both the log line and the actual timer -- calling the
        // backoff generator twice here was doubling the growth rate.
        const retryDelayMs = nextLeaseRetryDelay(businessId);
        if (e?.code === "SESSION_OWNED_ELSEWHERE") {
          logger.info({ businessId, instanceId, retryDelayMs }, "WhatsApp lease still owned elsewhere; retry scheduled");
        } else {
          // Any other failure acquiring the lease (transient RPC error, 503,
          // timeout) also gets a backed-off retry instead of giving up for
          // good -- a business should never end up permanently unrecovered
          // just because one lease check hit a network blip.
          logger.error({ e, businessId, retryDelayMs }, "WhatsApp lease takeover attempt failed; retrying with backoff");
        }
        scheduleResumeRetry(businessId, retryDelayMs);
      }
    }, delayMs);
    timer.unref?.();
    resumeRetryTimers.set(businessId, timer);
  }

  function getState(businessId) {
    if (!sessions.has(businessId)) {
      sessions.set(businessId, {
        sock: null,
        qr: null,
        pairingCode: null,
        status: "disconnected",
        phone: null,
        connecting: false,
        leaseTimer: null,
        lastLeaseRenewedAt: null,
      });
    }
    return sessions.get(businessId);
  }

  function clearLeaseTimer(st) {
    if (st?.leaseTimer) clearInterval(st.leaseTimer);
    if (st) st.leaseTimer = null;
  }

  function terminateForLeaseLoss(businessId, st, reason) {
    clearLeaseTimer(st);
    logger.error({ businessId, instanceId, reason }, "WhatsApp session lease lost");
    try { st.sock?.end?.(new Error("session lease lost")); } catch (_) {}
    sessions.delete(businessId);
  }

  async function releaseBusinessLease(businessId, st) {
    clearLeaseTimer(st);
    resetLeaseRetryDelay(businessId);
    if (releaseLease && instanceId) {
      await releaseLease(businessId, instanceId).catch((err) =>
        logger.warn({ err, businessId }, "lease release failed")
      );
    }
  }

  async function startLease(businessId, st) {
    if (!acquireLease || !instanceId) return;

    const acquired = await acquireLease(businessId, instanceId, leaseSeconds);
    if (!acquired) {
      throw Object.assign(new Error("SESSION_OWNED_ELSEWHERE"), {
        code: "SESSION_OWNED_ELSEWHERE",
      });
    }

    resetLeaseRetryDelay(businessId);
    clearResumeRetry(businessId);
    st.lastLeaseRenewedAt = Date.now();
    clearLeaseTimer(st);
    let renewInFlight = false;
    const timer = setInterval(async () => {
      // Never let a slow/hung renewal call pile another one on top of it for
      // the SAME business -- at scale (many businesses, each with their own
      // timer) that is what turns one transient Supabase slowdown into a
      // burst of concurrent duplicate requests.
      if (renewInFlight) return;
      renewInFlight = true;
      try {
        const ok = await renewLease?.(businessId, instanceId, leaseSeconds);
        if (ok === false) {
          terminateForLeaseLoss(businessId, st, "owner_changed");
          return;
        }
        st.lastLeaseRenewedAt = Date.now();
      } catch (err) {
        logger.error({ err, businessId }, "lease renewal failed");
        const elapsed = Date.now() - (st.lastLeaseRenewedAt || 0);
        // Fail closed before the DB lease can expire. This prevents a second
        // instance from acquiring the same business while this socket remains live.
        if (elapsed >= Math.floor(leaseSeconds * 1000 * 0.66)) {
          terminateForLeaseLoss(businessId, st, "renewal_timeout");
        }
      } finally {
        renewInFlight = false;
      }
    }, leaseRenewMs);
    timer.unref?.();
    st.leaseTimer = timer;
  }

  async function setStatus(businessId, status, extra = {}) {
    const st = getState(businessId);
    st.status = status;
    if (extra.phone !== undefined) st.phone = extra.phone;
    await onClientStatus?.(businessId, status, extra.phone ?? st.phone);
  }

  async function startSession(businessId, phoneNumberForPairing) {
    if (canConnect) {
      const access = await canConnect(businessId);
      if (!access?.allowed) {
        const reason = access?.reason || "WHATSAPP_NOT_AUTHORIZED";
        throw Object.assign(new Error(reason), {
          code: "WHATSAPP_NOT_AUTHORIZED",
          accessReason: reason,
        });
      }
    }

    const st = getState(businessId);
    if (st.connecting || (st.sock && st.status === "connected")) return st;

    let leaseAcquired = false;
    try {
      await startLease(businessId, st);
      leaseAcquired = true;
      st.connecting = true;

      const { state: authState, saveCreds, clearAll } = await useSupabaseAuthState(supabase, businessId);
      const { version } = await fetchLatestBaileysVersion();
      const sock = makeWASocket({
        version,
        auth: {
          creds: authState.creds,
          keys: makeCacheableSignalKeyStore(authState.keys, logger),
        },
        logger,
        printQRInTerminal: false,
        browser: Browsers.ubuntu("Chrome"),
        markOnlineOnConnect: false,
        syncFullHistory: false,
        shouldSyncHistoryMessage: () => false,
        // We do not use privacy/blocklist/business-profile init queries. They are
        // optional in Baileys and can time out/reconnect long-lived headless sockets.
        fireInitQueries: false,
        getMessage: async () => undefined,
      });

      st.sock = sock;
      st.status = "connecting";

      if (phoneNumberForPairing && !authState.creds.registered) {
        try {
          st.pairingCode = await sock.requestPairingCode(
            phoneNumberForPairing.replace(/[^0-9]/g, "")
          );
          st.status = "pairing_pending";
          await setStatus(businessId, "pairing_pending");
        } catch (err) {
          logger.error({ err }, "requestPairingCode failed — falling back to QR");
        }
      }

      sock.ev.on("creds.update", saveCreds);

      sock.ev.on("connection.update", async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
          st.qr = await QRCode.toDataURL(qr);
          if (st.status !== "pairing_pending" && !st.pairingCode) {
            await setStatus(businessId, "qr_pending");
          }
        }

        if (connection === "open") {
          st.qr = null;
          st.pairingCode = null;
          st.connecting = false;
          reconnectAttempts.delete(businessId);
          await setStatus(businessId, "connected", {
            phone: sock.user?.id ? jidNormalizedUser(sock.user.id).split("@")[0] : null,
          });
        }

        if (connection === "close") {
          st.connecting = false;
          clearLeaseTimer(st);

          const statusCode = lastDisconnect?.error?.output?.statusCode;
          const loggedOut =
            statusCode === DisconnectReason.loggedOut || statusCode === 401;

          if (loggedOut) {
            await setStatus(businessId, "disconnected");
            await clearAll();
            await releaseBusinessLease(businessId, st);
            sessions.delete(businessId);
            reconnectAttempts.delete(businessId);
          } else {
            await setStatus(businessId, "reconnecting");
            const attempt = (reconnectAttempts.get(businessId) || 0) + 1;
            reconnectAttempts.set(businessId, attempt);
            const delay = Math.min(3000 * Math.pow(2, attempt - 1), 60000);
            sessions.delete(businessId);
            setTimeout(() => {
              startSession(businessId).catch((e) => {
                if (e?.code === "SESSION_OWNED_ELSEWHERE") {
                  scheduleResumeRetry(businessId);
                  return;
                }
                logger.error({ e, businessId }, "reconnect failed");
              });
            }, delay).unref?.();
          }
        }
      });

      sock.ev.on("messages.upsert", async (payload) => {
        try {
          await onMessages?.(businessId, sock, payload);
        } catch (err) {
          logger.error({ err }, "onMessages handler failed");
        }
      });

      return st;
    } catch (err) {
      st.connecting = false;
      if (leaseAcquired) await releaseBusinessLease(businessId, st);
      throw err;
    }
  }

  async function stopSession(businessId) {
    const st = getState(businessId);
    clearResumeRetry(businessId);
    clearLeaseTimer(st);
    if (st.sock) {
      try { await st.sock.logout(); } catch (_) {}
    }
    await releaseBusinessLease(businessId, st);
    sessions.delete(businessId);
    await onClientStatus?.(businessId, "disconnected", st.phone);
  }

  async function resumeAll() {
    const { data, error } = await supabase
      .from("wam_clients")
      .select("business_id, status")
      .in("status", ["connected", "connecting", "reconnecting", "pairing_pending", "qr_pending"]);

    if (error) {
      logger.error({ error }, "resumeAll query failed");
      return;
    }

    for (const row of data || []) {
      startSession(row.business_id).catch((e) => {
        if (e?.code === "SESSION_OWNED_ELSEWHERE") {
          scheduleResumeRetry(row.business_id);
          return;
        }
        logger.error({ e, businessId: row.business_id }, "resumeAll: session failed");
      });
    }
  }

  async function shutdownAll() {
    for (const timer of resumeRetryTimers.values()) clearTimeout(timer);
    resumeRetryTimers.clear();
    const entries = [...sessions.entries()];
    for (const [businessId, st] of entries) {
      clearLeaseTimer(st);
      try { st.sock?.end?.(new Error("bridge shutdown")); } catch (_) {}
      await releaseBusinessLease(businessId, st);
    }
    sessions.clear();
  }

  return { getState, startSession, stopSession, resumeAll, shutdownAll, sessions };
}
