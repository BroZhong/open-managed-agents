# 如何使用

> 这一篇最短，但有一个我认为值得单独写一篇文章的观察：**一个端点的存在或不存在，是在回答"这个状态归谁"。**

## 一、API 表面：常用端点

```
GET    /health

POST   /v1/agents                      创建 Agent
GET    /v1/agents                      列出 Agent
GET    /v1/agents/{id}                 读取 Agent
POST   /v1/agents/{id}                 更新 Agent
DELETE /v1/agents/{id}                 删除 Agent

POST   /v1/sessions                    创建 Session
GET    /v1/sessions                    列出 Session
GET    /v1/sessions/{id}               读取 Session
DELETE /v1/sessions/{id}               终止 Session

POST   /v1/sessions/{id}/events        追加用户事件
GET    /v1/sessions/{id}/events        取事件（JSON 或 SSE 流）
GET    /v1/sessions/{id}/pending       查询 Session 的排队输入

GET    /v1/api-keys                    列出 API key
POST   /v1/api-keys                    创建 API key
DELETE /v1/api-keys/{id}               吊销 API key，保留用量历史
```

上面路径都相对于 API 基址：线上是 `https://agentry.welltop.tech/api`，本地默认是 `http://localhost:3000`。除健康检查外，以上接口需要 `x-api-key` 或登录得到的 Bearer token。完整接口清单以 `docs/openapi.json` 为准，已部署版本可查 `https://agentry.welltop.tech/api/openapi.json`。

## 二、三个值得指出的设计

### ① 一个端点同时提供 JSON 和 SSE

`GET /v1/sessions/{id}/events` 既能拉快照（JSON），也能订阅流（SSE）。

同一份事件日志，两种投影。这直接来自"会话是可寻址、可切片的持久对象"这个模型 —— **如果历史存在 runtime 的 session 文件里，这两件事就得是两套代码**：一套解析文件格式，一套接管实时输出，然后你要处理它们之间的重叠。

对照 Managed Agents，它把这两件事分成了两个端点（`GET /events` 和 `GET /events/stream`），并且文档反复强调三件配套的事：SSE 流没有重放、每次重连都要先开流再拉历史、按 event ID 去重。它还特意点出一个死锁 —— 如果流在一个 `agent.custom_tool_use` 等待解决时断掉，Session 会 idle 等你，而你重连后收不到那个事件，就卡死了。

**我们把历史重放与活跃 Turn 的 Delta 补发放在服务端**（客户端通过 `replay=1` 或 `Last-Event-ID` 开启），呈现为一条流；客户端仍按持久事件序号去重，并将 Delta 替换为对应的 Complete Event —— 代价是服务端更复杂。两种选择都合理，取决于你想把复杂度放在哪一边。作为一个要给多种客户端（Web、CLI、别人的系统）用的 API，我认为放服务端更好：复杂度写一次，而不是每个客户端写一次。

### ② `GET /v1/sessions/{id}/pending` 的存在本身是一个立场

排队输入是**服务端状态**，所以它必须可查询。

如果它是前端的乐观猜测，就不会有这个端点 —— 刷新一次就没了。这正是 issue #114 修的东西（"排队中的输入在 Turn 间隙从界面上消失"）。

**一个端点的存在或不存在，是在回答"这个状态归谁"。** 这句话值得当整篇文章的题眼，因为它是一个可以反过来用的诊断工具：看一个 API 有没有某个查询端点，就能推断出设计者认为那个状态归谁。

顺便一提，Managed Agents 用了另一种解法：`processed_at` 字段。客户端发的事件先带 `processed_at: null`（排队中）出现在流上，处理后再带时间戳出现一次。它有一个反直觉的例外值得记：`user.define_outcome`、`user.custom_tool_result`、`user.tool_result` 三个是**收到即处理**，回显时 `processed_at` 已经填好了 —— 所以一个假设"第一次见到必然是 null"的 pending→acknowledged UI，对这三个永远不会清除。

**这是同一个问题的两种解法**：我们做成一个可查询的资源，它做成流上事件的一个字段。字段的好处是不需要额外请求，代价是你只能在流上看到它 —— 刷新页面后要靠拉历史重建。

### ③ Workspace 文件接口也是公开 API

Workspace 的列表、读取、写入、删除、重命名、上传和临时预览链接均已收录在 OpenAPI；控制台与机器客户端共用这些接口：

```
GET    /v1/workspaces/{id}/files
GET    /v1/workspaces/{id}/files/{path}
PUT    /v1/workspaces/{id}/files/content
DELETE /v1/workspaces/{id}/files/content?path=...
POST   /v1/workspaces/{id}/files/rename
POST   /v1/workspaces/{id}/files/upload
GET    /v1/workspaces/{id}/preview-url?path=...&expiresIn=600
```

产物是怎么出现的值得说明白：Host 列出 Session 绑定的 Workspace 的 OSS 前缀，沙箱在 `/home/user/workspace` 直接挂载同一前缀。**Agent 在这个目录里用 `bash` 生成的文件，成功写入并关闭后也会出现在文件树里。** 挂载缓存可能影响跨客户端的可见时间，Turn 结束时控制台会刷新列表。

文件内容可以通过 Host 读取或下载（`?download=1`）；`preview-url` 返回短期有效的 OSS 签名 GET 链接，`expiresIn` 为 60–900 秒，默认 600 秒。文件接口直接使用 Workspace ID，无需先创建 Session；读写均验证 Tenant 归属。运行中的 Session 不阻止文件写入，同一路径的并发写入可能互相覆盖。终止 Session 会释放执行资源，并保留已经保存的 Workspace 文件。

对照 Managed Agents 的做法：Agent 写到 `/mnt/session/outputs/` 的文件被 Files API 自动捕获，之后用 `files.list({scope_id: session.id})` 列出、`files.download(id)` 下载。这是一个**约定目录**方案 —— 比"全盘扫描"便宜，代价是模型必须知道并遵守那个约定（如果它把文件写在别处，你就看不到）。

它的文档还老实记了一个细节：`session.status_idle` 到输出文件出现在 `files.list` 之间有约 1–3 秒的索引延迟，空的话要重试一两次。**这类"最终一致性的具体秒数"是文档里最有用的信息，因为它决定了你的重试逻辑该怎么写。**

## 三、三条典型用法

### 用法一：人在控制台里用

入口是 **Agent** 而不是会话列表。这是刻意的信息架构选择：**你先选"跟谁工作"，再选"哪次工作"。** Session 列在 Agent 内部。

Skill Library 与 Agent 列表在同一个入口页，装备（equip）在具体 Agent 页上做。这个位置也是刻意的 —— 因为 equip 是一次 fork（见 10 号文章的边界六），它产生的是一个 Agent 私有的拷贝，所以操作应该发生在 Agent 的上下文里，而不是库的上下文里。

### 用法二：机器调用（`x-api-key`）

Agent 配置一次，之后通过 Session 提交输入并订阅输出：

```
POST /v1/agents                           → agentId（一次性，配好人格/模型/技能）
POST /v1/sessions {"agent":"<agentId>"}   → sessionId
POST /v1/sessions/{id}/events             → 202，输入已接受
GET  /v1/sessions/{id}/events?include=chunks → SSE 流
```

发送与订阅使用两个请求。线上设置 `OMA_API_URL=https://agentry.welltop.tech/api`（包含 `/api` 前缀）；本地默认是 `http://localhost:3000`。下面假设已设置 `OMA_API_URL`、`OMA_API_KEY` 和 `SESSION_ID`：

```bash
curl -fsS -X POST "$OMA_API_URL/v1/sessions/$SESSION_ID/events" \
  -H "x-api-key: $OMA_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"events":[{"type":"user.message","data":{"content":[{"type":"text","text":"请执行任务"}]}}]}'

curl -fsS -N "$OMA_API_URL/v1/sessions/$SESSION_ID/events?include=chunks" \
  -H "x-api-key: $OMA_API_KEY" \
  -H "Accept: text/event-stream" \
  -H "Last-Event-ID: 0"
```

`202` 表示输入已接受，执行结果从 SSE 获取。`Last-Event-ID: 0` 会补发已有的持久事件；重连时改成最后收到的持久事件序号。`include=chunks` 开启实时 Delta；Delta 没有 SSE `id`，不要把它当作重连游标。客户端应按持久事件序号去重，并按 `turnId + blockIndex` 用 Complete Event 替换对应的 Delta。SSE 是 Session 级长连接，不会随一个 Turn 结束自动关闭；根据 `session.status_idle` 判断该 Turn 已结束，并检查是否出现 `session.error`。

之后每一轮只需向 `/events` 再提交一个 `user.message`，输出继续通过 SSE 接收。**Session 保留对话历史与绑定的 Workspace；沙箱重建后重新挂载同一份文件。** 只有 `/home/user/workspace` 持久化，HOME 下的依赖和缓存留在沙箱本地，重建后可能需要重新安装。

注意第一步的"一次性"。这跟 Managed Agents 强调的是同一条纪律，它的措辞更重：

> **Agent 一次，不是每次运行。** `agents.create()` 是一个 setup 步骤。存下返回的 `agent_id` 并复用；不要在热路径顶部调 `agents.create()`。

它给的反模式判据很实用：**如果你看到 `agents.create()` 出现在一个按请求或按 cron tick 调用的函数里，那就是错的** —— 提到一次性 setup 里，把 ID 持久化。

它还推荐一个划分我认为很有品味：**控制面用 CLI，数据面用 SDK。** Agent 和 environment 是相对静态的资源，做成 checked-in 的 YAML 从 CI apply；Session 是动态的，由应用代码驱动。

### 用法三：断线重连

这是最能体现架构价值的用法。

拿着 `Last-Event-ID` 重连 `GET /v1/sessions/{id}/events`，服务端**翻页 backfill 到 `hasMore === false`**，补齐断点之后的全部事件，然后接上活跃 Turn 的 Redis delta，呈现为一条连续的流。前端做指数退避自动重连（`lastSeqRef` + backoff）。

**这条值得写，因为它是"状态所有权在我们这边"的直接兑现。** 如果事件日志在别人的服务端，这套重连语义就是你去适配别人的，而不是你定义的 —— 你不能决定 backfill 要不要翻页、不能决定 delta 和 complete event 怎么合并、不能决定合并在哪一侧做。

顺便记一下这条路径上的坑（issue #95/#96）：backfill 原本有 `limit: 1000` 的静默截断。**任何 backfill 都必须翻页到 `hasMore === false`** —— 带默认上限的读接口在正常量级下永远是对的，只在最需要它对的时候错。

## 四、部署形态

线上跑在阿里云上海的 `agent-platform` ACS 集群，两个 Deployment（`oma-server` / `oma-web`）+
各自 Service，通过 ALB Ingress 统一暴露在 `https://agentry.welltop.tech`：`/api/*`
转发给 Server，其余路径转发给 Web。健康检查必须访问 `/api/health` 并确认 JSON `{"status":"ok"}`：不带 `/api` 的 `/health` 和 `/openapi.json` 会返回控制台 HTML，即使 HTTP 状态是 `200` 也不代表访问了 API。

依赖：

- **PostgreSQL**（Supabase）—— 权威事件日志 + 控制平面 + 待执行输入
- **Redis** —— per-Turn delta 流 + 活跃 Turn 映射
- **OSS** —— Workspace 文件的权威存储，沙箱直接挂载，Host 使用独立 OSS 配置访问
- **Supabase Storage** —— Skill 内容，与 Workspace 存储分开配置
- **ACK Agent Sandbox** —— `sandbox-system` 中唯一维护的 `auto-story-v2` SandboxSet 暖池，通过
  **E2B 兼容 SDK** 接入（配 `E2B_DOMAIN` + `E2B_API_KEY`）

沙箱底座为什么选它，正好呼应 02 号文章的"自研不等于全部自己写"：

| 它提供的 | 数字 |
|---|---|
| 隔离级别 | MicroVM 级隔离，计算/网络/存储端到端隔离 |
| 弹性 | 每分钟最高 15K 沙箱 |
| 休眠/唤醒 | 内存级休眠 + 状态保留，1s~10s 快速唤醒 |
| 冷启动 | 镜像缓存让拉取时间降低 90%+；配合预热池支持百毫秒级创建 |
| 接入 | **E2B 兼容 SDK**（推荐），复用既有调用方式 |
| 声明式管理 | Sandbox CR（CRD）管理沙箱模板、运行参数、生命周期 |
| 存储 | 运行中沙箱含 30 GiB 免费临时存储；休眠沙箱无免费额度 |

**E2B 兼容这一条是选型的决定性因素。** 它意味着我们的 `SandboxClient` 端口写一份就能同时对着 E2B 和 ACK，本地开发用 `FakeSandboxClient`，测试不需要真沙箱。**对基础设施产品来说，"兼容一个既有 SDK"是比任何独家能力更强的卖点。**

有意思的是我们**没有用**它的休眠/唤醒能力 —— 因为那个能力解决的是"沙箱是宠物"模式下的成本问题，而我们选的是"沙箱可丢弃、OSS 权威"（详见 07 号文章）。**平台的一个亮点能力，在另一种架构下是不需要的。买底座也要知道自己在买什么。**

## 五、两个真实的运维教训

这一节我建议放在最后，因为它给整个系列一个不那么漂亮但更真实的收尾。

### 教训一：线上 Agent 全线不回复

根因不在架构 —— 是 runtime 的 OAuth token 过期，导致 `model_request` 变成 0-token 空转。

**没有报错，只是不说话。**

### 教训二：文件功能全线报错

Supabase Storage 背后的 OSS AccessKey 失效，`getObject` 500，`putObject` 403（`InvalidAccessKeyId`）。同样不是代码问题，但表现是"文件功能全坏了"。

### 一个可以作为收尾的观点

**云端 Agent 的失败模式大多是"静默的"。**

不像本地报个栈就完事，云上的链条 —— 凭据 → 模型 → 沙箱 → 存储 —— 每一环都可能安静地退化成"什么也没发生"。而 Agent 这个形态天生掩盖静默失败，因为"它想了很久"和"它什么都没在做"从外面看起来一样。

所以 `span.model_request_start` / `span.model_first_token` / `span.model_request_end`（带 usage）这类可观测性事件不是锦上添花 —— **它们是唯一能区分"模型在想"和"什么都没在发生"的东西。**

`model_first_token` 这个事件的存在尤其关键：有 `request_start` 没有 `first_token`，就是"发出去了但没回来"；有 `first_token` 没有 `request_end`，就是"回来一半断了"。两个都有但 usage 是 0，就是我们那次 token 过期的形态。

这也正好回到 Flurry 的理由一：

> 如果沙箱死了，它无法上报自己的死亡。故障检测必须从你自己的后端发出。

**把可观测性放在后端，而不是放在那个会死的东西里面。** 这句话可以当整个系列的最后一句。

---

## 附：本文的事实来源

- 端点清单：`docs/openapi.json`
- SSE 重连与 backfill 翻页：issue #95/#96；ADR-0002 §3
- Queued Input 端点与 issue #114
- 当前 Workspace 存储、路径、持久化与签名链接：ADR-0008；`server/packages/api/src/routes/workspace-files.ts`（替代 ADR-0002 原存储部分）
- 部署拓扑与依赖：`deploy/k8s.yaml`
- ACK Agent Sandbox 数字：阿里云公开文档
- 两个运维事件：本项目运维记录
- Managed Agents 的对照（流/历史去重与死锁、`processed_at` 三个例外、`/mnt/session/outputs/` 与 1–3 秒索引延迟、agent-once 纪律、CLI/SDK 控制面数据面划分）：核对自官方 API 参考
- Flurry 的可观测性论点：《Run Your Harness Outside of the Sandbox》
