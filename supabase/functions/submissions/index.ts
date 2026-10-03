import { ApiError as AgentError, requireAgent } from "../_shared/agent-auth.ts";
import {
  ApiError,
  canonical,
  errorStatus,
  matchesSignature,
  MAX_FILE_SIZE,
  uuid,
  validateBody,
} from "./validation.ts";

const base = Deno.env.get("SUPABASE_URL")!;
const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const bucket = "submission-evidence";
const headers = {
  apikey: serviceKey,
  Authorization: `Bearer ${serviceKey}`,
  "Content-Type": "application/json",
};
const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, apikey, content-type, idempotency-key, x-client-info",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};
type Task = {
  id: string;
  publisher_id: string;
  status: string;
  deadline_at: string;
  published_config: unknown;
};
type Submission = {
  id: string;
  task_id: string;
  tester_id: string;
  current_revision_id: string;
  version: number;
  processing_status: string;
  payment_status: string;
  submission_no: string;
};
type Evidence = {
  id: string;
  task_id: string;
  uploader_id: string;
  object_path: string;
  name: string;
  mime_type: string;
  size_bytes: number;
};
type Revision = {
  id: string;
  submission_id: string;
  revision_no: number;
  operation_notes: string;
  answers: unknown[];
  evidence_ids: string[];
  submitted_at: string;
};
type Tables = {
  payment_rewards: { id: string; submission_id: string; state: string };
  tasks: Task;
  submissions: Submission;
  submission_evidence: Evidence;
  submission_revisions: Revision;
  submission_jobs: { revision_id: string; status: string; summary: unknown };
  submission_decisions: {
    id: string;
    revision_id: string;
    action: string;
    reason: string;
    created_at: string;
  };
  submission_api_requests: {
    request_hash: string;
    response: Submission | Evidence;
  };
};
async function upstream<T>(path: string, init: RequestInit = {}): Promise<T> {
  const r = await fetch(base + path, {
    ...init,
    headers: { ...headers, ...init.headers },
    signal: AbortSignal.timeout(20000),
  });
  const data = await r.json();
  if (!r.ok) {
    if (errorStatus[data.message]) {
      throw new ApiError(errorStatus[data.message], data.message);
    }
    if (data.code === "23505") throw new ApiError(409, "already_submitted");
    // Never expose SQL, keys, Storage paths or upstream internals in API errors/logs.
    throw new ApiError(502, "upstream_error");
  }
  return data;
}
function rows<K extends keyof Tables>(
  table: K,
  query: Record<string, string>,
): Promise<Tables[K][]> {
  return upstream("/rest/v1/" + table + "?" + new URLSearchParams(query));
}
async function task(id: string): Promise<Task> {
  const [t] = await rows("tasks", {
    id: "eq." + id,
    select: "id,publisher_id,status,deadline_at,published_config",
  });
  if (!t) throw new ApiError(404, "task_not_found");
  return t;
}
async function ownedSubmission(id: string, actor: string): Promise<Submission> {
  const [s] = await rows("submissions", { id: "eq." + id, select: "*" });
  if (!s) throw new ApiError(404, "submission_not_found");
  if (s.tester_id !== actor && (await task(s.task_id)).publisher_id !== actor) {
    throw new ApiError(404, "submission_not_found");
  }
  return s;
}
async function signedRead(e: Evidence) {
  const result = await upstream<{ signedURL: string }>(
    `/storage/v1/object/sign/${bucket}/${e.object_path}`,
    { method: "POST", body: JSON.stringify({ expiresIn: 300 }) },
  );
  return {
    id: e.id,
    name: e.name,
    mime_type: e.mime_type,
    size_bytes: e.size_bytes,
    url: base + "/storage/v1" + result.signedURL,
    expires_in: 300,
  };
}
async function paymentView(s: Submission) {
  const rewards = await rows("payment_rewards", {
    submission_id: "eq." + s.id,
    select: "id,submission_id,state",
  });
  return {
    ...s,
    payment_status: rewards[0]?.state || s.payment_status,
    reward: rewards[0] || null,
  };
}
async function detail(s: Submission) {
  const [revisions, decisions] = await Promise.all([
    rows("submission_revisions", {
      submission_id: "eq." + s.id,
      select: "*",
      order: "revision_no.asc",
    }),
    rows("submission_decisions", {
      submission_id: "eq." + s.id,
      select: "id,revision_id,action,reason,created_at",
      order: "created_at.asc",
    }),
  ]);
  const ids = [...new Set(revisions.flatMap((r) => r.evidence_ids))];
  const evidence = ids.length
    ? await rows("submission_evidence", {
      id: "in.(" + ids.join(",") + ")",
      select: "*",
    })
    : [];
  const jobs = revisions.length
    ? await rows("submission_jobs", {
      revision_id: "in.(" + revisions.map((r) => r.id).join(",") + ")",
      select: "revision_id,status,summary",
    })
    : [];
  return {
    ...await paymentView(s),
    revisions: revisions.map((r) => ({
      ...r,
      ai: jobs.find((j) => j.revision_id === r.id) ?? { status: "queued" },
    })),
    decisions,
    evidence: await Promise.all(evidence.map(signedRead)),
  };
}
async function verifyEvidence(ids: string[], taskId: string, actor: string) {
  for (const id of ids) {
    const [e] = await rows("submission_evidence", {
      id: "eq." + uuid(id),
      task_id: "eq." + taskId,
      uploader_id: "eq." + actor,
      select: "*",
    });
    if (!e) throw new ApiError(422, "invalid_evidence");
    const response = await fetch(
      `${base}/storage/v1/object/authenticated/${bucket}/${e.object_path}`,
      { headers, signal: AbortSignal.timeout(30000) },
    );
    if (
      !response.ok ||
      Number(response.headers.get("content-length")) > MAX_FILE_SIZE
    ) {
      await response.body?.cancel();
      throw new ApiError(422, "invalid_evidence");
    }
    // Upload grants disallow overwrite; clients have no bucket mutation policy.
    const reader = response.body!.getReader();
    let total = 0;
    const prefix = new Uint8Array(32);
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (total < 32) {
          prefix.set(
            value.subarray(0, Math.min(value.length, 32 - total)),
            total,
          );
        }
        total += value.length;
        if (total > MAX_FILE_SIZE || total > e.size_bytes) {
          throw new ApiError(422, "invalid_evidence");
        }
      }
    } finally {
      await reader.cancel();
    }
    if (
      total !== e.size_bytes ||
      !matchesSignature(prefix.subarray(0, Math.min(total, 32)), e.mime_type)
    ) throw new ApiError(422, "invalid_evidence");
  }
}
async function readJson(req: Request): Promise<unknown> {
  if (
    !req.headers.get("content-type")?.toLowerCase().startsWith(
      "application/json",
    )
  ) throw new ApiError(415, "json_required");
  const reader = req.body?.getReader();
  if (!reader) throw new ApiError(400, "invalid_json");
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.length;
      if (length > 262144) throw new ApiError(413, "body_too_large");
      chunks.push(value);
    }
  } finally {
    await reader.cancel();
  }
  const joined = new Uint8Array(length);
  let offset = 0;
  for (const c of chunks) {
    joined.set(c, offset);
    offset += c.length;
  }
  try {
    return JSON.parse(new TextDecoder().decode(joined));
  } catch {
    throw new ApiError(400, "invalid_json");
  }
}

export async function handle(req: Request): Promise<Response> {
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
    if (!authorization?.match(/^Bearer \S+$/i)) {
      throw new ApiError(401, "unauthorized");
    }
    const url = new URL(req.url);
    const path = url.pathname.replace(/^\/submissions(?=\/v1\/)/, "");
    const agentRequest = /^Bearer rwk_/i.test(authorization);
    let actor: string;
    if (agentRequest) {
      const readable = req.method === "GET" &&
        (/^\/v1\/tasks\/[^/]+\/submissions$/.test(path) ||
          /^\/v1\/submissions\/[^/]+$/.test(path));
      if (!readable) throw new ApiError(403, "human_session_required");
      actor = (await requireAgent(req, ["submissions:read"])).publisher_id;
    } else {
      const auth = await fetch(base + "/auth/v1/user", {
        headers: { apikey: serviceKey, Authorization: authorization },
        signal: AbortSignal.timeout(10000),
      });
      if (!auth.ok) {
        await auth.body?.cancel();
        throw new ApiError(
          auth.status >= 500 ? 503 : 401,
          auth.status >= 500 ? "auth_unavailable" : "unauthorized",
        );
      }
      const user = await auth.json();
      actor = uuid(user.id);
      if (!user.email_confirmed_at || user.is_anonymous) {
        throw new ApiError(403, "email_not_verified");
      }
    }
    let match: RegExpMatchArray | null;
    if (req.method === "GET") {
      if ((match = path.match(/^\/v1\/submissions\/([^/]+)$/))) {
        const found = await ownedSubmission(uuid(match[1]), actor);
        if (
          agentRequest && (await task(found.task_id)).publisher_id !== actor
        ) throw new ApiError(404, "submission_not_found");
        return json(await detail(found));
      }
      const own = path === "/v1/me/submissions";
      const list = path.match(/^\/v1\/tasks\/([^/]+)\/submissions$/);
      if (own || list) {
        const query: Record<string, string> = { select: "*", order: "id.asc" };
        if (own) {
          query.tester_id = "eq." + actor;
          if (url.searchParams.has("task_id")) {
            query.task_id = "eq." + uuid(url.searchParams.get("task_id"));
          }
        } else {
          const id = uuid(list![1]);
          if ((await task(id)).publisher_id !== actor) {
            throw new ApiError(404, "task_not_found");
          }
          query.task_id = "eq." + id;
        }
        const limit = Number(url.searchParams.get("limit") ?? 20);
        if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
          throw new ApiError(422, "invalid_limit");
        }
        if (url.searchParams.has("cursor")) {
          query.id = "gt." + uuid(url.searchParams.get("cursor"));
        }
        query.limit = String(limit + 1);
        const found = await rows("submissions", query);
        const page = found.slice(0, limit);
        const revisions = page.length
          ? await rows("submission_revisions", {
            id: "in.(" + page.map((s) => s.current_revision_id).join(",") + ")",
            select: "id,answers,operation_notes,submitted_at",
          })
          : [];
        const jobs = page.length
          ? await rows("submission_jobs", {
            revision_id: "in.(" + page.map((s) =>
              s.current_revision_id
            ).join(",") + ")",
            select: "revision_id,status,summary",
          })
          : [];
        const rewards = page.length
          ? await rows("payment_rewards", {
            submission_id: "in.(" + page.map((s) => s.id).join(",") + ")",
            select: "id,submission_id,state",
          })
          : [];
        return json({
          items: page.map((s) => {
            const reward = rewards.find((r) => r.submission_id === s.id);
            return {
              ...s,
              payment_status: reward?.state || s.payment_status,
              reward: reward || null,
              current_revision: revisions.find((r) =>
                r.id === s.current_revision_id
              ),
              ai: jobs.find((j) => j.revision_id === s.current_revision_id),
            };
          }),
          next_cursor: found.length > limit ? page.at(-1)!.id : null,
        });
      }
    }
    if (req.method === "POST") {
      if ((match = path.match(/^\/v1\/evidence\/([^/]+)\/read-url$/))) {
        const id = uuid(match[1]);
        const [e] = await rows("submission_evidence", {
          id: "eq." + id,
          select: "*",
        });
        if (!e) throw new ApiError(404, "evidence_not_found");
        if (e.uploader_id !== actor) {
          if ((await task(e.task_id)).publisher_id !== actor) {
            throw new ApiError(404, "evidence_not_found");
          }
          const revisions = await rows("submission_revisions", {
            evidence_ids: "cs.{" + id + "}",
            select: "id",
            limit: "1",
          });
          if (!revisions.length) throw new ApiError(404, "evidence_not_found");
        }
        return json(await signedRead(e));
      }
      let action: string;
      let target: string;
      if (path === "/v1/uploads") {
        action = "upload";
        target = "";
      } else if ((match = path.match(/^\/v1\/tasks\/([^/]+)\/submissions$/))) {
        action = "submit";
        target = uuid(match[1]);
      } else if (
        (match = path.match(
          /^\/v1\/submissions\/([^/]+)\/(revisions|decisions)$/,
        ))
      ) {
        action = match[2] === "revisions" ? "revise" : "decide";
        target = uuid(match[1]);
      } else throw new ApiError(404, "route_not_found");
      const key = req.headers.get("idempotency-key");
      if (!key || !/^[\x21-\x7e]{1,128}$/.test(key)) {
        throw new ApiError(422, "idempotency_key_required");
      }
      const body = validateBody(action, await readJson(req));
      if (action === "upload") target = uuid(body.task_id);
      const hash = Array.from(
        new Uint8Array(
          await crypto.subtle.digest(
            "SHA-256",
            new TextEncoder().encode(canonical(body)),
          ),
        ),
      ).map((v) => v.toString(16).padStart(2, "0")).join("");
      const [cached] = await rows("submission_api_requests", {
        principal_id: "eq." + actor,
        route: "eq." + action + ":" + target,
        key: "eq." + key,
        select: "request_hash,response",
      });
      if (cached && cached.request_hash !== hash) {
        throw new ApiError(409, "idempotency_conflict");
      }
      if (!cached && (action === "submit" || action === "revise")) {
        const taskId = action === "submit"
          ? target
          : (await ownedSubmission(target, actor)).task_id;
        await verifyEvidence(body.evidence_ids as string[], taskId, actor);
      }
      const result = cached?.response ??
        await upstream<Submission | Evidence>(
          "/rest/v1/rpc/mutate_submission",
          {
            method: "POST",
            body: JSON.stringify({
              p_actor: actor,
              p_action: action,
              p_target: target,
              p_body: body,
              p_key: key,
              p_hash: hash,
            }),
          },
        );
      if (action === "upload") {
        const evidence = result as Evidence;
        const signed = await upstream<{ url: string }>(
          `/storage/v1/object/upload/sign/${bucket}/${evidence.object_path}`,
          { method: "POST", body: "{}" },
        );
        return json({
          id: result.id,
          path: evidence.object_path,
          upload_url: base + "/storage/v1" + signed.url,
          method: "PUT",
          mime_type: evidence.mime_type,
        }, 201);
      }
      return json(result, action === "decide" ? 200 : 201);
    }
    throw new ApiError(404, "route_not_found");
  } catch (error) {
    const e = error instanceof ApiError || error instanceof AgentError
      ? error
      : new ApiError(500, "internal_error");
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
}
if (import.meta.main) Deno.serve(handle);
