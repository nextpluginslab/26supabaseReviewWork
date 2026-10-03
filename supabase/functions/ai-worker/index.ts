import {
  allowedRefs,
  classifyError,
  instructions,
  type Job,
  type Json,
  makeInput,
  parseResponse,
  PROMPT_VERSION,
  schemaForRefs,
  WorkerError,
} from "./core.ts";

type Config = {
  base: string;
  serviceKey: string;
  workerToken: string;
  openaiKey: string;
  model: string;
};
export function config(): Config {
  return {
    base: Deno.env.get("SUPABASE_URL") ?? "",
    serviceKey: Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
    workerToken: Deno.env.get("AI_WORKER_TOKEN") ?? "",
    openaiKey: Deno.env.get("OPENAI_API_KEY") ?? "",
    model: Deno.env.get("OPENAI_SUMMARY_MODEL") ?? "",
  };
}
export async function secureEqual(a: string, b: string): Promise<boolean> {
  const digest = async (s: string) =>
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)),
    );
  const [x, y] = await Promise.all([digest(a), digest(b)]);
  let difference = 0;
  for (let i = 0; i < x.length; i++) difference |= x[i] ^ y[i];
  return Boolean(a && b) && difference === 0;
}
export class Backend {
  constructor(private cfg: Config) {}
  async rpc<T>(name: string, body: Json = {}): Promise<T> {
    const r = await fetch(`${this.cfg.base}/rest/v1/rpc/${name}`, {
      method: "POST",
      headers: {
        apikey: this.cfg.serviceKey,
        Authorization: `Bearer ${this.cfg.serviceKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15000),
    });
    if (!r.ok) {
      await r.body?.cancel();
      throw new WorkerError("database_unavailable");
    }
    return await r.json();
  }
  async images(job: Job) {
    const images: { id: string; url: string }[] = [];
    const limitations: string[] = [];
    if (job.kind === "task") {
      return {
        images,
        limitations: [
          "Task summary uses current written answers and notes; screenshots and recordings were not inspected for this aggregate summary.",
        ],
      };
    }
    let bytes = 0;
    for (const e of job.payload.evidence ?? []) {
      if (!e.mime_type.startsWith("image/")) {
        limitations.push(
          `Video evidence ${e.id} was not analyzed; the publisher must inspect the recording.`,
        );
        continue;
      }
      if (images.length >= 4 || bytes + e.size_bytes > 10 * 1024 * 1024) {
        limitations.push(
          `Image evidence ${e.id} was not analyzed because the per-summary image limit was reached.`,
        );
        continue;
      }
      // Payload comes only from the trusted SQL claim RPC; reject malformed Storage paths.
      if (
        !e.object_path.startsWith(job.payload.task_id + "/") ||
        e.object_path.includes("..")
      ) throw new WorkerError("invalid_evidence_path", false);
      const path = e.object_path.split("/").map(encodeURIComponent).join("/");
      const r = await fetch(
        `${this.cfg.base}/storage/v1/object/sign/submission-evidence/${path}`,
        {
          method: "POST",
          headers: {
            apikey: this.cfg.serviceKey,
            Authorization: `Bearer ${this.cfg.serviceKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ expiresIn: 180 }),
          signal: AbortSignal.timeout(10000),
        },
      );
      if (!r.ok) {
        await r.body?.cancel();
        if (r.status >= 500 || r.status === 429) {
          throw new WorkerError("storage_unavailable");
        }
        limitations.push(
          `Image evidence ${e.id} could not be accessed and was not analyzed.`,
        );
        continue;
      }
      const data = await r.json();
      if (
        typeof data.signedURL !== "string" ||
        !data.signedURL.startsWith("/object/sign/")
      ) throw new WorkerError("invalid_storage_response");
      images.push({
        id: e.id,
        url: this.cfg.base + "/storage/v1" + data.signedURL,
      });
      bytes += e.size_bytes;
    }
    return { images, limitations };
  }
  async generate(job: Job) {
    const { images, limitations } = await this.images(job);
    const input = makeInput(job, images, limitations);
    const r = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.cfg.openaiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: this.cfg.model,
        store: false,
        instructions,
        input: [{ role: "user", content: input }],
        max_output_tokens: 3500,
        text: {
          format: {
            type: "json_schema",
            name: "feedback_summary",
            strict: true,
            schema: schemaForRefs(allowedRefs(job)),
          },
        },
      }),
      signal: AbortSignal.timeout(60000),
    });
    if (!r.ok) {
      await r.body?.cancel();
      throw new WorkerError(
        `openai_http_${r.status}`,
        r.status === 429 || r.status >= 500 || r.status === 408,
      );
    }
    const data = await r.json();
    const summary = parseResponse(data, allowedRefs(job));
    summary.limitations = [
      ...new Set([...summary.limitations, ...limitations]),
    ];
    const usage = data.usage
      ? {
        input_tokens: data.usage.input_tokens,
        output_tokens: data.usage.output_tokens,
        total_tokens: data.usage.total_tokens,
      }
      : {};
    return { summary, usage, model: data.model ?? this.cfg.model };
  }
}
export async function processOne(db: Backend): Promise<string> {
  const job = await db.rpc<Job | null>("ai_claim_job");
  if (!job) return "idle";
  try {
    const result = await db.generate(job);
    const saved = await db.rpc<boolean>("ai_finish_job", {
      p_kind: job.kind,
      p_id: job.id,
      p_token: job.lease_token,
      p_version: job.version,
      p_summary: result.summary,
      p_snapshot: job.kind === "task" ? job.payload : null,
      p_model: result.model,
      p_prompt_version: PROMPT_VERSION,
      p_usage: result.usage,
    });
    console.log(
      JSON.stringify({
        job_id: job.id,
        kind: job.kind,
        status: saved ? "succeeded" : "superseded",
      }),
    );
    return saved ? "succeeded" : "superseded";
  } catch (error) {
    const e = classifyError(error);
    await db.rpc("ai_fail_job", {
      p_kind: job.kind,
      p_id: job.id,
      p_token: job.lease_token,
      p_version: job.version,
      p_error: e.code,
      p_retryable: e.retryable,
    });
    console.error(
      JSON.stringify({ job_id: job.id, kind: job.kind, error_code: e.code }),
    );
    return "failed";
  }
}
// Keep each invocation within the Edge runtime budget. Cron drains remaining jobs.
export async function drain(cfg: Config) {
  const db = new Backend(cfg);
  for (let i = 0; i < 2; i++) if (await processOne(db) === "idle") break;
}
export async function handle(
  req: Request,
  cfg = config(),
  schedule?: (promise: Promise<unknown>) => void,
): Promise<Response> {
  const json = (body: Json, status: number) =>
    Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
  if (req.method !== "POST") return json({ code: "method_not_allowed" }, 405);
  if (
    !await secureEqual(
      req.headers.get("x-ai-worker-token") ?? "",
      cfg.workerToken,
    )
  ) return json({ code: "unauthorized" }, 401);
  if (!cfg.base || !cfg.serviceKey || !cfg.openaiKey || !cfg.model) {
    return json({ code: "worker_not_configured" }, 503);
  }
  // Client cannot select a model, job, prompt or source: all work comes from SQL.
  const work = drain(cfg).catch(() =>
    console.error(JSON.stringify({ error_code: "worker_drain_failed" }))
  );
  if (schedule) {
    schedule(work);
    return json({ status: "accepted" }, 202);
  }
  await work;
  return json({ status: "completed" }, 200);
}
if (import.meta.main) {
  const runtime = (globalThis as unknown as {
    EdgeRuntime?: { waitUntil(promise: Promise<unknown>): void };
  }).EdgeRuntime;
  Deno.serve((req) =>
    handle(req, config(), runtime ? (p) => runtime.waitUntil(p) : undefined)
  );
}
