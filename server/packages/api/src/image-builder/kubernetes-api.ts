import { readFile } from "node:fs/promises";
import { isIP } from "node:net";
import { Agent, fetch } from "undici";

/** The Kubernetes REST calls the image builder makes (in-cluster, its own ServiceAccount). */
export interface KubernetesApi {
  /** A JSON request; rejects with {@link KubernetesApiError} on a non-2xx answer. */
  request<T = unknown>(method: "GET" | "POST" | "DELETE", path: string, options?: { body?: unknown; signal?: AbortSignal }): Promise<T>;
  /** A streamed GET (pod logs with `follow=true`); the body as it arrives. */
  stream(path: string, signal: AbortSignal): Promise<AsyncIterable<Uint8Array>>;
}

/**
 * A non-2xx answer: its status and the Status object's `reason` and
 * `message`, which name the resource and the rule, never a credential.
 */
export class KubernetesApiError extends Error {
  constructor(readonly status: number, readonly reason: string, message: string) {
    super(message);
    this.name = "KubernetesApiError";
  }
}

export const isNotFound = (error: unknown) => error instanceof KubernetesApiError && error.status === 404;
export const isConflict = (error: unknown) => error instanceof KubernetesApiError && error.status === 409;

const SERVICE_ACCOUNT = "/var/run/secrets/kubernetes.io/serviceaccount";
const REQUEST_MS = 30_000;

type HostEnv = Readonly<Record<string, string | undefined>>;

/**
 * The API server from inside a pod: its ServiceAccount token (re-read on
 * every call, since the kubelet rotates it) and CA, on a dispatcher of its
 * own so no HTTP proxy is ever used.
 */
export async function inClusterKubernetesApi(env: HostEnv = process.env): Promise<KubernetesApi> {
  const host = env.KUBERNETES_SERVICE_HOST?.trim();
  const port = env.KUBERNETES_SERVICE_PORT_HTTPS?.trim() || "443";
  if (!host || (!isIP(host) && !/^[A-Za-z0-9.-]+$/.test(host))) throw new Error("The image builder requires a valid KUBERNETES_SERVICE_HOST");
  if (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535) throw new Error("The image builder requires a valid KUBERNETES_SERVICE_PORT_HTTPS");
  const origin = `https://${isIP(host) === 6 ? `[${host}]` : host}:${port}`;
  const ca = await readFile(`${SERVICE_ACCOUNT}/ca.crt`, "utf8");
  const dispatcher = new Agent({ connect: { ca } });
  const token = async () => {
    const value = (await readFile(`${SERVICE_ACCOUNT}/token`, "utf8")).trim();
    if (!value) throw new Error("The image builder's ServiceAccount token is empty");
    return value;
  };

  const send = async (method: string, path: string, body: unknown, signal: AbortSignal) => {
    const response = await fetch(`${origin}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${await token()}`,
        Accept: "application/json",
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      dispatcher,
      signal,
      redirect: "error",
    });
    if (response.ok) return response;
    let status: { reason?: string; message?: string } = {};
    try { status = await response.json() as typeof status; } catch { /* not a Status */ }
    throw new KubernetesApiError(response.status, status.reason ?? "", `Kubernetes ${method} ${path.split("?")[0]} answered ${response.status}${status.reason ? ` ${status.reason}` : ""}: ${status.message ?? ""}`.trimEnd());
  };

  return {
    async request<T>(method: "GET" | "POST" | "DELETE", path: string, options: { body?: unknown; signal?: AbortSignal } = {}) {
      const signal = options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(REQUEST_MS)]) : AbortSignal.timeout(REQUEST_MS);
      const response = await send(method, path, options.body, signal);
      return await response.json() as T;
    },
    async stream(path, signal) {
      const response = await send("GET", path, undefined, signal);
      if (!response.body) return (async function* () {})();
      return response.body as AsyncIterable<Uint8Array>;
    },
  };
}
