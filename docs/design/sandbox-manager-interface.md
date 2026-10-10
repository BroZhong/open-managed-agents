# Sandbox Manager interface

Current contracts: [ADR-0019](../adr/0019-native-sandbox-lifecycle.md) for lifetime and [ADR-0008](../adr/0008-oss-mounted-workspaces.md) for mounts, superseding the hydrate/sync design in ADR-0005.

The Host resolves ownership, computes the OSS prefix and supplies the Environment Spec. The Manager creates a Sandbox lazily, verifies the mount during Turn preparation, refreshes Skills, recovers Paused or confirmed missing resources and disposes execution resources. The Adapter uses a per-Turn injected ToolExecutor and knows no storage SDK.

```ts
interface EnvSpec {
  tenantId: string;
  workspaceId: string;
  workspaceMount: {
    bucket: string;
    prefix: string; // workspaceObjectPrefix(tenantId, workspaceId), trailing slash
    agentName: string;
    pvName: string;
    credentialProviderName: string;
  };
  image?: string;
  env?: Record<string, string>;
  projections?: readonly ReadonlyProjection[];
}

interface SandboxManager {
  open(spec: EnvSpec): SandboxSession;
  list(filter?: { tenantId?: string; workspaceId?: string }): Promise<SandboxDescriptor[]>;
  reclaim(sandboxId: string): Promise<void>;
}

interface SandboxSession extends ToolExecutor {
  prepare(projections?: readonly ReadonlyProjection[]): Promise<void>;
  checkWorkspace(): Promise<void>;
  dispose(): Promise<void>;
}
```

`open` starts no Sandbox. `prepare` checks an existing mount and reconciles Skills; cold Sessions remain cold. Normal filesystem/command operations reuse the prepared handle. Only an exceptional tool failure queries control-plane state; the failed operation is never replayed. `checkWorkspace` reports known uncertainty without a network probe or file scan. It is not a saved-files receipt. `dispose` destroys only execution resources; successfully closed Workspace writes already exist in OSS. Failed disposal retains the handle for a cleanup retry.

The current `list` hook remains an unimplemented lifecycle reservation, as before; there is no active orphan sweep. TTL bounds abandoned instances. It must not be used as a production active-Session inventory: use Session metadata and the actual cluster Sandbox list for maintenance.

Mount verification lives behind SandboxClient. The real E2B client checks gateway identity metadata, resolves the deployed CSI symlink and checks fuse.ossfs as UID/GID1000. It writes/closes a fresh reserved probe, calls a Host-injected OSS readback verifier for the expected prefix, then removes the probe in `finally`. There is no local fallback.

Skills use `ReadonlyProjection {targetPath, source:{kind,ref}}` with targets `/skills/<skill-name>`. The source remains `{kind:"s3", ref:{tenantId,skillId}}`; Supabase IDs never become Sandbox Skill path components. Target paths cannot overlap or contain the Workspace mount. Desired and previously applied projection paths are reconciled across failed refresh attempts, including renamed or removed Skills.

The Workspace root is `/home/user/workspace`; absolute local HOME paths remain accessible to tools for supported dependency installation. Files outside the mount are disposable. There is no WorkspacePersistence, Baseline, SyncResult, dirty state, checkpoint or file-change delta. Web refresh follows Turn completion. The Host handles an end-of-Turn storage diagnostic independently of the completed answer.
