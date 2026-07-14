import { isIP } from "node:net";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

function isPrivateIpv4(hostname) {
  const [first, second, third, fourth] = hostname.split(".").map(Number);
  return (
    first === 0 ||
    first === 10 ||
    first === 127 ||
    (first === 100 && second >= 64 && second <= 127) ||
    (first === 169 && second === 254) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 0 && third === 0 &&
      fourth !== 9 && fourth !== 10) ||
    (first === 192 && second === 0 && third === 2) ||
    (first === 192 && second === 168) ||
    (first === 192 && second === 88 && third === 99) ||
    (first === 198 && (second === 18 || second === 19)) ||
    (first === 198 && second === 51 && third === 100) ||
    (first === 203 && second === 0 && third === 113) ||
    first >= 224
  );
}

function ipv6ToBigInt(hostname) {
  const value = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  const halves = value.split("::");
  if (halves.length > 2) return null;

  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves.length === 2 && halves[1]
    ? halves[1].split(":")
    : [];
  const missing = 8 - left.length - right.length;
  if (
    (halves.length === 1 && missing !== 0) ||
    (halves.length === 2 && missing < 1)
  ) {
    return null;
  }

  const groups = [
    ...left,
    ...Array.from({ length: missing }, () => "0"),
    ...right,
  ];
  if (
    groups.length !== 8 ||
    groups.some((group) => !/^[0-9a-f]{1,4}$/.test(group))
  ) {
    return null;
  }
  return groups.reduce(
    (result, group) => (result << 16n) | BigInt(`0x${group}`),
    0n,
  );
}

function isInIpv6Cidr(address, base, prefixLength) {
  const addressValue = ipv6ToBigInt(address);
  const baseValue = ipv6ToBigInt(base);
  if (addressValue === null || baseValue === null) return true;
  const shift = 128n - BigInt(prefixLength);
  return addressValue >> shift === baseValue >> shift;
}

function isPrivateIpv6(hostname) {
  const nonPublicRanges = [
    ["::", 96],
    ["::ffff:0:0", 96],
    ["64:ff9b:1::", 48],
    ["100::", 64],
    ["2001:2::", 48],
    ["2001:10::", 28],
    ["2001:20::", 28],
    ["2001:db8::", 32],
    ["fc00::", 7],
    ["fe80::", 10],
    ["ff00::", 8],
  ];
  return nonPublicRanges.some(([base, prefix]) =>
    isInIpv6Cidr(hostname, base, prefix)
  );
}

function assertPublicHostname(hostname) {
  const normalized = hostname.toLowerCase().replace(/\.$/, "");
  const specialUseDomains = [
    "localhost",
    "local",
    "internal",
    "home.arpa",
    "test",
    "invalid",
    "example",
    "onion",
  ];
  if (specialUseDomains.some((domain) =>
    normalized === domain || normalized.endsWith(`.${domain}`)
  )) {
    throw new Error("PUBLIC_API_URL must use a public hostname");
  }

  const ipVersion = isIP(normalized.replace(/^\[|\]$/g, ""));
  if (
    (ipVersion === 4 && isPrivateIpv4(normalized)) ||
    (ipVersion === 6 && isPrivateIpv6(normalized))
  ) {
    throw new Error("PUBLIC_API_URL must not use a private or reserved IP address");
  }
}

export function normalizePublicApiUrl(value) {
  if (value === undefined || value === null || String(value).trim() === "") {
    return null;
  }

  let url;
  try {
    url = new URL(String(value).trim());
  } catch {
    throw new Error("PUBLIC_API_URL must be an absolute URL");
  }
  if (url.protocol !== "https:") {
    throw new Error("PUBLIC_API_URL must use HTTPS");
  }
  if (url.username || url.password) {
    throw new Error("PUBLIC_API_URL must not contain embedded credentials");
  }
  if (url.pathname !== "/") {
    throw new Error("PUBLIC_API_URL must be an origin without a path");
  }
  if (url.search || url.hash) {
    throw new Error("PUBLIC_API_URL must not contain a query string or fragment");
  }

  assertPublicHostname(url.hostname);
  return url.origin;
}

function main() {
  const normalized = normalizePublicApiUrl(process.argv[2]);
  if (!normalized) {
    throw new Error("Usage: node apifox-public-api-url.mjs https://api.example.com");
  }
  console.log(normalized);
}

if (
  process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  try {
    main();
  } catch (error) {
    console.error(
      `::error::${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  }
}
