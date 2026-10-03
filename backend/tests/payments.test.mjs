import { before, after, beforeEach, afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';

const owner = '10000000-0000-4000-8000-000000000001';
const tester = '10000000-0000-4000-8000-000000000002';
const stranger = '10000000-0000-4000-8000-000000000003';
const task = '20000000-0000-4000-8000-000000000001';
const submission = '30000000-0000-4000-8000-000000000001';
const decision = '40000000-0000-4000-8000-000000000001';
let db;
const rpc = async (action, actor = null, data = {}) =>
  (await db.query('select payments_command($1,$2::uuid,$3::jsonb) as result', [action, actor, JSON.stringify(data)])).rows[0].result;
// Assertions that intentionally fail SQL run in savepoints so the test can keep checking state.
async function rejectsSQL(fn, pattern) {
  await db.exec('savepoint expected_error');
  await assert.rejects(fn, pattern);
  await db.exec('rollback to expected_error');
}
async function register(reward = 200, budget = 200) {
  return await rpc('register_task', owner, { task_id: task, reward_amount_minor: reward, budget_amount_minor: budget });
}
async function funded() {
  await register();
  const f = await rpc('reserve_funding', owner, { task_id: task });
  await rpc('apply_funding', null, { id: f.id, session_id: 'cs_test_1', state: 'paid', charge_id: 'ch_test_1', event_id: 'evt_funded', event_type: 'checkout.session.completed' });
  return f;
}
async function authorize(extra = {}) {
  return await rpc('authorize_reward', owner, { task_id: task, submission_id: submission, tester_id: tester,
    decision_id: decision, confirm_payment: true, ...extra });
}
async function attempt() {
  await funded();
  const reward = await authorize();
  await rpc('save_connect', tester, { account_id: 'acct_tester' });
  await rpc('claim');
  const a = await rpc('prepare_attempt', null, { id: reward.id });
  return { reward, a };
}
before(async () => {
  db = new PGlite();
  await db.exec(`create role anon; create role authenticated; create role service_role;
    create schema auth; create table auth.users(id uuid primary key);
    insert into auth.users values ('${owner}'),('${tester}'),('${stranger}');`);
  await db.exec(await readFile(new URL('../../supabase/migrations/20261003000100_payments.sql', import.meta.url), 'utf8'));
});
after(async () => { await db.close(); });
beforeEach(async () => { await db.exec('begin'); });
afterEach(async () => { await db.exec('rollback'); });

test('migration enables RLS and denies all client writes / RPC calls', async () => {
  const rows = (await db.query("select relname,relrowsecurity from pg_class where relname in ('payment_rewards','payment_attempts','payment_task_accounts')")).rows;
  assert.equal(rows.length, 3);
  assert.ok(rows.every(row => row.relrowsecurity));
  for (const role of ['anon', 'authenticated']) {
    const result = (await db.query("select has_function_privilege($1,'payments_command(text,uuid,jsonb)','EXECUTE') as allowed", [role])).rows[0];
    assert.equal(result.allowed, false);
  }
  await db.exec('set local role authenticated');
  await rejectsSQL(() => rpc('register_task', owner, { task_id: task, reward_amount_minor: 1, budget_amount_minor: 1 }), /permission denied/);
  await rejectsSQL(() => db.exec("insert into payment_webhook_events values ('forged','test',now())"), /permission denied/);
});
test('funding reservations reuse one session and freeze amounts', async () => {
  await register();
  const a = await rpc('reserve_funding', owner, { task_id: task });
  const b = await rpc('reserve_funding', owner, { task_id: task });
  assert.equal(a.id,b.id);
  await rejectsSQL(() => register(200,400), /frozen/);
  await rejectsSQL(() => rpc('reserve_funding', stranger, { task_id: task }), /not owned/);
});
test('only verified expiration releases funding configuration; old failure cannot undo paid', async () => {
  await register();
  const f = await rpc('reserve_funding', owner, { task_id: task });
  await rpc('apply_funding', null, { id:f.id,session_id:'cs_test_1',state:'expired' });
  await register(200,400);
  const next = await rpc('reserve_funding', owner, { task_id: task });
  assert.notEqual(f.id,next.id);
  await rpc('apply_funding', null, { id:next.id,session_id:'cs_test_2',state:'paid',charge_id:'ch_test_2' });
  await rpc('apply_funding', null, { id:next.id,session_id:'cs_test_2',state:'expired' });
  assert.equal((await rpc('task', owner,{task_id:task})).funding_state,'funded');
});
test('accept requires funding, human confirmation, and one reward per submission', async () => {
  await register();
  await rejectsSQL(() => authorize(), /not been funded/);
  await funded();
  await rejectsSQL(() => authorize({ confirm_payment:false }), /confirmation required/);
  const r = await authorize();
  assert.equal((await authorize()).id,r.id);
  await rejectsSQL(() => authorize({ tester_id:stranger }), /conflict/);
});
test('last available reward occupies budget; failure keeps it occupied', async () => {
  const {reward,a} = await attempt();
  await rpc('finish_attempt',null,{id:a.id,state:'failed',error_code:'declined'});
  const budget = await rpc('task',owner,{task_id:task});
  assert.equal(budget.pending_amount_minor,200);
  assert.equal(budget.remaining_amount_minor,0);
  await rejectsSQL(() => authorize({submission_id:crypto.randomUUID(),decision_id:crypto.randomUUID()}), /Insufficient/);
  const retry = await rpc('retry',owner,{id:reward.id,request_key:'retry-1'});
  assert.equal(retry.attempt_no,2);
  assert.equal((await rpc('retry',owner,{id:reward.id,request_key:'retry-1'})).attempt_no,2);
});
test('free rewards skip funding, consume no budget, and never enter worker queue', async () => {
  await register(0,1000);
  const reward = await authorize({confirm_payment:false});
  assert.equal(reward.state,'not_required');
  assert.equal(await rpc('claim'),null);
  assert.equal((await rpc('task',owner,{task_id:task})).pending_amount_minor,0);
});
test('unknown transfer reuses same attempt; unrelated publisher cannot retry', async () => {
  const {reward,a} = await attempt();
  await rpc('finish_attempt',null,{id:a.id,state:'unknown'});
  await rejectsSQL(() => rpc('retry',stranger,{id:reward.id,request_key:'r1'}), /not owned/);
  const r = await rpc('retry',owner,{id:reward.id,request_key:'r1'});
  assert.equal(r.attempt_no,1);
  assert.equal((await rpc('prepare_attempt',null,{id:r.id})).id,a.id);
});
test('duplicate and out-of-order events cannot undo paid or double-count the budget', async () => {
  const {reward,a} = await attempt();
  const event = {id:a.id,state:'paid',transfer_id:'tr_test_1',event_id:'evt_paid',event_type:'transfer.created'};
  await rpc('finish_attempt',null,event);
  await rpc('finish_attempt',null,event);
  await rpc('finish_attempt',null,{id:a.id,state:'failed'});
  await rpc('defer',null,{id:reward.id,state:'pending'});
  const r = await rpc('retry',owner,{id:reward.id,request_key:'again'});
  assert.equal(r.state,'paid');
  const budget=await rpc('task',owner,{task_id:task});
  assert.equal(budget.paid_amount_minor,200);
  assert.equal(budget.pending_amount_minor,0);
  assert.equal((await db.query("select count(*)::int as n from payment_webhook_events where event_id='evt_paid'")).rows[0].n,1);
  await rpc('finish_attempt',null,{...event,event_id:'evt_reversed',reversed:true});
  assert.equal((await rpc('retry',owner,{id:reward.id,request_key:'reverse'})).reversed,true);
});
test('webhook failure rolls event insert back for a later retry', async () => {
  const {a} = await attempt();
  await rejectsSQL(() => rpc('finish_attempt',null,{id:a.id,state:'paid',event_id:'evt_broken',event_type:'transfer.created'}), /Verified transfer/);
  assert.equal((await db.query("select count(*)::int as n from payment_webhook_events where event_id='evt_broken'")).rows[0].n,0);
});
test('decision and reward can roll back together in the caller transaction', async () => {
  await funded();
  await db.exec('savepoint decision_transaction');
  await authorize();
  await db.exec('rollback to decision_transaction');
  assert.equal((await rpc('task',owner,{task_id:task})).pending_amount_minor,0);
  assert.equal(await rpc('claim'),null);
});
test('request key deduplicates and rejects conflicting payloads', async () => {
  const data={route:'POST /test',key:'k',hash:'abc'};
  assert.equal((await rpc('request_begin',owner,data)).cached,false);
  await rejectsSQL(() => rpc('request_begin',owner,data), /already processing/);
  await rpc('request_finish',owner,{...data,response:{url:'https://checkout.stripe.com/example'}});
  assert.equal((await rpc('request_begin',owner,data)).cached,true);
  await rejectsSQL(() => rpc('request_begin',owner,{...data,hash:'def'}), /different request/);
});
test('worker lease excludes a second claim and aged unknown needs reconciliation', async () => {
  await funded();
  const reward=await authorize();
  assert.equal((await rpc('claim')).id,reward.id);
  assert.equal(await rpc('claim'),null);
  await rpc('defer',null,{id:reward.id,state:'reconciliation_required'});
  await rejectsSQL(() => rpc('retry',owner,{id:reward.id,request_key:'unsafe'}), /reconciliation/);
});
test('a budget below the Stripe USD minimum stays editable and creates no Checkout reservation', async () => {
  await register(1,10);
  await rejectsSQL(() => rpc('reserve_funding',owner,{task_id:task}), /50 cents/);
  assert.equal((await db.query('select count(*)::int as n from payment_funding_sessions')).rows[0].n,0);
  await register(1,50);
  assert.equal((await rpc('reserve_funding',owner,{task_id:task})).amount_minor,50);
});
