import type { ArtifactStore } from "@oma-server/store";
import type { SandboxClient, SandboxCreateOptions } from "./sandbox-client.js";
import { SandboxToolExecutor } from "./sandbox-tool-executor.js";

/** The (tenant, workspace) a session's executor is bound to. */
export interface WorkspaceBinding {
  tenantId: string;
  workspaceId: string;
  /** Optional per-agent sandbox image / kruise template. */
  image?: string;
  /** Optional env baked into the sandbox. */
  env?: Record<string, string>;
}

/**
 * Produces a fresh {@link SandboxToolExecutor} bound to a session's Workspace.
 *
 * This is the Host seam: the SessionRouter asks the factory for an executor,
 * injects it on `AdapterInput.toolExecutor` for that run, and disposes it at
 * session end. A new executor per session (never a shared mutable registry)
 * is what keeps concurrent sessions isolated — the FastClaw hazard the ADR
 * calls out.
 */
export interface ToolExecutorFactory {
  create(binding: WorkspaceBinding): SandboxToolExecutor;
}

export interface SandboxToolExecutorFactoryOptions {
  sandboxClient: SandboxClient;
  artifactStore: ArtifactStore;
  /** Absolute sandbox dir the Workspace hydrates into. Defaults to `/workspace`. */
  workspaceDir?: string;
  /** Base create options merged under per-binding overrides. */
  createOptions?: SandboxCreateOptions;
}

export class SandboxToolExecutorFactory implements ToolExecutorFactory {
  private readonly sandboxClient: SandboxClient;
  private readonly artifactStore: ArtifactStore;
  private readonly workspaceDir?: string;
  private readonly createOptions?: SandboxCreateOptions;

  constructor(opts: SandboxToolExecutorFactoryOptions) {
    this.sandboxClient = opts.sandboxClient;
    this.artifactStore = opts.artifactStore;
    this.workspaceDir = opts.workspaceDir;
    this.createOptions = opts.createOptions;
  }

  create(binding: WorkspaceBinding): SandboxToolExecutor {
    return new SandboxToolExecutor({
      sandboxClient: this.sandboxClient,
      artifactStore: this.artifactStore,
      tenantId: binding.tenantId,
      workspaceId: binding.workspaceId,
      workspaceDir: this.workspaceDir,
      createOptions: {
        ...this.createOptions,
        image: binding.image ?? this.createOptions?.image,
        env: { ...this.createOptions?.env, ...binding.env },
      },
    });
  }
}
