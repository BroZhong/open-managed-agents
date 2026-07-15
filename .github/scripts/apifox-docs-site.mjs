import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

function sameId(actual, expected) {
  return actual !== undefined && String(actual) === String(expected);
}

function documentationOrigin(value) {
  if (typeof value !== "string" || value.trim() === "") return null;
  const raw = value.trim();
  const candidate = raw.includes("://")
    ? raw
    : `https://${raw.includes(".") ? raw : `${raw}.apifox.cn`}`;
  let parsed;
  try {
    parsed = new URL(candidate);
  } catch {
    throw new Error(`Apifox returned an invalid documentation domain: ${raw}`);
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.username ||
    parsed.password ||
    parsed.port ||
    parsed.pathname !== "/" ||
    parsed.search ||
    parsed.hash
  ) {
    throw new Error(`Apifox returned an unsafe documentation domain: ${raw}`);
  }
  if (
    !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.apifox\.cn$/.test(
      parsed.hostname.toLowerCase(),
    )
  ) {
    throw new Error(
      "The configured documentation site must expose an Apifox system domain",
    );
  }
  return parsed.origin;
}

export function verifyDocumentationSite(
  envelope,
  { projectId, siteId, url },
) {
  if (envelope?.success !== true || !envelope.data) {
    throw new Error("Apifox docs-site get returned an invalid envelope");
  }
  const site = envelope.data;
  if (!sameId(site.id, siteId) || !sameId(site.projectId, projectId)) {
    throw new Error(
      "Apifox documentation site identity does not match the configured project and site",
    );
  }
  if (site.isPrivate !== false) {
    throw new Error("The configured Apifox documentation site is not publicly visible");
  }
  if (site.status !== 1) {
    throw new Error("The configured Apifox documentation site is not published");
  }
  if (site.visibilitySettings?.type !== "PUBLIC") {
    throw new Error("The configured Apifox documentation site is not publicly visible");
  }
  if (site.isMockData !== false) {
    throw new Error("Apifox did not return an authoritative documentation site");
  }

  let configuredUrl;
  try {
    configuredUrl = new URL(url);
  } catch {
    throw new Error("APIFOX_DOCS_URL must be an absolute URL");
  }
  if (configuredUrl.protocol !== "https:") {
    throw new Error("APIFOX_DOCS_URL must use HTTPS");
  }
  if (configuredUrl.username || configuredUrl.password) {
    throw new Error("APIFOX_DOCS_URL must not contain embedded credentials");
  }
  if (configuredUrl.port) {
    throw new Error("APIFOX_DOCS_URL must use the default HTTPS port");
  }
  if (
    configuredUrl.pathname !== "/" ||
    configuredUrl.search ||
    configuredUrl.hash
  ) {
    throw new Error("APIFOX_DOCS_URL must be the documentation site origin");
  }

  if (site.isSystemDomainEnabled !== true) {
    throw new Error(
      "The configured Apifox documentation site has no enabled system domain",
    );
  }
  const systemOrigin = documentationOrigin(site.sysDomain);
  if (!systemOrigin) {
    throw new Error(
      "The configured Apifox documentation site has no enabled system domain",
    );
  }
  if (configuredUrl.origin !== systemOrigin) {
    throw new Error(
      "APIFOX_DOCS_URL does not belong to the configured Apifox documentation site",
    );
  }

  return configuredUrl.href;
}

function parseArguments(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!flag?.startsWith("--") || value === undefined) {
      throw new Error(`Invalid argument near ${flag ?? "end of command"}`);
    }
    values.set(flag.slice(2), value);
  }
  return values;
}

function main() {
  const args = parseArguments(process.argv.slice(2));
  const siteFile = args.get("site-file");
  const projectId = args.get("project");
  const siteId = args.get("site");
  const url = args.get("url");
  if (!siteFile || !projectId || !siteId || !url) {
    throw new Error(
      "Usage: node apifox-docs-site.mjs --site-file FILE --project ID --site ID --url URL",
    );
  }
  const envelope = JSON.parse(readFileSync(resolve(siteFile), "utf8"));
  const verified = verifyDocumentationSite(envelope, {
    projectId,
    siteId,
    url,
  });
  console.log(`Verified Apifox documentation site URL: ${verified}`);
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
