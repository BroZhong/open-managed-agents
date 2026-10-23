import {
  InvalidSkillFileError,
  isFilteredSkillPath,
  packSkillBundle,
  type PackedSkillBundle,
  type Skill,
  type SkillBundleFile,
  type SkillBundleInputFile,
  type SkillBundleStore,
  type SkillStore,
  type SkillStoreUpdateInput,
} from "@oma-server/store";

/**
 * Skill files as immutable Skill Bundles (ADR-0022). A Skill's row names its
 * current version (`bundleSha256`, `bundleSize`); the bundle is the only copy
 * of its files. Reads go to that bundle. An edit checks out the current
 * version, packs the changed tree into a new bundle, stores it, and publishes
 * it by compare-and-set on the version it read: an edit based on a version
 * that is no longer current throws `SkillVersionConflictError` (HTTP 409)
 * instead of silently losing the other change. Bundles are never modified or
 * deleted here — they are content-addressed and may be shared by forks;
 * collecting unreferenced ones is #273.
 */

/** The `skills` columns naming one Skill Bundle: one version of a Skill. */
export interface SkillVersion {
  bundleSha256: string;
  bundleSize: number;
}

/** A Skill and every file of the version it was read at: the base of an edit. */
export interface SkillCheckout {
  skill: Skill;
  /** The version read, captured as a value: what the commit's compare-and-set expects. */
  bundleSha256: string;
  files: SkillBundleFile[];
}

/** The Skill's current version. Every Skill has one from its creation on. */
export function currentVersion(skill: Skill): SkillVersion {
  if (skill.bundleSha256 === null || skill.bundleSize === null) {
    throw new Error(`Skill ${skill.id} has no Skill Bundle`);
  }
  return { bundleSha256: skill.bundleSha256, bundleSize: skill.bundleSize };
}

export class SkillVersions {
  constructor(
    private readonly skills: SkillStore,
    private readonly bundles: SkillBundleStore,
  ) {}

  /** The current version's file paths, in path order. */
  async paths(skill: Skill): Promise<string[]> {
    const entries = await this.bundles.listFiles(skill.tenantId, currentVersion(skill).bundleSha256);
    if (!entries) throw missingBundle(skill);
    return entries.map((entry) => entry.path);
  }

  /** One file of the current version; null if the version has no such file. */
  readFile(skill: Skill, path: string): Promise<Uint8Array | null> {
    return this.bundles.readFile(skill.tenantId, currentVersion(skill).bundleSha256, path);
  }

  /** Every file (bytes and mode) of the current version, to base an edit on. */
  async checkout(skill: Skill): Promise<SkillCheckout> {
    const { bundleSha256 } = currentVersion(skill);
    const files = await this.bundles.readAll(skill.tenantId, bundleSha256);
    if (!files) throw missingBundle(skill);
    return { skill, bundleSha256, files };
  }

  /** Store a packed bundle: afterwards a Skill row may name it as its version. */
  async store(tenantId: string, bundle: PackedSkillBundle): Promise<SkillVersion> {
    await this.bundles.put(tenantId, bundle);
    return { bundleSha256: bundle.sha256, bundleSize: bundle.size };
  }

  /**
   * Publish `files` (with `metadata`) as the next version of the checked-out
   * Skill. Throws `InvalidSkillFileError` or `SkillBundleTooLargeError` before
   * anything is written, and `SkillVersionConflictError` if another edit
   * published a version since the checkout. Null if the Skill was deleted.
   *
   * A checked-out version never holds compiled Python (packing leaves it
   * out), so such a path here is one the edit targets: it is rejected rather
   * than dropped, and an edit never reports a file it did not store.
   */
  async commit(
    base: SkillCheckout,
    files: readonly SkillBundleInputFile[],
    metadata: Pick<SkillStoreUpdateInput, "name" | "description"> = {},
  ): Promise<Skill | null> {
    const excluded = files.filter((file) => isFilteredSkillPath(file.path)).map((file) => file.path);
    if (excluded.length) {
      throw new InvalidSkillFileError(excluded[0], `Compiled Python cannot be stored in a Skill: ${excluded.join(", ")}. `
        + ".pyc files and __pycache__ directories are left out of every Skill version; remove them and retry.");
    }
    const version = await this.store(base.skill.tenantId, await packSkillBundle(files));
    return this.skills.update(base.skill.id, { ...metadata, ...version }, { expectedBundleSha256: base.bundleSha256 });
  }
}

function missingBundle(skill: Skill): Error {
  return new Error(`Skill ${skill.id} names Skill Bundle ${skill.bundleSha256}, which is not stored`);
}
