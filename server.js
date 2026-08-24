import express from 'express';
import { createClient } from '@supabase/supabase-js';
import { startSession, getSession, stopSession } from './sessions.js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const BRIDGE_API_KEY = process.env.BRIDGE_API_KEY; // shared secret so only the dashboard can call this

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY env vars');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
const app = express();
app.use(express.json());
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type, x-bridge-key');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

function requireAuth(req, res, next) {
  if (!BRIDGE_API_KEY) return next(); // no key configured yet — open (set BRIDGE_API_KEY in Render ASAP)
  const key = req.headers['x-bridge-key'];
  if (key !== BRIDGE_API_KEY) return res.status(401).json({ error: 'unauthorized' });
  next();
}

app.get('/health', (req, res) => res.json({ ok: true }));

app.post('/session/:businessId/start', requireAuth, async (req, res) => {
  const { businessId } = req.params;
  const { phoneNumber } = req.body || {};
  try {
    const entry = await startSession({
      supabase,
      supabaseUrl: SUPABASE_URL,
      serviceKey: SUPABASE_SERVICE_ROLE_KEY,
      businessId,
      phoneNumber, // optional — if given, pairing code is requested; otherwise QR fallback applies
    });
    res.json({
      ok: true,
      status: entry?.status || 'starting',
      pairingCode: entry?.pairingCode || null,
      method: entry?.pairingCode ? 'pairing_code' : 'qr',
    });
  } catch (err) {
    res.status(500).json({ error: String(err.message || err) });
  }
});

// Explicit pairing-code request/refresh (e.g. dashboard "Send me a code" button, or code expired ~60s)
app.post('/session/:businessId/pairing-code', requireAuth, async (req, res) => {
  const { businessId } = req.params;
  const { phoneNumber } = req.body || {};
  if (!phoneNumber) return res.status(400).json({ error: 'phoneNumber is required' });
  try {
    const entry = await startSession({
      supabase,
      supabaseUrl: SUPABASE_URL,
      serviceKey: SUPABASE_SERVICE_ROLE_KEY,
      businessId,
      phoneNumber,
    });
    if (!entry?.pairingCode) {
      return res.status(409).json({ error: 'Could not generate a pairing code — already connected, or falling back to QR.' });
    }
    res.json({ ok: true, pairingCode: entry.pairingCode, status: entry.status });
  } catch (err) {
    res.status(500).json({ error: String(err.message || err) });
  }
});

app.get('/session/:businessId/qr', requireAuth, (req, res) => {
  const entry = getSession(req.params.businessId);
  if (!entry) return res.status(404).json({ error: 'session_not_started' });
  if (!entry.qr) return res.json({ status: entry.status, qr: null });
  res.json({ status: entry.status, qr: entry.qr }); // data URL, dashboard can render directly in <img src=...>
});

app.get('/session/:businessId/status', requireAuth, (req, res) => {
  const entry = getSession(req.params.businessId);
  res.json({
    status: entry?.status || 'not_started',
    pairingCode: entry?.pairingCode || null,
    hasQr: !!entry?.qr,
  });
});

app.post('/session/:businessId/stop', requireAuth, async (req, res) => {
  try {
    await stopSession({ supabase, businessId: req.params.businessId });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: String(err.message || err) });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`WhatsApp QR bridge listening on :${PORT}`));
