# Stripe Sandbox 支付模块

## 实现范围

本模块实现 Checkout 测试出资、Express Connect 托管开户/状态、付款重试、Stripe webhook 和转账 worker。只接受 `sk_test_` 密钥和 `livemode=false` 的资金对象，不调用 Payout API。

参考 [Ship by Sundown](https://shipbysundown.dev/) 的 Hosted Checkout 方案；本项目不是订阅业务，使用单次 Checkout 收取任务预算，再通过 Connect separate charges and transfers 支付接受的反馈。

当前 worktree 没有 task/submission 后端表和决定事务。本模块使用独立的 `payment_*` 表，**不创建另一份 tasks/submissions 表**。下述两个数据库事务接入点必须由对应 API 接入后，才能跑通从发布到接受付款的业务流程。

## 文件与运行

- `supabase/migrations/20261003000100_payments.sql`：表、约束、权限与事务 RPC。
- `supabase/functions/payments/`：用户支付 API。
- `supabase/functions/stripe-webhook/`：Stripe 签名回调。
- `supabase/functions/payment-worker/`：一次处理一条已人工授权的报酬。
- `supabase/functions/_shared/payments/`：Stripe 服务与可测试的 handler。
- `backend/tests/payments.test.mjs`：PGlite 隔离 PostgreSQL 迁移/事务测试。

安装测试依赖并验证：

```sh
npm ci --prefix backend
deno task --config supabase/functions/deno.json check
deno task --config supabase/functions/deno.json test
npm --prefix backend test
```

Deno 使用已提交的 `deno.lock`；Stripe SDK 固定 18.5.0，API 版本固定 `2025-08-27.basil`。测试不调用 Stripe、不连接生产数据库；PGlite 不等于多连接 PostgreSQL 并发验收。

## API

独立部署，避免与正在开发的 task/submission `api` Function 冲突：

```text
BASE=https://<project>.supabase.co/functions/v1/payments/v1
WEBHOOK=https://<project>.supabase.co/functions/v1/stripe-webhook
WORKER=https://<project>.supabase.co/functions/v1/payment-worker
```

前端配置 `NEXT_PUBLIC_PAYMENTS_API_URL=BASE`，后续也可在统一 API 网关代理这些路由。Supabase Storage / Auth 路由不受影响。

全部用户接口要求 `Authorization: Bearer <Supabase access token>`。服务端通过 Auth `getUser` 验证令牌，并要求已验证邮箱、authenticated role、非匿名用户及 `session_id`；不接受 agent key 或 service-role token 作为用户登录。

| Method / Path（相对 BASE） | 行为 |
| --- | --- |
| `POST /tasks/{id}/funding-sessions` | 创建/复用冻结预算的 Checkout Session，返回 `session_id,url,state` |
| `GET /tasks/{id}/funding` | 当前任务出资及预算；若 Session 尚未确认，主动向 Stripe 核实 |
| `GET /tasks/{id}/budget` | 同一支付视图，含预算、已付、待付、剩余 |
| `POST /me/connect-onboarding` | 创建/复用本人 Express 测试账户，返回托管开户 `url,expires_at,mode` |
| `GET /me/connect-account` | 实时查询 `account_id,ready,details_submitted,currently_due,mode` |
| `POST /rewards/{id}/retry` | 仅任务所有者可重试，返回 202 和 `reward_id,state,mode`；不立即声称已支付 |

POST 接受空对象 `{}`（或空 body），要求 `Idempotency-Key`，1–128 个字母、数字或 `_.:-`。金额、收款人、owner 和回跳 URL 均不能从客户端提交。相同主体/路由/key 返回持久化结果；进行中的请求返回 409，等待 60 秒后可用原 key 重试。过期或已使用的 Connect 链接需用新 key 获取新链接。

CORS 仅允许 `APP_URL` 的精确 origin；服务端到服务端无 Origin 请求仍需验证身份。响应不缓存。密钥及 Stripe 原始错误不返回浏览器或写入日志。

### 前端返回页约定

Checkout 返回现有 `/tasks/{id}/results?funding=return` 或 `funding=cancelled`。返回页必须读取 funding API；URL 参数不是付款凭证。

Connect 返回 `/settings?connect=return`；失效链接返回 `/settings?connect=refresh`。设置页在 return 时调用账户状态，在 refresh 时以新 Idempotency-Key 请求开户链接并跳转。**当前前端尚无真实 Auth 和 settings 页面，这部分 UI 接入不在本后端模块内，联调前必须补齐。**

## Task API 事务接入

以下 RPC 仅授权 `service_role` 执行，不能交给浏览器调用。`p_actor` 必须来自验证后的身份，不能接受客户端 owner ID。

在 task 创建/草稿改价的同一个 Postgres 事务中调用：

```sql
select public.payments_command(
  'register_task',
  :verified_publisher_id,
  jsonb_build_object(
    'task_id', :task_id,
    'budget_amount_minor', :server_validated_budget,
    'reward_amount_minor', :server_validated_reward
  )
);
```

这是调用契约示例，`:name` 为集成代码绑定值。`register_task` 只能在任务仍可编辑时调用；草稿/发布状态仍由 task API 验证。存在进行中/已支付 Checkout 或报酬记录时，金额在数据库层冻结。过期 Session 必须先经 Stripe 验证为 expired，才能改价。

金额为 USD 美分整数。付费任务预算至少覆盖一份报酬，且 Checkout 至少 50 美分；0 元报酬不需要出资，不消耗预算。上限 99,999,999 美分。

发布事务调用 `payments_command('task', publisher_id, {task_id})`，要求 `funding_state` 为 `funded` 或 `not_required`，然后冻结任务配置。该调用锁定预算行至事务结束，不能依据前端回跳或客户端传入的状态发布。

## Submission API 事务接入

在人工接受的 **同一个数据库事务** 内：

1. 验证发布者交互会话和任务所有权。
2. 按统一顺序锁定 task、payment budget（调用 `task` RPC）、submission，再验证 `expected_revision_id` 和允许的处理状态。
3. 插入唯一的人工 accept 决定，读取可信的 `tester_id` 和提交归属。
4. 调用以下 RPC，再设置 accepted 状态；任一步失败全部回滚。

```sql
select public.payments_command(
  'authorize_reward',
  :verified_publisher_id,
  jsonb_build_object(
    'task_id', :task_id,
    'submission_id', :submission_id,
    'tester_id', :verified_submission_tester_id,
    'decision_id', :persisted_human_decision_id,
    'confirm_payment', true
  )
);
```

**不要先通过一次 HTTP 写 accepted，再通过第二次 HTTP 创建 reward**；需在 submission 的 Postgres RPC 内调用 `payments_command`。本模块无法验证另一个尚不存在的 submission 表，因此该接入点只信任已经做过上述校验的服务端事务，没有对应的公开 HTTP 授权付款接口。

该操作锁预算行，检查 `paid + pending + 本份报酬 <= budget`，创建唯一 reward。报酬金额来自任务，不来自请求。reward 的 pending 行就是持久化待执行任务；事务提交后 worker 才能读取。0 元报酬记 `not_required`，不会进入 worker。

建议所有决定事务按 task → payment budget → submission 的统一顺序取锁，避免与任务编辑的锁顺序相反。API key 无权人工接受/确认付款；重复接受必须复用原决定 ID。

## Worker 与重试

定时调度器以 `Authorization: Bearer <PAYMENT_WORKER_SECRET>` POST WORKER，空 body 即可。每次领取一条任务，使用 `FOR UPDATE SKIP LOCKED` + 两分钟租约；建议每分钟调用，也可在接受事务提交后额外触发。触发失败不会丢失数据库中的任务。

- 收款账户未就绪：保留 pending，每分钟可再次检查，不提前创建 Stripe 转账尝试。
- 每个 attempt 固定金额、目标账户、出资 charge 和 Stripe 幂等键。
- 转账使用 `source_transaction` 指向该任务的真实测试 Charge；平台需准备测试余额覆盖 Stripe 手续费差额，不从承诺报酬中扣费。
- 每次执行先查询 transfer group，恢复可能已成功但响应丢失的转账。
- 超时、网络断开和 5xx：保留 unknown 和预算占用，复用同一 attempt/key。
- 明确的无效请求失败：记 failed，发布者显式 retry 才创建下一 attempt。
- attempt 超过 23 小时且未找到转账：记 `reconciliation_required`，拒绝盲目重发，防止 Stripe 在 24 小时后清理 key 导致重复付款。
- 大于 1,000 条的任务转账历史扫描会停止并要求人工对账，不以不完整扫描作为“未付款”证据。
- 已成功转账保持 paid；发生部分/全部 reversal 标记 `reversed=true` 供人工处理，不释放预算、不自动再次付款。
- 预算采用 reward 的 SQL 聚合投影；paid 和所有未付状态互斥计数，同一报酬永远只占一份。

`reconciliation_required` 的恢复需要运维核对 Stripe 的实际 Session/Account/Transfer，并通过服务端受限的 RPC 写回已核实对象；没有给浏览器提供“跳过检查”接口。无法确认未付款时不能创建新 attempt。

## Webhook

使用 Stripe 平台 Sandbox endpoint，并固定事件 API 版本 `2025-08-27.basil`。订阅：

- `checkout.session.completed`
- `checkout.session.async_payment_succeeded`
- `checkout.session.async_payment_failed`
- `checkout.session.expired`
- `transfer.created`
- `transfer.updated`
- `transfer.reversed`

仅处理 `metadata.application=reviewwork` 的对象。原始请求体交给 Stripe SDK 验签，时间容差 300 秒；拒绝 live 事件。之后再次读取 Stripe 当前对象，核对金额、币种、task/reward/attempt、目标和源 Charge。事件去重与状态更新在同一事务，写入失败会回滚事件记录，Stripe 可重试。旧事件不能覆盖成功。

Connect 状态采用实时读取，不依赖 `account.updated` 的缓存。退款、争议和真钱运营不在本版自动化范围内。

## 部署配置与联调

尚未应用迁移、部署 Functions 或创建真实 Stripe 测试对象。当前配置的 Supabase 项目是生产项目；不要把迁移/部署放进启动命令或测试脚本。

服务端配置（参见 `backend/.env.example`）：

```text
APP_URL=https://your-app.example
PAYMENT_MODE=stripe_test
STRIPE_SECRET_KEY=<Sandbox sk_test_ key>
STRIPE_WEBHOOK_SECRET=<该 endpoint 的 whsec_ secret>
PAYMENT_WORKER_SECRET=<独立的高熵随机 secret>
```

Supabase 在线运行时注入 `SUPABASE_URL` 和 `SUPABASE_SERVICE_ROLE_KEY`。不要把整个 backend env 上传，也不要把这些密钥放入 NEXT_PUBLIC_*。

部署时依次：

1. 将 task/submission 的两个事务接入点实现并验证。
2. 在目标数据库应用迁移；配置上述 Secrets。
3. 部署 payments、stripe-webhook、payment-worker 三个 Functions。
4. 注册 Stripe Sandbox webhook 并设置对应签名密钥。
5. 配置 Cron/Vault 或已有调度器，每分钟携带 worker secret 调用 WORKER。
6. 接好前端登录、结果页刷新与 Connect settings 返回页。
7. 用真实 Sandbox Checkout 出资、Connect 测试账户、人工接受和 worker 完成一次转账，并在 Stripe 查询 Session/PaymentIntent/Transfer。
8. 在真正多连接的 Postgres 上并发接受最后两份预算、重复 webhook 和重复 retry，验证不超预算、不重付。

本地单元测试/隔离 SQL 测试的通过不等于第 7–8 步已完成。

官方实现依据：[Checkout](https://docs.stripe.com/api/checkout/sessions/create)、[Connect transfers](https://docs.stripe.com/connect/separate-charges-and-transfers)、[幂等请求](https://docs.stripe.com/api/idempotent_requests)、[开户链接](https://docs.stripe.com/api/account_links/create)、[Supabase Stripe webhook](https://supabase.com/docs/guides/functions/examples/stripe-webhooks)。

## Passwordless reward claims

Publishers still authorize payment from their authenticated results page. Accepting a nonzero reward atomically queues one recipient email in `reward_claim_emails`. Each authenticated `payment-worker` invocation delivers at most one queued email and processes one transfer. Email failure does not undo acceptance or block a transfer; delivery is retried after five minutes, up to eight attempts. The recipient is resolved from the reward's `tester_id` through Auth, never from publisher input. Delivery is at-least-once: a worker interruption after SMTP acceptance may result in another link; the newest link should be used.

The email uses Supabase Auth's single-use magic link. It opens `/rewards/claim?reward=<uuid>` and establishes the verified session automatically, without a login page or password. This is passwordless authentication, not anonymous access to payment accounts. The claim API checks reward ownership on every read and onboarding request. Expired/used links can be renewed on the same page using the feedback email; users can also enter the email code. Public task pages allow guest uploads and feedback without a login or email verification step. An anonymous Supabase session keeps evidence private. Guest contact emails are immutable per browser identity and unverified until a secure email link is redeemed; Auth may create a passwordless recipient account at that point. The claim API verifies the recipient email against the stored guest contact before allowing setup of the guest reward’s receiving account.

`GET /v1/rewards/{id}/claim` returns only the recipient's amount, currency, state and receiving readiness. `POST /v1/rewards/{id}/claim/onboarding` accepts only an empty body, uses the existing server-bound account, and returns fresh Stripe Account Links with trusted return/refresh URLs on the reward page. Returning from Stripe does not mark a reward paid. Existing worker verification remains the only path to transfer success. No money moves through the claim endpoint.

Deployment requirements:

1. Apply migrations `20261004005000_reward_claims.sql`, `20261004006000_payment_worker_schedule.sql`, and `20261004007000_guest_feedback.sql`; existing unpaid rewards are queued too.
2. Deploy `submissions`, `payments`, `payment-worker`, and the frontend. Enable Supabase anonymous sign-ins for private guest feedback sessions. Schedule the authenticated payment worker regularly as already required for transfers.
3. Configure Supabase Auth SMTP for delivery to real recipients and retain the server-side `SUPABASE_ANON_KEY`. Ensure the Auth redirect allowlist includes `APP_URL/rewards/claim` with its reward query (the existing domain `/**` pattern covers it).
4. Apply the magic-link and confirmation email subjects/templates from `supabase/templates/magic_link.html` in hosted Auth. Function deployment alone does not apply Auth configuration. Both `ConfirmationURL` and `Token` are included for link and code verification.
5. Monitor `reward_claim_emails.last_error` and exhausted `attempts >= 8`; after fixing delivery, an operator can reset attempts and next_run_at for unsent rows. Recipients can always request a new verification link from the original claim page.

This remains Stripe Sandbox: there is no real bank payout. Local mocked email/Stripe tests do not establish hosted SMTP delivery or an actual Stripe test transfer.
