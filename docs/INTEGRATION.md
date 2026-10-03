# Frontend / Supabase integration

## Integrated branches

- `codex/task-api` (`df68b98`)
- `codex/submissions-api` (`4e90356`)
- `codex/backend-uploads-verification` (`747d735`)
- `codex/backend-ai-worker` (`a70bf3e`)
- `codex/backend-payments` (`cf4eb45`)
- `codex/backend-agent-api-keys` (`3e912a2`)
- `codex/backend-notifications` (`b18769b`)

Publisher UI commit `d9a4e05` is preserved, including required budgets, zero defaults, three-day deadline, optional fields and empty initial questionnaire.

## Current application

- `/dashboard`: authenticated task list, create/edit/results/public links.
- `/tasks/new`, `/tasks/{uuid}/edit`: authenticated draft creation/update; free publication; paid drafts go to the funding/results page.
- `/tasks/{slug}`: anonymous reading, verified account required before uploading/submitting; private Storage uploads, versioned supplements and status refresh. UUID URLs also resolve for notification links.
- `/tasks/{uuid}/results`: authenticated owner-only results, SQL statistics, AI summary and source links, private evidence, revision history, all three human decisions, budget and funding controls. Stale AI output is labeled as an earlier snapshot.
- `/settings`: one-time Agent Key creation/list/revocation, notifications/read status, Stripe Connect setup/status.
- `/submissions/{uuid}`: resolves a notification to the appropriate tester or publisher view after an authorized detail read.
- Only explicit demo IDs (`demo`, `mobile`, `expired`, `missing`, legacy browser-local `rw-…`) use fixtures. API failures on real IDs never fall back to demo data.

Auth uses Supabase email links or email OTP when supplied by the configured email template. Sessions refresh through the SDK; signing out hides private pages. No server secret is exposed to the browser. Email delivery itself was not exercised by automated tests (temporary users were confirmed through the Admin API without sending emails).

## Contract integration

The module API documents record their original branch delivery. This document supersedes their earlier “frontend not connected”, “Agent unsupported” and “payment transaction not integrated” notes.

- Existing Edge Function bases remain separate: `api/v1`, `submissions/v1`, `payments/v1`, `notifications/v1`, and `api-keys`.
- Added owner-only task `GET /tasks/{id}/results`, `/statistics`, `/summary`. Results include AI output with its original source snapshot and independent current SQL statistics/budget.
- Public task reads accept the public slug and UUID; generated share links use the slug.
- Task management accepts scoped Agent keys; publisher submission reads accept `submissions:read`. Agent keys cannot upload, submit as a tester, make human decisions, manage keys or authorize/retry payment. Aggregate results require both `tasks:read` and `insights:read`.
- Task/submission validation now permits zero questions and blank optional instructions to match the latest publisher UI. Configured questions still require complete legal answers and reasons. Amounts align with payment storage (up to 99,999,999 cents); paid Checkout budget must be at least 50 cents.
- New migration `20261004004000_integrate_modules.sql` connects task create/edit/funding and acceptance/reward authorization inside the existing database transactions. Lock order is task → payment account → submission. Failed payment authorization rolls back the decision. Reward state is projected on API reads, avoiding reverse reward-to-submission locks.
- Verified payment success/failure produces an inbox notification in the same transaction.
- Mutating browser calls preserve their idempotency key across unknown failures; decisions and revisions send the actual server revision UUID and version. Upload bytes go only to the signed URL, without the user bearer token.

## Deployment record — 2026-10-03

Authorized target: `myjdykfmxspqtgbuoqdt`.

Applied only:

1. `20261003000100_payments.sql` (existing payment branch, not previously applied).
2. `20261004004000_integrate_modules.sql`.

Updated `api` and `submissions`; deployed `payments`, `stripe-webhook`, `payment-worker`. Existing `ai-worker`, `api-keys` and `notifications` remain deployed. Explicit pinned npm imports fix payment function cloud bundling.

Auth Site URL is `https://reviewwork.vercel.app`; redirect allowlist includes that domain and localhost/127.0.0.1 port 3000. Email verification remains enabled. `APP_URL` uses the production domain and `PAYMENT_MODE=stripe_test`.

**Stripe is not configured yet:** `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `PAYMENT_WORKER_SECRET`, Stripe webhook registration and payment-worker scheduling remain to be configured. The payments API returns an explicit 503 `payments_not_configured`; paid task publication remains blocked until verified funding. No real Sandbox Checkout/Transfer was claimed or executed. See PAYMENTS.md for the setup sequence. Free tasks and their acceptance work normally. No real-money payments or bank payouts are enabled.

## Verification

- Frontend unit tests, TypeScript check and production build.
- Deno validation, AI worker, notification, payment and new ownership/Agent-boundary tests.
- PGlite migration/transaction tests for paid publication gating, rollback, one reward per submission, exhausted budget, free acceptance and closed-task revisions. These are not a substitute for multi-connection PostgreSQL stress tests.
- Browser suites cover creation, upload/submission/revision, reviewer decisions, settings and legacy demo regression. API fixture suites explicitly intercept network traffic; they do not claim cloud coverage.
- `backend/tests/frontend-live.mjs` passed 19 checks against actual deployed Auth/REST/Storage/Functions, including a browser using the real APIs. All temporary users/tasks/evidence were cleaned up. No email or Stripe payment was sent. Existing AI triggers may process synthetic feedback during this explicit cloud test.

```sh
npm test --prefix frontend
npm run typecheck --prefix frontend
npm run build --prefix frontend
npm test --prefix backend
deno test --config supabase/functions/deno.json --allow-env supabase/functions/api/ supabase/functions/submissions/ supabase/functions/ai-worker/ supabase/functions/notifications/ supabase/functions/_shared/payments/
TASK_PREVIEW_PORT=3120 PLAYWRIGHT_CHANNEL=chrome npm exec --prefix frontend -- playwright test -c frontend/task/playwright.config.ts
RESULT_PREVIEW_PORT=3123 PLAYWRIGHT_CHANNEL=chrome npm exec --prefix frontend -- playwright test -c frontend/result/playwright.config.ts
# Explicit cloud test only; uses/cleans temporary project data:
node --env-file=backend/.env.local backend/tests/frontend-live.mjs
# Optional real-browser phase (start the local app first):
FRONTEND_TEST_URL=http://localhost:3000 node --env-file=backend/.env.local backend/tests/frontend-live.mjs
```

Unused upload cleanup and large-scale result-list pagination optimization remain follow-up work; the MVP fetches all publisher list pages for filtering/export, while authoritative totals come from SQL.


## Guest feedback and reward claims — 2026-10-03 update

This update supersedes the login requirement for public feedback and the earlier Stripe configuration status above. Public task pages now put the required payout email first and allow uploads/submission without a login screen. A private anonymous session owns guest evidence; the immutable contact email is verified only when claiming the reward. Publishers still require a verified account to review and authorize payment.

Migrations through `20261004007000_guest_feedback.sql` are applied. `submissions`, `payments`, and `payment-worker` are deployed; anonymous sign-ins and both secure-link email templates are configured. The Sandbox Stripe secrets, worker Vault configuration, and minute schedule are present. A real temporary guest successfully accessed its empty private submission list, was denied payment-account access before email verification, and read the supplied public task. That temporary user was deleted; no feedback, email, or transfer was sent in this smoke test. Desktop/mobile browser checks confirmed the public task has no login prompt and shows the email before the task title.

**SMTP remains unconfigured.** Guest feedback works, but reward email delivery to ordinary recipients is not ready until a custom email provider is connected. Default Supabase SMTP is restricted to project-team addresses. This deployment does not claim successful delivery or an actual Sandbox transfer.
