-- Connect existing domains without rewriting already-applied migrations.
alter table public.submissions drop constraint submissions_payment_status_check;
alter table public.submissions add constraint submissions_payment_status_check check (payment_status in ('awaiting_confirmation','not_required','not_payable','pending','processing','unknown','failed','paid','reconciliation_required'));
-- Backfill payment accounts only; this neither charges nor authorizes any reward.
insert into public.payment_task_accounts(task_id,publisher_id,budget_amount_minor,reward_amount_minor,funding_state)
select id,publisher_id,(config->>'budget_amount_minor')::bigint,(config->>'reward_amount_minor')::bigint,case when (config->>'reward_amount_minor')::bigint=0 then 'not_required' else 'unfunded' end from public.tasks on conflict do nothing;
grant select on public.payment_rewards to service_role;
create or replace function public.mutate_task(p_actor uuid, p_action text, p_task uuid, p_config jsonb, p_version integer, p_key text, p_hash text)
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
    perform public.payments_command('register_task',p_actor,jsonb_build_object('task_id',t.id,'budget_amount_minor',(t.config->>'budget_amount_minor')::bigint,'reward_amount_minor',(t.config->>'reward_amount_minor')::bigint));
  elsif p_action='publish' then
    if t.status <> 'draft' then raise exception 'invalid_state'; end if;
    -- Payment integration must establish trusted funding before paid publishing is enabled.
    if public.payments_command('task',p_actor,jsonb_build_object('task_id',t.id))->>'funding_state' not in ('funded','not_required') then raise exception 'funding_required'; end if;
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

create or replace function public.mutate_submission(p_actor uuid,p_action text,p_target uuid,p_body jsonb,p_key text,p_hash text)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare
  t public.tasks; s public.submissions; cached public.submission_api_requests;
  route_key text := p_action || ':' || p_target::text; result jsonb; rid uuid; eid uuid;
  decision_id uuid; reward jsonb; q jsonb; a jsonb; ids uuid[]; e public.submission_evidence; act text; why text;
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
    select tt.* into t from tasks tt join submissions ss on tt.id=ss.task_id where ss.id=p_target and (ss.tester_id=p_actor or tt.publisher_id=p_actor) for share of tt;
    if not found then raise exception 'submission_not_found'; end if;
    -- Global order: task -> payment account -> submission. Revisions need no payment lock.
    if p_action='decide' then
      if t.publisher_id<>p_actor then raise exception 'forbidden'; end if;
      perform public.payments_command('task',p_actor,jsonb_build_object('task_id',t.id));
    end if;
    select * into s from submissions where id=p_target for update;
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
    insert into submission_decisions(submission_id,revision_id,publisher_id,action,reason) values(s.id,s.current_revision_id,p_actor,act,why) returning id into decision_id;
    if act='accept' then
      reward:=public.payments_command('authorize_reward',p_actor,jsonb_build_object('task_id',t.id,'submission_id',s.id,'tester_id',s.tester_id,'decision_id',decision_id,'confirm_payment',coalesce((p_body->>'confirm_payment')::boolean,false)));
    end if;
    update submissions set processing_status=case act when 'accept' then 'accepted' when 'decline' then 'declined' else 'changes_requested' end,
      payment_status=case act when 'accept' then reward->>'state' when 'decline' then 'not_payable' else 'awaiting_confirmation' end,version=version+1 where id=s.id returning * into s;
    result:=to_jsonb(s);
  else raise exception 'invalid_request'; end if;
  insert into submission_api_requests(principal_id,route,key,request_hash,response) values(p_actor,route_key,p_key,p_hash,result);
  return result;
end $$;
revoke all on function public.mutate_submission(uuid,text,uuid,jsonb,text,text) from public,anon,authenticated;
grant execute on function public.mutate_submission(uuid,text,uuid,jsonb,text,text) to service_role;

-- Payment status is read from payment_rewards by the API. No reverse write into
-- submissions here: avoids reward -> submission locks opposing decision order.

-- Payment notifications share the same transaction as the verified reward state.
create function public.notify_payment_result() returns trigger
language plpgsql security definer set search_path='' as $$
begin
  if new.state is distinct from old.state and new.state in ('paid','failed') then
    insert into public.notifications(recipient_id,event_key,type,entity_id,task_id,title,body)
    values(new.tester_id,'payment:'||new.id::text||':'||new.attempt_no::text||':'||new.state,
      case when new.state='paid' then 'payment_succeeded' else 'payment_failed' end,
      new.submission_id,new.task_id,
      case when new.state='paid' then 'Test payment completed' else 'Test payment failed' end,
      case when new.state='paid' then 'Your accepted feedback has received a Stripe Sandbox transfer.' else 'Your feedback remains accepted. The publisher can retry the payment.' end)
    on conflict(recipient_id,event_key) do nothing;
  end if;
  return new;
end $$;
revoke all on function public.notify_payment_result() from public,anon,authenticated;
create trigger payment_result_notification after update of state on public.payment_rewards for each row execute function public.notify_payment_result();
