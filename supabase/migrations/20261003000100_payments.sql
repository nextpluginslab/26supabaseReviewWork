-- Payment-owned tables. Task/submission APIs call the service-only RPC in THEIR
-- transaction; this migration deliberately does not create competing domain tables.
create table public.payment_task_accounts (
  task_id uuid primary key,
  publisher_id uuid not null references auth.users(id),
  budget_amount_minor bigint not null check (budget_amount_minor between 0 and 99999999),
  reward_amount_minor bigint not null check (reward_amount_minor between 0 and 99999999),
  currency text not null default 'usd' check (currency = 'usd'),
  funding_state text not null default 'unfunded' check (funding_state in ('unfunded','pending','funded','not_required')),
  charge_id text unique,
  check (reward_amount_minor = 0 or budget_amount_minor >= reward_amount_minor)
);
create table public.payment_funding_sessions (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null references public.payment_task_accounts(task_id),
  publisher_id uuid not null references auth.users(id),
  amount_minor bigint not null check (amount_minor > 0),
  session_id text unique,
  state text not null default 'creating' check (state in ('creating','open','expired','paid')),
  created_at timestamptz not null default now()
);
create unique index payment_one_active_funding on public.payment_funding_sessions(task_id) where state <> 'expired';
create table public.payment_connect_accounts (
  user_id uuid primary key references auth.users(id),
  id uuid not null unique default gen_random_uuid(),
  account_id text unique,
  created_at timestamptz not null default now()
);
create table public.payment_rewards (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null references public.payment_task_accounts(task_id),
  submission_id uuid not null unique,
  tester_id uuid not null references auth.users(id),
  decision_id uuid not null unique,
  amount_minor bigint not null check (amount_minor >= 0),
  state text not null check (state in ('not_required','pending','processing','unknown','failed','paid','reconciliation_required')),
  attempt_no integer not null default 1,
  transfer_id text unique,
  last_retry_key text,
  lease_until timestamptz,
  next_run_at timestamptz not null default now(),
  error_code text,
  reversed boolean not null default false,
  created_at timestamptz not null default now()
);
create index payment_reward_queue on public.payment_rewards(next_run_at) where state in ('pending','processing','unknown');
create table public.payment_attempts (
  id uuid primary key default gen_random_uuid(),
  reward_id uuid not null references public.payment_rewards(id),
  attempt_no integer not null,
  task_id uuid not null,
  tester_id uuid not null,
  amount_minor bigint not null,
  destination text not null,
  source_charge text not null,
  transfer_id text unique,
  state text not null default 'processing' check (state in ('processing','unknown','failed','paid')),
  created_at timestamptz not null default now(),
  unique(reward_id, attempt_no)
);
create table public.payment_webhook_events (
  event_id text primary key,
  event_type text not null,
  processed_at timestamptz not null default now()
);
create table public.payment_requests (
  actor_id uuid not null references auth.users(id),
  route text not null,
  request_key text not null,
  request_hash text not null,
  response jsonb,
  lease_until timestamptz not null default now() + interval '60 seconds',
  created_at timestamptz not null default now(),
  primary key(actor_id, route, request_key)
);

-- All mutations and reads are mediated by authenticated Edge handlers. No client
-- can forge a funded account, reward authorization, or transfer result via REST.
alter table public.payment_task_accounts enable row level security;
alter table public.payment_funding_sessions enable row level security;
alter table public.payment_connect_accounts enable row level security;
alter table public.payment_rewards enable row level security;
alter table public.payment_attempts enable row level security;
alter table public.payment_webhook_events enable row level security;
alter table public.payment_requests enable row level security;
revoke all on public.payment_task_accounts, public.payment_funding_sessions,
  public.payment_connect_accounts, public.payment_rewards, public.payment_attempts,
  public.payment_webhook_events, public.payment_requests from public, anon, authenticated;

create function public.payments_command(p_action text, p_actor uuid, p_data jsonb default '{}')
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  t payment_task_accounts;
  f payment_funding_sessions;
  c payment_connect_accounts;
  r payment_rewards;
  a payment_attempts;
  q payment_requests;
  v_id uuid;
  v_paid bigint;
  v_pending bigint;
  v_inserted integer;
begin
  if p_action = 'register_task' then
    -- Called from the task create/edit transaction with server-authoritative data.
    insert into payment_task_accounts(task_id,publisher_id,budget_amount_minor,reward_amount_minor,funding_state)
      values ((p_data->>'task_id')::uuid,p_actor,(p_data->>'budget_amount_minor')::bigint,
        (p_data->>'reward_amount_minor')::bigint,
        case when (p_data->>'reward_amount_minor')::bigint=0 then 'not_required' else 'unfunded' end)
      on conflict do nothing;
    select * into strict t from payment_task_accounts where task_id=(p_data->>'task_id')::uuid for update;
    if t.publisher_id <> p_actor then raise insufficient_privilege using message='Task ownership mismatch'; end if;
    if t.budget_amount_minor <> (p_data->>'budget_amount_minor')::bigint or t.reward_amount_minor <> (p_data->>'reward_amount_minor')::bigint then
      if exists(select 1 from payment_funding_sessions where task_id=t.task_id and state<>'expired')
        or exists(select 1 from payment_rewards where task_id=t.task_id) then
        raise exception 'Task payment amounts are frozen';
      end if;
      update payment_task_accounts set budget_amount_minor=(p_data->>'budget_amount_minor')::bigint,
        reward_amount_minor=(p_data->>'reward_amount_minor')::bigint,
        funding_state=case when (p_data->>'reward_amount_minor')::bigint=0 then 'not_required' else 'unfunded' end
        where task_id=t.task_id returning * into t;
    end if;
    return to_jsonb(t);
  elsif p_action in ('task','reserve_funding','authorize_reward') then
    select * into strict t from payment_task_accounts where task_id=(p_data->>'task_id')::uuid for update;
    if p_actor is null or t.publisher_id <> p_actor then raise insufficient_privilege using message='Task is not owned by this user'; end if;
    select coalesce(sum(amount_minor) filter(where state='paid'),0),
      coalesce(sum(amount_minor) filter(where state not in ('paid','not_required')),0)
      into v_paid,v_pending from payment_rewards where task_id=t.task_id;
    if p_action='task' then
      select * into f from payment_funding_sessions where task_id=t.task_id and state<>'expired';
      return to_jsonb(t)||jsonb_build_object('paid_amount_minor',v_paid,'pending_amount_minor',v_pending,
        'remaining_amount_minor',t.budget_amount_minor-v_paid-v_pending,'funding',case when f.id is null then null else to_jsonb(f) end);
    elsif p_action='reserve_funding' then
      if t.funding_state in ('funded','not_required') then raise exception 'No funding is required'; end if;
      if t.budget_amount_minor<50 then raise exception 'Stripe USD funding requires a budget of at least 50 cents'; end if;
      select * into f from payment_funding_sessions where task_id=t.task_id and state<>'expired';
      if not found then
        insert into payment_funding_sessions(task_id,publisher_id,amount_minor)
          values(t.task_id,t.publisher_id,t.budget_amount_minor) returning * into f;
      end if;
      update payment_task_accounts set funding_state='pending' where task_id=t.task_id;
      return to_jsonb(f);
    else
      -- Call ONLY in the same transaction as verifying the current submission
      -- revision and inserting the human accept decision. Never expose over HTTP.
      select * into r from payment_rewards where submission_id=(p_data->>'submission_id')::uuid;
      if found then
        if r.task_id<>t.task_id or r.tester_id<>(p_data->>'tester_id')::uuid or r.decision_id<>(p_data->>'decision_id')::uuid then
          raise exception 'Reward authorization conflict';
        end if;
        return to_jsonb(r);
      end if;
      if t.reward_amount_minor>0 then
        if p_data->>'confirm_payment' is distinct from 'true' then raise exception 'Human payment confirmation required'; end if;
        if t.funding_state<>'funded' then raise exception 'Task has not been funded'; end if;
        if v_paid+v_pending+t.reward_amount_minor>t.budget_amount_minor then raise exception 'Insufficient task budget'; end if;
      end if;
      insert into payment_rewards(task_id,submission_id,tester_id,decision_id,amount_minor,state)
        values(t.task_id,(p_data->>'submission_id')::uuid,(p_data->>'tester_id')::uuid,
          (p_data->>'decision_id')::uuid,t.reward_amount_minor,
          case when t.reward_amount_minor=0 then 'not_required' else 'pending' end) returning * into r;
      return to_jsonb(r);
    end if;
  elsif p_action='funding' then
    select * into strict f from payment_funding_sessions where id=(p_data->>'id')::uuid;
    return to_jsonb(f);
  elsif p_action='apply_funding' then
    -- Server has retrieved and verified the Stripe Session/PaymentIntent/Charge.
    select task_id into strict v_id from payment_funding_sessions where id=(p_data->>'id')::uuid;
    select * into strict t from payment_task_accounts where task_id=v_id for update;
    select * into strict f from payment_funding_sessions where id=(p_data->>'id')::uuid for update;
    if f.session_id is not null and f.session_id<>p_data->>'session_id' then raise exception 'Checkout identity mismatch'; end if;
    if p_data->>'event_id' is not null then
      insert into payment_webhook_events(event_id,event_type) values(p_data->>'event_id',p_data->>'event_type') on conflict do nothing;
      get diagnostics v_inserted=row_count;
      if v_inserted=0 then return to_jsonb(f); end if;
    end if;
    if f.state='paid' then return to_jsonb(f); end if;
    if p_data->>'state'='paid' then
      if nullif(p_data->>'charge_id','') is null then raise exception 'Verified charge required'; end if;
      update payment_task_accounts set funding_state='funded',charge_id=p_data->>'charge_id' where task_id=t.task_id;
    elsif p_data->>'state'='expired' then
      update payment_task_accounts set funding_state='unfunded' where task_id=t.task_id and funding_state<>'funded';
    end if;
    update payment_funding_sessions set session_id=p_data->>'session_id',state=p_data->>'state' where id=f.id returning * into f;
    return to_jsonb(f);
  elsif p_action in ('connect','prepare_connect','save_connect') then
    if p_actor is null then raise insufficient_privilege; end if;
    if p_action='connect' then
      select * into c from payment_connect_accounts where user_id=p_actor;
      return coalesce(to_jsonb(c),jsonb_build_object('account_id',null));
    end if;
    insert into payment_connect_accounts(user_id) values(p_actor) on conflict do nothing;
    select * into strict c from payment_connect_accounts where user_id=p_actor for update;
    if p_action='save_connect' then
      if c.account_id is not null and c.account_id<>p_data->>'account_id' then raise exception 'Connect account identity mismatch'; end if;
      update payment_connect_accounts set account_id=p_data->>'account_id' where user_id=p_actor returning * into c;
    end if;
    return to_jsonb(c);
  elsif p_action='retry' then
    select task_id into strict v_id from payment_rewards where id=(p_data->>'id')::uuid;
    select * into strict t from payment_task_accounts where task_id=v_id for update;
    if p_actor is null or t.publisher_id<>p_actor then raise insufficient_privilege using message='Reward is not owned by this publisher'; end if;
    select * into strict r from payment_rewards where id=(p_data->>'id')::uuid for update;
    if r.state in ('paid','not_required') or r.last_retry_key=p_data->>'request_key' then return to_jsonb(r); end if;
    if r.state='reconciliation_required' then raise exception 'Manual Stripe reconciliation is required before retry'; end if;
    if r.lease_until>now() then raise exception 'Payment is already processing'; end if;
    update payment_rewards set attempt_no=attempt_no+case when state='failed' then 1 else 0 end,
      state=case when state='unknown' then 'unknown' else 'pending' end,
      last_retry_key=p_data->>'request_key',next_run_at=now(),error_code=null where id=r.id returning * into r;
    return to_jsonb(r);
  elsif p_action='claim' then
    select * into r from payment_rewards where state in ('pending','processing','unknown')
      and next_run_at<=now() and (lease_until is null or lease_until<now())
      order by next_run_at for update skip locked limit 1;
    if not found then return 'null'::jsonb; end if;
    update payment_rewards set lease_until=now()+interval '2 minutes',state='processing' where id=r.id returning * into r;
    return to_jsonb(r);
  elsif p_action='current_attempt' then
    select a1.* into a from payment_attempts a1 join payment_rewards r1 on r1.id=a1.reward_id
      where r1.id=(p_data->>'id')::uuid and a1.attempt_no=r1.attempt_no;
    if not found then return 'null'::jsonb; end if;
    return to_jsonb(a);
  elsif p_action='prepare_attempt' then
    select * into strict r from payment_rewards where id=(p_data->>'id')::uuid for update;
    if r.state='paid' then return 'null'::jsonb; end if;
    select * into a from payment_attempts where reward_id=r.id and attempt_no=r.attempt_no;
    if found then return to_jsonb(a); end if;
    select * into strict t from payment_task_accounts where task_id=r.task_id;
    select * into c from payment_connect_accounts where user_id=r.tester_id;
    if c.account_id is null then return 'null'::jsonb; end if;
    if t.charge_id is null then raise exception 'Verified funding charge is required'; end if;
    insert into payment_attempts(reward_id,attempt_no,task_id,tester_id,amount_minor,destination,source_charge)
      values(r.id,r.attempt_no,r.task_id,r.tester_id,r.amount_minor,c.account_id,t.charge_id) returning * into a;
    return to_jsonb(a);
  elsif p_action='attempt' then
    select * into strict a from payment_attempts where id=(p_data->>'id')::uuid;
    return to_jsonb(a);
  elsif p_action='finish_attempt' then
    select * into strict a from payment_attempts where id=(p_data->>'id')::uuid;
    select * into strict t from payment_task_accounts where task_id=a.task_id for update;
    select * into strict r from payment_rewards where id=a.reward_id for update;
    select * into strict a from payment_attempts where id=a.id for update;
    if p_data->>'event_id' is not null then
      insert into payment_webhook_events(event_id,event_type) values(p_data->>'event_id',p_data->>'event_type') on conflict do nothing;
      get diagnostics v_inserted=row_count;
      if v_inserted=0 then return to_jsonb(r); end if;
    end if;
    if p_data->>'state'='paid' then
      if nullif(p_data->>'transfer_id','') is null then raise exception 'Verified transfer required'; end if;
      if r.transfer_id is not null and r.transfer_id<>p_data->>'transfer_id' then raise exception 'Reward already has another transfer'; end if;
      update payment_attempts set state='paid',transfer_id=p_data->>'transfer_id' where id=a.id;
      update payment_rewards set state='paid',transfer_id=p_data->>'transfer_id',
        reversed=reversed or coalesce((p_data->>'reversed')::boolean,false),lease_until=null,error_code=null where id=r.id returning * into r;
    elsif r.state<>'paid' and a.attempt_no=r.attempt_no then
      update payment_attempts set state=p_data->>'state' where id=a.id and state<>'paid';
      update payment_rewards set state=p_data->>'state',lease_until=null,next_run_at=now()+interval '1 minute',
        error_code=p_data->>'error_code' where id=r.id returning * into r;
    end if;
    return to_jsonb(r);
  elsif p_action='defer' then
    update payment_rewards set state=p_data->>'state',error_code=p_data->>'error_code',
      lease_until=null,next_run_at=now()+interval '1 minute'
      where id=(p_data->>'id')::uuid and state<>'paid' returning * into r;
    return to_jsonb(r);
  elsif p_action='request_begin' then
    insert into payment_requests(actor_id,route,request_key,request_hash)
      values(p_actor,p_data->>'route',p_data->>'key',p_data->>'hash') on conflict do nothing;
    get diagnostics v_inserted=row_count;
    select * into strict q from payment_requests where actor_id=p_actor and route=p_data->>'route' and request_key=p_data->>'key' for update;
    if q.request_hash<>p_data->>'hash' then raise exception 'Idempotency-Key was used with a different request'; end if;
    if q.response is not null then return jsonb_build_object('cached',true,'response',q.response); end if;
    if v_inserted=0 and q.lease_until>now() then raise exception 'Request is already processing; retry shortly'; end if;
    if q.created_at<now()-interval '23 hours' then raise exception 'Request requires reconciliation; do not replay'; end if;
    update payment_requests set lease_until=now()+interval '60 seconds' where actor_id=q.actor_id and route=q.route and request_key=q.request_key;
    return jsonb_build_object('cached',false);
  elsif p_action='request_finish' then
    update payment_requests set response=p_data->'response',lease_until=now() where actor_id=p_actor and route=p_data->>'route' and request_key=p_data->>'key';
    return '{}';
  else
    raise exception 'Unknown payment command';
  end if;
end;
$$;
revoke all on function public.payments_command(text,uuid,jsonb) from public, anon, authenticated;
grant execute on function public.payments_command(text,uuid,jsonb) to service_role;
