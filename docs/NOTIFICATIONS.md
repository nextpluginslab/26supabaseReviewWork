# Notifications API

The `notifications` Edge Function owns the inbox. It does not replace the deployed
`api` or `submissions` functions. Notifications are in-app records, not email or
push messages. No frontend notification UI is included in this backend change.

Base URL:

```text
https://myjdykfmxspqtgbuoqdt.supabase.co/functions/v1/notifications/v1
```

Both routes require `Authorization: Bearer <Supabase user access token>` and a
verified, non-anonymous email identity. The function validates the token with Auth
and forwards that user's JWT to PostgREST; it never uses the service-role key.
`verify_jwt = false` disables only the gateway's legacy JWT verification, not the
handler's authentication. Browser clients can send their public `apikey` header.

## List

`GET /me/notifications?limit=20&unread_only=false&cursor=...`

- `limit`: integer 1–100, default 20.
- `unread_only`: `true` or `false`, default `false`.
- `cursor`: opaque `next_cursor` from the previous page; omit on the first page.
- Newest first, ordered by `(created_at DESC, id DESC)`; tied timestamps paginate
  without skipping rows. Keep filters unchanged between pages.
- `unread_count` counts the entire user's unread inbox, not just this page. It is
  a separate database read and can briefly differ during concurrent updates.
- No caller-supplied recipient ID is accepted.

```json
{
  "items": [{
    "id": "notification-uuid",
    "type": "changes_requested",
    "entity_id": "submission-uuid",
    "task_id": "task-uuid",
    "title": "More information requested",
    "body": "Please add a screenshot of the blocked step.",
    "created_at": "2026-10-03T22:00:00+00:00",
    "read_at": null
  }],
  "next_cursor": null,
  "unread_count": 1
}
```

`entity_id` currently identifies a submission; `task_id` locates its task. Fetch
the authorized submission API for current state: a historical notification may
describe an earlier decision. Render title/body as plain text, never HTML.

## Mark read

`POST /notifications/{uuid}/read` — no request body or idempotency key needed.

Returns the notification object with server-generated `read_at`. Repeats and
concurrent calls preserve the first timestamp. Unknown and other users' IDs both
return 404. The SQL RPC derives the actor from `auth.uid()` and accepts only the
notification ID. Clients cannot edit content, insert notifications, delete rows,
or choose a read timestamp through direct table access.

Errors follow `{code, message, field_errors, request_id}`: 401 unauthenticated,
403 unverified email, 404 invisible/missing, 405 wrong method, 422 invalid input,
and 5xx upstream failure. Responses use `Cache-Control: no-store`.

## Event production

Database triggers create notifications atomically with new business rows:

| Source | Recipient | Type |
| --- | --- | --- |
| First `submission_revisions` row | Task publisher | `submission_received` |
| Later revision | Task publisher | `submission_revised` |
| Decision `request_changes` | Tester | `changes_requested` |
| Decision `accept` | Tester | `submission_accepted` |
| Decision `decline` | Tester | `submission_declined` |

`(recipient_id, event_key)` is unique. Revision/decision UUIDs form event keys;
idempotent replay of existing business requests produces no duplicate notice.
Existing pre-migration submissions are not backfilled. AI outputs do not create
review decisions or notifications. The migration reserves `payment_succeeded`,
`payment_failed`, and `review_reminder` types, but payment/reminder producers are
not implemented here. Future producers must write an inbox row inside the same
trusted business transaction, with a stable event key.

## Verify and deploy

```sh
deno check supabase/functions/notifications/index.ts
deno lint supabase/functions/notifications
deno test supabase/functions/notifications/handler_test.ts
supabase db push --linked --dry-run
# Confirm only the notifications migration is pending before pushing.
supabase db push --linked
supabase functions deploy notifications --project-ref myjdykfmxspqtgbuoqdt --use-api --no-verify-jwt
node scripts/test-notifications-cloud.mjs --cloud
```

The cloud test reads `backend/.env.local` (`SUPABASE_URL` and
`SUPABASE_SERVICE_ROLE_KEY`), or the file selected by `NOTIFICATIONS_TEST_ENV`.
It refuses other projects, creates three isolated Auth test users without
sending email, seeds its own task/submission fixtures, exercises the deployed
decision and notification APIs and database permissions, then deletes only its
tracked fixtures/users in `finally`. Existing business records are not touched.
The revision fixture bypasses evidence validation to focus on inbox triggers;
it is not an upload/submission acceptance test. Any task AI summary row created
by the existing AI trigger is removed through the test task's cascade on cleanup.

## Verified deployment — 2026-10-03

- Applied only `20261004001000_notifications.sql` after a successful cloud dry run.
  Earlier task, submission, and AI migrations were fetched from cloud history to
  align this worktree; none were reapplied or changed by this feature.
- Deployed the standalone `notifications` function to `myjdykfmxspqtgbuoqdt`.
- Deno typecheck, lint, formatting, and all 5 handler tests passed.
- All 10 cloud test groups passed: empty inbox, auth/CORS, initial submission,
  real decision API/idempotent replay, API/RLS isolation, concurrent mark-read,
  direct-write denial, revision/accept/decline events, tied-time pagination/event
  deduplication, and input validation/private response headers.
- Cloud test fixture and Auth user cleanup completed successfully.
