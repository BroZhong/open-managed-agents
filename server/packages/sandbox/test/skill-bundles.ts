import { packSkillBundle, type SkillBundleInputFile, type SkillBundleStore } from "@oma-server/store";
import type { SkillSetMember } from "../src/skill-install.js";

/** The install-URL half of the in-memory bundle store: `data:` URLs carrying the zip. */
export class Bundles implements Pick<SkillBundleStore, "createInstallUrl"> {
  readonly zips = new Map<string, Uint8Array>();
  readonly signed: string[] = [];
  async add(name: string, files: SkillBundleInputFile[]): Promise<SkillSetMember> {
    const packed = await packSkillBundle(files);
    this.zips.set(packed.sha256, packed.bytes);
    return { name, sha256: packed.sha256, size: packed.size };
  }
  async createInstallUrl(_tenantId: string, sha256: string): Promise<string> {
    this.signed.push(sha256);
    const zip = this.zips.get(sha256);
    if (!zip) throw new Error("Skill Bundle not found");
    return `data:application/zip;base64,${Buffer.from(zip).toString("base64")}`;
  }
}

export const text = (path: string, body: string, mode?: number): SkillBundleInputFile =>
  ({ path, body: new TextEncoder().encode(body), mode });
