# reviewWork — developer results

Next.js App Router + React + TypeScript + Tailwind CSS v4. The local shadcn/ui Button and Dialog components use CVA and Radix UI; `components.json` supports extending the component set.

```sh
cd frontend
npm install
npm run dev
```

Open http://localhost:3000/tasks/demo/results. Dynamic task IDs get independent mock datasets. UI copy follows SPEC's English-language requirement.

```sh
npm run test
npm run build
npm run typecheck
```

## Mock boundary

`result/api.ts` exposes `getTask`, `getResults`, and `approveSubmission`, corresponding to `GET /api/tasks/:id`, `GET /api/tasks/:id/results`, and `POST /api/submissions/:id/approve`. These async adapters use local fixture data rather than HTTP. Replace the adapter bodies when the backend is ready. No environment variables or external services are needed.

Developer login is on this page: any valid email opens a **demo** session in sessionStorage. No email is sent, ownership is not verified, and this is not real authentication. Results are sample data visible before login; confirmation requires the demo session. Do not use this adapter with private production data.

Confirmations persist in localStorage per task; clear `fieldwork:mock-results:v1:<taskId>` to reset. Confirmation validates remaining budget, preserves existing pending rewards, and returns an already-confirmed submission without paying again. These protections model one browser tab only; the real API must implement transactional budget locking, idempotency, ownership and authentication. Mock payment success does not represent a Stripe Sandbox transfer.

The page includes all-submission statistics, configurable question distributions, AI source links, status/search filters, pagination, full answers and reasons, evidence preview, `?submission=FB-001` deep links, loading/error/retry/empty states, and responsive layouts. List filters do not change the overview's explicitly labeled all-submission statistics. AI notes are advisory and do not block review. Sample evidence is an original illustrative SVG, explicitly labeled as demo.

Request-more-information, decline, and retry-payment mutations are not implemented because they are absent from the supplied API list; existing review reasons and states are displayed. No Mobbin MCP was available during implementation; no external design reference is claimed.

## Browser verification

```sh
npx playwright install chromium
npx playwright test --config result/playwright.config.ts
# Or use installed Chrome:
PLAYWRIGHT_CHANNEL=chrome npx playwright test --config result/playwright.config.ts
```

The results E2E suite starts an isolated preview on port 3102 and covers login, evidence, confirmation, persistence, filtering, pagination, mobile layout and deep links.

The results page uses a minimal monochrome layout: one header, inline counts, answer distribution, a concise AI summary and the submission table. Details and confirmation stay in dialogs; redundant navigation, decorative cards, copy-link and export controls were removed.

`next-env.d.ts` and build outputs are generated and ignored. On a fresh checkout, run `npm run dev` or `npm run build` before standalone type checking. `.env.example` contains only optional placeholders; keep real environment values in ignored `.env.local`.
