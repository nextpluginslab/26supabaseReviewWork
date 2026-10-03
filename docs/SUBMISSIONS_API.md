# Submissions API (MVP)

Deployed project: `myjdykfmxspqtgbuoqdt`.

Base URL: `https://myjdykfmxspqtgbuoqdt.supabase.co/functions/v1/submissions/v1`

The separate `submissions` Edge Function avoids overwriting the existing task `api` function. It reuses `public.tasks.published_config`, `deadline_at`, and publisher ownership from migration `20261003230000_task_api.sql` (retrieved from the linked project without modification). Task creation/publishing stays in the existing task API. All paths below are relative to this base.

## Authentication and request conventions

- Every request except CORS OPTIONS requires `Authorization: Bearer <Supabase user access token>`. The function validates the token with Supabase Auth `/user`; it does not trust locally decoded JWT data, email input, or owner IDs from the client. Verified email is required. Agent keys are not supported by this implementation.
- Function gateway `verify_jwt=false` is intentional: authentication is enforced in the handler, including support for asymmetric user JWTs. It does not make the business endpoints public.
- JSON mutations require `Content-Type: application/json` and `Idempotency-Key` (1–128 printable ASCII characters). The read-url operation does not require an idempotency key/body.
- Mutation keys are scoped to user + action + resource. A replay returns the original business result. The same key with a different body returns 409. Upload replay reuses the same evidence object but can issue a fresh upload URL.
- Revisions and decisions require both `expected_revision_id` and `expected_version`, taken from the latest submission response. Concurrent changes return 409.
- Limits: request body 256 KiB; 1–100 answers; reasons/notes up to 10,000 characters; 1–10 distinct evidence files per revision; 50 MiB per file; at most 100 upload intents per user/task; 60 successful mutations per user/minute. Question/option keys up to 128 characters. Limits are enforced in the handler and critical checks again in the database.
- Errors: `{ "code": "version_conflict", "message": "version_conflict", "field_errors": {}, "request_id": "..." }`. Field-specific diagnostics are not implemented yet. Responses are `Cache-Control: no-store`.

## Routes

| Method | Path | Authorization / response |
|---|---|---|
| POST | `/uploads` | Verified tester; creates upload intent and signed PUT URL; 201 |
| POST | `/tasks/{task_id}/submissions` | Verified tester; creates a **formal** submission and first revision; 201 |
| POST | `/submissions/{id}/revisions` | Submission owner, only while `changes_requested`; submits complete next revision; 201 |
| GET | `/me/submissions?task_id={id}&limit=20&cursor={id}` | Current user's submissions; optional task filter |
| GET | `/submissions/{id}` | Submission owner or task publisher; full history, decisions, AI states and signed evidence URLs |
| GET | `/tasks/{task_id}/submissions?limit=20&cursor={id}` | Task publisher only; latest formal answers, states and AI summaries |
| POST | `/submissions/{id}/decisions` | Task publisher's verified user session; 200 |
| POST | `/evidence/{id}/read-url` | Uploader, or task publisher after evidence has been formally submitted; 300-second read URL |

Lists return `{ "items": [...], "next_cursor": "uuid-or-null" }`, ordered by UUID ascending, with limit 1–100. The cursor is an opaque continuation position, not a chronological sort. A tester cannot use the publisher list endpoint. Inaccessible submissions/evidence return 404.

### 1. Upload evidence

`POST /uploads`:

```json
{
  "task_id": "<task UUID>",
  "name": "blocker.png",
  "mime_type": "image/png",
  "size_bytes": 12345
}
```

Response: `{ "id": "<evidence UUID>", "path": "...", "upload_url": "...", "method": "PUT", "mime_type": "image/png" }`.

Upload raw file bytes to `upload_url` with `PUT` and the declared `Content-Type`. Do not send the user's bearer token to the signed URL; the URL carries its authorization. Store the returned evidence `id` for formal submission. URLs are temporary; replay the upload-intent request if a new URL is needed. A grant cannot overwrite an existing object. Bucket `submission-evidence` is private, with no direct client mutation policies.

Supported MIME types: PNG, JPEG, WebP, MP4, QuickTime, WebM, additionally restricted by the task's published `evidence_types`. SVG is not accepted. Formal submission streams the actual uploaded file to check size and magic bytes; the database also checks object metadata and ownership inside the transaction. Header checks do not prove screenshot authenticity or fully decode media.

### 2. Formal submission

`POST /tasks/{task_id}/submissions`:

```json
{
  "operation_notes": "I could not find the playback control.",
  "answers": [
    {
      "question_key": "choice",
      "selected_option_key": "no",
      "reason": "I could not complete the workflow."
    }
  ],
  "evidence_ids": ["<uploaded evidence UUID>"]
}
```

Every published question must have exactly one valid option and nonblank reason. No sentiment or completion-based rejection is performed. Unknown fields, duplicate answers, cross-task files/options and unuploaded evidence fail validation. Task must be published and before its deadline. One submission per task/user; subsequent changes use revisions.

Response contains `id`, `submission_no`, `task_id`, `tester_id`, `current_revision_id`, `version`, `processing_status: "awaiting_publisher"`, `payment_status: "awaiting_confirmation"`, timestamps and `ai_status: "queued"`.

### 3. Publisher decision

`POST /submissions/{id}/decisions`:

```json
{
  "action": "request_changes",
  "reason": "Please show where you looked for the control.",
  "expected_revision_id": "<current revision UUID>",
  "expected_version": 1
}
```

Actions: `accept`, `request_changes`, `decline`. Request changes/decline require a reason. Free acceptance sets `accepted` + `not_required`; decline sets `declined` + `not_payable`. Both are terminal. Requests for changes set `changes_requested`; publisher can still accept/decline the latest formal revision. Decisions increment `version` even if the revision ID is unchanged.

Paid acceptance returns **409 `payment_not_configured`**, atomically leaving the submission and decision history unchanged. This matches the existing task API's paid-publication restriction. No Stripe payment or budget mutation is claimed.

### 4. Supplementary revision

`POST /submissions/{id}/revisions` accepts the same **complete snapshot** as the first submission, plus `expected_revision_id` and `expected_version`. Include retained evidence IDs as well as new ones; omitted files remain in history but are absent from the latest revision. Send every question's answer, including unchanged answers.

Only the tester can supplement after a publisher requests changes. Expired or closed tasks still allow these supplements and their uploads. Original submission number remains unchanged; every revision is preserved, the version increments, and processing returns to `awaiting_publisher`. Accepted/declined submissions cannot reopen.

## Persistence and scope

New tables: `submissions`, `submission_revisions`, `submission_evidence`, `submission_decisions`, `submission_jobs`, `submission_api_requests`. All enable RLS and deny direct anon/authenticated reads/writes. The service-only `mutate_submission` RPC atomically handles revisions, state transitions, idempotency and AI job creation. The Edge Function checks ownership for all service-role reads.

Answers are stored as JSON snapshots against the immutable published task questionnaire. Files can be reused only within the same task and uploader. The current revision has a composite ownership FK; decisions reference a revision of the same submission. Submission uniqueness, row locks and both concurrency tokens prevent duplicate submissions and competing decisions.

AI jobs are persisted in `submission_jobs` but **no AI worker is included**; they remain queued until a worker is connected. No Stripe transfer, task results aggregation, notification service, server-side draft save or frontend adapter conversion is included. This intentionally implements the simplified MVP discussed in chat, not the older draft/submit split in SPEC §6.2. The old Spec remains a larger roadmap; this document is the contract for this deployed slice.

There is no client file-deletion endpoint yet. Unused upload intents and objects need a future bounded cleanup policy; the per-task quota counts all intents. The live test removes its own unused objects and metadata.

## Verification and deployment

```sh
deno check supabase/functions/submissions/index.ts
deno lint supabase/functions/submissions
deno test supabase/functions/submissions/validation_test.ts
supabase db push --linked --dry-run
supabase db push --linked
supabase functions deploy submissions --project-ref myjdykfmxspqtgbuoqdt --use-api
node --env-file=<path-to-backend-env> backend/tests/submissions-live.mjs
```

Live tests require `SUPABASE_URL` and server-only `SUPABASE_SERVICE_ROLE_KEY`, assert the exact target project, create temporary Auth users without sending emails, create isolated task/file fixtures, and clean up only the generated IDs in FK order. They verify real Auth/Storage/HTTP/database behavior. No database reset or changes to existing tasks are performed. Run only when authorized to test against this project.

Verified on 2026-10-03: Deno typecheck, lint and formatting passed; 8 unit tests passed; the deployed function passed 64 live checks, including concurrent first submissions and competing decisions, pagination, expired-task supplements, idempotent retries, private storage reads, signed-upload overwrite rejection, client REST/RPC bypass rejection, and paid-acceptance rollback. Function `submissions` is ACTIVE (version 2); migration `20261003231000` is applied. Existing task function `api` remained at version 1.
