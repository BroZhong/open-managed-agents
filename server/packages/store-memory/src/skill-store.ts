import type {
  Skill,
  SkillOwnerType,
  SkillStore,
  SkillStoreCreateInput,
  SkillStoreListOpts,
  SkillStoreUpdateInput,
  PaginatedResult,
} from "@oma-server/store";

export class InMemorySkillStore implements SkillStore {
  private skills: Skill[] = [];
  private nextId = 1;

  async create(input: SkillStoreCreateInput): Promise<Skill> {
    const ownerType: SkillOwnerType = input.ownerType ?? "library";
    const ownerId = input.ownerId ?? (ownerType === "library" ? input.tenantId : "");
    const skill: Skill = {
      id: `skill_${this.nextId++}`,
      tenantId: input.tenantId,
      name: input.name,
      description: input.description,
      ownerType,
      ownerId,
      sourceSkillId: input.sourceSkillId ?? null,
      updatedAt: new Date(),
    };
    this.skills.push(skill);
    return skill;
  }

  async getById(id: string): Promise<Skill | null> {
    return this.skills.find((s) => s.id === id) ?? null;
  }

  async list(tenantId: string, opts?: SkillStoreListOpts): Promise<PaginatedResult<Skill>> {
    const limit = opts?.limit ?? 50;
    const cursor = opts?.cursor;
    // The Library lists only Library Skills; Agent forks are read via listByOwner.
    let filtered = this.skills.filter(
      (s) => s.tenantId === tenantId && s.ownerType === "library",
    );
    if (cursor) {
      const idx = filtered.findIndex((s) => s.id === cursor);
      if (idx >= 0) filtered = filtered.slice(idx + 1);
    }
    const data = filtered.slice(0, limit);
    const hasMore = filtered.length > limit;
    return { data, hasMore };
  }

  async listByOwner(
    tenantId: string,
    ownerType: SkillOwnerType,
    ownerId: string,
  ): Promise<Skill[]> {
    return this.skills.filter(
      (s) => s.tenantId === tenantId && s.ownerType === ownerType && s.ownerId === ownerId,
    );
  }

  async update(id: string, input: SkillStoreUpdateInput): Promise<Skill | null> {
    const skill = this.skills.find((s) => s.id === id);
    if (!skill) return null;
    if (input.name !== undefined) skill.name = input.name;
    if (input.description !== undefined) skill.description = input.description;
    skill.updatedAt = new Date();
    return skill;
  }

  async delete(id: string): Promise<boolean> {
    const idx = this.skills.findIndex((s) => s.id === id);
    if (idx < 0) return false;
    this.skills.splice(idx, 1);
    return true;
  }
}
