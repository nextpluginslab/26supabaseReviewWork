-- Keep payment processing and reward email delivery running after requests end.
create or replace function public.payment_configure_worker(p_url text, p_token text)
returns void language plpgsql security definer set search_path=public,pg_temp as $$
declare sid uuid;
begin
  if p_url !~ '^https://[a-z0-9]+\.supabase\.co/functions/v1/payment-worker$'
    or p_url is null or p_token is null or length(p_token)<32 then
    raise exception 'invalid_worker_config';
  end if;
  select id into sid from vault.secrets where name='reviewwork_payment_worker_url';
  if found then perform vault.update_secret(sid,p_url);
  else perform vault.create_secret(p_url,'reviewwork_payment_worker_url'); end if;
  select id into sid from vault.secrets where name='reviewwork_payment_worker_token';
  if found then perform vault.update_secret(sid,p_token);
  else perform vault.create_secret(p_token,'reviewwork_payment_worker_token'); end if;
end $$;

create or replace function public.payment_wake_worker()
returns void language plpgsql security definer set search_path=public,pg_temp as $$
declare endpoint text; token text;
begin
  if not (exists(select 1 from payment_rewards
      where state in ('pending','processing','unknown') and next_run_at<=now()
      and (lease_until is null or lease_until<now()))
    or exists(select 1 from reward_claim_emails
      where sent_at is null and attempts<8 and next_run_at<=now()
      and (lease_until is null or lease_until<now()))) then return; end if;
  select decrypted_secret into endpoint from vault.decrypted_secrets
    where name='reviewwork_payment_worker_url';
  select decrypted_secret into token from vault.decrypted_secrets
    where name='reviewwork_payment_worker_token';
  if endpoint is null or token is null then return; end if;
  perform net.http_post(url:=endpoint,
    headers:=jsonb_build_object('Content-Type','application/json','Authorization','Bearer '||token),
    body:='{}'::jsonb,timeout_milliseconds:=60000);
end $$;

create or replace function public.payment_notify_reward()
returns trigger language plpgsql security definer set search_path=public,pg_temp as $$
begin
  perform public.payment_wake_worker();
  return new;
exception when others then
  -- The durable queue and minute cron recover a failed immediate wake.
  return new;
end $$;
create trigger payment_reward_wake after insert on public.payment_rewards
for each row execute function public.payment_notify_reward();

revoke all on function public.payment_configure_worker(text,text) from public,anon,authenticated;
revoke all on function public.payment_wake_worker() from public,anon,authenticated;
revoke all on function public.payment_notify_reward() from public,anon,authenticated;
grant execute on function public.payment_configure_worker(text,text) to service_role;
grant execute on function public.payment_wake_worker() to service_role;
select cron.schedule('reviewwork-payment-worker','* * * * *','select public.payment_wake_worker();');
notify pgrst,'reload schema';
