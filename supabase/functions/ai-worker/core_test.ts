import {
  allowedRefs,
  classifyError,
  type Job,
  makeInput,
  parseResponse,
  validateSummary,
  WorkerError,
} from "./core.ts";
import { type Backend, handle, processOne, secureEqual } from "./index.ts";
function assert(ok: unknown, message = "Assertion failed"): asserts ok {
  if (!ok) throw new Error(message);
}
function throws(fn: () => unknown, code: string) {
  try {
    fn();
  } catch (e) {
    assert(e instanceof WorkerError && e.code === code);
    return;
  }
  throw new Error("Expected " + code);
}
const source = {
  submission_id: "s1",
  revision_id: "r1",
  operation_notes: "Blocked",
  answers: [{
    question_key: "choice",
    selected_option_key: "no",
    reason: "Missing control",
  }],
};
const job: Job = {
  kind: "submission",
  id: "j1",
  lease_token: "token1",
  version: 0,
  payload: {
    ...source,
    task_id: "t1",
    config: { app_name: "Example" },
    evidence: [{
      id: "e1",
      name: "proof.png",
      mime_type: "image/png",
      size_bytes: 100,
      object_path: "t1/private/e1",
    }],
  },
};
const summary = () => ({
  confidence_score: 4 as number | null,
  confidence_reason: "The reported blocker lacks visual confirmation.",
  summary: "The tester could not find a control.",
  findings: [{
    text: "A control is missing according to the tester.",
    source_refs: ["revision:r1/answer:choice"],
  }],
  evidence_observations: [],
  suggested_followups: [],
  limitations: ["Evidence does not prove completion."],
});
Deno.test("rejects foreign revision citations and workflow fields", () => {
  const refs = allowedRefs(job);
  assert(refs.has("revision:r1/evidence:e1"));
  validateSummary(summary(), refs);
  throws(
    () => validateSummary({ ...summary(), approved: true }, refs),
    "invalid_model_output",
  );
  const value = summary();
  value.findings[0].source_refs = ["revision:foreign/answer:choice"];
  throws(() => validateSummary(value, refs), "invalid_model_output");
  value.findings[0].source_refs = [];
  throws(() => validateSummary(value, refs), "invalid_model_output");
});
Deno.test("task references only supplied current revisions", () => {
  const task: Job = {
    ...job,
    kind: "task",
    payload: {
      ...job.payload,
      evidence: [],
      submissions: [{ ...source, revision_id: "r2", evidence_ids: ["e2"] }],
    },
  };
  const refs = allowedRefs(task);
  assert(!refs.has("revision:r1/answer:choice"));
  assert(refs.has("revision:r2/evidence:e2"));
});
Deno.test("model input excludes private paths; oversized input fails explicitly", () => {
  const text = JSON.stringify(makeInput(job, [], []));
  assert(!text.includes("t1/private/e1"));
  throws(
    () =>
      makeInput(
        {
          ...job,
          payload: { ...job.payload, operation_notes: "x".repeat(160001) },
        },
        [],
        [],
      ),
    "input_too_large",
  );
});
Deno.test("refused, incomplete, malformed responses cannot become summaries", () => {
  throws(
    () => parseResponse({ status: "incomplete", output: [] }, allowedRefs(job)),
    "model_response_incomplete",
  );
  throws(
    () =>
      parseResponse({
        status: "completed",
        output: [{ type: "message", content: [{ type: "refusal" }] }],
      }, allowedRefs(job)),
    "model_refusal",
  );
  throws(
    () =>
      parseResponse({
        status: "completed",
        output: [{
          type: "message",
          content: [{ type: "output_text", text: "oops" }],
        }],
      }, allowedRefs(job)),
    "invalid_model_output",
  );
  assert(
    parseResponse({
      status: "completed",
      output: [{
        type: "message",
        content: [{ type: "output_text", text: JSON.stringify(summary()) }],
      }],
    }, allowedRefs(job)).summary.length > 0,
  );
});
Deno.test("worker rejects anonymous/users and missing secrets before starting work", async () => {
  const cfg = {
    base: "https://example.com",
    serviceKey: "service",
    workerToken: "secret",
    openaiKey: "key",
    model: "model",
  };
  assert(
    (await handle(new Request("https://example.com", { method: "POST" }), cfg))
      .status === 401,
  );
  assert(
    (await handle(
      new Request("https://example.com", {
        method: "POST",
        headers: { authorization: "Bearer user" },
      }),
      cfg,
    )).status === 401,
  );
  assert(
    (await handle(
      new Request("https://example.com", {
        method: "POST",
        headers: { "x-ai-worker-token": "secret" },
      }),
      { ...cfg, model: "" },
    )).status === 503,
  );
  assert(!await secureEqual("", ""));
  assert(!await secureEqual("secret", "different"));
  assert(await secureEqual("secret", "secret"));
});
Deno.test("worker only finishes leased AI job, preserving version fencing", async () => {
  const calls: { name: string; body: Record<string, unknown> }[] = [];
  const db = {
    rpc: (name: string, body: Record<string, unknown> = {}) => {
      calls.push({ name, body });
      return Promise.resolve(name === "ai_claim_job" ? job : false);
    },
    generate: () =>
      Promise.resolve({ summary: summary(), model: "model", usage: {} }),
  } as unknown as Backend;
  assert(await processOne(db) === "superseded");
  assert(calls.map((c) => c.name).join(",") === "ai_claim_job,ai_finish_job");
  assert(calls[1].body.p_token === job.lease_token);
  assert(calls[1].body.p_snapshot === null);
});
Deno.test("provider failure records a safe retry code, never the raw error", async () => {
  const calls: { name: string; body: Record<string, unknown> }[] = [];
  const db = {
    rpc: (name: string, body: Record<string, unknown> = {}) => {
      calls.push({ name, body });
      return Promise.resolve(name === "ai_claim_job" ? job : true);
    },
    generate: () => {
      throw new Error("sensitive provider detail");
    },
  } as unknown as Backend;
  assert(await processOne(db) === "failed");
  assert(calls[1].name === "ai_fail_job");
  assert(calls[1].body.p_error === "worker_error");
  assert(calls[1].body.p_retryable === true);
  assert(
    classifyError(new DOMException("secret", "TimeoutError")).code ===
      "upstream_timeout",
  );
});

Deno.test("video inputs are never signed or sent as images", async () => {
  const { Backend } = await import("./index.ts");
  const backend = new Backend({
    base: "https://example.com",
    serviceKey: "service",
    workerToken: "secret",
    openaiKey: "key",
    model: "model",
  });
  const videoJob: Job = {
    ...job,
    payload: {
      ...job.payload,
      evidence: [{
        id: "video1",
        name: "recording.mp4",
        mime_type: "video/mp4",
        size_bytes: 100,
        object_path: "t1/private/video1",
      }],
    },
  };
  const result = await backend.images(videoJob);
  assert(result.images.length === 0);
  assert(
    result.limitations.some((l) =>
      l.includes("Video evidence video1 was not analyzed")
    ),
  );
});
Deno.test("aggregate inputs explicitly disclose evidence analysis limits", async () => {
  const { Backend } = await import("./index.ts");
  const backend = new Backend({
    base: "https://example.com",
    serviceKey: "service",
    workerToken: "secret",
    openaiKey: "key",
    model: "model",
  });
  const result = await backend.images({ ...job, kind: "task" });
  assert(result.images.length === 0);
  assert(result.limitations[0].includes("not inspected"));
});

Deno.test("structured schema restricts citations to the current source set", async () => {
  const { schemaForRefs } = await import("./core.ts");
  const refs = allowedRefs(job);
  const schema = schemaForRefs(refs);
  assert(
    schema.properties.findings.items.properties.source_refs.items.enum.every((
      ref,
    ) => refs.has(ref)),
  );
  assert(
    schema.properties.findings.items.properties.source_refs.minItems === 1,
  );
  assert(schemaForRefs(new Set()).properties.findings.maxItems === 0);
});

Deno.test("confidence must be an integer 0-10; submission and aggregate scores differ", () => {
  const refs = allowedRefs(job);
  for (const score of [-1, 11, 2.5, "8", undefined, NaN]) {
    throws(
      () => validateSummary({ ...summary(), confidence_score: score }, refs),
      "invalid_model_output",
    );
  }
  for (const score of [0, 4, 7, 10]) {
    validateSummary({ ...summary(), confidence_score: score }, refs);
  }
  throws(
    () => validateSummary({ ...summary(), confidence_reason: "" }, refs),
    "invalid_model_output",
  );
  const response = (score: number | null) => ({
    status: "completed",
    output: [{
      type: "message",
      content: [{
        type: "output_text",
        text: JSON.stringify({ ...summary(), confidence_score: score }),
      }],
    }],
  });
  throws(
    () => parseResponse(response(null), refs, "submission"),
    "invalid_model_output",
  );
  throws(
    () => parseResponse(response(8), refs, "task"),
    "invalid_model_output",
  );
  assert(parseResponse(response(null), refs, "task").confidence_score === null);
});
