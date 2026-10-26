import { inClusterKubernetesApi, KubernetesApiError } from "./kubernetes.js";

type HostEnv = Readonly<Record<string, string | undefined>>;

const environmentName = /^[A-Za-z_][A-Za-z0-9_]*$/;
const base64Value = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

function secretEnvironment(secret: unknown): Record<string, string> {
  if (!secret || typeof secret !== "object" || Array.isArray(secret) ||
      !("data" in secret) || !secret.data || typeof secret.data !== "object" ||
      Array.isArray(secret.data)) {
    throw new Error("Sandbox base Secret must contain environment entries in data");
  }

  const entries: [string, string][] = [];
  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
  for (const [name, encoded] of Object.entries(secret.data)) {
    // File entries such as source.env are not environment variables.
    if (!environmentName.test(name)) continue;
    if (typeof encoded !== "string" || !base64Value.test(encoded)) {
      throw new Error("Sandbox base Secret environment values must be base64 strings");
    }
    const bytes = Buffer.from(encoded, "base64");
    if (bytes.toString("base64") !== encoded) {
      throw new Error("Sandbox base Secret environment values must be base64 strings");
    }
    let value: string;
    try {
      value = decoder.decode(bytes);
    } catch {
      throw new Error("Sandbox base Secret environment values must be valid UTF-8");
    }
    if (value.includes("\0")) {
      throw new Error("Sandbox base Secret environment values must not contain NUL");
    }
    entries.push([name, value]);
  }
  if (entries.length === 0) {
    throw new Error("Sandbox base Secret must contain at least one valid environment entry");
  }
  return Object.fromEntries(entries);
}

/**
 * Load deployment-owned sandbox defaults directly from the named Kubernetes
 * Secret, through the pod's ServiceAccount (`kubernetes.ts`). Errors name
 * what failed, never a value, a credential or the response body.
 */
export async function sandboxBaseEnvFromKubernetes(
  env: HostEnv = process.env,
): Promise<Record<string, string>> {
  const namespace = env.SANDBOX_BASE_SECRET_NAMESPACE?.trim();
  const name = env.SANDBOX_BASE_SECRET_NAME?.trim();
  if (!namespace && !name) return {};
  if (!namespace || !name) {
    throw new Error(
      "Sandbox base Secret configuration requires SANDBOX_BASE_SECRET_NAMESPACE and SANDBOX_BASE_SECRET_NAME",
    );
  }

  // The client's messages carry no credential and no body; a Status's text
  // is dropped too, so a failed read reports only its HTTP status.
  const failed = (error: unknown): never => {
    throw new Error(error instanceof KubernetesApiError
      ? `Sandbox base Secret request failed with HTTP ${error.status}`
      : `Sandbox base Secret: ${error instanceof Error ? error.message : "request failed"}`);
  };
  const api = await inClusterKubernetesApi(env).catch(failed);
  try {
    const secret = await api.request(
      "GET",
      `/api/v1/namespaces/${encodeURIComponent(namespace)}/secrets/${encodeURIComponent(name)}`,
      { timeoutMs: 10_000 },
    ).catch(failed);
    return secretEnvironment(secret);
  } finally {
    await api.close().catch(failed);
  }
}
