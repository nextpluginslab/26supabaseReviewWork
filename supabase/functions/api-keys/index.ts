import {
  ApiError,
  database,
  requireAgent,
  requireUserSession,
  sha256,
  UUID,
  validateScopes,
} from "../_shared/agent-auth.ts";

const metadata =
  "id,publisher_id,name,key_prefix,scopes,created_at,expires_at,revoked_at,last_used_at";
const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, apikey, content-type, x-client-info",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Access-Control-Expose-Headers": "x-request-id",
};
async function readBody(req: Request): Promise<Record<string, unknown>> {
  if (
    !req.headers.get("content-type")?.toLowerCase().includes("application/json")
  ) throw new ApiError(415, "unsupported_media_type", "Use application/json.");
  const reader = req.body?.getReader();
  if (!reader) throw new ApiError(400, "invalid_json", "JSON object required.");
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > 8192) {
      await reader.cancel();
      throw new ApiError(413, "body_too_large", "Maximum body size is 8 KiB.");
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
    const data = JSON.parse(new TextDecoder().decode(bytes));
    if (!data || typeof data !== "object" || Array.isArray(data)) {
      throw new Error();
    }
    return data;
  } catch {
    throw new ApiError(400, "invalid_json", "JSON object required.");
  }
}
function fields(input: Record<string, unknown>, allowed: string[]) {
  if (Object.keys(input).some((key) => !allowed.includes(key))) {
    throw new ApiError(422, "invalid_request", "Unknown or read-only field.");
  }
}
function publicMetadata(row: Record<string, unknown>) {
  return Object.fromEntries(metadata.split(",").map((key) => [key, row[key]]));
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
    const path = url.pathname.replace(/^\/api-keys(?=\/|$)/, "").replace(
      /\/$/,
      "",
    );
    // Self-introspection only. It never executes business actions or grants new scopes.
    if (path === "/authorize" && req.method === "POST") {
      const input = await readBody(req);
      fields(input, ["required_scopes"]);
      const agent = await requireAgent(
        req,
        validateScopes(input.required_scopes),
      );
      return json({ principal: { type: "agent", ...agent } });
    }
    const match = path.match(/^(?:\/([0-9a-f-]+))?$/i);
    if (!match || (match[1] && !UUID.test(match[1]))) {
      throw new ApiError(404, "not_found", "Route not found.");
    }
    const id = match[1];
    if (!(id ? ["DELETE"] : ["GET", "POST"]).includes(req.method)) {
      throw new ApiError(405, "method_not_allowed", "Method not allowed.");
    }
    const user = await requireUserSession(req);
    if (req.method === "GET") {
      const limitRaw = url.searchParams.get("limit") ?? "20";
      const limit = Number(limitRaw), cursor = url.searchParams.get("cursor");
      if (
        !/^\d+$/.test(limitRaw) || limit < 1 || limit > 100 ||
        (cursor && !UUID.test(cursor))
      ) {
        throw new ApiError(
          422,
          "invalid_pagination",
          "Use limit 1–100 and a returned cursor.",
        );
      }
      const rows = await database(
        `api_keys?select=${metadata}&publisher_id=eq.${user.id}&order=id.asc&limit=${
          limit + 1
        }${cursor ? `&id=gt.${cursor}` : ""}`,
      );
      return json({
        api_keys: rows.slice(0, limit),
        next_cursor: rows.length > limit ? rows[limit - 1].id : null,
      });
    }
    if (req.method === "DELETE") {
      const filter = `id=eq.${id}&publisher_id=eq.${user.id}`;
      await database(`api_keys?${filter}&revoked_at=is.null`, {
        method: "PATCH",
        body: JSON.stringify({ revoked_at: new Date().toISOString() }),
      });
      const rows = await database(`api_keys?select=${metadata}&${filter}`);
      if (!rows.length) {
        throw new ApiError(404, "not_found", "API key not found.");
      }
      return json({ api_key: rows[0] });
    }
    const input = await readBody(req);
    fields(input, ["name", "scopes", "expires_at"]);
    if (
      typeof input.name !== "string" || !input.name.trim() ||
      input.name.trim().length > 80
    ) {
      throw new ApiError(
        422,
        "invalid_name",
        "Name must contain 1–80 characters.",
      );
    }
    const scopes = validateScopes(input.scopes);
    const now = Date.now();
    const expiry = input.expires_at === undefined
      ? now + 90 * 86400000
      : typeof input.expires_at === "string" &&
          /^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(input.expires_at)
      ? Date.parse(input.expires_at)
      : NaN;
    if (
      !Number.isFinite(expiry) || expiry <= now || expiry > now + 365 * 86400000
    ) {
      throw new ApiError(
        422,
        "invalid_expiration",
        "Expiry must be a future ISO timestamp within 365 days.",
      );
    }
    const key = "rwk_" +
      Array.from(
        crypto.getRandomValues(new Uint8Array(32)),
        (b) => b.toString(16).padStart(2, "0"),
      ).join("");
    const row = await database("rpc/create_agent_api_key", {
      method: "POST",
      body: JSON.stringify({
        p_publisher_id: user.id,
        p_name: input.name.trim(),
        p_key_hash: await sha256(key),
        p_key_prefix: key.slice(0, 12),
        p_scopes: scopes,
        p_expires_at: new Date(expiry).toISOString(),
      }),
    });
    return json({ api_key: publicMetadata(row), key }, 201);
  } catch (error) {
    const known = error instanceof ApiError;
    if (!known) {
      console.error(
        JSON.stringify({ event: "api_key_error", request_id: requestId }),
      );
    }
    return json({
      code: known ? error.code : "internal_error",
      message: known ? error.message : "Unable to process API key request.",
      field_errors: {},
      request_id: requestId,
    }, known ? error.status : 500);
  }
}

if (import.meta.main) Deno.serve(handler);
