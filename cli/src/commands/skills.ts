import { boolean, id, pagination, string, type Command } from "../types.js";
import { CliError, invalid } from "../errors.js";
import { base, enc, write } from "./common.js";
import { pick } from "../http.js";
export const skills: Command[] = [
  {
    path: "skill list",
    description: "List Library Skills (not Agent forks)",
    flags: pagination,
    api: ["GET /v1/skills"],
    run: (c) =>
      c.http.pages("/v1/skills", c.flags, (x) =>
        pick(x, ["id", "name", "description", "createdAt", "updatedAt"]),
      ),
  },
  {
    path: "skill get",
    description:
      "Read metadata and full file paths of this Library or fork ID; never follow its source",
    flags: id("skill"),
    api: ["GET /v1/skills/{id}"],
    run: async (c) => ({ data: await c.http.request(base(c, "skill")) }),
  },
  {
    path: "skill file list",
    description:
      "List all Skill file paths, including hidden files; SKILL.md is not required",
    flags: id("skill"),
    api: ["GET /v1/skills/{id}/files"],
    run: async (c) => ({
      data: (await c.http.request(base(c, "skill") + "/files")).data,
      meta: { has_more: false },
    }),
  },
  {
    path: "skill delete",
    description:
      "Permanently delete a Library Skill and its tree; independent Agent forks remain. No recovery.",
    flags: id("skill"),
    write: true,
    confirm: true,
    api: ["GET /v1/skills/{id}", "DELETE /v1/skills/{id}"],
    run: async (c) => {
      const s = await c.http.request(base(c, "skill"));
      if (s.ownerType !== "library")
        throw new CliError(
          {
            type: "validation",
            subtype: "skill_not_library",
            param: "--skill-id",
            message: "Only Library Skills can be deleted here",
            hint: `Use oma-cli agent skill unequip --agent-id ${s.ownerId} --skill-id ${s.id} --yes`,
            retryable: false,
          },
          2,
        );
      return write(c, { method: "DELETE", path: base(c, "skill") });
    },
  },
  {
    path: "agent skill list",
    description:
      "List this Agent’s private fork IDs; use these IDs for Skill file operations",
    flags: id("agent"),
    api: ["GET /v1/agents/{id}/skills"],
    run: async (c) => ({
      data: (await c.http.request(base(c, "agent") + "/skills")).data.map(
        (x: any) =>
          pick(x, [
            "id",
            "name",
            "description",
            "sourceSkillId",
            "createdAt",
            "updatedAt",
          ]),
      ),
      meta: { has_more: false },
    }),
  },
  {
    path: "agent skill equip",
    description:
      "Fork a Library Skill. Repeated equip preserves private edits; overwrite replaces the entire fork tree. No cross-storage transaction.",
    flags: {
      ...id("agent"),
      "skill-id": string("Source Library ID", { field: "skillId" }),
      overwrite: boolean("Discard private edits and replace tree", {
        field: "overwrite",
      }),
    },
    bodyFields: {
      skillId: string("Source Library ID"),
      overwrite: boolean("Replace tree"),
    },
    requiredBody: ["skillId"],
    validate: (_flags, body) => {
      if (!body.skillId) invalid("Skill ID cannot be empty", "--skill-id");
    },
    write: true,
    api: ["POST /v1/agents/{id}/skills"],
    run: (c) =>
      write(c, {
        method: "POST",
        path: base(c, "agent") + "/skills",
        body: c.body,
      }),
  },
  {
    path: "agent skill unequip",
    description:
      "Delete this Agent fork tree and reference; Library remains. Download private edits first if needed. No cross-storage transaction.",
    flags: { ...id("agent"), ...id("skill") },
    write: true,
    confirm: true,
    api: ["DELETE /v1/agents/{id}/skills/{skillId}"],
    run: (c) =>
      write(c, {
        method: "DELETE",
        path: base(c, "agent") + "/skills/" + enc(c.flags["skill-id"]),
      }),
  },
];
