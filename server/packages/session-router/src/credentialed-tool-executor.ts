import type {
  ExecOptions,
  ExecOutputChunk,
  FileListEntry,
  ToolExecutor,
} from "@open-managed-agents/adapter-core";

const VFS_CLI = /^(?:\/usr\/local\/bin\/)?vfs-cli(?:\s|$)/;

/**
 * Bind a VFS credential to one Adapter turn without putting it in the
 * sandbox's global environment. Only a direct, non-compound vfs-cli invocation
 * receives the variable; arbitrary bash, env, filesystem tools, and later turns
 * cannot read it.
 */
export function withVfsCredential(
  executor: ToolExecutor,
  vfsToken: string | undefined,
): ToolExecutor {
  if (!vfsToken) return executor;
  return new CredentialedToolExecutor(executor, vfsToken);
}

class CredentialedToolExecutor implements ToolExecutor {
  constructor(
    private readonly inner: ToolExecutor,
    private readonly vfsToken: string,
  ) {}

  async *exec(
    command: string[],
    opts?: ExecOptions,
  ): AsyncIterable<ExecOutputChunk> {
    const shouldInject = isDirectVfsCliArgv(command) || isSafeVfsCliShell(command);
    const nextOpts = shouldInject
      ? {
          ...opts,
          env: { ...opts?.env, VFS_TOKEN: this.vfsToken },
        }
      : opts;
    yield* this.inner.exec(command, nextOpts);
  }

  readFile(path: string): Promise<string> {
    return this.inner.readFile(path);
  }

  writeFile(path: string, content: string): Promise<void> {
    return this.inner.writeFile(path, content);
  }

  list(globOrDir?: string): Promise<FileListEntry[]> {
    return this.inner.list(globOrDir);
  }
}

function isDirectVfsCliArgv(command: string[]): boolean {
  return command[0] === "vfs-cli" || command[0] === "/usr/local/bin/vfs-cli";
}

function isSafeVfsCliShell(command: string[]): boolean {
  if (
    command.length !== 3 ||
    (command[0] !== "/bin/sh" && command[0] !== "/bin/bash") ||
    command[1] !== "-c"
  ) {
    return false;
  }
  const script = command[2].trim();
  if (!VFS_CLI.test(script)) return false;
  assertSingleShellCommand(script);
  return true;
}

function assertSingleShellCommand(script: string): void {
  let quote: "'" | '"' | undefined;
  let escaped = false;
  for (const char of script) {
    if (char === "\0" || char === "\r" || char === "\n") throwUnsafe();
    if (quote === "'") {
      if (char === "'") quote = undefined;
      continue;
    }
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (quote === '"') {
      if (char === '"') quote = undefined;
      else if (char === "$" || char === "`") throwUnsafe();
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (";$`&|<>".includes(char)) throwUnsafe();
  }
  if (quote || escaped) throwUnsafe();
}

function throwUnsafe(): never {
  throw new Error(
    "Credentialed vfs-cli calls must be a single direct command without shell control operators",
  );
}
