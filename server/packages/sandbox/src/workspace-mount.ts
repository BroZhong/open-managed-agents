import { workspaceObjectPrefix } from "@oma-server/store";

/** Host-owned infrastructure recipe; never populated from browser mount paths. */
export interface WorkspaceMountSpec {
  bucket: string;
  /** Canonical object prefix, including the trailing slash. */
  prefix: string;
  agentName: string;
  pvName: string;
  credentialProviderName: string;
}

/** Expected mounted filesystem identity, checked by the sandbox backend. */
export interface WorkspaceMountTarget {
  mountPath: string;
  bucket: string;
  prefix: string;
}

/** Only fixed classifications and elapsed time; never SDK messages, URLs or causes. */
export interface WorkspaceMountDiagnostic {
  stage: "get_info" | "metadata" | "probe" | "readback" | "cleanup";
  category: "timeout" | "aborted" | "authentication" | "not_found" | "rate_limit" | "network" | "invalid_response" | "verification_failed" | "unknown";
  durationMs: number;
}

export class WorkspaceMountUnavailable extends Error {
  constructor(readonly diagnostic?: WorkspaceMountDiagnostic) {
    super(
      diagnostic?.stage === "get_info"
        ? "Sandbox metadata could not be queried. Workspace mount verification has not run; a later tool call can retry."
        : "Workspace storage is unavailable or its mount could not be verified. Saved files remain in storage; retry after storage recovers.",
    );
    this.name = "WorkspaceMountUnavailable";
  }
}

export function assertWorkspaceMountSpec(
  spec: WorkspaceMountSpec,
  tenantId: string,
  workspaceId: string,
): void {
  if (!spec || spec.prefix !== workspaceObjectPrefix(tenantId, workspaceId)) {
    throw new Error(
      "Workspace mount prefix does not match its Tenant and Workspace",
    );
  }
  if (
    ![
      spec.bucket,
      spec.agentName,
      spec.pvName,
      spec.credentialProviderName,
    ].every(
      (value) =>
        typeof value === "string" && /^[a-z0-9][a-z0-9.-]{0,252}$/.test(value),
    )
  ) {
    throw new Error(
      "Workspace mount requires valid bucket and identity resource names",
    );
  }
}

/** Exact CSI metadata protocol verified by the deployed E2B gateway. */
export function workspaceMountMetadata(
  spec: WorkspaceMountSpec,
  mountPath: string,
): Record<string, string> {
  return {
    "security.agents.kruise.io/agent-name": spec.agentName,
    "e2b.agents.kruise.io/csi-volume-config": JSON.stringify([
      {
        pvName: spec.pvName,
        mountPath,
        subPath: spec.prefix.slice(0, -1),
        attributes: { credentialProviderName: spec.credentialProviderName },
      },
    ]),
  };
}
