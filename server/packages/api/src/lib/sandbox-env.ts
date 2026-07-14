export interface SandboxEnvPolicy {
  /** Deployment defaults that an Agent may override per key. */
  defaultSandboxEnv?: Record<string, string>;
  /** Host-managed values scoped to explicitly allowed Agent ids. */
  managedSandboxEnvByAgentId?: Readonly<
    Record<string, Readonly<Record<string, string>>>
  >;
}

type HostEnv = Readonly<Record<string, string | undefined>>;

function nonBlank(env: HostEnv, name: string): string | undefined {
  const value = env[name]?.trim();
  return value ? value : undefined;
}

function commaSeparated(env: HostEnv, name: string): string[] {
  const value = nonBlank(env, name);
  if (!value) return [];
  return [...new Set(value.split(",").map((item) => item.trim()).filter(Boolean))];
}

/**
 * Build the environment inherited by Host-side adapter CLIs. Deployment-owned
 * sandbox values are intentionally excluded: they belong only in the
 * Sandbox.create env payload and must not spread to Claude/Codex subprocesses.
 */
export function adapterProcessEnvFromHost(
  env: HostEnv,
): Record<string, string | undefined> {
  return Object.fromEntries(
    Object.entries(env).filter(([name]) => !name.startsWith("DEFAULT_SANDBOX_")),
  );
}

/**
 * Translate Host deployment variables into the names exposed inside a sandbox.
 * Secret values remain process-local and are never persisted on an Agent.
 */
export function sandboxEnvPolicyFromHost(env: HostEnv): SandboxEnvPolicy {
  const defaultSandboxEnv: Record<string, string> = {};

  const vfsToken = nonBlank(env, "DEFAULT_SANDBOX_VFS_TOKEN");
  if (vfsToken) defaultSandboxEnv.VFS_TOKEN = vfsToken;

  const wwBaseUrl = nonBlank(env, "DEFAULT_SANDBOX_OPENGROVE_WW_BASE_URL");
  const wwAccessToken = nonBlank(
    env,
    "DEFAULT_SANDBOX_OPENGROVE_WW_ACCESS_TOKEN",
  );
  const wwAgentIds = commaSeparated(
    env,
    "DEFAULT_SANDBOX_OPENGROVE_WW_AGENT_IDS",
  );

  const hasAnyWwConfig = Boolean(wwBaseUrl || wwAccessToken || wwAgentIds.length);
  const hasCompleteWwConfig = Boolean(
    wwBaseUrl && wwAccessToken && wwAgentIds.length,
  );
  if (hasAnyWwConfig && !hasCompleteWwConfig) {
    throw new Error(
      "Managed OpenGrove WW sandbox configuration requires " +
        "DEFAULT_SANDBOX_OPENGROVE_WW_BASE_URL, " +
        "DEFAULT_SANDBOX_OPENGROVE_WW_ACCESS_TOKEN, and " +
        "DEFAULT_SANDBOX_OPENGROVE_WW_AGENT_IDS",
    );
  }

  let managedSandboxEnvByAgentId:
    | SandboxEnvPolicy["managedSandboxEnvByAgentId"]
    | undefined;
  if (wwBaseUrl && wwAccessToken && wwAgentIds.length > 0) {
    managedSandboxEnvByAgentId = Object.fromEntries(
      wwAgentIds.map((agentId) => [
        agentId,
        {
          OPENGROVE_WW_BASE_URL: wwBaseUrl,
          OPENGROVE_WW_ACCESS_TOKEN: wwAccessToken,
        },
      ]),
    );
  }

  return {
    ...(Object.keys(defaultSandboxEnv).length > 0 ? { defaultSandboxEnv } : {}),
    ...(managedSandboxEnvByAgentId ? { managedSandboxEnvByAgentId } : {}),
  };
}
