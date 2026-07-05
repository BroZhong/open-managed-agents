// Sandbox backend = the official `e2b` Node SDK against a self-hosted gateway
// (#53, replacing the abandoned kruise-CRD client). The `@alibaba-group/
// opensandbox` model is intentionally NOT here.

export type {
  SandboxClient,
  SandboxHandle,
  SandboxCreateOptions,
  SandboxExecChunk,
  SandboxExecOptions,
  SandboxFileEntry,
} from "./sandbox-client.js";

export {
  E2BSandboxClient,
  parseFindOutput,
  wrapCommand,
  type E2BSandboxClientOptions,
  type E2BSandbox,
  type CreateSandboxFn,
} from "./e2b-sandbox-client.js";

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
