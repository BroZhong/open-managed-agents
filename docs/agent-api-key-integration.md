# 通过 API Key 调用 Agent 并获取产物

面向其他业务的后端服务。本文使用已在线上验证的 `test-gpt6`，演示创建 Workspace、创建 Session、发起任务、等待结束和下载文件。示例只使用 API key，不需要用户登录 token。

## 1. 接入信息

| 配置 | 值 |
| --- | --- |
| API Base URL | `https://agentry.welltop.tech/api` |
| Agent 名称 | `test-gpt6` |
| Agent ID | `agent_Gm9zOmeyCQ6seu0O0XEwI` |
| 当前模型 | `openai-codex/gpt-6-astra` |
| 认证请求头 | `x-api-key: <完整 API key>` |
| JSON 请求头 | `Content-Type: application/json` |

由平台方单独提供 API key。不要把真实 key 写进本文、代码仓库或浏览器前端；业务后端从环境变量或密钥管理服务读取。API key 必须与目标 Agent 属于同一 Tenant（租户）。Agent ID 是调用参数，名称只用于识别；模型可能由平台方调整。

**当前权限边界：**API key 可以访问所属 Tenant 的全部业务接口，包括修改 Agent、创建和撤销 key。当前没有“只允许调用某个 Agent”的 scope；同一 Tenant 下分发不同 key，也不会自动隔离不同业务的数据。若需要向不可信第三方提供单 Agent 调用能力，应先增加权限控制或由业务网关封装，不能把现有 key 当作单 Agent 专用凭据。

请只发送 `x-api-key`，值不加 `Bearer`。如果同时发送 `Authorization: Bearer ...`，服务端优先验证 Bearer；失效的 Bearer 会直接导致 `401`。

## 2. 调用流程

```text
业务后端
  │  POST /v1/workspaces                 创建文件空间
  │  POST /v1/sessions                   绑定 Agent 和 Workspace
  │  POST /v1/sessions/{id}/events        提交任务，返回 202
  │  GET  /v1/sessions/{id}/events        轮询执行事件
  │  GET  /v1/workspaces/{id}/files       查询文件列表
  └  GET  /v1/workspaces/{id}/files/{path} 下载文件
```

- **Workspace** 存放输入文件、中间文件和输出文件，独立于 Session 存在。
- **Session** 是一次对话的执行上下文，创建时绑定 Agent 和 Workspace。
- **Turn** 是 Agent 处理一次输入的执行过程，一个 Session 可以包含多个 Turn。

建议每个独立业务任务创建新的 Workspace 和 Session，把 `业务任务 ID → workspaceId、sessionId` 保存到业务数据库。本文示例每个 Session 只提交一次任务；多轮复用时需要另外记录本轮事件起点并关联 `turnId`，不能用历史完成事件判断新一轮已经完成。

### 2.1 设置环境变量

以下 cURL 示例需要 Bash 和 jq，按顺序在同一个 Shell 中执行：

```bash
set -euo pipefail
export OMA_API_URL='https://agentry.welltop.tech/api'
export OMA_AGENT_ID='agent_Gm9zOmeyCQ6seu0O0XEwI'
# 通过你的密钥管理方式设置 OMA_API_KEY，不要使用文档中的占位符作为真实 key。
```

### 2.2 创建 Workspace

```bash
WORKSPACE_ID=$(curl --fail-with-body -sS "$OMA_API_URL/v1/workspaces" \
  -H "x-api-key: $OMA_API_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"name":"业务任务示例"}' | jq -er '.id')
```

成功状态：`201`。返回 Workspace 对象，其中 `id` 是后续文件接口使用的 ID。

### 2.3 创建 Session

```bash
SESSION_ID=$(curl --fail-with-body -sS "$OMA_API_URL/v1/sessions" \
  -H "x-api-key: $OMA_API_KEY" \
  -H 'Content-Type: application/json' \
  -d "$(jq -n --arg agent "$OMA_AGENT_ID" --arg workspace "$WORKSPACE_ID" \
    '{agent:$agent, workspace_id:$workspace}')" | jq -er '.id')
```

成功状态：`201`。注意：创建请求字段是 `workspace_id`；返回对象里的绑定字段是 `workspaceId`。

### 2.4 发起任务

```bash
curl --fail-with-body -sS "$OMA_API_URL/v1/sessions/$SESSION_ID/events" \
  -H "x-api-key: $OMA_API_KEY" \
  -H 'Content-Type: application/json' \
  -d '{
    "events":[{
      "type":"user.message",
      "data":{
        "content":[{
          "type":"text",
          "text":"请写一份简短的 API 接入说明，实际保存到 /home/user/workspace/outputs/result.md。必须创建文件，不要只在回复中展示正文。完成后回复文件路径。"
        }]
      }
    }]
  }'
```

返回 **`202 Accepted`**：

```json
{"accepted":true,"interrupted":false}
```

这表示输入已接受，任务仍可能排队或执行中。`POST /v1/sessions/{id}/messages` 已移除，请使用 `/events`。

### 2.5 等待执行结束

```bash
curl --fail-with-body -sS \
  "$OMA_API_URL/v1/sessions/$SESSION_ID/events?after_seq=0&limit=100" \
  -H "x-api-key: $OMA_API_KEY" \
  -H 'Accept: application/json'
```

返回结构示意：

```json
{
  "data":[{
    "sessionId":"sess_...",
    "seq":18,
    "type":"session.turn_completed",
    "data":{"pendingEventId":"...","turnId":"..."},
    "ts":"2026-09-15T10:00:00.000Z",
    "sessionThreadId":"sthr_primary"
  }],
  "has_more":false
}
```

处理规则：

1. 保存已经处理的最大 `seq`，下一次传 `after_seq=<最大seq>`。
2. `has_more=true` 时立即读取下一页；读完当前页后，若任务尚未结束，间隔约 3 秒继续查询。
3. 新 Session 的本次输入出现 `session.turn_completed` 表示该 Turn 结束。不要仅凭 `202`、`agent.message` 或 Session 的 `idle` 状态判断任务完成：新建 Session 本身也是 `idle`。
4. 检查 `session.error`、`agent.error` 等执行错误，并验证所需产物。完成事件没有 `success=true` 保证，也不意味着业务目标必然达成。
5. 设置业务超时时间。停止轮询不会取消任务；保留 ID 后可继续查询，不要因超时自动再发同一条输入。

若需要流式进度，可使用 SSE：

```bash
curl -N "$OMA_API_URL/v1/sessions/$SESSION_ID/events?replay=1&include=chunks" \
  -H "x-api-key: $OMA_API_KEY" \
  -H 'Accept: text/event-stream'
```

SSE 在 Turn 完成后仍保持连接，客户端应按事件自行结束等待；重连时可发送上次收到的 `Last-Event-ID`。

### 2.6 查询产物合集

```bash
curl --fail-with-body -sS \
  "$OMA_API_URL/v1/workspaces/$WORKSPACE_ID/files?prefix=outputs/" \
  -H "x-api-key: $OMA_API_KEY"
```

返回结构示意：

```json
{
  "data":[{
    "path":"outputs/result.md",
    "size":256,
    "updated_at":"2026-09-15T10:00:00.000Z"
  }]
}
```

列表是平铺结构，当前不分页，`updated_at` 也可能为 `null`。它返回文件元数据，不包含文件内容或下载 URL。

`outputs/` 是本文与 Agent 约定的输出目录，平台不会自动识别哪些文件是“最终产物”。不传 `prefix` 时，会列出 Workspace 的可见文件，包括输入和中间文件；业务方应按约定的路径、格式和内容验收产物。

### 2.7 下载文件

```bash
curl --fail-with-body -sS \
  "$OMA_API_URL/v1/workspaces/$WORKSPACE_ID/files/outputs/result.md?download=1" \
  -H "x-api-key: $OMA_API_KEY" \
  -o result.md
```

成功返回文件原始字节，而不是 JSON 或 Base64。`download=1` 设置附件下载响应头。中文、空格、`#` 等文件名需逐路径段 URL 编码，目录之间的 `/` 保留为分隔符。下载接口使用 **Workspace ID**，不要传 Session ID。

若要让浏览器临时预览媒体而不接触 API key，可由业务后端获取签名链接：

```bash
curl --fail-with-body -sS -G \
  "$OMA_API_URL/v1/workspaces/$WORKSPACE_ID/preview-url" \
  -H "x-api-key: $OMA_API_KEY" \
  --data-urlencode 'path=outputs/result.md' \
  --data-urlencode 'expiresIn=600'
```

返回 `{"url":"临时签名URL","expiresIn":600}`。访问该 URL 不需要 API key；有效期为 60–900 秒，默认 600 秒。仅向需要访问该文件的用户提供链接，不要把它当作永久地址。

## 3. 可运行的 Python 示例

文件：[examples/call_agent.py](examples/call_agent.py)。使用 Python 3.10+，无需安装第三方库。

在仓库根目录运行：

```bash
# 先设置 OMA_API_KEY；OMA_API_URL、OMA_AGENT_ID 可覆盖脚本默认值。
python3 docs/examples/call_agent.py \
  --prompt '生成一份产品介绍，实际保存到 /home/user/workspace/outputs/result.md，完成后回复路径。' \
  --timeout 600 \
  --output-dir ./oma-results
```

脚本将：

- 创建独立 Workspace 和 Session，并先把 ID 写到本地 `job.json`。
- 提交一次输入，以 `202` 验证接受结果。
- 分页轮询事件，检查完成、错误和超时。
- 列出 `outputs/` 中的文件，安全处理文件路径并下载到独立本地目录。
- 保留服务端 Session 和文件，方便业务继续查询。

网络异常或轮询超时后，可使用 `job.json` 中的 ID 继续查询，**不会再次提交输入**：

```bash
python3 docs/examples/call_agent.py \
  --session-id 'sess_...' \
  --workspace-id 'ws_...' \
  --timeout 600
```

此恢复模式同样假设该 Session 只提交过一次任务。提交输入时若连接中断，无法仅凭客户端报错判断服务端是否接受；先检查事件和 `/v1/sessions/{id}/pending`。当前不能依赖 `Idempotency-Key` 请求头去重，示例不会自动重试创建或提交类请求。

## 4. 可选：提交输入文件

Agent 运行前，先把素材上传到同一 Workspace：

```bash
curl --fail-with-body -sS \
  "$OMA_API_URL/v1/workspaces/$WORKSPACE_ID/files/upload" \
  -H "x-api-key: $OMA_API_KEY" \
  -F 'path=inputs/brief.txt' \
  -F 'file=@./brief.txt'
```

成功返回 `200`。使用 `-F` 时不要手动设置 `Content-Type`，由客户端生成 multipart boundary。随后在任务中明确告知 Agent 读取 `/home/user/workspace/inputs/brief.txt`，把输出写到 `outputs/`。

同一 Workspace 可以被多个 Session 共享，运行期间文件也可写入，但同一路径的并发写入可能覆盖，重命名也不是原子操作。独立任务使用独立 Workspace 可以减少相互干扰。

## 5. 异常处理与任务结束

| 现象 | 处理 |
| --- | --- |
| `400` | 检查 JSON 字段、事件类型、文件路径与上传参数 |
| `401` | 检查 `x-api-key` 是否正确、是否被撤销，以及是否误带了失效 Bearer |
| `404` | 检查 Agent、Workspace、Session、文件是否存在且属于该 key 的 Tenant |
| `410` | Session 已终止，不能继续提交输入；新任务创建新 Session |
| `503` | 服务或存储暂不可用；查询类请求可退避重试，提交类请求先确认是否已接受 |
| Turn 结束但无产物 | 查看事件中的执行错误，检查是否要求实际保存文件，以及输出路径是否符合约定 |
| 轮询超时 | 保存 ID 并稍后继续查询；是否中止执行由业务决定 |

需要中止当前 Turn、保留 Session 时，提交：

```http
POST /v1/sessions/{sessionId}/events
x-api-key: <API key>
Content-Type: application/json

{"events":[{"type":"user.interrupt","data":{}}]}
```

若业务已结束且不再继续对话，可调用 `DELETE /v1/sessions/{sessionId}` 终止 Session、释放执行资源。已有 Workspace 文件和历史记录仍保留，仍可通过 Workspace 文件接口获取。文件需按业务保留策略单独删除，终止 Session 不等于删除产物。

## 6. 验证记录与契约

2026-09-15 已使用上述 `test-gpt6` 与 API key 完成线上验证：创建 Workspace `201`、创建 Session `201`、提交输入 `202`、真实 Agent 工具写入、列表查询与下载 `200`，文件内容逐字节一致。

本文附带的 Python 示例还通过了上述真实 Session 的恢复查询与下载验证，下载内容与原产物一致；本次未用该脚本重新发起模型任务。

- [线上 OpenAPI 契约](https://agentry.welltop.tech/api/openapi.json)
- [Workspace 迁移与测试记录](workspace-api-migration-2026-09-15.md)
- [Apifox 公开文档](https://f2imdh2qly.apifox.cn)：路径已迁移，但当前部分鉴权配置和导出字段仍有差异；认证方式以本文和线上契约为准。
