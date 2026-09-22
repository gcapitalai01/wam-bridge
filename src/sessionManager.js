// One Baileys socket per business_id. In-memory registry (single process).
// Auth persisted in Supabase so a redeploy/restart never loses a linked session.
import makeWASocket, { DisconnectReason, fetchLatestBaileysVersion, jidNormalizedUser } from "@whiskeysockets/baileys";
import QRCode from "qrcode";
import { useSupabaseAuthState } from "./authState.js";

export function createSessionManager({ supabase, logger, onMessages, onClientStatus, canConnect }) {
  const sessions = new Map();
  const reconnectAttempts = new Map();

  function getState(businessId) {
    if (!sessions.has(businessId)) sessions.set(businessId, { sock: null, qr: null, pairingCode: null, status: "disconnected", phone: null, connecting: false });
    return sessions.get(businessId);
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
        throw Object.assign(new Error(reason), { code: "WHATSAPP_NOT_AUTHORIZED", accessReason: reason });
      }
    }

    const st = getState(businessId);
    if (st.connecting || (st.sock && st.status === "connected")) return st;
    st.connecting = true;

    const { state: authState, saveCreds, clearAll } = await useSupabaseAuthState(supabase, businessId);
    const { version } = await fetchLatestBaileysVersion();
    const sock = makeWASocket({ version, auth: authState, logger, printQRInTerminal: false, browser: ["G Capital AI", "Chrome", "1.0"], markOnlineOnConnect: false });
    st.sock = sock;
    st.status = "connecting";

    if (phoneNumberForPairing && !authState.creds.registered) {
      try {
        st.pairingCode = await sock.requestPairingCode(phoneNumberForPairing.replace(/[^0-9]/g, ""));
        st.status = "pairing_pending";
        await setStatus(businessId, "pairing_pending");
      } catch (err) { logger.error({ err }, "requestPairingCode failed — falling back to QR"); }
    }

    sock.ev.on("creds.update", saveCreds);

    sock.ev.on("connection.update", async (update) => {
      const { connection, lastDisconnect, qr } = update;
      if (qr) {
        st.qr = await QRCode.toDataURL(qr);
        if (st.status !== "pairing_pending" && !st.pairingCode) await setStatus(businessId, "qr_pending");
      }
      if (connection === "open") {
        st.qr = null; st.pairingCode = null; st.connecting = false;
        reconnectAttempts.delete(businessId);
        await setStatus(businessId, "connected", { phone: sock.user?.id ? jidNormalizedUser(sock.user.id).split("@")[0] : null });
      }
      if (connection === "close") {
        st.connecting = false;
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        const loggedOut = statusCode === DisconnectReason.loggedOut || statusCode === 401;
        if (loggedOut) {
          await setStatus(businessId, "disconnected");
          await clearAll();
          sessions.delete(businessId);
          reconnectAttempts.delete(businessId);
        } else {
          await setStatus(businessId, "reconnecting");
          const attempt = (reconnectAttempts.get(businessId) || 0) + 1;
          reconnectAttempts.set(businessId, attempt);
          const delay = Math.min(3000 * Math.pow(2, attempt - 1), 60000);
          sessions.delete(businessId);
          setTimeout(() => startSession(businessId).catch((e) => logger.error({ e }, "reconnect failed")), delay).unref?.();
        }
      }
    });

    sock.ev.on("messages.upsert", async (payload) => {
      try { await onMessages?.(businessId, sock, payload); }
      catch (err) { logger.error({ err }, "onMessages handler failed"); }
    });

    return st;
  }

  async function stopSession(businessId) {
    const st = getState(businessId);
    if (st.sock) { try { await st.sock.logout(); } catch (_) {} }
    sessions.delete(businessId);
    await setStatus(businessId, "disconnected");
  }

  async function resumeAll() {
    const { data, error } = await supabase.from("wam_clients").select("business_id, status")
      .in("status", ["connected", "connecting", "reconnecting", "pairing_pending", "qr_pending"]);
    if (error) { logger.error({ error }, "resumeAll query failed"); return; }
    for (const row of data || []) startSession(row.business_id).catch((e) => logger.error({ e, businessId: row.business_id }, "resumeAll: session failed"));
  }

  return { getState, startSession, stopSession, resumeAll, sessions };
}
