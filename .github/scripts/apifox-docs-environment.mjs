import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { normalizePublicApiUrl } from "./apifox-public-api-url.mjs";

function sameId(actual, expected) {
  return actual !== undefined && String(actual) === String(expected);
}

function positiveIntegerId(value, label) {
  const number = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(number) || number <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
  return number;
}

function assertSiteIdentity(envelope, { projectId, siteId }) {
  if (envelope?.success !== true || !envelope.data) {
    throw new Error("Apifox docs-site get returned an invalid envelope");
  }
  if (
    !sameId(envelope.data.id, siteId) ||
    !sameId(envelope.data.projectId, projectId)
  ) {
    throw new Error(
      "Apifox documentation site identity does not match the configured project and site",
    );
  }
  return envelope.data;
}

export function selectPublicApiEnvironment(envelope, publicApiUrl) {
  if (envelope?.success !== true || !Array.isArray(envelope.data)) {
    throw new Error("Apifox environment list returned an invalid envelope");
  }
  const normalizedUrl = normalizePublicApiUrl(publicApiUrl);
  if (!normalizedUrl) {
    throw new Error("PUBLIC_API_URL is required to bind an Apifox environment");
  }

  const matches = envelope.data.filter(
    (environment) => environment?.baseUrls?.default === normalizedUrl,
  );
  if (matches.length === 0) {
    throw new Error(
      `No Apifox environment has baseUrls.default equal to ${normalizedUrl}`,
    );
  }
  if (matches.length > 1) {
    throw new Error(
      `Multiple Apifox environments have baseUrls.default equal to ${normalizedUrl}`,
    );
  }

  return {
    ...matches[0],
    id: positiveIntegerId(matches[0].id, "Apifox environment ID"),
  };
}

export function buildDocsSiteEnvironmentUpdate(
  envelope,
  { projectId, siteId, environmentId },
) {
  const site = assertSiteIdentity(envelope, { projectId, siteId });
  if (
    !site.environments ||
    typeof site.environments !== "object" ||
    Array.isArray(site.environments)
  ) {
    throw new Error(
      "Apifox docs-site get did not return the complete environments object",
    );
  }
  const id = positiveIntegerId(environmentId, "Apifox environment ID");

  return {
    environments: {
      ...site.environments,
      environmentIds: [id],
      defaultEnvironmentId: id,
    },
  };
}

export function verifyDocsSiteEnvironmentBinding(
  envelope,
  { projectId, siteId, environmentId },
) {
  const site = assertSiteIdentity(envelope, { projectId, siteId });
  const id = positiveIntegerId(environmentId, "Apifox environment ID");
  const environmentIds = site.environments?.environmentIds;
  if (
    !Array.isArray(environmentIds) ||
    environmentIds.length !== 1 ||
    !sameId(environmentIds[0], id) ||
    !sameId(site.environments?.defaultEnvironmentId, id)
  ) {
    throw new Error(
      "The Apifox documentation site environment binding was not applied exactly",
    );
  }
  return id;
}

function parseArguments(argv) {
  const [operation, ...rest] = argv;
  if (operation !== "prepare" && operation !== "verify") {
    throw new Error(
      "Usage: node apifox-docs-environment.mjs <prepare|verify> --environments-file FILE --site-file FILE --public-api-url URL --project ID --site ID [--output FILE]",
    );
  }
  const values = new Map();
  for (let index = 0; index < rest.length; index += 2) {
    const flag = rest[index];
    const value = rest[index + 1];
    if (!flag?.startsWith("--") || value === undefined) {
      throw new Error(`Invalid argument near ${flag ?? "end of command"}`);
    }
    values.set(flag.slice(2), value);
  }
  return { operation, values };
}

function required(values, name) {
  const value = values.get(name);
  if (!value) throw new Error(`--${name} is required`);
  return value;
}

function readJson(file) {
  return JSON.parse(readFileSync(resolve(file), "utf8"));
}

function main() {
  const { operation, values } = parseArguments(process.argv.slice(2));
  const environments = readJson(required(values, "environments-file"));
  const site = readJson(required(values, "site-file"));
  const publicApiUrl = required(values, "public-api-url");
  const projectId = required(values, "project");
  const siteId = required(values, "site");
  const environment = selectPublicApiEnvironment(environments, publicApiUrl);

  if (operation === "prepare") {
    const output = required(values, "output");
    const payload = buildDocsSiteEnvironmentUpdate(site, {
      projectId,
      siteId,
      environmentId: environment.id,
    });
    writeFileSync(resolve(output), `${JSON.stringify(payload, null, 2)}\n`, {
      mode: 0o600,
    });
    console.log(
      `Prepared Apifox documentation environment binding for environment ${environment.id}.`,
    );
    return;
  }

  verifyDocsSiteEnvironmentBinding(site, {
    projectId,
    siteId,
    environmentId: environment.id,
  });
  console.log(
    `Verified Apifox documentation environment binding for environment ${environment.id}.`,
  );
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
