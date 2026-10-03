# 开发进度

更新时间：2026-10-03

## Submissions API

**Status：等待测试**

已完成实现和指定 Supabase 项目的部署，等待前端联调与人工验收。自动化检查通过不代表人工验收完成。

| Task | 已完成内容 | Status |
| --- | --- | --- |
| 正式提交 | `POST /tasks/{id}/submissions`；校验已发布问卷、原因、证据和首次截止时间，生成唯一编号 | 等待测试 |
| 补充提交 | `POST /submissions/{id}/revisions`；同编号保存完整修订历史，允许截止后补充 | 等待测试 |
| 提交查询 | 本人列表、发布者分页列表、提交详情；按身份限制可见范围 | 等待测试 |
| 人工审核 | 接受、请求补充、不接受；原因校验、版本冲突保护和终态限制 | 等待测试 |
| 证据文件 | 私有 Storage 上传授权、实际文件大小及格式头校验、短期读取链接、禁止覆盖 | 等待测试 |
| 数据库与权限 | submissions 相关表、RLS、仅 service-role 可调用的事务 RPC、幂等和并发保护 | 等待测试 |
| AI 任务记录 | 正式提交及补充时原子创建 `queued` 任务记录，独立于人工审核 | 等待测试 |
| 部署与接口文档 | 独立 `submissions` Edge Function，复用现有任务表，提供请求示例与验证脚本 | 等待测试 |

### 部署信息

- 项目：`myjdykfmxspqtgbuoqdt`
- Function：`submissions`，已确认 ACTIVE，版本 2
- API 基地址：`https://myjdykfmxspqtgbuoqdt.supabase.co/functions/v1/submissions/v1`
- 新增迁移：`20261003231000_submissions_api.sql`
- 依赖迁移：`20261003230000_task_api.sql`，从远端获取，未修改
- 本次未覆盖已有任务 `api` 函数。

### 已执行验证

- Deno 类型检查、lint 和格式检查通过。
- 8 个单元测试通过。
- 64 项线上检查通过，覆盖真实 Auth/Storage、鉴权、幂等、并发提交与审核、分页、截止后补充和文件保护。
- 线上测试创建的临时账号、任务、提交和文件已清理。

### 等待测试与当前边界

- 等待前端接入真实接口，人工验收上传 → 正式提交 → 请求补充 → 补交 → 接受/不接受流程。
- 前端当前仍使用 Mock，本次未改前端适配器。
- 免费任务接受后为 `accepted` / `not_required`；支付尚未接入，付费接受返回 `409 payment_not_configured`，不改变审核状态。
- AI worker 尚未实现；本次只保存待处理任务，摘要保持 `queued`。
- 服务端草稿、通知、整体结果聚合和未使用上传文件的定期清理不在本次实现范围。

接口契约及复测命令见 [SUBMISSIONS_API.md](./SUBMISSIONS_API.md)。
