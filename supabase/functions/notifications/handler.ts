type Notification = {
  id: string;
  type: string;
  entity_id: string;
  task_id: string;
  title: string;
  body: string;
  created_at: string;
  read_at: string | null;
};
type Cursor = { created_at: string; id: string };
const columns = "id,type,entity_id,task_id,title,body,created_at,read_at";
const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const timestampPattern =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/;
const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, apikey, content-type, x-client-info",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Expose-Headers": "X-Request-Id",
};
class ApiError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
  }
}
function encodeCursor(row: Cursor): string {
  return btoa(JSON.stringify({ created_at: row.created_at, id: row.id }))
    .replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}
function decodeCursor(value: string): Cursor {
  try {
    if (value.length > 256 || !/^[A-Za-z0-9_-]+$/.test(value)) {
      throw new Error();
    }
    const cursor = JSON.parse(
      atob(value.replaceAll("-", "+").replaceAll("_", "/")),
    );
    if (
      typeof cursor.id !== "string" || !uuidPattern.test(cursor.id) ||
      typeof cursor.created_at !== "string" ||
      !timestampPattern.test(cursor.created_at) ||
      !Number.isFinite(Date.parse(cursor.created_at))
    ) throw new Error();
    return cursor;
  } catch {
    throw new ApiError(
      422,
      "invalid_cursor",
      "The pagination cursor is invalid.",
    );
  }
}
function publicNotification(row: Notification): Notification {
  return {
    id: row.id,
    type: row.type,
    entity_id: row.entity_id,
    task_id: row.task_id,
    title: row.title,
    body: row.body,
    created_at: row.created_at,
    read_at: row.read_at,
  };
}

export function createHandler(config: {
  url: string;
  anonKey: string;
  fetch?: typeof fetch;
}) {
  const request = config.fetch ?? fetch;
  return async (req: Request): Promise<Response> => {
    const requestId = crypto.randomUUID();
    const json = (data: unknown, status = 200) =>
      new Response(JSON.stringify(data), {
        status,
        headers: {
          ...cors,
          "Content-Type": "application/json",
          "Cache-Control": "no-store",
          "X-Request-Id": requestId,
        },
      });
    if (req.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors });
    }
    try {
      const authorization = req.headers.get("authorization");
      if (!authorization || !/^Bearer \S+$/i.test(authorization)) {
        throw new ApiError(
          401,
          "unauthorized",
          "Sign in to view notifications.",
        );
      }
      const headers = { apikey: config.anonKey, Authorization: authorization };
      const auth = await request(config.url + "/auth/v1/user", {
        headers,
        signal: AbortSignal.timeout(10000),
      });
      if (!auth.ok) {
        await auth.body?.cancel();
        throw auth.status >= 500 || auth.status === 429
          ? new ApiError(
            503,
            "auth_unavailable",
            "Authentication is temporarily unavailable.",
          )
          : new ApiError(
            401,
            "unauthorized",
            "Your session is invalid or expired.",
          );
      }
      const user = await auth.json();
      if (typeof user.id !== "string" || !uuidPattern.test(user.id)) {
        throw new ApiError(
          401,
          "unauthorized",
          "Your session is invalid or expired.",
        );
      }
      if (!user.email_confirmed_at || user.is_anonymous) {
        throw new ApiError(
          403,
          "email_not_verified",
          "Verify your email before continuing.",
        );
      }

      // Every database call uses the user's JWT, so RLS applies even if a route
      // accidentally omits its explicit recipient filter. No service key here.
      const rest = async (path: string, init: RequestInit = {}) => {
        const response = await request(config.url + "/rest/v1/" + path, {
          ...init,
          headers: {
            ...headers,
            "Content-Type": "application/json",
            ...init.headers,
          },
          signal: AbortSignal.timeout(15000),
        });
        if (!response.ok) {
          await response.body?.cancel();
          throw new ApiError(
            502,
            "upstream_error",
            "Notifications are temporarily unavailable.",
          );
        }
        return response;
      };
      const url = new URL(req.url);
      const path = url.pathname.replace(
        /^\/(?:functions\/v1\/)?notifications(?=\/v1\/)/,
        "",
      );
      const isList = path === "/v1/me/notifications";
      const read = path.match(/^\/v1\/notifications\/([^/]+)\/read$/);
      if (!isList && !read) {
        throw new ApiError(404, "route_not_found", "Route not found.");
      }
      if ((isList && req.method !== "GET") || (read && req.method !== "POST")) {
        throw new ApiError(
          405,
          "method_not_allowed",
          "This method is not supported.",
        );
      }
      if (isList) {
        for (const key of url.searchParams.keys()) {
          if (
            !["limit", "cursor", "unread_only"].includes(key) ||
            url.searchParams.getAll(key).length !== 1
          ) {
            throw new ApiError(
              422,
              "invalid_query",
              "Unsupported or repeated query parameter.",
            );
          }
        }
        const rawLimit = url.searchParams.get("limit") ?? "20";
        const limit = Number(rawLimit);
        if (!/^\d{1,3}$/.test(rawLimit) || limit < 1 || limit > 100) {
          throw new ApiError(
            422,
            "invalid_limit",
            "Limit must be an integer from 1 to 100.",
          );
        }
        const unreadOnly = url.searchParams.get("unread_only") ?? "false";
        if (!["true", "false"].includes(unreadOnly)) {
          throw new ApiError(
            422,
            "invalid_query",
            "unread_only must be true or false.",
          );
        }
        const query = new URLSearchParams({
          select: columns,
          recipient_id: "eq." + user.id,
          order: "created_at.desc,id.desc",
          limit: String(limit + 1),
        });
        if (unreadOnly === "true") query.set("read_at", "is.null");
        if (url.searchParams.has("cursor")) {
          const c = decodeCursor(url.searchParams.get("cursor")!);
          query.set(
            "or",
            `(created_at.lt.${c.created_at},and(created_at.eq.${c.created_at},id.lt.${c.id}))`,
          );
        }
        const countQuery = new URLSearchParams({
          select: "id",
          recipient_id: "eq." + user.id,
          read_at: "is.null",
          limit: "1",
        });
        const [listResponse, countResponse] = await Promise.all([
          rest("notifications?" + query),
          rest("notifications?" + countQuery, {
            headers: { Prefer: "count=exact" },
          }),
        ]);
        const found: Notification[] = await listResponse.json();
        await countResponse.body?.cancel();
        const count = countResponse.headers.get("content-range")?.split("/")[1];
        if (!count || !/^\d+$/.test(count)) {
          throw new Error("Missing notification count");
        }
        const items = found.slice(0, limit).map(publicNotification);
        return json({
          items,
          next_cursor: found.length > limit
            ? encodeCursor(items.at(-1)!)
            : null,
          unread_count: Number(count),
        });
      }
      if (!uuidPattern.test(read![1])) {
        throw new ApiError(
          422,
          "invalid_id",
          "Notification ID must be a UUID.",
        );
      }
      if (url.search) {
        throw new ApiError(
          422,
          "invalid_query",
          "This endpoint accepts no query parameters.",
        );
      }
      // Body is deliberately ignored: clients cannot select recipient or read_at.
      const response = await rest("rpc/mark_notification_read", {
        method: "POST",
        body: JSON.stringify({ p_id: read![1] }),
      });
      const items: Notification[] = await response.json();
      if (!items.length) {
        throw new ApiError(
          404,
          "notification_not_found",
          "Notification not found.",
        );
      }
      return json(publicNotification(items[0]));
    } catch (error) {
      const e = error instanceof ApiError ? error : new ApiError(
        error instanceof DOMException &&
          ["TimeoutError", "AbortError"].includes(error.name)
          ? 503
          : 500,
        "internal_error",
        "Notifications are temporarily unavailable.",
      );
      if (e.status >= 500) {
        console.error(JSON.stringify({ request_id: requestId, code: e.code }));
      }
      return json({
        code: e.code,
        message: e.message,
        field_errors: {},
        request_id: requestId,
      }, e.status);
    }
  };
}
