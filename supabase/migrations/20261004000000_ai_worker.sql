-- Additive migration. Requires task_api and submissions_api (already deployed).
-- No changes to mutate_submission, review decisions, payments, or API functions.
create extension if not exists pg_net with schema extensions;
create extension if not exists pg_cron;
create extension if not exists supabase_vault with schema vault;

alter table public.submission_jobs
  add column attempts integer not null default 0,
  add column next_run_at timestamptz not null default now(),
  add column lease_token uuid,
  add column lease_expires_at timestamptz,
  add column last_error text,
  add column model text,
  add column prompt_version text,
  add column usage jsonb,
  add column completed_at timestamptz;
create index submission_jobs_due on public.submission_jobs(next_run_at) where status in ('queued','running');

create table public.task_ai_summaries (
  task_id uuid primary key references public.tasks(id) on delete cascade,
  status text not null default 'queued' check(status in ('queued','running','succeeded','failed')),
  requested_version bigint not null default 1,
  completed_version bigint,
  summary jsonb,
  source_snapshot jsonb,
  attempts integer not null default 0,
  next_run_at timestamptz not null default now(),
  lease_token uuid,
  lease_expires_at timestamptz,
  last_error text,
  model text,
  prompt_version text,
  usage jsonb,
  completed_at timestamptz,
  updated_at timestamptz not null default now()
);
alter table public.task_ai_summaries enable row level security;
revoke all on public.task_ai_summaries from anon, authenticated;
grant all on public.task_ai_summaries to service_role;

-- One SQL statement provides a consistent snapshot and deterministic counts.
-- Full counts always include all statuses and only the current formal revision.
create function public.ai_task_snapshot(p_task_id uuid) returns jsonb
language sql stable security definer set search_path=public,pg_temp as $$
  with sources as (
    select s.id submission_id, s.submission_no, s.processing_status, r.id revision_id,
      r.operation_notes, r.answers, r.evidence_ids, r.submitted_at
    from submissions s join submission_revisions r on r.id=s.current_revision_id
    where s.task_id=p_task_id
  ), config as (select published_config c from tasks where id=p_task_id)
  select jsonb_build_object(
    'task_id',p_task_id,'config',(select c from config),'scope','all',
    'as_of',now(),
    'submissions',coalesce((select jsonb_agg(to_jsonb(s) order by s.submission_id) from sources s),'[]'::jsonb),
    'statistics',jsonb_build_object(
      'total_submissions',(select count(*) from sources),
      'status_counts',(select jsonb_object_agg(state,(select count(*) from sources where processing_status=state))
        from unnest(array['awaiting_publisher','changes_requested','accepted','declined']) state),
      'questions',coalesce((select jsonb_agg(jsonb_build_object(
        'question_key',q->>'question_key','prompt',q->>'prompt',
        'options',(select jsonb_agg(jsonb_build_object(
          'option_key',o->>'option_key','label',o->>'label','count',
          (select count(*) from sources s cross join lateral jsonb_array_elements(s.answers) a
            where a->>'question_key'=q->>'question_key' and a->>'selected_option_key'=o->>'option_key')
        ) order by oi) from jsonb_array_elements(q->'options') with ordinality options(o,oi))
      ) order by qi) from config cross join lateral jsonb_array_elements(c->'questions') with ordinality questions(q,qi)),'[]'::jsonb)
    )
  );
$$;

create function public.ai_mark_task_dirty() returns trigger
language plpgsql security definer set search_path=public,pg_temp as $$
begin
  if new.current_revision_id is null then return new; end if;
  if tg_op='UPDATE' and new.current_revision_id is not distinct from old.current_revision_id
    and new.processing_status is not distinct from old.processing_status then return new; end if;
  insert into task_ai_summaries(task_id) values(new.task_id)
  on conflict(task_id) do update set
    requested_version=task_ai_summaries.requested_version+1,
    status=case when task_ai_summaries.status='running' then 'running' else 'queued' end,
    attempts=case when task_ai_summaries.status='running' then task_ai_summaries.attempts else 0 end,
    next_run_at=now()+interval '5 seconds',last_error=null,updated_at=now();
  return new;
end $$;
create trigger ai_task_dirty after insert or update of current_revision_id,processing_status on public.submissions
for each row execute function public.ai_mark_task_dirty();

-- Shared claim lock caps concurrent model calls; SKIP LOCKED and fencing tokens
-- prevent duplicate completion. An expired lease can be retried at most 3 times.
create function public.ai_claim_job() returns jsonb
language plpgsql security definer set search_path=public,pg_temp as $$
declare j submission_jobs; t task_ai_summaries; payload jsonb; token uuid:=gen_random_uuid();
begin
  if not pg_try_advisory_xact_lock(hashtextextended('reviewwork-ai-claim',0)) then return null; end if;
  update submission_jobs set status='failed',last_error='lease_exhausted',lease_token=null,lease_expires_at=null
    where status='running' and lease_expires_at<now() and attempts>=3;
  update task_ai_summaries set status='failed',last_error='lease_exhausted',lease_token=null,lease_expires_at=null
    where status='running' and lease_expires_at<now() and attempts>=3;
  if ((select count(*) from submission_jobs where status='running' and lease_expires_at>now())+
      (select count(*) from task_ai_summaries where status='running' and lease_expires_at>now()))>=2 then return null; end if;
  select * into j from submission_jobs
    where attempts<3 and ((status='queued' and next_run_at<=now()) or (status='running' and lease_expires_at<now()))
    order by created_at for update skip locked limit 1;
  if found then
    update submission_jobs set status='running',attempts=attempts+1,lease_token=token,
      lease_expires_at=now()+interval '3 minutes',last_error=null where id=j.id;
    select jsonb_build_object('task_id',s.task_id,'config',t.published_config,
      'submission_id',s.id,'submission_no',s.submission_no,'revision_id',r.id,
      'operation_notes',r.operation_notes,'answers',r.answers,
      'evidence',coalesce((select jsonb_agg(jsonb_build_object('id',e.id,'name',e.name,'mime_type',e.mime_type,
          'size_bytes',e.size_bytes,'object_path',e.object_path) order by e.id)
        from submission_evidence e where e.id=any(r.evidence_ids) and e.task_id=s.task_id and e.uploader_id=s.tester_id),'[]'::jsonb))
      into payload from submission_revisions r join submissions s on s.id=r.submission_id
      join tasks t on t.id=s.task_id where r.id=j.revision_id;
    return jsonb_build_object('kind','submission','id',j.id,'lease_token',token,'version',0,'payload',payload);
  end if;
  select ts.* into t from task_ai_summaries ts
    where ts.attempts<3 and ((ts.status='queued' and ts.next_run_at<=now()) or (ts.status='running' and ts.lease_expires_at<now()))
    and not exists(select 1 from submissions s join submission_jobs sj on sj.revision_id=s.current_revision_id
      where s.task_id=ts.task_id and sj.status in ('queued','running'))
    order by ts.next_run_at for update of ts skip locked limit 1;
  if not found then return null; end if;
  update task_ai_summaries set status='running',attempts=attempts+1,lease_token=token,
    lease_expires_at=now()+interval '3 minutes',last_error=null where task_id=t.task_id;
  return jsonb_build_object('kind','task','id',t.task_id,'lease_token',token,
    'version',t.requested_version,'payload',ai_task_snapshot(t.task_id));
end $$;

create function public.ai_finish_job(p_kind text,p_id uuid,p_token uuid,p_version bigint,
  p_summary jsonb,p_snapshot jsonb,p_model text,p_prompt_version text,p_usage jsonb) returns boolean
language plpgsql security definer set search_path=public,pg_temp as $$
declare t task_ai_summaries; affected integer;
begin
  if p_kind='submission' then
    update submission_jobs set status='succeeded',summary=p_summary,model=p_model,prompt_version=p_prompt_version,
      usage=p_usage,completed_at=now(),lease_token=null,lease_expires_at=null,last_error=null
      where id=p_id and status='running' and lease_token=p_token and lease_expires_at>now();
    get diagnostics affected=row_count; return affected=1;
  elsif p_kind='task' then
    select * into t from task_ai_summaries where task_id=p_id and status='running' and lease_token=p_token and lease_expires_at>now() for update;
    if not found then return false; end if;
    if t.requested_version<>p_version then
      update task_ai_summaries set status='queued',attempts=0,next_run_at=now(),lease_token=null,lease_expires_at=null where task_id=p_id;
      return false;
    end if;
    update task_ai_summaries set status='succeeded',summary=p_summary,source_snapshot=p_snapshot,
      completed_version=p_version,model=p_model,prompt_version=p_prompt_version,usage=p_usage,
      completed_at=now(),lease_token=null,lease_expires_at=null,last_error=null where task_id=p_id;
    return true;
  end if;
  raise exception 'invalid_job_kind';
end $$;

create function public.ai_fail_job(p_kind text,p_id uuid,p_token uuid,p_version bigint,p_error text,p_retryable boolean)
returns boolean language plpgsql security definer set search_path=public,pg_temp as $$
declare affected integer;
begin
  if p_error !~ '^[a-z0-9_]{1,80}$' then p_error:='worker_error'; end if;
  if p_kind='submission' then
    update submission_jobs set status=case when p_retryable and attempts<3 then 'queued' else 'failed' end,
      next_run_at=now()+make_interval(secs=>30*attempts),last_error=p_error,lease_token=null,lease_expires_at=null
      where id=p_id and status='running' and lease_token=p_token and lease_expires_at>now();
  elsif p_kind='task' then
    update task_ai_summaries set status=case when requested_version<>p_version or (p_retryable and attempts<3) then 'queued' else 'failed' end,
      attempts=case when requested_version<>p_version then 0 else attempts end,
      next_run_at=now()+make_interval(secs=>30*attempts),last_error=p_error,lease_token=null,lease_expires_at=null
      where task_id=p_id and status='running' and lease_token=p_token and lease_expires_at>now();
  else raise exception 'invalid_job_kind'; end if;
  get diagnostics affected=row_count; return affected=1;
end $$;

-- Called by backend task/results handlers. Old text stays attached to its old
-- statistics snapshot; stale explicitly marks changed revisions/review states.
create function public.ai_task_result(p_task_id uuid) returns jsonb
language sql stable security definer set search_path=public,pg_temp as $$
  select jsonb_build_object('status',status,'summary',summary,'snapshot',source_snapshot,
    'stale',completed_version is distinct from requested_version,'completed_at',completed_at,
    'error_code',last_error) from task_ai_summaries where task_id=p_task_id;
$$;

-- The dedicated worker token lives in Vault and in Edge Secrets, never source.
create function public.ai_configure_worker(p_url text,p_token text) returns void
language plpgsql security definer set search_path=public,pg_temp as $$
declare sid uuid;
begin
  if p_url !~ '^https://[a-z0-9]+\.supabase\.co/functions/v1/ai-worker$' or length(p_token)<32 then raise exception 'invalid_worker_config'; end if;
  select id into sid from vault.secrets where name='reviewwork_ai_worker_url';
  if found then perform vault.update_secret(sid,p_url); else perform vault.create_secret(p_url,'reviewwork_ai_worker_url'); end if;
  select id into sid from vault.secrets where name='reviewwork_ai_worker_token';
  if found then perform vault.update_secret(sid,p_token); else perform vault.create_secret(p_token,'reviewwork_ai_worker_token'); end if;
end $$;

create function public.ai_wake_worker() returns void
language plpgsql security definer set search_path=public,pg_temp as $$
declare endpoint text; token text;
begin
  if not (exists(select 1 from submission_jobs where (status='queued' and next_run_at<=now()) or (status='running' and lease_expires_at<now()))
    or exists(select 1 from task_ai_summaries where (status='queued' and next_run_at<=now()) or (status='running' and lease_expires_at<now()))) then return; end if;
  select decrypted_secret into endpoint from vault.decrypted_secrets where name='reviewwork_ai_worker_url';
  select decrypted_secret into token from vault.decrypted_secrets where name='reviewwork_ai_worker_token';
  if endpoint is null or token is null then return; end if;
  perform net.http_post(url:=endpoint,headers:=jsonb_build_object('Content-Type','application/json','x-ai-worker-token',token),body:='{}'::jsonb,timeout_milliseconds:=1000);
end $$;
create function public.ai_notify_submission_job() returns trigger
language plpgsql security definer set search_path=public,pg_temp as $$
begin
  perform ai_wake_worker();
  return new;
exception when others then
  -- Durable queue insertion must succeed even when the best-effort wake fails.
  -- The minute cron will recover without blocking the submission transaction.
  return new;
end $$;
create trigger ai_submission_wake after insert on public.submission_jobs
for each row execute function public.ai_notify_submission_job();

-- Also summarize existing formal submissions; do not rewrite existing jobs.
insert into public.task_ai_summaries(task_id)
select distinct task_id from public.submissions where current_revision_id is not null;

-- Internal RPCs must never be callable with an anon key or a user's JWT.
do $$ declare f record; begin
  for f in select p.oid::regprocedure signature from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public' and p.proname in ('ai_task_snapshot','ai_mark_task_dirty','ai_claim_job','ai_finish_job','ai_fail_job','ai_task_result','ai_configure_worker','ai_wake_worker','ai_notify_submission_job') loop
    execute format('revoke all on function %s from public, anon, authenticated',f.signature);
    execute format('grant execute on function %s to service_role',f.signature);
  end loop;
end $$;
select cron.schedule('reviewwork-ai-worker','* * * * *','select public.ai_wake_worker();');
notify pgrst,'reload schema';
