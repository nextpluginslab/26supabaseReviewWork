# Evidence uploads: deployed MVP contract

Project: `myjdykfmxspqtgbuoqdt`.

Endpoint: `POST https://myjdykfmxspqtgbuoqdt.supabase.co/functions/v1/submissions/v1/uploads`

The deployed `submissions` Edge Function already implements upload authorization and
formal-submission verification. This work reuses that implementation; it does not
deploy a second upload function or overwrite the task API. The implementation and
database migration are in the `codex/submissions-api` branch (baseline commit
`4e90356`), under `supabase/functions/submissions/` and
`supabase/migrations/20261003231000_submissions_api.sql`. This worktree adds the
focused live regression suite and this integration contract.

## 1. Obtain upload authorization

Headers:

```http
Authorization: Bearer <Supabase user access token>
Content-Type: application/json
Idempotency-Key: <unique key for this file's upload intent>
```

The user must have a verified email. Never use a service-role key in frontend code.
The function validates identity through Supabase Auth and checks the published
task's evidence types and deadline. Closed/expired tasks allow new uploads only
for the tester's existing submission in `changes_requested`.

Request:

```json
{
  "task_id": "<task UUID>",
  "name": "screenshot.png",
  "mime_type": "image/png",
  "size_bytes": 12345
}
```

Response (`201`):

```json
{
  "id": "<evidence UUID>",
  "path": "<task UUID>/<user UUID>/<evidence UUID>",
  "upload_url": "<temporary signed Storage URL>",
  "method": "PUT",
  "mime_type": "image/png"
}
```

Persist `id` with the feedback draft. The server assigns the object path; clients
cannot specify an owner, bucket or path. Replaying the same key/body reuses the
same evidence record and issues an upload URL. Reusing the key with different
metadata returns `409 idempotency_conflict`.

## 2. Upload the actual file

Send the raw file bytes, not multipart form data, to `upload_url`:

```javascript
const result = await fetch(upload.upload_url, {
  method: "PUT",
  headers: { "Content-Type": file.type },
  body: file,
});
if (!result.ok) throw new Error("Evidence upload failed");
```

Do not attach the user's token or an API key to this request. The URL is itself
an upload credential; do not log or share it. Supabase signed upload URLs are
valid for two hours. They do not permit overwriting an existing object, including
when a client attempts `x-upsert: true`.

The private `submission-evidence` bucket allows PNG, JPEG, WebP, MP4, QuickTime and
WebM, further restricted by the task's `evidence_types`. SVG is not accepted.
Files must be non-empty and at most **50 MiB (52,428,800 bytes)**. The current
submission service permits at most 10 evidence IDs per revision and 100 upload
intents per user/task, with a 60-successful-mutations/user/minute limit.

## 3. Submit evidence references

Send `evidence_ids` with the existing formal submission request:

`POST /functions/v1/submissions/v1/tasks/{task_id}/submissions`

```json
{
  "operation_notes": "I could not complete the first step.",
  "answers": [
    {
      "question_key": "choice",
      "selected_option_key": "no",
      "reason": "The control was not visible."
    }
  ],
  "evidence_ids": ["<evidence UUID>"]
}
```

Use the task's actual question/option keys and include every question. Submission
requires the same authentication and a separate idempotency key. Uploading alone
does not create a formal submission.

Before accepting a submission, the server checks that each file belongs to the
authenticated tester and the same task, streams the uploaded bytes to verify
actual size and media signature, and checks Storage size/MIME metadata within
the database transaction. Missing objects, cross-owner/task references, size or
MIME mismatches, and obvious fake media are rejected with `422 invalid_evidence`.
Media-header checks do not fully decode files or prove that evidence is authentic.

Requested supplements use `POST /submissions/{id}/revisions`, with the complete
next answers/evidence snapshot, `expected_revision_id` and `expected_version`.
Retain existing evidence IDs when they should remain in the new revision.

## 4. Preview evidence

`GET /submissions/{id}` returns evidence metadata and 300-second signed read URLs
to the tester or task publisher. Refresh a link with
`POST /evidence/{id}/read-url`. The publisher cannot read an upload before it is
formally submitted; another tester cannot read it. Public object URLs cannot
read the private bucket. Browser users cannot directly modify evidence metadata
or delete/overwrite the stored objects.

## Errors

Error bodies contain `code`, `message`, `field_errors` and `request_id`.

| Status | Examples |
| --- | --- |
| 401 | Missing or invalid user access token |
| 403 | Email not verified |
| 404 | Unknown/unpublished task or inaccessible evidence |
| 409 | Task closed, idempotency conflict |
| 422 | Invalid metadata, unsupported type, invalid evidence |
| 429 | Mutation rate limit or upload-intent quota exceeded |

## Live verification

Verified on **2026-10-03** against the deployed project: **38 checks passed**,
including real signed upload → formal submission → publisher preview, invalid
metadata, missing/fake/mismatched evidence, cross-user/task isolation, overwrite
and direct-write protection, and closed-task supplementary uploads. Cleanup of
the run's tasks, evidence records, stored files and Auth users was verified.
No function or database redeployment was necessary.

```sh
node --check backend/tests/uploads-live.mjs
node --env-file=<server-env-file> backend/tests/uploads-live.mjs
```

The server env file must contain `SUPABASE_URL` and
`SUPABASE_SERVICE_ROLE_KEY`. The suite refuses a different project URL. It creates
temporary Auth accounts without sending email, creates/publishes zero-reward
tasks through the task API, exercises real Storage uploads and submission
validation, and cleans up only IDs generated by that run. No payments or AI
model calls are made. The deployed submission service records queued AI jobs;
the suite removes its own jobs during cleanup.

Cleanup runs in `finally`, deletes Storage objects through the Storage API, and
checks that fixture tasks, evidence records, files and users are gone. Do not run
automatically during builds: this is an explicitly authorized live-project test.

The frontend task page still uses its existing mock adapter. Connecting real
Auth sessions and replacing that adapter are separate work. Unused production
upload intents/files still need a retention and cleanup policy; this change
does not delete existing user data or add a client deletion endpoint.

Reference: [Supabase signed upload URLs](https://supabase.com/docs/reference/javascript/file-buckets-createsigneduploadurl).
