-- Uses the existing Vault secret internally; never print its value.
select cron.schedule('gca-whatsapp-watchdog-probe-v1','* * * * *',$job$
select net.http_post(
  url:='https://wkpvlgfirechfeppfutg.supabase.co/functions/v1/wa-watchdog-probe',
  headers:=jsonb_build_object('Content-Type','application/json','x-bridge-secret',
    (select decrypted_secret from vault.decrypted_secrets where name='whatsapp_bridge_secret_v2')),
  body:='{}'::jsonb,timeout_milliseconds:=30000);
$job$);
-- Reversible removal of this monitor only:
-- select cron.unschedule('gca-whatsapp-watchdog-probe-v1');
