# AI summary worker

The `ai-worker` Supabase Edge Function consumes the existing `submission_jobs` table. The deployed submission transaction already inserts one job for each formal revision; no browser trigger or change to the task/submissions functions is needed.

## Integration

- Submission results are written to `submission_jobs.summary`, with `status` equal to `queued`, `running`, `succeeded`, or `failed`. Existing submission detail/list APIs already read this table and expose `ai` for the relevant revision.
- Task results are stored in `task_ai_summaries`. The backend task/results handler can call service-role RPC `ai_task_result({p_task_id})` **after verifying task ownership**. It returns `status`, `summary`, `snapshot`, `stale`, `completed_at`, and `error_code`. This work does not overwrite the separately deployed task API or add a frontend endpoint.
- A task summary snapshot contains all current formal revisions, their processing statuses, the published questionnaire, and SQL-computed statistics. A previous summary remains paired with its original snapshot when stale. Do not combine old text with new counts as a single current report.
- Each output contains `summary`, `findings`, `evidence_observations`, `suggested_followups`, and `limitations`. Findings carry exact revision/answer/evidence references such as `revision:<uuid>/answer:<question_key>`.
- The worker never writes submissions, decisions, rewards, payments, or budgets. AI suggestions are advisory.

## Queue and concurrency

A best-effort `pg_net` wake follows insertion of a submission job. A `pg_cron` job named `reviewwork-ai-worker` checks due work every minute, recovering missed wakes and retrying transient failures. Empty queues cause no HTTP request or model call. Review-state changes queue a new task summary and are picked up by cron.

Claims are atomic Postgres RPCs with `SKIP LOCKED`, a global maximum of two active leases, a three-minute lease, fencing tokens, and at most three attempts. An invocation handles at most two jobs. OpenAI calls have a 60-second timeout. Rate limits, transient server errors and timeouts retry with bounded backoff; refusal, non-retryable provider errors and oversized inputs fail explicitly. Crashed jobs recover after lease expiry. Logs contain only job IDs, kinds and safe error codes.

Submission summaries are tied to immutable revision IDs. A late result can never overwrite a newer revision. Task changes increment `requested_version`; completion for an outdated version is discarded and requeued. A task summary waits for current submission jobs to finish or fail, but does not require AI success to summarize written feedback.

## Model and evidence

The model is explicitly configured through `OPENAI_SUMMARY_MODEL`; the initial deployment pins `gpt-4.1-mini-2025-04-14`. Responses API Structured Outputs uses `store: false`. The worker validates the schema and every citation independently after model generation.

A submission summary analyzes up to four screenshots with a combined declared size of 10 MiB using short-lived private Storage links. It explicitly lists omitted/inaccessible images. Videos are metadata only and always carry a limitation requiring publisher review. Aggregate summaries use written answers and notes, not screenshot or video pixels. Input is limited to 160,000 JSON characters; oversized input fails rather than silently sampling or truncating the dataset. These are MVP processing limits, not task or upload limits.

Task content, questionnaire text, notes, answers and images are untrusted input. The model has no tools and cannot execute workflow actions. Structured outputs and citation checking do not guarantee factual correctness; publishers retain access to original evidence.

## Deployment

Migrations `20261004000000_ai_worker.sql`, `20261004002000_ai_claim_alias.sql`, and `20261004003000_ai_retry_new_version.sql` depend on the existing `20261003230000_task_api` and `20261003231000_submissions_api` migrations. Merge those prerequisite migrations before deploying to a fresh project. This worker change intentionally does not copy/rewrite the separate task/submission implementations.

1. Apply the additive migration using the normal linked Supabase CLI migration workflow. It enables `pg_net`/`pg_cron` if necessary and creates the queue RPCs, triggers and scheduler.
2. Configure `OPENAI_API_KEY`, `OPENAI_SUMMARY_MODEL` and a random `AI_WORKER_TOKEN` (at least 32 characters) in Edge Function Secrets. Supabase URL/service credentials are injected by the runtime.
3. Deploy only `ai-worker` with `supabase functions deploy ai-worker --project-ref <ref> --use-api`.
4. Using a trusted backend service-role client, call `ai_configure_worker` with `p_url = https://<ref>.supabase.co/functions/v1/ai-worker` and `p_token` equal to the worker token. It stores the dedicated token and URL in Vault. Never put the token in source, SQL migrations, logs or browser code.

Gateway JWT verification is disabled only for this function because `pg_net` authenticates with a dedicated `x-ai-worker-token`. The handler checks it before claiming jobs. An anon key, ordinary user JWT, or service-role JWT alone does not authorize a worker invocation. All AI RPCs and tables are restricted to service-role access; existing ownership checks remain in the business APIs.

Rotate the token in Edge Secrets and Vault together. To pause dispatch, unschedule only `reviewwork-ai-worker` and remove its Vault configuration; queued work is retained. Do not reset the database or delete existing submissions.

## Verification

```sh
deno check supabase/functions/ai-worker/index.ts
deno lint supabase/functions/ai-worker
deno test supabase/functions/ai-worker/core_test.ts
node --env-file=<backend-env-path> backend/tests/ai-worker-live.mjs
```

The live test is restricted to project `myjdykfmxspqtgbuoqdt`. It creates tagged temporary users, tasks and synthetic image evidence; invokes the real deployed submission API; waits for automatic dispatch and real OpenAI summaries; checks details, revisions, all-status counts, stale completion fencing, retry limits, permission denial, and unchanged review/payment states. It cleans up only IDs it created, including on failure. No email is sent, no Stripe calls occur, and model calls incur normal API usage.

References: [OpenAI Structured Outputs](https://developers.openai.com/api/docs/guides/structured-outputs), [Supabase scheduled Edge Functions](https://supabase.com/docs/guides/functions/schedule-functions).

## Live verification record — 2026-10-03

- Deployed `ai-worker` version 2, status `ACTIVE`, to `myjdykfmxspqtgbuoqdt`; applied all three AI migrations. Other business functions were not redeployed by this change.
- `deno check`, `deno lint`, formatting checks and 10 unit tests passed.
- Final clean live run passed 30 checks using automatic submission-trigger/cron dispatch only, real OpenAI responses and database writes. No manual worker invocation was used in this final run.
- After one tester revised their answer, two logical submissions still produced exactly two responses: Yes 2, No 0, Not sure 0. State counts remained one awaiting publisher and one declined. Both original and revised submission summaries were accessible through the existing submission detail API.
- Tested ordinary-user RPC/worker denial, stale result rejection, fresh retry budget for new source versions, invalid lease rejection and the three-attempt retry limit. AI did not change decisions or payment states.
- Tagged users/tasks, Storage fixtures, revisions, jobs, notifications (via existing cascades) and aggregate summaries were cleaned up; the worker and minute scheduler remain deployed.
- The first diagnostic run found an SQL record/table alias collision, fixed by the follow-up migration. Citation generation was also constrained to the exact permitted source references before the final clean run.

## Evidence confidence (prompt v2)

New submission summaries require `confidence_score` (integer 0–10) and
`confidence_reason` (nonempty English explanation). The score measures support
for a relevant testing experience against the task requirements, including
well-documented blockers. It is not sentiment, authenticity, an approval, or a
payment decision. Aggregate task summaries use a null score.

The results list and submission detail show a colored progress bar: 0–4
insufficient evidence, 5–7 partial support, 8–10 strong support. Details also
show evidence observations, follow-up suggestions and limitations. Legacy
summaries remain readable and display “Not scored · earlier review”; no score
is inferred from old text. New scoring requires deployment of `ai-worker` and
the frontend. Existing completed jobs are not automatically regenerated.
