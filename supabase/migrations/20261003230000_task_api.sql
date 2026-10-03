-- All task writes go through a service-only transactional function. No direct client table access.
create table public.tasks (
  id uuid primary key default gen_random_uuid(),
  publisher_id uuid not null references auth.users(id) on delete cascade,
  public_slug text not null unique default encode(extensions.gen_random_bytes(16), 'hex'),
  status text not null default 'draft' check (status in ('draft','published','closed')),
  config jsonb not null check (jsonb_typeof(config) = 'object'),
  published_config jsonb,
  question_registry jsonb not null default '{}',
  version integer not null default 1,
  deadline_at timestamptz,
  published_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index tasks_owner_cursor on public.tasks(publisher_id, id);
alter table public.tasks enable row level security;
revoke all on public.tasks from anon, authenticated;
grant all on public.tasks to service_role;
create table public.task_api_requests (
  principal_id uuid not null references auth.users(id) on delete cascade,
  route text not null,
  key text not null,
  request_hash text not null,
  response jsonb not null,
  created_at timestamptz not null default now(),
  primary key(principal_id, route, key)
);
alter table public.task_api_requests enable row level security;
revoke all on public.task_api_requests from anon, authenticated;
grant all on public.task_api_requests to service_role;

create function public.mutate_task(p_actor uuid, p_action text, p_task uuid, p_config jsonb, p_version integer, p_key text, p_hash text)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  t public.tasks; cached public.task_api_requests; result jsonb;
  route_key text := p_action || ':' || coalesce(p_task::text, 'new');
  q jsonb; o jsonb; old_q jsonb; old_o jsonb; mapped jsonb := '[]'; opts jsonb;
  registry jsonb; qid text; oid text; option_path text;
begin
  if p_actor is null or p_key is null or length(p_key) not between 1 and 128 then raise exception 'invalid_request'; end if;
  perform pg_advisory_xact_lock(hashtextextended(p_actor::text || ':' || route_key || ':' || p_key, 0));
  select * into cached from task_api_requests where principal_id=p_actor and route=route_key and key=p_key;
  if found then
    if cached.request_hash <> p_hash then raise exception 'idempotency_conflict'; end if;
    return cached.response;
  end if;
  perform pg_advisory_xact_lock(hashtextextended(p_actor::text, 1));
  if (select count(*) from task_api_requests where principal_id=p_actor and created_at > now()-interval '1 minute') >= 60 then raise exception 'rate_limited'; end if;
  if p_action <> 'create' then
    select * into t from tasks where id=p_task and publisher_id=p_actor for update;
    if not found then raise exception 'task_not_found'; end if;
    if p_version is null or t.version <> p_version then raise exception 'version_conflict'; end if;
  end if;
  if p_action in ('create','update') then
    if p_action='update' and t.status <> 'draft' then raise exception 'task_immutable'; end if;
    registry := coalesce(t.question_registry, '{}');
    for q in select value from jsonb_array_elements(p_config->'questions') loop
      select value into old_q from jsonb_array_elements(coalesce(t.config->'questions','[]')) where value->>'question_key'=q->>'question_key';
      if old_q is null and registry ? (q->>'question_key') then raise exception 'retired_question_key'; end if;
      qid := coalesce(old_q->>'id', gen_random_uuid()::text);
      registry := registry || jsonb_build_object(q->>'question_key', qid);
      opts := '[]';
      for o in select value from jsonb_array_elements(q->'options') loop
        select value into old_o from jsonb_array_elements(coalesce(old_q->'options','[]')) where value->>'option_key'=o->>'option_key';
        option_path := (q->>'question_key') || '/' || (o->>'option_key');
        if old_o is null and registry ? option_path then raise exception 'retired_option_key'; end if;
        oid := coalesce(old_o->>'id', gen_random_uuid()::text);
        registry := registry || jsonb_build_object(option_path, oid);
        opts := opts || jsonb_build_array(o || jsonb_build_object('id',oid));
      end loop;
      mapped := mapped || jsonb_build_array(q || jsonb_build_object('id',qid,'options',opts));
    end loop;
    p_config := jsonb_set(p_config,'{questions}',mapped);
    if p_action='create' then
      insert into tasks(publisher_id,config,question_registry) values(p_actor,p_config,registry) returning * into t;
    else
      update tasks set config=p_config,question_registry=registry,version=version+1,updated_at=now() where id=p_task returning * into t;
    end if;
  elsif p_action='publish' then
    if t.status <> 'draft' then raise exception 'invalid_state'; end if;
    -- Payment integration must establish trusted funding before paid publishing is enabled.
    if (t.config->>'reward_amount_minor')::bigint > 0 then raise exception 'funding_required'; end if;
    t.deadline_at := case when t.config ? 'duration_seconds' then now()+make_interval(secs => (t.config->>'duration_seconds')::integer) else (t.config->>'deadline_at')::timestamptz end;
    if t.deadline_at <= now() then raise exception 'deadline_expired'; end if;
    update tasks set status='published',published_config=config,deadline_at=t.deadline_at,published_at=now(),version=version+1,updated_at=now() where id=p_task returning * into t;
  elsif p_action='close' then
    if t.status <> 'published' then raise exception 'invalid_state'; end if;
    update tasks set status='closed',version=version+1,updated_at=now() where id=p_task returning * into t;
  else raise exception 'invalid_action';
  end if;
  result := to_jsonb(t) - 'question_registry';
  insert into task_api_requests(principal_id,route,key,request_hash,response) values(p_actor,route_key,p_key,p_hash,result);
  return result;
end $$;
revoke all on function public.mutate_task(uuid,text,uuid,jsonb,integer,text,text) from public, anon, authenticated;
grant execute on function public.mutate_task(uuid,text,uuid,jsonb,integer,text,text) to service_role;
