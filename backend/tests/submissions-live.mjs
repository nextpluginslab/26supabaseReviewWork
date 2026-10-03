// Run explicitly against the authorized project. Creates only tagged, temporary fixtures.
// node --env-file=<backend env path> backend/tests/submissions-live.mjs
import assert from "node:assert/strict";
const base = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
assert.equal(base, "https://myjdykfmxspqtgbuoqdt.supabase.co");
assert.ok(key, "Missing service role key");
const api = base + "/functions/v1/submissions/v1";
const tag = "submissions-smoke-" + crypto.randomUUID();
const users = [], tasks = [], files = [];
let checks = 0;
async function request(
  url,
  { token = key, method = "GET", body, extra = {} } = {},
) {
  const r = await fetch(url, {
    method,
    headers: {
      apikey: key,
      Authorization: "Bearer " + token,
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      ...extra,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const raw = await r.text();
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    data = raw;
  }
  return { status: r.status, data };
}
async function admin(path, method = "GET", body) {
  const r = await request(base + path, {
    method,
    body,
    extra: { Prefer: "return=representation" },
  });
  assert.ok(
    r.status < 300,
    `${method} ${path.split("?")[0]}: ${r.status} ${JSON.stringify(r.data)}`,
  );
  return r.data;
}
async function user(name, confirmed = true) {
  const email = `${tag}-${name}@example.com`,
    password = crypto.randomUUID() + "aA!1";
  const u = await admin("/auth/v1/admin/users", "POST", {
    email,
    password,
    email_confirm: confirmed,
  });
  users.push(u.id);
  if (!confirmed) return { ...u, email, password };
  const signed = await admin("/auth/v1/token?grant_type=password", "POST", {
    email,
    password,
  });
  return { ...u, token: signed.access_token };
}
async function call(
  path,
  actor,
  {
    method = "GET",
    body,
    key: idem = crypto.randomUUID(),
    status = 200,
    code,
  } = {},
) {
  const r = await request(api + path, {
    token: actor?.token ?? "invalid",
    method,
    body,
    extra: { "Idempotency-Key": idem },
  });
  assert.equal(
    r.status,
    status,
    `${method} ${path}: ${JSON.stringify(r.data)}`,
  );
  if (code) assert.equal(r.data.code, code);
  checks++;
  return r.data;
}
async function makeTask(publisher, patch = {}) {
  const config = {
    title: tag,
    app_name: "Smoke product",
    app_type: "web",
    app_url: "https://example.com",
    experience_instructions: "Open product",
    task_description: "Try it",
    evidence_types: ["image"],
    evidence_instructions: "Screenshot",
    reward_amount_minor: 0,
    budget_amount_minor: 0,
    currency: "USD",
    display_timezone: "UTC",
    questions: [{
      question_key: "choice",
      prompt: "Would you use this?",
      type: "single_choice",
      reason_required: true,
      options: [{ option_key: "yes", label: "Yes" }, {
        option_key: "no",
        label: "No",
      }],
    }],
  };
  const [t] = await admin("/rest/v1/tasks", "POST", {
    publisher_id: publisher.id,
    status: "published",
    config,
    published_config: config,
    deadline_at: new Date(Date.now() + 3600000).toISOString(),
    published_at: new Date().toISOString(),
    ...patch,
  });
  tasks.push(t.id);
  return t;
}
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6VZkAAAAASUVORK5CYII=",
  "base64",
);
async function upload(t, actor, bytes = png) {
  const u = await call("/uploads", actor, {
    method: "POST",
    body: {
      task_id: t.id,
      name: "proof.png",
      mime_type: "image/png",
      size_bytes: bytes.length,
    },
    status: 201,
  });
  files.push(u.path);
  const r = await fetch(u.upload_url, {
    method: "PUT",
    headers: { "Content-Type": "image/png" },
    body: bytes,
  });
  assert.ok(r.ok, "Signed upload failed: " + r.status);
  checks++;
  return u;
}
try {
  const publisher = await user("publisher"),
    tester = await user("tester"),
    other = await user("other");
  const t = await makeTask(publisher),
    expired = await makeTask(publisher, {
      deadline_at: new Date(Date.now() - 60000).toISOString(),
    });
  await call("/me/submissions", null, { status: 401 });
  const missing = await fetch(api + "/me/submissions");
  assert.equal(missing.status, 401);
  checks++;
  const options = await fetch(api + "/me/submissions", { method: "OPTIONS" });
  assert.equal(options.status, 204);
  checks++;
  const proof = await upload(t, tester);
  const body = {
    answers: [{
      question_key: "choice",
      selected_option_key: "no",
      reason: "I could not finish the workflow.",
    }],
    operation_notes: "Got stuck at the first step.",
    evidence_ids: [proof.id],
  };
  await call(`/tasks/${t.id}/submissions`, tester, {
    method: "POST",
    body: { ...body, tester_id: other.id },
    status: 422,
  });
  await call(`/tasks/${t.id}/submissions`, tester, {
    method: "POST",
    body: {
      ...body,
      answers: [{ ...body.answers[0], selected_option_key: "foreign" }],
    },
    status: 422,
    code: "invalid_answers",
  });
  await call(`/tasks/${t.id}/submissions`, other, {
    method: "POST",
    body,
    status: 422,
    code: "invalid_evidence",
  });
  const bad = await upload(
    t,
    tester,
    Buffer.from("this is not a png but has a png content type"),
  );
  await call(`/tasks/${t.id}/submissions`, tester, {
    method: "POST",
    body: { ...body, evidence_ids: [bad.id] },
    status: 422,
    code: "invalid_evidence",
  });
  const intent = await call("/uploads", tester, {
    method: "POST",
    body: {
      task_id: t.id,
      name: "missing.png",
      mime_type: "image/png",
      size_bytes: png.length,
    },
    status: 201,
  });
  await call(`/tasks/${t.id}/submissions`, tester, {
    method: "POST",
    body: { ...body, evidence_ids: [intent.id] },
    status: 422,
    code: "invalid_evidence",
  });
  const idem = crypto.randomUUID();
  const [s, replayed] = await Promise.all([
    call(`/tasks/${t.id}/submissions`, tester, {
      method: "POST",
      body,
      key: idem,
      status: 201,
    }),
    call(`/tasks/${t.id}/submissions`, tester, {
      method: "POST",
      body,
      key: idem,
      status: 201,
    }),
  ]);
  assert.equal(s.id, replayed.id);
  assert.equal(s.processing_status, "awaiting_publisher");
  assert.equal(s.ai_status, "queued");
  checks++;
  await call(`/tasks/${t.id}/submissions`, tester, {
    method: "POST",
    body: { ...body, operation_notes: "different" },
    key: idem,
    status: 409,
    code: "idempotency_conflict",
  });
  await call(`/tasks/${t.id}/submissions`, tester, {
    method: "POST",
    body,
    status: 409,
    code: "already_submitted",
  });
  await call(`/submissions/${s.id}`, other, { status: 404 });
  await call(`/tasks/${t.id}/submissions`, tester, { status: 404 });
  const mine = await call(`/me/submissions?task_id=${t.id}`, tester);
  assert.equal(mine.items.length, 1);
  const list = await call(`/tasks/${t.id}/submissions?limit=1`, publisher);
  assert.equal(list.items.length, 1);
  assert.equal(
    list.items[0].current_revision.answers[0].selected_option_key,
    "no",
  );
  const full = await call(`/submissions/${s.id}`, publisher);
  assert.equal(full.revisions.length, 1);
  assert.equal((await fetch(full.evidence[0].url)).status, 200);
  checks++;
  await call(`/evidence/${proof.id}/read-url`, other, {
    method: "POST",
    status: 404,
  });
  await call(`/evidence/${intent.id}/read-url`, publisher, {
    method: "POST",
    status: 404,
  });
  await call(`/submissions/${s.id}/decisions`, tester, {
    method: "POST",
    body: {
      action: "accept",
      expected_revision_id: s.current_revision_id,
      expected_version: s.version,
    },
    status: 403,
  });
  await call(`/submissions/${s.id}/decisions`, publisher, {
    method: "POST",
    body: {
      action: "request_changes",
      reason: " ",
      expected_revision_id: s.current_revision_id,
      expected_version: s.version,
    },
    status: 422,
  });
  const changed = await call(`/submissions/${s.id}/decisions`, publisher, {
    method: "POST",
    body: {
      action: "request_changes",
      reason: "Please explain the blocker.",
      expected_revision_id: s.current_revision_id,
      expected_version: s.version,
    },
  });
  await admin("/rest/v1/tasks?id=eq." + t.id, "PATCH", {
    deadline_at: new Date(Date.now() - 60000).toISOString(),
    status: "closed",
  });
  const extraProof = await upload(t, tester);
  const revision = {
    ...body,
    evidence_ids: [proof.id, extraProof.id],
    operation_notes: "Here is the blocker detail.",
    expected_revision_id: s.current_revision_id,
    expected_version: changed.version,
  };
  await call(`/submissions/${s.id}/revisions`, tester, {
    method: "POST",
    body: { ...revision, expected_version: s.version },
    status: 409,
    code: "version_conflict",
  });
  const revised = await call(`/submissions/${s.id}/revisions`, tester, {
    method: "POST",
    body: revision,
    status: 201,
  });
  assert.equal(revised.submission_no, s.submission_no);
  assert.equal(revised.processing_status, "awaiting_publisher");
  await call(`/submissions/${s.id}/decisions`, publisher, {
    method: "POST",
    body: {
      action: "accept",
      expected_revision_id: s.current_revision_id,
      expected_version: changed.version,
    },
    status: 409,
  });
  const acceptance = {
    action: "accept",
    expected_revision_id: revised.current_revision_id,
    expected_version: revised.version,
  };
  const acceptKey = crypto.randomUUID();
  const accepted = await call(`/submissions/${s.id}/decisions`, publisher, {
    method: "POST",
    body: acceptance,
    key: acceptKey,
  });
  assert.equal(accepted.payment_status, "not_required");
  await call(`/submissions/${s.id}/decisions`, publisher, {
    method: "POST",
    body: acceptance,
    key: acceptKey,
  });
  await call(`/submissions/${s.id}/revisions`, tester, {
    method: "POST",
    body: {
      ...revision,
      expected_revision_id: revised.current_revision_id,
      expected_version: accepted.version,
    },
    status: 409,
  });
  const history = await call(`/submissions/${s.id}`, tester);
  assert.equal(history.revisions.length, 2);
  assert.equal(history.decisions.length, 2);
  assert.equal(history.revisions[0].operation_notes, body.operation_notes);
  await call("/uploads", other, {
    method: "POST",
    body: {
      task_id: expired.id,
      name: "x.png",
      mime_type: "image/png",
      size_bytes: png.length,
    },
    status: 409,
    code: "task_closed",
  });
  // Actual file exists on closed task; first submission must still be rejected by DB.
  const deadlineTask = await makeTask(publisher);
  const lateProof = await upload(deadlineTask, other);
  await admin("/rest/v1/tasks?id=eq." + deadlineTask.id, "PATCH", {
    deadline_at: new Date(Date.now() - 60000).toISOString(),
  });
  await call(`/tasks/${deadlineTask.id}/submissions`, other, {
    method: "POST",
    body: { ...body, evidence_ids: [lateProof.id] },
    status: 409,
    code: "task_closed",
  });
  // Direct client REST/RPC bypasses must fail, even with a verified user's JWT.
  const direct = await request(base + "/rest/v1/submissions?select=*", {
    token: tester.token,
  });
  assert.equal(direct.status, 403);
  checks++;
  const rpc = await request(base + "/rest/v1/rpc/mutate_submission", {
    token: tester.token,
    method: "POST",
    body: {
      p_actor: publisher.id,
      p_action: "decide",
      p_target: s.id,
      p_body: acceptance,
      p_key: crypto.randomUUID(),
      p_hash: "forged",
    },
  });
  assert.equal(rpc.status, 403);
  checks++;
  const overwrite = await fetch(
    base + "/storage/v1/object/submission-evidence/" + proof.path,
    {
      method: "PUT",
      headers: {
        apikey: key,
        Authorization: "Bearer " + tester.token,
        "Content-Type": "image/png",
      },
      body: png,
    },
  );
  assert.ok(!overwrite.ok);
  checks++;
  const signedOverwrite = await fetch(proof.upload_url, {
    method: "PUT",
    headers: { "Content-Type": "image/png", "x-upsert": "true" },
    body: png,
  });
  assert.ok(
    !signedOverwrite.ok,
    "Signed upload grant must not overwrite submitted evidence",
  );
  checks++;
  const missingKey = await request(api + `/submissions/${s.id}/decisions`, {
    token: publisher.token,
    method: "POST",
    body: acceptance,
  });
  assert.equal(missingKey.status, 422);
  assert.equal(missingKey.data.code, "idempotency_key_required");
  checks++;
  await call("/me/submissions?limit=101", tester, { status: 422 });
  // Competing first submissions and decisions must have one winner, one conflict.
  const concurrentTask = await makeTask(publisher);
  const concurrentProof = await upload(concurrentTask, tester);
  const concurrentBody = { ...body, evidence_ids: [concurrentProof.id] };
  const firstRace = await Promise.all(
    [1, 2].map(() =>
      request(api + `/tasks/${concurrentTask.id}/submissions`, {
        token: tester.token,
        method: "POST",
        body: concurrentBody,
        extra: { "Idempotency-Key": crypto.randomUUID() },
      })
    ),
  );
  assert.deepEqual(firstRace.map((r) => r.status).sort(), [201, 409]);
  checks++;
  const raceSubmission = firstRace.find((r) => r.status === 201).data;
  const decisionBody = {
    action: "decline",
    reason: "Evidence does not demonstrate this task.",
    expected_revision_id: raceSubmission.current_revision_id,
    expected_version: raceSubmission.version,
  };
  const decisionRace = await Promise.all(
    [1, 2].map(() =>
      request(api + `/submissions/${raceSubmission.id}/decisions`, {
        token: publisher.token,
        method: "POST",
        body: decisionBody,
        extra: { "Idempotency-Key": crypto.randomUUID() },
      })
    ),
  );
  assert.deepEqual(decisionRace.map((r) => r.status).sort(), [200, 409]);
  checks++;
  assert.equal(
    decisionRace.find((r) => r.status === 200).data.payment_status,
    "not_payable",
  );
  const declined = await call(`/submissions/${raceSubmission.id}`, tester);
  assert.equal(declined.decisions.length, 1);
  const otherProof = await upload(concurrentTask, other);
  await call(`/tasks/${concurrentTask.id}/submissions`, other, {
    method: "POST",
    body: { ...body, evidence_ids: [otherProof.id] },
    status: 201,
  });
  const firstPage = await call(
    `/tasks/${concurrentTask.id}/submissions?limit=1`,
    publisher,
  );
  assert.ok(firstPage.next_cursor);
  assert.equal(firstPage.items.length, 1);
  const secondPage = await call(
    `/tasks/${concurrentTask.id}/submissions?limit=1&cursor=${firstPage.next_cursor}`,
    publisher,
  );
  assert.equal(secondPage.items.length, 1);
  assert.equal(secondPage.next_cursor, null);
  assert.notEqual(firstPage.items[0].id, secondPage.items[0].id);
  // Future paid tasks cannot accidentally show accepted/paid without a payment integration.
  const paidConfig = {
    ...t.config,
    reward_amount_minor: 100,
    budget_amount_minor: 100,
  };
  const paidTask = await makeTask(publisher, {
    config: paidConfig,
    published_config: paidConfig,
  });
  const paidProof = await upload(paidTask, tester);
  const paidSubmission = await call(
    `/tasks/${paidTask.id}/submissions`,
    tester,
    {
      method: "POST",
      body: { ...body, evidence_ids: [paidProof.id] },
      status: 201,
    },
  );
  await call(`/submissions/${paidSubmission.id}/decisions`, publisher, {
    method: "POST",
    body: {
      action: "accept",
      confirm_payment: true,
      expected_revision_id: paidSubmission.current_revision_id,
      expected_version: paidSubmission.version,
    },
    status: 409,
    code: "payment_not_configured",
  });
  const unpaid = await call(`/submissions/${paidSubmission.id}`, tester);
  assert.equal(unpaid.processing_status, "awaiting_publisher");
  assert.equal(unpaid.decisions.length, 0);
  const unverified = await user("unverified", false);
  const login = await request(base + "/auth/v1/token?grant_type=password", {
    method: "POST",
    body: { email: unverified.email, password: unverified.password },
  });
  if (login.status === 200) {
    await call("/me/submissions", { token: login.data.access_token }, {
      status: 403,
    });
  } else {
    assert.equal(login.data.error_code, "email_not_confirmed");
    checks++;
  }
  console.log(
    JSON.stringify({
      result: "PASS",
      checks,
      project: "myjdykfmxspqtgbuoqdt",
      function: "submissions",
    }),
  );
} finally {
  // Delete only IDs generated by this run, in FK order; no resets, no global cleanup.
  if (files.length) {
    await admin("/storage/v1/object/submission-evidence", "DELETE", {
      prefixes: files,
    });
  }
  if (tasks.length) {
    const filter = "in.(" + tasks.join(",") + ")";
    const submissions = await admin(
      "/rest/v1/submissions?task_id=" + filter + "&select=id",
    );
    if (submissions.length) {
      const ids = "in.(" + submissions.map((s) => s.id).join(",") + ")";
      const revisions = await admin(
        "/rest/v1/submission_revisions?submission_id=" + ids + "&select=id",
      );
      if (revisions.length) {
        await admin(
          "/rest/v1/submission_jobs?revision_id=in.(" + revisions.map((r) =>
            r.id
          ).join(",") + ")",
          "DELETE",
        );
      }
      await admin(
        "/rest/v1/submission_decisions?submission_id=" + ids,
        "DELETE",
      );
      await admin("/rest/v1/submissions?id=" + ids, "PATCH", {
        current_revision_id: null,
      });
      await admin(
        "/rest/v1/submission_revisions?submission_id=" + ids,
        "DELETE",
      );
      await admin("/rest/v1/submissions?id=" + ids, "DELETE");
    }
    await admin("/rest/v1/submission_evidence?task_id=" + filter, "DELETE");
    await admin("/rest/v1/tasks?id=" + filter, "DELETE");
  }
  if (users.length) {
    await admin(
      "/rest/v1/submission_api_requests?principal_id=in.(" + users.join(",") +
        ")",
      "DELETE",
    );
  }
  for (const id of users) await admin("/auth/v1/admin/users/" + id, "DELETE");
  console.log("Temporary fixtures cleaned up.");
}
