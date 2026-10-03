# 本地开发环境

Node.js 22，npm。前端是 Next.js；后端目标为 Supabase Edge Functions。
开发和测试直接连接生产项目 `myjdykfmxspqtgbuoqdt`，不使用 Docker 或本地 Supabase。
真实任务已接入 Supabase Auth、任务、提交、Storage、AI、通知及 Agent Key。只有明确的 demo 路由保留 fixture；最新集成状态见 [INTEGRATION.md](INTEGRATION.md)。

```sh
npm ci
npm ci --prefix frontend
npm run dev
```

访问 http://localhost:3000。检查与构建：

```sh
npm run typecheck
npm run build
npm run test
npm run env:check
npm run env:check -- --online
```

`env:check` 只打印配置是否存在，不打印密钥。`--online` 只请求 Supabase Auth
配置、REST schema 和 OpenAI 模型列表，不写数据库或调用付费生成。

## 服务与凭据

- Vercel：团队 `daren7`，项目 `reviewwork`，Git 根目录 `frontend`，Node 22。
  在仓库根目录执行 `npm run vercel -- whoami` 或 `npm run vercel -- env ls --scope daren7`。
- Supabase CLI：`supabase login` 后执行
  `supabase link --project-ref myjdykfmxspqtgbuoqdt`。
  这是生产项目；不要运行 `db reset --linked`，不要把 `db push` 或部署放进启动脚本。
- OpenAI CLI：通过 `brew install openai/tools/openai` 安装。
  `npm run openai -- --help` 自动加载 `backend/.env.local`，API 使用 `OPENAI_API_KEY`。

`frontend/.env.local` 存前端公开配置；`backend/.env.local` 存服务端密钥。
两者已被 Git 忽略，模板是各目录下的 `.env.example`。
OpenAI 和 Supabase service-role 密钥绝不能放进 `NEXT_PUBLIC_*` 变量。
OpenAI 模型在实现 AI 后端时通过 `OPENAI_MODEL` 明确选择。

Supabase REST 根路径 `/rest/v1/` 是 OpenAPI schema，只允许服务端密钥访问。
`env:check -- --online` 使用服务端密钥检查此路径；前端 anon key 通过 Auth 接口验证。
不能把 schema 路径对 anon key 返回 401 误判为前端密钥无效。

Supabase Edge Functions 在线运行时自动注入 Supabase 内置环境变量。
已按用户授权将 OpenAI 密钥配置到该项目的 Edge Function Secrets。
后续修改本地 env 不会自动同步到 Supabase。不要把整个 backend env 文件直接上传为 Secrets。

参考：[Vercel CLI](https://vercel.com/docs/projects/deploy-from-cli)、
[Supabase CLI](https://supabase.com/docs/reference/cli/introduction)、
[OpenAI CLI](https://developers.openai.com/api/docs/libraries/openai-cli)。

## 已验证与已知限制

2026-10-03：Node 22.22.0、Supabase CLI 2.65.5、Vercel CLI 62.2.0、OpenAI CLI 1.30.7。
前端 build、typecheck 和 15 个单元测试通过；Auth、REST schema、OpenAI 模型列表均返回 HTTP 200。
业务表和 Edge Functions 已部署；`NEXT_PUBLIC_API_URL` 指向任务 api Function，其他模块地址由 Supabase URL 派生。
Vercel 项目已连接 GitHub 仓库，后续推送可能触发自动部署；集成分支合入 main 后触发前端自动部署。

依赖审计仍有待处理项：前端 4 项（1 high、3 moderate），Vercel CLI 开发依赖 33 项
（1 critical、24 high、8 moderate）。已运行兼容范围内的 `npm audit fix`；没有使用
`--force` 强制更换框架或 CLI 大版本。对外部署前应单独处理并重新验证这些依赖。
