// Explicit live integration test. Uses only temporary IDs created by this run.
// node --env-file=<server-env-file> backend/tests/uploads-live.mjs
import assert from "node:assert/strict";

const base = process.env.SUPABASE_URL;
const secret = process.env.SUPABASE_SERVICE_ROLE_KEY;
assert.equal(base, "https://myjdykfmxspqtgbuoqdt.supabase.co");
assert.ok(secret, "SUPABASE_SERVICE_ROLE_KEY is required");
const api = "/functions/v1/submissions/v1";
const taskApi = "/functions/v1/api/v1";
const bucket = "submission-evidence";
const tag = `uploads-live-${crypto.randomUUID()}`;
const users = [], tasks = [];
const passed = [];
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6VZkAAAAASUVORK5CYII=",
  "base64",
);

async function request(
  path,
  { token, method = "GET", body, headers = {} } = {},
) {
  const r = await fetch(base + path, {
    method,
    headers: {
      ...(token ? { apikey: secret, Authorization: `Bearer ${token}` } : {}),
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(30000),
  });
  const text = await r.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = null;
  }
  return { status: r.status, data, headers: r.headers };
}
async function admin(path, method = "GET", body) {
  const r = await request(path, {
    token: secret,
    method,
    body,
    headers: { Prefer: "return=representation" },
  });
  // Do not include response bodies: Auth responses and signed URLs contain credentials.
  assert.ok(
    r.status < 300,
    `Fixture operation ${method} ${path.split("?")[0]} failed (${r.status})`,
  );
  return r.data;
}
async function call(
  path,
  actor,
  body,
  { status = 200, code, key = crypto.randomUUID(), prefix = api } = {},
) {
  const r = await request(prefix + path, {
    token: actor?.token,
    method: body === undefined ? "GET" : "POST",
    body,
    headers: key ? { "Idempotency-Key": key } : {},
  });
  assert.equal(
    r.status,
    status,
    `${path}: expected ${status}, received ${r.status} (${
      r.data?.code ?? r.data?.error?.code ?? "unknown"
    })`,
  );
  if (code) assert.equal(r.data.code, code);
  return r.data;
}
async function check(label, fn) {
  await fn();
  passed.push(label);
  console.log(`PASS ${label}`);
}
async function user(name) {
  const email = `${tag}-${name}@example.com`,
    password = crypto.randomUUID() + "aA!1";
  const u = await admin("/auth/v1/admin/users", "POST", {
    email,
    password,
    email_confirm: true,
  });
  users.push(u.id);
  const login = await admin("/auth/v1/token?grant_type=password", "POST", {
    email,
    password,
  });
  return { id: u.id, token: login.access_token };
}
async function createTask(publisher, publish = true) {
  const { task } = await call("/tasks", publisher, {
    config: {
      title: tag,
      app_name: "Upload integration fixture",
      app_type: "web",
      app_url: "https://example.com",
      experience_instructions: "Open the product.",
      task_description: "Record the blocker.",
      evidence_types: ["image"],
      evidence_instructions: "Upload a screenshot.",
      reward_amount_minor: 0,
      budget_amount_minor: 0,
      currency: "USD",
      duration_seconds: 3600,
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
    },
  }, { prefix: taskApi, status: 201 });
  tasks.push(task.id);
  if (!publish) return task;
  return (await call(`/tasks/${task.id}/publish`, publisher, {
    version: task.version,
  }, { prefix: taskApi })).task;
}
function uploadBody(task, patch = {}) {
  return {
    task_id: task.id,
    name: "proof.png",
    mime_type: "image/png",
    size_bytes: png.length,
    ...patch,
  };
}
async function intent(task, actor, patch = {}, options = {}) {
  return call("/uploads", actor, uploadBody(task, patch), {
    status: 201,
    ...options,
  });
}
async function put(upload, bytes = png, mime = "image/png", extra = {}) {
  const url = new URL(upload.upload_url);
  assert.equal(url.origin, base);
  assert.ok(
    url.pathname.startsWith(`/storage/v1/object/upload/sign/${bucket}/`),
  );
  const r = await fetch(url, {
    method: "PUT",
    headers: { "Content-Type": mime, ...extra },
    body: bytes,
    signal: AbortSignal.timeout(30000),
  });
  await r.body?.cancel();
  return r;
}
function feedback(evidence) {
  return {
    operation_notes: "A blocker was observed.",
    answers: [{
      question_key: "choice",
      selected_option_key: "no",
      reason: "The workflow was blocked.",
    }],
    evidence_ids: evidence.map((e) => e.id),
  };
}

async function cleanup() {
  // Discover all evidence belonging to our task IDs, including intents whose response was interrupted.
  if (tasks.length) {
    const filter = `in.(${tasks.join(",")})`;
    const evidence = await admin(
      `/rest/v1/submission_evidence?task_id=${filter}&select=object_path`,
    );
    if (evidence.length) {
      await admin(`/storage/v1/object/${bucket}`, "DELETE", {
        prefixes: evidence.map((e) => e.object_path),
      });
    }
    const submissions = await admin(
      `/rest/v1/submissions?task_id=${filter}&select=id`,
    );
    if (submissions.length) {
      const ids = `in.(${submissions.map((s) => s.id).join(",")})`;
      const revisions = await admin(
        `/rest/v1/submission_revisions?submission_id=${ids}&select=id`,
      );
      if (revisions.length) {
        await admin(
          `/rest/v1/submission_jobs?revision_id=in.(${
            revisions.map((r) => r.id).join(",")
          })`,
          "DELETE",
        );
      }
      await admin(
        `/rest/v1/submission_decisions?submission_id=${ids}`,
        "DELETE",
      );
      await admin(`/rest/v1/submissions?id=${ids}`, "PATCH", {
        current_revision_id: null,
      });
      await admin(
        `/rest/v1/submission_revisions?submission_id=${ids}`,
        "DELETE",
      );
      await admin(`/rest/v1/submissions?id=${ids}`, "DELETE");
    }
    await admin(`/rest/v1/submission_evidence?task_id=${filter}`, "DELETE");
    await admin(`/rest/v1/tasks?id=${filter}`, "DELETE");
    assert.deepEqual(await admin(`/rest/v1/tasks?id=${filter}&select=id`), []);
    assert.deepEqual(
      await admin(`/rest/v1/submission_evidence?task_id=${filter}&select=id`),
      [],
    );
    for (const id of tasks) {
      const remaining = await admin(
        `/storage/v1/object/list/${bucket}`,
        "POST",
        { prefix: id + "/", limit: 1 },
      );
      assert.deepEqual(remaining, [], "Test files must be removed");
    }
  }
  if (users.length) {
    for (const table of ["submission_api_requests", "task_api_requests"]) {
      await admin(
        `/rest/v1/${table}?principal_id=in.(${users.join(",")})`,
        "DELETE",
      );
    }
  }
  for (const id of users) {
    await admin(`/auth/v1/admin/users/${id}`, "DELETE");
    assert.equal(
      (await request(`/auth/v1/admin/users/${id}`, { token: secret })).status,
      404,
    );
  }
  console.log(
    "CLEANUP verified: temporary tasks, evidence, files and users removed.",
  );
}

try {
  const publisher = await user("publisher"),
    tester = await user("tester"),
    other = await user("other");
  const task = await createTask(publisher),
    secondTask = await createTask(publisher),
    draft = await createTask(publisher, false);
  await check("private bucket, size and MIME restrictions", async () => {
    const b = await admin(`/storage/v1/bucket/${bucket}`);
    assert.equal(b.public, false);
    assert.equal(Number(b.file_size_limit), 50 * 1024 * 1024);
    assert.ok(b.allowed_mime_types.includes("image/png"));
    assert.ok(!b.allowed_mime_types.includes("image/svg+xml"));
  });
  await check("browser preflight", async () => {
    const r = await request(api + "/uploads", { method: "OPTIONS" });
    assert.equal(r.status, 204);
    assert.match(
      r.headers.get("access-control-allow-headers"),
      /idempotency-key/,
    );
  });
  await check(
    "missing login rejected",
    () => intent(task, null, {}, { status: 401 }),
  );
  await check(
    "forged token rejected",
    () => intent(task, { token: "invalid" }, {}, { status: 401 }),
  );
  await check(
    "missing idempotency key rejected",
    () =>
      intent(task, tester, {}, {
        key: null,
        status: 422,
        code: "idempotency_key_required",
      }),
  );
  for (
    const [label, patch] of [
      ["empty file", { size_bytes: 0 }],
      ["oversize file", { size_bytes: 52428801 }],
      ["fractional size", { size_bytes: 1.5 }],
      ["unsupported SVG", { mime_type: "image/svg+xml" }],
      ["blank name", { name: " " }],
      ["invalid task ID", { task_id: "invalid" }],
      ["forged owner", { uploader_id: other.id }],
      ["client object path", { path: "../other/file" }],
    ]
  ) {
    await check(
      `${label} rejected`,
      () => intent(task, tester, patch, { status: 422 }),
    );
  }
  await check(
    "unknown task rejected",
    () => intent({ id: crypto.randomUUID() }, tester, {}, { status: 404 }),
  );
  await check(
    "unpublished task rejected",
    () => intent(draft, tester, {}, { status: 404 }),
  );
  await check(
    "task image-only policy enforced",
    () => intent(task, tester, { mime_type: "video/mp4" }, { status: 422 }),
  );

  const key = crypto.randomUUID();
  let proof;
  await check(
    "upload intent returns private, server-assigned path",
    async () => {
      proof = await intent(task, tester, {}, { key });
      assert.equal(proof.path, `${task.id}/${tester.id}/${proof.id}`);
      assert.equal(proof.method, "PUT");
      assert.equal(proof.mime_type, "image/png");
    },
  );
  await check("idempotent upload retries reuse evidence", async () => {
    const retry = await intent(task, tester, {}, { key });
    assert.equal(retry.id, proof.id);
    assert.equal(retry.path, proof.path);
  });
  await check(
    "idempotency body conflict rejected",
    () =>
      intent(task, tester, { name: "different.png" }, {
        key,
        status: 409,
        code: "idempotency_conflict",
      }),
  );
  await check(
    "signed URL uploads actual PNG without user credentials",
    async () => assert.equal((await put(proof)).status, 200),
  );
  await check(
    "signed upload cannot overwrite even with x-upsert",
    async () =>
      assert.ok(
        !(await put(proof, png, "image/png", { "x-upsert": "true" })).ok,
      ),
  );
  await check(
    "raw public object URL cannot read private evidence",
    async () => {
      const r = await request(
        `/storage/v1/object/public/${bucket}/${proof.path}`,
      );
      assert.ok(r.status >= 400 && r.status < 500);
    },
  );
  await check(
    "another tester cannot read evidence",
    () => call(`/evidence/${proof.id}/read-url`, other, {}, { status: 404 }),
  );
  await check(
    "publisher cannot read unsubmitted evidence",
    () =>
      call(`/evidence/${proof.id}/read-url`, publisher, {}, { status: 404 }),
  );
  await check(
    "another tester cannot submit this evidence",
    () =>
      call(`/tasks/${task.id}/submissions`, other, feedback([proof]), {
        status: 422,
        code: "invalid_evidence",
      }),
  );
  await check(
    "cross-task evidence rejected",
    () =>
      call(`/tasks/${secondTask.id}/submissions`, tester, feedback([proof]), {
        status: 422,
        code: "invalid_evidence",
      }),
  );

  const missing = await intent(task, tester);
  await check(
    "unuploaded evidence rejected at submission",
    () =>
      call(`/tasks/${task.id}/submissions`, tester, feedback([missing]), {
        status: 422,
        code: "invalid_evidence",
      }),
  );
  const fake = Buffer.from(
    "This is not a PNG even if its content type says image/png.",
  );
  const fakeProof = await intent(task, tester, { size_bytes: fake.length });
  assert.ok((await put(fakeProof, fake)).ok);
  await check(
    "fake PNG signature rejected at submission",
    () =>
      call(`/tasks/${task.id}/submissions`, tester, feedback([fakeProof]), {
        status: 422,
        code: "invalid_evidence",
      }),
  );
  const wrongSize = await intent(task, tester, { size_bytes: png.length + 1 });
  assert.ok((await put(wrongSize)).ok);
  await check(
    "actual file size mismatch rejected",
    () =>
      call(`/tasks/${task.id}/submissions`, tester, feedback([wrongSize]), {
        status: 422,
        code: "invalid_evidence",
      }),
  );
  const wrongMime = await intent(task, tester);
  assert.ok((await put(wrongMime, png, "image/jpeg")).ok);
  await check(
    "actual Storage MIME mismatch rejected",
    () =>
      call(`/tasks/${task.id}/submissions`, tester, feedback([wrongMime]), {
        status: 422,
        code: "invalid_evidence",
      }),
  );
  await check("failed evidence checks leave no formal submission", async () => {
    const mine = await call(`/me/submissions?task_id=${task.id}`, tester);
    assert.equal(mine.items.length, 0);
  });
  let submission;
  await check("real upload accepted by formal submission", async () => {
    submission = await call(
      `/tasks/${task.id}/submissions`,
      tester,
      feedback([proof]),
      { status: 201 },
    );
    assert.equal(submission.processing_status, "awaiting_publisher");
  });
  await check(
    "publisher receives signed preview and original bytes",
    async () => {
      const detail = await call(`/submissions/${submission.id}`, publisher);
      const e = detail.evidence.find((e) => e.id === proof.id);
      assert.equal(e.expires_in, 300);
      const r = await fetch(e.url, { signal: AbortSignal.timeout(30000) });
      assert.equal(r.status, 200);
      assert.deepEqual(Buffer.from(await r.arrayBuffer()), png);
    },
  );
  await check("direct metadata write bypass rejected", async () => {
    const r = await request("/rest/v1/submission_evidence", {
      token: tester.token,
      method: "POST",
      body: {
        task_id: task.id,
        uploader_id: tester.id,
        object_path: "forged",
        name: "forged.png",
        mime_type: "image/png",
        size_bytes: png.length,
      },
    });
    assert.equal(r.status, 403);
  });
  await check("direct Storage deletion by uploader rejected", async () => {
    const r = await request(`/storage/v1/object/${bucket}`, {
      token: tester.token,
      method: "DELETE",
      body: { prefixes: [proof.path] },
    });
    assert.ok(
      r.status >= 400 ||
        (r.status === 200 && Array.isArray(r.data) && r.data.length === 0),
    );
    const info = await admin(`/storage/v1/object/list/${bucket}`, "POST", {
      prefix: `${task.id}/${tester.id}/`,
      limit: 100,
    });
    assert.ok(info.some((e) => e.name === proof.id));
  });

  const decision = await call(
    `/submissions/${submission.id}/decisions`,
    publisher,
    {
      action: "request_changes",
      reason: "Please add another screenshot.",
      expected_revision_id: submission.current_revision_id,
      expected_version: submission.version,
    },
  );
  await call(`/tasks/${task.id}/close`, publisher, { version: task.version }, {
    prefix: taskApi,
  });
  await check(
    "closed task rejects new tester upload",
    () => intent(task, other, {}, { status: 409, code: "task_closed" }),
  );
  await check(
    "closed task still permits requested supplementary upload",
    async () => {
      const extra = await intent(task, tester);
      assert.ok((await put(extra)).ok);
      const revised = await call(
        `/submissions/${submission.id}/revisions`,
        tester,
        {
          ...feedback([proof, extra]),
          expected_revision_id: submission.current_revision_id,
          expected_version: decision.version,
        },
        { status: 201 },
      );
      assert.equal(revised.submission_no, submission.submission_no);
      const history = await call(`/submissions/${submission.id}`, tester);
      assert.equal(history.revisions.length, 2);
      assert.deepEqual(history.revisions[0].evidence_ids, [proof.id]);
      assert.equal(history.evidence.length, 2);
    },
  );
  await admin(`/rest/v1/tasks?id=eq.${secondTask.id}`, "PATCH", {
    deadline_at: new Date(Date.now() - 60000).toISOString(),
  });
  await check(
    "expired task rejects first upload",
    () => intent(secondTask, other, {}, { status: 409, code: "task_closed" }),
  );
} finally {
  await cleanup();
}
console.log(
  JSON.stringify({
    result: "PASS",
    checks: passed.length,
    project: "myjdykfmxspqtgbuoqdt",
    endpoint: api + "/uploads",
    cleanup: "verified",
  }),
);
