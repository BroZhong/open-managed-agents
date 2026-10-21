/** Loaded by Node inside ToolExecutor. Only public, unmodified Pi exports. */
export const SANDBOX_TOOL_RUNTIME = String.raw`
import { readFile, unlink } from "node:fs/promises";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
const controller = new AbortController();
// Keep the listener installed: signal-exit must not reinterpret this as unhandled.
process.on("SIGTERM", () => controller.abort());
const emit = value => process.stdout.write(JSON.stringify(value) + "\n");
try {
  const requestPath = process.argv[1];
  const request = JSON.parse(await readFile(requestPath, "utf8"));
  await unlink(requestPath);
  emit({ type: "accepted", pid: process.pid });
  // The local executor maps the model workspace to a temporary test directory.
  // Production uses workspaceRoot as cwd and leaves every native path untouched.
  if (process.cwd() !== request.workspaceRoot && typeof request.args.path === "string") {
    const prefix = request.args.path.startsWith("@") ? "@" : "";
    const target = request.args.path.slice(prefix.length).replace(/^~(?=\/|$)/, "/home/user");
    if (target === request.workspaceRoot || target.startsWith(request.workspaceRoot + "/")) {
      request.args.path = prefix + "./" + target.slice(request.workspaceRoot.length).replace(/^\//, "");
    }
  }
  const modulePath = process.env.OMA_PI_TOOL_MODULE || "/opt/oma-pi-tools/node_modules/@earendil-works/pi-coding-agent/dist/index.js";
  const pi = await import(pathToFileURL(modulePath).href);
  if (pi.VERSION !== request.sdkVersion) throw new Error("Sandbox Pi version mismatch: expected " + request.sdkVersion + ", got " + pi.VERSION);
  const factories = {
    bash: () => pi.createBashToolDefinition(process.cwd(), { exposeSessionEnvironment: false }),
    read: () => pi.createReadToolDefinition(process.cwd()),
    write: () => pi.createWriteToolDefinition(process.cwd()),
    edit: () => pi.createEditToolDefinition(process.cwd()),
    ls: () => pi.createLsToolDefinition(process.cwd()),
    grep: () => pi.createGrepToolDefinition(process.cwd()),
    find: () => pi.createFindToolDefinition(process.cwd()),
  };
  const factory = factories[request.name];
  if (!factory) throw new Error("Unsupported sandbox tool: " + request.name);
  const result = await factory().execute(request.id, request.args, controller.signal,
    result => emit({ type: "update", result }), { cwd: process.cwd(), model: request.model });
  // Pi bounds read images to 2000x2000 but keeps PNG whenever it fits, and
  // every later request resends them. Encode opaque non-JPEG images once as
  // JPEG and keep whichever is smaller; transparency would turn black.
  if (request.name === "read") {
    try {
      const photon = createRequire(modulePath)("@silvia-odwyer/photon-node");
      for (const [index, block] of result.content.entries()) {
        if (block.type !== "image" || block.mimeType === "image/jpeg") continue;
        let image;
        try {
          image = photon.PhotonImage.new_from_byteslice(Buffer.from(block.data, "base64"));
          const pixels = image.get_raw_pixels();
          let opaque = true;
          for (let i = 3; opaque && i < pixels.length; i += 4) opaque = pixels[i] === 255;
          if (!opaque) continue;
          const data = Buffer.from(image.get_bytes_jpeg(85)).toString("base64");
          if (data.length < block.data.length) result.content[index] = { type: "image", data, mimeType: "image/jpeg" };
        } catch { /* keep Pi's image */ } finally { image?.free(); }
      }
    } catch { /* photon unavailable: keep Pi's images */ }
  }
  emit(controller.signal.aborted ? { type: "cancelled", message: "Command aborted" } : { type: "result", result });
} catch (error) {
  emit({ type: controller.signal.aborted ? "cancelled" : "error", message: error instanceof Error ? error.message : String(error) });
  process.exitCode = 1;
}
`;
