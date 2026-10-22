import { randomBytes } from "node:crypto";
import { DataType, newDb } from "pg-mem";
import { ensureSchema } from "../src/postgres/schema.js";
import type { Pool } from "../src/postgres/connection.js";

/**
 * Test harness for the PostgreSQL store impls.
 *
 * By default, spins up an in-memory PostgreSQL (`pg-mem`) so the suite runs
 * with no external server — equivalent coverage to the old mongodb-memory-server
 * setup. Set `PG_TEST_URL` to point the same suite at a throwaway real
 * PostgreSQL for integration runs.
 *
 * `harness.pool` is a getter so callers always see the current pool after a
 * `reset()`. For pg-mem, `reset()` builds a brand-new in-memory database (the
 * cleanest form of isolation — pg-mem does not fully support DROP of PK
 * index relations). For real PG, each harness owns a schema of its own,
 * `oma_harness_<random>`, which `reset()` drops and recreates and `close()`
 * drops: test files run in parallel, and a shared schema let one file's reset
 * wipe another's rows. The harness drops no schema it did not name itself, so
 * a real environment's schema (`oma`, `oma_test`) is never touched.
 *
 * Note: pg-mem does not enforce `search_path` schema qualification the way real
 * PG does, so the DDL is applied to the default (public) schema in-memory. The
 * store impls use unqualified table names, so they work identically against
 * both.
 */
export interface PgTestHarness {
  readonly pool: Pool;
  /** The schema the pool's tables live in: the harness's own on real PostgreSQL, `public` on pg-mem. */
  readonly schema: string;
  /** Recreate a clean database/schema — call in beforeEach for isolation. */
  reset(): Promise<void>;
  close(): Promise<void>;
}

const REAL_PG_URL = process.env.PG_TEST_URL;

/** A schema name only a harness gives: the one kind of schema it may drop. */
const HARNESS_SCHEMA = /^oma_harness_[0-9a-f]{12}$/;

/** Drop a harness's own schema; any other, a real environment's `oma` or `oma_test` say, is refused. */
async function dropHarnessSchema(pool: Pool, schema: string): Promise<void> {
  if (!HARNESS_SCHEMA.test(schema)) throw new Error(`Refusing to drop schema "${schema}": a test harness drops only its own`);
  await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
}

async function createRealPgHarness(url: string): Promise<PgTestHarness> {
  const pg = await import("pg");
  const schema = `oma_harness_${randomBytes(6).toString("hex")}`;
  const pool = new pg.default.Pool({ connectionString: url }) as unknown as Pool;
  (pool as unknown as { on: (e: string, cb: (c: { query: (q: string) => unknown }) => void) => void }).on(
    "connect",
    (client) => {
      void client.query(`SET search_path TO "${schema}"`);
    },
  );

  const reset = async () => {
    await dropHarnessSchema(pool, schema);
    await ensureSchema(pool, schema);
  };
  await reset();

  return {
    get pool() {
      return pool;
    },
    schema,
    reset,
    close: async () => {
      await dropHarnessSchema(pool, schema).catch(() => {});
      await (pool as unknown as { end: () => Promise<void> }).end();
    },
  };
}

function createMemHarness(noAstCoverageCheck = false): PgTestHarness {
  let pool: Pool;

  const reset = async () => {
    const db = newDb({ noAstCoverageCheck });
    db.public.registerFunction({
      name: "clock_timestamp",
      returns: DataType.timestamptz,
      impure: true,
      implementation: () => new Date(),
    });
    db.public.registerFunction({
      name: "to_char",
      args: [DataType.timestamptz, DataType.text],
      returns: DataType.text,
      implementation: (value: Date, format: string) => {
        if (format !== 'YYYY-MM-DD"T"HH24:MI:SS.USTZH:TZM') throw new Error(`Unsupported test timestamp format: ${format}`);
        return value.toISOString();
      },
    });
    const { Pool } = db.adapters.createPg();
    pool = new Pool() as unknown as Pool;
    // pg-mem is schema-agnostic for our unqualified queries; apply DDL to the
    // default schema.
    await ensureSchema(pool, "public");
  };

  return {
    get pool() {
      return pool;
    },
    schema: "public",
    reset,
    close: async () => {
      /* pg-mem is process-local; nothing to release */
    },
  };
}

export async function createPgTestHarness(options?: {
  /**
   * Let pg-mem ignore unsupported planner-only clauses such as SKIP LOCKED.
   * The same test must still be run against real PostgreSQL for concurrency.
   */
  allowUnsupportedLockSyntax?: boolean;
}): Promise<PgTestHarness> {
  if (REAL_PG_URL) {
    return createRealPgHarness(REAL_PG_URL);
  }
  const harness = createMemHarness(options?.allowUnsupportedLockSyntax);
  await harness.reset();
  return harness;
}
