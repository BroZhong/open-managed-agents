// Sandbox backend = the official `e2b` Node SDK against a self-hosted gateway
// (#53, replacing the abandoned kruise-CRD client). The `@alibaba-group/
// opensandbox` model is intentionally NOT here.

export type {
  SandboxClient,
  SandboxHandle,
  SandboxClaim,
  SandboxCreateOptions,
  SandboxExecChunk,
  SandboxExecOptions,
  SandboxFileEntry,
  SandboxListFilter,
  ListedSandbox,
} from "./sandbox-client.js";

export {
  CLAIM_SECONDS,
  WAIT_READY_SECONDS,
  CREATE_REQUEST_MS,
  INTENT_DEADLINE_SECONDS,
  SandboxCreateRejected,
  CLAIM_IMAGE_METADATA,
  isDigestPinnedImage,
} from "./sandbox-client.js";

export {
  SANDBOX_BINDING_LABEL,
  SANDBOX_ENVIRONMENT_LABEL,
  SWEEP_MAX_KILLS,
  selectSweep,
  type SandboxEnvironment,
  type SweepBinding,
  type SweepOptions,
  type SweepDecision,
  type SweepKillReason,
  type SweepKeepReason,
  type SweepCounts,
  type SweepSelection,
} from "./sandbox-sweep.js";

export { killSandboxes, killBindingSandboxes, type SandboxKills } from "./sandbox-kill.js";

export { SandboxSweeper, SWEEP_INTERVAL_MS, SWEEP_JITTER_MS, type SandboxSweeperDeps, type SweepRound } from "./sandbox-sweeper.js";

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
  type FakeCreateFault,
} from "./fake-sandbox-client.js";

export {
  WorkspaceMountUnavailable,
  type WorkspaceMountSpec,
  type WorkspaceMountTarget,
} from "./workspace-mount.js";

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
  DefaultSandboxManager,
  CommandVariablesUnavailable,
  SandboxSessionClosed,
  SandboxUnavailable,
  type SandboxUnavailableReason,
  type SandboxPrepareObserver,
  type SandboxPrepareOutcome,
  type SandboxManager,
  type SandboxSession,
  type SandboxManagerDeps,
  type SandboxDescriptor,
  type EnvSpec,
  type CommandVariables,
  type SandboxBinding,
  type PrepareOptions,
  type SkillInstallObserver,
} from "./sandbox-manager.js";

export { BINDING_REREAD_MS, type SandboxSignals } from "./sandbox-signals.js";

export {
  DefaultTurnSandboxes,
  isSandboxedAgent,
  type TurnSandboxes,
  type TurnSandboxesDeps,
  type SandboxEnvironments,
  type SandboxLease,
  type SandboxLeaseRequest,
  type TurnSettlement,
} from "./turn-sandboxes.js";

export { skillsInstallFailedText, type TurnExecutorGuard } from "./turn-executor.js";

export { WORKSPACE_ENV, WORKSPACE_INSTRUCTIONS } from "./workspace-environment.js";

export { ENVIRONMENT_VARIABLE_NAME, PLATFORM_DEFAULT_ENV, isReservedEnvironmentVariable } from "./environment-variables.js";
