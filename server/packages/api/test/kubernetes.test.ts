import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const close = vi.fn();
  const dispatcher = { close };
  return {
    readFile: vi.fn(),
    fetch: vi.fn(),
    close,
    dispatcher,
    Agent: vi.fn(function () { return dispatcher; }),
  };
});

vi.mock("node:fs/promises", () => ({ readFile: mocks.readFile }));
vi.mock("undici", () => ({ Agent: mocks.Agent, fetch: mocks.fetch }));

import { inClusterKubernetesApi, isConflict, isNotFound, KubernetesApiError } from "../src/lib/kubernetes.js";

const ENV = { KUBERNETES_SERVICE_HOST: "10.96.0.1" };
const TOKEN = "service-account-token-sentinel";
let tokens: string[];

beforeEach(() => {
  vi.clearAllMocks();
  tokens = [TOKEN];
  mocks.readFile.mockImplementation(async (path: string) => (path.endsWith("/token") ? `${tokens.shift() ?? TOKEN}\n` : "cluster-ca"));
  mocks.Agent.mockImplementation(function () { return mocks.dispatcher; });
  mocks.close.mockResolvedValue(undefined);
  mocks.fetch.mockImplementation(async () => new Response(JSON.stringify({ kind: "Pod" })));
});

describe("inClusterKubernetesApi", () => {
  it.each([
    [{}, "KUBERNETES_SERVICE_HOST"],
    [{ KUBERNETES_SERVICE_HOST: "https://evil.example" }, "KUBERNETES_SERVICE_HOST"],
    [{ ...ENV, KUBERNETES_SERVICE_PORT_HTTPS: "65536" }, "KUBERNETES_SERVICE_PORT_HTTPS"],
  ])("checks the API server address before reading any credential", async (env, message) => {
    await expect(inClusterKubernetesApi(env)).rejects.toThrow(message);
    expect(mocks.readFile).not.toHaveBeenCalled();
  });

  it("sends JSON as the ServiceAccount, re-reading its token on every call, on its own dispatcher", async () => {
    const api = await inClusterKubernetesApi({ KUBERNETES_SERVICE_HOST: "fd00::1", KUBERNETES_SERVICE_PORT_HTTPS: "6443" });
    expect(mocks.Agent).toHaveBeenCalledWith({ connect: { ca: "cluster-ca" } });
    tokens = ["first", "rotated"];
    await expect(api.request("GET", "/api/v1/namespaces/ns/pods/p")).resolves.toEqual({ kind: "Pod" });
    await api.request("PATCH", "/apis/x/v1/things/t", { body: [{ op: "replace", path: "/a", value: 1 }], contentType: "application/json-patch+json" });
    expect(mocks.fetch.mock.calls[0]).toEqual(["https://[fd00::1]:6443/api/v1/namespaces/ns/pods/p", {
      method: "GET", headers: { Authorization: "Bearer first", Accept: "application/json" }, body: undefined,
      dispatcher: mocks.dispatcher, signal: expect.any(AbortSignal), redirect: "error",
    }]);
    expect(mocks.fetch.mock.calls[1]![1]).toMatchObject({
      method: "PATCH", body: JSON.stringify([{ op: "replace", path: "/a", value: 1 }]),
      headers: { Authorization: "Bearer rotated", "Content-Type": "application/json-patch+json" },
    });
  });

  it("rejects a non-2xx answer with its status and the Status's reason and message, without the query", async () => {
    const api = await inClusterKubernetesApi(ENV);
    mocks.fetch.mockResolvedValueOnce(new Response(JSON.stringify({ kind: "Status", reason: "NotFound", message: "pods \"p\" not found" }), { status: 404 }));
    const error = await api.request("GET", "/api/v1/namespaces/ns/pods/p?labelSelector=a%3Db").catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(KubernetesApiError);
    expect(error).toMatchObject({ status: 404, reason: "NotFound", message: "Kubernetes GET /api/v1/namespaces/ns/pods/p answered HTTP 404 NotFound: pods \"p\" not found" });
    expect(isNotFound(error)).toBe(true);
    mocks.fetch.mockResolvedValueOnce(new Response("not a Status", { status: 409 }));
    const conflict = await api.request("POST", "/api/v1/namespaces/ns/pods", { body: {} }).catch((caught: unknown) => caught);
    expect(isConflict(conflict)).toBe(true);
    expect(String(conflict)).toBe("KubernetesApiError: Kubernetes POST /api/v1/namespaces/ns/pods answered HTTP 409");
  });

  it("rejects an aborted call with its signal's reason, and a failed one without the failure's text", async () => {
    const api = await inClusterKubernetesApi(ENV);
    const stop = new AbortController();
    const reason = new Error("build stopped");
    mocks.fetch.mockImplementationOnce(async (_url: string, init: { signal: AbortSignal }) => {
      stop.abort(reason);
      throw init.signal.reason;
    });
    await expect(api.request("DELETE", "/api/v1/namespaces/ns/pods/p", { signal: stop.signal })).rejects.toBe(reason);

    mocks.fetch.mockRejectedValueOnce(Object.assign(new Error(`connect ECONNREFUSED ${TOKEN}`), { cause: TOKEN }));
    const failed = await api.request("GET", "/api/v1/namespaces/ns/pods").catch((caught: unknown) => caught);
    expect(String(failed)).toBe("Error: Kubernetes GET /api/v1/namespaces/ns/pods: the request failed or timed out");
    expect(failed).not.toHaveProperty("cause");
    mocks.fetch.mockResolvedValueOnce(new Response(`{${TOKEN}`));
    await expect(api.request("GET", "/api/v1/namespaces/ns/pods")).rejects.toThrow(/^Kubernetes GET \/api\/v1\/namespaces\/ns\/pods: the response could not be decoded$/);
  });

  it("never calls without a token, streams a body as it arrives and closes its dispatcher", async () => {
    const api = await inClusterKubernetesApi(ENV);
    tokens = [" "];
    await expect(api.request("GET", "/api/v1/namespaces/ns/pods")).rejects.toThrow("service account credentials could not be read");
    expect(mocks.fetch).not.toHaveBeenCalled();

    mocks.fetch.mockResolvedValueOnce(new Response("line 1\nline 2\n"));
    let text = "";
    for await (const chunk of await api.stream("/api/v1/namespaces/ns/pods/p/log?follow=true", new AbortController().signal)) text += Buffer.from(chunk).toString();
    expect(text).toBe("line 1\nline 2\n");

    await api.close();
    expect(mocks.close).toHaveBeenCalledOnce();
    mocks.close.mockRejectedValueOnce(new Error(TOKEN));
    await expect(api.close()).rejects.toThrow(/^The Kubernetes client could not be closed$/);
  });
});
