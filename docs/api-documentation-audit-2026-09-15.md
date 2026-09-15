# API 文档与线上接口核对 — 2026-09-15

## 结论与范围

本次在用户授权下，通过正式 API 入口完成了当前本地契约所列 **54 个 HTTP operation** 的线上请求核对，其中 **52 个验证了至少一条 2xx 成功流程，2 个认证接口仅验证了错误输入返回 400**。没有完全未触达的 operation。另验证了缺少凭据、无效 Bearer 优先、Session 终止后拒绝输入等部分失败分支。

这表示每个接口都有请求观测，**不表示所有接口的成功流程、参数组合、错误分支、并发条件或性能都已验证**。下文逐项列出实际 HTTP 状态与覆盖边界。

- 线上入口：`https://agentry.welltop.tech/api`。表中的路径相对于该入口。
- 本地核对范围：[OpenAPI 文档源](../server/packages/api/src/openapi/routes.ts)、[schema](../server/packages/api/src/openapi/schemas.ts)、对应 handler，以及 [生成契约](openapi.json)。
- 线上证据：本次会话生成的脱敏临时记录 `/tmp/oma-api-audit/results.json`，封闭时共 88 条请求记录；公开契约快照 `/tmp/oma-api-audit/live-openapi.json`。这两个临时文件不是仓库的长期附件。
- 记录仅保留接口模板、状态与必要结论；不包含用户 API key、签名 URL、业务资源 ID 或业务内容。

## 线上版本与入口差异

| 核对项 | 实际观测 | 判断 |
| --- | --- | --- |
| `/api/health` | `200`，`application/json` | 正确 API 入口 |
| 不带 `/api` 的 `/health` | `200`，HTML | 命中网页入口；只检查 HTTP 200 会误判 API 可用 |
| 线上 `/api/openapi.json` | `200`；55 个 operation | 线上版本尚包含旧接口 |
| 本地当前契约 | 54 个 operation、46 个 schema | 已删除明确弃用的 `/messages` |
| 两份契约的 operation 差集 | 线上仅多 `POST /v1/sessions/{id}/messages` | 属于尚未部署的版本差异，不是新接口缺失 |
| 线上契约 `servers[0].url` | `https://agentry.welltop.tech`，缺少 `/api` | 文档入口错误，需使用带 `/api` 的正式地址；修订发布状态见文末 |

本次没有以重新调用旧 `/messages` 的方式验证其执行行为。上表关于它的结论来自线上公开契约与本地契约的差集。

## 逐接口覆盖表

“成功流程”表示观察到至少一个 2xx 响应，并按该次请求核对了用途；`202` 仅说明输入被接收，执行完成另见后文。“仅输入验证”表示尚未验证正常认证成功。

| # | 方法 | 路径模板 | 已观测 HTTP 状态 | 覆盖说明 |
| --- | --- | --- | --- | --- |
| 1 | GET | `/health` | 200 | 成功流程：健康检查 JSON |
| 2 | GET | `/openapi.json` | 200 | 成功流程：读取线上契约 |
| 3 | POST | `/auth/register` | 400 | 仅输入验证；未创建真实用户 |
| 4 | POST | `/auth/login` | 400 | 仅输入验证；未验证用户名密码登录成功 |
| 5 | GET | `/v1/mcp-catalog` | 200 | 成功流程：读取可公开的 MCP 配置目录 |
| 6 | POST | `/v1/agents` | 201 | 成功流程：创建独立 mock 与真实模型测试 Agent |
| 7 | GET | `/v1/agents` | 200、401 | 成功流程；缺少凭据与无效 Bearer 返回 401 |
| 8 | GET | `/v1/agents/{id}` | 200、404 | 成功流程；删除测试 Agent 后确认 404 |
| 9 | POST | `/v1/agents/{id}` | 200 | 成功流程：修改测试 Agent |
| 10 | DELETE | `/v1/agents/{id}` | 200 | 成功流程：清理测试 Agent |
| 11 | GET | `/v1/agents/{agentId}/loops` | 200 | 成功流程：读取 Agent 的 Loop 列表 |
| 12 | POST | `/v1/agents/{agentId}/loops` | 201 | 成功流程：创建禁用状态的测试 Loop |
| 13 | GET | `/v1/loops/{id}` | 200 | 成功流程：读取测试 Loop |
| 14 | POST | `/v1/loops/{id}` | 200 | 成功流程：更新并确认测试 Loop 保持禁用 |
| 15 | POST | `/v1/loops/{id}/run` | 201 | 成功流程：手动触发 mock Loop 创建 Session |
| 16 | GET | `/v1/agents/{id}/files` | 200 | 成功流程：列出 Agent Files |
| 17 | GET | `/v1/agents/{id}/files/{filename}` | 200 | 成功流程：读取测试 Agent File |
| 18 | POST | `/v1/agents/{id}/files/{filename}` | 200 | 成功流程：写入测试 Agent File |
| 19 | DELETE | `/v1/agents/{id}/files/{filename}` | 200 | 成功流程：删除测试 Agent File |
| 20 | GET | `/v1/agents/{id}/skills` | 200 | 成功流程：列出装备的 Skill Fork |
| 21 | POST | `/v1/agents/{id}/skills` | 201、200 | 成功流程：首次装备创建 fork；重复装备返回原 fork |
| 22 | DELETE | `/v1/agents/{id}/skills/{skillId}` | 200 | 成功流程：卸载并删除测试 fork |
| 23 | POST | `/v1/skills` | 201 | 成功流程：上传测试 Library Skill |
| 24 | GET | `/v1/skills` | 200 | 成功流程：列出 Library Skills |
| 25 | GET | `/v1/skills/{id}` | 200 | 成功流程：读取 Skill 元数据与文件路径 |
| 26 | POST | `/v1/skills/{id}` | 200 | 成功流程：修改测试 Skill 元数据 |
| 27 | DELETE | `/v1/skills/{id}` | 200 | 成功流程：删除测试 Library Skills |
| 28 | GET | `/v1/skills/{id}/files` | 200 | 成功流程：列出测试 Skill 文件 |
| 29 | GET | `/v1/skills/{id}/files/content` | 200 | 成功流程：通过 query `path` 读取文本 |
| 30 | PUT | `/v1/skills/{id}/files/content` | 200 | 成功流程：写入测试 Skill 文本文件 |
| 31 | DELETE | `/v1/skills/{id}/files/content` | 400、200 | 初次将 `path` 放在 body 返回 400；改为 query 后删除成功 |
| 32 | POST | `/v1/skills/{id}/files/rename` | 200 | 成功流程：重命名测试 Skill 文件 |
| 33 | GET | `/v1/api-keys` | 200 | 成功流程：读取 key 元数据与使用量；报告不保存明细 |
| 34 | POST | `/v1/api-keys` | 201 | 成功流程：创建专用于本次测试的临时 key |
| 35 | DELETE | `/v1/api-keys/{id}` | 200 | 成功流程：吊销临时测试 key |
| 36 | POST | `/v1/workspaces` | 201 | 成功流程：创建独立测试 Workspace |
| 37 | GET | `/v1/workspaces` | 200 | 成功流程：读取 Workspace 列表 |
| 38 | GET | `/v1/workspaces/{id}` | 200 | 成功流程：读取测试 Workspace |
| 39 | POST | `/v1/workspaces/{id}` | 200 | 成功流程：修改测试 Workspace 名称 |
| 40 | POST | `/v1/sessions` | 201、400 | 成功流程：创建并绑定 Workspace；缺少 `agent` 返回 400 |
| 41 | GET | `/v1/sessions` | 200 | 成功流程：读取列表并验证选定的过滤请求 |
| 42 | GET | `/v1/sessions/{id}` | 200 | 成功流程：读取 mock 与真实模型 Session 状态 |
| 43 | DELETE | `/v1/sessions/{id}` | 200 | 成功流程：终止共享 Workspace 的 Session 及其余测试 Sessions |
| 44 | GET | `/v1/sessions/{id}/usage` | 200 | 成功流程：读取 mock 与真实模型调用的记录使用量 |
| 45 | POST | `/v1/sessions/{id}/events` | 202、400、410 | 接收 mock/真实模型输入；拒绝不支持的事件；拒绝已终止 Session 的新输入 |
| 46 | GET | `/v1/sessions/{id}/events` | 200 | 成功流程：JSON 历史和 `text/event-stream` 历史重放 |
| 47 | GET | `/v1/sessions/{id}/pending` | 200 | 成功流程：读取 queued input 的统一响应形状 |
| 48 | PUT | `/v1/sessions/{id}/workspace/files/content` | 200 | 成功流程：写入嵌套路径文本文件 |
| 49 | DELETE | `/v1/sessions/{id}/workspace/files/content` | 200 | 成功流程：通过 query `path` 删除测试文本与二进制文件 |
| 50 | POST | `/v1/sessions/{id}/workspace/files/rename` | 200 | 成功流程：重命名测试 Workspace 文件 |
| 51 | POST | `/v1/sessions/{id}/workspace/files/upload` | 200 | 成功流程：上传二进制文件 |
| 52 | GET | `/v1/sessions/{id}/workspace/preview-url` | 200 | 成功流程：签发预览 URL；报告不保留该 URL |
| 53 | GET | `/v1/sessions/{id}/workspace/files` | 200 | 成功流程：空目录、文件列表与清理后空列表 |
| 54 | GET | `/v1/sessions/{id}/workspace/files/{path}` | 200 | 成功流程：嵌套文件读取、二进制下载、跨 Session 读取与终止后读取 |

表中第 31 项的首次 `400` 是测试请求输入位置错误。接口契约要求 `DELETE .../files/content?path=...`；纠正后已返回 `200`，不计为 API 缺陷。

## 已完成的行为验证

### Agent 执行与事件

- mock 流程：创建 Agent 和 Session、提交 `user.message`、读取 pending 与完整事件历史、核对 Turn 已完成。
- 真实模型流程：创建独立测试 Agent 和 Session，`POST /events` 返回 `202`；随后核对模型回答符合预期探针结果及完成事件。仅收到 `202` 没有被当作执行成功依据。
- 真实模型记录使用量：`input_tokens=4485`、`output_tokens=37`、`total_tokens=4522`；本次 `cache_read_tokens=0`、`cache_write_tokens=0`、`cache_hit_rate=0`。这是一轮测试观测，不是固定调用成本。
- SSE 历史重放返回 `200` 和 `Content-Type: text/event-stream`，与 JSON 历史读取路径分别核对。
- 对 idle Session 发送 `user.interrupt` 返回 `{ "accepted": true, "interrupted": false }`；该检查没有验证正在执行的 Turn 被中止。
- Session 终止后再次发送输入返回 `410`。

### Workspace 与 Session 的关系

文件归属于 Tenant 的持久 Workspace。Session 路径用来验证调用方对 Session 的权限，再解析其绑定的 Workspace；写操作还会检查该 Session 是否有 running Turn。这个写入限制只检查请求路径中的 Session，不能阻止其他共享该 Workspace 的 Session 同时写入。

本次创建第二个 Session 绑定同一 Workspace，成功读取先前保存的文件；终止其中一个 Session 后仍可读取已保存的文件。清理测试文件后，再次列出 Workspace 确认为空。

### 鉴权

- 用户提供的 API key 通过 `x-api-key` 鉴权，受保护接口返回正常结果。
- 缺少凭据返回 `401`。
- 同时提供有效 API key 和无效 Bearer 时返回 `401`，验证了 Bearer 优先且失败不回退的行为。
- 注册与登录只使用无效输入验证了 `400`；没有验证真实用户注册、密码登录、token 过期或刷新流程。

## 文档不一致与本地订正

下面区分线上实测与代码审计。代码存在某条分支，并不等于本次已在线触发该分支。

| 项目 | 证据 | 订正内容与边界 |
| --- | --- | --- |
| 正式 API 地址缺少 `/api` | 线上入口与公开契约 | 使用 `https://agentry.welltop.tech/api`；不能把无前缀页面的 HTML 200 当成 API JSON 成功 |
| 旧 `/messages` 仍出现在文档 | 线上 55、本地 54 的差集 | 本地已移除旧 handler、专属 schema、测试与文档项；线上尚未部署此删除 |
| 登录遗漏 `400` | 线上错误输入与契约校验 | 补充文档响应，不改变认证行为 |
| Bearer 说明不完整 | 鉴权 middleware、线上 401 | 说明注册和登录均可签发 30 天 JWT，以及 Bearer 优先且失败不回退 |
| `/events` 请求、确认与流式行为不清楚 | 线上 mock/模型/SSE 与 handler | 增加 `user.message` 示例；区分 `202` 接收确认与完成事件；注明 JSON 分页和 SSE 重放参数的不同作用 |
| SSE frame 描述把 `id` 视为所有 frame 都具备 | SSE handler 与事件编码 | durable event 的 `id` 是 `seq`；Delta 不带 SSE `id`；还会出现 retry 指令及 keepalive 注释 |
| Workspace 文件的归属与访问入口混淆 | 共享与终止后读取实测、ADR-0008 | 说明文件属 Workspace，Session 是鉴权、绑定与运行中写入检查入口；终止 Session 保留已保存文件 |
| 文件读取的 MIME 说明过于简单 | 文件读取 handler、MIME 解析实现 | 有意义的存储 MIME 会保留；缺少或通用 MIME 可按扩展名补充。签名 URL 直读保留对象存储元数据 |
| 签名预览遗漏有效期和 `501` | handler；线上签发 `200` | 文档注明默认 600 秒、有限数值取整后约束至 60–900 秒、后端不支持签名时返回 `501`。本次未在线触发 `501` |
| Workspace 重命名、上传副作用描述缺失 | handler 与 ADR-0008 | 说明覆盖目标、复制后删除的非原子重命名、顺序上传失败不回滚已保存文件；本次未做故障注入 |
| Skill 删除被描述为只接受 Library Skill | 所有权检查 handler | 实际可接受 Tenant 内 Library Skill 或 Agent Skill；卸载已装备 fork 应使用 Agent 下的专用删除接口，以一并移除装备引用 |
| 重复装备 Skill 的含义不清楚 | 线上先 `201` 后 `200` | 说明返回已有 fork，不会从 Library 自动刷新其内容 |
| Token usage 被称为逐 token 实时统计 | 使用量聚合实现、线上模型用量 | 改为已记录的 durable model-request 使用量，保留缓存命中率公式 |
| 存储与文件 API 使用文章过时 | [使用文章](articles/11-how-to-use.md)、[技术材料](articles/cloud-agent-materials.md)、ADR-0008 | 旧文章称 Workspace CRUD 不在 OpenAPI、没有签名 URL、Workspace 与 Skill 都使用 Supabase、根目录为 `/home/user`，并把 hydrate/sync/Baseline 当作现行流程。当前修订明确 Workspace 使用 OSS 直接挂载 `/home/user/workspace`，Skill 仍使用 Supabase 与只读投影；旧同步机制标为历史方案 |

这些过时存储说法来自仓库文章。没有证据证明 Apifox 项目简介也曾包含这些说法。

## 尚未验证的行为

54 个 operation 都已触达，但以下内容仍不能由本次测试推出：

- 注册和登录的正常成功流程、invite code 各失败分支、JWT 过期。
- 所有请求字段、分页边界、过滤器组合、路径编码及跨 Tenant 隔离分支。
- running Turn 的实际中止、执行中 Workspace 写入 `423`、大量 queued input 的分页边界。
- SSE 重连与并发写入竞争、长时间 keepalive、大规模历史重放、Delta 去重的所有场景。
- 签名 URL 的实际外部读取、过期、Range 请求等完整媒体使用流程；签发 `200` 本身不证明这些行为。
- 存储不可用 `503`、签名不支持 `501`、重命名中途失败、批量上传部分失败。
- Loop 的自动定时触发、延迟恢复、并发调度；本次仅手动运行了禁用的测试 Loop。

## 测试资源清理

线上测试已结束，探针进程已退出并清除其内存凭据。清理结果如下：

- 两个测试 Agent 已删除，随后 GET 均返回 `404`。
- 4 个测试 Session 均已终止。
- 测试 Library Skills 与装备 fork 已删除。
- 临时测试 API key 已吊销；用户原有 key 未被修改。
- Workspace 内测试文本与二进制文件已删除，最终列表为空。
- 测试 Loop 保持 `enabled=false`。

Session 历史、空 Workspace 和禁用 Loop 的元数据依照现有 API 能力保留。目前没有 Workspace/Loop 删除接口；本次没有绕过 API 直接修改数据库。

## 本地验证

- `pnpm --filter @oma-server/api typecheck`：通过。
- `pnpm --filter @oma-server/api test`：29 个测试文件通过、1 个跳过；391 项测试通过、1 项跳过。这里记录当前工作区的运行结果，不能代替线上未覆盖分支的验证。
- `bash -n server/test-api.sh`：通过。
- 冒烟脚本已改为同时确认 HTTP `200`、`Content-Type: text/event-stream` 和至少一个含合法 JSON data 的完整 event frame。只有满足这些条件，curl 维持长连接导致的预期超时才被接受。
- 使用本地 HTTP fixture 和真实 curl 验证了 6 种脚本场景：完整 SSE、有效 SSE 后超时均成功；收到响应前超时、返回 `200 JSON`、只有 keepalive/retry、event data 不是合法 JSON 均失败。各场景的测试资源清理调用与临时响应文件清理均通过；没有使用线上凭据或触发模型调用。

## 发布与 Apifox 状态

- 本地接口删除及文档修订：已形成可检查的源码变更；本报告不宣称它们已经部署至线上。
- GitHub `PUBLIC_API_URL` 已更新并回读为 `https://agentry.welltop.tech/api`；Apifox 站点和默认版本均已绑定正确环境。`pnpm openapi:check` 通过，保留 4 项原有 lint 警告。
- Apifox 同步脚本新增官方 OpenAPI 3.1 内容回读检查，并接入 CI；本次实际回读会正确报告尚存差异，不宣称 CI 已恢复成功。脚本单元测试全部通过。
- Apifox 已导入 54 个 operation、46 个 schema，并绑定带 `/api` 的正式环境。
- 使用无凭据公开 GET 核对了 [公开目录](https://f2imdh2qly.apifox.cn/llms.txt) 与全部 54 个 operation Markdown 页面：均返回 `200`；方法、路径、summary、description、operationId、响应状态码集合和 server 与当前候选契约一致。目录已删除 `/messages` 及 `ContentBlock`、`TextBlock`、`ImageBlock` 三个专用 schema；Workspace 文件说明也已更新。
- 已在 AI 分支 `ai/20260915-from-main-api-auth`（ID `8635798`）修复 50 个受限接口的鉴权，官方导出确认其均为 API key **或** Bearer，4 个公共接口仍免鉴权。同一分支补全 Workspace 上传的 4 个表单字段，并在原始 `requestBody.jsonSchema` 保留完整 `anyOf`。
- 分支修复尚未合入主分支：主分支直接编辑返回 `403075 Automation caller branch required`；CLI 2.2.1 和 2.2.7 合并均返回 `422001 Invalid Parameter`。主分支未开放 AI 写入，权限变更等待用户确认；没有关闭项目保护或绕过限制。
- 公开页面的基础信息一致，不代表逐字段机器契约一致；已确认的输出限制见下节。

## 仍存在的平台输出限制

Apifox 的官方 OpenAPI 3.1 导出与公开站的 Markdown 内嵌 OpenAPI 3.0.1 有不同结果。下面记录本次首次导入后的回读快照；官方导出成功不能代替公开站核对。普通 URL、带查询参数的 URL 和 `Cache-Control: no-cache` 均复现了任意类型字段错误，响应显示缓存未命中，因此不能仅归因于旧缓存。格式转换是可能原因，尚未确认平台内部实现。

| 字段或行为 | 本地契约与实际接口 | 官方 OpenAPI 3.1 导出 | 公开 Markdown 内嵌契约 |
| --- | --- | --- | --- |
| `UserEvent.data` | 接受任意 JSON；说明与示例展示 `user.message` 的对象 payload，线上对象输入已成功执行 | 任意类型、说明与对象示例保留 | 错写为 `string`，丢失字段说明与对象示例；独立 schema 页面也相同 |
| `StoredEvent.data` 及其他任意 JSON 字段 | 不限定为字符串；事件历史在线正常返回 | 保留任意类型 | `StoredEvent.data`、pending 的 `data`、`ToolConfig.inputSchema.additionalProperties` 和 OpenAPI 响应的 `additionalProperties` 被改为字符串 |
| 请求体是否必填 | 20 个 operation 的本地 `requestBody.required=true` | 保留 `required=true` | 20 个 operation 均未输出该标记 |
| GET `/v1/sessions/{id}/events` 的 `200` 响应 | 支持 `application/json` 和 `text/event-stream`；两种流程均已在线验证 | 两种 media type、SSE 说明与示例均保留 | 只保留 `application/json`，丢失 `text/event-stream` 响应分支；接口 description 中的 SSE 说明仍存在 |
| Workspace 文件上传的 multipart schema | 本地用 `anyOf` 描述 `file` 或 `files` 形式；二进制上传已在线成功 | 首次导入回读中 `anyOf` 丢失，只剩空对象 schema | 同样只剩空对象 schema；这项损失已经发生在官方导出之前或之中，不能只归因于公开站 |

后续 AI 分支试验进一步确认：原始 `requestBody.jsonSchema` 可以完整保存上传 `anyOf`，但官方 3.1 导出仍不输出这个约束；公开表单字段可补齐，不能据此宣布机器契约已完整保留。

上述差异没有改变线上 handler 的行为；本次对应的实际请求正常，本地契约仍是这些字段的依据。**公开 Markdown 不能作为准确的机器契约替代来源**，尤其不能据此生成 `data: string` 的事件请求或认定接口不支持 SSE。本次不能保证 Apifox 各输出格式逐字段一致，也不宣称所有文档问题已经订正完成。

脱敏临时证据包括 `/tmp/oma-api-audit/public-audit-summary.json`、`public-operation-documents.json`、`public-openapi-assembled.json`、`public-schema-cache-probes.json` 和 `public-contract-findings.json`。公开页面仅用于独立回读；没有通过修改其 OpenAPI 版本标记将它当作正式校验通过。

## 参考

- [领域模型](../CONTEXT.md)
- [ADR-0008：OSS 直接挂载 Workspace](adr/0008-oss-mounted-workspaces.md)
- [OpenAPI 文档构建及全局说明](../server/packages/api/src/openapi/document.ts)
- [Session handler](../server/packages/api/src/routes/sessions.ts)
- [Event handler](../server/packages/api/src/routes/events.ts)
- [Workspace 文件 handler](../server/packages/api/src/routes/workspace-files.ts)
