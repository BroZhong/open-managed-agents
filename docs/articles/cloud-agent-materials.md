# 云端 Agent — 待编辑素材

> 给作者的说明：这是按你的提纲组织的素材库，不是成稿。每节都标了「素材」「可直接用的段落」「引文/数据」「我的判断」。
> `docs/articles/cloud-agent-part1.md` 已经覆盖了提纲的第 1、2 节（缺 FastClaw），本文档补齐 FastClaw，并把「如何实现 / 如何使用」两大节从零写出来。
>
> **一个需要你决策的矛盾**：part1 结尾写「下一部分展开：为什么最终选了 Agent-in-the-Sandbox 而不是 Sandbox-as-Tool」。这跟代码里的事实是反的 —— ADR-0001 先定了 Agent-in-the-Sandbox，ADR-0002 把 Pi 改成了 Sandbox-as-Tool，线上跑的是后者。这个「先选 A 后改成 B」恰好是文章最值钱的一段（见 §3.2），建议改成正序叙述而不是掩掉。

---

## 0. 参考材料的定位（先说清楚每篇在讲什么）

写这篇文章的四篇参考资料并不在同一层，混着引会打架。先各自定位：

| 材料 | 作者/来源 | 它在论证什么 | 对本文的作用 |
|---|---|---|---|
| Anthropic《Managed Agents》工程博客 | Anthropic | **架构解耦**：Brain / Hands / Session 三分，以及为什么单容器（"pet"）模式必须被拆掉 | 提供"为什么要拆"的权威论证 + 性能数字 |
| Nathan Flurry《Run Your Harness Outside of the Sandbox》 | Rivet 创始人，2026-07-27 | **harness 应该跑在沙箱外面**，以及为什么无状态 HTTP 和工作流引擎都不行，应该用 actor 模型 | 提供"Sandbox as Tool"最完整的公开论证 |
| 艾逗笔《聊一聊 Agent 的存算分离架构设计》 | FastClaw 作者，2026-06-02 | **存算分离**：什么该存、什么该算，四类存储各归各位 | 提供中文语境下最贴切的框架 + 真实成本数字 |
| 阿里云 ACK Agent Sandbox 文档 | 阿里云 | **沙箱基座**：MicroVM 隔离、内存级休眠、E2B 兼容 SDK | 提供"底座买现成"的具体对象 |

**建议在文章开头就点明这个分层**，因为它本身就是一个洞察：这四篇讲的是同一个系统的四个不同切面 —— Anthropic 讲抽象，Flurry 讲 harness 的位置，艾逗笔讲状态的归属，阿里云讲底座。**四者叠起来，就是一份完整的云端 Agent 架构说明书。**

---

## 1. 为什么需要云端 Agent（补充素材）

> part1 的 1.1/1.2 已成型。以下是可以插进去加强论证的料。

### 1.1 补充：Anthropic 的"操作系统"类比（可以直接用来开篇）

Anthropic 给出的动机不是"云更好"，而是一个更尖锐的观察：

> harness 把"当下模型的能力假设"硬编码进了代码。模型变强之后，这些假设就变成了 **dead weight** —— 比如为早期模型设计的 context reset，在新模型上已经完全不必要，却还留在代码里。

他们的解法是操作系统类比：**把组件虚拟化成足够通用的抽象，以容纳"尚未被想到的程序"（programs as yet unthought of）**。

这个视角值得放在文章很前面的位置，因为它回答了一个更根本的问题：**云端 Agent 不只是"把 Agent 搬到云上"，而是给 Agent 建立一层稳定的接口，使实现可以在下面自由演进。** 本地 Agent 没有这个压力 —— 它的接口就是它的实现。

### 1.2 补充：三个可以直接引用的硬数字

写这类文章最缺的是数字，这三个都有出处：

**① Anthropic：解耦让首 token 时间 p50 降约 60%，p95 降超 90%。**
机制很有说服力：把容器供给（container provisioning）**推迟到真正需要的时候**。原来是"开会话就开容器"，现在是"要用手了才长手"。
→ 这条可以用来反驳"解耦是过度设计"：解耦在这里不是洁癖，是性能优化。很多会话根本不需要沙箱（纯聊天、读历史），为它们付容器冷启动是纯损失。

**② 艾逗笔（FastClaw）：服务器 18 台 → 3 台，运营成本降到 1/6。**
原架构是 k8s 上 500 个常驻 Pod、每个限 4G 内存、18 台 4c16g 节点池、月成本近 5000 美元；MRR 突破 8000 美元但利润极低。迁到存算分离后 3 台就够。
→ 这是全篇最有力的一个数字，因为它把架构选择直接翻译成了利润。**"Agent 无需常驻"不是技术优雅，是毛利率。**

**③ Nathan Flurry：harness 在沙箱外的额外延迟约 10ms（同数据中心）。**
对比参照：浏览器发一个普通 API 请求是 50–200ms。actor 本身闲时只占几兆内存。
→ 这条用来预先拆掉读者最容易有的反射式反对："跨进程调用不会很慢吗？"答案是：一次工具调用多 10ms，而它省掉的是整个沙箱的冷启动。

### 1.3 补充：Flurry 的三个"为什么不能把 Agent 放进沙箱"

这是 part1「1.1 技术视角」最好的加强材料，因为它比"笔记本会合盖"更狠 —— 它论证的是**即使你已经上了云，把 Agent 放在沙箱里仍然是错的**。三个理由（可以按这个结构复述）：

**理由一：爆炸半径（Blast Radius）。**
> 沙箱是用来盛放 Agent 制造的混乱的。这是设计使然 —— Agent 在沙箱里能做什么毫无结构，所以沙箱会因为非常非常多的原因而崩掉：一条 build 命令把沙箱 OOM 了，一个跑飞的脚本把 CPU 打满了，一次装歪的工具把 `$PATH` 搞坏了，或者文件系统干脆就烂了。

沙箱崩的时候会连带拖走三样东西：
- **Agent loop、重试与持久性**：本该从故障中恢复的机制，自己跟着故障一起死了。重试必须活在你的后端里。
- **会话历史**：存在沙箱里的历史会跟着一起损坏或清零。放外面，放进真正的数据库。
- **故障的可观测性**：沙箱死了就无法上报自己的死亡。故障检测要从你自己的后端发出。

**理由二：信任边界（Trust Boundary）。**
> 沙箱本该是 trust-nothing 架构，因为 Agent 天生容易被 prompt injection、天生会泄露敏感信息。**如果某个东西在沙箱里可访问，就应当假设这份数据或这个 API 会被滥用和泄露。**

以下这些事在沙箱里一件都做不安全：LLM 凭据与路由、权限与审批（"编码 Agent 被训练成会绕过障碍"）、审计日志（Agent 能篡改自己写的日志）、多人协作的按用户权限、访问内部数据库的可信工具、Agent 间通信。

**理由三：沙箱不总是在运行。**
沙箱按设计会在闲置时睡去。而睡着的沙箱做不了：定时任务（睡着的沙箱无法唤醒自己）、持久工作流（可能睡几小时后恢复）、快速加载会话（读历史不该需要唤醒沙箱）、跨会话检索（不可能唤醒一整队沙箱来建索引）。

> **我的判断（可以作为你的观点写出来）**：这三条真正的共同点是 —— **沙箱是"可丢弃"的，而以上每一件事都要求"不可丢弃"。** 把可丢弃的和不可丢弃的东西放在同一个进程里，是这个领域最常见的架构错误。part1 里"状态所有权的重新划分"那句话，正好是这三条的抽象版。

### 1.4 补充：艾逗笔的"存算分离"框架（强烈建议采用为文章骨架）

这套划分极其干净，值得直接借用（注明出处）。一个有灵魂、有记忆的 Agent，单次任务生命周期是：

1. 用户输入 query（text + files）
2. Agent 读取提示词文件（soul.md、identity.md、user.md）
3. Agent 读取可用的工具和技能（tools、skills）
4. Agent 读取记忆（memory.md、memory_search）
5. Agent 构建上下文（prompt + tools + memory + query）
6. Agent 进入 Loop（LLM 调用 → 工具调用 → 观测 → 再推理）
7. Agent 交付结果（Artifacts）

于是：

- **什么需要存**：提示词文件、工具和技能、对话记录、交付产物
- **什么需要算**：上下文拼接、LLM 调用、工具调用

一句话概括：`fn(query, agent runtime) = artifacts`

**三种运行方式**（这个分类可以直接用作文章的历史脉络）：

| 方式 | 代表 | 存算关系 | 主要问题 |
|---|---|---|---|
| 本地裸机 | OpenClaw | 存算一体，全在本地磁盘 | `exec(rm -rf /)` 直接破坏宿主机 |
| 本地带沙盒 | Codex | 只在工具调用环节引入沙箱做动态计算，存储仍靠宿主机文件系统 | 存仍绑在一台机器上 |
| 云端多副本 | Manus / 各家托管小龙虾 | 若用 PVC + 固定路由，仍是存算一体，只是搬到了 Pod 里 | **Pod 必须常驻，成本极高，难以规模化** |

第三行是关键：**"上云"本身不解决问题。** 把 500 个 Pod 常驻在 k8s 上，隔离性很好，但那只是把存算一体搬到了云上，成本反而更糟。真正的分水岭是存算是否分离。

**四类存储各归各位**（这张表可以直接用）：

| 状态类型 | 内容 | 介质 | 为什么 |
|---|---|---|---|
| 热状态 | Agent Loop 的 step、plan、游标 | KV（Redis） | 高性能低延迟，异常重启后断点恢复 |
| 对话与任务记录 | 完成后的会话历史 | 关系型数据库（Postgres） | 需要事务与查询 |
| 长期记忆 | 从记录里摘要提取的记忆 | 向量数据库（pgvector、milvus） | 需要语义检索 |
| 工作产物 | 用户上传文件、Agent 输出文件、tools、skills | 对象存储（S3、OSS） | 大对象、便宜、天然共享 |

---

## 2. 为什么自己实现（补 FastClaw 一节）

> part1 已写了 Claude Managed Agents、Qoder、AgentBay 三节和对照表。以下补 FastClaw，并给出插入建议。

### 2.4（新增）FastClaw：最接近的参照物，也是最直接的对手戏

FastClaw（艾逗笔，fastclaw.ai）在这篇文章里的位置很特殊：**它不是"平台"，而是和我们做同一件事的另一个实现。** 前三家是"要不要买"的问题，FastClaw 是"同一个问题的另一种解法"。所以这一节不该写成竞品分析，该写成设计对照。

**它的定位**：为云原生多租户场景设计的 Agent 运行框架，同样适用本地运行。相对 OpenClaw 的公开数字：代码体积约 1/40，运行资源占用约 1/7，单二进制分发无环境依赖，gateway 启动从约 15s 降到秒级。

**它的运行流程**（作者原文，可作为"存算分离参考实现"引用）：

1. k8s 集群，日常 2 个 Pod 部署 fastclaw gateway 接收请求
2. 负载均衡把请求路由到其中一个 Pod，Agent 开始计算：
   - 2.1 从 db 读取提示词文件（soul、identity、user）
   - 2.2 初始化 Pod 内一个临时目录作为 workspace
   - 2.3 初始化 sandbox，挂载 workspace
   - 2.4 从对象存储下载用户资料和系统 skills 到 workspace
   - 2.5 调用 memory_search，从向量数据库查询记忆
   - 2.6 拼接上下文，调用 LLM，解析工具
   - 2.7 在 sandbox 执行工具调用，读写 workspace 内的文件
   - 2.8 把 Loop 过程状态设为 checkpoint 存入 KV
   - 2.9 输出结果
3. 惰性检查关闭不活跃 sandbox，关闭前把 workspace 文件上传到对象存储

作者自己点出的最大挑战：**分布式多副本场景下的数据一致性**，需要合理使用锁机制与负载均衡策略。

**我们与它的三处实质分歧**（这是本节的重点，也是全文最有信息量的对照之一）：

**分歧一：工具能力是「按调用注入」还是「共享注册表」。**
FastClaw 用共享可变注册表持有工具。我们的 `ToolExecutor` 作为 **per-`run()` 调用参数**注入（`AdapterInput.toolExecutor`），既不是 Adapter 的构造器状态，也不是任何共享可变结构。代码注释里把这条写得很直白：

> Per-call injection is what makes true per-agent concurrency safe (the FastClaw shared-registry hazard we are explicitly avoiding).

原因很实际：一个 Host 进程里同时跑 N 个租户的 Turn，每个 Turn 绑定的是不同 Workspace、不同沙箱。共享注册表意味着这个绑定是全局可变状态 —— 并发下就是一个竞态。**按调用注入把"哪个沙箱"变成了函数参数，而不是全局变量。** 这是同一个架构下一个很小但不可让的选择差异。

**分歧二：Skill 放 Host 还是投影进沙箱。**
FastClaw 的 read 工具不走沙箱映射，所以 Skill 留在 Host 上就能读。我们相反：Pi adapter 以 `noTools: "builtin"` 运行、全部工具都被映射进沙箱，于是 Pi 的提示词让模型「用 `read` 工具去读 Skill 文件」时，那个 `read` 是沙箱内的。**留在 Host 上的 Skill 会读不到 —— 所以 Skill 必须作为只读投影进沙箱。**（ADR-0005 §4 明确记了这条与 FastClaw 相反的结论及其原因。）

这个分歧值得展开一句，因为它说明了一件普遍的事：**一旦你把工具的执行位置改了，所有"资源放在哪"的结论都要跟着重算。** 这不是偏好差异，是同一条约束的必然推论。

**分歧三：记忆是不是一等公民。**
FastClaw 有独立的 `memory_search` + 向量库这一层。我们目前没有 —— Agent 的身份与指令走 Agent File（SOUL/IDENTITY/MEMORY/USER 作为 markdown 文档），检索式长期记忆还没做。**这是真实的能力差距，建议在文章里如实承认**，比假装是设计取舍更可信。

### 2.5 对照表的补充行

建议在 part1 §2.4 的表里加一列 FastClaw：

| 维度 | FastClaw |
|---|---|
| 层次 | 完整 harness 框架（自托管，非托管服务） |
| Agent runtime | 自带 |
| 会话状态归属 | 你自己（db + kv + oss + 向量库） |
| 工作区持久化语义 | 惰性检查 + 关闭前上传对象存储 |
| 工具能力注入 | 共享注册表 |
| Skill 位置 | Host（read 工具不走沙箱） |
| 长期记忆 | 一等公民（向量库 + memory_search） |
| 分发形态 | 单二进制，无环境依赖 |

---

## 3. 如何实现

> 这一大节 part1 完全没写。以下是主体素材，按你提纲的五个子点组织。

### 3.0 建议的叙事策略：按"我们先选错了什么"来讲

这一节最好的写法不是"我们的架构是这样"，而是**按 ADR 的时间顺序讲一次真实的转向**：

- **ADR-0001**：调研完所有 runtime 的工具拦截能力，结论是只有 Agent-in-the-Sandbox 普适 —— 因为 Claude Code 做不到透明拦截。于是选了它，配套用 Pause/Resume 保存状态。
- **ADR-0002**：Pi 落地时改成 Sandbox-as-Tool，并且明确否掉了 Pause/Resume。
- **ADR-0005**：把两种模式真正共享的部分（沙箱生命周期）抽成 Sandbox Manager，并明确宣布扩展性预算只花在存储介质这一处接缝上。
- **ADR-0008**：Workspace 改成直接挂载 OSS，替代 ADR-0002/0005 的 hydrate、Baseline 和 Turn 边界同步；Skill 仍由 Supabase 提供只读投影。

**这个顺序本身就是文章的论证**：一个由"最弱 runtime 的能力"决定的架构决策，在换了主 runtime 之后必须重做。Flurry 那篇文章是在 2026 年 7 月才写出这个结论的（"industry is moving toward running agents outside of sandboxes for mature projects"），而我们是自己撞出来的 —— 这段经历比直接引用他的结论有价值得多。

### 3.1 Agent as Stateless Service

**核心命题：Adapter 是纯翻译器，Host 拥有全部基础设施。**

契约极简 —— `run(input): AsyncIterable<SessionEvent>`。Adapter 只做一件事：在事件流和某个具体 runtime 的 SDK 之间翻译。它不碰持久化、不碰消息、不碰沙箱生命周期、不碰产物存储。这些全在 Host（也就是 Server）里。

**一个容易被误解的点，值得单独写一段**：ADR-0002 里有一句关键的澄清 ——

> "Resident" 和 "coupled to infrastructure" 是两个正交的性质。Adapter 可以运行在一个常驻的 Host 进程里，同时仍然是一个纯粹的按调用翻译器。

也就是说，「无状态」不等于「短命」。Adapter 常驻在内存里没问题，只要它每次 `run()` 都不依赖上一次留下的东西。**无状态说的是"不携带跨调用的状态"，不是"进程要退出"。** 这个区分在文章里很值钱，因为很多人把 stateless 直接等同于 serverless / FaaS。

**它带来的四个具体好处**（每条都能对上代码里的一个事实）：

1. **换 runtime 不影响历史**。历史是 Host 的事件日志，Adapter 只是每轮从日志重建出该 runtime 认得的形状。
2. **改模型立即对存量会话生效**。因为每轮都从当前 Agent 配置解析模型、从日志重建历史，所以改 Agent 的模型对已存在的对话零成本生效（ADR-0003 §3 / issue #59）。这条是纯粹的架构红利 —— 如果历史存在 runtime 自己的 session 文件里，就得写迁移。
3. **多副本可以水平扩**。活跃 Turn 的状态（`sessionId → turnId + status`）放 Redis/Postgres，不放进程内存，所以断线重连落到哪个副本都对。
4. **Turn 边界是干净的**。ADR-0006 §2：SDK 消费者显式绑定扩展、prompt 前后成对、dispose 前发 `session_shutdown`。**目的是防止 MCP 连接、子进程 watcher、扩展状态活过一个 Turn。**

**事件日志的设计（这是本节最该展开的部分）**

`SessionEvent` 分四类，分类本身就是设计：

- **Lifecycle**：`session.status_running` / `status_idle` / `error`
- **Span**（可观测性）：`span.model_request_start` / `model_first_token` / `model_request_end`（带 usage）
- **Canonical**（持久）：`user.message`、`agent.message`、`agent.thinking`、`agent.tool_use`、`agent.tool_result`、`agent.mcp_tool_use/result`
- **Delta**（瞬态）：`agent.message_stream_start/chunk/end`、`agent.thinking_stream_*`

**Delta 与 Complete Event 的区分是整个设计里最关键的一条**，值得在文章里大写：

> **Delta** 是当前 Turn 运行期间发出的、瞬态的输出增量。它们构成的是**只属于这一个 Turn 的实时投影**：永不进入 Session 的持久历史，会被对应的 Complete Event 替换，如果 Turn 结束时对应的 Complete Event 没到，就直接丢弃。

具体机制：
- Delta 写进 Redis 的 `stream:turn:{turnId}`，Turn 结束时 `DEL` 回收，**永不落 Postgres**。
- 一个 Turn 的每个最终输出块各自保存为 Complete Event，用 `turnId + blockIndex` 与 Delta 对齐。
- **重连的补发在服务端做**：通过 `replay=1` 或 `Last-Event-ID` 开启后，Host 先从 Postgres 重放持久 Event，再追加活跃 Turn 的 Redis Delta，对前端呈现为一条 SSE 流。前端仍按持久事件序号去重，并按输出块替换 Delta。
- **前端的替换按 block 对齐**：保留当前 Turn 里每一个未完成的 Delta block，直到同 `turnId + blockIndex` 的 Complete Event 到达（或 Turn 结束）。后来的 block 绝不擦掉更早的未完成 block，且 Delta 与 Complete 两个投影共享同一个逻辑 UI 身份 —— 所以最终化的时候气泡不会重新挂载。

Anthropic 在同一个问题上给的接口是 `getEvents()`，允许 brain 按**位置切片**去审问上下文：

> The session functions as a durable context object living outside Claude's context window. The `getEvents()` interface allows the brain to interrogate context by selecting positional slices of the event stream, enabling flexible recovery from specific points without losing information.

以及他们对上下文管理的取舍陈述，值得原样引用：
> Rather than making irreversible decisions about which tokens to retain, the session provides recoverable context storage that harnesses can interrogate flexibly.

**建议的一句话结论**：会话不是聊天记录，是一个可寻址、可切片、可重放的持久上下文对象。压缩是可选的优化，不是必须的损失。

**踩过的两个真坑（强烈建议写进文章，这是最有说服力的部分）**

**坑一（issue #82）**：`SessionRouter.drainLoop` 调 `getEvents` 时忘了传 `opts`，结果只喂给 Adapter **最旧的 50 条事件**。表现是 Agent 莫名失忆 —— 而且是"记得很久以前，忘了刚刚"这种最反直觉的失忆。
→ 教益：**事件日志的重放路径必须有测试，因为它的错误形态是"看起来像模型变笨了"**。

**坑二（issue #95/#96）**：SSE backfill 的 `limit: 1000` 静默截断，导致重连后丢事件；配套修了前端 SSE 自动重连（`lastSeqRef` + 指数退避 + Last-Event-ID 续传）。
→ 教益：**任何 backfill 都必须翻页到 `hasMore === false`。带默认上限的读接口在正常量级下永远是对的，只在最需要它对的时候错。**

**坑三（Interrupt 的语义）**：这一组的设计精细度值得单独一段，见 §3.5「边界设定」。

### 3.2 Sandbox as Tool（本节是全文技术核心）

**先讲两种模式的定义**（用 ADR-0001 的原始表述）：

- **Agent in the Sandbox**：整个 adapter + agent CLI 跑在沙箱容器里。Agent 直接操作沙箱文件系统，**完全不知道自己被隔离了**。
- **Sandbox as Tool**：Agent 跑在本地/Host，它的工具调用（Bash、Read、Write）被拦截并代理到远端沙箱。

**再讲我们为什么先选了前者 —— 这段调研表是文章的高价值内容：**

| Runtime | 能否透明拦截工具执行？ |
|---|---|
| oh-my-pi (Pi Agent) | **能** —— 通过 Extension `registerTool` + `setActiveTools`，或 RPC `host_tools` |
| Claude Code | **不能** —— `PreToolUse` 钩子只能阻止/修改，不能替换执行 |
| Codex | **不能** —— 需要在 Rust 层实现 `ExecBackend` trait |

结论一句话（原文）：**由于 Claude Code（当时的主 adapter）无法支持透明的工具拦截，Agent-in-the-Sandbox 是唯一普适的模型。**

> **这段的写法建议**：这是一个教科书级的"能力最弱的依赖决定架构"案例。可以明确写出这条一般原则：**当你要支持 N 个异质 runtime 时，架构由能力最弱的那个决定 —— 除非你允许它们分叉。** 我们后来正是选择了允许分叉。

**然后讲转向：为什么 Pi 改成了 Sandbox-as-Tool。**

三个理由：
1. Pi 需要作为**常驻多用户服务**运行 —— 从持久化事件构建上下文、向前端流式推送、给工具调用一个真实文件系统且产物在 UI 里可见。
2. Pause/Resume **与 Workspace 共享模型冲突**。Pause/Resume 是 1:1 绑一个沙箱实例的模型；而我们要的是一个 Workspace 可以被多个 Session 并发绑定（1:N），且 S3 是权威存储。这两者不兼容 —— 所以 ADR-0002 明确否掉了 Pause/Resume。
3. 拦截必须发生在 Pi SDK 那一层，而那一层只有 Adapter 能碰。

**第 3 条的推论很有意思，值得展开**：因为拦截只能在 Adapter 里做，而 Adapter 又不允许碰基础设施，唯一的出路就是 —— **让 Adapter 接受一个抽象的执行器作为参数**。于是有了 `ToolExecutor`：

```ts
export interface ToolExecutor {
  exec(command: string[], opts?: ExecOptions): AsyncIterable<ExecOutputChunk>;
  readFile(path: string): Promise<string>;
  writeFile(path: string, content: string): Promise<void>;
  list(globOrDir?: string): Promise<FileListEntry[]>;
}
```

代码注释里的两句话就是这一节的论点：

> 所有路径都相对于 executor 自己的根来解释；实现**必须**不让路径逃出这个根。这里没有任何东西提到沙箱、S3、数据库或任何具体后端 —— **这就是重点**。

对照 Anthropic 的抽象，会发现两边独立收敛到了同一个形状：

> Tools operate via a standardized interface: `execute(name, input) → string`. This abstraction treats all execution environments uniformly—containers, custom tools, MCP servers, or external sandboxes—without distinguishing between them.

**这个收敛值得点出来**：一边是 Anthropic 的生产系统，一边是我们从"Adapter 不能碰基础设施"这条自定规则推出来的结果，形状一样。**说明这个接缝不是品味问题，是这个问题域的自然解。**

**Pi 工具的具体做法（一个很实际的技巧，值得写）**

我们没有手写任何工具 schema。而是用 Pi 自己的 `create*ToolDefinition(cwd, {operations})` 工厂，只实现把 fs/exec 重定向进沙箱的 `*Operations`：

```ts
createBashToolDefinition(SANDBOX_WORKSPACE_ROOT, { /* operations → executor */ })
createReadToolDefinition(SANDBOX_WORKSPACE_ROOT, { ... })
// write / edit / ls / find 同理；grep 因为 Pi 0.80.3 仍在 Host 上 spawn `rg`，
// 保留 Pi 的 schema/renderer 但整体替换 execute
```

配合 `createAgentSession({ customTools, noTools: "builtin" })` —— **`noTools: "builtin"` 关掉 Pi 自带的会打到 Host 磁盘的 fs/bash 工具**，保证模型能调的每一个工具都走那个按调用注入的 executor。

好处直接：**schema 由 Pi 原生保证，与原生工具字节级一致。** 我们只换执行，不换契约。这也意味着模型看到的工具名就是 `read`（而不是早期手写的 `read_file`）—— 模型的先验知识仍然有效。

> **可以引申的一句**：给 Agent 换执行后端的正确姿势，是替换实现而保留 schema。改了 schema 就等于改了模型的先验，你会为此付出无法归因的效果损失。

**Flurry 那篇的"正确架构"是同一件事的另一种说法**，可以引用：
> 当 harness 需要执行脚本、读写文件或在沙箱里做任何事时，它通过一个工具发起对沙箱的远程调用。**在 harness 运行的那台机器上，什么都不会执行。** 一切都作为工具调用进入沙箱。

他还预先回答了最常见的质疑：
> **在沙箱外跑 harness 不安全吗？** 不。工具实际上就是对沙箱的 API 调用。没有任何东西让 Agent 能在跑 harness 的机器上运行代码或触碰文件。

**最后：Anthropic 的 self-hosted sandbox 边界（part1 已提，此处可深化）**
编排仍在 Anthropic 侧，工具的输入输出**仍然流经 Anthropic 的控制平面** —— 因为模型必须看到结果才能决定下一步。Flurry 对此的定性很准：

> Anthropic's Managed Agents (hosted loop)：它验证了同一个拆分，只是 loop 跑在 Anthropic 的服务器上，而不是你的后端。

### 3.3 Agent runtime 选型

**这一节的核心不是"选哪个"，而是"选型这件事本身要付什么代价"。**

**三个 runtime 的实际形态：**

| Runtime | 模式 | 工具拦截 | 备注 |
|---|---|---|---|
| Pi (`@earendil-works/pi-coding-agent`) | Sandbox-as-Tool | Extension / `host_tools` / customTools | 主 runtime；SDK 而非 CLI 接入 |
| Claude Code | Agent-in-the-Sandbox | 只能拦不能替 | 保留 |
| Codex | Agent-in-the-Sandbox | 需改 Rust `ExecBackend` | 保留 |

**为什么最终选 Pi 作为主 runtime（可以直说的三条）：**

1. **它是唯一支持透明工具替换的**。这不是小优势 —— 它是"能不能把 Agent 挪到沙箱外"这个架构选择的**唯一前提**。Flurry 的 FAQ 也印证了这点：
   > Claude Code、Codex、OpenCode 原生不支持这个架构……**Pi 直接支持**：你可以把它的编码工具换成绑定到你的沙箱的工具。
2. **它以 SDK 而不是 CLI 接入**。这条被低估了：CLI 接入意味着你的拦截面只有进程边界（stdin/stdout/env/文件），SDK 接入意味着你能在对象层注入。`customTools` + `noTools: "builtin"` 这套做法在 CLI 形态下根本不存在。
3. **provider 层已经做了脏活**：跨 provider 归一化 tool call id（`transformMessages` / `normalizeToolCallId`）、丢弃跨 provider 不兼容的 thinking/signature、给孤儿 tool call 注入合成结果、以及压缩。ADR-0003 里写得很直接：喂扁平文本给它，**这些能力全部作废**。

**ADR-0003 是本节最好的素材，因为它记录了一次"抄近路然后还债"的完整过程：**

早期 Pi Adapter 把历史轮次压成一个文本 blob（`buildPromptWithHistory`）喂给 `session.prompt(...)`。两个后果：

1. **工具调用历史丢失**。文本压平只留 `user.message` 和 `agent.message`，丢掉 `agent.tool_use` / `agent.tool_result`。于是多轮对话里模型**看不到自己之前跑过什么工具、返回了什么** —— 只看到交换过的字句。
2. **provider 层能力全部旁路**。上面那三样脏活一件也用不上。

修法（这个方案本身很值得讲，因为它在两个约束之间找到了缝）：

- 每轮把事件日志转成 Pi 的 `AgentMessage[]`（`eventLogToAgentMessages`），保留结构：
  - `user.message` → `{ role: "user", content }`
  - `agent.message` + 同一轮的 `agent.tool_use` 块 → `{ role: "assistant", content: [text…, toolCall{id,name,input}], provider, api, model }`
  - `agent.tool_result` → `{ role: "toolResult", toolCallId, content, isError }`
- 用我们已经存在事件日志里的 `toolUseId` 作为 `toolCall.id` ↔ `toolResult.toolCallId` 的配对键。
- 每条 assistant 消息带上**产生它的那个** `provider`/`api`/`model`，这样 provider 层的 `isSameModel` 判断才准：**同模型的轮次 tool id 字节级不变（KV cache 前缀稳定），跨模型的轮次自动被归一化。**
- 每轮 `SessionManager.inMemory()`（`persist = false`）→ 用公开的 `appendMessage(...)` 回放 → `createAgentSession({ sessionManager })`。**磁盘上什么都不写，事件日志仍是唯一权威存储。**

**明确拒绝的两个替代方案**（这种"考虑过但否掉"的记录在文章里非常有说服力）：
- 旧的文本压平路径：丢结构 + 丢 provider 能力。
- 更底层的 `pi-ai` `stream(model, context)`：无状态且干净，**但会失去 Pi 内建的压缩能力**。

一句话总结这个取舍：**seed 一个内存 SessionManager，是同时保住"事件日志权威"和"保留压缩"的唯一位置。**

**一个特别精细的点（值得单独一段，因为它体现了"两层各自诚实"的设计）**

重建出的 assistant 消息必须带上记录下来的 `stopReason`，而**不能假装它完成了**。原因是这决定了 Pi 自己的转换层会怎么处理一个被打断的轮次：

- Pi 会**整条丢掉**一个半写完的 assistant 消息（它的立场是"模型应该从上一个有效状态重试"）。
- 而事件日志和前端**保留**它（用户停掉了 Agent，但仍然想看它走到了哪一步）。
- 因为 Pi 整条丢掉，那条 assistant 里被丢弃的 tool call 所对应的 tool result 也必须跟着丢 —— 否则会有一个 result 到达 provider 而前面没有对应的请求。

**这是一个刻意的两层分歧**：给模型看的历史和给人看的历史，本来就不该是同一份。缺失的 `stopReason` 视为已完成，所以老事件和不上报 stopReason 的 runtime 都不受影响。

> **可以提炼的观点**："历史"至少有两个不同的消费者 —— 模型和人。它们对"半截的输出"要求正好相反。把这两者混成一份数据，是很多 Agent 产品在 Interrupt 功能上出问题的根因。

**KV cache 的诚实结论**（值得写，因为很多人对此有幻想）：tool id 在同一模型内跨轮往返不变，所以前缀稳定；但 provider 变了、或压缩重写了前缀，**必然 miss** —— 这两者都不可避免，且与 id 处理无关。

### 3.4 存储选型

**当前介质与角色**（我们的实际选择，可与艾逗笔那张表对照）：

| 介质 | 存什么 | 权威性 |
|---|---|---|
| **PostgreSQL** | 事件日志 + 完整消息 + 控制平面（Agent、Session、Skill、User、API key、Workspace 元数据）；**以及待执行输入队列** | **权威** |
| **Redis** | 只承载瞬态流量：per-Turn delta 流（`stream:turn:{turnId}`，Turn 结束即回收）+ 活跃 Turn 映射 | 瞬态 |
| **OSS**（沙箱直接挂载，Host 独立访问） | Workspace 文件 | **Workspace 的权威** |
| **Supabase Storage** | Skill 内容 | **Skill 文件的权威** |
| ~~MongoDB~~ | —— | 已退役 |

**三条值得写进文章的判断：**

**① Delta 永不落库，是一条纪律而不是优化。**
如果 delta 落了库，你就得回答"重放历史时要不要重放 delta"，而这个问题没有好答案。让它物理上不存在，问题就消失了。这类"把不该有的状态设计成不可能存在"的做法，在架构里比"约定不要用"可靠得多。

**② 待执行输入的权威存储从 Redis 迁到了 Postgres，原因很具体。**
代码注释写得很清楚：

> 遗留的 Redis 待执行输入队列保留用于兼容/测试。**生产使用 PostgreSQL 作为权威 pending store，这样 claim + generation fencing 在多个 Host 之间是原子的。** 这个实现镜像了同样的 API 语义，但**绝不可用于多 Host 执行**。

→ 这是一个很好的例子：**Redis 能表达这个队列的形状，但不能表达它需要的原子性。** 选型不是选"够不够快"，是选"能不能表达你需要的不变量"。多副本 + 租约 + fencing token，这套东西你会想要事务。

**③ Workspace 的权威在 OSS，沙箱是可丢弃的。**
当前 ADR-0008 中，沙箱直接把 Session 绑定的 OSS 前缀挂载到 `/home/user/workspace`，Host 文件 API 访问同一前缀。成功写入并关闭会独立保存一个文件；失败、Interrupt 和终止 Session 均保留已保存的文件。多个 Session 可以共用一个 Workspace，文件可能互相覆盖；没有 Turn 事务或自动回滚。HOME `/home/user`、依赖和缓存留在沙箱本地，重建后可能需要重新安装。

**历史方案：双向同步的三个难点。**

> 以下至 §3.5 之前记录的是 ADR-0002/0005 的旧机制，供解释架构演进，已由 ADR-0008 替代。当前实现没有 hydrate、mtime/hash/Baseline 扫描、检查点上传或新的 `workspace.file_change` 同步通知；Turn 结束时控制台重新读取 OSS 文件列表。下文的同步失败与数据丢失窗口仅适用于旧方案。

**难点一：怎么只传变化的文件？**
内容哈希是变更的最终裁判。但每轮全量读+哈希整个 `/home/user` 太贵，所以加了一层 size+mtime 预过滤。**这个预过滤的正确性论证很漂亮，值得原样复述：**

> 预过滤的可靠性只依赖一条不变量：**一次写入必须推进文件的 mtime。** 有了这条，一个 size 和 mtime 都仍然匹配的文件就不可能变过，跳过它的读+哈希一定安全。**预过滤永远不"判定"一个文件变了 —— size/mtime 的差异只是强制去做哈希，而内容哈希始终是变更的最终裁判。** 它唯一的职责是在什么都没动时省下工作。

当时的生产实现细节：e2b 后端用 `find -printf '%T@'` 读 mtime，`%T@` 是**分数秒**（GNU find 在现代文件系统上给到纳秒），我们保留为 `Math.round(sec * 1000)` 毫秒 —— **所以同一个 wall-clock 秒内的等长编辑仍然会显示更新的 mtime，不会被跳过。**

残留边界也如实记着：mtime 粒度粗（比如整秒）的文件系统**可能**对一个 granularity tick 内的等长编辑报出相同 mtime。所以内容哈希才是裁判 —— 预过滤是叠在上面的纯优化，如果哪天某个后端的 mtime 被证明太粗，正确的反应是**让预过滤更保守（只在确定时跳过）**，而不是去信任它作为唯一信号。

> **这段可以作为"自己写的价值"的最佳例证**：这类论证在平台的配置项里是不存在的。你要么接受平台的语义，要么自己拥有这个论证。

**难点二：怎么区分"用户删了它"和"另一个并发会话刚创建了它"？**
答案是 **Baseline**（基线）：沙箱 hydrate 时捕获的 workspace 路径快照 —— 「我进来时看到的世界」。

**Sync 只从 Workspace Store 里删除那些"在基线里、但现在不见了"的路径。** 所以一个并发 Session 新加的文件永远不会被删掉 —— 它不在我的基线里，我就无权删它。

三个配套性质：
- 基线是**per-sandbox-instance** 的，每次 hydrate（包括 rebuild）都刷新。
- 基线是 **Workspace Store 的私有概念**，藏在不透明的 `HydrationSession` 句柄里（`{ readonly __brand: "hydration-session" }`）—— 调用方和 Sandbox Manager 都读不到它。介质定义它，换一个介质可以完全没有基线。
- 代价如实承认：一个并发 Session 做的删除，**在下次 hydrate 之前我看不到**（有意为之的最终一致性）。

> **可以提炼的一般原则**：分布式删除的正确形态不是"删掉不存在的东西"，而是"只删我曾见过、现已消失的东西"。把删除的权限锚定在观察上，而不是锚定在当前状态上。

**难点三：什么时候同步？**
Sync 属于 Workspace，不属于 Session/Turn。触发点是**沙箱生命周期检查点**：Turn 结束保留为一个便宜的安全点，Manager 在 dispose/rebuild 前也会 sync。`workspace.file_change` 是一个幂等的"现在刷新"脉冲，只发给触发那个 Session 的流 —— **不需要跨实例注册表，因为 S3 是权威的，而前端在 Turn 结束时还有一次兜底重取。**

> 这里有个很实用的设计模式：**当权威存储可以被直接查询时，通知就可以退化成一个不携带信息的"脉冲"。** 脉冲是幂等的、可丢失的、不需要顺序的 —— 于是分发它不需要任何基础设施。

**已知代价（如实列出，比藏起来可信）**：沙箱如果在 hydrate 和 sync 之间被 gateway 回收，那一轮未同步的文件就丢了。这是 S3 权威 + 沙箱可丢弃模型下已知的最终一致性成本。

### 3.5 边界设定

**这一节我建议作为整篇文章的收尾重点**，因为它最能体现"自己写"到底买到了什么 —— 买到的是**可以自己划边界的权力**。有五道边界，每一道都是一个明确的、写下来的决定。

#### 边界一：Adapter | Host —— 唯一的接缝是 ToolExecutor

规则：Adapter 是纯翻译器，`ToolExecutor` 是它与全部基础设施之间的唯一通道，按调用注入。

**但 ADR-0006 记录了这条规则的一次诚实破例，这个破例值得写**：三个 Pi 扩展（`pi-web-access` 公网检索、`pi-mcp-adapter` 连远端 MCP、`@tintinweb/pi-subagents` 起子会话）在 **Host 进程里**执行，由 Pi 的 `DefaultResourceLoader` 发现。ADR 的原话是：

> 假装它们经过 `ToolExecutor` 会**隐藏一次真实的信任边界变化**。

于是选择把它明确记为「一个显式的、受管的例外」，并配上具体管控：
- 只允许版本钉死的白名单；**用户不能通过 Agent 定义安装任意 Host 扩展**，加一个扩展需要改代码+改部署+更新威胁模型。
- Web 访问是只读公网检索，不接收任何 per-Agent 密钥配置。
- MCP 通过 **`GET /v1/mcp-catalog` 查询当前 Tenant 可用的受管目录**；Agent 的 `mcpServers` 只接受 `catalogId`、`name` 和可选 `description`。URL、命令、header 和环境变量由 Host 解析，不能通过 Agent API 提交。目录包含 `rds-mcp`，特定 Tenant 还可获得 `aliyun-rds-supabase`；实际可用项以目录响应为准。**真凭据只存在于 Host 环境里。**
- 子 Agent 拿到的是父 Agent 那**同一套七个 custom ToolDefinition**，闭包在同一个 per-Turn `ToolExecutor` 上 —— 所以父子读写同一个沙箱，**谁都不碰 Host 文件**。

> **这是我最推荐写进文章的一段。** 因为它示范了一个成熟系统该怎么对待自己的规则：**不是假装没有例外，而是把例外的边界、管控和代价都写下来。** 「`ToolExecutor` 仍然是唯一的 Workspace/Sandbox 边界，但它不再声称自己中介了无关的 Host web/MCP 网络工具」—— 这种精确的收缩比一句漂亮的绝对化规则有价值得多。

#### 边界二：Workspace（持久文件）| Read-only Projection（只读内容）

两种沙箱内容，靠**一个轴**区分：是否属于用户的持久工作文件。

| | Workspace | Read-only Projection |
|---|---|---|
| 访问 | 直接挂载 OSS，Host 访问同一前缀 | 从来源物化到沙箱，只向下 |
| 位置 | `/home/user/workspace` | **必须在 Workspace 之外**；已装备的 Skill 位于 `/skills/<skill-name>` |
| 内容 | 用户上传、Agent 产出 | 当前主要是已装备的 Skill |
| 持久化 | 成功写入并关闭后保存到 OSS | 不写回 Workspace 或来源 |

**为什么投影的目标路径必须在 Workspace 之外**：Workspace 是直接挂载的持久文件树，Skill 是由 Host 管理并刷新的一份外部内容。把投影写进 Workspace 会把它变成用户产物，混淆所有权和保存语义。ADR-0008 因此禁止投影目标与 Workspace 相交。

Skill 的内容流向也是一条边界：**Router 向 Sandbox Manager 提供 Tenant 和 Skill 坐标；Manager 的 `S3ProvisionSource` 从 Supabase 读取文件，再写入沙箱的只读投影目录。** Router 自己只查 `skillArtifactStore` 确认 Skill 非空；实际内容由 Provision Source 物化，不能把这个调用边界误写成沙箱直接访问存储的网络拓扑。

#### 边界三：Tenant —— 一切的隔离边界

Tenant 拥有一切：Agent、Session、Skill、API key。两种凭据都解析到同一个 `tenantId`：
- `x-api-key`（给机器）
- `Authorization: Bearer`（给人，登录会话 token）

User 与 Tenant 在注册时一对一创建。**Agent File 是 Agent 作用域而不是 Session 作用域**：一个 Agent 的所有 Session 看到同一份 Files，而**一个 Agent 永远读不到另一个的 Files**。

#### 边界四：Interrupt —— 一次对语义精度的练习

这一组的设计非常细，我建议在文章里完整讲一遍，因为它是"领域语言写清楚了能省多少 bug"的最好例证。

**Interrupt 的定义**（CONTEXT.md 原文）：
> 用户要求 Session 当前运行的 Turn **立刻停止**。Interrupt **只针对那一个 Turn**：用户已经排队的输入之后仍然会执行，Session 保持可用。**它是一个关于现在的请求，不是对过去的修改** —— Agent 已经产出的东西仍然是 Session 历史的一部分。

由此推出的四条：

1. **Interrupted Turn 的输出保留，并按它被留下的样子展示** —— 让人看得出是被截断的，而不是把它当成一个完成的答案。理由：**停掉 Agent 的用户，仍然想看它走到了哪一步。**
2. 但半成品**不被当作 Agent 认可的工作**：下一个 Turn 从 Agent 真正完成的最后一点继续。
3. **Queued Input 是持久的服务端状态，不是客户端的乐观猜测**。它活过刷新，也活过它到达时正在运行的那个 Turn —— **这正是"Interrupt 结束一个 Turn，而它后面排队的输入仍会运行"的原因。**
4. **一个输入要么在排队，要么在执行，绝不同时**。因为 Turn 一旦 claim 了它，就把它提升成了 Session 历史里的一条 user message。

还有一条关于**诚实**的实现细节（issue #113），很值得写：`interrupt(sessionId)` 返回**是否真的中止了一个 Turn**。活跃 Turn 的 controller 是 per-process 的，所以一个指向另一个副本上的 Turn 的 interrupt **返回 false，而不是默默声称成功**。

> **可提炼的观点**：分布式系统里"我做到了"和"我没做到"必须可区分。一个总是返回成功的 stop 按钮，比一个会说"我停不了"的按钮更糟 —— 因为用户会基于它做下一步决定。

#### 边界五：扩展性预算 —— 明确宣布"哪里不留接缝"

ADR-0005 §2 是我见过最克制的扩展性声明，值得原样引用其结构。下面保留当时的三层设计；其 Workspace 介质与 Baseline 接缝已被 ADR-0008 的直接 OSS 挂载替代，不能作为当前接口描述。三层，三种**刻意不对称**的立场：

| 层 | 立场 | 理由 |
|---|---|---|
| **Workspace Store（介质）** | **保留深接缝** | S3 是今天唯一实现，但介质**一定会**变（持久卷、镜像快照、沙箱内 sidecar）。这是真实的未来，所以现在就建接缝。 |
| **Sandbox Manager（生命周期）** | 两种模式共享 | Tool 模式和 Agent 模式都要 provision 和 reclaim 沙箱 —— 这是**真实的**两个消费者。 |
| **fs/exec 原语 + Pi 工具** | **硬绑 Pi，零预留** | "第二个非 Pi 的工具消费者"是假想的。 |

那条判据本身就是可以引用的格言：

> **一个消费者是假想的接缝，两个才是真实的接缝。**（one consumer is a hypothetical seam, two is a real one）

于是明确写下了一条给未来评审的指令：

> 未来的架构评审**不应**再建议抽出一个中立/可复用的工具包：那个接缝是刻意假想的。只有当真的存在第二个非 Pi 消费者时才重新考虑。

> **这段的价值在于它是反直觉的。** 大部分架构文档只说"我们在这里留了扩展点"，很少有文档明确写"我们在这里**故意不留**扩展点，理由如下，请不要再提"。而后者才是真正防止架构腐化的东西 —— 因为架构腐化的主要来源不是缺少抽象，是抽象过早。

**同类的克制还有一处**：`list`/`reclaim` 在 Manager 接口上**预留了但没实现主动清扫**。理由是崩溃遗留的沙箱有约 1 小时 TTL 兜底，而**目前没有证据表明孤儿沙箱的成本在痛**。没有痛就不建机制。

#### （可选）边界六：Skill 的 fork 语义

装备（Equip）一个 Library Skill 到 Agent 上，做的是**快照复制**而不是引用。这也是一道边界：库和 fork 在 equip 之后彼此独立。

促成这个决定的是一个真实 bug（2026-07-06 E2E 报告）：按引用装备时，删掉一个 Library Skill 会在 `Agent.skills` 里留下**悬空引用**，而物化流程会静默跳过缺失的 id —— 于是 **Agent 以为自己装备了一个 Skill，而运行时行为完全忽略它。** 报告里观察到的就是一个引用 `skill_JWy7c…` 而该行已不存在的 Agent。

fork 之后这类 bug **结构性地消失了**。代价也明确：库的后续修改**不会**传到已装备的 Agent。重复装备会返回已有 fork；要从库拉取新快照，先卸载已有 fork，再重新装备 —— 这是拿"保持同步"去换"能安全地隔离编辑"。

考虑过并否掉的：copy-on-write（给每条读路径和物化路径都加一个"有没有 fork 过？"状态，比产品需要的复杂）、以及引用+Agent 页只读（回避了 fork，但违背"Agent 页可编辑且不影响 Library"的需求）。

> **可提炼的观点**：一个"静默跳过"的错误处理，会把配置错误变成行为错误 —— 而后者的排查成本高一个数量级。fork 的真正收益不是"能编辑"，是让那一整类 bug 无法被表达。

---

## 4. 如何使用

> 这一节需要你决定写多深。以下按"接口 → 场景 → 部署"给素材。

### 4.1 API 表面（常用端点）

下面路径相对于 API 基址：线上为 `https://agentry.welltop.tech/api`，本地默认是 `http://localhost:3000`。除健康检查外，以下接口需要 `x-api-key` 或登录得到的 Bearer token。完整接口清单以 `docs/openapi.json` 为准；已部署版本可查 `https://agentry.welltop.tech/api/openapi.json`：

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

**三个值得指出的设计**：

1. **`GET /v1/sessions/{id}/events` 一个端点同时提供 JSON 和 SSE。** 同一份事件日志，两种投影：拉快照 vs 订阅流。这直接来自"会话是可寻址、可切片的持久对象"这个模型 —— 如果历史存在 runtime 的 session 文件里，这两件事就得是两套代码。

2. **`GET /v1/sessions/{id}/pending` 存在，本身就是一个立场。** 排队输入是**服务端状态**，所以它必须可查询。如果它是前端的乐观猜测，就不会有这个端点 —— 刷新一次就没了（这正是 issue #114 修的东西）。**一个端点的存在或不存在，是在回答"这个状态归谁"。**

3. **Workspace 的文件接口已收录在 OpenAPI**：`/v1/workspaces/{id}/files` 提供列表，其下还有读取、写入、删除、重命名和上传接口；`/workspace/preview-url?path=...&expiresIn=600` 返回短期 OSS 签名 GET 链接（60–900 秒，默认 600 秒）。Host 和沙箱访问同一个 OSS 前缀，因此 `/home/user/workspace` 下由 shell 成功写入并关闭的文件也能列出。文件接口直接使用 Workspace ID，无需先创建 Session；运行中的 Session 不阻止文件写入，同一路径的并发写入可能互相覆盖。

### 4.2 三条典型用法（对应 part1 §1.2 的"被系统调用"）

part1 已经论证了"从被人使用变成被系统调用"是最大的业务杠杆。这里给它落地：

**用法一：人在控制台里用（Agent-centric console）**
入口是 Agent 而不是会话列表 —— 这是刻意的信息架构选择：**你先选"跟谁工作"，再选"哪次工作"。** Session 列在 Agent 内部。Skill Library 与 Agent 列表同一个入口页，装备在具体 Agent 页上做。

**用法二：机器调用（`x-api-key`）**
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

**用法三：断线重连（这是最能体现架构价值的用法）**
拿着 `Last-Event-ID` 重连 `GET /v1/sessions/{id}/events`，服务端**翻页 backfill 到 `hasMore === false`**，补齐断点之后的全部事件，然后接上活跃 Turn 的 Redis delta，呈现为一条连续的流。前端做指数退避自动重连。

→ **这条值得写，因为它是"状态所有权在我们这边"的直接兑现。** 如果事件日志在别人的服务端，这套重连语义就是你去适配别人的，而不是你定义的。

### 4.3 部署形态（可选，看文章长度）

线上跑在阿里云上海的 `agent-platform` ACS 集群，两个 Deployment（`oma-server` / `oma-web`）+
各自 Service，通过 ALB Ingress 统一暴露在 `https://agentry.welltop.tech`，API 基址是
`https://agentry.welltop.tech/api`。依赖：PostgreSQL（Supabase）、Redis、Workspace 专用 OSS、
Skill 使用的 Supabase Storage，以及 `sandbox-system` 中默认的 ACK Agent Sandbox
`auto-story` 暖池（**通过 E2B 兼容 SDK 接入**，配 `E2B_DOMAIN` + `E2B_API_KEY`）。

健康检查访问 `/api/health` 并确认 JSON `{"status":"ok"}`；不带 `/api` 的 `/health` 和
`/openapi.json` 会返回 `200` HTML 控制台，不能据此判断 API 健康或读取到了接口定义。

**沙箱底座选阿里云 ACK Agent Sandbox 的理由，正好呼应 part1 "自研不等于全部自己写"：**

| 它提供的 | 数字 |
|---|---|
| 隔离级别 | MicroVM 级隔离，计算/网络/存储端到端隔离 |
| 弹性 | 每分钟最高 15K 沙箱 |
| 休眠/唤醒 | 内存级休眠 + 状态保留，**1s~10s 快速唤醒** |
| 冷启动 | 镜像缓存加速做到秒级镜像就绪（拉取时间降低 90%+）；配合预热池支持**百毫秒级**快速创建 |
| 接入 | **E2B 兼容 SDK**（推荐），复用既有 E2B 调用方式，迁移成本最小 |
| 声明式管理 | Sandbox CR（CRD）管理沙箱模板、运行参数、生命周期 |
| 存储 | 运行中沙箱含 30 GiB 免费临时存储；休眠沙箱无免费额度 |

**E2B 兼容这一条是选型的决定性因素**，值得说明白：它意味着我们的 `SandboxClient` 端口写一份就能同时对着 E2B 和 ACK，本地开发用 `FakeSandboxClient`，测试不需要真沙箱。**"兼容一个既有 SDK"对基础设施产品来说，是比任何独家能力更强的卖点。**

有意思的是我们**没有用**它的休眠/唤醒能力（ADR-0002 明确否掉 Pause/Resume）—— 因为 1s~10s 唤醒解决的是"沙箱是宠物"模式下的成本问题，而我们选的是"沙箱可丢弃、OSS 权威"。**平台的一个亮点能力，在另一种架构下是不需要的。** 这个例子很能说明"买底座也要知道自己在买什么"。

### 4.4 一个真实的运维教训（如果文章需要"血泪"素材）

线上 Agent 全线不回复过一次，根因不在架构 —— 是 runtime 的 OAuth token 过期，导致 `model_request` 变成 0-token 空转。**没有报错，只是不说话。**

→ 可以引出一个不错的收尾观点：**云端 Agent 的失败模式大多是"静默的"。** 不像本地报个栈就完事，云上的链条（凭据 → 模型 → 沙箱 → 存储）每一环都可能安静地退化成"什么也没发生"。所以 `span.model_request_start` / `model_first_token` / `model_request_end`（带 usage）这类可观测性事件不是锦上添花 —— **它们是唯一能区分"模型在想"和"什么都没在发生"的东西。**

这也正好回到 Flurry 的理由一：**如果沙箱死了，它无法上报自己的死亡。故障检测必须从你自己的后端发出。**

---

## 5. 备选标题 / 结构建议

**如果拆成三篇：**
- 一：为什么需要云端 Agent，以及为什么自己写（现有 part1 + §1、§2 补充）
- 二：Agent as Stateless Service + Sandbox as Tool（§3.0–3.3）
- 三：存储、边界与使用（§3.4–3.5、§4）

**如果合成一篇长文**，建议的骨架：
1. 引子：Anthropic 的 dead weight 论 —— harness 把模型假设硬编码了（§1.1）
2. 问题：本地做不到什么（现有 part1 §1.1）+ Flurry 的三个理由（§1.3）
3. 框架：存算分离（§1.4，注明借自艾逗笔）
4. 买还是造：四家的固定假设（part1 §2 + §2.4 FastClaw）
5. 转向：Agent-in-Sandbox → Sandbox-as-Tool 的真实过程（§3.0–3.2）—— **全文重心**
6. 选型的代价：runtime、存储（§3.3–3.4）
7. 五道边界（§3.5）—— **全文收尾重心**
8. 怎么用（§4）

**几个可用的标题方向：**
- 《云端 Agent：把无状态的执行体和有状态的任务分开》
- 《Agent 该跑在沙箱里，还是沙箱外？—— 一次架构转向的完整记录》
- 《一个消费者是假想的接缝，两个才是真实的接缝》（用 ADR-0005 那句格言当标题，很挑人但很准）

---

## 附：可直接引用的句子清单

**Anthropic**
- harness 编码了会过期的模型能力假设，模型变强后它们变成 dead weight。
- 操作系统类比：虚拟化成足够通用的抽象，以容纳"尚未被想到的程序"。
- Brain（Claude + harness）/ Hands（沙箱与工具）/ Session（append-only 事件日志）三分，各自可独立失败或被替换。
- 单容器设计造出了一个 "pet" 基础设施问题：容器失败意味着丢掉整个会话。
- 解耦让 TTFT p50 降约 60%、p95 降超 90%（把容器供给推迟到真正需要时）。
- 把沙箱与凭据存储分开，可以防止 prompt injection 拿到认证 token。
- 与其对"保留哪些 token"做不可逆的决定，不如提供可恢复的上下文存储，让 harness 灵活地去审问它。

**Nathan Flurry**
- 沙箱是为运行不受信代码而生的，不是为托管 Agent 本身。
- 如果某个东西在沙箱里可访问，就应当假设这份数据或这个 API 会被滥用和泄露。
- 编码 Agent 被训练成会绕过障碍，所以在沙箱里执行的权限，是 Agent 大概能绕过的权限。
- 在 harness 运行的那台机器上，什么都不会执行。
- 无状态服务器和工作流引擎失败于同一个原因：Agent 是一个长生命周期的有状态负载，而两者都不是为此而建的。
- Agent 的主循环永远运行，而工作流引擎从来不是为永不结束的循环设计的。

**艾逗笔 / FastClaw**
- `fn(query, agent runtime) = artifacts`
- 什么需要存：提示词文件、工具和技能、对话记录、交付产物；什么需要算：上下文拼接、LLM 调用、工具调用。
- 每个 Pod 常驻的方案隔离性很好，不好的地方在于运行成本很高，难以规模化。
- 通过存算分离的架构，让 Agent 无需常驻，而是在收到请求时动态挂载 sandbox 来提供服务。
- 这套架构最大的挑战在于分布式多副本场景下的数据一致性。

**本项目（CONTEXT.md / ADR）**
- Delta 是当前 Turn 的实时投影，永不进入持久历史；Turn 结束时没有对应 Complete Event 就丢弃。
- Interrupt 是一个关于现在的请求，不是对过去的修改。
- 停掉 Agent 的用户，仍然想看它走到了哪一步。
- 一个输入要么在排队，要么在执行，绝不同时。
- 历史方案（ADR-0005，已由 ADR-0008 替代）：Baseline 是"我进来时看到的世界"；只删我曾见过、现已消失的东西。
- 历史方案（ADR-0002/0005，已由 ADR-0008 替代）：预过滤永远不"判定"一个文件变了 —— 内容哈希始终是最终裁判。
- 一个消费者是假想的接缝，两个才是真实的接缝。
- 假装它们经过 ToolExecutor，会隐藏一次真实的信任边界变化。
