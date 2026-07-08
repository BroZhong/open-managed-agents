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
  contentHash,
  syncHasChanges,
  type WorkspaceSyncResult,
} from "./workspace-sync.js";

export {
  S3WorkspacePersistence,
  FakeWorkspacePersistence,
  type WorkspacePersistence,
  type HydrateTarget,
  type HydrationSession,
  type SandboxFsAccess,
  type SandboxFsEntry,
  type SyncResult,
} from "./workspace-persistence.js";

export {
  S3ProvisionSource,
  FakeProvisionSource,
  isInsideWorkspace,
  assertProjectionOutsideWorkspace,
  type ProvisionSource,
  type ProvisionCoordinate,
  type ReadonlyProjection,
  type ProjectionTarget,
  type S3ProvisionRef,
} from "./provision-source.js";

export {
  DefaultSandboxManager,
  SandboxSessionClosed,
  type SandboxManager,
  type SandboxSession,
  type SandboxManagerDeps,
  type SandboxDescriptor,
  type EnvSpec,
} from "./sandbox-manager.js";
