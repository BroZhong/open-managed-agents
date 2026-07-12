# SandboxManager 接口设计（定案）

> 由 `/codebase-design` 的 design-it-twice 得出：三个并行设计（最小接口 / 最大灵活 / 默认 trivial）→ 以"默认 trivial"的会话对象为骨架，吸收"最小接口"的极简与"最大灵活"的正交检验。承接 ADR-0005 与 CONTEXT.md 词汇。

## 决策摘要

- **主路径一扇门**：`open(spec) → SandboxSession`。不建 `withSandbox`（有界作用域无真实调用方，属假想场景）。
- **SandboxSession 是长命对象**：跨 turn 复用，turn 间隔短则沙箱不回收重建;Session 结束才 `dispose`。绑定语义存在对象身份里，不再是 Router 的 Map。
- **只暴露 Tool 模式原语**：`exec/readFile/writeFile/list` + `checkpoint`/`dispose`。Agent 模式的 `attachment()` 等真做时再加（用 deletion test 保证不破坏 Tool 面）。
- **命名裁决**：介质无关的 hydrate/sync 家在代码里叫 `WorkspacePersistence`（`WorkspaceStore` 已被元数据存储占用）。
- **只读投影来源用弱类型 `{kind, ref}`**，拒绝强类型判别联合（保 EnvSpec 是可序列化的值、加来源不动核心类型）。

---

## 1. 值：EnvSpec（Host 算出的配方，无行为）

```ts
/** Host 算出、交给 SandboxManager 的完整配方。是值不是行为：无 I/O、无 lifecycle。 */
export interface EnvSpec {
  tenantId: string;
  workspaceId: string;

  image?: string;                       // 容器镜像 / e2b template;缺省用 Manager 默认
  env?: Record<string, string>;         // 烘进沙箱运行时的环境变量

  /** 只读投影：单向下行、永不 sync，挂固定 /home/user 之外。0 个或多个。 */
  projections?: readonly ReadonlyProjection[];
}

/** 一条只读投影（值）。source 是坐标,I/O 由注入的 ProvisionSource 按 kind 分发。 */
export interface ReadonlyProjection {
  /** 沙箱内绝对路径,MUST 在 /home/user 之外(如 /skills、/repo)。 */
  targetPath: string;
  source: ProvisionCoordinate;
}

/** 弱类型坐标:加一个新来源 = 加一个 kind + 注册一个 adapter,EnvSpec 类型零改动。 */
export interface ProvisionCoordinate {
  kind: string;                         // "s3" today;未来 "git" | "tarball"
  ref: Record<string, string>;          // s3 today: { tenantId, skillId } —— 落地时故意用这个而非裸 { prefix }，
                                        // 让 SkillArtifactStore 保留其私有 key 布局(见 provision-source.ts)
}
```

**不变量**：Workspace 根固定为 `/home/user`；任一 `projection.targetPath` 落在该目录之内 → `open` 直接 fail loud（否则 sync 全量扫描会把投影当用户产物回写，污染 Workspace）。

---

## 2. Module：SandboxManager（主路径一扇门）

```ts
/**
 * 沙箱生命周期的唯一拥有者,两模式共享。小接口,藏 create+hydrate+投影编排、
 * 透明自愈、销毁前必 sync。per-call 隔离:无跨会话可变注册表。
 */
export interface SandboxManager {
  /**
   * 取得一个绑定到该 EnvSpec 的 SandboxSession。**廉价**:不起任何沙箱
   * (懒创建 —— 首次原语调用才 create+hydrate+project)。纯聊天 turn 零成本。
   * 两次 open 得两个独立 SandboxSession —— 绑定在对象身份里,不在 Manager 的 Map。
   */
  open(spec: EnvSpec): SandboxSession;

  // ── 孤儿回收:接口预留,当下靠 1h TTL,不实现 sweep(ADR-0005 §一致) ──
  list(filter?: { tenantId?: string; workspaceId?: string }): Promise<SandboxDescriptor[]>;
  reclaim(sandboxId: string): Promise<void>;
}

export interface SandboxDescriptor {
  sandboxId: string;
  tenantId: string;
  workspaceId: string;
  createdAtMs: number;
}
```

---

## 3. Handle：SandboxSession（长命、跨 turn、自愈）

```ts
/**
 * 一个 Session 对其沙箱的活的、自愈的绑定。跨 turn 长命:Router 每个 Session 持有
 * 恰好一个,持有其整个生命周期。turn 间隔短时沙箱**不回收重建**(靠 1h TTL 存活)。
 *
 * 暴露:Tool 模式原语(over 永远活的 handle) + 检查点 + 销毁。
 * 隐藏:sandboxId、create、hydrate、rebuild、baseline、内容哈希态、isAlive 探测。
 *   Router 永远看不到、也无从误用这些。
 *
 * 结构上是 adapter-core 的 ToolExecutor(exec/readFile/writeFile/list 签名一致),
 * 所以 AdapterInput.toolExecutor 直接收它,无需转换。
 */
export interface SandboxSession {
  // ── Tool 模式原语(ADR-0005 §2:Tool-mode-only,可自由耦合 Pi) ──
  // 每次调用透明保活:首次 create+hydrate+project;网关回收后 rebuild+重新 hydrate。
  // 调用方**永不**见 SandboxReclaimed。路径 workspace-relative,绝不暴露沙箱绝对路径。
  exec(command: string[], opts?: ExecOptions): AsyncIterable<ExecOutputChunk>;
  readFile(path: string): Promise<string>;
  writeFile(path: string, content: string): Promise<void>;
  list(globOrDir?: string): Promise<FileListEntry[]>;

  /**
   * 生命周期检查点(turn 末)sync。返回 delta 供上层发 workspace.file_change。
   * 从未起过沙箱(纯聊天)或已被网关回收 → 返回**空** SyncResult,**绝不 throw**;
   * 真正的介质失败**才** throw,由调用方决定。不会为了 sync 而起沙箱。
   */
  checkpoint(): Promise<SyncResult>;

  /**
   * Session 结束:先 sync 再 destroy。幂等。纯聊天 Session(从未起沙箱)→ 空 no-op。
   * dispose 后会话作废,再调原语 throw SandboxSessionClosed。
   */
  dispose(): Promise<SyncResult>;
}
```

`ExecOptions` / `ExecOutputChunk` / `FileListEntry` 复用现有 `adapter-core` 类型不变。

**Agent 模式（未来，现在不建）**：届时加 `attachment(): Promise<{ backendId, workspacePath, env }>` 给 Agent 编排把进程塞进沙箱。deletion test 要求：加它之后删掉 `exec/readFile/writeFile/list`，Agent 模式仍完整可用;反之删掉 `attachment`，Tool 模式仍完整可用——证明两组正交、各为一个真实用例的最小面。

---

## 4. SyncResult（Workspace 产物，Manager 不发事件）

```ts
export interface SyncResult {
  tenantId: string;
  workspaceId: string;
  changed: string[];   // workspace-relative,推到 Store 的新/改文件
  deleted: string[];   // baseline-diff 删除
}
export function syncHasChanges(r: SyncResult): boolean;  // 复用现有
```

Manager/Session 只返回 `SyncResult`;**从不**发 `workspace.file_change`。发事件留在 Router（它才知道 SSE）。

---

## 5. 注入的 seam

```ts
export interface SandboxManagerDeps {
  sandboxClient: SandboxClient;                       // True external:E2B + Fake(均已存在)
  persistence: WorkspacePersistence;                  // Remote-but-owned:介质无关,S3 today
  provisionSources: Record<string, ProvisionSource>;  // 按 coordinate.kind 分发,{ s3 } today
  defaults?: { lifetimeSeconds?: number };
}

/**
 * Workspace 持久态的介质无关的家(CONTEXT.md 的 "Workspace Store")。
 * Baseline 是它的**私有**概念,藏在 opaque HydrationSession 里,不上浮 Manager 接口——
 * 换 PV/镜像(可能无 baseline)时接口不穿帮。
 */
export interface WorkspacePersistence {
  /** 把 workspace 区灌进沙箱,返回 opaque session(内藏 baseline 或介质等价物)。 */
  hydrate(target: HydrateTarget): Promise<HydrationSession>;
  /** 用同一 session 把沙箱当前 workspace 态写回。介质自定"怎么算改/删"。 */
  sync(session: HydrationSession, target: HydrateTarget): Promise<SyncResult>;
}

/** Manager 给 Persistence 的最小沙箱读写能力(Persistence 不认识后端 SDK)。 */
export interface HydrateTarget {
  tenantId: string;
  workspaceId: string;
  workspaceDir: string;  // Manager 传固定 /home/user；Persistence 仍保持介质无关
  fs: SandboxFsAccess;   // Manager 用当前活沙箱填充:writeFile/readFile/list
}

/** opaque:Manager 与调用方都不看内部,只在 hydrate→sync 间传递。 */
export type HydrationSession = { readonly __brand: "hydration-session" };

/** 只读投影来源。单向:把 coord 内容灌到沙箱 targetPath,永不回读、不经 Host。 */
export interface ProvisionSource {
  project(coord: ProvisionCoordinate, target: ProjectionTarget): Promise<void>;
}
export interface ProjectionTarget {
  targetPath: string;                                 // 沙箱内绝对路径,MUST 在 workspace 外
  fs: SandboxFsAccess;
  exec(command: string[], opts?: ExecOptions): AsyncIterable<ExecOutputChunk>;
}
```

| seam | 生产 adapter | 测试 adapter | 扩一个新的要写 |
|---|---|---|---|
| `SandboxClient` | `E2BSandboxClient`（已有） | `FakeSandboxClient`（已有） | 无需动 |
| `WorkspacePersistence` | `S3WorkspacePersistence`（包 `ArtifactStore`;`HydrationSession = {baseline, s3State}`） | `FakeWorkspacePersistence`（内存 map 当 baseline） | 新介质:实现 hydrate/sync 两方法,自定 session 内部形状 |
| `ProvisionSource` | `S3ProvisionSource` | `FakeProvisionSource` | 新来源:实现 project 一方法 + 注册进 map(kind→source) |

**S3WorkspacePersistence 就是现有 `SandboxToolExecutor.hydrate/sync` 两段代码搬家**：hydrate 的 list→writeFile→捕获 baseline→seed s3State;sync 的 full-scan→(新增 size+mtime 预筛)→content-hash push→baseline-diff delete。逻辑不变,只是从 executor 私有方法变成 adapter 方法,baseline 从字段变成 opaque session 内部字段。

---

## 6. 调用方：SessionRouter 收敛

现状（`session-router.ts`）这些**消失**：`sessionExecutors` Map 的绑定语义、`getExecutorForSession`、`resolveWorkspaceBinding`、`disposeExecutor`、`syncWorkspace` 的 40 行、`DisposableToolExecutor` 结构类型、`materializeSkills` 整套 Host 临时目录 + 每 turn cleanup。

```ts
// deps: sandboxManager?: SandboxManager   (替换 toolExecutorFactory)
private readonly sessions = new Map<string, SandboxSession>();  // 仅复用查找,不含 lifecycle

private specFor(session: Session, agent: Agent): EnvSpec {
  return {
    tenantId: session.tenantId,
    workspaceId: session.workspaceId,
    image: agent.sandbox?.image,
    env: agent.sandbox?.env,
    projections: (agent.skills ?? []).map((id) => ({
      targetPath: `/skills/${id}`,
      source: { kind: "s3", ref: { /* skill 的 S3 坐标 */ } },
    })),
  };
}

private sandboxFor(sessionId, session, agent): SandboxSession | undefined {
  if (!this.sandboxManager || agent.sandbox?.enabled === false) return undefined;
  let s = this.sessions.get(sessionId);
  if (!s) { s = this.sandboxManager.open(this.specFor(session, agent)); this.sessions.set(sessionId, s); }
  return s;   // 懒:此时未真起沙箱
}

// buildAdapterInput 里:toolExecutor = sandbox(session 本身就是 ToolExecutor)
// turn 末检查点:
if (sandbox) { const r = await sandbox.checkpoint(); if (syncHasChanges(r)) this.emitFileChange(sessionId, r); }
// terminateSession:
const s = this.sessions.get(sessionId); this.sessions.delete(sessionId);
if (s) { const r = await s.dispose(); if (syncHasChanges(r)) this.emitFileChange(sessionId, r); }
```

`isSandboxedButUnprovisionable` 缩成一行 fail-loud（Host 的 mandatoriness 决策,留 Router）。**Skills 从 Host 临时目录改为只读投影**（ADR-0005 §4）：`specFor` 声明 `projections`,不再 `materializeSkills`。

---

## 7. deletion test（每个 module 是否在集中复杂度）

- 删 `SandboxSession.dispose` 的 pre-sync → Session 结束丢最后一 turn 文件,重开见陈旧 workspace。**承重**。
- 删原语路径里的自愈 → >1h 后首个工具调用抛 `SandboxNotFoundError`,破坏透明保活。**承重**。
- 删 `targetPath` 在 workspace 外的不变量 → 投影被 sync 当用户文件回写,污染 Workspace。**承重**。
- 删 `SyncResult` 返回(改 void) → Router 无法发 `file_change`,文件树不刷新。**承重**。
- 删 `WorkspacePersistence`、内联 S3 → module 知道了介质,违反"介质是唯一扩展赌注"。**承重**（即便 S3 是唯一实现）。
- 删 `list`/`reclaim` → 今天什么都不坏（无 sweep）。**当下不承重**——诚实标注为预留。

---

## 8. 落地顺序（小步、可回退）

1. 抽 `WorkspacePersistence` seam：把 `SandboxToolExecutor.hydrate/sync` 搬成 `S3WorkspacePersistence`,baseline 进 opaque session。旧 executor 暂时调用它,行为不变（纯重构,现有测试守住）。
2. 抽 `ProvisionSource` + `S3ProvisionSource`。
3. 建 `SandboxManager` + `SandboxSession`：把 executor 的 lifecycle/自愈上浮进来;`SandboxSession` 内部持有 `SandboxClient` + `persistence` + `provisionSources`。
4. Router 切换：`toolExecutorFactory` → `sandboxManager`,`sessionExecutors` → `sessions`,删 `materializeSkills`,Skills 走 `projections`。
5. 删旧 `SandboxToolExecutor` / `SandboxToolExecutorFactory` / `WorkspaceBinding` 导出,更新 `index.ts`。
6. Pi 工具改用方案 1（注入 `*Operations`）—— 独立于本次,可并行。
