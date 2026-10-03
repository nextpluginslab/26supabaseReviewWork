-- A manually shared link grants access only to one accepted reward, never an
-- Auth session. Store only its SHA-256 digest; issuers are task owners.
create table public.reward_access_links (
  reward_id uuid primary key references public.payment_rewards(id),
  token_hash text not null check(token_hash ~ '^[a-f0-9]{64}$'),
  expires_at timestamptz not null
);
alter table public.reward_access_links enable row level security;
revoke all on public.reward_access_links from public,anon,authenticated;
create function public.reward_link_command(p_action text,p_actor uuid,p_data jsonb)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare r payment_rewards; expiry timestamptz;
begin
  select * into r from payment_rewards where id=(p_data->>'id')::uuid;
  if not found then raise no_data_found; end if;
  if p_action='issue' then
    if p_actor is null or not exists(select 1 from payment_task_accounts where task_id=r.task_id and publisher_id=p_actor) then
      raise insufficient_privilege;
    end if;
    if r.amount_minor=0 or r.state in ('paid','not_required') then raise exception 'Reward does not require claiming'; end if;
    expiry:=now()+interval '7 days';
    insert into reward_access_links(reward_id,token_hash,expires_at) values(r.id,p_data->>'token_hash',expiry)
      on conflict(reward_id) do update set token_hash=excluded.token_hash,expires_at=excluded.expires_at;
    return jsonb_build_object('expires_at',expiry);
  elsif p_action='resolve' then
    if not exists(select 1 from reward_access_links where reward_id=r.id and token_hash=p_data->>'token_hash' and expires_at>now()) then
      raise insufficient_privilege;
    end if;
    return jsonb_build_object('id',r.id,'tester_id',r.tester_id,'amount_minor',r.amount_minor,'currency','usd','state',r.state);
  end if;
  raise exception 'Invalid link operation';
end $$;
revoke all on function public.reward_link_command(text,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.reward_link_command(text,uuid,jsonb) to service_role;
notify pgrst,'reload schema';
