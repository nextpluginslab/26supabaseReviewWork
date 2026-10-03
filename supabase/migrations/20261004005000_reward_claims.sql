-- Durable delivery of passwordless reward links. Auth owns token generation,
-- expiration and single-use verification; no payment capability is made public.
create table public.reward_claim_emails (
  reward_id uuid primary key references public.payment_rewards(id),
  sent_at timestamptz,
  attempts integer not null default 0,
  next_run_at timestamptz not null default now(),
  lease_id uuid,
  lease_until timestamptz,
  last_error text
);
alter table public.reward_claim_emails enable row level security;
revoke all on public.reward_claim_emails from public, anon, authenticated;

create function public.queue_reward_claim_email() returns trigger
language plpgsql security definer set search_path='' as $$
begin
  if new.amount_minor > 0 then
    insert into public.reward_claim_emails(reward_id) values(new.id) on conflict do nothing;
  end if;
  return new;
end $$;
revoke all on function public.queue_reward_claim_email() from public,anon,authenticated;
create trigger reward_claim_email after insert on public.payment_rewards
for each row execute function public.queue_reward_claim_email();
-- Existing unpaid rewards can also be claimed through email after deployment.
insert into public.reward_claim_emails(reward_id)
select id from public.payment_rewards where amount_minor>0 and state<>'paid'
on conflict do nothing;

create function public.reward_claim_command(p_action text, p_actor uuid, p_data jsonb default '{}')
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare
  e reward_claim_emails;
  r payment_rewards;
begin
  if p_action='reward' then
    select * into r from payment_rewards where id=(p_data->>'id')::uuid and tester_id=p_actor;
    if not found then raise no_data_found using message='Reward not found for this recipient'; end if;
    return jsonb_build_object('id',r.id,'amount_minor',r.amount_minor,'state',r.state,'currency','usd');
  elsif p_action='claim_email' then
    select * into e from reward_claim_emails where sent_at is null and attempts<8
      and next_run_at<=now() and (lease_until is null or lease_until<now())
      order by next_run_at for update skip locked limit 1;
    if not found then return 'null'::jsonb; end if;
    update reward_claim_emails set lease_id=gen_random_uuid(),lease_until=now()+interval '2 minutes',attempts=attempts+1
      where reward_id=e.reward_id returning * into e;
    select * into strict r from payment_rewards where id=e.reward_id;
    return to_jsonb(e)||jsonb_build_object('tester_id',r.tester_id);
  elsif p_action in ('email_sent','email_failed') then
    update reward_claim_emails set
      sent_at=case when p_action='email_sent' then now() else sent_at end,
      last_error=case when p_action='email_failed' then 'email_delivery_failed' else null end,
      next_run_at=now()+interval '5 minutes',lease_until=null,lease_id=null
      where reward_id=(p_data->>'id')::uuid and lease_id=(p_data->>'lease_id')::uuid and sent_at is null;
    return '{}'::jsonb;
  else raise exception 'Unknown reward claim command'; end if;
end $$;
revoke all on function public.reward_claim_command(text,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.reward_claim_command(text,uuid,jsonb) to service_role;
