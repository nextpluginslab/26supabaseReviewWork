-- Inbox only. Existing task/submission functions are not replaced.
create table public.notifications (
  id uuid primary key default gen_random_uuid(),
  recipient_id uuid not null references auth.users(id) on delete cascade,
  event_key text not null check (length(event_key) between 1 and 256),
  type text not null check (type in (
    'submission_received', 'submission_revised', 'changes_requested',
    'submission_accepted', 'submission_declined',
    'payment_succeeded', 'payment_failed', 'review_reminder'
  )),
  entity_id uuid not null,
  task_id uuid not null references public.tasks(id) on delete cascade,
  title text not null check (length(title) between 1 and 200),
  body text not null default '' check (length(body) <= 10000),
  created_at timestamptz not null default now(),
  read_at timestamptz,
  unique (recipient_id, event_key)
);
create index notifications_recipient_cursor on public.notifications
  (recipient_id, created_at desc, id desc);
create index notifications_unread_cursor on public.notifications
  (recipient_id, created_at desc, id desc) where read_at is null;
alter table public.notifications enable row level security;
revoke all on public.notifications from public, anon, authenticated;
grant select on public.notifications to authenticated;
grant all on public.notifications to service_role;
create policy notifications_read_own on public.notifications
  for select to authenticated using (recipient_id = (select auth.uid()));

-- The caller cannot choose a recipient, forge read_at, or edit notification content.
-- UPDATE obtains a row lock; retries preserve the original read timestamp.
create function public.mark_notification_read(p_id uuid)
returns setof public.notifications
language sql security definer set search_path = '' as $$
  update public.notifications
  set read_at = coalesce(read_at, statement_timestamp())
  where id = p_id and recipient_id = (select auth.uid())
  returning *;
$$;
revoke all on function public.mark_notification_read(uuid) from public, anon, authenticated;
grant execute on function public.mark_notification_read(uuid) to authenticated;

-- These triggers run inside the business transaction. Rollback also rolls back
-- the inbox event; replaying an idempotent submission mutation creates no event.
create function public.notify_submission_revision()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  insert into public.notifications
    (recipient_id, event_key, type, entity_id, task_id, title, body)
  select t.publisher_id, 'revision:' || new.id::text,
    case when new.revision_no = 1 then 'submission_received' else 'submission_revised' end,
    s.id, s.task_id,
    case when new.revision_no = 1 then 'New feedback received' else 'Feedback updated' end,
    'Submission ' || s.submission_no ||
      case when new.revision_no = 1 then ' is ready for review.' else ' has been updated and is ready for review.' end
  from public.submissions s join public.tasks t on t.id = s.task_id
  where s.id = new.submission_id
  on conflict (recipient_id, event_key) do nothing;
  return new;
end;
$$;
revoke all on function public.notify_submission_revision() from public, anon, authenticated;
create trigger notifications_on_revision after insert on public.submission_revisions
  for each row execute function public.notify_submission_revision();

create function public.notify_submission_decision()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  insert into public.notifications
    (recipient_id, event_key, type, entity_id, task_id, title, body)
  select s.tester_id, 'decision:' || new.id::text,
    case new.action when 'accept' then 'submission_accepted'
      when 'decline' then 'submission_declined' else 'changes_requested' end,
    s.id, s.task_id,
    case new.action when 'accept' then 'Feedback accepted'
      when 'decline' then 'Feedback declined' else 'More information requested' end,
    left(new.reason, 10000)
  from public.submissions s where s.id = new.submission_id
  on conflict (recipient_id, event_key) do nothing;
  return new;
end;
$$;
revoke all on function public.notify_submission_decision() from public, anon, authenticated;
create trigger notifications_on_decision after insert on public.submission_decisions
  for each row execute function public.notify_submission_decision();
