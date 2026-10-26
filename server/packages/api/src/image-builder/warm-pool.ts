import type { EnvironmentBuildQueue } from "@oma-server/store";
import { isNotFound, type KubernetesApi } from "../lib/kubernetes.js";
import type { Clock } from "./ports.js";

/** The deployment's Warm Pool: one SandboxSet whose pod template runs one image. */
export interface WarmPool {
  readonly name: string;
  /** The image the pool's Sandboxes start with. */
  image(): Promise<string>;
  /** Point the pool at `image`; Kruise replaces its idle Sandboxes. */
  setImage(image: string): Promise<void>;
}

/**
 * An ACS ImageCache of an image (ADR-0024 "Starting a Sandbox"): `ready`
 * once pods created with the image skip its pull; `creating` while ACS
 * pulls and builds it (about 4 min in #299's bench); `failed` for good.
 */
export interface ImageCacheState {
  state: "ready" | "creating" | "failed";
  id?: string;
  detail?: string;
}

/** Creates or finds the ImageCache of an image (`acs-image-cache.ts`). */
export interface ImageCaches {
  /** The image's cache, created when there is none. Idempotent. */
  ensure(image: string): Promise<ImageCacheState>;
}

export type WarmPoolOutcome = "no-image" | "unchanged" | "updated" | "waiting-for-cache" | "cache-failed";

export interface WarmPoolUpdaterDeps {
  store: Pick<EnvironmentBuildQueue, "getBuiltIn">;
  /** The Built-in Environment the pool runs (`env_video_production`). */
  environmentId: string;
  pool: WarmPool;
  /**
   * Caches the new image before the pool points at it. Null: the pool is
   * pointed at once, and every refill pulls the whole image until a cache
   * exists (73–81 s for 1.9 GB in #299).
   */
  caches: ImageCaches | null;
  clock: Clock;
  logger?: Pick<Console, "info" | "warn" | "error">;
  /** How often the pool is compared with the Environment's image (and a cache in progress re-read). */
  recheckMs?: number;
  /** How long a cache seen ready for the pool's own image is trusted before it is listed again. */
  cacheRecheckMs?: number;
}

const RECHECK_MS = 30_000;
const CACHE_RECHECK_MS = 10 * 60_000;

/**
 * Keeps the Warm Pool on its Environment's image (ADR-0024): when that
 * Environment's build succeeds, its new image gets an ACS ImageCache first
 * (when configured), and only once the cache is ready is the pool's
 * SandboxSet patched, so Sessions of that Environment claim without a swap
 * and refills hit the cache. Runs at startup, after every build of the
 * Environment and every `recheckMs`; every step is idempotent.
 */
export class WarmPoolUpdater {
  private readonly logger: Pick<Console, "info" | "warn" | "error">;
  private readonly stopping = new AbortController();
  private wake?: () => void;
  private loop?: Promise<void>;
  /** The image whose cache was last reported, so a wait is logged once. */
  private reported?: string;
  /** The image whose cache was last seen ready, and when: the pool's recheck need not list it again. */
  private cached?: { image: string; at: number };

  constructor(private readonly deps: WarmPoolUpdaterDeps) {
    this.logger = deps.logger ?? console;
  }

  start(): void {
    this.loop ??= this.run();
  }

  /** Reconcile now (a build of the pool's Environment ended). */
  trigger(): void {
    this.wake?.();
  }

  async stop(): Promise<void> {
    this.stopping.abort();
    this.wake?.();
    await this.loop;
  }

  async reconcile(): Promise<WarmPoolOutcome> {
    const { pool, caches } = this.deps;
    const image = (await this.deps.store.getBuiltIn(this.deps.environmentId))?.image;
    if (!image) return "no-image";
    const current = await pool.image();
    if (current === image && this.cached?.image === image &&
        this.deps.clock.now() - this.cached.at < (this.deps.cacheRecheckMs ?? CACHE_RECHECK_MS)) {
      return "unchanged";
    }
    let cache: ImageCacheState | undefined;
    if (caches) {
      cache = await caches.ensure(image);
      if (cache.state !== "ready") {
        if (this.reported !== `${image}:${cache.state}`) {
          this.reported = `${image}:${cache.state}`;
          const log = cache.state === "failed" ? this.logger.error : this.logger.info;
          log.call(this.logger, `warm_pool pool=${pool.name} image=${image} cache=${cache.id ?? "none"} state=${cache.state}${cache.detail ? ` detail=${cache.detail}` : ""}; the pool keeps ${current}`);
        }
        return cache.state === "failed" ? "cache-failed" : "waiting-for-cache";
      }
      this.cached = { image, at: this.deps.clock.now() };
    }
    // Also backfill a cache enabled later, or recreate one removed while the pool kept its image.
    if (current === image) return "unchanged";
    await pool.setImage(image);
    this.logger.info(`warm_pool_updated pool=${pool.name} image=${image} previous=${current} cache=${cache?.id ?? "none"}`);
    if (!caches) {
      this.logger.warn(`warm_pool_cold_refill pool=${pool.name}: without an ImageCache every refill of the pool pulls ${image} in full`);
    }
    return "updated";
  }

  private async run(): Promise<void> {
    const recheck = this.deps.recheckMs ?? RECHECK_MS;
    while (!this.stopping.signal.aborted) {
      await this.reconcile().catch((error) => this.logger.error(`warm_pool pool=${this.deps.pool.name}: ${error instanceof Error ? error.message : String(error)}`));
      const waked = new AbortController();
      this.wake = () => waked.abort();
      await this.deps.clock.sleep(recheck, AbortSignal.any([waked.signal, this.stopping.signal])).catch(() => {});
    }
  }
}

/** The pod template's container that runs the Sandbox (the pool's only one today). */
export const SANDBOX_CONTAINER = "sandbox";

interface SandboxSet {
  spec?: { template?: { spec?: { containers?: Array<{ name: string; image?: string }> } } };
}

/** The Warm Pool as a SandboxSet in `sandbox-system` (agents.kruise.io/v1alpha1). */
export class KubernetesWarmPool implements WarmPool {
  constructor(private readonly api: KubernetesApi, private readonly namespace: string, readonly name: string) {}

  private get path() {
    return `/apis/agents.kruise.io/v1alpha1/namespaces/${encodeURIComponent(this.namespace)}/sandboxsets/${encodeURIComponent(this.name)}`;
  }

  private async container(): Promise<{ index: number; image: string }> {
    let set: SandboxSet;
    try {
      set = await this.api.request<SandboxSet>("GET", this.path);
    } catch (error) {
      if (isNotFound(error)) throw new Error(`Warm Pool ${this.namespace}/${this.name} does not exist`);
      throw error;
    }
    const containers = set.spec?.template?.spec?.containers ?? [];
    const index = containers.findIndex((container) => container.name === SANDBOX_CONTAINER);
    if (index < 0 || !containers[index]!.image) throw new Error(`Warm Pool ${this.name} has no ${SANDBOX_CONTAINER} container`);
    return { index, image: containers[index]!.image! };
  }

  async image(): Promise<string> {
    return (await this.container()).image;
  }

  async setImage(image: string): Promise<void> {
    const { index } = await this.container();
    const at = `/spec/template/spec/containers/${index}`;
    // The test fails the patch if the containers moved since the read.
    await this.api.request("PATCH", this.path, {
      contentType: "application/json-patch+json",
      body: [{ op: "test", path: `${at}/name`, value: SANDBOX_CONTAINER }, { op: "replace", path: `${at}/image`, value: image }],
    });
  }
}
