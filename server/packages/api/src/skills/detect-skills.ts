/**
 * Single/multi-Skill detection over a dropped folder, mirroring Pi's
 * `loadSkillsFromDir` discovery. Pure and unit-testable: given the flat list of
 * files in the dropped root (each with a root-relative path + text content),
 * decide whether the drop is one Skill or many, and extract name/description
 * from each Skill's `SKILL.md`.
 *
 * Rules (server-authoritative; the client runs the same rule for instant
 * feedback), given dropped root `ROOT/`:
 *   - `ROOT/SKILL.md` present            → ONE Skill (whole ROOT).
 *   - no `ROOT/SKILL.md` but `ROOT/<child>/SKILL.md` for ≥1 children
 *                                        → EACH such child is a Skill.
 *   - no `SKILL.md` anywhere             → reject.
 *   - both `ROOT/SKILL.md` AND child `SKILL.md`s (ambiguous mix) → reject.
 */

export interface DroppedFile {
  /** Root-relative path, e.g. `SKILL.md` or `my-skill/SKILL.md`. */
  path: string;
  /** File text. Binary skill assets are out of scope for MVP (instruction-only). */
  content: string;
}

export interface DetectedSkill {
  name: string;
  description: string;
  /**
   * Files belonging to this Skill, RE-ROOTED so each path is relative to the
   * Skill's own directory (SKILL.md sits at the top). Materializing these under
   * `<tmp>/<skillId>/` yields a directory Pi can load as a skill root.
   */
  files: DroppedFile[];
}

export type DetectResult =
  | { ok: true; skills: DetectedSkill[] }
  | { ok: false; error: string };

function normalize(path: string): string {
  return path.replace(/^\/+/, "").replace(/^\.\//, "");
}

/** Split a normalized path into its first segment and the remainder. */
function firstSegment(path: string): { head: string; rest: string } {
  const idx = path.indexOf("/");
  if (idx < 0) return { head: path, rest: "" };
  return { head: path.slice(0, idx), rest: path.slice(idx + 1) };
}

/** Extract `name`/`description` from a SKILL.md's YAML frontmatter. */
export function parseSkillMetadata(skillMd: string, fallbackName: string): {
  name: string;
  description: string;
} {
  let name = fallbackName;
  let description = "";
  const fm = /^---\s*\n([\s\S]*?)\n---/.exec(skillMd);
  if (fm) {
    for (const line of fm[1].split("\n")) {
      const m = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(line.trim());
      if (!m) continue;
      const key = m[1].toLowerCase();
      const value = m[2].trim().replace(/^["']|["']$/g, "");
      if (key === "name" && value) name = value;
      else if (key === "description" && value) description = value;
    }
  }
  if (!description) {
    // Fall back to the first non-heading, non-frontmatter line.
    const body = skillMd.replace(/^---\s*\n[\s\S]*?\n---\s*\n?/, "");
    const firstLine = body.split("\n").map((l) => l.trim()).find((l) => l && !l.startsWith("#"));
    if (firstLine) description = firstLine;
  }
  return { name, description };
}

export function detectSkills(files: DroppedFile[]): DetectResult {
  const normalized = files.map((f) => ({ path: normalize(f.path), content: f.content }));

  const rootSkillMd = normalized.find((f) => f.path === "SKILL.md");

  // Children (first path segment) that directly contain a SKILL.md.
  const childSkillDirs = new Set<string>();
  for (const f of normalized) {
    const { head, rest } = firstSegment(f.path);
    if (rest === "SKILL.md" && head) childSkillDirs.add(head);
  }

  if (rootSkillMd && childSkillDirs.size > 0) {
    return {
      ok: false,
      error:
        "Ambiguous folder: a root SKILL.md and nested SKILL.md files were both found. Drop either a single Skill folder or a folder of Skill folders.",
    };
  }

  if (rootSkillMd) {
    const meta = parseSkillMetadata(rootSkillMd.content, deriveRootName(normalized));
    return { ok: true, skills: [{ name: meta.name, description: meta.description, files: normalized }] };
  }

  if (childSkillDirs.size > 0) {
    const skills: DetectedSkill[] = [];
    for (const dir of [...childSkillDirs].sort()) {
      const prefix = `${dir}/`;
      const skillFiles = normalized
        .filter((f) => f.path.startsWith(prefix))
        .map((f) => ({ path: f.path.slice(prefix.length), content: f.content }));
      const skillMd = skillFiles.find((f) => f.path === "SKILL.md");
      const meta = parseSkillMetadata(skillMd?.content ?? "", dir);
      skills.push({ name: meta.name, description: meta.description, files: skillFiles });
    }
    return { ok: true, skills };
  }

  return {
    ok: false,
    error: "No SKILL.md found. A Skill folder must contain a SKILL.md (or be a folder of such folders).",
  };
}

/**
 * When the drop's top-level files carry a common leading directory (browsers
 * often include the dropped folder's own name in webkitRelativePath), use that
 * as the Skill name; otherwise fall back to a generic name.
 */
function deriveRootName(files: DroppedFile[]): string {
  const skillMdPath = files.find((f) => f.path.endsWith("SKILL.md"))?.path ?? "";
  const dir = skillMdPath.includes("/") ? firstSegment(skillMdPath).head : "";
  return dir || "skill";
}
