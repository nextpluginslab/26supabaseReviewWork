-- Additive migration; no changes to task/submission tables or existing policies.
begin;

create table public.api_keys (
  id uuid primary key default gen_random_uuid(),
  publisher_id uuid not null references auth.users(id) on delete cascade,
  name text not null check (length(btrim(name)) between 1 and 80),
  key_hash text not null unique check (key_hash ~ '^[0-9a-f]{64}$'),
  key_prefix text not null check (key_prefix ~ '^rwk_[0-9a-f]{8}$'),
  scopes text[] not null check (
    cardinality(scopes) between 1 and 5 and
    array_position(scopes, null) is null and
    scopes <@ array['tasks:read','tasks:write','submissions:read','insights:read','insights:write']::text[]
  ),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null check (expires_at > created_at),
  revoked_at timestamptz,
  last_used_at timestamptz
);
create index api_keys_publisher_created on public.api_keys (publisher_id, created_at);
alter table public.api_keys enable row level security;
-- Even authenticated owners cannot read hashes or bypass the management API.
revoke all on public.api_keys from public, anon, authenticated;
grant select, insert, update, delete on public.api_keys to service_role;

create function public.create_agent_api_key(
  p_publisher_id uuid, p_name text, p_key_hash text, p_key_prefix text,
  p_scopes text[], p_expires_at timestamptz
) returns public.api_keys
language plpgsql security invoker set search_path = '' as $$
declare result public.api_keys;
begin
  -- Serialize creation per account, including parallel Edge invocations.
  perform pg_advisory_xact_lock(hashtextextended(p_publisher_id::text, 731));
  if not exists (select 1 from auth.users where id = p_publisher_id
    and email_confirmed_at is not null and deleted_at is null
    and (banned_until is null or banned_until <= now()) and not is_anonymous) then
    raise exception 'invalid_publisher';
  end if;
  if (select count(*) from public.api_keys where publisher_id = p_publisher_id
      and created_at > now() - interval '24 hours') >= 100
    or (select count(*) from public.api_keys where publisher_id = p_publisher_id
      and revoked_at is null and expires_at > now()) >= 50 then
    raise exception 'key_limit';
  end if;
  if p_expires_at <= now() or p_expires_at > now() + interval '366 days' then
    raise exception 'invalid_expiration';
  end if;
  insert into public.api_keys(publisher_id,name,key_hash,key_prefix,scopes,expires_at)
    values(p_publisher_id,p_name,p_key_hash,p_key_prefix,p_scopes,p_expires_at)
    returning * into result;
  return result;
end;
$$;

create function public.authorize_agent_api_key(p_key_hash text, p_required_scopes text[])
returns table (key_id uuid, publisher_id uuid, scopes text[])
language plpgsql security invoker set search_path = '' as $$
declare candidate public.api_keys;
begin
  if p_required_scopes is null or cardinality(p_required_scopes) < 1
    or array_position(p_required_scopes,null) is not null
    or not p_required_scopes <@ array['tasks:read','tasks:write','submissions:read','insights:read','insights:write']::text[] then
    raise exception 'invalid_scopes';
  end if;
  select k.* into candidate from public.api_keys k
    join auth.users u on u.id = k.publisher_id
    where k.key_hash = p_key_hash and k.revoked_at is null and k.expires_at > now()
    and u.email_confirmed_at is not null and u.deleted_at is null
    and (u.banned_until is null or u.banned_until <= now()) and not u.is_anonymous
    for update of k;
  if not found then raise exception 'invalid_api_key'; end if;
  if not p_required_scopes <@ candidate.scopes then raise exception 'insufficient_scope'; end if;
  if candidate.last_used_at is null or candidate.last_used_at < now() - interval '5 minutes' then
    update public.api_keys k set last_used_at = now() where k.id = candidate.id;
  end if;
  return query select candidate.id, candidate.publisher_id, candidate.scopes;
end;
$$;

revoke all on function public.create_agent_api_key(uuid,text,text,text,text[],timestamptz) from public, anon, authenticated;
revoke all on function public.authorize_agent_api_key(text,text[]) from public, anon, authenticated;
grant execute on function public.create_agent_api_key(uuid,text,text,text,text[],timestamptz) to service_role;
grant execute on function public.authorize_agent_api_key(text,text[]) to service_role;
notify pgrst, 'reload schema';
commit;
