# Tester task page

Real tasks now use Supabase Auth, private Storage and the submissions API, including versioned supplements. See [INTEGRATION.md](../../docs/INTEGRATION.md) for the current contract and tests. Explicit `/tasks/demo` routes preserve the original fixture preview.

The following is the historical UI delivery record; its mock-only statements apply to `mock-api.ts` and explicit demo routes.

# Tester task page

Next.js App Router route: `/tasks/[id]`. Open `/tasks/demo` for the sample task.
The feature lives in `task/`; styles and shadcn-pattern Radix components are scoped
with `fw-` classes so publisher/result pages can evolve independently.

## Run

From `frontend/`:

```sh
npm install
npm run dev
```

## What is implemented

- Publisher-configured product details, instructions, USD reward, and deadline with timezone.
- External app link; mobile instructions for mobile tasks.
- Multiple screenshot/recording uploads, type/50 MB validation, progress, retry,
  removal, and original-file previews. Blocker evidence is allowed.
- Dynamic single-choice questions with a required reason for every answer.
- Email entry and explicitly simulated verification (`123456`; no email sent).
- Browser-local draft restoration, evidence persistence in IndexedDB, and feedback submission.
- Awaiting publisher / more information requested / accepted / declined states,
  separate payment states, review requests, and complete revision history.
- Revisions preserve the submission number and are allowed after the initial deadline.
- Loading, missing-task, offline, error, closed-task, and responsive mobile states.

## Mock boundary

`api.ts` provides async `getTask`, `createUploadUrl`, `uploadEvidence`, and
`submitFeedback` adapters. Their future HTTP equivalents are `GET /api/tasks/:id`,
`POST /api/uploads`, direct upload to the returned signed URL, and
`POST /api/tasks/:id/submissions`. No real backend calls are made.

`getSubmission`, `verifyEmail`, and `simulateReview` are additional **local-only**
helpers. The supplied endpoint list does not include a tester-owned submission
status endpoint or auth API. Connect those to authenticated backend/Supabase
services before production; do not expose publisher `getResults` to testers.
The demo stores one submission per task in this browser, not per authenticated user.

Add `?preview=1` to the task URL to access **Mock preview controls** for explicit review/payment
simulation after submission. AI never decides acceptance. No payment occurs.
Use `/tasks/expired`, `/tasks/mobile`, and `/tasks/missing` for other fixtures.
All sample product/step/question content is isolated in `fixtures.ts`.
Files remain in IndexedDB; draft and submission metadata remain in localStorage.
Production must use private storage, verified identities, API authorization,
server validation, concurrency protection, and upload integrity checks.

## Verify

```sh
npm run typecheck
npm test
npx playwright install chromium
npx playwright test -c task/playwright.config.ts
# Or use an installed Chrome:
PLAYWRIGHT_CHANNEL=chrome npx playwright test -c task/playwright.config.ts
# Separate output when another preview is running:
NEXT_BUILD_DIR=.next-task-build npm run build
```

The browser tests cover the full submission/revision flow, refresh recovery,
negative feedback, status persistence, mobile overflow, deadline blocking,
unsupported evidence, and offline upload retry. Unit tests cover variable
question configurations, required reasons, invalid options, and deadline rules.

Design follows the Spec's Next.js/shadcn stack and English-language requirement.
Mobbin MCP was unavailable in this session; no Mobbin reference is claimed.

The tester interface uses reviewWork branding and a minimal monochrome layout.
Review information appears after submission; developer preview controls are hidden by default.
