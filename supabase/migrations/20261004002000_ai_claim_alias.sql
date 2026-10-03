-- Avoid conflict between the PL/pgSQL task-summary record and the tasks SQL alias.
create or replace function public.ai_claim_job() returns jsonb
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
    select jsonb_build_object('task_id',s.task_id,'config',task_row.published_config,
      'submission_id',s.id,'submission_no',s.submission_no,'revision_id',r.id,
      'operation_notes',r.operation_notes,'answers',r.answers,
      'evidence',coalesce((select jsonb_agg(jsonb_build_object('id',e.id,'name',e.name,'mime_type',e.mime_type,
          'size_bytes',e.size_bytes,'object_path',e.object_path) order by e.id)
        from submission_evidence e where e.id=any(r.evidence_ids) and e.task_id=s.task_id and e.uploader_id=s.tester_id),'[]'::jsonb))
      into payload from submission_revisions r join submissions s on s.id=r.submission_id
      join tasks task_row on task_row.id=s.task_id where r.id=j.revision_id;
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

notify pgrst,'reload schema';
