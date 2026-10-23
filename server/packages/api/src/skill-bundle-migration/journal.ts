import { closeSync, fsyncSync, openSync, writeSync } from "node:fs";
import { MigrationError } from "./errors.js";
import type { MigrationTarget } from "./migration.js";

/**
 * The ownership journal of a real Skill Bundle migration run (#266). The
 * report is written only at the end, so without the journal a run that died
 * midway would leave rows holding bundles no manifest owns, and every later
 * run would keep them as another writer's forever.
 *
 * JSON Lines beside the report (`<report>.journal.jsonl`): a header, then one
 * claim per Skill, appended and fsynced after its bundle is uploaded and read
 * back and before the row's compare-and-set write (an unchanged row is claimed
 * too). `--manifest` accepts a journal like a report. Lines are written whole,
 * so only the last one can be torn, by a crash mid-append; it is ignored.
 */

export interface JournalHeader {
  tool: "migrate-skill-bundles";
  version: 1;
  kind: "journal";
  runId: string;
  mode: "full" | "delta";
  dryRun: false;
  since: string | null;
  target: MigrationTarget;
  startedAt: string;
}

export interface JournalClaim {
  runId: string;
  tenantId: string;
  skillId: string;
  sha256: string;
  size: number;
}

export interface OwnershipJournal {
  /** Once, before any row is read. */
  begin(header: JournalHeader): void;
  /** Durable when it returns. */
  claim(claim: JournalClaim): void;
}

export const journalPathFor = (reportPath: string) => `${reportPath.replace(/\.json$/, "")}.journal.jsonl`;

export class FileOwnershipJournal implements OwnershipJournal {
  private fd?: number;

  constructor(readonly path: string) {}

  begin(header: JournalHeader): void {
    try {
      this.fd = openSync(this.path, "wx");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      throw new MigrationError(`The ownership journal ${this.path} exists already: it may be a crashed run's only record ` +
        "of the rows it wrote. Keep it, pass it as --manifest, and choose another --report");
    }
    this.append(header);
  }

  claim(claim: JournalClaim): void {
    this.append(claim);
  }

  close(): void {
    if (this.fd === undefined) return;
    closeSync(this.fd);
    this.fd = undefined;
  }

  private append(line: JournalHeader | JournalClaim): void {
    if (this.fd === undefined) throw new MigrationError("The ownership journal is not open");
    const bytes = Buffer.from(`${JSON.stringify(line)}\n`);
    for (let offset = 0; offset < bytes.byteLength;) offset += writeSync(this.fd, bytes, offset);
    fsyncSync(this.fd);
  }
}
