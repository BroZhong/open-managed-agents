import { packSkillBundle, type SkillBundleInputFile } from "@oma-server/store";
import { InMemorySkillBundleStore } from "@oma-server/store-memory";
import type { SkillSetMember } from "../src/skill-install.js";

export const TENANT = "tenant_1";

/** The in-memory Skill Bundle store, packing a Skill's files and counting what it signs. */
export class Bundles extends InMemorySkillBundleStore {
  readonly signed: string[] = [];
  async add(name: string, files: SkillBundleInputFile[]): Promise<SkillSetMember> {
    const packed = await packSkillBundle(files);
    await this.put(TENANT, packed);
    return { name, sha256: packed.sha256, size: packed.size };
  }
  override async createInstallUrl(tenantId: string, sha256: string, expiresInSec: number): Promise<string> {
    this.signed.push(sha256);
    return super.createInstallUrl(tenantId, sha256, expiresInSec);
  }
}

export const text = (path: string, body: string, mode?: number): SkillBundleInputFile =>
  ({ path, body: new TextEncoder().encode(body), mode });
