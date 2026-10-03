// Creates only disposable confirmed test users; deletes them and their task data in finally.
// CLI keys and session tokens remain in memory and are never printed.
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
const ref = 'myjdykfmxspqtgbuoqdt';
const base = `https://${ref}.supabase.co`;
const api = `${base}/functions/v1/api/v1`;
const keys = JSON.parse(execFileSync('supabase',['projects','api-keys','--project-ref',ref,'--output','json'],{encoding:'utf8',stdio:['ignore','pipe','pipe']}));
const service = keys.find(k=>k.name==='service_role')?.api_key;
const anon = keys.find(k=>k.name==='anon')?.api_key;
assert(service && anon,'CLI project keys unavailable');
const admin = {apikey:service,Authorization:`Bearer ${service}`,'Content-Type':'application/json'};
const users=[];let passed=0;
const config={title:'[API smoke test] temporary',app_name:'Smoke product',app_type:'web',app_url:'https://example.com',experience_instructions:'Open the page',task_description:'Try navigation',evidence_types:['image','video'],evidence_instructions:'Show the page',questions:[{question_key:'ease',prompt:'Easy to use?',type:'single_choice',reason_required:true,options:[{option_key:'yes',label:'Yes'},{option_key:'no',label:'No'}]}],reward_amount_minor:0,budget_amount_minor:0,currency:'USD',duration_seconds:3600,display_timezone:'UTC'};
async function raw(url,options={}) { const r=await fetch(url,{...options,signal:AbortSignal.timeout(30000)}); const text=await r.text();let data;try{data=JSON.parse(text);}catch{data={};}return {status:r.status,data}; }
async function account(){const email=`task-api-${crypto.randomUUID()}@example.com`,password=`Aa1!${crypto.randomUUID()}`;const created=await raw(`${base}/auth/v1/admin/users`,{method:'POST',headers:admin,body:JSON.stringify({email,password,email_confirm:true})});assert.equal(created.status,200,'Create temporary user');users.push(created.data.id);const login=await raw(`${base}/auth/v1/token?grant_type=password`,{method:'POST',headers:{apikey:anon,'Content-Type':'application/json'},body:JSON.stringify({email,password})});assert.equal(login.status,200,'Login temporary user');return login.data.access_token;}
async function call(path,{token,method='GET',body,key}={}){return raw(`${api}${path}`,{method,headers:{apikey:anon,...(token?{Authorization:`Bearer ${token}`} : {}),...(body?{'Content-Type':'application/json'}:{}),...(key?{'Idempotency-Key':key}:{})},...(body?{body:JSON.stringify(body)}:{})});}
function check(name,value){assert(value,name);passed++;console.log(`PASS ${name}`);}
try {
 const owner=await account(), other=await account();
 check('anonymous private request rejected',(await call('/tasks')).status===401);
 check('invalid bearer rejected',(await call('/tasks',{token:'invalid'})).status===401);
 check('missing idempotency key rejected',(await call('/tasks',{token:owner,method:'POST',body:{config}})).status===422);
 check('spoofed owner rejected',(await call('/tasks',{token:owner,method:'POST',key:crypto.randomUUID(),body:{config,publisher_id:users[1]}})).status===422);
 check('malformed question rejected',(await call('/tasks',{token:owner,method:'POST',key:crypto.randomUUID(),body:{config:{...config,questions:[{...config.questions[0],question_key:undefined}]}}})).status===422);
 const key=crypto.randomUUID();const created=await call('/tasks',{token:owner,method:'POST',key,body:{config}});check('create task',created.status===201);let task=created.data.task;const id=task.id;
 const replay=await call('/tasks',{token:owner,method:'POST',key,body:{config}});check('create idempotency',replay.data.task.id===id);
 check('idempotency conflict',(await call('/tasks',{token:owner,method:'POST',key,body:{config:{...config,title:'changed'}}})).status===409);
 check('owner detail',(await call(`/tasks/${id}`,{token:owner})).status===200);
 check('other user cannot read',(await call(`/tasks/${id}`,{token:other})).status===404);
 check('other user list empty',(await call('/tasks',{token:other})).data.tasks.length===0);
 check('draft is not public',(await call(`/public/tasks/${task.public_slug}`)).status===404);
 check('direct authenticated table access denied',(await raw(`${base}/rest/v1/tasks?select=id`,{headers:{apikey:anon,Authorization:`Bearer ${owner}`}})).status===403);
 check('direct anonymous table access denied',[401,403].includes((await raw(`${base}/rest/v1/tasks?select=id`,{headers:{apikey:anon}})).status));
 check('direct RPC denied',(await raw(`${base}/rest/v1/rpc/mutate_task`,{method:'POST',headers:{apikey:anon,Authorization:`Bearer ${owner}`,'Content-Type':'application/json'},body:JSON.stringify({p_actor:users[0],p_action:'create',p_task:null,p_config:config,p_version:null,p_key:crypto.randomUUID(),p_hash:'x'})})).status===403);
 const updates=await Promise.all([1,2].map(n=>call(`/tasks/${id}`,{token:owner,method:'PATCH',key:crypto.randomUUID(),body:{version:1,config:{...config,title:`Updated ${n}`}}})));
 check('concurrent edit has one winner',updates.filter(r=>r.status===200).length===1&&updates.filter(r=>r.status===409).length===1);
 const updated=updates.find(r=>r.status===200).data.task;
 check('question UUID stays stable',updated.config.questions[0].id===task.config.questions[0].id);
 check('cross-owner publish denied',(await call(`/tasks/${id}/publish`,{token:other,method:'POST',key:crypto.randomUUID(),body:{version:2}})).status===404);
 const publishKey=crypto.randomUUID();const pub=await call(`/tasks/${id}/publish`,{token:owner,method:'POST',key:publishKey,body:{version:2}});check('publish free task',pub.status===200&&pub.data.task.status==='published');task=pub.data.task;
 check('publish idempotency',(await call(`/tasks/${id}/publish`,{token:owner,method:'POST',key:publishKey,body:{version:2}})).data.task.version===task.version);
 const publicResult=await call(`/public/tasks/${task.public_slug}`);check('public read and accepting state',publicResult.status===200&&publicResult.data.task.accepting_submissions);
 check('public projection hides private fields',!['publisher_id','budget_amount_minor','config','question_registry'].some(k=>k in publicResult.data.task));
 check('published config immutable',(await call(`/tasks/${id}`,{token:owner,method:'PATCH',key:crypto.randomUUID(),body:{version:task.version,config}})).status===409);
 const close=await call(`/tasks/${id}/close`,{token:owner,method:'POST',key:crypto.randomUUID(),body:{version:task.version}});check('close task',close.status===200&&close.data.task.status==='closed');
 check('closed task still visible but not accepting',!(await call(`/public/tasks/${task.public_slug}`)).data.task.accepting_submissions);
 const paid=await call('/tasks',{token:owner,method:'POST',key:crypto.randomUUID(),body:{config:{...config,reward_amount_minor:100,budget_amount_minor:1000}}});
 const blocked=await call(`/tasks/${paid.data.task.id}/publish`,{token:owner,method:'POST',key:crypto.randomUUID(),body:{version:1}});check('paid publication requires real funding',blocked.status===409&&blocked.data.error.code==='funding_required');
 const {duration_seconds,...absolute}=config;
 const expired=await call('/tasks',{token:owner,method:'POST',key:crypto.randomUUID(),body:{config:{...absolute,deadline_at:'2000-01-01T00:00:00Z'}}});check('expired deadline cannot publish',(await call(`/tasks/${expired.data.task.id}/publish`,{token:owner,method:'POST',key:crypto.randomUUID(),body:{version:1}})).status===422);
 const list=await call('/tasks?limit=1',{token:owner});check('cursor pagination',(await call(`/tasks?limit=1&cursor=${list.data.next_cursor}`,{token:owner})).data.tasks[0].id!==list.data.tasks[0].id);
 check('invalid pagination rejected',(await call('/tasks?limit=999',{token:owner})).status===422);
 console.log(`Passed ${passed} live API checks.`);
} finally {
 for(const id of users){const r=await raw(`${base}/auth/v1/admin/users/${id}`,{method:'DELETE',headers:admin});assert.equal(r.status,200,`Cleanup failed for test user ${id}`);}
 console.log(`Cleaned up ${users.length} temporary users and their task data.`);
}
