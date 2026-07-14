export interface SandboxEnvPolicy {
  /** Deployment defaults that an Agent may override per key. */
  defaultSandboxEnv?: Record<string, string>;
  /** Host-managed values that stay authoritative over Agent configuration. */
  managedSandboxEnv?: Record<string, string>;
}

type HostEnv = Readonly<Record<string, string | undefined>>;

function nonBlank(env: HostEnv, name: string): string | undefined {
  const value = env[name]?.trim();
  return value ? value : undefined;
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
  const managedSandboxEnv: Record<string, string> = {};

  const vfsToken = nonBlank(env, "DEFAULT_SANDBOX_VFS_TOKEN");
  if (vfsToken) defaultSandboxEnv.VFS_TOKEN = vfsToken;

  const wwBaseUrl = nonBlank(env, "DEFAULT_SANDBOX_OPENGROVE_WW_BASE_URL");
  const wwAccessToken = nonBlank(
    env,
    "DEFAULT_SANDBOX_OPENGROVE_WW_ACCESS_TOKEN",
  );

  if (Boolean(wwBaseUrl) !== Boolean(wwAccessToken)) {
    throw new Error(
      "Managed OpenGrove WW sandbox configuration requires both " +
        "DEFAULT_SANDBOX_OPENGROVE_WW_BASE_URL and " +
        "DEFAULT_SANDBOX_OPENGROVE_WW_ACCESS_TOKEN",
    );
  }

  if (wwBaseUrl && wwAccessToken) {
    managedSandboxEnv.OPENGROVE_WW_BASE_URL = wwBaseUrl;
    managedSandboxEnv.OPENGROVE_WW_ACCESS_TOKEN = wwAccessToken;
  }

  return {
    ...(Object.keys(defaultSandboxEnv).length > 0 ? { defaultSandboxEnv } : {}),
    ...(Object.keys(managedSandboxEnv).length > 0 ? { managedSandboxEnv } : {}),
  };
}
