import type { ExecOptions, ToolExecutor } from "@open-managed-agents/adapter-core";
import { buildCustomTools } from "../src/custom-tools.js";
import { MemoryFileSystem } from "./memory-file-system.js";
export const result = { content: [{ type: "text" as const, text: "中文 😀 result" }], details: { native: true } };
export class ProtocolExecutor implements ToolExecutor {
  readonly fileSystem = new MemoryFileSystem();
  readonly commands: string[][] = [];
  requests: any[] = [];
  frames: unknown[] = [{ type: "accepted", pid: 123 }, { type: "result", result }];
  exitCode: number | null | undefined = 0;
  failure?: Error;
  afterFrames?: () => Promise<void>;
  async *exec(command: string[], options?: ExecOptions) {
    this.commands.push(command);
    if (command[1] !== "--input-type=module") { options?.onExit?.({ exitCode: 0 }); return; }
    this.requests.push(JSON.parse(Buffer.from(await this.fileSystem.readFile(command.at(-1)!)).toString()));
    const bytes = Buffer.from(this.frames.map(frame => typeof frame === "string" ? frame : JSON.stringify(frame)).join("\n") + "\n");
    for (const byte of bytes) yield { stream: "stdout" as const, text: "", bytes: Uint8Array.of(byte) };
    await this.afterFrames?.();
    if (this.exitCode !== undefined) options?.onExit?.({ exitCode: this.exitCode });
    if (this.failure) throw this.failure;
  }
  async readFile(): Promise<string> { throw new Error("legacy read forbidden"); }
  async writeFile(): Promise<void> { throw new Error("legacy write forbidden"); }
  async list(): Promise<never> { throw new Error("legacy list forbidden"); }
}
export function invoke(executor: ToolExecutor, name = "read", args: Record<string, unknown> = { path: "note.txt" }, signal?: AbortSignal, update?: (value: any) => void) {
  return buildCustomTools(executor).find(tool => tool.name === name)!.execute("test", args as never, signal, update, {} as never);
}
