/**
 * A minimal read-only Supabase Storage reader for the one-time Skill Bundle
 * migration (#266). It mirrors `SupabaseStorageClient.listRecursive` and
 * `getObject` of `@oma-server/store` (key layout of `S3SkillArtifactStore`:
 * `<tenantId>/skills/<skillId>/<path>`) so the tool keeps working after the
 * runtime Supabase Skill code is deleted, and is itself removed with #272.
 *
 * Supabase Storage answered HTTP 544 `DatabaseTimeout` under load (#259), so
 * requests in flight are bounded and 544, other 5xx, 429 and network errors are
 * retried with exponential backoff. Errors carry the HTTP status and Supabase's
 * error code only: never a URL, a header or a response body.
 */

export interface SupabaseSkillReaderOptions {
  /** Supabase Storage REST base, e.g. `http://host:80/storage/v1`. */
  endpoint: string;
  /** service_role JWT sent as `Authorization: Bearer <serviceKey>`. */
  serviceKey: string;
  bucket: string;
  fetch?: typeof fetch;
  /** Requests in flight. Default 4. */
  concurrency?: number;
  /** Attempts per request, including the first. Default 5. */
  maxAttempts?: number;
  /** First retry delay; doubled per retry, plus up to 25% jitter. Default 500 ms. */
  backoffMs?: number;
  /** `object/list` page size. Default 1000, as the runtime client. */
  listPageSize?: number;
  sleep?: (ms: number) => Promise<void>;
}

export interface SupabaseReadStats {
  requests: number;
  retries: number;
  /** Retries by HTTP status, or `network`. */
  retriesByCause: Record<string, number>;
}

export class SupabaseObjectMissingError extends Error {
  constructor(readonly path: string) {
    super(`Supabase object listed for the Skill is missing: ${path}`);
    this.name = "SupabaseObjectMissingError";
  }
}

type Outcome<T> = { kind: "ok"; value: T } | { kind: "missing" } | { kind: "error"; status: number; code: string };

/** A final, non-retryable answer. */
class SupabaseRequestError extends Error {}

interface ListEntry {
  name: string;
  id?: string | null;
  metadata?: object | null;
}

class Semaphore {
  private active = 0;
  private readonly waiting: Array<() => void> = [];
  constructor(private readonly limit: number) {}

  async run<T>(task: () => Promise<T>): Promise<T> {
    if (this.active >= this.limit) await new Promise<void>((resolve) => this.waiting.push(resolve));
    else this.active += 1;
    try {
      return await task();
    } finally {
      const next = this.waiting.shift();
      if (next) next();
      else this.active -= 1;
    }
  }
}

const RETRYABLE = (status: number) => status === 429 || status >= 500;

/** Supabase answers a missing object with 404, or 400 and a JSON body whose status code is 404. */
function isMissing(status: number, body: string): boolean {
  if (status === 404) return true;
  if (status !== 400) return false;
  try {
    const parsed = JSON.parse(body) as Record<string, unknown>;
    return String(parsed.statusCode ?? parsed.status ?? parsed.code) === "404" ||
      /\bnot[ _]found\b/i.test(String(parsed.error ?? ""));
  } catch {
    return false;
  }
}

/** Supabase's short error code (`DatabaseTimeout`, `Unauthorized`, …), never free text that could echo input. */
function errorCode(body: string): string {
  try {
    const code = (JSON.parse(body) as Record<string, unknown>).error;
    return typeof code === "string" && /^[A-Za-z0-9_ -]{1,64}$/.test(code) ? ` ${code}` : "";
  } catch {
    return "";
  }
}

export class SupabaseSkillReader {
  readonly stats: SupabaseReadStats = { requests: 0, retries: 0, retriesByCause: {} };
  private readonly endpoint: string;
  private readonly serviceKey: string;
  private readonly bucket: string;
  private readonly fetchImpl: typeof fetch;
  private readonly semaphore: Semaphore;
  private readonly maxAttempts: number;
  private readonly backoffMs: number;
  private readonly listPageSize: number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(options: SupabaseSkillReaderOptions) {
    if (!options.endpoint) throw new Error("Supabase Storage endpoint is required");
    if (!options.serviceKey) throw new Error("Supabase Storage service key is required");
    if (!options.bucket) throw new Error("Supabase Storage bucket is required");
    this.endpoint = options.endpoint.replace(/\/+$/, "");
    this.serviceKey = options.serviceKey;
    this.bucket = options.bucket;
    this.fetchImpl = options.fetch ?? fetch;
    this.semaphore = new Semaphore(options.concurrency ?? 4);
    this.maxAttempts = options.maxAttempts ?? 5;
    this.backoffMs = options.backoffMs ?? 500;
    this.listPageSize = options.listPageSize ?? 1000;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  /** `<tenantId>/skills/<skillId>`: the key prefix of `S3SkillArtifactStore`. */
  private prefix(tenantId: string, skillId: string): string {
    return `${encodeURIComponent(tenantId)}/skills/${encodeURIComponent(skillId)}`;
  }

  /**
   * One request with retries. `accept` turns a final response into a result;
   * it runs inside the concurrency slot so the body is consumed before release.
   */
  private async request<T>(operation: "list" | "read", url: string, init: RequestInit,
    accept: (response: Response) => Promise<T>): Promise<T> {
    for (let attempt = 1; ; attempt += 1) {
      let cause: string;
      let detail = "";
      try {
        const result = await this.semaphore.run(async (): Promise<Outcome<T>> => {
          this.stats.requests += 1;
          const response = await this.fetchImpl(url, {
            ...init, headers: { ...(init.headers as Record<string, string>), Authorization: `Bearer ${this.serviceKey}` },
          });
          if (response.ok) return { kind: "ok", value: await accept(response) };
          const body = await response.text().catch(() => "");
          if (operation === "read" && isMissing(response.status, body)) return { kind: "missing" };
          return { kind: "error", status: response.status, code: errorCode(body) };
        });
        if (result.kind === "ok") return result.value;
        if (result.kind === "missing") throw new SupabaseObjectMissingError("");
        if (!RETRYABLE(result.status)) throw new SupabaseRequestError(`Supabase ${operation} failed: HTTP ${result.status}${result.code}`);
        cause = String(result.status);
        detail = `HTTP ${result.status}${result.code}`;
      } catch (error) {
        if (error instanceof SupabaseObjectMissingError || error instanceof SupabaseRequestError) throw error;
        cause = "network";
        detail = `network error (${(error as Error).name})`;
      }
      if (attempt >= this.maxAttempts) throw new Error(`Supabase ${operation} failed after ${attempt} attempts: ${detail}`);
      this.stats.retries += 1;
      this.stats.retriesByCause[cause] = (this.stats.retriesByCause[cause] ?? 0) + 1;
      const delay = this.backoffMs * 2 ** (attempt - 1);
      await this.sleep(delay + Math.floor(Math.random() * delay * 0.25));
    }
  }

  private async listFolder(folder: string, onFile: (key: string) => void): Promise<void> {
    for (let offset = 0; ;) {
      const entries = await this.request("list", `${this.endpoint}/object/list/${encodeURIComponent(this.bucket)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prefix: folder, limit: this.listPageSize, offset }),
      }, async (response) => (await response.json()) as ListEntry[]);
      for (const entry of entries) {
        // Supabase lists a folder as an entry without id and metadata.
        if (entry.id == null && entry.metadata == null) await this.listFolder(`${folder}${entry.name}/`, onFile);
        else onFile(`${folder}${entry.name}`);
      }
      if (entries.length < this.listPageSize) return;
      offset += entries.length;
    }
  }

  /** Every file of the Skill, as Skill-relative paths in code-unit order. */
  async list(tenantId: string, skillId: string): Promise<string[]> {
    const base = `${this.prefix(tenantId, skillId)}/`;
    const paths: string[] = [];
    await this.listFolder(base, (key) => paths.push(key.slice(base.length)));
    return paths.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  }

  /** One file's bytes. A listed file that is gone throws {@link SupabaseObjectMissingError}. */
  async read(tenantId: string, skillId: string, path: string): Promise<Uint8Array> {
    const key = `${this.prefix(tenantId, skillId)}/${path}`;
    const url = `${this.endpoint}/object/${encodeURIComponent(this.bucket)}/${key.split("/").map(encodeURIComponent).join("/")}`;
    try {
      return await this.request("read", url, { method: "GET" }, async (response) => new Uint8Array(await response.arrayBuffer()));
    } catch (error) {
      if (error instanceof SupabaseObjectMissingError) throw new SupabaseObjectMissingError(path);
      throw error;
    }
  }
}
