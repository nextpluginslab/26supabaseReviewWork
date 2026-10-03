# Agent API Keys

已部署到 Supabase 项目 `myjdykfmxspqtgbuoqdt`。本模块独立于正在开发的
`api` / `submissions` Functions；没有覆盖它们，也没有给它们自动启用 Agent 访问。

## 身份边界

- 创建、列出、撤销：`Authorization: Bearer <Supabase Auth access_token>`。
  必须是邮箱已验证、非匿名用户。发布者是已登录用户，不接受客户端 owner ID。
- Agent 校验：`Authorization: Bearer <rwk_...>`。这是本应用生成的 Key，
  **不是** Supabase anon/publishable/service-role Key，也不能直接访问数据库。
- Agent 不允许创建/列出/撤销 Key，不允许审核决定、付款或重试付款。
- Supabase Auth 会话可由前端既有登录流程获取；本模块不另建登录 API。
  当前前端 demo sessionStorage 登录仍需由页面开发接入真实 Auth。

## HTTP 契约

基地址：`https://myjdykfmxspqtgbuoqdt.supabase.co/functions/v1/api-keys`

| Method / 相对路径 | 身份 | 请求及返回 |
| --- | --- | --- |
| `POST /` | 用户会话 | `{name, scopes, expires_at?}` → `201 {api_key, key}`；只有这次返回完整 Key |
| `GET /?limit=20&cursor=…` | 用户会话 | `{api_keys, next_cursor}`；仅本人元数据，包含已撤销/过期记录 |
| `DELETE /{id}` | 用户会话 | `{api_key}`；软撤销，重复调用保留原 revoked_at；他人 ID 返回 404 |
| `POST /authorize` | Agent Key | `{required_scopes}` → `{principal:{type:"agent", key_id, publisher_id, scopes}}` |

`api_key` 元数据：`id, publisher_id, name, key_prefix, scopes, created_at,
expires_at, revoked_at, last_used_at`。任何 API 响应均不返回哈希。

`/authorize` 是自检/后端接入用的身份校验端点，不执行任何任务操作，不扩充权限。
业务 API 必须自己决定 required scopes，不能信任前端传来的校验结果。

支持的 scope（精确匹配，write 不隐含 read）：

| Scope | 用途 |
| --- | --- |
| `tasks:read` | 发布者自己的任务配置、列表、预算等 |
| `tasks:write` | 创建、编辑、发布、关闭自己的任务 |
| `submissions:read` | 读取自己任务收到的反馈 |
| `insights:read` | 查看自己任务的统计、AI 摘要 |
| `insights:write` | 生成自己任务的 AI 摘要 |

必须显式选择至少一个 scope；不支持 `*`、重复项或付款 scope。
名称 trim 后 1–80 字符。到期默认 90 天，可指定未来 365 天内带时区的 ISO 时间。
每用户最多 50 个有效 Key、24 小时最多创建 100 个；撤销不会重置日创建额度。
列表 limit 1–100，使用响应中的 opaque UUID cursor。

错误格式：`{code,message,field_errors,request_id}`。缺少/无效凭据 401、权限不足
403、不可见资源 404、非法字段 422、创建限额 429。响应设置 `Cache-Control: no-store`。

创建不是可重放的密钥检索接口：网络超时后先列出并撤销不确定的创建记录，再重新创建。
完整 Key 不落库，无法找回；本接口没有承诺 Idempotency-Key 重放完整 secret。

## task / submission 开发者接入

共享模块：`supabase/functions/_shared/agent-auth.ts`，无外部依赖。

```ts
import { requireAgent, requireAgentOwner } from "../_shared/agent-auth.ts";

// 业务路由在代码里选择 scope，不能从客户端请求体中读取。
const agent = await requireAgent(req, ["tasks:read"]);

// 数据库查询必须绑定 agent.publisher_id；不要接受请求中的 publisher_id。
// 若先加载资源，则用数据库记录的归属检查权限：
requireAgentOwner(agent, task.publisher_id);
```

同时接受用户和 Agent 的路由，可以根据 Bearer token 是否以 `rwk_` 开头，
分别调用 `requireAgent` 和 `requireUserSession`。不要在一种凭据验证失败后降级放行。
管理 Key、人工决定和付款路由只能调用 `requireUserSession`，不能允许 Agent 分支。

若其他 Function 不方便共享源码，可由**服务端**调用 `/authorize`，提供该路由
写死的 required_scopes，验证 200 响应并使用返回的 publisher_id 约束数据库查询。
不能让客户端先校验后自行携带 publisher_id 作为可信身份。

`api-keys` 的 `verify_jwt=false` 是为了让 opaque Agent Key 到达自定义鉴权。
这不代表匿名放行：管理路由使用 Auth `/user` 验证真实会话，Agent 路由验证数据库
哈希、scope、有效期、撤销状态及用户有效性。其他 Function 若接 Agent Key，需自行
配置 gateway 并保证每条非公开路由都有对应鉴权。

## 数据与安全

- Key 使用 Web Crypto 生成 32 字节随机数，格式 `rwk_` + 64 位十六进制。
- 数据库仅存 SHA-256 哈希及 8 位随机前缀，完整 Key 只在创建响应出现。
- `public.api_keys` 启用 RLS，同时撤销 anon/authenticated 的所有表权限。
- 两个 RPC 仅允许 service_role 执行；固定空 search_path，限定表名。
  SECURITY DEFINER 仅用于查询 Auth 用户的邮箱验证、禁用和删除状态，未开放 Auth 表。
- 创建限额使用每用户事务锁；成功鉴权按 5 分钟粒度更新 last_used_at。
- 撤销在后续授权请求生效，不会中断已经获得授权的执行中请求。
- 用户删除通过外键级联删除其 Key。

## 部署和验证

已在远程应用并登记两条 additive migrations：

- `20261003223000_agent_api_keys.sql`
- `20261003223100_agent_api_key_auth_lookup.sql`

不运行本地 Supabase、Docker 或 db reset。不要在缺少其他开发者 migration 文件的
worktree 中直接对整个远程项目执行 db push。

部署本模块：

```sh
supabase functions deploy api-keys --project-ref myjdykfmxspqtgbuoqdt --use-api
```

类型和 lint 检查（不启动服务）：

```sh
deno check supabase/functions/api-keys/index.ts
deno lint supabase/functions/api-keys/index.ts supabase/functions/_shared/agent-auth.ts
```

直接针对线上 Supabase 集成测试：

```sh
node scripts/test-agent-api-keys.mjs /absolute/path/backend/.env.local
```

需要该项目的 `SUPABASE_URL`、`SUPABASE_ANON_KEY`、`SUPABASE_SERVICE_ROLE_KEY`。
脚本只为本次测试创建临时 Auth 用户和 Key，finally 删除临时用户并级联清理 Key。
不发送邮件，不打印 session、Key 或 service-role secret。若进程被强制终止，需清理
`app_metadata.purpose=agent-api-key-integration-test` 的本次临时账号。

2026-10-03 已通过 50 项远程集成断言：真实 Auth 登录、一次性 Key、哈希存储、
跨用户隔离、scope、数据库直连保护、分页、过期、撤销、幂等撤销、并发创建限额。
测试账号和关联 Key 已清理。task/submission 接入后的业务资源隔离应由对应接口的
集成测试继续验证；本次没有声称已验证它们接受 Agent Key。
