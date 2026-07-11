import { DataType, newDb } from "pg-mem";
import { ensureSchema } from "../src/postgres/schema.js";
import type { Pool } from "../src/postgres/connection.js";

/**
 * Test harness for the PostgreSQL store impls.
 *
 * By default, spins up an in-memory PostgreSQL (`pg-mem`) so the suite runs
 * with no external server — equivalent coverage to the old mongodb-memory-server
 * setup. Set `PG_TEST_URL` to point the same suite at a real PostgreSQL (e.g.
 * the oma cluster) for integration runs.
 *
 * `harness.pool` is a getter so callers always see the current pool after a
 * `reset()`. For pg-mem, `reset()` builds a brand-new in-memory database (the
 * cleanest form of isolation — pg-mem does not fully support DROP of PK
 * index relations). For real PG, `reset()` drops and recreates the schema.
 *
 * Note: pg-mem does not enforce `search_path` schema qualification the way real
 * PG does, so the DDL is applied to the default (public) schema in-memory. The
 * store impls use unqualified table names, so they work identically against
 * both.
 */
export interface PgTestHarness {
  readonly pool: Pool;
  /** Recreate a clean database/schema — call in beforeEach for isolation. */
  reset(): Promise<void>;
  close(): Promise<void>;
}

const REAL_PG_URL = process.env.PG_TEST_URL;

async function createRealPgHarness(url: string): Promise<PgTestHarness> {
  const pg = await import("pg");
  const schema = process.env.PG_TEST_SCHEMA ?? "oma_test";
  const pool = new pg.default.Pool({ connectionString: url }) as unknown as Pool;
  (pool as unknown as { on: (e: string, cb: (c: { query: (q: string) => unknown }) => void) => void }).on(
    "connect",
    (client) => {
      void client.query(`SET search_path TO "${schema}"`);
    },
  );

  const reset = async () => {
    await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await ensureSchema(pool, schema);
  };
  await reset();

  return {
    get pool() {
      return pool;
    },
    reset,
    close: async () => {
      await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => {});
      await (pool as unknown as { end: () => Promise<void> }).end();
    },
  };
}

function createMemHarness(): PgTestHarness {
  let pool: Pool;

  const reset = async () => {
    const db = newDb();
    db.public.registerFunction({
      name: "clock_timestamp",
      returns: DataType.timestamptz,
      impure: true,
      implementation: () => new Date(),
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
    reset,
    close: async () => {
      /* pg-mem is process-local; nothing to release */
    },
  };
}

export async function createPgTestHarness(): Promise<PgTestHarness> {
  if (REAL_PG_URL) {
    return createRealPgHarness(REAL_PG_URL);
  }
  const harness = createMemHarness();
  await harness.reset();
  return harness;
}
