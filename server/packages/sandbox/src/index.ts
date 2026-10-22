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
  type FakeSkillInstallFault,
} from "./fake-sandbox-client.js";

export {
  WorkspaceMountUnavailable,
  type WorkspaceMountSpec,
  type WorkspaceMountTarget,
} from "./workspace-mount.js";
export type { SandboxFsAccess } from "./sandbox-client.js";

export {
  EMPTY_SKILL_SET,
  SKILLS_PATH,
  SKILLS_ROOT,
  SKILL_INSTALL_COMMAND,
  DEFAULT_SKILL_INSTALL_THROUGHPUT,
  MIN_SKILL_INSTALL_BUDGET_MS,
  SkillInstallError,
  isSkillInstallCommand,
  redactUrls,
  skillSetOf,
  skillInstallBudgetMs,
  type SkillSet,
  type SkillSetMember,
  type SkillInstallStage,
  type SkillInstallReport,
  type SkillInstallBudget,
} from "./skill-install.js";

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
  type SandboxEnvironmentBinding,
} from "./sandbox-manager.js";
