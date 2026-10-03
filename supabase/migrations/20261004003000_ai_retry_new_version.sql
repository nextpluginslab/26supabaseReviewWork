-- New source versions get a fresh retry budget even if the old worker crashes.
create or replace function public.ai_mark_task_dirty() returns trigger
language plpgsql security definer set search_path=public,pg_temp as $$
begin
  if new.current_revision_id is null then return new; end if;
  if tg_op='UPDATE' and new.current_revision_id is not distinct from old.current_revision_id
    and new.processing_status is not distinct from old.processing_status then return new; end if;
  insert into task_ai_summaries(task_id) values(new.task_id)
  on conflict(task_id) do update set
    requested_version=task_ai_summaries.requested_version+1,
    status=case when task_ai_summaries.status='running' then 'running' else 'queued' end,
    attempts=0,
    next_run_at=now()+interval '5 seconds',last_error=null,updated_at=now();
  return new;
end $$;
