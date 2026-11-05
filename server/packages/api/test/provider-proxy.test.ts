import { createServer, type Server } from "node:http";
import { type AddressInfo, type Socket } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Agent, ProxyAgent, type Dispatcher } from "undici";
import { providerAddressError, providerFetch } from "../src/lib/provider-fetch.js";

const dns = vi.hoisted(() => ({ addresses: [{ address: "8.8.8.8", family: 4 }] }));
vi.mock("node:dns", async (original) => ({
  ...await original<typeof import("node:dns")>(),
  lookup: (_host: string, _options: unknown, callback: (error: Error | null, addresses: typeof dns.addresses) => void) =>
    callback(null, dns.addresses),
}));
const servers: Server[] = [];
const sockets = new Set<Socket>();
const dispatchers = new Set<Dispatcher>();
const nativeFetch = globalThis.fetch;
const proxyEnv = ["OMA_PROVIDER_PROXY_URL", "OMA_PROXY_URL", "HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy"];

beforeEach(() => {
  for (const key of proxyEnv) vi.stubEnv(key, undefined);
  dns.addresses = [{ address: "8.8.8.8", family: 4 }];
});
afterEach(async () => {
  await Promise.all([...dispatchers].map(d => d.destroy()));
  dispatchers.clear();
  for (const socket of sockets) socket.destroy();
  sockets.clear();
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))));
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});
async function proxy(status = 200) {
  const connects: string[] = [];
  const requests: string[] = [];
  const server = createServer();
  servers.push(server);
  server.on("connection", socket => { sockets.add(socket); socket.on("close", () => sockets.delete(socket)); });
  server.on("connect", (request, socket) => {
    connects.push(request.url!);
    if (status !== 200) { socket.end(`HTTP/1.1 ${status} Bad Gateway\r\n\r\n`); return; }
    socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    socket.once("data", data => {
      requests.push(data.toString());
      socket.end("HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nOK");
    });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  vi.stubGlobal("fetch", (input: Parameters<typeof fetch>[0], init: RequestInit & { dispatcher: Dispatcher }) => {
    if (init.dispatcher instanceof ProxyAgent) dispatchers.add(init.dispatcher);
    return nativeFetch(input, init);
  });
  return { url, connects, requests };
}

describe("custom Provider proxy routing", () => {
  it.each(["OMA_PROXY_URL", "HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy"])("inherits %s when the dedicated setting is absent", async key => {
    const p = await proxy();
    vi.stubEnv(key, p.url);
    const response = await providerFetch("http://provider.example:3102")("http://provider.example:3102/v1/responses", { headers: { Authorization: "Bearer fixture" }, signal: AbortSignal.timeout(1000) });
    expect(await response.text()).toBe("OK");
    expect(p.connects).toEqual(["8.8.8.8:3102"]);
    expect(p.requests[0]).toContain("host: provider.example:3102");
    expect(p.requests[0]).toContain("Bearer fixture");
  });
  it.each(["http", "https"])("explicit empty setting opts out for %s", async scheme => {
    vi.stubEnv("HTTP_PROXY", "http://127.0.0.1:7890");
    vi.stubEnv("OMA_PROVIDER_PROXY_URL", "");
    const mock = vi.fn().mockResolvedValue(new Response("OK"));
    vi.stubGlobal("fetch", mock);
    await providerFetch(`${scheme}://provider.example`)(`${scheme}://provider.example/v1/models`);
    expect(mock.mock.calls[0][1].dispatcher).toBeInstanceOf(Agent);
    expect(mock.mock.calls[0][1].dispatcher).not.toBeInstanceOf(ProxyAgent);
  });
  it("uses the dedicated proxy before inherited settings", async () => {
    const p = await proxy();
    vi.stubEnv("HTTP_PROXY", "http://127.0.0.1:1");
    vi.stubEnv("OMA_PROVIDER_PROXY_URL", p.url);
    const response = await providerFetch("http://8.8.8.8")("http://8.8.8.8/v1/models");
    expect(await response.text()).toBe("OK");
    expect(p.connects).toEqual(["8.8.8.8:80"]);
  });
  it.each(["127.0.0.1", "169.254.169.254", "198.18.0.1", "::ffff:127.0.0.1"])("blocks DNS result %s before contacting the proxy", async address => {
    const p = await proxy();
    vi.stubEnv("HTTP_PROXY", p.url);
    dns.addresses = [{ address, family: address.includes(":") ? 6 : 4 }];
    const error = await providerFetch("http://provider.example")("http://provider.example/v1/models", { signal: AbortSignal.timeout(1000) }).catch(e => e);
    expect(providerAddressError(error)).toBeDefined();
    expect(p.connects).toEqual([]);
    expect(p.requests).toEqual([]);
  });
  it("uses CONNECT for HTTPS and retains the original TLS server name", async () => {
    const p = await proxy();
    vi.stubEnv("HTTP_PROXY", p.url);
    // This fixture deliberately speaks plain HTTP inside the tunnel: HTTPS
    // must attempt TLS (with the provider's SNI), never send plaintext API keys.
    await expect(providerFetch("https://provider.example")("https://provider.example/v1/models", {
      headers: { Authorization: "Bearer fixture" }, signal: AbortSignal.timeout(1000),
    })).rejects.toThrow();
    expect(p.connects).toEqual(["8.8.8.8:443"]);
    expect(p.requests[0]).toContain("provider.example");
    expect(p.requests[0]).not.toContain("Bearer fixture");
    expect(p.requests[0]).not.toContain("GET /v1/models");
  });
  it("revalidates DNS on a new tunnel instead of trusting an earlier public result", async () => {
    const p = await proxy();
    vi.stubEnv("HTTP_PROXY", p.url);
    const request = providerFetch("http://provider.example");
    expect(await (await request("http://provider.example/v1/models")).text()).toBe("OK");
    dns.addresses = [{ address: "8.8.8.8", family: 4 }, { address: "127.0.0.1", family: 4 }];
    const error = await request("http://provider.example/v1/models").catch(e => e);
    expect(providerAddressError(error)).toBeDefined();
    expect(p.connects).toEqual(["8.8.8.8:80"]);
  });
  it("retains direct transport when no proxy address is configured anywhere", async () => {
    const mock = vi.fn().mockResolvedValue(new Response("OK"));
    vi.stubGlobal("fetch", mock);
    await providerFetch("http://provider.example")("http://provider.example/v1/models");
    expect(mock.mock.calls[0][1].dispatcher).toBeInstanceOf(Agent);
  });
  it("does not silently fall back to direct when the proxy fails", async () => {
    const p = await proxy(502);
    vi.stubEnv("HTTP_PROXY", p.url);
    await expect(providerFetch("http://provider.example")("http://provider.example/v1/models", { signal: AbortSignal.timeout(1000) })).rejects.toThrow();
    expect(p.connects).toEqual(["8.8.8.8:80"]);
    expect(p.requests).toEqual([]);
  });
});
