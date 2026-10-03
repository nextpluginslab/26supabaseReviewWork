import { before, after, beforeEach, afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
const tester='10000000-0000-4000-8000-000000000001';
const stranger='10000000-0000-4000-8000-000000000002';
let db;
const rpc=async(action,actor=null,data={})=>(await db.query('select reward_claim_command($1,$2::uuid,$3::jsonb) result',[action,actor,JSON.stringify(data)])).rows[0].result;
async function reward(amount=200) {
  const id=crypto.randomUUID();
  await db.query(`insert into payment_rewards(id,task_id,submission_id,tester_id,decision_id,amount_minor,state)
    values($1,$2,$3,$4,$5,$6,$7)`,[id,'20000000-0000-4000-8000-000000000001',crypto.randomUUID(),tester,crypto.randomUUID(),amount,amount?'pending':'not_required']);
  return id;
}
before(async()=>{
  db=new PGlite();
  await db.exec(`create role anon; create role authenticated; create role service_role;
    create schema auth; create table auth.users(id uuid primary key);
    insert into auth.users values('${tester}'),('${stranger}');`);
  for(const file of ['20261003000100_payments.sql','20261004005000_reward_claims.sql'])
    await db.exec(await readFile(new URL('../../supabase/migrations/'+file,import.meta.url),'utf8'));
  await db.query(`insert into payment_task_accounts(task_id,publisher_id,budget_amount_minor,reward_amount_minor) values($1,$2,1000,200)`,['20000000-0000-4000-8000-000000000001',stranger]);
});
after(async()=>db.close());
beforeEach(async()=>db.exec('begin'));
afterEach(async()=>db.exec('rollback'));
test('paid rewards enqueue one email; free feedback never sends a claim',async()=>{
  const id=await reward(); await reward(0);
  assert.equal((await db.query('select count(*)::int n from reward_claim_emails')).rows[0].n,1);
  const job=await rpc('claim_email');
  assert.equal(job.reward_id,id); assert.equal(job.tester_id,tester);
  assert.equal(await rpc('claim_email'),null);
  await rpc('email_sent',null,{id,lease_id:job.lease_id});
  assert.equal(await rpc('claim_email'),null);
});
test('recipient ownership is enforced and no account or transfer details are exposed',async()=>{
  const id=await reward();
  assert.deepEqual(await rpc('reward',tester,{id}),{id,amount_minor:200,currency:'usd',state:'pending'});
  await assert.rejects(()=>rpc('reward',stranger,{id}),/Reward not found/);
});
test('failed email retries and a stale lease cannot complete a newer delivery',async()=>{
  const id=await reward(); const first=await rpc('claim_email');
  await rpc('email_failed',null,{id,lease_id:first.lease_id});
  assert.equal(await rpc('claim_email'),null);
  await db.exec("update reward_claim_emails set next_run_at=now()-interval '1 second'");
  const second=await rpc('claim_email');
  assert.notEqual(first.lease_id,second.lease_id);
  await rpc('email_sent',null,{id,lease_id:first.lease_id});
  assert.equal((await db.query('select sent_at from reward_claim_emails')).rows[0].sent_at,null);
  await rpc('email_sent',null,{id,lease_id:second.lease_id});
  assert.ok((await db.query('select sent_at from reward_claim_emails')).rows[0].sent_at);
});
test('queue rolls back with reward authorization and is unavailable to browser roles',async()=>{
  await db.exec('savepoint decision'); await reward(); await db.exec('rollback to decision');
  assert.equal(await rpc('claim_email'),null);
  for(const role of ['anon','authenticated']) {
    assert.equal((await db.query("select has_function_privilege($1,'reward_claim_command(text,uuid,jsonb)','EXECUTE') allowed",[role])).rows[0].allowed,false);
    assert.equal((await db.query("select has_table_privilege($1,'reward_claim_emails','SELECT') allowed",[role])).rows[0].allowed,false);
  }
});
