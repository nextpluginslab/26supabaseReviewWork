import { expect, type Page } from "@playwright/test";
export const taskId = "20000000-0000-4000-8000-000000000001",
  slug = "abcdef0123456789abcdef0123456789",
  submissionId = "30000000-0000-4000-8000-000000000001";
export async function apiFixture(
  page: Page,
  { signedIn = true, submitted = false } = {},
) {
  const user = {
    id: "10000000-0000-4000-8000-000000000001",
    email: "tester@example.com",
    email_confirmed_at: new Date().toISOString(),
    aud: "authenticated",
    role: "authenticated",
    app_metadata: {},
    user_metadata: {},
    created_at: new Date().toISOString(),
  };
  if (signedIn)
    await page.addInitScript(
      ({ user }) => {
        const enc = (v: unknown) =>
          btoa(JSON.stringify(v))
            .replace(/=/g, "")
            .replace(/\+/g, "-")
            .replace(/\//g, "_");
        const exp = Math.floor(Date.now() / 1000) + 86400;
        localStorage.setItem(
          "sb-myjdykfmxspqtgbuoqdt-auth-token",
          JSON.stringify({
            access_token: `${enc({ alg: "HS256", typ: "JWT" })}.${enc({ sub: user.id, role: "authenticated", exp, session_id: "session" })}.test`,
            refresh_token: "test-refresh",
            expires_at: exp,
            expires_in: 86400,
            token_type: "bearer",
            user,
          }),
        );
      },
      { user },
    );
  let config: any = {
    title: "Test product",
    app_name: "Test product",
    app_type: "web",
    app_url: "https://example.com",
    experience_instructions: "Open the app",
    task_description: "Try the editor",
    evidence_types: ["image"],
    evidence_instructions: "Show your result",
    questions: [],
    reward_amount_minor: 0,
    budget_amount_minor: 0,
    currency: "USD",
    deadline_at: "2099-01-01T12:00:00Z",
    display_timezone: "UTC",
  };
  let status = "published",
    version = 2;
  const evidenceId = "40000000-0000-4000-8000-000000000001";
  const row: any = {
    id: submissionId,
    submission_no: "FW-LIVE",
    task_id: taskId,
    tester_id: user.id,
    current_revision_id: "50000000-0000-4000-8000-000000000001",
    version: 1,
    processing_status: "awaiting_publisher",
    payment_status: "awaiting_confirmation",
    first_submitted_at: new Date().toISOString(),
    revisions: [
      {
        id: "50000000-0000-4000-8000-000000000001",
        revision_no: 1,
        operation_notes: "Initial observation",
        answers: [],
        evidence_ids: [evidenceId],
        submitted_at: new Date().toISOString(),
        ai: {
          status: "succeeded",
          summary: { summary: "Useful feedback", findings: [] },
        },
      },
    ],
    decisions: [],
    evidence: [
      {
        id: evidenceId,
        name: "proof.png",
        mime_type: "image/png",
        size_bytes: 68,
        url: "https://myjdykfmxspqtgbuoqdt.supabase.co/storage/v1/test-image",
      },
    ],
  };
  const calls: {
    path: string;
    method: string;
    body: any;
    key: string | undefined;
  }[] = [];
  let keys: any[] = [],
    read = false;
  const task = () => ({
    id: taskId,
    public_slug: slug,
    status,
    version,
    config,
    published_config: status === "draft" ? null : config,
    deadline_at: config.deadline_at,
  });
  await page.route("https://*.supabase.co/**", async (route) => {
    const req = route.request(),
      path = new URL(req.url()).pathname,
      method = req.method();
    const json = async (data: unknown, status = 200) =>
      route.fulfill({
        status,
        contentType: "application/json",
        headers: {
          "access-control-allow-origin": "*",
          "access-control-allow-headers": "*",
        },
        body: JSON.stringify(data),
      });
    if (method === "OPTIONS") return json({}, 200);
    if (path.startsWith("/auth/v1/user")) return json(user);
    if (path.startsWith("/storage/"))
      return route.fulfill({
        status: 200,
        contentType: "image/png",
        body: Buffer.from(
          "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jFZkAAAAASUVORK5CYII=",
          "base64",
        ),
      });
    const body = req.postData() ? JSON.parse(req.postData()!) : undefined,
      key = req.headers()["idempotency-key"];
    calls.push({ path, method, body, key });
    if (!path.includes("/public/tasks/"))
      expect(req.headers().authorization).toMatch(/^Bearer /);
    if (path.includes("/api/v1/public/tasks/"))
      return json({
        task: {
          ...config,
          id: taskId,
          slug,
          status,
          accepting_submissions: status === "published",
        },
      });
    if (path === "/functions/v1/api/v1/tasks" && method === "POST") {
      expect(key).toBeTruthy();
      config = body.config;
      status = "draft";
      version = 1;
      return json({ task: task() }, 201);
    }
    if (path.endsWith(`/api/v1/tasks/${taskId}/publish`)) {
      expect(body.version).toBe(version);
      status = "published";
      version++;
      return json({ task: task() });
    }
    if (path.endsWith(`/api/v1/tasks/${taskId}`)) return json({ task: task() });
    if (path.endsWith("/api/v1/tasks"))
      return json({ tasks: [task()], next_cursor: null });
    if (path.endsWith(`/api/v1/tasks/${taskId}/results`))
      return json({
        ai: { status: "queued", summary: null, stale: false },
        budget: { paid: 0, pending: 0, remaining: config.budget_amount_minor },
      });
    if (path.endsWith("/submissions/v1/uploads")) {
      expect(key).toBeTruthy();
      expect(body.task_id).toBe(taskId);
      return json(
        {
          id: evidenceId,
          path: "private/path",
          upload_url:
            "https://myjdykfmxspqtgbuoqdt.supabase.co/storage/v1/test-upload",
          method: "PUT",
          mime_type: "image/png",
        },
        201,
      );
    }
    if (path.endsWith("/read-url")) return json({ url: row.evidence[0].url });
    if (path.endsWith("/me/submissions"))
      return json({ items: submitted ? [row] : [], next_cursor: null });
    if (path.endsWith(`/tasks/${taskId}/submissions`)) {
      if (method === "POST") {
        expect(key).toBeTruthy();
        submitted = true;
        row.revisions[0].operation_notes = body.operation_notes;
        row.revisions[0].answers = body.answers;
        return json(row, 201);
      }
      return json({
        items: submitted
          ? [{ ...row, current_revision: row.revisions.at(-1) }]
          : [],
        next_cursor: null,
      });
    }
    if (path.endsWith(`/submissions/${submissionId}`)) return json(row);
    if (path.endsWith("/revisions")) {
      expect(body.expected_version).toBe(row.version);
      expect(body.expected_revision_id).toBe(row.current_revision_id);
      expect(key).toBeTruthy();
      row.version++;
      row.current_revision_id = "50000000-0000-4000-8000-000000000002";
      row.processing_status = "awaiting_publisher";
      row.revisions.push({
        ...row.revisions[0],
        id: row.current_revision_id,
        revision_no: 2,
        ...body,
      });
      return json(row, 201);
    }
    if (path.endsWith("/decisions")) {
      expect(body.expected_version).toBe(row.version);
      expect(body.expected_revision_id).toBe(row.current_revision_id);
      expect(key).toBeTruthy();
      row.version++;
      row.processing_status =
        body.action === "accept"
          ? "accepted"
          : body.action === "decline"
            ? "declined"
            : "changes_requested";
      row.payment_status =
        body.action === "accept"
          ? "not_required"
          : body.action === "decline"
            ? "not_payable"
            : "awaiting_confirmation";
      row.decisions.push({ action: body.action, reason: body.reason });
      return json(row);
    }
    if (path.includes("/api-keys")) {
      if (method === "POST") {
        keys = [
          {
            id: "key-1",
            name: body.name,
            key_prefix: "rwk_test",
            scopes: body.scopes,
            revoked_at: null,
            expires_at: "2099-01-01",
          },
        ];
        return json({ api_key: keys[0], key: "rwk_fake_e2e_key" });
      }
      if (method === "DELETE") keys[0].revoked_at = "2026-10-03";
      return json({ api_keys: keys, next_cursor: null });
    }
    if (path.endsWith("/me/notifications"))
      return json({
        items: [
          {
            id: "notice-1",
            title: "More information requested",
            body: "Show the editor",
            task_id: taskId,
            entity_id: submissionId,
            read_at: read ? "2026-10-03" : null,
          },
        ],
        next_cursor: null,
        unread_count: read ? 0 : 1,
      });
    if (path.endsWith("/notifications/notice-1/read")) {
      read = true;
      return json({ read_at: "2026-10-03" });
    }
    if (path.endsWith("/me/connect-account"))
      return json({ ready: false, currently_due: ["account setup"] });
    return json({ message: `Unexpected test request: ${path}` }, 500);
  });
  return {
    calls,
    row,
    requestChanges() {
      row.version++;
      row.processing_status = "changes_requested";
      row.decisions.push({
        action: "request_changes",
        reason: "Please add details",
      });
    },
    task,
  };
}
