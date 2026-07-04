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
}

export const DEFAULT_SCHEMA = "oma";

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
  });

  // Pin the search_path for every pooled connection so unqualified identifiers
  // resolve against the target schema.
  pool.on("connect", (client) => {
    void client.query(`SET search_path TO "${schema}"`);
  });

  return pool;
}

/**
 * Read a PgConnectionConfig from the environment.
 *
 * Precedence:
 *  - PG_URL / DATABASE_URL (connection string), OR
 *  - PGHOST/PGPORT/PGUSER/PGPASSWORD/PGDATABASE discrete fields.
 * Schema comes from PG_SCHEMA (default "oma"). SSL from PGSSL (default off).
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
  };
}
