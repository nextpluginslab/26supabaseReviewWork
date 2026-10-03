-- Depends on the deployed task_api migration. Published task JSON is authoritative.
create table public.submissions (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null references public.tasks(id),
  tester_id uuid not null references auth.users(id),
  submission_no text not null unique default ('FW-' || replace(gen_random_uuid()::text, '-', '')),
  processing_status text not null default 'awaiting_publisher' check (processing_status in ('awaiting_publisher','changes_requested','accepted','declined')),
  payment_status text not null default 'awaiting_confirmation' check (payment_status in ('awaiting_confirmation','not_required','not_payable')),
  current_revision_id uuid,
  version integer not null default 1,
  first_submitted_at timestamptz not null default now(),
  awaiting_publisher_since timestamptz not null default now(),
  unique(task_id,tester_id)
);
create table public.submission_revisions (
  id uuid primary key default gen_random_uuid(),
  submission_id uuid not null references public.submissions(id),
  revision_no integer not null,
  operation_notes text not null,
  answers jsonb not null check (jsonb_typeof(answers)='array'),
  evidence_ids uuid[] not null,
  submitted_at timestamptz not null default now(),
  unique(submission_id,revision_no), unique(submission_id,id)
);
alter table public.submissions add constraint current_revision_ownership foreign key(id,current_revision_id) references public.submission_revisions(submission_id,id) deferrable initially deferred;
create table public.submission_evidence (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null references public.tasks(id),
  uploader_id uuid not null references auth.users(id),
  object_path text not null unique,
  name text not null,
  mime_type text not null check (mime_type in ('image/png','image/jpeg','image/webp','video/mp4','video/quicktime','video/webm')),
  size_bytes bigint not null check(size_bytes > 0 and size_bytes <= 52428800),
  created_at timestamptz not null default now()
);
create table public.submission_decisions (
  id uuid primary key default gen_random_uuid(),
  submission_id uuid not null references public.submissions(id),
  revision_id uuid not null,
  publisher_id uuid not null references auth.users(id),
  action text not null check(action in ('accept','request_changes','decline')),
  reason text not null,
  created_at timestamptz not null default now(),
  foreign key(submission_id,revision_id) references public.submission_revisions(submission_id,id)
);
create table public.submission_jobs (
  id uuid primary key default gen_random_uuid(),
  revision_id uuid not null unique references public.submission_revisions(id),
  status text not null default 'queued' check(status in ('queued','running','succeeded','failed')),
  summary jsonb,
  created_at timestamptz not null default now()
);
create table public.submission_api_requests (
  principal_id uuid not null references auth.users(id),
  route text not null, key text not null, request_hash text not null, response jsonb not null,
  created_at timestamptz not null default now(), primary key(principal_id,route,key)
);
create index submissions_task_cursor on public.submissions(task_id,id);
create index submissions_tester_cursor on public.submissions(tester_id,id);
create index submission_evidence_owner on public.submission_evidence(uploader_id,task_id);
create index submission_requests_rate on public.submission_api_requests(principal_id,created_at);
do $$ declare tbl text; begin
  foreach tbl in array array['submissions','submission_revisions','submission_evidence','submission_decisions','submission_jobs','submission_api_requests'] loop
    execute format('alter table public.%I enable row level security',tbl);
    execute format('revoke all on public.%I from anon, authenticated',tbl);
    execute format('grant all on public.%I to service_role',tbl);
  end loop;
end $$;
-- Dedicated immutable upload bucket: no client INSERT/UPDATE/DELETE policies.
insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
values('submission-evidence','submission-evidence',false,52428800,array['image/png','image/jpeg','image/webp','video/mp4','video/quicktime','video/webm']);

create function public.mutate_submission(p_actor uuid,p_action text,p_target uuid,p_body jsonb,p_key text,p_hash text)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare
  t public.tasks; s public.submissions; cached public.submission_api_requests;
  route_key text := p_action || ':' || p_target::text; result jsonb; rid uuid; eid uuid;
  q jsonb; a jsonb; ids uuid[]; e public.submission_evidence; act text; why text;
begin
  if p_actor is null or p_key is null or length(p_key) not between 1 and 128 or p_hash is null then raise exception 'invalid_request'; end if;
  if not exists(select 1 from auth.users where id=p_actor and email_confirmed_at is not null and coalesce(is_anonymous,false)=false) then raise exception 'email_not_verified'; end if;
  perform pg_advisory_xact_lock(hashtextextended(p_actor::text || ':' || route_key || ':' || p_key, 2));
  select * into cached from submission_api_requests where principal_id=p_actor and route=route_key and key=p_key;
  if found then
    if cached.request_hash <> p_hash then raise exception 'idempotency_conflict'; end if;
    return cached.response;
  end if;
  perform pg_advisory_xact_lock(hashtextextended(p_actor::text,3));
  if (select count(*) from submission_api_requests where principal_id=p_actor and created_at>now()-interval '1 minute') >= 60 then raise exception 'rate_limited'; end if;
  if p_action in ('submit','upload') then
    select * into t from tasks where id=p_target and published_config is not null for share;
    if not found then raise exception 'task_not_found'; end if;
    if p_action='submit' and (t.status<>'published' or t.deadline_at<=now()) then raise exception 'task_closed'; end if;
    if p_action='upload' and (t.status<>'published' or t.deadline_at<=now()) and not exists(select 1 from submissions where task_id=t.id and tester_id=p_actor and processing_status='changes_requested') then raise exception 'task_closed'; end if;
  else
    select ss.* into s from submissions ss join tasks tt on tt.id=ss.task_id where ss.id=p_target and (ss.tester_id=p_actor or tt.publisher_id=p_actor) for update of ss;
    if not found then raise exception 'submission_not_found'; end if;
    select * into t from tasks where id=s.task_id for share;
    if p_body->>'expected_revision_id' is distinct from s.current_revision_id::text or (p_body->>'expected_version')::integer is distinct from s.version then raise exception 'version_conflict'; end if;
  end if;
  if p_action='upload' then
    if not ((t.published_config->'evidence_types') ? split_part(p_body->>'mime_type','/',1)) then raise exception 'invalid_evidence'; end if;
    if (select count(*) from submission_evidence where task_id=t.id and uploader_id=p_actor) >= 100 then raise exception 'upload_quota_exceeded'; end if;
    eid:=gen_random_uuid();
    insert into submission_evidence(id,task_id,uploader_id,object_path,name,mime_type,size_bytes)
    values(eid,t.id,p_actor,t.id::text || '/' || p_actor::text || '/' || eid::text,p_body->>'name',p_body->>'mime_type',(p_body->>'size_bytes')::bigint) returning to_jsonb(submission_evidence.*) into result;
  elsif p_action in ('submit','revise') then
    if p_action='revise' and (s.tester_id<>p_actor or s.processing_status<>'changes_requested') then raise exception 'invalid_state'; end if;
    if p_action='submit' and exists(select 1 from submissions where task_id=t.id and tester_id=p_actor) then raise exception 'already_submitted'; end if;
    if jsonb_typeof(p_body->'answers') is distinct from 'array' or jsonb_array_length(p_body->'answers')<>jsonb_array_length(t.published_config->'questions') then raise exception 'invalid_answers'; end if;
    for q in select value from jsonb_array_elements(t.published_config->'questions') loop
      if (select count(*) from jsonb_array_elements(p_body->'answers') where value->>'question_key'=q->>'question_key')<>1 then raise exception 'invalid_answers'; end if;
      select value into a from jsonb_array_elements(p_body->'answers') where value->>'question_key'=q->>'question_key';
      if jsonb_typeof(a->'reason') is distinct from 'string' or length(btrim(a->>'reason')) not between 1 and 10000 or not exists(select 1 from jsonb_array_elements(q->'options') where value->>'option_key'=a->>'selected_option_key') then raise exception 'invalid_answers'; end if;
    end loop;
    select array_agg(value::uuid) into ids from jsonb_array_elements_text(p_body->'evidence_ids');
    if coalesce(cardinality(ids),0) not between 1 and 10 or cardinality(ids)<>(select count(distinct x) from unnest(ids) x) then raise exception 'invalid_evidence'; end if;
    foreach eid in array ids loop
      select * into e from submission_evidence where id=eid and task_id=t.id and uploader_id=p_actor;
      if not found or not exists(select 1 from storage.objects where bucket_id='submission-evidence' and name=e.object_path and (metadata->>'size')::bigint=e.size_bytes and metadata->>'mimetype'=e.mime_type) then raise exception 'invalid_evidence'; end if;
    end loop;
    if p_action='submit' then insert into submissions(task_id,tester_id) values(t.id,p_actor) returning * into s; end if;
    insert into submission_revisions(submission_id,revision_no,operation_notes,answers,evidence_ids)
    values(s.id,(select count(*)+1 from submission_revisions where submission_id=s.id),coalesce(p_body->>'operation_notes',''),p_body->'answers',ids) returning id into rid;
    update submissions set current_revision_id=rid,processing_status='awaiting_publisher',payment_status='awaiting_confirmation',version=case when p_action='submit' then version else version+1 end,awaiting_publisher_since=now() where id=s.id returning * into s;
    insert into submission_jobs(revision_id) values(rid);
    result:=to_jsonb(s) || jsonb_build_object('ai_status','queued');
  elsif p_action='decide' then
    if t.publisher_id<>p_actor then raise exception 'forbidden'; end if;
    if s.processing_status not in ('awaiting_publisher','changes_requested') then raise exception 'invalid_state'; end if;
    act:=p_body->>'action'; why:=coalesce(p_body->>'reason','');
    if act not in ('accept','request_changes','decline') or act is null then raise exception 'invalid_request'; end if;
    if act in ('request_changes','decline') and length(btrim(why))=0 then raise exception 'reason_required'; end if;
    -- Existing task API also blocks paid publishing until the payment implementation lands.
    if act='accept' and (t.published_config->>'reward_amount_minor')::bigint>0 then raise exception 'payment_not_configured'; end if;
    insert into submission_decisions(submission_id,revision_id,publisher_id,action,reason) values(s.id,s.current_revision_id,p_actor,act,why);
    update submissions set processing_status=case act when 'accept' then 'accepted' when 'decline' then 'declined' else 'changes_requested' end,
      payment_status=case act when 'accept' then 'not_required' when 'decline' then 'not_payable' else 'awaiting_confirmation' end,version=version+1 where id=s.id returning * into s;
    result:=to_jsonb(s);
  else raise exception 'invalid_request'; end if;
  insert into submission_api_requests(principal_id,route,key,request_hash,response) values(p_actor,route_key,p_key,p_hash,result);
  return result;
end $$;
revoke all on function public.mutate_submission(uuid,text,uuid,jsonb,text,text) from public,anon,authenticated;
grant execute on function public.mutate_submission(uuid,text,uuid,jsonb,text,text) to service_role;
