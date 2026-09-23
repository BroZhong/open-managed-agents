import { readFile, readdir } from "node:fs/promises";
import { resolve, basename, join } from "node:path";
import {
  boolean,
  id,
  string,
  type Command,
  type Context,
  type Values,
  type Step,
} from "../types.js";
import { conflict, invalid } from "../errors.js";
import { remotePath, utf8 } from "../input.js";
import {
  checkChain,
  destinations,
  mime,
  save,
  stat,
  tree,
} from "../local-files.js";
import { base, batch, enc, failure, plan } from "./common.js";
import { descriptorPath, workspaceFiles } from "./files.js";
const overwrite = boolean(
  "Permit replacing existing ordinary files; preflight is not an atomic remote condition",
);
export const transfers: Command[] = [];
for (const action of ["upload", "download"] as const)
  transfers.push({
    path: `workspace file ${action}`,
    description: `${action} original bytes; recursive transfers retain relative contents, not empty directories, permissions or timestamps. No rollback or resume.`,
    flags: {
      ...id("workspace"),
      path: string("File path or recursive directory prefix (. means root)", {
        required: true,
      }),
      recursive: boolean("Transfer directory contents"),
      overwrite,
      ...(action === "upload"
        ? {
            file: string("Local regular file or directory; no stdin", {
              required: true,
            }),
          }
        : {
            output: string("Local destination file or directory", {
              required: true,
            }),
          }),
    },
    write: true,
    api: [
      action === "upload"
        ? "POST /v1/workspaces/{id}/files/upload"
        : "GET /v1/workspaces/{id}/files/{path}",
    ],
    validate: (f) => {
      f.path = remotePath(f.path, false, f.recursive, f.recursive);
      if (f.file === "-") invalid("Upload does not accept stdin", "--file");
    },
    run: (c) =>
      action === "upload" ? uploadWorkspace(c) : downloadWorkspace(c),
  });
async function uploadWorkspace(c: Context) {
  const { flags: f } = c;
  const local = resolve(f.file);
  await checkChain(local, f.recursive ? "directory" : "file");
  let entries: { path: string; bytes: Uint8Array }[];
  if (f.recursive)
    entries = (await tree(local)).map((x) => ({
      ...x,
      path: (f.path ? f.path + "/" : "") + x.path,
    }));
  else {
    const s = await stat(local);
    if (!s)
      throw Object.assign(new Error("Local file not found"), {
        code: "ENOENT",
      });
    if (!s.isFile())
      invalid("Use --recursive to upload a directory", "--recursive");
    entries = [{ path: f.path, bytes: await readFile(local) }];
  }
  for (const e of entries) remotePath(e.path);
  const existing = await workspaceFiles(c);
  if (
    !f.overwrite &&
    entries.some((e) => existing.some((x) => x.path === e.path))
  )
    conflict("One or more remote destination files already exist");
  const path = base(c, "workspace") + "/files/upload";
  if (f["dry-run"])
    return plan(
      c,
      entries.map((e) => ({
        method: "POST",
        path,
        body: {
          multipart: {
            path: e.path,
            file: { size: e.bytes.length, contentType: mime(e.path) },
          },
        },
        effects: "Upload file bytes",
      })),
    );
  const results: Values[] = [];
  for (const e of entries) {
    c.signal.throwIfAborted();
    try {
      const form = new FormData();
      form.set("path", e.path);
      form.set(
        "file",
        new Blob([e.bytes], { type: mime(e.path) }),
        basename(e.path),
      );
      await c.http.request(path, "POST", form);
      results.push({ path: e.path, status: "succeeded" });
    } catch (error) {
      if (c.signal.aborted) throw c.signal.reason;
      results.push({ path: e.path, ...failure(error, true) });
    }
  }
  return batch(results);
}
async function downloadWorkspace(c: Context) {
  const f = c.flags,
    root = base(c, "workspace");
  const paths = f.recursive
    ? (await workspaceFiles(c, f.path || undefined)).map((x) => x.path)
    : [f.path];
  const relative = paths.map((p) =>
    f.recursive && f.path ? p.slice(f.path.length + 1) : p,
  );
  for (const p of paths) remotePath(p);
  const outputs = f.recursive
    ? await destinations(f.output, relative)
    : [resolve(f.output)];
  for (const output of outputs) await checkChain(output, "file", f.overwrite);
  // Resolve all single-file existence errors before beginning local writes.
  let single: any;
  if (!f.recursive)
    single = await c.http.request(
      descriptorPath(root, f.path, "expiresIn=600&download=1"),
    );
  if (f["dry-run"])
    return plan(
      c,
      paths.map((p, i) => ({
        method: "GET",
        path: descriptorPath(root, p, "expiresIn=600&download=1"),
        output: outputs[i]!,
        effects:
          "Fetch signed URL without Host credentials; atomically commit complete bytes locally",
      })),
    );
  const results: Values[] = [];
  for (let i = 0; i < paths.length; i++) {
    const path = paths[i]!,
      output = outputs[i]!;
    c.signal.throwIfAborted();
    try {
      let d =
        single ??
        (await c.http.request(
          descriptorPath(root, path, "expiresIn=600&download=1"),
        ));
      if (d.expiresAt && Date.parse(d.expiresAt) <= Date.now())
        d = await c.http.request(
          descriptorPath(root, path, "expiresIn=600&download=1"),
        );
      const stream = await c.http.request(d.url, "GET", undefined, {
        signed: true,
        stream: true,
      });
      const size = await save(output, stream, f.overwrite, c.signal, d.size);
      results.push({ path, output, size, status: "succeeded" });
    } catch (error) {
      if (c.signal.aborted) throw c.signal.reason;
      results.push({ path, output, ...failure(error) });
    }
  }
  return batch(results);
}
transfers.push({
  path: "skill download",
  description:
    "Export this Skill’s complete UTF-8 text tree; no binary fidelity or cross-file snapshot guarantee. Existing unrelated files remain.",
  flags: {
    ...id("skill"),
    output: string("Local directory", { required: true }),
    overwrite,
  },
  write: true,
  api: ["GET /v1/skills/{id}", "GET /v1/skills/{id}/files/content"],
  run: async (c) => {
    const root = base(c, "skill"),
      skill = await c.http.request(root);
    const paths: string[] = skill.files;
    const outputs = await destinations(c.flags.output, paths, true);
    for (const o of outputs) await checkChain(o, "file", c.flags.overwrite);
    const request = (p: string) => root + "/files/content?path=" + enc(p);
    if (c.flags["dry-run"])
      return plan(
        c,
        paths.map((p, i) => ({
          method: "GET",
          path: request(p),
          output: outputs[i]!,
          effects: "Save full UTF-8 content locally",
        })),
      );
    const results: Values[] = [];
    for (let i = 0; i < paths.length; i++) {
      const path = paths[i]!,
        output = outputs[i]!;
      try {
        c.signal.throwIfAborted();
        const r = await c.http.request(request(path));
        if (typeof r.content !== "string")
          throw new Error("Invalid Skill content response");
        const size = await save(
          output,
          Buffer.from(r.content),
          c.flags.overwrite,
          c.signal,
        );
        results.push({ path, output, size, status: "succeeded" });
      } catch (e) {
        if (c.signal.aborted) throw c.signal.reason;
        results.push({ path, output, ...failure(e) });
      }
    }
    return batch(results);
  },
});
// Mirrors the Host's deliberately limited single-line parser, not full YAML.
function metadata(text: string, fallback: string) {
  let name = fallback,
    description = "";
  const fm = /^---\s*\n([\s\S]*?)\n---/.exec(text);
  if (fm)
    for (const line of fm[1]!.split("\n")) {
      const m = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(line.trim());
      if (!m) continue;
      const k = m[1]!.toLowerCase(),
        v = m[2]!.trim().replace(/^["']|["']$/g, "");
      if (k === "name" && v) name = v;
      else if (k === "description" && v) description = v;
    }
  if (!description)
    description =
      text
        .replace(/^---\s*\n[\s\S]*?\n---\s*\n?/, "")
        .split("\n")
        .map((l) => l.trim())
        .find((l) => l && !l.startsWith("#")) ?? "";
  return { name, description };
}
transfers.push({
  path: "skill upload",
  description:
    "Upload Library Skill text trees without equipping. Root SKILL.md or direct child Skills; YAML multiline descriptions are not fully parsed. Overwrite replaces the whole tree while preserving forks.",
  flags: {
    directory: string("Local Skill directory or directory of Skills", {
      required: true,
    }),
    overwrite,
  },
  write: true,
  api: ["GET /v1/skills", "POST /v1/skills"],
  run: async (c) => {
    const dir = await checkChain(c.flags.directory, "directory");
    const root = await stat(join(dir, "SKILL.md"));
    const children: string[] = [];
    for (const d of await readdir(dir, { withFileTypes: true }))
      if (d.isDirectory() && (await stat(join(dir, d.name, "SKILL.md"))))
        children.push(d.name);
    if (root && children.length)
      invalid("Ambiguous mixed root and child Skills", "--directory");
    if (!root && !children.length) invalid("No SKILL.md found", "--directory");
    const selected = root ? [dir] : children.sort().map((d) => join(dir, d));
    const inputs = [];
    const names = new Set<string>();
    for (const local of selected) {
      const prefix = basename(resolve(local));
      remotePath(prefix, true);
      const files = await tree(local);
      const content = files.map((x) => ({
        path: remotePath(x.path, true),
        content: utf8(x.bytes, x.path),
      }));
      const md = content.find((x) => x.path === "SKILL.md");
      if (!md) invalid("Missing SKILL.md");
      const meta = metadata(md.content, prefix);
      if (names.has(meta.name)) invalid("Duplicate Skill name in upload batch");
      names.add(meta.name);
      inputs.push({ ...meta, prefix, files: content });
    }
    const existing = (
      await c.http.pages("/v1/skills", { all: true, limit: 100 })
    ).data;
    if (
      !c.flags.overwrite &&
      inputs.some((s) => existing.some((x) => x.name === s.name))
    )
      conflict("A Library Skill with this name already exists");
    if (c.flags["dry-run"])
      return plan(
        c,
        inputs.map((s) => ({
          method: "POST",
          path: "/v1/skills",
          body: {
            multipart: {
              paths: s.files.map((f) => s.prefix + "/" + f.path),
              ...(c.flags.overwrite ? { overwrite: "true" } : {}),
            },
          },
          effects: `Upload ${s.name}; no automatic Equip`,
        })),
      );
    const results: Values[] = [];
    for (const skill of inputs) {
      try {
        c.signal.throwIfAborted();
        const form = new FormData();
        form.set(
          "paths",
          JSON.stringify(skill.files.map((f) => skill.prefix + "/" + f.path)),
        );
        if (c.flags.overwrite) form.set("overwrite", "true");
        for (const f of skill.files)
          form.append(
            "files",
            new Blob([f.content], { type: "text/plain" }),
            basename(f.path),
          );
        const r = await c.http.request("/v1/skills", "POST", form);
        const entity = r.data?.[0];
        if (!entity?.id)
          throw new Error("Upload response did not identify a Skill");
        results.push({ name: skill.name, id: entity.id, status: "succeeded" });
      } catch (e) {
        if (c.signal.aborted) throw c.signal.reason;
        results.push({ name: skill.name, ...failure(e, true) });
      }
    }
    return batch(results);
  },
});
