# reviewWork frontend

Next.js App Router, React, TypeScript and shadcn/ui. Real routes use Supabase Auth and the deployed module APIs. See [integration status](../docs/INTEGRATION.md) for routes, deployment and verification.

```sh
npm install
npm run dev
npm test
npm run typecheck
npm run build
```

Copy `.env.example` to `.env.local` and set the public Supabase URL/key. Never put service-role, OpenAI or Stripe secrets in frontend environment variables.

Start at `/dashboard` or `/tasks/new`. Public task links use `/tasks/{slug}`; owner results use `/tasks/{uuid}/results`. Email login is real. `/settings` manages Agent keys, notifications and Stripe Sandbox receiving accounts.

`/tasks/demo` and `/tasks/demo/results` remain explicit local demonstrations. Their simulated identity, evidence and payment behavior does not apply to real task IDs. API errors never switch a real task to fixtures.

Stripe functions are deployed, but Sandbox credentials/webhook/scheduling still require setup. Payment UI reports unavailable configuration; free-task publication and review work without Stripe.

Browser verification uses isolated ports:

```sh
TASK_PREVIEW_PORT=3120 PLAYWRIGHT_CHANNEL=chrome npx playwright test -c task/playwright.config.ts
RESULT_PREVIEW_PORT=3123 PLAYWRIGHT_CHANNEL=chrome npx playwright test -c result/playwright.config.ts
```
