Deno.env.set("SUPABASE_URL", "https://example.supabase.co");
Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", "test-service-key");
const { handler } = await import("./index.ts");
const { handle } = await import("../submissions/index.ts");
const id = "20000000-0000-4000-8000-000000000001",
  owner = "10000000-0000-4000-8000-000000000001";
function check(v: unknown) {
  if (!v) throw new Error("Assertion failed");
}
Deno.test("aggregate results check owner before accessing service-only AI and budget RPCs", async () => {
  const original = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = ((input: RequestInfo | URL) => {
    const url = String(input);
    calls.push(url);
    return Promise.resolve(
      Response.json(
        url.includes("/auth/") ? { id: owner, email_confirmed_at: "now" } : [],
      ),
    );
  }) as typeof fetch;
  try {
    const res = await handler(
      new Request(`https://edge/api/v1/tasks/${id}/results`, {
        headers: { authorization: "Bearer user" },
      }),
    );
    check(res.status === 404);
    check(!calls.some((c) => c.includes("/rpc/")));
  } finally {
    globalThis.fetch = original;
  }
});
Deno.test("agent aggregate results require both insights and task scopes", async () => {
  const original = globalThis.fetch;
  let scopes: unknown;
  globalThis.fetch = ((_input: RequestInfo | URL, init?: RequestInit) => {
    scopes = JSON.parse(String(init?.body)).p_required_scopes;
    return Promise.resolve(
      Response.json({ message: "insufficient_scope" }, { status: 400 }),
    );
  }) as typeof fetch;
  try {
    const res = await handler(
      new Request(`https://edge/api/v1/tasks/${id}/results`, {
        headers: { authorization: "Bearer rwk_" + "a".repeat(64) },
      }),
    );
    check(res.status === 403);
    check(JSON.stringify(scopes) === '["insights:read","tasks:read"]');
  } finally {
    globalThis.fetch = original;
  }
});
Deno.test("agent may not mutate submissions or enter tester-owned routes", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (() => {
    throw new Error("Must reject before upstream access");
  }) as typeof fetch;
  try {
    for (
      const [method, path] of [["POST", `/submissions/${id}/decisions`], [
        "POST",
        "/uploads",
      ], ["GET", "/me/submissions"]]
    ) {
      const res = await handle(
        new Request(`https://edge/submissions/v1${path}`, {
          method,
          headers: { authorization: "Bearer rwk_" + "a".repeat(64) },
        }),
      );
      check(res.status === 403);
    }
  } finally {
    globalThis.fetch = original;
  }
});
