import type { ToolExecutor, ToolFileSystem } from "@open-managed-agents/adapter-core";
import { SkillInstallError } from "./skill-install.js";

/** What a Sandbox operation fails with when the Turn's Skill Install it waited for failed (ADR-0022). */
export function skillsInstallFailedText(error: SkillInstallError): string {
  return `skills_install_failed: ${error.message}. The tool was not executed.`;
}

export interface TurnExecutorGuard {
  /** Refuses an operation unless this attempt still owns its Turn: a stopped attempt sends the Sandbox nothing. */
  assertOwner?(): Promise<void>;
  /** An operation found the Turn's Skill Install failed: the Turn ends with it. */
  skillInstallFailed(error: SkillInstallError): void;
}

/**
 * The Sandbox executor a Turn attempt hands its Adapter: a fresh capability
 * per Turn, so stale owners cannot start new Sandbox work. The fence only
 * refuses to start commands, it never cancels a running one: stopping a tool
 * is its owner's decision, sent through the tool's own protocol (Pi asks its
 * wrapper to abort with SIGTERM). Killing the command would stop only the
 * wrapper and leave Pi's bash process group running.
 *
 * Every operation waits for the Turn's preparation and Skill Install. One
 * that finds the install failed has not run: it fails with
 * skills_install_failed and tells the guard, which ends the Turn instead of
 * letting the model retry around it. One that meets an environment failure
 * (SandboxUnavailable) has not run either, and fails with it unchanged: a
 * tool error the model can retry (ADR-0023).
 */
export function turnExecutor(executor: ToolExecutor, guard: TurnExecutorGuard): ToolExecutor {
  const failed = (error: unknown): unknown => {
    if (!(error instanceof SkillInstallError)) return error;
    guard.skillInstallFailed(error);
    return new Error(skillsInstallFailedText(error));
  };
  const run = async <T>(operation: () => Promise<T>): Promise<T> => {
    await guard.assertOwner?.();
    try { return await operation(); }
    catch (error) { throw failed(error); }
  };
  const fs = executor.fileSystem;
  const guardedFs = fs && Object.fromEntries(Object.keys(fs).map((key) => [key, (...args: unknown[]) =>
    run(() => (fs[key as keyof ToolFileSystem] as (...args: unknown[]) => Promise<unknown>)(...args))])) as unknown as ToolFileSystem | undefined;
  return {
    fileSystem: guardedFs,
    async *exec(command, options) {
      await guard.assertOwner?.();
      try { yield* executor.exec(command, options); }
      catch (error) { throw failed(error); }
    },
    readFile: (path) => run(() => executor.readFile(path)),
    writeFile: (path, content) => run(() => executor.writeFile(path, content)),
    list: (path) => run(() => executor.list(path)),
  };
}
