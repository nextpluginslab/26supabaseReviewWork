import { createHandler } from "./handler.ts";

const actor = "11111111-1111-4111-8111-111111111111";
const notification = {
  id: "22222222-2222-4222-8222-222222222222",
  type: "changes_requested",
  entity_id: crypto.randomUUID(),
  task_id: crypto.randomUUID(),
  title: "More information requested",
  body: "Please add a screenshot.",
  created_at: "2026-10-03T12:00:00.123456+00:00",
  read_at: null,
};
function assert(ok: unknown, message = "Assertion failed"): asserts ok {
  if (!ok) throw new Error(message);
}
function setup() {
  const calls: { url: URL; init?: RequestInit }[] = [];
  const handler = createHandler({
    url: "https://example.supabase.co",
    anonKey: "public-key",
    fetch: ((input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      calls.push({ url, init });
      if (url.pathname === "/auth/v1/user") {
        return Promise.resolve(
          Response.json({ id: actor, email_confirmed_at: "2026-01-01" }),
        );
      }
      if (url.pathname.endsWith("/mark_notification_read")) {
        return Promise.resolve(Response.json([]));
      }
      if (new Headers(init?.headers).get("prefer") === "count=exact") {
        return Promise.resolve(
          Response.json([], { headers: { "Content-Range": "0-0/3" } }),
        );
      }
      return Promise.resolve(
        Response.json([notification, {
          ...notification,
          id: crypto.randomUUID(),
        }]),
      );
    }) as typeof fetch,
  });
  const request = (path: string, method = "GET") =>
    handler(
      new Request(
        "https://example.supabase.co/notifications/v1/" + path,
        { method, headers: { Authorization: "Bearer user-jwt" } },
      ),
    );
  return { handler, calls, request };
}

Deno.test("missing authentication and preflight never access the database", async () => {
  const { handler, calls } = setup();
  assert(
    (await handler(
      new Request("https://example.test/notifications/v1/me/notifications"),
    )).status === 401,
  );
  assert(
    (await handler(new Request("https://example.test/", { method: "OPTIONS" })))
      .status === 204,
  );
  assert(calls.length === 0);
});

Deno.test("list forwards user JWT, filters recipient, and preserves microsecond cursor", async () => {
  const { request, calls } = setup();
  const response = await request("me/notifications?limit=1&unread_only=true");
  assert(response.status === 200);
  const data = await response.json();
  assert(
    data.items.length === 1 && data.unread_count === 3 && data.next_cursor,
  );
  assert(response.headers.get("cache-control") === "no-store");
  const query = calls[1].url.searchParams;
  assert(
    query.get("recipient_id") === "eq." + actor &&
      query.get("read_at") === "is.null",
  );
  for (const call of calls) {
    const headers = new Headers(call.init?.headers);
    assert(headers.get("authorization") === "Bearer user-jwt");
    assert(headers.get("apikey") === "public-key");
  }
  await request("me/notifications?cursor=" + data.next_cursor);
  assert(
    calls[4].url.searchParams.get("or")?.includes(notification.created_at),
  );
});

Deno.test("invalid filters, UUIDs, and injection-shaped cursors fail before database access", async () => {
  const invalidCursor = btoa(
    JSON.stringify({
      id: notification.id,
      created_at: "now),recipient_id.neq.x",
    }),
  );
  for (
    const path of [
      "me/notifications?limit=0",
      "me/notifications?limit=101",
      "me/notifications?limit=1.5",
      "me/notifications?limit=1&limit=2",
      "me/notifications?unread_only=yes",
      "me/notifications?recipient_id=" + actor,
      "me/notifications?cursor=",
      "me/notifications?cursor=" + encodeURIComponent(invalidCursor),
    ]
  ) {
    const { request, calls } = setup();
    assert((await request(path)).status === 422, path);
    assert(calls.length === 1, "Only authentication should be called");
  }
  assert(
    (await setup().request("notifications/not-a-uuid/read", "POST")).status ===
      422,
  );
});

Deno.test("foreign or missing notification returns 404, unsupported writes return 405", async () => {
  const { request, calls } = setup();
  assert(
    (await request(`notifications/${notification.id}/read`, "POST")).status ===
      404,
  );
  assert(JSON.parse(String(calls[1].init?.body)).p_id === notification.id);
  assert((await request("me/notifications", "POST")).status === 405);
});

Deno.test("invalid and unverified sessions cannot reach database", async () => {
  for (
    const authResponse of [
      Response.json({ message: "bad token" }, { status: 401 }),
      Response.json({ id: actor, email_confirmed_at: null }),
      Response.json({
        id: actor,
        email_confirmed_at: "2026-01-01",
        is_anonymous: true,
      }),
    ]
  ) {
    let count = 0;
    const expected = authResponse.status === 401 ? 401 : 403;
    const handler = createHandler({
      url: "https://example.test",
      anonKey: "public",
      fetch: (() => {
        count++;
        return Promise.resolve(authResponse);
      }) as typeof fetch,
    });
    const response = await handler(
      new Request("https://example.test/v1/me/notifications", {
        headers: { authorization: "Bearer test" },
      }),
    );
    assert(response.status === expected && count === 1);
  }
});
