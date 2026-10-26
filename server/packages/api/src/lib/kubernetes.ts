import { readFile } from "node:fs/promises";
import { isIP } from "node:net";
import { Agent, fetch } from "undici";

/**
 * The Kubernetes REST API as a pod's own ServiceAccount sees it: the image
 * builder's build pods and Warm Pool, the Host's platform-secret reader.
 */
export interface KubernetesApi {
  /**
   * A JSON request (`contentType` for a PATCH, such as
   * `application/json-patch+json`); rejects with {@link KubernetesApiError}
   * on a non-2xx answer. Times out after 30 s unless `timeoutMs` says otherwise.
   */
  request<T = unknown>(method: KubernetesMethod, path: string, options?: KubernetesRequestOptions): Promise<T>;
  /** A streamed GET (pod logs with `follow=true`); the body as it arrives. */
  stream(path: string, signal: AbortSignal): Promise<AsyncIterable<Uint8Array>>;
  /** Close the connections; the client is unusable afterwards. */
  close(): Promise<void>;
}

export interface KubernetesRequestOptions {
  body?: unknown;
  contentType?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
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

export type KubernetesMethod = "GET" | "POST" | "DELETE" | "PATCH";

export const isNotFound = (error: unknown) => error instanceof KubernetesApiError && error.status === 404;
export const isConflict = (error: unknown) => error instanceof KubernetesApiError && error.status === 409;

const SERVICE_ACCOUNT = "/var/run/secrets/kubernetes.io/serviceaccount";
const REQUEST_MS = 30_000;
const CREDENTIALS_UNREADABLE = "The Kubernetes service account credentials could not be read";

type HostEnv = Readonly<Record<string, string | undefined>>;

/** `https://<KUBERNETES_SERVICE_HOST>:<KUBERNETES_SERVICE_PORT_HTTPS>`, both checked. */
function apiServerOrigin(env: HostEnv): string {
  const host = env.KUBERNETES_SERVICE_HOST?.trim();
  const port = env.KUBERNETES_SERVICE_PORT_HTTPS?.trim() || "443";
  if (!host || (!isIP(host) && !/^[A-Za-z0-9.-]+$/.test(host))) throw new Error("In-cluster Kubernetes access requires a valid KUBERNETES_SERVICE_HOST");
  if (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535) throw new Error("In-cluster Kubernetes access requires a valid KUBERNETES_SERVICE_PORT_HTTPS");
  return `https://${isIP(host) === 6 ? `[${host}]` : host}:${port}`;
}

/**
 * The API server from inside a pod: its ServiceAccount token (re-read on
 * every call, since the kubelet rotates it) and CA, on a dispatcher of its
 * own so no HTTP proxy is ever used. Every error names the call and never
 * carries a credential, a response body (beyond a Status's reason and
 * message) or a lower-level error's text: an aborted call rejects with its
 * signal's reason, a failed one with what failed.
 */
export async function inClusterKubernetesApi(env: HostEnv = process.env): Promise<KubernetesApi> {
  const origin = apiServerOrigin(env);
  let ca: string;
  try {
    ca = await readFile(`${SERVICE_ACCOUNT}/ca.crt`, "utf8");
  } catch {
    throw new Error(CREDENTIALS_UNREADABLE);
  }
  if (!ca.trim()) throw new Error(CREDENTIALS_UNREADABLE);
  let dispatcher: Agent;
  try {
    dispatcher = new Agent({ connect: { ca } });
  } catch {
    throw new Error("The Kubernetes TLS client could not be initialized");
  }
  const token = async () => {
    let value = "";
    try { value = (await readFile(`${SERVICE_ACCOUNT}/token`, "utf8")).trim(); } catch { /* reported below */ }
    if (!value) throw new Error(CREDENTIALS_UNREADABLE);
    return value;
  };

  const send = async (method: string, path: string, body: unknown, signal: AbortSignal, contentType = "application/json") => {
    const call = `Kubernetes ${method} ${path.split("?")[0]}`;
    const authorization = `Bearer ${await token()}`;
    let response;
    try {
      response = await fetch(`${origin}${path}`, {
        method,
        headers: {
          Authorization: authorization,
          Accept: "application/json",
          ...(body === undefined ? {} : { "Content-Type": contentType }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        dispatcher,
        signal,
        redirect: "error",
      });
    } catch {
      if (signal.aborted) throw signal.reason;
      throw new Error(`${call}: the request failed or timed out`);
    }
    if (response.ok) return { response, call };
    let status: { reason?: string; message?: string } = {};
    try { status = await response.json() as typeof status; } catch { /* not a Status */ }
    const reason = typeof status.reason === "string" ? status.reason : "";
    const detail = typeof status.message === "string" ? status.message : "";
    throw new KubernetesApiError(response.status, reason, `${call} answered HTTP ${response.status}${reason ? ` ${reason}` : ""}${detail ? `: ${detail}` : ""}`);
  };

  return {
    async request<T>(method: KubernetesMethod, path: string, options: KubernetesRequestOptions = {}) {
      const timeout = AbortSignal.timeout(options.timeoutMs ?? REQUEST_MS);
      const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
      const { response, call } = await send(method, path, options.body, signal, options.contentType);
      try {
        return await response.json() as T;
      } catch {
        if (signal.aborted) throw signal.reason;
        throw new Error(`${call}: the response could not be decoded`);
      }
    },
    async stream(path, signal) {
      const { response } = await send("GET", path, undefined, signal);
      if (!response.body) return (async function* () {})();
      return response.body as AsyncIterable<Uint8Array>;
    },
    async close() {
      try {
        await dispatcher.close();
      } catch {
        throw new Error("The Kubernetes client could not be closed");
      }
    },
  };
}
