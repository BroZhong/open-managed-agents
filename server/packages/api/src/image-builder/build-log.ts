import { ENVIRONMENT_BUILD_LOG_MAX_BYTES, type EnvironmentBuildLogStore } from "@oma-server/store";

/** A line that never ends is cut here rather than held back forever. */
const PARTIAL_LINE_MAX = 64 * 1024;

/**
 * One build's log as the builder writes it: whole lines only, so every byte
 * offset a reader resumes from is a character boundary; the head is dropped
 * at a line once the text exceeds the kept tail (1 MiB), and `start` counts
 * what was dropped. `flush` writes the tail to the log store when it changed.
 */
export class BuildLog {
  private text = "";
  private bytes = 0;
  private start = 0;
  private partial = "";
  private dirty = false;
  private writing: Promise<void> = Promise.resolve();

  constructor(
    private readonly store: EnvironmentBuildLogStore,
    readonly key: string,
    private readonly now: () => number = Date.now,
    private readonly maxBytes = ENVIRONMENT_BUILD_LOG_MAX_BYTES,
  ) {}

  /** Continue the log an earlier attempt kept (after a reclaim), or start a new one. */
  static async open(store: EnvironmentBuildLogStore, key: string, now?: () => number, maxBytes?: number): Promise<BuildLog> {
    const log = new BuildLog(store, key, now, maxBytes);
    const kept = await store.read(key);
    if (kept) {
      log.text = kept.text;
      log.bytes = Buffer.byteLength(kept.text);
      log.start = kept.start;
    }
    return log;
  }

  /** Raw output (the build pod's), in any chunking. */
  append(chunk: string): void {
    this.partial += chunk;
    const end = this.partial.lastIndexOf("\n");
    if (end >= 0) {
      this.push(this.partial.slice(0, end + 1));
      this.partial = this.partial.slice(end + 1);
    }
    if (this.partial.length > PARTIAL_LINE_MAX) {
      this.push(`${this.partial}\n`);
      this.partial = "";
    }
  }

  /** One line of the builder's own, timestamped. */
  note(message: string): void {
    if (this.partial) { this.push(`${this.partial}\n`); this.partial = ""; }
    this.push(`[oma-builder ${new Date(this.now()).toISOString()}] ${message}\n`);
  }

  /** Write the tail if it changed; `final` also writes a last unterminated line. Writes never overlap. */
  flush(final = false): Promise<void> {
    if (final && this.partial) { this.push(`${this.partial}\n`); this.partial = ""; }
    const write = this.writing.then(async () => {
      if (!this.dirty) return;
      this.trim();
      this.dirty = false;
      try {
        await this.store.write(this.key, { text: this.text, start: this.start });
      } catch (error) {
        this.dirty = true;
        throw error;
      }
    });
    this.writing = write.catch(() => {});
    return write;
  }

  /** The kept text, for tests and diagnostics. */
  snapshot(): { text: string; start: number } {
    this.trim();
    return { text: this.text, start: this.start };
  }

  private push(text: string): void {
    this.text += text;
    this.bytes += Buffer.byteLength(text);
    this.dirty = true;
    // Bound memory between flushes; flush trims exactly.
    if (this.bytes > this.maxBytes * 2) this.trim();
  }

  private trim(): void {
    if (this.bytes <= this.maxBytes) return;
    const buffer = Buffer.from(this.text);
    const excess = buffer.length - this.maxBytes;
    const newline = buffer.indexOf(10, excess - 1);
    let cut = newline >= 0 && newline < buffer.length - 1 ? newline + 1 : excess;
    while (cut < buffer.length && (buffer[cut]! & 0xc0) === 0x80) cut++;
    this.text = buffer.subarray(cut).toString("utf8");
    this.bytes = buffer.length - cut;
    this.start += cut;
  }
}
