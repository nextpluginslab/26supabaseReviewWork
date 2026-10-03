# Task API

部署项目：`myjdykfmxspqtgbuoqdt`（reviewWork）。

Base URL: `https://myjdykfmxspqtgbuoqdt.supabase.co/functions/v1/api/v1`

所有路由在一个 `api` Edge Function 内。除公开详情和 CORS OPTIONS 外，均要求 `Authorization: Bearer <Supabase user access token>`，用户必须已验证邮箱。API key / MCP scope 暂未实现，不能用 anon key 或 service-role key 代替用户会话。网关 `verify_jwt=false` 是为了公开路由，私有路由在函数内调用 Auth 验证用户。

## 路由

| Method | Path | 请求 / 响应 |
| --- | --- | --- |
| POST | `/tasks` | `{config}` → `201 {task}` |
| GET | `/tasks?limit=20&cursor=...` | `{tasks, next_cursor}`，仅本人任务，limit 1–100，UUID 升序游标 |
| GET | `/tasks/{id}` | `{task}`，仅所有者 |
| PATCH | `/tasks/{id}` | `{version, config}` → `{task}`，仅草稿；config 为完整替换，不是字段合并 |
| POST | `/tasks/{id}/publish` | `{version}` → `{task}`，冻结配置、解析截止时间 |
| POST | `/tasks/{id}/close` | `{version}` → `{task}`，仅 published → closed；保留公开详情 |
| GET | `/public/tasks/{slug}` | `{task}`，匿名访问已发布/关闭任务，不包含预算和所有者信息 |

写请求必须传 `Content-Type: application/json` 和 `Idempotency-Key`（1–128 个无空格 ASCII 字符）。相同用户、动作、任务及 key 的相同 JSON 请求重试返回原结果；不同请求返回 409。JSON 属性顺序应保持一致。编辑、发布、关闭必须传最新 version；成功修改后 version 加一，旧版本返回 409。

## 创建示例

```sh
curl 'https://myjdykfmxspqtgbuoqdt.supabase.co/functions/v1/api/v1/tasks' \
  -H "Authorization: Bearer $USER_ACCESS_TOKEN" \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: create-example-001' \
  --data '{
    "config": {
      "title": "Review onboarding",
      "app_name": "Example product",
      "app_type": "web",
      "app_url": "https://example.com",
      "experience_instructions": "Open the product in your browser.",
      "task_description": "Try onboarding and describe where you got stuck.",
      "evidence_types": ["image", "video"],
      "evidence_instructions": "Show the completion screen or blocker.",
      "questions": [{
        "question_key": "ease",
        "prompt": "Was onboarding easy?",
        "type": "single_choice",
        "reason_required": true,
        "options": [
          {"option_key": "yes", "label": "Yes"},
          {"option_key": "no", "label": "No"}
        ]
      }],
      "reward_amount_minor": 0,
      "budget_amount_minor": 0,
      "currency": "USD",
      "duration_seconds": 86400,
      "display_timezone": "America/Phoenix"
    }
  }'
```

`duration_seconds` 和 `deadline_at` 二选一。前者 60–31536000 秒，从发布时起算；后者使用带时区 ISO 8601 时间，发布时必须仍在未来。金额为 0–100000000 的整数美分；币种 USD；预算不得小于单条报酬。

问卷支持 1–30 道单选题，每题 2–20 个选项、原因必填。key 使用 1–64 位字母/数字/下划线/连字符；每题 key 唯一，题内 option key 和去掉首尾空格后的标签唯一。服务器分配 UUID，编辑时保留已有 key 对应的 UUID。删除后的 key 不可复用。更新 config 时只发送上述输入字段，不发送服务器返回的 question/option `id`。

任务返回 `id`、`public_slug`、`status`、`config`、`published_config`、`version` 和时间字段。`public_url` 是可直接访问的公开 **API URL**。`task_url` 仅在部署环境设置 `APP_URL` 后生成；本次没有设置该值，返回 null。当前前端仍为 Mock，尚未接入真实任务，不能将前端页面链接视为已完成联调。

公开结果还包含 `accepting_submissions` 和付款规则，不暴露总预算、所有者、内部注册表。首次提交是否可接受仍需要未来 submission API 在服务端再次校验。

## 边界与保障

- 付费草稿可以创建和编辑；发布返回 `409 funding_required`，直到 Stripe 真实测试出资接入。客户端不能传 funded/paid 绕过检查。零报酬任务可发布。
- 发布后配置不可编辑；close 只关闭首次提交，不删除任务或历史。
- 新增 `tasks`、`task_api_requests` 表，开启 RLS 并撤销 anon/authenticated 直接访问。事务 RPC 仅 service_role 可调用，由 Edge Function 传入 Auth 验证过的用户 ID。
- 数据库行锁保护版本；事务内保存幂等结果。每个用户每分钟最多 60 次成功的新写操作，幂等重放不计入。请求体上限 128 KiB；更全面的网关/IP 限流后续补充。
- 本次问卷保存在任务 JSONB 快照中，并维护稳定 UUID 注册表，暂未创建 Spec 规划的独立 question/option 表；提交和统计模块可基于发布快照扩展。
- 尚未实现提交、上传、结果统计、AI、支付、Agent Key，也未修改前端 Mock。

错误格式：`{error: {code, message, field_errors, request_id}}`。401 未登录，403 邮箱未验证，404 不存在或不可见，409 状态/版本/幂等/出资冲突，422 配置不合法，429 限流。所有响应禁止缓存并返回 `X-Request-Id`。

## 验证与部署

```sh
deno check supabase/functions/api/index.ts
deno test supabase/functions/api/validation_test.ts
supabase db push --linked --dry-run
supabase db push --linked
supabase functions deploy api --project-ref myjdykfmxspqtgbuoqdt --use-api
node scripts/test-task-api.mjs
```

线上测试脚本明确固定上述项目，需已登录 CLI；在内存读取项目 keys，创建两个临时已验证用户，不发送邮件，并在 finally 删除这些用户及其关联任务/幂等数据。不要将此脚本加入日常前端启动命令。

2026-10-03 验证：11 个本地校验测试、Deno 类型检查通过；29 个真实线上检查通过，包括身份、越权、直接表/RPC 访问拦截、幂等、并发编辑、稳定问卷 ID、公开投影、发布冻结、关闭、付款门槛、过期截止时间、分页。临时测试账号与关联数据已清理。
