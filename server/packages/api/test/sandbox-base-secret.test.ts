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

import { sandboxBaseEnvFromKubernetes } from "../src/lib/sandbox-base-secret.js";

const configuredEnv = {
  SANDBOX_BASE_SECRET_NAMESPACE: "sandbox-system",
  SANDBOX_BASE_SECRET_NAME: "base-secret",
  KUBERNETES_SERVICE_HOST: "10.96.0.1",
};
const credentialSentinel = "service-account-token-sentinel";
const secretSentinel = "secret-response-sentinel";
const encoded = (value: string) => Buffer.from(value).toString("base64");
const response = (data: unknown) => new Response(JSON.stringify({ data }));

async function expectSafeFailure(message: string | RegExp) {
  const error = await sandboxBaseEnvFromKubernetes(configuredEnv).catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(Error);
  expect(String(error)).toMatch(message);
  expect(String(error)).not.toContain(credentialSentinel);
  expect(String(error)).not.toContain(secretSentinel);
  expect(error).not.toHaveProperty("cause");
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.readFile.mockImplementation(async (path: string) =>
    path.endsWith("/token") ? `${credentialSentinel}\n` : "cluster-ca-sentinel",
  );
  mocks.Agent.mockImplementation(function () { return mocks.dispatcher; });
  mocks.close.mockResolvedValue(undefined);
  mocks.fetch.mockResolvedValue(response({ TOKEN: encoded(secretSentinel) }));
});

describe("sandboxBaseEnvFromKubernetes", () => {
  it("is disabled without a Secret reference and performs no I/O", async () => {
    await expect(sandboxBaseEnvFromKubernetes({})).resolves.toEqual({});
    expect(mocks.readFile).not.toHaveBeenCalled();
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it.each([
    { SANDBOX_BASE_SECRET_NAMESPACE: "sandbox-system" },
    { SANDBOX_BASE_SECRET_NAME: "base-secret" },
    { SANDBOX_BASE_SECRET_NAMESPACE: " ", SANDBOX_BASE_SECRET_NAME: "base-secret" },
  ])("rejects partial Secret configuration", async (env) => {
    await expect(sandboxBaseEnvFromKubernetes(env)).rejects.toThrow(
      "requires SANDBOX_BASE_SECRET_NAMESPACE and SANDBOX_BASE_SECRET_NAME",
    );
    expect(mocks.readFile).not.toHaveBeenCalled();
  });

  it.each([undefined, "", "https://untrusted.example", "untrusted.example/path", "user@host"])(
    "rejects missing or malformed Kubernetes hosts", async (host) => {
      await expect(sandboxBaseEnvFromKubernetes({ ...configuredEnv, KUBERNETES_SERVICE_HOST: host }))
        .rejects.toThrow("KUBERNETES_SERVICE_HOST");
      expect(mocks.readFile).not.toHaveBeenCalled();
    },
  );

  it.each(["0", "65536", "-1", "443/path", "https"])("rejects malformed Kubernetes ports", async (port) => {
    await expect(sandboxBaseEnvFromKubernetes({ ...configuredEnv, KUBERNETES_SERVICE_PORT_HTTPS: port }))
      .rejects.toThrow("KUBERNETES_SERVICE_PORT_HTTPS");
    expect(mocks.readFile).not.toHaveBeenCalled();
  });

  it("uses a direct authenticated GET with the cluster CA and closes the dispatcher", async () => {
    const timeout = vi.spyOn(AbortSignal, "timeout");
    try {
      await expect(sandboxBaseEnvFromKubernetes(configuredEnv)).resolves.toEqual({ TOKEN: secretSentinel });
      expect(mocks.readFile).toHaveBeenCalledWith("/var/run/secrets/kubernetes.io/serviceaccount/token", "utf8");
      expect(mocks.readFile).toHaveBeenCalledWith("/var/run/secrets/kubernetes.io/serviceaccount/ca.crt", "utf8");
      expect(mocks.Agent).toHaveBeenCalledWith({ connect: { ca: "cluster-ca-sentinel" } });
      expect(mocks.fetch).toHaveBeenCalledWith(
        "https://10.96.0.1:443/api/v1/namespaces/sandbox-system/secrets/base-secret",
        {
          method: "GET",
          headers: { Authorization: `Bearer ${credentialSentinel}` },
          dispatcher: mocks.dispatcher,
          signal: expect.any(AbortSignal),
          redirect: "error",
        },
      );
      expect(timeout).toHaveBeenCalledWith(10_000);
      expect(mocks.close).toHaveBeenCalledOnce();
    } finally {
      timeout.mockRestore();
    }
  });

  it("supports Kubernetes IPv6 endpoints and an explicit HTTPS port", async () => {
    await sandboxBaseEnvFromKubernetes({
      ...configuredEnv,
      KUBERNETES_SERVICE_HOST: "fd00::1",
      KUBERNETES_SERVICE_PORT_HTTPS: "6443",
    });
    expect(mocks.fetch.mock.calls[0][0]).toBe("https://[fd00::1]:6443/api/v1/namespaces/sandbox-system/secrets/base-secret");
  });

  it("preserves whitespace, empty values, Unicode and BOM while ignoring file keys", async () => {
    const values = {
      OSS_READ_ACCESS_KEY_ID: "  key with spaces  ",
      TOKEN: "line one\nline two\n",
      EMPTY: "",
      _UNICODE: "中文🦊",
      BOM: "\uFEFFkept",
    };
    mocks.fetch.mockResolvedValue(response({
      ...Object.fromEntries(Object.entries(values).map(([key, value]) => [key, encoded(value)])),
      "source.env": encoded("export IGNORED=secret-response-sentinel"),
      "BAD-NAME": 42,
      "1BAD": encoded("ignored"),
    }));
    await expect(sandboxBaseEnvFromKubernetes(configuredEnv)).resolves.toEqual(values);
  });

  it("keeps a valid __proto__ environment name as an own property", async () => {
    mocks.fetch.mockResolvedValue(response(Object.fromEntries([["__proto__", encoded("plain-value")]])));
    const env = await sandboxBaseEnvFromKubernetes(configuredEnv);
    expect(Object.keys(env)).toEqual(["__proto__"]);
    expect(env.__proto__).toBe("plain-value");
    expect(Object.getPrototypeOf(env)).toBe(Object.prototype);
  });

  it.each([403, 404, 500])("reports HTTP %s without leaking or parsing the response body", async (status) => {
    const failed = new Response(`${secretSentinel} ${credentialSentinel}`, { status });
    const json = vi.spyOn(failed, "json");
    mocks.fetch.mockResolvedValue(failed);
    await expectSafeFailure(`HTTP ${status}`);
    expect(json).not.toHaveBeenCalled();
    expect(failed.bodyUsed).toBe(true);
    expect(mocks.close).toHaveBeenCalledOnce();
  });

  it.each(["network", "timeout"])("sanitizes %s failures and closes the dispatcher", async (kind) => {
    mocks.fetch.mockRejectedValue(new Error(`${kind}: ${credentialSentinel} ${secretSentinel}`));
    await expectSafeFailure("request failed or timed out");
    expect(mocks.close).toHaveBeenCalledOnce();
  });

  it("sanitizes service account file errors", async () => {
    mocks.readFile.mockRejectedValue(new Error(`${credentialSentinel} ${secretSentinel}`));
    await expectSafeFailure("service account credentials could not be read");
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it.each(["/token", "/ca.crt"])("rejects an empty service account %s", async (emptyFile) => {
    mocks.readFile.mockImplementation(async (path: string) => path.endsWith(emptyFile) ? " \n" : "valid");
    await expectSafeFailure("service account credentials could not be read");
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it("sanitizes TLS client initialization errors", async () => {
    mocks.Agent.mockImplementation(function () { throw new Error(`${credentialSentinel} ${secretSentinel}`); });
    await expectSafeFailure("TLS client could not be initialized");
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it("sanitizes dispatcher close failures", async () => {
    mocks.close.mockRejectedValue(new Error(`${credentialSentinel} ${secretSentinel}`));
    await expectSafeFailure("client could not be closed");
  });

  it("sanitizes malformed response JSON and closes the dispatcher", async () => {
    mocks.fetch.mockResolvedValue(new Response(`{${secretSentinel} ${credentialSentinel}`));
    await expectSafeFailure("response could not be decoded");
    expect(mocks.close).toHaveBeenCalledOnce();
  });

  it.each([undefined, null, [], {}, { "source.env": encoded("TOKEN=ignored") }])(
    "rejects Secrets without any valid environment entries", async (data) => {
      mocks.fetch.mockResolvedValue(response(data));
      await expectSafeFailure(/must contain/);
      expect(mocks.close).toHaveBeenCalledOnce();
    },
  );

  it.each([42, secretSentinel, "AA=A", "AB=="])("rejects malformed base64 values", async (value) => {
    mocks.fetch.mockResolvedValue(response({ TOKEN: value }));
    await expectSafeFailure("must be base64 strings");
  });

  it("rejects NUL bytes without disclosing the value", async () => {
    mocks.fetch.mockResolvedValue(response({ TOKEN: encoded(`${secretSentinel}\0`) }));
    await expectSafeFailure("must not contain NUL");
  });

  it("rejects invalid UTF-8 without silently replacing bytes", async () => {
    mocks.fetch.mockResolvedValue(response({ TOKEN: Buffer.from([0xc3, 0x28]).toString("base64") }));
    await expectSafeFailure("must be valid UTF-8");
  });
});
