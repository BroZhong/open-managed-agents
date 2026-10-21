/** Loaded by Node inside ToolExecutor. Only public, unmodified Pi exports. */
export const SANDBOX_TOOL_RUNTIME = String.raw`
import { readFile, unlink } from "node:fs/promises";
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
  // Pi 0.83's read cannot take resize options (1.x accepts resizeOptions).
  // Skip its pass so each image is encoded once with the Host's options.
  const resize = request.name === "read" ? request.imageResize : undefined;
  const factories = {
    bash: () => pi.createBashToolDefinition(process.cwd(), { exposeSessionEnvironment: false }),
    read: () => pi.createReadToolDefinition(process.cwd(), { autoResizeImages: !resize }),
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
  if (resize) {
    const content = [];
    for (const block of result.content) {
      if (block.type !== "image") { content.push(block); continue; }
      const resized = await pi.resizeImage(Buffer.from(block.data, "base64"), block.mimeType, resize);
      if (!resized) { content.push({ type: "text", text: "[Image omitted: could not be resized below the inline image size limit.]" }); continue; }
      content.push({ type: "image", data: resized.data, mimeType: resized.mimeType });
      const note = pi.formatDimensionNote(resized);
      if (note) content.push({ type: "text", text: note });
    }
    result.content = content;
  }
  emit(controller.signal.aborted ? { type: "cancelled", message: "Command aborted" } : { type: "result", result });
} catch (error) {
  emit({ type: controller.signal.aborted ? "cancelled" : "error", message: error instanceof Error ? error.message : String(error) });
  process.exitCode = 1;
}
`;
