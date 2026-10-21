-- Additive, invoker-rights API: a Signal key batch commits under one locked lease.
CREATE OR REPLACE FUNCTION public.wa_auth_write_batch_if_owner(p_business uuid,p_owner_instance text,p_entries jsonb)
RETURNS boolean LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE v_owner text; v_until timestamptz; e jsonb;
BEGIN
 SELECT bridge_owner_instance,bridge_lease_until INTO v_owner,v_until
 FROM public.wam_clients WHERE business_id=p_business FOR UPDATE;
 IF v_owner IS DISTINCT FROM p_owner_instance OR v_until IS NULL OR v_until<=clock_timestamp() THEN RETURN false; END IF;
 IF jsonb_typeof(p_entries) IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'invalid auth batch'; END IF;
 FOR e IN SELECT value FROM jsonb_array_elements(p_entries) LOOP
  IF coalesce(e->>'key','')='' THEN RAISE EXCEPTION 'invalid auth key'; END IF;
  IF coalesce((e->>'delete')::boolean,false) THEN
   DELETE FROM public.wam_auth_state WHERE business_id=p_business AND data_key=e->>'key';
  ELSE
   INSERT INTO public.wam_auth_state(business_id,data_key,value,updated_at)
   VALUES(p_business,e->>'key',e->'value',clock_timestamp())
   ON CONFLICT(business_id,data_key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at;
  END IF;
 END LOOP;
 RETURN true;
END $$;
REVOKE ALL ON FUNCTION public.wa_auth_write_batch_if_owner(uuid,text,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.wa_auth_write_batch_if_owner(uuid,text,jsonb) TO service_role;
