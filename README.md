# G Capital AI — WhatsApp QR Bridge

Tentaculo de WhatsApp via QR (Baileys), reenvia todo a chat-ai (el cerebro).

## Deploy en Render
1. Sube este folder a un repo GitHub nuevo.
2. Render → New Web Service → conecta el repo.
3. Build command: `npm install` | Start command: `npm start`
4. Env vars: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, BRIDGE_API_KEY (inventa una clave larga)
5. Corre `migration.sql` en Supabase (SQL editor) antes del primer deploy.

## Uso desde el dashboard
- POST /session/{business_id}/start  -> arranca sesion, genera QR
- GET  /session/{business_id}/qr     -> {status, qr: "data:image/png;base64,..."} para mostrar en <img>
- GET  /session/{business_id}/status -> {status}
- POST /session/{business_id}/stop   -> logout

Todas las rutas (excepto /health) requieren header `x-bridge-key: <BRIDGE_API_KEY>`.

## IMPORTANTE — pendiente de verificar
El payload que se manda a chat-ai (`{business_id, channel:'whatsapp', external_id, customer_name, message}`)
y la respuesta esperada (`{reply}`) estan basados en el patron de facebook-webhook, pero no se verificaron
linea por linea contra chat-ai.ts en esta sesion (sin acceso MCP a Supabase). Antes de usar con cliente real:
confirmar el contrato exacto de chat-ai y ajustar `forwardToBrain()` en src/sessions.js si difiere.
