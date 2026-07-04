// Sandbox backend = OpenKruise `agents.kruise.io` CRD (ADR-0002 §4, #37 spike).
// The abandoned `@alibaba-group/opensandbox` model is intentionally NOT here.

export type {
  SandboxClient,
  SandboxHandle,
  SandboxCreateOptions,
  SandboxExecChunk,
  SandboxExecOptions,
  SandboxFileEntry,
} from "./sandbox-client.js";

export {
  KruiseSandboxClient,
  parseFindOutput,
  type KruiseSandboxClientOptions,
  type CommandRunner,
  type StreamRunner,
} from "./kruise-sandbox-client.js";

export {
  FakeSandboxClient,
  type FakeSandboxClientOptions,
} from "./fake-sandbox-client.js";

export {
  SandboxToolExecutor,
  type SandboxToolExecutorOptions,
} from "./sandbox-tool-executor.js";

export {
  contentHash,
  syncHasChanges,
  type WorkspaceSyncResult,
} from "./workspace-sync.js";

export {
  SandboxToolExecutorFactory,
  type SandboxToolExecutorFactoryOptions,
  type ToolExecutorFactory,
  type WorkspaceBinding,
} from "./sandbox-tool-executor-factory.js";
