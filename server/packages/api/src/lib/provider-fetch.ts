import { lookup, type LookupAddress } from "node:dns";
import { BlockList, isIP } from "node:net";
import { Agent, Pool, ProxyAgent, type Dispatcher } from "undici";

const blocked = new BlockList();
for (const [address, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 3],
] as const)
  blocked.addSubnet(address, prefix, "ipv4");
const globalV6 = new BlockList();
const fakeIpV4 = new BlockList();
fakeIpV4.addSubnet("198.18.0.0", 15, "ipv4");

export class ProviderAddressError extends Error {
  constructor(fakeIp: boolean) {
    super(
      fakeIp
        ? "Provider DNS resolved to a reserved Fake-IP address (198.18.0.0/15). Exclude this provider domain from your proxy's Fake-IP DNS mode, then retry. The request was blocked before API-key authentication."
        : "Provider DNS resolved to a non-public address. Configure DNS to return public addresses, then retry. The request was blocked before API-key authentication.",
    );
  }
}

/** Fetch and vendor SDKs wrap transport failures in Error.cause. */
export function providerAddressError(
  error: unknown,
): ProviderAddressError | undefined {
  for (let depth = 0; depth < 10 && error instanceof Error; depth++) {
    if (error instanceof ProviderAddressError) return error;
    error = error.cause;
  }
  return undefined;
}
globalV6.addSubnet("2000::", 3, "ipv6");
blocked.addSubnet("2001::", 23, "ipv6");
blocked.addSubnet("2001:db8::", 32, "ipv6");
blocked.addSubnet("2002::", 16, "ipv6");
export function isPublicProviderAddress(address: string): boolean {
  const family = isIP(address);
  return family === 4
    ? !blocked.check(address, "ipv4")
    : family === 6 &&
        globalV6.check(address, "ipv6") &&
        !blocked.check(address, "ipv6");
}
export function providerBaseUrl(raw: string): string {
  const url = new URL(raw);
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (isIP(hostname) && !isPublicProviderAddress(hostname)) ||
    hostname === "localhost" ||
    hostname.endsWith(".localhost")
  ) {
    throw new Error(
      "Use a public HTTP or HTTPS provider URL without credentials, query parameters or fragments.",
    );
  }
  return url.href.replace(/\/+$/, "");
}

// Validate at connection time and return precisely the validated addresses to
// the socket. A separate preflight DNS lookup would permit DNS rebinding.
const directDispatcher = new Agent({
  connect: {
    lookup(hostname, options, callback) {
      lookup(hostname, { all: true, verbatim: true }, (error, addresses) => {
        if (error) return callback(error, [], 0);
        try { assertPublicAddresses(addresses); }
        catch (error) { return callback(error as Error, [], 0); }
        const matches = options.family
          ? addresses.filter((item) => item.family === Number(options.family))
          : addresses;
        if (!matches.length)
          return callback(
            new Error("No provider address for requested family"),
            [],
            0,
          );
        if (options.all) callback(null, matches);
        else callback(null, matches[0].address, matches[0].family);
      });
    },
  },
});

function assertPublicAddresses(addresses: LookupAddress[]): void {
  if (!addresses.length || addresses.some(item => !isPublicProviderAddress(item.address))) {
    throw new ProviderAddressError(addresses.some(item =>
      item.family === 4 && fakeIpV4.check(item.address, "ipv4")));
  }
}

/** Pin the CONNECT authority to a validated IP. Letting the proxy resolve the
 * original hostname after a local preflight would reopen DNS rebinding. The
 * ProxyAgent still uses the original origin for HTTP Host and TLS verification. */
class PublicProviderProxyPool extends Pool {
  override dispatch(options: Dispatcher.DispatchOptions, handler: Dispatcher.DispatchHandlers): boolean {
    if (options.method !== "CONNECT") {
      handler.onError?.(new Error("Provider proxy requires CONNECT"));
      return false;
    }
    const target = new URL(`http://${options.path}`);
    const hostname = target.hostname.replace(/^\[|\]$/g, "");
    const connect = (error: NodeJS.ErrnoException | null, addresses: LookupAddress[]) => {
      try {
        if (error) throw error;
        assertPublicAddresses(addresses);
        const { address, family } = addresses[0]!;
        const authority = `${family === 6 ? `[${address}]` : address}:${target.port || "80"}`;
        super.dispatch({
          ...options,
          path: authority,
          headers: { ...options.headers, host: authority },
        }, handler);
      } catch (error) { handler.onError?.(error as Error); }
    };
    const family = isIP(hostname);
    if (family) connect(null, [{ address: hostname, family }]);
    else lookup(hostname, { all: true, verbatim: true }, connect);
    return true;
  }
}

const proxyDispatchers = new Map<string, ProxyAgent>();
function providerDispatcher(): Dispatcher {
  // Absent inherits the Host proxy; an explicit empty value opts out. Do not
  // fall back to direct on proxy failures. Both protocols use the same route.
  const proxyUrl = process.env.OMA_PROVIDER_PROXY_URL ?? (
    process.env.OMA_PROXY_URL || process.env.HTTPS_PROXY || process.env.https_proxy ||
    process.env.HTTP_PROXY || process.env.http_proxy
  );
  if (!proxyUrl?.trim()) return directDispatcher;
  let dispatcher = proxyDispatchers.get(proxyUrl);
  if (!dispatcher) {
    dispatcher = new ProxyAgent({
      uri: proxyUrl,
      clientFactory: (origin, options) => new PublicProviderProxyPool(origin, options),
    });
    proxyDispatchers.set(proxyUrl, dispatcher);
  }
  return dispatcher;
}

export function providerFetch(baseUrl: string): typeof fetch {
  const base = new URL(providerBaseUrl(baseUrl));
  const dispatcher = providerDispatcher();
  return async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    providerBaseUrl(`${url.origin}${url.pathname}`);
    if (
      url.origin !== base.origin ||
      !`${url.pathname}/`.startsWith(`${base.pathname.replace(/\/$/, "")}/`)
    ) {
      throw new Error("Provider request left its configured endpoint");
    }
    const response = await fetch(input, {
      ...init,
      redirect: "error",
      dispatcher,
    } as RequestInit);
    if (!response.ok) {
      // Classify before redaction so a rejected thinking parameter remains
      // distinguishable from authentication and quota errors. Only fixed text
      // crosses this boundary; raw error bodies never reach SDK consumers.
      const { customProviderFailureMessage } = await import("@open-managed-agents/adapter-pi-agent");
      const reader = response.body?.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        while (reader && size < 16_384) {
          const { done, value } = await reader.read();
          if (done) break;
          const chunk = value.subarray(0, 16_384 - size);
          chunks.push(chunk);
          size += chunk.byteLength;
        }
      } catch {
        chunks.length = 0;
      } finally {
        void reader?.cancel().catch(() => {});
      }
      const diagnostic = customProviderFailureMessage(response.status, Buffer.concat(chunks).toString("utf8"));
      return new Response(
        JSON.stringify({
          error: {
            message: diagnostic,
          },
        }),
        {
          status: response.status,
          headers: { "Content-Type": "application/json" },
        },
      );
    }
    return response;
  };
}
