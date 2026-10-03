import { ApiError as AgentError, requireAgent } from "../_shared/agent-auth.ts";
import { ApiError, publicTask, validateConfig } from "./validation.ts";
const base = Deno.env.get("SUPABASE_URL")!;
const secret = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const columns =
  "id,publisher_id,public_slug,status,config,published_config,version,deadline_at,published_at,created_at,updated_at";
const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, apikey, content-type, idempotency-key, x-client-info",
  "Access-Control-Allow-Methods": "GET, POST, PATCH, OPTIONS",
  "Access-Control-Expose-Headers": "x-request-id",
};
async function db(path: string, init: RequestInit = {}) {
  const response = await fetch(`${base}/rest/v1/${path}`, {
    ...init,
    headers: {
      apikey: secret,
      Authorization: `Bearer ${secret}`,
      "Content-Type": "application/json",
      ...init.headers,
    },
    signal: AbortSignal.timeout(15000),
  });
  const data = await response.json();
  if (!response.ok) {
    const codes: Record<string, [number, string]> = {
      task_not_found: [404, "Task not found."],
      version_conflict: [409, "Refresh the task and use its current version."],
      idempotency_conflict: [
        409,
        "Idempotency key was used with another request.",
      ],
      task_immutable: [409, "Published task configuration cannot be edited."],
      invalid_state: [409, "Task is not in the required state."],
      funding_required: [
        409,
        "Paid publishing requires verified funding. Complete Stripe Sandbox funding first.",
      ],
      deadline_expired: [422, "Publication requires a future deadline."],
      retired_question_key: [422, "Deleted question keys cannot be reused."],
      retired_option_key: [422, "Deleted option keys cannot be reused."],
      rate_limited: [429, "Too many task writes. Retry later."],
    };
    const known = codes[data.message] || ({
      "Task payment amounts are frozen": [
        409,
        "Payment amounts are frozen while funding is active.",
      ],
      "Insufficient task budget": [409, "Insufficient task budget."],
      "Task has not been funded": [409, "Complete funding first."],
    } as Record<string, [number, string]>)[data.message];
    if (known) throw new ApiError(known[0], data.message, known[1]);
    console.error(JSON.stringify({ event: "database_error", code: data.code }));
    throw new ApiError(500, "internal_error", "Unable to process the task.");
  }
  return data;
}
async function body(req: Request) {
  if (!req.headers.get("content-type")?.includes("application/json")) {
    throw new ApiError(415, "unsupported_media_type", "Use application/json.");
  }
  const reader = req.body?.getReader();
  if (!reader) throw new ApiError(400, "invalid_json", "JSON body required.");
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > 131072) {
      await reader.cancel();
      throw new ApiError(
        413,
        "body_too_large",
        "Maximum request body is 128 KiB.",
      );
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  try {
    const value = JSON.parse(new TextDecoder().decode(bytes));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw 0;
    return value;
  } catch {
    throw new ApiError(400, "invalid_json", "JSON object required.");
  }
}
function decorate(row: Record<string, any>) {
  const url = `${base}/functions/v1/api/v1/public/tasks/${row.public_slug}`;
  const appUrl = Deno.env.get("APP_URL");
  return {
    ...row,
    public_url: row.status === "draft" ? null : url,
    task_url: row.status !== "draft" && appUrl
      ? `${appUrl.replace(/\/$/, "")}/tasks/${row.public_slug}`
      : null,
  };
}
export async function handler(req: Request): Promise<Response> {
  const requestId = crypto.randomUUID();
  const json = (value: unknown, status = 200) =>
    new Response(JSON.stringify(value), {
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
    const url = new URL(req.url);
    const path = url.pathname.replace(/^\/api(?=\/)/, "").replace(/\/$/, "");
    const publicMatch = path.match(/^\/v1\/public\/tasks\/([a-f0-9-]{32,36})$/);
    if (req.method === "GET" && publicMatch) {
      const rows = await db(
        `tasks?select=id,public_slug,status,published_config,deadline_at,published_at&${
          publicMatch[1].length === 36 ? "id" : "public_slug"
        }=eq.${publicMatch[1]}&status=in.(published,closed)&limit=1`,
      );
      if (!rows.length) {
        throw new ApiError(404, "task_not_found", "Task not found.");
      }
      return json({ task: publicTask(rows[0]) });
    }
    const match = path.match(
      /^\/v1\/tasks(?:\/([^/]+)(?:\/(publish|close|results|statistics|summary))?)?$/,
    );
    if (!match) throw new ApiError(404, "route_not_found", "Route not found.");
    const [, id, action] = match;
    if (id && !uuid.test(id)) {
      throw new ApiError(404, "task_not_found", "Task not found.");
    }
    const insight = ["results", "statistics", "summary"].includes(action);
    const allowed = insight
      ? ["GET"]
      : action
      ? ["POST"]
      : id
      ? ["GET", "PATCH"]
      : ["GET", "POST"];
    if (!allowed.includes(req.method)) {
      throw new ApiError(405, "method_not_allowed", "Method not allowed.");
    }
    const token = req.headers.get("authorization");
    if (!token?.match(/^Bearer \S+$/i)) {
      throw new ApiError(401, "unauthenticated", "Sign in to continue.");
    }
    let user: { id: string };
    if (/^Bearer rwk_/i.test(token)) {
      const principal = await requireAgent(
        req,
        action === "results" ? ["insights:read", "tasks:read"] : [
          insight
            ? "insights:read"
            : req.method === "GET"
            ? "tasks:read"
            : "tasks:write",
        ],
      );
      user = { id: principal.publisher_id };
    } else {
      const authResponse = await fetch(`${base}/auth/v1/user`, {
        headers: { apikey: secret, Authorization: token },
        signal: AbortSignal.timeout(10000),
      });
      if (!authResponse.ok) {
        throw new ApiError(
          401,
          "unauthenticated",
          "Session is invalid or expired.",
        );
      }
      user = await authResponse.json();
      if (
        !user.id || !(user as any).email_confirmed_at ||
        (user as any).is_anonymous
      ) {
        throw new ApiError(
          403,
          "email_not_verified",
          "Verify your email before managing tasks.",
        );
      }
    }
    if (req.method === "GET") {
      if (id) {
        const rows = await db(
          `tasks?select=${columns}&id=eq.${id}&publisher_id=eq.${user.id}`,
        );
        if (!rows.length) {
          throw new ApiError(404, "task_not_found", "Task not found.");
        }
        if (insight) {
          const [ai, snapshot, payment] = await Promise.all([
            db("rpc/ai_task_result", {
              method: "POST",
              body: JSON.stringify({ p_task_id: id }),
            }),
            db("rpc/ai_task_snapshot", {
              method: "POST",
              body: JSON.stringify({ p_task_id: id }),
            }),
            db("rpc/payments_command", {
              method: "POST",
              body: JSON.stringify({
                p_action: "task",
                p_actor: user.id,
                p_data: { task_id: id },
              }),
            }),
          ]);
          if (action === "statistics") return json(snapshot.statistics);
          if (action === "summary") {
            return json(
              ai || { status: "queued", summary: null, stale: false },
            );
          }
          return json({
            ai: ai || { status: "queued", summary: null, stale: false },
            statistics: snapshot.statistics,
            as_of: snapshot.as_of,
            budget: {
              paid: payment.paid_amount_minor,
              pending: payment.pending_amount_minor,
              remaining: payment.remaining_amount_minor,
            },
          });
        }
        return json({ task: decorate(rows[0]) });
      }
      const limitText = url.searchParams.get("limit") ?? "20";
      const limit = Number(limitText);
      const cursor = url.searchParams.get("cursor");
      if (
        !/^\d+$/.test(limitText) || limit < 1 || limit > 100 ||
        (cursor && !uuid.test(cursor))
      ) {
        throw new ApiError(
          422,
          "invalid_pagination",
          "Use limit 1–100 and a returned cursor.",
        );
      }
      const rows = await db(
        `tasks?select=${columns}&publisher_id=eq.${user.id}&order=id.asc&limit=${
          limit + 1
        }${cursor ? `&id=gt.${cursor}` : ""}`,
      );
      return json({
        tasks: rows.slice(0, limit).map(decorate),
        next_cursor: rows.length > limit ? rows[limit - 1].id : null,
      });
    }
    const key = req.headers.get("idempotency-key");
    if (!key || !/^[\x21-\x7e]{1,128}$/.test(key)) {
      throw new ApiError(
        422,
        "idempotency_key_required",
        "Provide an Idempotency-Key of 1–128 printable characters.",
      );
    }
    const input = await body(req);
    const expectedKeys = action
      ? ["version"]
      : id
      ? ["version", "config"]
      : ["config"];
    if (Object.keys(input).some((k) => !expectedKeys.includes(k))) {
      throw new ApiError(
        422,
        "invalid_request",
        "Unknown or read-only request field.",
      );
    }
    if (id && (!Number.isSafeInteger(input.version) || input.version < 1)) {
      throw new ApiError(
        422,
        "version_required",
        "Provide the current task version.",
      );
    }
    const config = action ? null : validateConfig(input.config);
    const hash = Array.from(
      new Uint8Array(
        await crypto.subtle.digest(
          "SHA-256",
          new TextEncoder().encode(JSON.stringify(input)),
        ),
      ),
    ).map((n) => n.toString(16).padStart(2, "0")).join("");
    const row = await db("rpc/mutate_task", {
      method: "POST",
      body: JSON.stringify({
        p_actor: user.id,
        p_action: action ?? (id ? "update" : "create"),
        p_task: id ?? null,
        p_config: config,
        p_version: input.version ?? null,
        p_key: key,
        p_hash: hash,
      }),
    });
    return json({ task: decorate(row) }, !id ? 201 : 200);
  } catch (error) {
    if (error instanceof ApiError || error instanceof AgentError) {
      return json({
        error: {
          code: error.code,
          message: error.message,
          field_errors: error instanceof ApiError ? error.fields : {},
          request_id: requestId,
        },
      }, error.status);
    }
    console.error(
      JSON.stringify({
        event: "request_failed",
        request_id: requestId,
        type: error instanceof Error ? error.name : "unknown",
      }),
    );
    return json({
      error: {
        code: "internal_error",
        message: "Unable to process request.",
        field_errors: {},
        request_id: requestId,
      },
    }, 500);
  }
}
if (import.meta.main) Deno.serve(handler);
