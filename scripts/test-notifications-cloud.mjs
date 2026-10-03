// Explicit opt-in cloud test. Creates isolated Auth users (no emails sent), task,
// submissions and inbox events; finally removes only this run's tracked fixtures.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';
import { randomUUID } from 'node:crypto';

if (!process.argv.includes('--cloud')) throw new Error('Pass --cloud to run against Supabase.');
const envPath = process.env.NOTIFICATIONS_TEST_ENV ?? 'backend/.env.local';
const env = { ...parseEnv(readFileSync(envPath, 'utf8')), ...process.env };
const base = env.SUPABASE_URL;
const key = env.SUPABASE_SERVICE_ROLE_KEY;
assert.equal(base, 'https://myjdykfmxspqtgbuoqdt.supabase.co', 'Unexpected project; refusing to run');
assert.ok(key, 'Missing service credential');
const run = randomUUID();
const users = [];
const tasks = [];
const submissions = [];
const api = '/functions/v1/notifications/v1';
const serviceHeaders = { apikey: key, Authorization: `Bearer ${key}` };
let checks = 0;
function ok(label) { checks++; console.log(`PASS ${label}`); }

async function call(path, { method = 'GET', body, token, service = false, headers = {} } = {}) {
  const response = await fetch(base + path, {
    method,
    headers: {
      apikey: key, ...(service ? serviceHeaders : token ? { Authorization: `Bearer ${token}` } : {}),
      'Content-Type': 'application/json', ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(30000),
  });
  const text = await response.text();
  let data;
  try { data = JSON.parse(text); } catch { data = null; }
  // Do not print response bodies: auth responses contain credentials.
  return { status: response.status, data, headers: response.headers };
}
async function insert(table, body) {
  const result = await call(`/rest/v1/${table}`, {
    method: 'POST', service: true, body, headers: { Prefer: 'return=representation' },
  });
  assert.equal(result.status, 201, `Insert ${table} failed (${result.data?.code ?? ''})`);
  return result.data[0];
}
async function account(label) {
  const email = `notifications-${label}-${run}@example.com`;
  const password = randomUUID() + randomUUID();
  const created = await call('/auth/v1/admin/users', {
    method: 'POST', service: true,
    body: { email, password, email_confirm: true, app_metadata: { notifications_test_run: run } },
  });
  assert.ok([200, 201].includes(created.status), `Create test user failed: ${created.status}`);
  const id = created.data.id;
  users.push(id);
  const login = await call('/auth/v1/token?grant_type=password', { method: 'POST', body: { email, password } });
  assert.equal(login.status, 200, 'Test login failed');
  return { id, token: login.data.access_token };
}
async function list(user, query = '') {
  const result = await call(api + '/me/notifications' + query, { token: user.token });
  assert.equal(result.status, 200, `List failed (${result.data?.code ?? ''})`);
  return result.data;
}
async function seedSubmission(task, tester) {
  const s = await insert('submissions', { task_id: task.id, tester_id: tester.id });
  submissions.push(s.id);
  const revision = await insert('submission_revisions', {
    submission_id: s.id, revision_no: 1, operation_notes: 'Isolated notification integration fixture.',
    answers: [{ question_key: 'experience', selected_option_key: 'yes', reason: 'Cloud test' }], evidence_ids: [],
  });
  const update = await call(`/rest/v1/submissions?id=eq.${s.id}`, {
    method: 'PATCH', service: true, body: { current_revision_id: revision.id },
  });
  assert.equal(update.status, 204);
  return { ...s, current_revision_id: revision.id };
}
async function decision(publisher, submission, action, reason, idem = randomUUID()) {
  const result = await call(`/functions/v1/submissions/v1/submissions/${submission.id}/decisions`, {
    token: publisher.token, method: 'POST', headers: { 'Idempotency-Key': idem },
    body: { action, reason, expected_revision_id: submission.current_revision_id, expected_version: submission.version },
  });
  assert.equal(result.status, 200, `Decision failed (${result.data?.code ?? ''})`);
  return result.data;
}

try {
  const publisher = await account('publisher');
  const tester = await account('tester');
  const other = await account('other');
  const config = {
    title: `Notification test ${run}`, app_name: 'Notification test', app_type: 'web',
    app_url: 'https://example.com', experience_instructions: 'Test fixture only',
    task_description: 'Cloud notification integration test', evidence_types: ['image'],
    evidence_instructions: 'Test fixture only', reward_amount_minor: 0, budget_amount_minor: 0,
    currency: 'USD', display_timezone: 'UTC', duration_seconds: 3600,
    questions: [{ question_key: 'experience', prompt: 'Did this work?', type: 'single_choice',
      reason_required: true, options: [{ option_key: 'yes', label: 'Yes' }, { option_key: 'no', label: 'No' }] }],
  };
  const task = await insert('tasks', {
    publisher_id: publisher.id, config, published_config: config, status: 'published',
    deadline_at: new Date(Date.now() + 3600000).toISOString(),
  });
  tasks.push(task.id);
  assert.deepEqual(await list(tester), { items: [], next_cursor: null, unread_count: 0 });
  ok('authenticated empty inbox');

  assert.equal((await call(api + '/me/notifications')).status, 401);
  assert.equal((await call(api + '/me/notifications', { token: 'invalid-token' })).status, 401);
  const options = await call(api + '/me/notifications', { method: 'OPTIONS' });
  assert.equal(options.status, 204);
  assert.equal(options.headers.get('access-control-allow-origin'), '*');
  ok('missing/invalid JWT rejected; browser preflight allowed');

  let submission = await seedSubmission(task, tester);
  let publisherInbox = await list(publisher);
  assert.equal(publisherInbox.items.length, 1);
  assert.equal(publisherInbox.items[0].type, 'submission_received');
  assert.equal(publisherInbox.items[0].entity_id, submission.id);
  ok('new submission transaction creates publisher notification');

  const original = { ...submission };
  const idem = randomUUID();
  submission = await decision(publisher, original, 'request_changes', 'Please add evidence of the blocked step.', idem);
  await decision(publisher, original, 'request_changes', 'Please add evidence of the blocked step.', idem);
  let inbox = await list(tester);
  assert.equal(inbox.items.length, 1);
  assert.equal(inbox.items[0].type, 'changes_requested');
  assert.equal(inbox.items[0].body, 'Please add evidence of the blocked step.');
  assert.equal(inbox.unread_count, 1);
  assert.equal('event_key' in inbox.items[0], false);
  assert.equal('recipient_id' in inbox.items[0], false);
  ok('real decision API creates notification once across idempotent replay');
  const notificationId = inbox.items[0].id;

  assert.equal((await list(other)).items.length, 0);
  assert.equal((await call(`${api}/notifications/${notificationId}/read`, { method: 'POST', token: other.token })).status, 404);
  assert.equal((await call(`${api}/notifications/${randomUUID()}/read`, { method: 'POST', token: tester.token })).status, 404);
  const directOther = await call(`/rest/v1/notifications?id=eq.${notificationId}`, { token: other.token });
  assert.equal(directOther.status, 200);
  assert.deepEqual(directOther.data, []);
  const foreignRpc = await call('/rest/v1/rpc/mark_notification_read', {
    method: 'POST', token: other.token, body: { p_id: notificationId },
  });
  assert.equal(foreignRpc.status, 200);
  assert.deepEqual(foreignRpc.data, []);
  ok('cross-user list/read blocked by both API and database');

  const attempts = await Promise.all(Array.from({ length: 3 }, () => call(`${api}/notifications/${notificationId}/read`, {
    method: 'POST', token: tester.token, body: { read_at: '2000-01-01', recipient_id: other.id },
  })));
  attempts.forEach(r => assert.equal(r.status, 200));
  const readAt = attempts[0].data.read_at;
  assert.ok(readAt && !readAt.startsWith('2000'));
  attempts.forEach(r => assert.equal(r.data.read_at, readAt));
  assert.equal((await list(tester)).unread_count, 0);
  assert.equal((await list(tester, '?unread_only=true')).items.length, 0);
  ok('concurrent mark-read is idempotent; unread filter/count update');

  const forbiddenInsert = await call('/rest/v1/notifications', {
    method: 'POST', token: tester.token,
    body: { recipient_id: other.id, task_id: task.id, entity_id: submission.id, type: 'review_reminder', event_key: run, title: 'Forged' },
  });
  assert.equal(forbiddenInsert.status, 403);
  for (const [method, body] of [['PATCH', { title: 'Forged' }], ['DELETE', undefined]]) {
    assert.equal((await call(`/rest/v1/notifications?id=eq.${notificationId}`, { method, body, token: tester.token })).status, 403);
  }
  ok('clients cannot create, edit content, or delete notifications through REST');

  const revision = await insert('submission_revisions', {
    submission_id: submission.id, revision_no: 2, operation_notes: 'Additional evidence description.',
    answers: [{ question_key: 'experience', selected_option_key: 'yes', reason: 'Updated explanation' }], evidence_ids: [],
  });
  assert.equal((await call(`/rest/v1/submissions?id=eq.${submission.id}`, {
    method: 'PATCH', service: true, body: { current_revision_id: revision.id, processing_status: 'awaiting_publisher', version: submission.version + 1 },
  })).status, 204);
  submission = { ...submission, current_revision_id: revision.id, version: submission.version + 1 };
  publisherInbox = await list(publisher);
  assert.equal(publisherInbox.items.length, 2);
  assert.equal(publisherInbox.items[0].type, 'submission_revised');
  await decision(publisher, submission, 'accept', 'Thanks for the additional detail.');
  inbox = await list(tester);
  assert.equal(inbox.items[0].type, 'submission_accepted');
  assert.equal(inbox.unread_count, 1);
  const otherSubmission = await seedSubmission(task, other);
  await decision(publisher, otherSubmission, 'decline', 'The evidence was for a different task.');
  assert.equal((await list(other)).items[0].type, 'submission_declined');
  ok('revision, accept, and decline events reach their correct recipients');

  const sameTime = new Date(Date.now() + 1000).toISOString();
  for (let i = 0; i < 3; i++) await insert('notifications', {
    recipient_id: tester.id, task_id: task.id, entity_id: submission.id, type: 'review_reminder',
    event_key: `${run}:page:${i}`, title: `Pagination fixture ${i}`, created_at: sameTime,
  });
  const duplicate = await call('/rest/v1/notifications', { method: 'POST', service: true, body: {
    recipient_id: tester.id, task_id: task.id, entity_id: submission.id, type: 'review_reminder',
    event_key: `${run}:page:0`, title: 'Duplicate',
  } });
  assert.equal(duplicate.status, 409);
  const expectedIds = (await list(tester)).items.map(n => n.id);
  const paged = [];
  let cursor = null;
  do {
    const page = await list(tester, '?limit=2' + (cursor ? '&cursor=' + encodeURIComponent(cursor) : ''));
    assert.equal(page.unread_count, 4);
    paged.push(...page.items.map(n => n.id));
    cursor = page.next_cursor;
    assert.ok(paged.length <= expectedIds.length, 'Pagination must terminate');
  } while (cursor);
  assert.deepEqual(paged, expectedIds);
  assert.equal(new Set(paged).size, expectedIds.length);
  ok('stable newest-first cursor pagination handles equal timestamps; event keys deduplicate');

  for (const query of ['?limit=0', '?limit=101', '?limit=1.5', '?cursor=bad', '?unread_only=yes', `?recipient_id=${other.id}`]) {
    assert.equal((await call(api + '/me/notifications' + query, { token: tester.token })).status, 422);
  }
  assert.equal((await call(`${api}/notifications/bad/read`, { method: 'POST', token: tester.token })).status, 422);
  assert.equal((await call(api + '/me/notifications', { method: 'POST', token: tester.token })).status, 405);
  const cached = await call(api + '/me/notifications', { token: tester.token });
  assert.equal(cached.headers.get('cache-control'), 'no-store');
  assert.ok(cached.headers.get('x-request-id'));
  ok('invalid input rejected and private responses never cached');
  console.log(`Cloud assertions passed: ${checks} groups`);
} finally {
  const failures = [];
  async function remove(table, query) {
    const result = await call(`/rest/v1/${table}?${query}`, { method: 'DELETE', service: true });
    if (result.status !== 204) failures.push(`${table}:${result.status}`);
  }
  if (submissions.length) {
    const filter = `in.(${submissions.join(',')})`;
    const nullRefs = await call(`/rest/v1/submissions?id=${filter}`, { method: 'PATCH', service: true, body: { current_revision_id: null } });
    if (nullRefs.status !== 204) failures.push('clear test revision references');
    // This fixture never creates AI jobs, evidence, or Storage objects.
    await remove('submission_decisions', `submission_id=${filter}`);
    await remove('submission_revisions', `submission_id=${filter}`);
    await remove('submissions', `id=${filter}`);
  }
  if (users.length) await remove('submission_api_requests', `principal_id=in.(${users.join(',')})`);
  if (tasks.length) {
    await remove('notifications', `task_id=in.(${tasks.join(',')})`);
    await remove('tasks', `id=in.(${tasks.join(',')})`);
  }
  for (const id of users) {
    const result = await call(`/auth/v1/admin/users/${id}`, { method: 'DELETE', service: true });
    if (result.status !== 200) failures.push(`test user ${id}: ${result.status}`);
  }
  assert.deepEqual(failures, [], `Test fixture cleanup incomplete: ${failures.join(', ')}`);
  console.log('CLEANUP complete: removed this run’s fixtures and test users');
}
