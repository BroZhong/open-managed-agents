/** One preinstalled item of a manifest, whatever list it came from. */
export interface ManifestItem {
  kind: "binary" | "dpkg" | "pip" | "npm";
  name: string;
  version: string;
  /** Where it lives: an interpreter, an npm root or project, a binary's path. */
  where?: string;
}

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json => !!value && typeof value === "object" && !Array.isArray(value);
const text = (value: unknown) => (typeof value === "string" ? value : value == null ? "" : String(value));
const packages = (value: unknown) => (Array.isArray(value) ? value.filter(isObject) : []);

/**
 * The lists `/opt/oma/bin/write-manifest` writes (ADR-0024): binaries, dpkg,
 * each Python environment and npm's global roots and projects, flattened.
 * Unknown parts are skipped.
 */
export function manifestItems(manifest: Json): ManifestItem[] {
  const items: ManifestItem[] = [];
  if (isObject(manifest.binaries)) {
    for (const [name, info] of Object.entries(manifest.binaries)) {
      items.push({ kind: "binary", name, version: isObject(info) ? text(info.version) : text(info), where: isObject(info) ? text(info.path) : undefined });
    }
  }
  for (const pkg of packages(manifest.dpkg)) items.push({ kind: "dpkg", name: text(pkg.name), version: text(pkg.version) });
  for (const env of packages(manifest.pip)) {
    for (const pkg of packages(env.packages)) items.push({ kind: "pip", name: text(pkg.name), version: text(pkg.version), where: text(env.prefix || env.interpreter) });
  }
  const npm = isObject(manifest.npm) ? manifest.npm : {};
  if (isObject(npm.global)) {
    for (const [root, list] of Object.entries(npm.global)) for (const pkg of packages(list)) items.push({ kind: "npm", name: text(pkg.name), version: text(pkg.version), where: root });
  }
  if (isObject(npm.projects)) {
    for (const [project, info] of Object.entries(npm.projects)) {
      for (const pkg of packages(isObject(info) ? info.dependencies : undefined)) items.push({ kind: "npm", name: text(pkg.name), version: text(pkg.version), where: project });
    }
  }
  return items;
}
