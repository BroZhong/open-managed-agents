# Environments 独立复审与 oma-test 回归 — 2026-10-26

**结论：正常执行与配置热更新路径通过；仍有 4 个新增 P2 缺陷，建议修复后再发布。** 另有 1 个已在旧版本复现的 Redis 故障下 Interrupt 缺陷。不能据本次测试宣称所有生产 Session 均无问题。

本次按用户最后指示验证最新源码 `0e1654082d8700aa7c35623d6d1df95f23e4ed89`，审查基点 `b88d77c1`。机器证据见 [JSON](environments-review-regression-oma-test-2026-10-26.json)。所有时间明确标注；测试发生于北京时间 2026-10-26 中午。

## 版本、部署与隔离

| 项目 | 本次实际版本 |
|---|---|
| 原交接源码 | `d90942ef`；运行代码 `d4953e20` |
| 最新源码 | `0e165408`，仅删除 video-production 的离线 Whisper，另改文档和定义测试；API/Runner/Store/Adapter/Web/CLI 源码与交接版一致 |
| 并发观察时 API / Runner | `oma-server@sha256:3fbff8c3fa6a2e668a1f78b71d1f472f1486cf0f205bd0c7f720316fb9316566` |
| 最新 builder；观察结束后 API / Runner 也完成滚动 | `oma-server@sha256:03081cae4cb0b710afa9a80f510128a14db5a279480c61a8d91aa1af4e77ed73` |
| Web（无变更） | `oma-web@sha256:46c363546a121bb75b612ba2a0a33249a03964d9f929838215df29c0b3119f8d` |
| 最新 video-production | `oma-environments@sha256:490544134a0313d850ad29eb56ad516a13efd9a23dd469706e3a3a6534fdd111` |
| 已有自定义媒体 Environment 对照 | `env_VnioXyHxyuHUwS2FCCeYx`，镜像 `9d65087f…`，只读使用其已有配置 |

另一项发布在测试准备期间先更新 builder，随后在并发取消后更新 API/Runner。本任务没有执行部署、扩容、故障重启或生产配置修改。比对了新 builder 的 `init.sh` 以及 Environment Service / PostgreSQL Store 源码哈希，确认与最新源码一致；4 个问题均仍适用。不能把本次并发称为全部角色均运行新 digest 的压力测试：它覆盖的是相同的 API/Runner 代码及最新内置镜像，全部角色滚动完成后另补了真实工具回归。

只在 `oma-test` / `oma_test` 新建测试资源，使用显式 `~/.kube/agent-platform-config`。生产只读查询 Agent 使用统计、读取必要输入作为复制源；未运行生产 Session、未修改生产数据。首尾生产 Deployment 镜像与 generation 一致。

生产最近 14 天的主要样本是 FreeCanvas（deepseek-flash，有 Sandbox，6471 个 Session）和 GB-015 Main Agent（自定义 GPT provider，无 Sandbox，686 个 Session）。本次使用测试租户的 FreeCanvas 副本及其 19 个 Skills，另测无 Sandbox 路径。没有复制生产自定义 provider 凭据，所以不覆盖全部 provider、Agent 私有提示和所有历史会话。

## Code review：Standards

### [P2] Environment 与 build 的行锁顺序相反，编辑可遇到死锁

位置：`server/packages/store/src/postgres/environment-store.ts:234–236`；同类路径包括 `delete`、`rebuild`，反向路径为 `claimBuild:301–323` 和 `finish:443–451`。

`update` 先锁 Environment，再锁其活动 build；`claimBuild` / `finish` 先锁 build，再锁 Environment。构建领取或完成恰与脚本编辑、重建、删除重叠时，PostgreSQL 会中止一个事务。编辑可能返回未处理的 500；若构建完成事务失败，已经产出的镜像可能要等 lease 过期后再次执行构建。

用真实 `PgEnvironmentStore` 与独立本地 PostgreSQL schema 控制两条请求的交错，稳定得到：`update → 40P01: deadlock detected`，同时 `claim → success`。这属于 ADR-0024 构建事务与 supersession 的正确性问题，不是风格建议。应统一所有相关路径的加锁顺序，保留既有 lease/attempt 校验。

复现源：`/tmp/oma-env-lock-review.mts`；详细记录：`/tmp/oma-env-standards-review.md`。

## Code review：Spec

### [P2] 并发普通变量编辑可恢复已轮换掉的旧密钥

位置：`server/packages/api/src/lib/environments.ts:265–275`，尤其第 272 行，保留密钥分支第 413–417 行。

Service 在 Store 事务外读取旧 `encryptedSecrets`。请求 A 修改普通变量并省略密钥值，暂停于旧快照之后；请求 B 轮换密钥并成功返回；A 随后把旧 ciphertext 一并写回。A 并未要求修改密钥，后续命令却再次得到已废弃凭据。违反“省略值保留当前密钥”和“下一条命令生效”的约定。

真实 Service / SecretBox / Resolver 的确定性交错结果：`rotatedInitially=true, reverted=true`。应在同一行锁内保留省略的密钥，或提交密钥 delta，或通过版本校验拒绝陈旧更新。

### [P2] Environment 删除与 Agent 绑定不是原子操作

位置：`server/packages/api/src/lib/environments.ts:320–325`；相应 Agent 校验与写入间隙位于 `routes/agents.ts:125–127,255–258`。

删除先单独查询 `inUse`，再删除；另一请求可在两步之间成功绑定。真实 Host HTTP 路由复现：创建 Agent **201**，删除 Environment **200**，随后查询 Environment **404**，Agent 仍引用该 Environment。会话仍可沿用被软删除的配置，但用户无法再通过 API 修改变量或重建它。违反 ADR-0024“有 Agent 引用时删除返回 409”。

应让绑定、fork/更新绑定与删除使用一致的 Environment 锁，在事务内完成引用检查与写入。

### [P2] 合法的特殊密钥名被接受，却没有保存密文

位置：`server/packages/api/src/lib/environments.ts:403–405`；运行时解析第 133–135 行。

`key in encryptedSecrets` 把原型上的 `constructor`、`toString`、`__proto__` 当作已存在的密钥，跳过保存。真实认证 HTTP API 对三个名称均返回 201，密文 own keys 为空；Resolver 随后报 `ERR_INVALID_ARG_TYPE`，导致该 Environment 的命令无法执行。

**测试服也复现了 `constructor`：更新成功，但数据库 secrets own keys 为空。** 验证后立即把本次新建 Environment B 恢复成原配置。

应使用无原型字典或 Map，并在读取、保留、复制和解析时使用 own-property 校验。仅把 `in` 换为 `Object.hasOwn` 不足以解决普通对象的 `__proto__` setter。测试应覆盖 create、保留、轮换、复制及运行时解密。

上述 Spec 复现源：`/tmp/oma-env-spec-repro.ts`、`/tmp/oma-env-delete-race.ts`、`/tmp/oma-env-prototype-api.ts`；详细记录：`/tmp/oma-env-spec-review.md`。未发现额外 scope creep。Standards 1 项、Spec 3 项，均 P2。

## 测试服顺序回归

新建两个 `oma-base` Environment，独立 Agent、Workspace、Session；密钥采用随机 canary，只输出哈希或 presence 布尔值。

| 检查 | 结果与证据 |
|---|---|
| 首次 Sandbox 执行 | 正确读到 v1 普通变量和密钥哈希；以真实 Pi/bash 执行 |
| 同一 Sandbox 普通变量、密钥轮换 | 更新于 12:41:47，约 4 秒后下一条命令读到 v2、新哈希及 profile override；Sandbox ID 相同 |
| 删除密钥 | 下一条命令 `secret_present=false`，普通变量为 v3 |
| 环境变量编辑不重建 | `lastBuild.id` 与 image 保持不变 |
| Session 冻结、Agent 修改 | 原 Session 继续使用 A；新 Session 使用 Agent 新绑定 B |
| Session 显式 override | `environment_id` 覆盖为 A，实际命令也读取 A 的变量 |
| 无 Sandbox | 正常完成对话，environment 为 null |
| Loop | 禁用周期调度，仅手动触发；创建时采用 Agent 当时的 B，实际命令匹配 |
| Interrupt + Queued Input | 活跃长 bash 被中断；已排队输入继续执行；后续新输入仍正常完成 |
| API 边界 | 被 Agent 使用的 Environment 删除 409；平台内置编辑 403；保留变量名 400；旧 `sandbox.env` 400 |
| initScript 修改与镜像更新 | 自动重建且构建期间继续服务旧 image；成功后旧 Sandbox 仍输出 A，新 Sandbox 输出 A2 |
| 软删除后冻结 Session | 先把唯一引用 Agent 改绑 B；删除 A 200、查询 A 404；原 Session 下一条命令仍成功读取 concurrent-v4 |
| 构建器接管 | 外部滚动打断 A 的首次构建；第二次 attempt 成功，attempts=2、retries=0；没有消耗基础设施 retry |
| 最新全部角色滚动后回归 | 12:54:29 真实新 Session 通过：Python 媒体依赖、libGL、FFmpeg 9.0.1、vfs-cli 0.3.21、平台 MediaKit 密钥 presence、离线 Whisper 路径不存在 |

共享 `base-secret` 同时服务生产，本次没有在线轮换该 Secret。每 60 秒刷新和读取失败保留旧值已由本地测试覆盖；不能把它描述为本次真实 K8s Secret 轮换验收。

## 并发：30 根 Session，观察 5 分 10 秒

- 请求全部接受：**12:45:58.022**。
- 最后取消前快照：**12:51:08.979**，即 **310.969 秒**。
- 终止请求结束：**12:51:09.886**。
- 峰值及最后快照：**30 根 + 15 子 = 45 个 Session**，30 个 Sandbox。两个 Runner 均执行任务。
- **0 个 `session.error`、0 个 Sandbox 错误、0 个超过创建窗口的未完成 binding**。约 113 秒时 30 个 Sandbox 全部就绪。
- 30 次领取耗时：最小 **23.321 s**、中位 **85.345 s**、p95 **109.089 s**、最大 **109.389 s**。测试 Warm Pool 只有 1 个副本，多数为冷启动；该结果不代表生产预热池的延迟，也不是生产最大容量测试。
- 15 个子 Session 的 Environment、Workspace 与共享 Sandbox 均与其父一致，无不匹配。

| 组 | 根 / 子 | 工具调用 / 结果 | 工具错误 | 有执行进展的根 Session |
|---|---:|---:|---:|---:|
| 连续独立命令 | 10 / 0 | 101 / 93 | 0 | 10/10 |
| 同步委派 | 10 / 10 | 110 / 90 | 0 | 10/10 |
| Storyboard | 5 / 5 | 217 / 212 | 7 | 5/5 |
| Finalcut | 5 / 0 | 162 / 157 | 6 | 5/5 |
| 合计 | **30 / 15** | **590 / 552** | **13** | **30/30** |

调用数多于结果数是主动取消时尚有运行中的命令/等待委派。取消前完整业务 Turn 完成数为 0，本次按用户指示观察后取消，**不把它算作成片或分镜最终质量验收**。

### 并发热更新

先确认 20 个连续命令/委派执行 Session 都有真实 v3 输出，再于 **12:48:25.133** 完成 Environment 更新。独立审计将 native tool call 与 tool result 匹配，并解析 stdout JSON：

- **20/20** 在修改后的第一条新命令中读取 `concurrent-v4` 与 `concurrent-profile`。
- 后续完成的 **123** 个探针全部新值，旧值 **0**。
- 首个新命令在更新后 **4.676–16.486 s** 发起；结果在 **25.892–37.736 s** 返回。命令刻意带 `sleep 20`，后一数字不是配置传播耗时。
- 不把更新前已经启动的命令仍返回旧值判为错误。

### SSE 与服务健康

选取连续命令根、Finalcut 根和委派子 Session 的 3 条 SSE，实际各观察约 297 秒（启动比并发晚 13 秒），各主动断开重连一次，使用逐帧 durable cursor：全部 HTTP 200；无重复或倒退 durable ID、解析错误、异常 EOF、传输错误或 Session 错误。对应 durable/delta 计数分别为 92/189、288/1501、92/167。

从前置回归到最终滚动后的 156 次 `/api/health` 探测全部成功；延迟中位 115 ms，p95 242 ms，最大 1105 ms。并发期间 API/Runner 没有重启；观察结束后的滚动是另一项发布，最终所有角色均就绪。

### 业务执行的实际限制

13 个工具错误全部有后续成功工具执行，说明任务继续推进，不能据此断言每个业务错误都已修复：

- CSV 列名 `镜头号` 与文件实际列名不符、临时输出目录或 `layout.json` 尚未创建。
- Skill 文件名大小写误用；Script-to-DP validator 按相邻 `pipeline/pipeline_constants.json` 查找，而装备的 bundle 名为 `pipeline_canvas-free`，Agent 复制到临时目录或 Workspace 后继续执行。没有旧版本同提示对照，因此标为 Skill 路径假设问题，不强称“历史已有”。
- `cut_first_scene.py` 已成功切除 0.750 s 片头；复合命令后续的 grep 无匹配导致退出码 1，不能误记为场景检测失败。
- 本次 Storyboard 测试提示误引用未装备的 `director_luran_style`；不能声称该风格被验证。已有 `script-to-dp` 与子 Agent 流程确有执行进展。

完整 590 个调用审计未发现 VFS 修改、OSS 上传、发布或依赖安装；唯一 vfs-cli 相关行为是 `which`。有 5 次真实 MediaKit ASR 发起及查询任务等 21 次调用，属于允许的媒体分析。

实际装备的 **19 个 Skills / 315 个文件**全部静态扫描，没有离线 Whisper 运行时依赖。旧 `story-audio` 不在该集合，新版明确移除了其离线识别路径；本次不能为其他使用旧 `story-audio` 的 Agent 保证兼容。

## 本地验证

计数按限定并发重跑去重，**不是声称首轮所有命令均成功**。

| 测试套件 | 通过 | 失败 | 跳过 |
|---|---:|---:|---:|
| Server，含真实 PG/Redis 与 opt-in 补充 | 3268 | 1 | 8 |
| Adapter | 455 | 0 | 0 |
| Web | 526 | 0 | 0 |
| CLI | 43 | 0 | 0 |
| Deploy，含最新改动 | 42 | 0 | 1 |
| **总计** | **4334** | **1** | **9** |

Server/Adapter/CLI typecheck、Web build、OpenAPI 检查通过（OpenAPI 4 条既有 warning）。最新 builtin Environment 7/7、init 脚本 `bash -n` 通过。真实 PG 覆盖 Environment store、构建队列并发、supersession/lease fencing 和迁移 0026/0028/0029/0030。

首轮多个工作区并行运行出现 Adapter 8 项、Web 8 项、CLI 1 项时序失败；限制 worker 后分别重跑 119、64、6 项全部通过，没有修改实现。Web lint 仍有 **11 个既有错误**，对应失败代码在基点就存在。9 个跳过包括 7 个不适用于所选 backend 的生命周期 contract、1 个真实 Supabase Loop、1 个缺失 pristine Pi MCP fixture 的测试。

### 已在旧版本确认的 Redis 故障下 Interrupt 缺陷

`server/packages/api/test/split-process.test.ts:232`：Redis 不可用时，运行中的短 Turn 收到 `requested:true`，PG 中也保存了匹配当前 generation 的 Interrupt，但 active Turn 和 queued Turn 最终都正常完成，`session.turn_aborted` 为 0（预期 1）。

在独立 `b88d77c1` archive 与最新 `0e165408` 均复现，排除了“请求时 Turn 已完成”。默认 heartbeat 10 秒；短 Turn 先结束，`session-router.ts:1673,1685` 的完成前续约只看 `.renewed`，未处理 `.interruptRequested`，随后 acknowledgement 清除了已接受标记。这不是本需求引入，但作为详尽回归中的持续失败保留，不能标全绿。

本地原始报告、日志、对照证据：`/tmp/oma-env-local-20261026/`，其中 `report.md`、`summary.json`、`redis-outage-comparison.json` 给出完整命令和状态。

## 保密检查、清理与保留物

- 随机密钥 canary 在当时 34 个相关 Sandbox CR/Pod、API/Runner/builder 日志、采集的 Session 事件中匹配 **0**。不输出真实平台密钥。
- 包括最后新版工具回归在内，**52/52 Session 已 terminated**，pending 队列 **0**，live/creating/reclaiming binding **0**。
- Kubernetes 检查：与全部测试 Session / Workspace 关联的 Sandbox CR **0**、Pod **0**。
- 本任务 **33 个临时 API key 均已吊销**；SSE worker 也确认自身 key 撤销。Loop 保持 disabled。
- 保留新建 Agent、Workspace、事件和测试镜像供复查；Environment A 已软删除（用于验证冻结 Session），B 保留。没有删除他人的环境或测试数据。
- 本地临时故障 Redis、Docker 新测试镜像、注入探针已清理；原有本地 PG/Redis 保留。

结论按两个审查轴分别记录：**Standards 1 个 P2；Spec 3 个 P2**。真实热更新和短期并发路径通过，不足以覆盖这些配置写入竞态；修复后应复跑相应确定性交错测试、配置热更新和并发观察。
