import { WORKSPACE_ENV } from "./workspace-environment.js";

/**
 * Environment variables (ADR-0024, "Environment variables"). A Sandbox
 * command sees, lowest first: the platform defaults, its Environment's
 * variables, then the Workspace variables. System-reserved names are rejected
 * when an Environment is saved, never silently overridden.
 */

/** A name a POSIX shell can export. */
export const ENVIRONMENT_VARIABLE_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Deployment-level defaults every Environment starts from, at the lowest
 * priority: package managers use the Aliyun mirrors that Sandboxes and build
 * pods reach directly. An Environment variable of the same name overrides one.
 */
export const PLATFORM_DEFAULT_ENV: Readonly<Record<string, string>> = Object.freeze({
  PIP_INDEX_URL: "https://mirrors.aliyun.com/pypi/simple/",
  NPM_CONFIG_REGISTRY: "https://registry.npmmirror.com",
});

/**
 * Names an Environment may not set:
 * - the Workspace variables (`WORKSPACE_ENV`), which the Host injects last;
 * - names the login shell (`bash -l -c`) sets or reads to start every
 *   command: its identity and working directory, `PATH` (the profile resets
 *   it; extend it from the init script in `/etc/profile.d`), the startup
 *   files `ENV`/`BASH_ENV`, word splitting, tracing and read-only bash state;
 * - `LD_PRELOAD`, which would load into the platform's tool runtime.
 */
const RESERVED_NAMES: ReadonlySet<string> = new Set([
  ...Object.keys(WORKSPACE_ENV),
  "PATH", "USER", "LOGNAME", "SHELL", "PWD", "OLDPWD", "SHLVL", "HOSTNAME",
  "UID", "EUID", "PPID", "IFS", "ENV", "BASH_ENV", "PS4", "PROMPT_COMMAND",
  "SHELLOPTS", "BASHOPTS", "BASHPID", "LD_PRELOAD",
]);

/**
 * Prefixes the platform owns: `OMA_` (the Host's own variables), `E2B_` and
 * `ENVD_` (the Sandbox daemon's), `BASH_` (bash's own state).
 */
const RESERVED_PREFIXES = ["OMA_", "E2B_", "ENVD_", "BASH_"] as const;

export function isReservedEnvironmentVariable(name: string): boolean {
  return RESERVED_NAMES.has(name) || RESERVED_PREFIXES.some((prefix) => name.startsWith(prefix));
}
