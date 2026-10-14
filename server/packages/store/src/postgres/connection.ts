import pg from "pg";

const { Pool } = pg;

export type Pool = pg.Pool;
export type PoolClient = pg.PoolClient;

export interface PgConnectionConfig {
  /** Full connection string; takes precedence over discrete fields when set. */
  connectionString?: string;
  host?: string;
  port?: number;
  user?: string;
  password?: string;
  database?: string;
  /** Postgres schema the stores read/write. Defaults to "oma". */
  schema?: string;
  ssl?: boolean;
  /** Maximum pooled clients. Defaults to node-postgres' 10. */
  max?: number;
  /** Fail a checkout after this wait instead of queueing forever. */
  connectionTimeoutMillis?: number;
}

export const DEFAULT_SCHEMA = "oma";
/** A saturated pool must surface as an error, never as a silent permanent hang. */
export const DEFAULT_CONNECTION_TIMEOUT_MS = 15_000;

/**
 * Build a pg Pool from a config object. The `schema` is applied per-connection
 * via `search_path` so all queries can use unqualified table names.
 */
export function createPgPool(config: PgConnectionConfig): Pool {
  const schema = config.schema ?? DEFAULT_SCHEMA;
  const pool = new Pool({
    connectionString: config.connectionString,
    host: config.host,
    port: config.port,
    user: config.user,
    password: config.password,
    database: config.database,
    ssl: config.ssl ? { rejectUnauthorized: false } : undefined,
    max: config.max,
    connectionTimeoutMillis: config.connectionTimeoutMillis ?? DEFAULT_CONNECTION_TIMEOUT_MS,
  });

  // Pin the search_path for every pooled connection so unqualified identifiers
  // resolve against the target schema.
  pool.on("connect", (client) => {
    void client.query(`SET search_path TO "${schema}"`);
    // pg-pool listens only while a client is idle. A server-side termination of
    // a checked-out client (e.g. idle_in_transaction_session_timeout) must fail
    // that client's query, not crash the process via an unhandled 'error'.
    client.on("error", (error) => console.error("PostgreSQL client error:", error.message));
  });
  pool.on("error", (error) => console.error("PostgreSQL idle client error:", error.message));

  return pool;
}

function positiveInteger(name: string, raw: string | undefined): number | undefined {
  if (raw === undefined || raw === "") return undefined;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) throw new RangeError(`${name} must be a positive integer`);
  return value;
}

/**
 * Read a PgConnectionConfig from the environment.
 *
 * Precedence:
 *  - PG_URL / DATABASE_URL (connection string), OR
 *  - PGHOST/PGPORT/PGUSER/PGPASSWORD/PGDATABASE discrete fields.
 * Schema comes from PG_SCHEMA (default "oma"). SSL from PGSSL (default off).
 * Pool size from PG_POOL_MAX; checkout wait from PG_POOL_CONNECTION_TIMEOUT_MS.
 */
export function pgConfigFromEnv(env: NodeJS.ProcessEnv = process.env): PgConnectionConfig {
  const connectionString = env.PG_URL ?? env.DATABASE_URL;
  const sslRaw = env.PGSSL ?? env.PG_SSL;
  const ssl = sslRaw != null && (sslRaw === "1" || sslRaw.toLowerCase() === "true");

  return {
    connectionString,
    host: env.PGHOST ?? env.PG_HOST,
    port: env.PGPORT ? Number(env.PGPORT) : env.PG_PORT ? Number(env.PG_PORT) : undefined,
    user: env.PGUSER ?? env.PG_USER,
    password: env.PGPASSWORD ?? env.PG_PASSWORD,
    database: env.PGDATABASE ?? env.PG_DATABASE,
    schema: env.PG_SCHEMA ?? DEFAULT_SCHEMA,
    ssl,
    max: positiveInteger("PG_POOL_MAX", env.PG_POOL_MAX),
    connectionTimeoutMillis: positiveInteger("PG_POOL_CONNECTION_TIMEOUT_MS", env.PG_POOL_CONNECTION_TIMEOUT_MS),
  };
}
