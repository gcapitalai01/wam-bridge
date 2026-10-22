# WhatsApp watchdog

Local inspection every 1000 ms; no database query every second. Existing lease fencing and Signal persistence are unchanged. No logout, clearAll or credential resets in recovery.

Automatic reconnects: six attempts per business in five minutes; then a 15-minute cooldown. One existing start promise and one timer per business. 401/logout and authorization failures require operator intervention. Bad MAC/decryption failures alert; Baileys performs its existing protocol retries without forced key resets or unnecessary socket restarts. Connecting sockets exceeding 90 seconds and sockets reporting closed without a close event are fenced off and recovered via the existing lease path.

AI calls have a 45-second timeout. Recovery sweep processes only locally connected tenants. No changes to Brain V2. Send uncertainty and missing delivery receipts after 120 seconds alert and never cause a blind resend. Receipt status 2 is server acknowledgement; only status >=3 is delivery. Counters and rolling p95 latency are process-local, reset on restart, and visible only at the bridge-key protected GET /ops/watchdog. GET /healthz exposes only release and tick count, not client status.

Alerts: wa-watchdog-alert authenticates the existing bridge secret and logs in admin_error_log. Sender sends to the fixed owner alexusa0110@gmail.com. Deduplication is 15 minutes per event, mail capped at 10/hour; all accepted nonsuppressed events log independently. Bridge retries failed alert requests at most three times. Provider acceptance is not inbox delivery. The first startup event verifies this path. This is not an independent monitor for a fully dead process; Render's service health checks remain responsible for process failures.

Validation: npm ci; npm test. Existing postinstall compatibility patch must run. Tests never send customer messages. Real end-to-end WhatsApp validation requires a message from the owner's test phone and its actual delivery receipt; mocked tests do not prove that path.

Rollback: previous live commit 2aabbbabcce0d2a22610b64b226764027754296e, Render deploy dep-dbckob5g1s2s7385p2tg. Redeploy that exact commit or use Render rollback after confirming current deployment. This change has no schema migration, auth deletion or Brain V2 replacement. The added alert Edge Function may remain dormant after bridge rollback. Avoid overlapping manual deploys. Changes to credentials or infrastructure are not automatic recovery actions.

## Independent synthetic monitor

Supabase cron job 59, gca-whatsapp-watchdog-probe-v1, runs every minute. It invokes the authenticated wa-watchdog-probe function using the existing Vault secret by reference. The probe reads the protected watchdog heartbeat and the 646 session status, logs a safe snapshot to admin_error_log, and emails the fixed owner when unavailable. It does not send WhatsApp messages or invoke Brain V2. Sender delivery to the owner's Gmail inbox was verified on 2026-10-22 at 04:01 UTC. Disable this job only with cron.unschedule as documented in watchdog-cron.sql.

## Deployment validation

Bridge release: 3d528a12adab85eac90d514a15e8de1613e9db1d. Tests: 103 passed, including 100 simulated lease-contention waits that do not consume the recovery budget. Old-deploy ownership waits retain backoff but no longer open the failure circuit. The previous live instance can retain its lease during Render's drain window; this is expected fencing, and must never be bypassed by deleting auth or stealing an unexpired lease. Successful synthetic probes are infrastructure/session checks, not proof of a real customer -> Brain V2 -> delivery transaction. A fresh owner-phone inbound test is still needed for that final validation.
