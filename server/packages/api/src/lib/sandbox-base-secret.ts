import { readFile } from "node:fs/promises";
import { isIP } from "node:net";
import { Agent, fetch } from "undici";

type HostEnv = Readonly<Record<string, string | undefined>>;

const serviceAccountPath = "/var/run/secrets/kubernetes.io/serviceaccount";
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

/** Load deployment-owned sandbox defaults directly from the named Kubernetes Secret. */
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

  const host = env.KUBERNETES_SERVICE_HOST?.trim();
  const port = env.KUBERNETES_SERVICE_PORT_HTTPS?.trim() || "443";
  if (!host || (!isIP(host) && !/^[A-Za-z0-9.-]+$/.test(host))) {
    throw new Error("Sandbox base Secret configuration requires a valid KUBERNETES_SERVICE_HOST");
  }
  if (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535) {
    throw new Error("Sandbox base Secret configuration requires a valid KUBERNETES_SERVICE_PORT_HTTPS");
  }
  const authority = isIP(host) === 6 ? `[${host}]` : host;
  const url = `https://${authority}:${port}/api/v1/namespaces/${encodeURIComponent(namespace)}/secrets/${encodeURIComponent(name)}`;

  let token: string;
  let ca: string;
  try {
    [token, ca] = await Promise.all([
      readFile(`${serviceAccountPath}/token`, "utf8"),
      readFile(`${serviceAccountPath}/ca.crt`, "utf8"),
    ]);
    token = token.trim();
    if (!token || !ca.trim()) throw new Error();
  } catch {
    throw new Error("Sandbox base Secret service account credentials could not be read");
  }

  let dispatcher: Agent;
  try {
    dispatcher = new Agent({ connect: { ca } });
  } catch {
    throw new Error("Sandbox base Secret TLS client could not be initialized");
  }
  try {
    let response;
    try {
      // Never use the Host's global proxy dispatcher for the cluster API.
      response = await fetch(url, {
        method: "GET",
        headers: { Authorization: `Bearer ${token}` },
        dispatcher,
        signal: AbortSignal.timeout(10_000),
        redirect: "error",
      });
    } catch {
      throw new Error("Sandbox base Secret request failed or timed out");
    }
    if (!response.ok) {
      // Release the body without reading or reporting its potentially sensitive text.
      await response.body?.cancel().catch(() => undefined);
      throw new Error(`Sandbox base Secret request failed with HTTP ${response.status}`);
    }
    let secret: unknown;
    try {
      secret = await response.json();
    } catch {
      throw new Error("Sandbox base Secret response could not be decoded");
    }
    return secretEnvironment(secret);
  } finally {
    try {
      await dispatcher.close();
    } catch {
      throw new Error("Sandbox base Secret client could not be closed");
    }
  }
}
