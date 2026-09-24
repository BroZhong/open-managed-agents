import { lookup } from "node:dns";
import { BlockList, isIP } from "node:net";
import { Agent } from "undici";

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
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (isIP(hostname) && !isPublicProviderAddress(hostname)) ||
    hostname === "localhost" ||
    hostname.endsWith(".localhost")
  ) {
    throw new Error(
      "Use a public HTTPS provider URL without credentials, query parameters or fragments.",
    );
  }
  return url.href.replace(/\/+$/, "");
}

// Validate at connection time and return precisely the validated addresses to
// the socket. A separate preflight DNS lookup would permit DNS rebinding.
const dispatcher = new Agent({
  connect: {
    lookup(hostname, options, callback) {
      lookup(hostname, { all: true, verbatim: true }, (error, addresses) => {
        if (error) return callback(error, [], 0);
        if (
          !addresses.length ||
          addresses.some((item) => !isPublicProviderAddress(item.address))
        ) {
          return callback(
            new ProviderAddressError(
              addresses.some(
                (item) =>
                  item.family === 4 && fakeIpV4.check(item.address, "ipv4"),
              ),
            ),
            [],
            0,
          );
        }
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

export function providerFetch(baseUrl: string): typeof fetch {
  const base = new URL(providerBaseUrl(baseUrl));
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
      await response.body?.cancel();
      // Error bodies are untrusted and may reflect Authorization headers.
      return new Response(
        JSON.stringify({
          error: {
            message: `Provider returned HTTP ${response.status}. Check credentials, model access and protocol.`,
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
