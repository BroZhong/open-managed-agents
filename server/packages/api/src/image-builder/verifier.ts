import {
  SANDBOX_ENVIRONMENT_LABEL,
  type SandboxClient,
  type SandboxEnvironment,
} from "@oma-server/sandbox";
import type { BuildAttemptRef, BuildLogSink, ImageVerifier, KeepAttempt, VerificationResult } from "./ports.js";

/** Metadata of a verification Sandbox; a Runner's sweeper keeps it (no Sandbox Binding label). */
export const VERIFICATION_LABELS = {
  purpose: "oma.dev/purpose",
  environment: "oma.dev/environment-id",
  build: "oma.dev/environment-build-id",
  attempt: "oma.dev/build-attempt",
} as const;
const PURPOSE = "environment-verification";
/** Destroyed right after the checks; the deadline only bounds one a builder lost track of. */
const SANDBOX_SECONDS = 15 * 60;
export const MANIFEST_PATH = "/opt/oma/manifest.json";

/** One shell command: bash itself, the default user, the home directory's owner. */
const PROBE = 'printf "bash=%s\\nuser=%s\\nhome=%s\\n" "$BASH_VERSION" "$(id -un)" "$(stat -c %U:%G /home/user)"';

/**
 * Verifies a pushed Environment image before it serves (ADR-0024
 * "Building"): claims one Sandbox from the Warm Pool with the image's digest
 * (swapped in place), checks that envd answers, bash runs as `user` and
 * `/home/user` belongs to `user`, reads `/opt/oma/manifest.json`, and
 * destroys the Sandbox.
 */
export class SandboxImageVerifier implements ImageVerifier {
  constructor(private readonly deps: { client: SandboxClient; environment: SandboxEnvironment }) {}

  async verify(image: string, io: { ref: BuildAttemptRef; log: BuildLogSink; signal: AbortSignal }): Promise<VerificationResult> {
    const { client } = this.deps;
    const infrastructure = (message: string): VerificationResult => ({ ok: false, kind: "infrastructure", message });
    const rejected = (message: string): VerificationResult => ({ ok: false, kind: "image", message });
    io.signal.throwIfAborted();
    let id: string;
    try {
      const handle = await client.create({ image, metadata: this.metadata(io.ref), timeoutSeconds: SANDBOX_SECONDS });
      id = handle.id;
      const claim = handle.claim;
      io.log(`Claimed Sandbox ${id}${claim ? ` in ${claim.claimMs} ms${claim.swapped === undefined ? "" : claim.swapped ? ", its image swapped in place" : ", without a swap"}` : ""}.`);
    } catch (error) {
      io.signal.throwIfAborted();
      return infrastructure(`Claiming a Sandbox with the image failed: ${message(error)}`);
    }
    try {
      io.signal.throwIfAborted();
      if (await client.state(id) !== "running") return infrastructure("The verification Sandbox is not running");
      let output = "";
      let exitCode: number | null = null;
      try {
        for await (const chunk of client.exec(id, ["bash", "-c", PROBE], { timeoutSeconds: 60, signal: io.signal, onExit: (exit) => { exitCode = exit.exitCode; } })) {
          if (chunk.stream === "stdout") output += chunk.text;
        }
      } catch (error) {
        io.signal.throwIfAborted();
        return infrastructure(`envd did not run a command: ${message(error)}`);
      }
      const facts = Object.fromEntries(output.trim().split("\n").map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]));
      if (exitCode !== 0 || !facts.bash) return rejected(`bash does not run in the image (exit status ${exitCode ?? "unknown"})`);
      if (facts.user !== "user") return rejected(`Commands run as ${facts.user || "an unknown user"}, not user`);
      if (facts.home !== "user:user") return rejected(`/home/user is owned by ${facts.home || "nobody"}, not user:user`);
      io.log(`envd answers; bash ${facts.bash} runs as user; /home/user is owned by user.`);
      let manifest: unknown;
      try {
        manifest = JSON.parse(await client.readFile(id, MANIFEST_PATH));
      } catch (error) {
        io.signal.throwIfAborted();
        return rejected(`${MANIFEST_PATH} is missing or not JSON: ${message(error)}`);
      }
      if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) return rejected(`${MANIFEST_PATH} is not a JSON object`);
      io.log(`Read ${MANIFEST_PATH}: ${summary(manifest as Record<string, unknown>)}.`);
      return { ok: true, manifest: manifest as Record<string, unknown> };
    } finally {
      await client.destroy(id).then(
        () => io.log(`Destroyed Sandbox ${id}.`),
        (error) => io.log(`Destroying Sandbox ${id} failed (${message(error)}); the builder's sweep removes it.`),
      );
    }
  }

  async sweep(keep: KeepAttempt): Promise<number> {
    const listed = await this.deps.client.listSandboxes({
      metadata: { [VERIFICATION_LABELS.purpose]: PURPOSE, [SANDBOX_ENVIRONMENT_LABEL]: this.deps.environment },
      states: ["running", "paused"],
    });
    let destroyed = 0;
    for (const sandbox of listed) {
      const attempt = Number(sandbox.metadata[VERIFICATION_LABELS.attempt]);
      const ref = { environmentId: sandbox.metadata[VERIFICATION_LABELS.environment] ?? "", buildId: sandbox.metadata[VERIFICATION_LABELS.build] ?? "", attempt };
      if (ref.environmentId && ref.buildId && Number.isSafeInteger(attempt) && await keep(ref)) continue;
      await this.deps.client.destroy(sandbox.sandboxId);
      destroyed++;
    }
    return destroyed;
  }

  private metadata(ref: BuildAttemptRef): Record<string, string> {
    return {
      [SANDBOX_ENVIRONMENT_LABEL]: this.deps.environment,
      [VERIFICATION_LABELS.purpose]: PURPOSE,
      [VERIFICATION_LABELS.environment]: ref.environmentId,
      [VERIFICATION_LABELS.build]: ref.buildId,
      [VERIFICATION_LABELS.attempt]: String(ref.attempt),
    };
  }
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** "326 dpkg packages, 2 Python environments, …" for the log. */
function summary(manifest: Record<string, unknown>): string {
  const parts: string[] = [];
  if (Array.isArray(manifest.dpkg)) parts.push(`${manifest.dpkg.length} dpkg packages`);
  if (Array.isArray(manifest.pip)) {
    const packages = manifest.pip.reduce((n: number, env) => n + (Array.isArray((env as { packages?: unknown[] }).packages) ? (env as { packages: unknown[] }).packages.length : 0), 0);
    parts.push(`${packages} Python packages in ${manifest.pip.length} environments`);
  }
  if (manifest.binaries && typeof manifest.binaries === "object") parts.push(`${Object.keys(manifest.binaries).length} binaries`);
  return parts.join(", ") || "no package lists";
}
