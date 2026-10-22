import { randomBytes } from "node:crypto";
import { packSkillBundle, type Skill, type SkillBundleStore, type SkillStore, type SkillStoreCreateInput } from "@oma-server/store";

export const bytes = (text: string) => new TextEncoder().encode(text);
export const text = (body: Uint8Array | null | undefined) => new TextDecoder().decode(body ?? undefined);

/**
 * Create a Skill row whose current version is a stored bundle of `files`, as
 * upload and equip do. Returns a snapshot: the memory store's row object
 * changes with later updates.
 */
export async function seedSkill(
  skills: SkillStore,
  bundles: SkillBundleStore,
  input: Omit<SkillStoreCreateInput, "bundleSha256" | "bundleSize">,
  files: Record<string, string | Uint8Array>,
): Promise<Skill> {
  const packed = await packSkillBundle(Object.entries(files).map(([path, body]) => ({
    path, body: typeof body === "string" ? bytes(body) : body,
  })));
  await bundles.put(input.tenantId, packed);
  return structuredClone(await skills.create({ ...input, bundleSha256: packed.sha256, bundleSize: packed.size }));
}

/** The current version of a Skill: its row's bundle digest and every file as text, by path. */
export async function currentFiles(skills: SkillStore, bundles: SkillBundleStore, id: string) {
  const skill = await skills.getById(id);
  if (!skill?.bundleSha256) throw new Error(`Skill ${id} has no current bundle`);
  const files = await bundles.readAll(skill.tenantId, skill.bundleSha256);
  if (!files) throw new Error(`Skill ${id} names a missing bundle`);
  return { sha256: skill.bundleSha256, files: Object.fromEntries(files.map((file) => [file.path, text(file.body)])) };
}

/** A TrueType header followed by bytes that are not valid UTF-8. */
export const TTF = new Uint8Array(Buffer.concat([
  Buffer.from([0x00, 0x01, 0x00, 0x00]),
  randomBytes(64 * 1024),
  Buffer.from([0xff, 0xfe, 0xc3, 0x28, 0x80]),
]));

/** A valid 1×1 PNG. */
export const PNG = new Uint8Array(Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
));
