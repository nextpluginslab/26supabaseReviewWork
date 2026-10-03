-- Guest sessions own private evidence/submissions without a login UI. Contact
-- email is immutable and remains unverified until the reward email is redeemed.
create table public.feedback_contacts (
  user_id uuid primary key references auth.users(id),
  email text not null check(length(email) between 3 and 254),
  created_at timestamptz not null default now()
);
alter table public.feedback_contacts enable row level security;
revoke all on public.feedback_contacts from public,anon,authenticated;
grant select on public.feedback_contacts to service_role;

create or replace function public.mutate_submission(p_actor uuid,p_action text,p_target uuid,p_body jsonb,p_key text,p_hash text)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare
  t public.tasks; s public.submissions; cached public.submission_api_requests;
  route_key text := p_action || ':' || p_target::text; result jsonb; rid uuid; eid uuid;
  decision_id uuid; reward jsonb; q jsonb; a jsonb; ids uuid[]; e public.submission_evidence; act text; why text;
begin
  if p_actor is null or p_key is null or length(p_key) not between 1 and 128 or p_hash is null then raise exception 'invalid_request'; end if;
  if not exists(select 1 from auth.users where id=p_actor and (
    (email_confirmed_at is not null and coalesce(is_anonymous,false)=false)
    or (is_anonymous=true and p_action in ('upload','submit','revise'))
  )) then raise exception 'email_not_verified'; end if;
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
    if exists(select 1 from auth.users where id=p_actor and is_anonymous=true) then
      if length(coalesce(p_body->>'contact_email','')) not between 3 and 254
        or (p_body->>'contact_email') !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' then
        raise exception 'invalid_contact_email';
      end if;
      insert into feedback_contacts(user_id,email) values(p_actor,lower(btrim(p_body->>'contact_email'))) on conflict do nothing;
      if not exists(select 1 from feedback_contacts where user_id=p_actor and email=lower(btrim(p_body->>'contact_email'))) then
        raise exception 'contact_email_locked';
      end if;
    end if;
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

create or replace function public.reward_claim_command(p_action text, p_actor uuid, p_data jsonb default '{}')
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare
  e reward_claim_emails;
  r payment_rewards;
begin
  if p_action='reward' then
    select * into r from payment_rewards where id=(p_data->>'id')::uuid and (
      tester_id=p_actor or exists(
        select 1 from feedback_contacts c join auth.users u on lower(u.email)=c.email
        where c.user_id=payment_rewards.tester_id and u.id=p_actor
          and u.email_confirmed_at is not null and coalesce(u.is_anonymous,false)=false
      )
    );
    if not found then raise no_data_found using message='Reward not found for this recipient'; end if;
    return jsonb_build_object('id',r.id,'tester_id',r.tester_id,'amount_minor',r.amount_minor,'state',r.state,'currency','usd');
  elsif p_action='recipient' then
    select * into strict r from payment_rewards where id=(p_data->>'id')::uuid;
    return (select jsonb_build_object('email',case when u.is_anonymous then c.email else u.email end,
      'guest',coalesce(u.is_anonymous,false)) from auth.users u left join feedback_contacts c on c.user_id=u.id
      where u.id=r.tester_id and (u.is_anonymous=true or u.email_confirmed_at is not null));
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

notify pgrst,'reload schema';
