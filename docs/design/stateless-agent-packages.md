# 无状态 Agent 与可组合能力包

日期：2026-10-19（2026-10-22 按 #234 的决定更新）。目标：Runner 在 Turn 执行到一半时崩溃，重启后（或换一个 Runner）从断点继续这个 Turn。
方式：参考 Pi 的组合方式，把 Agent 拆成独立包：`@oma/storage`、`@oma/sandbox`、`@oma/subagent`。

> **#234 的决定（以此为准）**：本期只做"无状态续跑"和"持久化内聚"：PR-A 的 TurnJournal 与提交屏障（ADR-0020），
> PR-B 的同 Turn 续跑与停机交接（ADR-0021）。**本期不做**：拆包（`@oma/storage` 等，§2、§3、§5）和 poller（§3.6）、
> 沙箱执行账本（§4.4）、续跑前杀孤儿进程、批量 append、生产多副本。与本稿原提案不同的地方：任何工具都不自动重跑
> （包括只读工具），悬空调用一律给模型"结果未知"（委托工具按持久的委托记录给真实结果）；stopReason 为 error/aborted
> 的 assistant 也续跑，不再以错误收尾。§4 按定稿重写，其余章节保留为后续拆包的设计参考。

依据：[Runner 执行链路架构评审](runtime-architecture-review.md)、`show-me-pi-packages.html`、
`@earendil-works/pi-durable@1.3.0` README、Pi 0.83.0 `docs/extensions.md`。

术语沿用 codebase-design：**模块**、**接口**（包括不变式和错误模式）、**接缝**、**适配器**、**深度**、**局部性**。

## 结论

1. **能拆，三个方向也对。** sandbox、storage、subagent 各对应一条真实接缝，每条都已经有或很容易有两个适配器：
   `SandboxSession` / `LocalToolExecutor`，PG / `store-memory`，PG 委托表 / 内存委托表。
2. **只拆这三个包，达不到"崩溃后继续执行"。** 续跑不归这三个包中的任何一个，它属于"驱动 Pi 循环、决定什么时候落库、
   重启后决定从哪里接着跑"的那一层。今天这一层分散在 `SessionRouter.drainLoop`（恢复判定）、`PiAgentAdapter`
   （`continuationHistory`、`restorePiSession`）和 `DelegationCoordinator`（waits）三处。用删除测试检验：删掉恢复逻辑，
   复杂度会在三个包和 Router 里各冒出来一份。所以需要第四个包 **`@oma/agent`**：持久 Turn 引擎兼组合根，也是唯一调用
   `createAgentSession` 的地方。三个能力包都插在它上面。
3. **续跑当时做不到，原因有两个，都和拆不拆包无关**（均已解决）：
   - **事件日志不是 WAL。** Pi 把事件推进一个无界队列后就继续往下跑，Router 要等消费到这个事件时才落库。所以工具可能已经在沙箱里
     执行完了，它的 tool call 还没写进 PG。→ PR-A：每个 Turn attempt 唯一的写入口 TurnJournal，Pi 在每个原生 `message_end`
     和模型请求闸门处 flush（ADR-0020）。
   - **恢复策略禁止续跑。** 只要已经写出部分输出，就以 `recovery_partial_turn_aborted` 结束（ADR-0010 §7）。→ PR-B：纯函数
     `planResume` 决定如何在同一个 Turn 内续跑，ADR-0021 替代 ADR-0010 §7。
4. **解法采用 pi-durable 的前半语义**（pi-durable 是 Pi 官方的持久化 harness）：先提交意图再执行工具，先提交上一步的结果再请求模型。
   后半按 #234 收紧：不按工具声明自动重跑，悬空调用一律如实告诉模型"结果未知"，由模型检查现场后决定；按 tool call 记录的沙箱执行
   账本是将来的扩展点（结果解析器按工具名注册），本期不做。
5. **顺序：先做无状态，再搬包。** 本期只做无状态；无状态相关的新模块（`planResume`、TurnJournal、悬空调用结果解析器）已经是独立模块，
   后面搬包只是挪文件，不用重写。

## 1. 为什么当时执行到一半重启会失败

（PR-A 之前的状态，留作背景；行号对应当时的代码。）

### 1.1 日志落后于执行

```
Pi AgentSession                     EventQueue(无界)            SessionRouter                PG
 ├ assistant: tool_call(bash)  ──push──▶ [entry]                    (还在处理更早的事件)
 ├ tool_call 钩子: capture() 只是 push，不等落库                    pi-context-journal.ts:30
 ├ bash 在沙箱里执行，产生副作用
 ├ toolResult                   ──push──▶ [entry, entry]
 ├ 下一次模型请求：journal.ready() 只等 compaction 提交            pi-context-journal.ts:57
 │                                                     ◀──next()── for await          pi-agent-adapter.ts:344, session-router.ts:1547
 ✗ Runner 崩溃                                                    append 还没轮到这条 ──▶ PG 里没有这次 tool_call
```

崩溃后，PG 里的日志停在 bash 之前。如果按"没有输出就重跑"，模型会重新决策，之前的副作用对它不可见；如果按"有部分输出就终止"，
Turn 直接报错。Runner 负载越高，Router 消费越慢，这个时间窗口就越大（参见 2026-10-15 的过载重启）。

现在唯一真正同步的屏障是 compaction 的 `persistContext`（ADR-0013）。

### 1.2 恢复策略

`session-router.ts:1207`：Turn 有部分持久输出且没有委托等待时，补齐悬空的 tool_use 结果，写 `recovery_partial_turn_aborted`，结束 Turn。
`session-router.ts:1441`：恢复委托等待时，只要还有别的悬空工具，就写 `recovery_required`。
`session-router.ts:1186`：子执行被接管时，直接以 `recovery_required` 结束。

### 1.3 续跑通道其实已经有了

委托等待的恢复路径（`session-router.ts:1478-1482`）已经能做到：用全部已提交历史重建 Pi 上下文，`continuation` 加上
`completedModelSteps`，再通过 `installContinuation` 用一条控制消息让 Pi `continue()`，不再追加用户消息。
`continuationHistory`（`pi-agent-adapter.ts:751`）要求每个悬空调用都已经有持久结果。
所以续跑缺的不是机制，而是两样东西：**落库屏障**，以及**为悬空调用产生结果的策略**。

## 2. 模块和接缝

（后续拆包的设计参考，本期不做。）

```
                       Host（oma-runner / oma-server / 本地 CLI）
                       只做组合 + HTTP + 唤醒调度
                                   │ createAgentRuntime({...})
                                   ▼
┌──────────────────────────── @oma/agent ─────────────────────────────┐
│ 持久 Turn 引擎 + 组合根                                             │
│ drive(sessionId)：租约 → 恢复判定 → 组装 Pi → 两道屏障 → 收尾       │
│ 唯一调用 createAgentSession；唯一懂 pi@0.83.0 entry 格式            │
└──────┬─────────────────────┬──────────────────────┬─────────────────┘
       │SessionStorage       │SandboxCapability     │SubagentCapability
       ▼                     ▼                      ▼
  @oma/storage           @oma/sandbox            @oma/subagent
  pg / jsonl / memory    local / e2b             Agent·get_subagent_result·steer_subagent
                         7 个 Pi 同名工具+账本    deriveChild；只依赖 storage
```

依赖规则：

- 能力包只依赖 Pi 公开 API 和 `@oma/core`（端口类型，由现在的 `adapter-core` 演化而来）。能力包之间互不依赖。
- `@oma/agent` 不 import 任何能力包的实现。具体实现只在 Host 的组合根里 `new`。
- 能力包的持久状态（委托记录、沙箱 binding 锁）放在 Session 所在的同一个 storage 里，并且在同一个事务里提交。
  这就是"继承 storage"的字面意思。

| 包 | 唯一职责 | 藏在接口后面的东西 | 接缝上的适配器 |
|---|---|---|---|
| `@oma/agent` | 让一个 Session 在任何进程上都能被推进到下一个稳定点 | 恢复判定、两道屏障、Pi 会话装配、续跑、步数预算、Delta 对齐、Turn 收尾 | —（它本身是被调用的深模块） |
| `@oma/storage` | 持久日志 + 待处理输入 + 独占租约 | fence/generation、心跳续租、中断轮询、幂等键、seq、分页、大结果转 OSS（ADR-0015）、提交后 publish | `pg`（包装现有 store）、`jsonl`（新）、`memory`（`store-memory`） |
| `@oma/sandbox` | 让工具在注入的环境里执行；没有注入时在本地执行 | ADR-0019 activity、binding 锁与占用计数、懒创建/重连/重建、挂载校验、Skill 投影、每次 exec 的 fence 校验、NDJSON 包装协议、edit/write 路径锁、执行账本 | `SandboxClient`：E2B / Fake；`ToolExecutor`：`SandboxSession` / `LocalToolExecutor` |
| `@oma/subagent` | 持久委托：创建或恢复子 Session、等待、steering、结果回传 | 委托表事务、并发上限 4、配额、结果 outbox、按 toolCallId 幂等 | `DelegationStore`：PG / 内存（都已存在） |

## 3. 接口

（后续拆包的设计参考，本期不做。§3.3 `ToolRecovery` 里的 `rerun` 不再采用，见 §4.3。）

### 3.1 `@oma/agent`

```ts
export function createAgentRuntime(options: {
  storage: SessionStorage;            // @oma/storage
  sandbox: SandboxCapability;         // @oma/sandbox；sandbox() 不带 provider 时在本地执行
  subagents?: SubagentCapability;     // @oma/subagent；不传则没有 Agent 工具
  models: ModelResolver;              // 租户 BYOK / 网关，由 Host 提供
  instructions: InstructionAssembler; // Agent Files、Skills、Workspace 说明、MCP，由 Host 提供
  live?: DeltaSink;                   // Redis / 控制台 / 不传
}): AgentRuntime;

export interface AgentRuntime {
  /**
   * 推进一个 Session，直到没有可执行的输入、租约丢失或 signal 中止。
   * - 任何进程、任何时刻、重复调用都安全；同一时刻最多只有一个调用在执行（租约）。
   * - 上一个执行者死在 Turn 中间时，从最后一条已提交记录继续同一个 Turn（同一个 turnId），
   *   不重开、不报 recovery 错误。
   * - signal.reason === "handoff"：只脱离，不取消沙箱里正在跑的工具；下一个 drive 会把它接回来。
   */
  drive(sessionId: string, signal?: AbortSignal): Promise<"idle" | "held-elsewhere" | "lease-lost" | "stopped">;
}
```

Runner 侧只剩这一个入口：Redis 唤醒和 PG 定时扫描都只调用 `drive`。中断、终止由 API 写进 storage，
引擎通过 `lease.signal` 感知，不需要 Runner 持有执行对象（和 ADR-0018 一致）。

内部模块，即评审 §4.1 的流水线，都不出现在接口上：`planResume`（纯函数）、`resolveTurnConfig`（纯函数）、`PiSessionFactory`、
`TurnJournal`（两道屏障）、`TurnFinalizer`、Delta 对齐。

### 3.2 `@oma/storage`

```ts
export function storage(options?: { pg?: PgPool; dir?: string }): SessionStorage; // 不传 pg：本地 JSONL
export function memoryStorage(): SessionStorage;                                     // 测试

export interface SessionStorage {
  /** 独占执行权。null 表示别人持有。续租在内部完成。 */
  acquire(sessionId: string): Promise<SessionLease | null>;
  /** API、Loop、委托、子会话结果都从这里进入。按 input.id 幂等。 */
  enqueue(sessionId: string, input: QueuedInput): Promise<void>;
  /** 有待处理输入的 Session。输入在 Turn 完成后才出队，所以执行到一半的 Turn 也在这里面。 */
  runnable(limit: number): Promise<string[]>;
  /** 能力包的持久状态，和 Session 同库同事务。 */
  readonly facets: { delegations: DelegationStore; sandboxBindings: SandboxBindingStore };
}

export interface SessionLease {
  readonly session: SessionRecord;   // 带 CapabilityProfile（见 §5）
  /** reason: "lease-lost" | "interrupt" | "terminated" | "handoff" */
  readonly signal: AbortSignal;
  history(): Promise<SessionEvent[]>;
  /** 队首输入，已幂等提升进日志；没有则 null。 */
  head(): Promise<QueuedInput | null>;
  /** 原子提交、带 fence、按 event.id 幂等。租约丢失时抛 LeaseLostError，调用方必须停下。 */
  commit(events: SessionEvent[], effects?: {
    createSessions?: SessionRecord[];
    enqueue?: { sessionId: string; input: QueuedInput }[];
  }): Promise<void>;
  /** turn_completed + ack；队列空了就置 idle。幂等。 */
  complete(inputId: string): Promise<void>;
  release(): Promise<void>;
}
```

`commit` 的 `effects` 让委托可以把"父 Turn 提交 tool call"和"创建子 Session、子 Session 的输入入队"放进同一个事务，
也让子 Session 可以把"自己的最终输出"和"结果入队给父 Session"放进同一个事务。

`jsonl` 适配器：每个 Session 一个文件，用 pid 锁文件做租约，只支持单进程。这个限制要写进接口说明，就像 pi-durable 写明的那样。

测试面：一套契约测试同时跑三个适配器，至少覆盖"两个 acquire 只有一个成功""租约丢失后 commit 被拒""重复 commit 幂等"
"head 只提升一次""complete 幂等"。

### 3.3 `@oma/sandbox`

```ts
export function sandbox(options?: { provider?: SandboxProvider; localRoot?: string }): SandboxCapability;
export function e2b(config: E2BConfig): SandboxProvider;   // 现有 SandboxManager + E2BSandboxClient

export interface SandboxCapability {
  /** 为一个 Turn 打开工具；沙箱在第一次工具调用时才创建。 */
  open(turn: TurnScope): Promise<TurnToolset>;
}

export interface TurnScope { session: SessionRecord; lease: SessionLease; signal: AbortSignal }

export interface TurnToolset {
  readonly tools: ToolDefinition[];                  // bash read write edit ls grep find：Pi 同名、同 schema
  /** 续跑时为一个已提交但没有结果的调用给出结果（§4.3）。 */
  recover(call: { turnId: string; id: string; name: string; args: unknown }): Promise<ToolRecovery>;
  close(outcome: { settled: boolean }): Promise<void>;  // ADR-0019 finishActivity、释放占用、清理账本
}

export type ToolRecovery =
  | { kind: "result"; result: ToolResult }        // 账本里有真实结果
  | { kind: "rerun" }                              // 能证明没执行过，或者是只读工具
  | { kind: "interrupted"; message: string };      // 无法确定
```

"有沙箱注入就用沙箱，没有就在本地执行"完全在这个包内部实现：两种情况下 Pi 看到的是同一套 7 个工具，只是背后的
`ToolExecutor` 不同。本地模式也通过同一个 node 包装器执行，所以账本语义一致。

### 3.4 `@oma/subagent`

```ts
export function subagents(policy?: { maxConcurrent?: number; maxModelSteps?: number }): SubagentCapability;

export interface SubagentCapability {
  open(turn: TurnScope): Promise<TurnToolset & {
    /** 每次模型请求前，取出已持久化的 steering 指令。 */
    beforeModelStep(): Promise<DelegationInstruction[]>;
  }>;
  /** 纯函数：从父 Session 的配置推导子 Session 的能力配置（§5）。 */
  deriveChild(parent: CapabilityProfile): CapabilityProfile;
}
```

不变式：**这个包永远不构造、也不运行 Pi 会话。** `Agent` 工具只做一件事：通过 `lease.commit(…, { createSessions, enqueue })`
写下子 Session 和它的 Delegation Input。子 Session 和其他 Session 一样由 `drive` 推进，可能在另一个 Runner 上执行。
`@tintinweb/pi-subagents` 被禁用，就是因为它自己调用 `createAgentSession`，继承不了父会话的 storage 和 sandbox。

### 3.5 组合示例

```ts
// 生产 Runner
const runtime = createAgentRuntime({
  storage: storage({ pg: pool }),
  sandbox: sandbox({ provider: e2b(cfg) }),
  subagents: subagents({ maxConcurrent: 4 }),
  models: tenantModels, instructions: hostInstructions, live: redisDeltas,
});
dispatch.onWake(id => runtime.drive(id, shutdownSignal));

// 本地：没有 PG、Redis、E2B
const store = storage();
const runtime = createAgentRuntime({ storage: store, sandbox: sandbox(), subagents: subagents(), models, instructions });
await store.enqueue(id, userMessage("整理 workspace 里的文件"));
await runtime.drive(id);   // kill -9 之后再执行一次这一行，Turn 会接着跑

// 本地 Pi + 远端沙箱：只改一处
sandbox: sandbox({ provider: e2b(e2bFromEnv()) }),
```

### 3.6 调度（poller）：`serve`，放在 `@oma/agent` 里，不单独成包

```ts
export function serve(options: {
  runtime: AgentRuntime;
  storage: SessionStorage;     // 定时扫描用 storage.runnable()
  wake?: WakeSource;           // Redis pub/sub / 进程内事件；丢了也没关系，靠扫描兜底
  scanEveryMs?: number;        // 默认 5000
  maxConcurrent?: number;      // 单个 Runner 的容量上限（今天没有）
  signal: AbortSignal;         // 停机：以 "handoff" 中止所有 drive，释放租约
}): Promise<void>;

export interface WakeSource { subscribe(onWake: (sessionId: string) => void): () => void }
```

poller 只负责一件事：找到该推进的 Session，调用 `drive(sessionId)`。它不解析 Agent 配置，不懂 Pi，也不碰事件。

- **只传 sessionId。** 续跑时必须沿用原始那次执行的配置，比如等待快照里的 model/thinking、委托执行的 model、Loop 快照，
  而这些规则只有引擎知道。今天的 `handleNewEvent(sessionId, session.agent)`（`runner-dispatch.ts:34`）把配置传进去，
  `drainLoop` 又在 `session-router.ts:1158-1176` 重新算了一遍。判断无状态的标准是：如果 `drive` 除了 sessionId 还需要别的输入，
  那个输入就是必须跨崩溃保存的状态。
- **完整事件不从 poller "流出去"。** 完整事件在引擎内部、在两道屏障上 await 提交到 storage，API/SSE 从 storage 读已提交的事件。
  如果完整事件作为一个流交给外层，由外层消费后再落库，就又回到了 §1.1 的根因：Pi 不会等落库就去执行工具。
  只有 Delta 适合直接往外推（`live`）。
- **接缝**：`WakeSource` 有 Redis 和进程内两个适配器。本地模式同样需要 poller，因为子 Session 要靠它在进程内被推进，所以 `serve` 和引擎放在同一个包里。
- **从 SessionRouter 迁进来的**：`RunnerDispatch`（61 行）、`activeSessions` / `wakeRequested`、claim 重试退避（`session-router.ts:237-470`、`:550-600`）。
  心跳和 fence 归 `SessionLease`。

## 4. 续跑的语义（按 #234 定稿，见 ADR-0020、ADR-0021）

### 4.1 提交屏障（ADR-0020）

- 每个 Turn attempt 只有一个写入口 **TurnJournal**：claim 之后由 Router 创建，注入给 Adapter。`record` 同步、按调用顺序排队；
  `flush` 在此前 record 的事件全部持久化并 publish 后 resolve，任何一次失败后永远 reject；只在 flush 时写入，没有后台写入线程。
- Pi 在每个原生 `message_end` 处 flush（一个 awaited Agent listener，排在 AgentSession 自己的 listener 之后）：工具开始之前，
  请求它的 assistant entry 已经提交；下一次模型请求之前，工具结果和 steering 已经提交。模型请求闸门（含摘要请求）也 flush。
  compaction 先检查中断再写入，边界本身就是提交证据（ADR-0013）。
- 写入口可以撤销：撤销前 record 的事件照常落库，之后 record/delta 丢弃、flush 立即失败。持久化失败与租约丢失走同一条停止路径，
  不写终态事件。Router 原来"从迭代器取到事件就落库"的路径、`EventQueue`、checkpoint 缓冲都已删除。
- **Delta 不经过屏障。** 崩溃只会丢掉正在流式输出的那段回答，续跑时重新请求模型。Delta 带 `attempt`，控制台对同一 Turn 只保留
  最大 attempt 的 Delta；Turn 的 Delta stream 只在 Turn 完成时删除。

代价：每轮工具调用、每次模型请求前各多一次 PG 往返。毫秒级开销，模型调用是秒级。

### 4.2 恢复判定：纯函数 `planResume`

输入是本输入提升之后的全部事件、委托等待、claim（generation、上一个 claim 是过期还是被释放、更早 generation 是否接受过 Interrupt）
和 Child Session 的执行；按优先级取第一条成立的行：

| # | 已提交的事实 | 动作 |
|---|---|---|
| 1 | 已有 `turn_completed` | 只补 ack |
| 2 | 已有终态事件（idle、`session.error`、`turn_aborted`） | 修补悬空调用后完成 Turn |
| 3 | 更早的 generation 有已接受、未生效的 Interrupt | 按 Interrupted Turn 收尾（#249） |
| 4 | 连续 3 次因租约过期被接管、其间没有新提交的原生消息 | `recovery_limit_exceeded`（#250） |
| 5 | 有同步委托等待 | 恢复等待，其余悬空调用补"结果未知"，然后 continue |
| 6 | 原生 user 消息还没提交 | 用同一个 turnId 重新 prompt（建在已提交的内容上，例如 compaction 边界） |
| 7 | 最后一条是不带工具调用、请求未失败的最终回答 | 直接完成，不再调用模型 |
| 8 | 有悬空调用 | 补"结果未知"后 continue |
| 9 | 最后一条是 toolResult、steering、输入本身，或 stopReason 为 error/aborted 的 assistant | continue |

没有老规则分支：普通 Turn 不会因为被接管而以 recovery 错误结束。compaction 边界不是消息：Pi 在最终回答之后（阈值）和请求失败之后
（溢出）都会压缩，边界前的那条消息决定走第 7 行还是继续。Child Session 的执行另有一行：执行已结束则完成 Turn（#252 决定丢失
owner 的执行如何续跑）。

每次接管写一条 `session.turn_resumed { turnId, generation, reason, danglingToolUseIds }`，`reason` 来自 claim 返回的上一个 claim 状态
（`expired` / `released`；PG 从 claim 已经锁住的那一行读取，不增加语句）。对话视图不显示，轨迹页可见。`turnId` 沿用第一次 attempt；
步数和 blockIndex 起点从日志统计；model 和 thinking 沿用第一次 attempt 记录的值（#253）。

### 4.3 悬空调用的结果

- **不自动重跑任何工具**，包括只读工具。接受重复执行（业务层保证幂等）；本期不杀孤儿进程。
- 默认给一条 isError 的工具结果，给模型的文案为："The agent runtime restarted while this tool call was in progress, so its outcome is
  unknown. It may not have run, may have partially completed, or may have finished, and a process it started may still be running.
  Inspect the current state before deciding whether to retry. Do not assume it succeeded."
- 委托工具（`Agent`、`get_subagent_result`、`steer_subagent`）由按工具名注册的结果解析器根据持久的委托记录给真实结果，查不到才补
  "结果未知"（#251）。`planResume` 不感知具体工具；解析器表也是将来接入沙箱执行账本（§4.4）的扩展点。
- MCP 调用同样是"结果未知"，结果带上原调用的 `serverName`。
- Interrupted Turn 的悬空调用仍用 Interrupt 的修补文案。
- Pi 0.83 并行执行同一条 assistant 消息里的工具调用，整批都结束后才追加结果：其中一个调用还在跑时 Runner 丢失，整批调用都是"结果未知"。

### 4.4 沙箱执行账本（本期不做）

以下是将来的设计，接入点是 §4.3 的结果解析器：

- 沙箱侧包装器（`sandbox-tool-runtime.ts`）在执行工具**之前**写 `~/.oma/tool-ledger/<turnId>/<toolCallId>.json`：
  `{ state: "started", pid }`；执行完成后用 rename 原子写入结果。
- 进程本来就和连接解耦：E2B 用 `background: true` 启动，断开 SDK 请求只会断流，不会终止进程（`e2b-sandbox-client.ts:465`、`:548`）。
  Runner 死了，沙箱里的命令会继续跑完。
- 解析器通过一次 exec 读取账本：有结果 → 真实结果；`started` 且 pid 还活着 → 继续等；其余 → "结果未知"。
- 待验证：E2B 的 background 进程在 SDK 连接断开后能存活多久；沙箱实例身份从 binding 的哪个字段读取。

### 4.5 停机交接：脱离，而不是取消（#254）

SIGTERM（发版、缩容）时：停止 claim 新输入（PG 扫描、唤醒订阅和 claim 重试定时器都停）；给每个运行中的 Turn 发停止请求，Pi 在下一次
模型请求闸门处停下（不在 `message_end`，否则并行工具已完成的结果无法提交），**不**取消正在运行的工具，Adapter 以 `"stopped"` 返回；
到停机截止时间仍未停下的 Turn 直接撤销写入口，不取消沙箱进程；释放 claim，不写任何终态事件，并唤醒其他 Runner。接管方按 §4.2 续跑，
被释放的 claim 不计入续跑上限。宽限期维持 20 秒 / K8s 30 秒，租约维持 30 秒。oma-test 的 Runner 切到 RollingUpdate、2 副本。

## 5. 子 Agent 继承：继承配置，不继承实例

（后续拆包的设计参考，本期不做。本期 Child Session 的执行像普通 Session 一样续跑，见 #252。）

Session 记录上增加一个可序列化的 `CapabilityProfile`：

```ts
interface CapabilityProfile {
  sandbox: { bindingId: string } | { localRoot: string } | null;
  delegation: boolean;       // 能否再委托
  extensions: string[];      // MCP、web
  maxModelSteps?: number;
}

// @oma/subagent，纯函数，表驱动测试
deriveChild(parent) = { sandbox: parent.sandbox, delegation: false, extensions: [], maxModelSteps: 500 }
```

- **sandbox 按 bindingId 继承**：子 Session 默认共享父 Session 的 Workspace 和 Sandbox binding（CONTEXT.md）。
  今天的写法是 `session.delegation?.sandboxSessionId ?? session.id`，在 `session-router.ts:708`、`:821`、`:1369` 各写了一遍。
- **storage 不写进 profile**：子 Session 是通过父 Session 的 `lease.commit(…, { createSessions })` 创建的，天然在同一个 storage 里；
  推进它的引擎也持有同一个 storage。这是由构造方式保证的继承。
- **实例不继承**：executor、租约、fence 都是每个 Session、每个 Turn 独立的（ADR-0010 取消了父子共享 ToolExecutor，
  `pi-agent-adapter.ts:303`）。原因：崩溃之后子 Session 可能在另一个 Runner 上续跑，能跨进程保留下来的只有序列化的数据。
- 这样就能删掉分散的 `isChild` / `session.delegation` 分支：`session-router.ts:1166`、`:1171`，`pi-agent-adapter.ts:303-304`、`:514-516`。

## 6. 和 Pi、pi-durable 的关系

- **Pi coding-agent 的组合方式**是一个 `createAgentSession({ sessionManager, customTools, resourceLoader })` 加上扩展。这里保持同样的形状：
  引擎是唯一的调用方，能力包提供工具和扩展。storage 做不成 Pi 扩展，原因有两个：`SessionManager` 是在 `createAgentSession` 时选定的同步具体类；
  扩展抛出的错误会被吞掉，而 B2 必须在出错时阻止下一次请求。
- **pi-durable** 是这套语义的来源："意图在 `execute()` 之前提交；只有 `replay: "safe"` 的工具会在崩溃后重跑，其余给模型 `interrupted`"（README:181）；
  子 Agent 工具 `replay: "safe"`，重跑时找回同一个子会话（README:548）；子会话复制父会话的 agent 配置（README:305）；
  每个会话一个 env 工厂（README:333）。
  暂不直接换成 pi-durable 的原因：它"一次只允许一个进程拥有 storage，没有跨进程锁"（README:682），而 OMA 是多 Runner + claim/fence；
  它标注为 Experimental（README:3）；它的扩展 API 也不同（pi-mcp-adapter、pi-web-access 加载不了）。
  这里的端口按它的形状设计，如果以后要换，只需要替换适配器，调用方不用改。
  与 pi-durable 不同，OMA 不按 `replay: "safe"` 自动重跑工具（#234）：不确定的调用一律交给模型判断。

## 7. 落地顺序（#234）

**PR-A**（持久化重构 + 提交屏障，ADR-0020）：#235 删除 claude-code/codex 运行时；#236 Router 测试改用 store-memory；#237 Delta stream
30 分钟滑动 TTL；#238 TurnJournal；#239 委托等待不再携带 checkpoint；#241 Router 写入改走 TurnJournal；#242 Pi Adapter 通过注入的
journal 写入并对齐 Delta；#243 mock Adapter 迁移；#244 `run()` 返回 `"finished" | "stopped"`，删除事件流路径。

**PR-B**（续跑 + 停机交接，ADR-0021）：#240 Interrupt 真正停止沙箱里的工具；#245 `planResume` 纯函数；#246 Delta 带 attempt；#247 同一
输入的各次 attempt 共用 turnId；#248 同一个 Turn 内续跑；#249 Runner 丢失前接受的 Interrupt 在接管后生效；#250 连续 3 次无进展的接管结束
Turn；#251 委托工具按记录给结果；#252 Child Session 的执行续跑；#253 沿用最初的 model 和 thinking；#254 停机交接；#255 oma-test 验收。

拆包（本稿 §2、§3、§5 的第二期）另行决定。

验证方法：
- **崩溃注入测试**（`server/packages/api/test/crash-injection`）：真实 Router + 真实 Pi SDK + 脚本化模型和工具 + 内存存储。在第 N 次持久写入
  之后像 kill -9 一样丢掉 Runner（此后它等待的一切都不再返回，claim 失效），保留存储，由新 Runner 的 pending 扫描接管；N 遍历场景的全部写入。
  断言：每个输入以原 turnId 完成一次、按顺序；没有 `recovery_*` 错误；每个工具调用恰好一个结果；"结果未知"只出现在崩溃时悬空的调用上；
  工具不重复执行；步数从日志延续；每次接管恰好一条 `session.turn_resumed`；丢失的 Runner 不再写入。场景：单个 bash、并行工具（含接管方
  再次丢失）、排队的最终回答、阈值与溢出 compaction、失败重试与持续失败的请求，以及流式中、工具运行中、一次 flush 中间丢失和 compaction
  中 Interrupt。后续票（#250–#254）在同一套测试上追加场景。
- **oma-test 实测**（#255）：长 bash 执行中 kill -9 一个 Runner，35 秒内被另一副本接管并跑完；Turn 执行中 rollout restart，交接后几秒内续跑；
  `verify-api-runner-release.mjs` 通过；统计 flush 耗时 p50/p99。

## 8. 已拍板的事

1. **不确定的工具调用**：给模型"结果未知"并继续，替代 ADR-0010 §7（ADR-0021）；不按工具声明自动重跑，包括只读工具。子执行随 #252 续跑。
2. **Host 侧 MCP 工具**：一律"结果未知"。
3. **先无状态后搬包**：本期只做无状态，拆包另行决定。

## 9. 不做的事

- 不自动重跑任何工具；本期也不在续跑前杀孤儿进程（#234）。
- 不把 storage 做成 Pi 扩展（理由见 §6）。
- subagent 包不创建 Pi 会话。
- 不持久化 Delta 和流式中的部分回答（pi-durable 每 100ms 提交一次部分回答，我们不需要：Delta 本来就是瞬态的）。
- 不承诺外部副作用 exactly-once：账本能覆盖"Runner 死了、沙箱还活着"这种常见情况，其余情况如实交给模型判断。
- 不做通用的能力插件注册表：引擎只有三个具名插槽，和用户心智里的三个包一一对应。
