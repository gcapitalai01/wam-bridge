// One Baileys socket per business_id per active lease owner.
// Auth lives in Supabase so deploys/restarts can reconnect without relinking.
import { randomUUID } from "node:crypto";
import makeWASocket, {
  Browsers,
  DisconnectReason,
  fetchLatestBaileysVersion,
  jidNormalizedUser,
} from "@whiskeysockets/baileys";
import QRCode from "qrcode";
import { useSupabaseAuthState } from "./authState.js";
import { getSentMessage } from "./sentCache.js";

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
  watchdog,
}) {
  const sessions = new Map();
  const starting = new Map();
  let shuttingDown = false;
  const reconnectAttempts = new Map();
  const reconnectTimers = new Map();
  const resumeRetryTimers = new Map();
  const leaseRenewMs = Math.max(5000, Math.floor((leaseSeconds * 1000) / 3));
  // Fast, capped-exponential retry for lease takeover. Starts quick (a few
  // seconds) so a normal redeploy hands the lease back over almost instantly
  // once the old instance's lease actually expires or it releases on
  // shutdown, instead of waiting out one fixed ~lease-length interval.
  // Backs off up to leaseSeconds*1000 if acquisition keeps failing, so a
  // genuinely stuck business does not hammer the DB forever. Keep the cap at\n  // 15s so an expired/released lease cannot leave a business offline for ~45s.
  const LEASE_RETRY_FLOOR_MS = 3000;
  const LEASE_RETRY_CEILING_MS = Math.max(LEASE_RETRY_FLOOR_MS, Math.min(15000, leaseSeconds * 1000));
  const leaseRetryBackoff = new Map(); // businessId -> current retry delay ms
  const RESUME_CONCURRENCY = 5;
  const RESUME_STAGGER_MS = 250;
  const FAST_TRANSIENT_DISCONNECT_CODES = new Set([408, 428, 503, 515]);
  const FAST_RECONNECT_BASE_MS = 1500;
  const FAST_RECONNECT_MAX_MS = 10000;
  const STABLE_CONNECTION_MS = 10 * 60 * 1000;
  let baileysVersionPromise = null;

  async function getBaileysVersion() {
    if (!baileysVersionPromise) {
      baileysVersionPromise = fetchLatestBaileysVersion()
        .then(({ version }) => version)
        .catch((err) => {
          baileysVersionPromise = null;
          throw err;
        });
    }
    return baileysVersionPromise;
  }

  function nextLeaseRetryDelay(businessId) {
    const current = leaseRetryBackoff.get(businessId) || LEASE_RETRY_FLOOR_MS;
    const jitter = Math.floor(current * 0.2 * Math.random());
    leaseRetryBackoff.set(businessId, Math.min(current * 2, LEASE_RETRY_CEILING_MS));
    return current + jitter;
  }

  function resetLeaseRetryDelay(businessId) {
    leaseRetryBackoff.delete(businessId);
  }

  function disconnectStatusCode(lastDisconnect) {
    const raw =
      lastDisconnect?.error?.output?.statusCode ??
      lastDisconnect?.error?.data?.statusCode ??
      lastDisconnect?.error?.data?.attrs?.code ??
      null;
    const code = Number(raw);
    return Number.isFinite(code) ? code : null;
  }

  function reconnectDelayMs(statusCode, attempt) {
    const transient = FAST_TRANSIENT_DISCONNECT_CODES.has(statusCode);
    const base = transient ? FAST_RECONNECT_BASE_MS : 3000;
    const ceiling = transient ? FAST_RECONNECT_MAX_MS : 60000;
    const exponential = Math.min(base * Math.pow(2, Math.max(0, attempt - 1)), ceiling);
    return exponential + Math.floor(exponential * 0.15 * Math.random());
  }

  function clearReconnectTimer(businessId) {
    const timer = reconnectTimers.get(businessId);
    if (timer) clearTimeout(timer);
    reconnectTimers.delete(businessId);
  }

  function clearStabilityTimer(st) {
    if (st?.stabilityTimer) clearTimeout(st.stabilityTimer);
    if (st) st.stabilityTimer = null;
  }

  function scheduleReconnect(businessId, delayMs) {
    if (shuttingDown) return;
    if (reconnectTimers.has(businessId)) return;
    const timer = setTimeout(() => {
      reconnectTimers.delete(businessId);
      automaticStart(businessId).catch((e) => {
        if (e?.code === "SESSION_OWNED_ELSEWHERE") {
          scheduleResumeRetry(businessId);
          return;
        }
        if (e?.code === "WHATSAPP_NOT_AUTHORIZED") { watchdog?.incident("access_blocked", businessId); return; }
        logger.error({ e, businessId }, "reconnect failed");
        scheduleResumeRetry(businessId);
      });
    }, delayMs);
    timer.unref?.();
    reconnectTimers.set(businessId, timer);
  }

  async function automaticStart(businessId) {
    const delay = watchdog?.recoveryDelay(businessId) || 0;
    if (delay) { scheduleResumeRetry(businessId, delay); return; }
    try { return await startSession(businessId); }
    catch (e) {
      // Waiting for the previous deploy is not a failed recovery attempt.
      if (e?.code === "SESSION_OWNED_ELSEWHERE") watchdog?.deferOwnership(businessId);
      throw e;
    }
  }

  function inspectSessions() {
    if (shuttingDown) return;
    for (const [businessId, st] of sessions) {
      if (st.status === "connected" && st.sock?.ws?.isClosed === true) {
        watchdog?.incident("socket_closed_without_event", businessId);
        terminateForLeaseLoss(businessId, st, "watchdog_closed_socket");
      } else if (st.status === "connecting" && Date.now() - (st.startedAt || Date.now()) > 90000) {
        watchdog?.incident("connection_timeout", businessId);
        terminateForLeaseLoss(businessId, st, "watchdog_connection_timeout");
      }
    }
  }

  function clearResumeRetry(businessId) {
    const timer = resumeRetryTimers.get(businessId);
    if (timer) clearTimeout(timer);
    resumeRetryTimers.delete(businessId);
  }

  function scheduleResumeRetry(businessId, delayMsOverride) {
    if (shuttingDown) return;
    if (resumeRetryTimers.has(businessId)) return;
    const delayMs = delayMsOverride ?? nextLeaseRetryDelay(businessId);
    const timer = setTimeout(async () => {
      resumeRetryTimers.delete(businessId);
      try {
        await automaticStart(businessId);
      } catch (e) {
        if (e?.code === "WHATSAPP_NOT_AUTHORIZED") { watchdog?.incident("access_blocked", businessId); return; }
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
        stabilityTimer: null,
        connectedAt: null,
        lastLeaseRenewedAt: null,
        leaseOwner: null,
      });
    }
    return sessions.get(businessId);
  }

  function clearLeaseTimer(st) {
    if (st?.leaseTimer) clearInterval(st.leaseTimer);
    if (st?.leaseWatchdog) clearInterval(st.leaseWatchdog);
    if (st) { st.leaseTimer = null; st.leaseWatchdog = null; }
  }

  function terminateForLeaseLoss(businessId, st, reason) {
    clearLeaseTimer(st);
    clearStabilityTimer(st);
    watchdog?.incident("lease_lost", businessId);
    logger.error({ businessId, instanceId, reason }, "WhatsApp session lease lost");
    const sock=st.sock; st.sock=null; st.status="reconnecting"; st.connecting=false;
    try { sock?.end?.(new Error("session lease lost")); } catch (_) {}
    if (sessions.get(businessId) === st) sessions.delete(businessId);
    scheduleResumeRetry(businessId);
  }

  async function releaseBusinessLease(businessId, st) {
    clearLeaseTimer(st);
    clearStabilityTimer(st);
    resetLeaseRetryDelay(businessId);
    await st?.authStore?.flush();
    const leaseOwner = st?.leaseOwner;
    if (releaseLease && leaseOwner) {
      await releaseLease(businessId, leaseOwner).catch((err) =>
        logger.warn({ err, businessId }, "lease release failed")
      );
    }
    if (st) st.leaseOwner = null;
  }

  async function startLease(businessId, st) {
    if (!acquireLease || !instanceId) return;

    if (!st.leaseOwner) st.leaseOwner = `${instanceId}:${randomUUID()}`;
    const leaseOwner = st.leaseOwner;

    const acquired = await acquireLease(businessId, leaseOwner, leaseSeconds);
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
        const ok = await renewLease?.(businessId, leaseOwner, leaseSeconds);
        // A renewal is valid only when the database explicitly confirms ownership.
        // Null/undefined must never extend a live socket's local lease clock.
        if (ok !== true) {
          terminateForLeaseLoss(businessId, st, "owner_unconfirmed");
          return;
        }
        // An expired local lease cannot be resurrected by a late RPC response.
        if (sessions.get(businessId) !== st || st.leaseOwner !== leaseOwner) return;
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
    // Independent of the renewal promise: a hung RPC must not keep a socket alive.
    st.leaseWatchdog=setInterval(()=>{
      if(Date.now()-(st.lastLeaseRenewedAt || 0)>=leaseSeconds*1000*0.8) {
        terminateForLeaseLoss(businessId,st,"lease_deadline_exceeded");
      }
    },1000);
    st.leaseWatchdog.unref?.();
  }

  async function setStatus(businessId, status, extra = {}) {
    const st = getState(businessId);
    st.status = status;
    if (extra.phone !== undefined) st.phone = extra.phone;
    await onClientStatus?.(businessId, status, extra.phone ?? st.phone);
  }

  function startSession(businessId, phoneNumberForPairing) {
    if(shuttingDown) return Promise.reject(new Error("BRIDGE_SHUTTING_DOWN"));
    if(starting.has(businessId)) return starting.get(businessId);
    const pending=startSessionOnce(businessId,phoneNumberForPairing).finally(()=>{
      if(starting.get(businessId)===pending) starting.delete(businessId);
    });
    starting.set(businessId,pending);
    return pending;
  }

  async function startSessionOnce(businessId, phoneNumberForPairing) {
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

      const authStore = await useSupabaseAuthState(supabase, businessId, st.leaseOwner);
      st.authStore = authStore;
      const { state: authState, saveCreds } = authStore;
      const version = await getBaileysVersion();
      if (shuttingDown || sessions.get(businessId)!==st || Date.now()-st.lastLeaseRenewedAt>=leaseSeconds*1000*0.8) throw new Error("SESSION_START_LEASE_EXPIRED");
      const sock = makeWASocket({
        version,
        auth: {
          creds: authState.creds,
          keys: authState.keys, // Never cache a Signal mutation before durable commit.
        },
        logger,
        printQRInTerminal: false,
        browser: Browsers.ubuntu("Chrome"),
        markOnlineOnConnect: false,
        syncFullHistory: false,
        // Retain Baileys v7 default initial LID mapping sync; full history stays off.
        // We do not use privacy/blocklist/business-profile init queries. They are
        // optional in Baileys and can time out/reconnect long-lived headless sockets.
        fireInitQueries: false,
        // Baileys calls this when a recipient sends a retry receipt (could not decrypt).
        // Returning undefined makes the recipient stay on "Waiting for this message".
        getMessage: async (key) => {
          try {
            const id = key?.id;
            if (!id) return undefined;
            const mem = getSentMessage(id);
            if (mem) return mem;
            const { data } = await supabase.from("wam_messages").select("text")
              .eq("business_id", businessId).eq("wa_message_id", id).eq("direction", "out").limit(1).maybeSingle();
            if (data?.text) return { conversation: data.text };
          } catch (_) {}
          return undefined;
        },
      });

      st.sock = sock;
      st.status = "connecting";
      st.startedAt = Date.now();

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

      sock.ev.on("creds.update", () => {
        if (sessions.get(businessId) !== st || st.sock !== sock) return;
        saveCreds().catch((err) => {
          if (err?.code === "AUTH_WRITE_LEASE_LOST") {
            logger.warn({ businessId }, "ignored stale creds.update after lease handoff");
            return;
          }
          logger.error({ code: err?.code, businessId }, "creds.update persistence failed");
          terminateForLeaseLoss(businessId,st,"auth_persistence_failed");
        });
      });

      sock.ev.on("connection.update", async (update) => {
        if (sessions.get(businessId) !== st || st.sock !== sock) {
          logger.debug?.({ businessId }, "ignored stale socket connection update");
          return;
        }

        if (shuttingDown) return;
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
          st.connectedAt = Date.now();
          if (reconnectAttempts.has(businessId)) watchdog?.incident("connection_recovered", businessId);
          clearStabilityTimer(st);
          clearReconnectTimer(businessId);
          await setStatus(businessId, "connected", {
            phone: sock.user?.id ? jidNormalizedUser(sock.user.id).split("@")[0] : null,
          });

          st.stabilityTimer = setTimeout(() => {
            if (
              sessions.get(businessId) === st &&
              st.sock === sock &&
              st.status === "connected"
            ) {
              reconnectAttempts.delete(businessId);
              logger.info({ businessId, stableMs: STABLE_CONNECTION_MS },
                "WhatsApp connection stable; reconnect backoff reset");
            }
            st.stabilityTimer = null;
          }, STABLE_CONNECTION_MS);
          st.stabilityTimer.unref?.();
        }

        if (connection === "close") {
          st.connecting = false;
          clearLeaseTimer(st);
          clearStabilityTimer(st);

          const statusCode = disconnectStatusCode(lastDisconnect);
          const loggedOut =
            statusCode === DisconnectReason.loggedOut || statusCode === 401;

          watchdog?.incident(loggedOut ? "session_logged_out" : `disconnect_${statusCode || "unknown"}`, businessId);
          if (loggedOut) {
            await setStatus(businessId, "disconnected");
            // Preserve credentials for inspection/recovery; never erase on a remote close.
            await releaseBusinessLease(businessId, st);
            if (sessions.get(businessId) === st) sessions.delete(businessId);
            reconnectAttempts.delete(businessId);
          } else {
            await setStatus(businessId, "reconnecting");
            const attempt = (reconnectAttempts.get(businessId) || 0) + 1;
            reconnectAttempts.set(businessId, attempt);
            const delay = reconnectDelayMs(statusCode, attempt);

            logger.warn({
              businessId,
              statusCode,
              attempt,
              delayMs: delay,
              fastTransient: FAST_TRANSIENT_DISCONNECT_CODES.has(statusCode),
            }, "WhatsApp socket closed; reconnect scheduled");

            // Release this exact session-generation lease before creating the
            // replacement socket. A new generation gets a new owner token, so
            // stale Signal writes from the old socket are fenced out in DB.
            await releaseBusinessLease(businessId, st);
            if (sessions.get(businessId) === st) sessions.delete(businessId);

            scheduleReconnect(businessId, delay);
          }
        }
      });

      sock.ev.on("messages.update", (updates) => {
        if(sessions.get(businessId)!==st || st.sock!==sock) return;
        for(const {key,update} of updates || []) {
          if(key?.fromMe && update?.status != null) watchdog?.receipt(businessId, key.id, update.status);
          if(key?.fromMe && update?.status != null) logger.info({businessId,messageId:key.id,status:update.status},"outbound delivery status");
        }
      });
      sock.ev.on("message-receipt.update", (updates) => {
        if(sessions.get(businessId)!==st || st.sock!==sock) return;
        for(const {key,receipt} of updates || []) {
          if(receipt?.receiptTimestamp || receipt?.readTimestamp) watchdog?.receipt(businessId,key?.id,3);
          logger.info({businessId,messageId:key?.id,delivered:!!receipt?.receiptTimestamp,read:!!receipt?.readTimestamp},"outbound receipt");
        }
      });
      sock.ev.on("messages.upsert", async (payload) => {
        if (sessions.get(businessId) !== st || st.sock !== sock || shuttingDown) return;
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
    clearReconnectTimer(businessId);
    clearLeaseTimer(st);
    clearStabilityTimer(st);
    reconnectAttempts.delete(businessId);
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
      throw new Error("RESUME_QUERY_FAILED");
    }

    const rows = data || [];
    let cursor = 0;

    async function resumeWorker() {
      while (true) {
        const index = cursor++;
        if (index >= rows.length) return;
        const row = rows[index];

        try {
          await startSession(row.business_id);
        } catch (e) {
          if (e?.code === "SESSION_OWNED_ELSEWHERE") {
            scheduleResumeRetry(row.business_id);
          } else {
            logger.error({ e, businessId: row.business_id }, "resumeAll: session failed");
            if(e?.code !== "WHATSAPP_NOT_AUTHORIZED") scheduleResumeRetry(row.business_id);
          }
        }

        // Avoid a restart thundering-herd against WhatsApp/Supabase when many
        // businesses are restored after a deploy or instance recycle.
        if (cursor < rows.length) {
          await new Promise((resolve) => setTimeout(resolve, RESUME_STAGGER_MS));
        }
      }
    }

    const workerCount = Math.min(RESUME_CONCURRENCY, rows.length);
    await Promise.all(Array.from({ length: workerCount }, () => resumeWorker()));
  }

  async function shutdownAll() {
    shuttingDown = true;
    await Promise.allSettled([...starting.values()]);
    for (const timer of resumeRetryTimers.values()) clearTimeout(timer);
    resumeRetryTimers.clear();
    for (const timer of reconnectTimers.values()) clearTimeout(timer);
    reconnectTimers.clear();
    const entries = [...sessions.entries()];
    for (const [businessId, st] of entries) {
      clearLeaseTimer(st);
      clearStabilityTimer(st);
      try { st.sock?.end?.(new Error("bridge shutdown")); } catch (_) {}
      await releaseBusinessLease(businessId, st);
    }
    sessions.clear();
  }

  return { getState, startSession, stopSession, resumeAll, shutdownAll, sessions, inspectSessions };
}
