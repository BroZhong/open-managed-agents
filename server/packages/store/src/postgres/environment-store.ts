import { EnvironmentNameConflictError } from "../errors.js";
import { environmentDefinitionSha256, newEnvironmentBuildId } from "../environment.js";
import type { Pool, PoolClient } from "./connection.js";
import type {
  ClaimedEnvironmentBuild,
  Environment,
  EnvironmentBaseImage,
  EnvironmentBuild,
  EnvironmentBuildLease,
  EnvironmentBuildQueue,
  EnvironmentBuildRenewal,
  EnvironmentBuildStatus,
  EnvironmentOwner,
  EnvironmentOwnerType,
  EnvironmentStatus,
  EnvironmentStore,
  EnvironmentStoreCreateInput,
  EnvironmentStoreUpdateInput,
  EnvironmentVariable,
  SandboxEnvironmentRecord,
} from "../interfaces/environment-store.js";

interface EnvironmentRow {
  id: string;
  owner_type: EnvironmentOwnerType;
  tenant_id: string | null;
  name: string;
  description: string;
  base_image: EnvironmentBaseImage;
  init_script: string;
  env: EnvironmentVariable[];
  secrets: Record<string, string>;
  status: EnvironmentStatus;
  image: string | null;
  manifest: Record<string, unknown> | null;
  last_build_id: string | null;
  created_at: Date;
  updated_at: Date;
  build_status: EnvironmentBuildStatus | null;
  build_created_at: Date | null;
  build_started_at: Date | null;
  build_finished_at: Date | null;
  build_error_code: string | null;
  build_error_message: string | null;
}

interface BuildRow {
  id: string;
  environment_id: string;
  owner_type: EnvironmentOwnerType;
  tenant_id: string | null;
  status: EnvironmentBuildStatus;
  base_image: EnvironmentBaseImage;
  init_script: string;
  definition_sha256: string;
  base_image_digest: string | null;
  attempts: number;
  retries: number;
  lease_owner: string | null;
  lease_expires_at: Date | null;
  created_at: Date;
  started_at: Date | null;
  finished_at: Date | null;
  error_code: string | null;
  error_message: string | null;
  image: string | null;
  manifest: Record<string, unknown> | null;
  log_key: string | null;
}

const date = (value: Date | null) => (value == null ? null : new Date(value));

/** An Environment with its latest build's summary. */
const SELECT_ENVIRONMENT = `
  SELECT e.*, b.status AS build_status, b.created_at AS build_created_at, b.started_at AS build_started_at,
    b.finished_at AS build_finished_at, b.error_code AS build_error_code, b.error_message AS build_error_message
  FROM environments e LEFT JOIN environment_builds b ON b.id = e.last_build_id`;

function rowToEnvironment(row: EnvironmentRow): Environment {
  return {
    id: row.id,
    ownerType: row.owner_type,
    tenantId: row.tenant_id,
    name: row.name,
    description: row.description,
    baseImage: row.base_image,
    initScript: row.init_script,
    env: row.env,
    encryptedSecrets: row.secrets,
    status: row.status,
    image: row.image,
    manifest: row.manifest,
    lastBuild: row.last_build_id && row.build_status ? {
      id: row.last_build_id,
      status: row.build_status,
      createdAt: new Date(row.build_created_at!),
      startedAt: date(row.build_started_at),
      finishedAt: date(row.build_finished_at),
      errorCode: row.build_error_code,
      errorMessage: row.build_error_message,
    } : null,
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
  };
}

function rowToBuild(row: BuildRow): EnvironmentBuild {
  return {
    id: row.id,
    environmentId: row.environment_id,
    ownerType: row.owner_type,
    tenantId: row.tenant_id,
    status: row.status,
    baseImage: row.base_image,
    initScript: row.init_script,
    definitionSha256: row.definition_sha256,
    baseImageDigest: row.base_image_digest,
    attempts: row.attempts,
    retries: row.retries,
    leaseOwner: row.lease_owner,
    leaseExpiresAt: date(row.lease_expires_at),
    createdAt: new Date(row.created_at),
    startedAt: date(row.started_at),
    finishedAt: date(row.finished_at),
    errorCode: row.error_code,
    errorMessage: row.error_message,
    image: row.image,
    manifest: row.manifest,
    logKey: row.log_key,
  };
}

/** SQL restricting `environments` to the rows `owner` owns; appends its parameter. */
function ownedBy(owner: EnvironmentOwner, params: unknown[]): string {
  if (owner.ownerType === "platform") return `owner_type = 'platform'`;
  params.push(owner.tenantId);
  return `owner_type = 'tenant' AND tenant_id = $${params.length}`;
}

const tenantOf = (owner: EnvironmentOwner) => (owner.ownerType === "tenant" ? owner.tenantId : null);

/** A build row's fence: the lease a builder holds on it. */
const HELD = `status = 'running' AND lease_owner = $2 AND attempts = $3`;
const leaseParams = (lease: EnvironmentBuildLease) => [lease.buildId, lease.owner, lease.attempt];
const LEASE_EXPIRES = (param: string) => `clock_timestamp() + CAST(${param} || ' milliseconds' AS interval)`;

function validateLeaseMs(leaseMs: number): void {
  if (!Number.isSafeInteger(leaseMs) || leaseMs < 1) throw new RangeError("Environment Build lease must be a positive integer of milliseconds");
}

export class PgEnvironmentStore implements EnvironmentStore, EnvironmentBuildQueue {
  constructor(private readonly pool: Pool) {}

  async list(tenantId: string): Promise<Environment[]> {
    const { rows } = await this.pool.query<EnvironmentRow>(
      `${SELECT_ENVIRONMENT}
       WHERE (e.owner_type = 'platform' OR e.tenant_id = $1) AND e.deleted_at IS NULL
       ORDER BY CASE WHEN e.owner_type = 'platform' THEN 0 ELSE 1 END, e.name, e.id`,
      [tenantId],
    );
    return rows.map(rowToEnvironment);
  }

  async get(tenantId: string, id: string): Promise<Environment | null> {
    const { rows } = await this.pool.query<EnvironmentRow>(
      `${SELECT_ENVIRONMENT}
       WHERE e.id = $1 AND (e.owner_type = 'platform' OR e.tenant_id = $2) AND e.deleted_at IS NULL`,
      [id, tenantId],
    );
    return rows[0] ? rowToEnvironment(rows[0]) : null;
  }

  async listForSessions(tenantId: string, ids: readonly string[]): Promise<Environment[]> {
    const unique = [...new Set(ids)];
    if (unique.length === 0) return [];
    // A list of parameters rather than = ANY($n): pg-mem matches no row with ANY.
    const listed = unique.map((_, i) => `$${i + 2}`).join(", ");
    const { rows } = await this.pool.query<EnvironmentRow>(
      `${SELECT_ENVIRONMENT}
       WHERE e.id IN (${listed}) AND (e.owner_type = 'platform' OR e.tenant_id = $1)`,
      [tenantId, ...unique],
    );
    return rows.map(rowToEnvironment);
  }

  async getForSandbox(tenantId: string, id: string): Promise<SandboxEnvironmentRecord | null> {
    // A primary-key read of the columns a command needs: no build join, script or manifest.
    const { rows: [row] } = await this.pool.query<Pick<EnvironmentRow, "id" | "tenant_id" | "image" | "env" | "secrets">>(
      `SELECT id, tenant_id, image, env, secrets FROM environments
       WHERE id = $1 AND (owner_type = 'platform' OR tenant_id = $2)`,
      [id, tenantId],
    );
    return row ? { id: row.id, tenantId: row.tenant_id, image: row.image, env: row.env, encryptedSecrets: row.secrets } : null;
  }

  async create(input: EnvironmentStoreCreateInput): Promise<Environment> {
    return this.transaction(async (client) => {
      await this.assertNameFree(client, input.owner, input.name);
      const now = new Date();
      const buildId = await this.queueBuild(client, input.id, input.owner, input.baseImage, input.initScript, now);
      await client.query(
        `INSERT INTO environments (id, owner_type, tenant_id, name, description, base_image, init_script, env, secrets,
           status, last_build_id, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb, 'pending', $10, $11, $11)`,
        [input.id, input.owner.ownerType, tenantOf(input.owner), input.name, input.description, input.baseImage,
          input.initScript, JSON.stringify(input.env), JSON.stringify(input.encryptedSecrets), buildId, now],
      ).catch((error) => rethrowNameConflict(error, input.name));
      return (await this.read(client, input.id))!;
    });
  }

  async update(owner: EnvironmentOwner, id: string, input: EnvironmentStoreUpdateInput): Promise<Environment | null> {
    return this.transaction(async (client) => {
      const params: unknown[] = [id];
      const where = ownedBy(owner, params);
      const { rows } = await client.query<EnvironmentRow>(
        `SELECT * FROM environments WHERE id = $1 AND ${where} AND deleted_at IS NULL FOR UPDATE`,
        params,
      );
      const row = rows[0];
      if (!row) return null;
      if (input.name !== undefined && input.name !== row.name) await this.assertNameFree(client, owner, input.name, id);
      const now = new Date();
      const sets: string[] = [];
      const values: unknown[] = [];
      const set = (column: string, value: unknown, cast = "") => {
        values.push(value);
        sets.push(`${column} = $${values.length}${cast}`);
      };
      if (input.name !== undefined) set("name", input.name);
      if (input.description !== undefined) set("description", input.description);
      if (input.baseImage !== undefined) set("base_image", input.baseImage);
      if (input.initScript !== undefined) set("init_script", input.initScript);
      if (input.env !== undefined) set("env", JSON.stringify(input.env), "::jsonb");
      if (input.encryptedSecrets !== undefined) set("secrets", JSON.stringify(input.encryptedSecrets), "::jsonb");
      const baseImage = input.baseImage ?? row.base_image;
      const initScript = input.initScript ?? row.init_script;
      if (baseImage !== row.base_image || initScript !== row.init_script) {
        await this.supersedeActiveBuild(client, id, now);
        set("last_build_id", await this.queueBuild(client, id, owner, baseImage, initScript, now));
        set("status", "pending");
      }
      set("updated_at", now);
      values.push(id);
      await client.query(`UPDATE environments SET ${sets.join(", ")} WHERE id = $${values.length}`, values)
        .catch((error) => rethrowNameConflict(error, input.name ?? row.name));
      return this.read(client, id);
    });
  }

  async delete(owner: EnvironmentOwner, id: string): Promise<boolean> {
    return this.transaction(async (client) => {
      const now = new Date();
      const params: unknown[] = [id, now];
      const { rows } = await client.query<{ id: string }>(
        `UPDATE environments SET deleted_at = $2, updated_at = $2
         WHERE id = $1 AND ${ownedBy(owner, params)} AND deleted_at IS NULL RETURNING id`,
        params,
      );
      if (!rows[0]) return false;
      await this.supersedeActiveBuild(client, id, now);
      return true;
    });
  }

  async rebuild(owner: EnvironmentOwner, id: string): Promise<Environment | null> {
    return this.transaction(async (client) => {
      const params: unknown[] = [id];
      const { rows } = await client.query<EnvironmentRow>(
        `SELECT * FROM environments WHERE id = $1 AND ${ownedBy(owner, params)} AND deleted_at IS NULL FOR UPDATE`,
        params,
      );
      const row = rows[0];
      if (!row) return null;
      const now = new Date();
      await this.supersedeActiveBuild(client, id, now);
      const buildId = await this.queueBuild(client, id, owner, row.base_image, row.init_script, now);
      await client.query(`UPDATE environments SET last_build_id = $2, status = 'pending' WHERE id = $1`, [id, buildId]);
      return this.read(client, id);
    });
  }

  async listBuilds(environmentId: string): Promise<EnvironmentBuild[]> {
    const { rows } = await this.pool.query<BuildRow>(
      `SELECT * FROM environment_builds WHERE environment_id = $1 ORDER BY seq DESC`,
      [environmentId],
    );
    return rows.map(rowToBuild);
  }

  async getBuild(environmentId: string, buildId: string): Promise<EnvironmentBuild | null> {
    const { rows } = await this.pool.query<BuildRow>(
      `SELECT * FROM environment_builds WHERE id = $1 AND environment_id = $2`,
      [buildId, environmentId],
    );
    return rows[0] ? rowToBuild(rows[0]) : null;
  }

  async claimBuild(owner: string, leaseMs: number): Promise<ClaimedEnvironmentBuild | null> {
    if (!owner) throw new RangeError("Environment Build lease owner must not be empty");
    validateLeaseMs(leaseMs);
    return this.transaction(async (client) => {
      // Skip a row another builder is claiming; the claim re-checks the
      // lease after the lock, by the database's clock.
      const candidate = await client.query<{ id: string; status: EnvironmentBuildStatus }>(
        `SELECT id, status FROM environment_builds
         WHERE status = 'pending' OR (status = 'running' AND lease_expires_at <= clock_timestamp())
         ORDER BY seq ASC
         LIMIT 1
         FOR UPDATE SKIP LOCKED`,
      );
      const head = candidate.rows[0];
      if (!head) return null;
      const { rows } = await client.query<BuildRow>(
        `UPDATE environment_builds
         SET status = 'running', attempts = attempts + 1, lease_owner = $2,
             lease_expires_at = ${LEASE_EXPIRES("$3")},
             started_at = COALESCE(started_at, clock_timestamp())
         WHERE id = $1 AND (status = 'pending' OR (status = 'running' AND lease_expires_at <= clock_timestamp()))
         RETURNING *`,
        [head.id, owner, leaseMs],
      );
      const row = rows[0];
      if (!row) return null;
      await client.query(
        `UPDATE environments SET status = 'building' WHERE id = $1 AND last_build_id = $2 AND deleted_at IS NULL`,
        [row.environment_id, row.id],
      );
      const env = await client.query<{ env: EnvironmentVariable[] }>(`SELECT env FROM environments WHERE id = $1`, [row.environment_id]);
      const build = rowToBuild(row);
      return {
        build,
        lease: { buildId: build.id, owner, attempt: build.attempts },
        env: env.rows[0]?.env ?? [],
        reclaimed: head.status === "running",
      };
    });
  }

  async renewBuild(lease: EnvironmentBuildLease, leaseMs: number): Promise<EnvironmentBuildRenewal> {
    validateLeaseMs(leaseMs);
    return this.transaction(async (client) => {
      // Lock first: the lease is judged after any concurrent writer committed.
      const locked = await client.query<{ status: EnvironmentBuildStatus }>(
        `SELECT status FROM environment_builds WHERE id = $1 FOR UPDATE`, [lease.buildId]);
      const status = locked.rows[0]?.status;
      if (status === "superseded") return "superseded";
      const { rows } = await client.query(
        `UPDATE environment_builds SET lease_expires_at = ${LEASE_EXPIRES("$4")}
         WHERE id = $1 AND ${HELD} AND lease_expires_at > clock_timestamp() RETURNING id`,
        [...leaseParams(lease), leaseMs],
      );
      return rows[0] ? "renewed" : "lost";
    });
  }

  async retryBuild(lease: EnvironmentBuildLease, leaseMs: number): Promise<EnvironmentBuildLease | null> {
    validateLeaseMs(leaseMs);
    return this.transaction(async (client) => {
      await client.query(`SELECT id FROM environment_builds WHERE id = $1 FOR UPDATE`, [lease.buildId]);
      const { rows } = await client.query<{ attempts: number }>(
        `UPDATE environment_builds SET attempts = attempts + 1, retries = retries + 1, lease_expires_at = ${LEASE_EXPIRES("$4")}
         WHERE id = $1 AND ${HELD} AND lease_expires_at > clock_timestamp() RETURNING attempts`,
        [...leaseParams(lease), leaseMs],
      );
      return rows[0] ? { ...lease, attempt: rows[0].attempts } : null;
    });
  }

  async releaseBuild(lease: EnvironmentBuildLease): Promise<boolean> {
    const { rows } = await this.pool.query(
      `UPDATE environment_builds SET lease_expires_at = clock_timestamp() WHERE id = $1 AND ${HELD} RETURNING id`,
      leaseParams(lease),
    );
    return rows.length > 0;
  }

  async recordBuildProgress(lease: EnvironmentBuildLease, progress: { baseImageDigest?: string; logKey?: string }): Promise<boolean> {
    const { rows } = await this.pool.query(
      `UPDATE environment_builds
       SET base_image_digest = COALESCE($4, base_image_digest), log_key = COALESCE($5, log_key)
       WHERE id = $1 AND ${HELD} RETURNING id`,
      [...leaseParams(lease), progress.baseImageDigest ?? null, progress.logKey ?? null],
    );
    return rows.length > 0;
  }

  async succeedBuild(lease: EnvironmentBuildLease, result: { image: string; manifest: Record<string, unknown> }): Promise<boolean> {
    return this.finish(lease, "succeeded", async (client, environmentId) => {
      await client.query(
        `UPDATE environment_builds SET image = $2, manifest = $3::jsonb WHERE id = $1`,
        [lease.buildId, result.image, JSON.stringify(result.manifest)],
      );
      await client.query(
        `UPDATE environments SET status = 'ready', image = $3, manifest = $4::jsonb
         WHERE id = $1 AND last_build_id = $2 AND deleted_at IS NULL`,
        [environmentId, lease.buildId, result.image, JSON.stringify(result.manifest)],
      );
    });
  }

  async failBuild(lease: EnvironmentBuildLease, error: { code: string; message: string }): Promise<boolean> {
    return this.finish(lease, "failed", async (client, environmentId) => {
      await client.query(
        `UPDATE environment_builds SET error_code = $2, error_message = $3 WHERE id = $1`,
        [lease.buildId, error.code, error.message],
      );
      await client.query(
        `UPDATE environments SET status = 'failed' WHERE id = $1 AND last_build_id = $2 AND deleted_at IS NULL`,
        [environmentId, lease.buildId],
      );
    });
  }

  async getBuiltIn(id: string): Promise<Environment | null> {
    const { rows } = await this.pool.query<EnvironmentRow>(
      `${SELECT_ENVIRONMENT} WHERE e.id = $1 AND e.owner_type = 'platform' AND e.deleted_at IS NULL`,
      [id],
    );
    return rows[0] ? rowToEnvironment(rows[0]) : null;
  }

  async listBuiltOnOtherBaseImage(baseImage: EnvironmentBaseImage, digest: string): Promise<Array<{ id: string; owner: EnvironmentOwner }>> {
    const { rows } = await this.pool.query<{ id: string; owner_type: EnvironmentOwnerType; tenant_id: string | null }>(
      `SELECT e.id, e.owner_type, e.tenant_id FROM environments e JOIN environment_builds b ON b.id = e.last_build_id
       WHERE e.base_image = $1 AND e.deleted_at IS NULL AND b.status IN ('succeeded', 'failed')
         AND (b.base_image_digest IS NULL OR b.base_image_digest <> $2)
       ORDER BY e.id`,
      [baseImage, digest],
    );
    return rows.map((row) => ({
      id: row.id,
      owner: row.owner_type === "platform" ? { ownerType: "platform" } : { ownerType: "tenant", tenantId: row.tenant_id! },
    }));
  }

  /**
   * End a held build with `status`, then let `record` write the outcome, in
   * one transaction. A lease that lapsed without a reclaim still finishes:
   * only a newer holder or a supersede fences it out.
   */
  private async finish(
    lease: EnvironmentBuildLease,
    status: "succeeded" | "failed",
    record: (client: PoolClient, environmentId: string) => Promise<void>,
  ): Promise<boolean> {
    return this.transaction(async (client) => {
      await client.query(`SELECT id FROM environment_builds WHERE id = $1 FOR UPDATE`, [lease.buildId]);
      const { rows } = await client.query<{ environment_id: string }>(
        `UPDATE environment_builds SET status = $4, finished_at = clock_timestamp()
         WHERE id = $1 AND ${HELD} RETURNING environment_id`,
        [...leaseParams(lease), status],
      );
      if (!rows[0]) return false;
      await record(client, rows[0].environment_id);
      return true;
    });
  }

  private async read(client: PoolClient, id: string): Promise<Environment | null> {
    const { rows } = await client.query<EnvironmentRow>(`${SELECT_ENVIRONMENT} WHERE e.id = $1`, [id]);
    return rows[0] ? rowToEnvironment(rows[0]) : null;
  }

  /** The unique indexes are the backstop; checking first names the conflict on every PostgreSQL. */
  private async assertNameFree(client: PoolClient, owner: EnvironmentOwner, name: string, exceptId?: string): Promise<void> {
    const params: unknown[] = [name, exceptId ?? ""];
    const { rows } = await client.query(
      `SELECT 1 FROM environments WHERE name = $1 AND id <> $2 AND ${ownedBy(owner, params)} AND deleted_at IS NULL`,
      params,
    );
    if (rows.length) throw new EnvironmentNameConflictError(name);
  }

  private async supersedeActiveBuild(client: PoolClient, environmentId: string, now: Date): Promise<void> {
    await client.query(
      `UPDATE environment_builds SET status = 'superseded', finished_at = $2
       WHERE environment_id = $1 AND status IN ('pending', 'running')`,
      [environmentId, now],
    );
  }

  private async queueBuild(
    client: PoolClient, environmentId: string, owner: EnvironmentOwner,
    baseImage: EnvironmentBaseImage, initScript: string, now: Date,
  ): Promise<string> {
    const id = newEnvironmentBuildId();
    await client.query(
      `INSERT INTO environment_builds (id, environment_id, owner_type, tenant_id, status, base_image, init_script, definition_sha256, created_at)
       VALUES ($1, $2, $3, $4, 'pending', $5, $6, $7, $8)`,
      [id, environmentId, owner.ownerType, tenantOf(owner), baseImage, initScript, environmentDefinitionSha256(baseImage, initScript), now],
    );
    return id;
  }

  private async transaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await work(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }
}

function rethrowNameConflict(error: { code?: string; constraint?: string }, name: string): never {
  if (error.code === "23505" && /^environments_(tenant|platform)_name_unique$/.test(error.constraint ?? "")) {
    throw new EnvironmentNameConflictError(name);
  }
  throw error;
}
