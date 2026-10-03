// Explicit cloud integration: temporary users/tasks only; no email or Stripe calls.
import assert from 'node:assert/strict';
const base=process.env.SUPABASE_URL,service=process.env.SUPABASE_SERVICE_ROLE_KEY;
assert.equal(base,'https://myjdykfmxspqtgbuoqdt.supabase.co');assert.ok(service);
const users=[],tasks=[],objects=[],checks=[];const tag=`frontend-integration-${crypto.randomUUID()}`;
async function http(path,{token,method='GET',body,key,admin=false}={}){const r=await fetch(base+path,{method,headers:{apikey:service,...(token?{Authorization:`Bearer ${token}`} : {}),...(body!==undefined?{'Content-Type':'application/json'}:{}),...(key?{'Idempotency-Key':key}:{}),...(admin?{Prefer:'return=representation'}:{})},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(30000)});return {status:r.status,data:await r.json().catch(()=>null)};}
async function admin(path,method='GET',body){const r=await http(path,{token:service,method,body,admin:true});assert.ok(r.status<300,`Fixture ${method} ${path.split('?')[0]} failed: ${r.status}`);return r.data;}
async function api(fn,path,token,body,expected=200,key=crypto.randomUUID()){const r=await http(`/functions/v1/${fn}${fn==='api-keys'?'':'/v1'}${path}`,{token,method:body===undefined?'GET':'POST',body,key});assert.equal(r.status,expected,`${fn}${path}: ${r.status} (${r.data?.code||r.data?.error?.code||'unknown'})`);return r.data;}
function check(name,condition){assert.ok(condition,name);checks.push(name);console.log('PASS '+name);}
async function user(suffix){const email=`${tag}-${suffix}@example.com`,password=crypto.randomUUID()+'Aa1!';const u=await admin('/auth/v1/admin/users','POST',{email,password,email_confirm:true,app_metadata:{purpose:'frontend-integration'}});users.push(u.id);const r=await http('/auth/v1/token?grant_type=password',{method:'POST',body:{email,password}});assert.equal(r.status,200);return {id:u.id,token:r.data.access_token,email,session:r.data};}
async function cleanup(){const errors=[];const remove=async(path,method='DELETE',body)=>{try{await admin(path,method,body);}catch(e){errors.push(e.message);}};
 if(objects.length)await remove('/storage/v1/object/submission-evidence','DELETE',{prefixes:objects});
 for(const id of tasks){const rows=await admin(`/rest/v1/submissions?task_id=eq.${id}&select=id`);const ids=rows.map(x=>x.id);if(ids.length){const q=`in.(${ids.join(',')})`;const revs=await admin(`/rest/v1/submission_revisions?submission_id=${q}&select=id`);await remove(`/rest/v1/payment_rewards?task_id=eq.${id}`);await remove(`/rest/v1/submissions?id=${q}`,'PATCH',{current_revision_id:null});await remove(`/rest/v1/submission_decisions?submission_id=${q}`);if(revs.length)await remove(`/rest/v1/submission_jobs?revision_id=in.(${revs.map(x=>x.id).join(',')})`);await remove(`/rest/v1/submission_revisions?submission_id=${q}`);await remove(`/rest/v1/submissions?id=${q}`);}
 await remove(`/rest/v1/submission_evidence?task_id=eq.${id}`);await remove(`/rest/v1/payment_task_accounts?task_id=eq.${id}`);await remove(`/rest/v1/tasks?id=eq.${id}`);}
 for(const id of users){await remove(`/rest/v1/submission_api_requests?principal_id=eq.${id}`);await remove(`/auth/v1/admin/users/${id}`);}
 assert.deepEqual(errors,[],'Temporary fixture cleanup must succeed');
}
try{
 const publisher=await user('publisher'),tester=await user('tester'),other=await user('other');
 const key=await api('api-keys','/',publisher.token,{name:tag,scopes:['tasks:read','tasks:write','submissions:read','insights:read']},201);
 const config={title:tag,app_name:'Integration product',app_type:'web',app_url:'https://example.com',experience_instructions:'',task_description:'',evidence_types:['image'],evidence_instructions:'',questions:[],reward_amount_minor:0,budget_amount_minor:0,currency:'USD',duration_seconds:3600,display_timezone:'UTC'};
 let {task}=await api('api','/tasks',key.key,{config},201);tasks.push(task.id);check('agent creates owned task with zero optional questions',task.config.questions.length===0);
 ({task}=await api('api',`/tasks/${task.id}/publish`,key.key,{version:task.version}));check('agent publishes free task',task.status==='published');
 const publicRow=await api('api',`/public/tasks/${task.public_slug}`,undefined);check('anonymous public task excludes budget and owner',!('budget_amount_minor' in publicRow.task)&&!('publisher_id' in publicRow.task));
 await api('api',`/public/tasks/${task.id}`,undefined);await api('api',`/tasks/${task.id}/results`,other.token,undefined,404);check('result ownership boundary',true);
 const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6VZkAAAAASUVORK5CYII=','base64');
 const upload=await api('submissions','/uploads',tester.token,{task_id:task.id,name:'proof.png',mime_type:'image/png',size_bytes:png.length},201);objects.push(upload.path);
 const put=await fetch(upload.upload_url,{method:'PUT',headers:{'Content-Type':'image/png'},body:png});assert.ok(put.ok);check('private signed upload',true);
 const body={operation_notes:'I got stuck. Negative feedback is valid.',answers:[],evidence_ids:[upload.id]},requestKey=crypto.randomUUID();
 let s=await api('submissions',`/tasks/${task.id}/submissions`,tester.token,body,201,requestKey);
 const duplicate=await api('submissions',`/tasks/${task.id}/submissions`,tester.token,body,201,requestKey);check('formal submit is idempotent',duplicate.id===s.id);
 let results=await api('api',`/tasks/${task.id}/results`,publisher.token);check('SQL statistics and AI result endpoint',results.statistics.total_submissions===1&&results.budget.pending===0);
 await api('api',`/tasks/${task.id}/results`,key.key);await api('submissions',`/tasks/${task.id}/submissions`,key.key);check('agent can read publisher results/submissions',true);
 await api('submissions',`/submissions/${s.id}/decisions`,key.key,{action:'accept',expected_revision_id:s.current_revision_id,expected_version:s.version},403);check('agent cannot make human decisions',true);
 const detail=await api('submissions',`/submissions/${s.id}`,publisher.token);check('publisher evidence and AI projection',detail.evidence.length===1&&detail.revisions[0].ai.status);
 const read=await fetch(detail.evidence[0].url);assert.ok(read.ok);
 s=await api('submissions',`/submissions/${s.id}/decisions`,publisher.token,{action:'request_changes',reason:'Please explain the blocker.',expected_revision_id:s.current_revision_id,expected_version:s.version});
 let inbox=await api('notifications','/me/notifications',tester.token);check('request-changes notification',inbox.items.some(n=>n.type==='changes_requested'));
 await api('api',`/tasks/${task.id}/close`,publisher.token,{version:task.version});
 s=await api('submissions',`/submissions/${s.id}/revisions`,tester.token,{...body,operation_notes:'Added blocker explanation',expected_revision_id:s.current_revision_id,expected_version:s.version},201);check('closed task permits requested revision',s.version===3);
 s=await api('submissions',`/submissions/${s.id}/decisions`,publisher.token,{action:'accept',confirm_payment:true,expected_revision_id:s.current_revision_id,expected_version:s.version});check('free acceptance creates no payable reward',s.processing_status==='accepted'&&s.payment_status==='not_required');
 const latest=await api('submissions',`/submissions/${s.id}`,tester.token);check('history and payment projection remain consistent',latest.revisions.length===2&&latest.reward.state==='not_required');
 results=await api('api',`/tasks/${task.id}/results`,publisher.token);check('revision does not increase response count',results.statistics.total_submissions===1);
 inbox=await api('notifications','/me/notifications',tester.token);await api('notifications',`/notifications/${inbox.items[0].id}/read`,tester.token,{});check('notification mark read',true);
 const revoked=await http(`/functions/v1/api-keys/${key.api_key.id}`,{token:publisher.token,method:'DELETE'});assert.equal(revoked.status,200);await api('api','/tasks',key.key,undefined,401);check('revoked agent key loses business access',true);
 const payment=await api('payments','/me/connect-account',tester.token,undefined,503);check('missing Stripe config is explicit, never simulated success',payment.code==='payments_not_configured');
 if(process.env.FRONTEND_TEST_URL){
  const {chromium}=await import('../../frontend/node_modules/playwright/index.mjs');const browser=await chromium.launch({channel:'chrome',headless:true});try{const page=await browser.newPage();await page.addInitScript(({session})=>localStorage.setItem('sb-myjdykfmxspqtgbuoqdt-auth-token',JSON.stringify(session)),{session:publisher.session});await page.goto(`${process.env.FRONTEND_TEST_URL}/tasks/${task.id}/results`);await page.getByRole('heading',{name:'Results',exact:true}).waitFor();await page.getByRole('button',{name:/Tester /}).first().click();await page.getByRole('heading',{name:'Revision history'}).waitFor();await page.getByRole('button',{name:/proof.png/}).waitFor();await page.screenshot({path:'/tmp/reviewwork-live-results.png',fullPage:true});check('browser uses real Auth, task, submission, budget and AI APIs',true);}finally{await browser.close();}
 }
}finally{await cleanup();}
console.log(JSON.stringify({result:'PASS',checks:checks.length,cleanup:'verified',project:'myjdykfmxspqtgbuoqdt'}));
