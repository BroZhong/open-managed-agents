/**
 * The platform values Environments' platform secret references resolve to
 * (ADR-0024): the deployment's base Secret, read at Runner startup and again
 * every interval, so a rotation reaches the next command without a restart.
 * A failed refresh keeps the last good values and is logged, by its own
 * value-free message only.
 */
export class PlatformSecrets {
  private current: Readonly<Record<string, string>>;
  private count = 0;
  private timer: ReturnType<typeof setInterval> | undefined;

  private constructor(
    private readonly read: () => Promise<Record<string, string>>,
    initial: Readonly<Record<string, string>>,
    private readonly logger: Pick<Console, "warn">,
  ) {
    this.current = initial;
  }

  /** The first read; its failure fails startup, as a misconfigured Secret always did. */
  static async load(read: () => Promise<Record<string, string>>, logger: Pick<Console, "warn"> = console): Promise<PlatformSecrets> {
    return new PlatformSecrets(read, await read(), logger);
  }

  /** Fixed values, for a Host without the Secret and for tests. */
  static of(values: Readonly<Record<string, string>>): PlatformSecrets {
    return new PlatformSecrets(async () => ({ ...values }), values, console);
  }

  values(): Readonly<Record<string, string>> {
    return this.current;
  }

  /** Counts the successful refreshes: what a problem is reported once per. */
  generation(): number {
    return this.count;
  }

  async refresh(): Promise<void> {
    try {
      this.current = await this.read();
      this.count++;
    } catch (error) {
      // The reader's messages carry no value (sandbox-base-secret.ts).
      this.logger.warn(`Platform secrets refresh failed; keeping the last values: ${error instanceof Error ? error.message : "unknown error"}`);
    }
  }

  start(intervalMs = 60_000): void {
    if (this.timer) return;
    this.timer = setInterval(() => { void this.refresh(); }, intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }
}
