import { createHash } from "node:crypto";
import { BUILD_CONTEXT_DIR, parseDriverReport, scriptFailureMessage } from "./build-context.js";
import { isConflict, isNotFound, type KubernetesApi } from "./kubernetes-api.js";
import type { BuildAttemptRef, BuildJob, BuildLogSink, BuildRunResult, BuildRunner, Clock, KeepAttempt } from "./ports.js";

/** How build pods run in the builder's namespace (ADR-0024 "Building", #299's pod). */
export interface BuildPodConfig {
  namespace: string;
  /** The deployment environment the pods belong to (`oma.dev/deployment`). */
  deployment: string;
  /** buildah, pinned by digest and mirrored into `welltop`. */
  buildahImage: string;
  /** The dockerconfigjson Secret mounted as the push credential, the only Secret a build pod sees. */
  registryAuthSecret: string;
  /** Pulls the buildah image. */
  imagePullSecret: string;
  /** How long a pod may take to be scheduled and start (ACS provisions one per pod). */
  startTimeoutMs: number;
  pollMs: number;
}

export const BUILD_POD_DEFAULTS = { startTimeoutMs: 15 * 60_000, pollMs: 2_000 } as const;

const MANAGED_BY = "app.kubernetes.io/managed-by=oma-image-builder";
const BUILD_LABEL = "oma.dev/environment-build";
const ANNOTATIONS = { environment: "oma.dev/environment-id", build: "oma.dev/environment-build-id", attempt: "oma.dev/build-attempt" } as const;
/** The tail an attempt's failure message is taken from. */
const OUTPUT_TAIL = 256 * 1024;
/** A waiting container in one of these will not start by itself. */
const START_FAILURES = new Set(["ErrImagePull", "ImagePullBackOff", "InvalidImageName", "CreateContainerConfigError", "CreateContainerError", "RunContainerError"]);

/** A build's label value: a stable hash, since build ids may hold characters labels do not allow. */
export const buildHash = (buildId: string) => createHash("sha256").update(buildId).digest("hex").slice(0, 16);
export const buildPodName = (buildId: string, attempt: number) => `oma-env-build-${buildHash(buildId)}-${attempt}`;

interface ContainerState {
  waiting?: { reason?: string; message?: string };
  running?: { startedAt?: string };
  terminated?: { exitCode: number; reason?: string; message?: string };
}
interface Pod {
  metadata: { name: string; uid: string; annotations?: Record<string, string> };
  status?: { phase?: string; reason?: string; message?: string; conditions?: Array<{ type: string; status: string; reason?: string; message?: string }>; containerStatuses?: Array<{ name: string; state?: ContainerState }> };
}

/** The pod one attempt runs in: unprivileged, 4 vCPU / 8 GiB / 60 GiB, the context and the push credential mounted. */
export function buildPodManifest(job: BuildJob, config: Pick<BuildPodConfig, "deployment" | "buildahImage" | "registryAuthSecret" | "imagePullSecret">) {
  const resources = { cpu: "4", memory: "8Gi", "ephemeral-storage": "60Gi" };
  return {
    apiVersion: "v1",
    kind: "Pod",
    metadata: {
      name: buildPodName(job.buildId, job.attempt),
      labels: {
        "app.kubernetes.io/name": "oma-environment-build",
        "app.kubernetes.io/managed-by": "oma-image-builder",
        "oma.dev/deployment": config.deployment,
        [BUILD_LABEL]: buildHash(job.buildId),
        "alibabacloud.com/acs": "true",
        "alibabacloud.com/compute-class": "general-purpose",
        "alibabacloud.com/compute-qos": "default",
      },
      annotations: {
        [ANNOTATIONS.environment]: job.environmentId,
        [ANNOTATIONS.build]: job.buildId,
        [ANNOTATIONS.attempt]: String(job.attempt),
      },
    },
    spec: {
      restartPolicy: "Never",
      automountServiceAccountToken: false,
      enableServiceLinks: false,
      // A backstop past the builder's own 60 minutes, should every builder be gone.
      activeDeadlineSeconds: 65 * 60,
      terminationGracePeriodSeconds: 5,
      imagePullSecrets: [{ name: config.imagePullSecret }],
      containers: [{
        name: "build",
        image: config.buildahImage,
        command: ["bash", `${BUILD_CONTEXT_DIR}/build.sh`],
        env: [
          { name: "OMA_BASE_IMAGE", value: job.baseImage },
          { name: "OMA_TARGET_IMAGE", value: job.target },
          { name: "OMA_BUILD_NONCE", value: job.nonce },
          { name: "CONTAINERS_STORAGE_CONF", value: `${BUILD_CONTEXT_DIR}/storage.conf` },
          { name: "BUILDAH_ISOLATION", value: "chroot" },
          { name: "REGISTRY_AUTH_FILE", value: "/run/oma-auth/auth.json" },
        ],
        resources: { requests: resources, limits: resources },
        securityContext: { privileged: false },
        terminationMessagePolicy: "File",
        volumeMounts: [
          { name: "context", mountPath: BUILD_CONTEXT_DIR, readOnly: true },
          { name: "registry-auth", mountPath: "/run/oma-auth", readOnly: true },
          { name: "containers", mountPath: "/var/lib/containers" },
        ],
      }],
      volumes: [
        { name: "context", configMap: { name: buildPodName(job.buildId, job.attempt) } },
        { name: "registry-auth", secret: { secretName: config.registryAuthSecret, defaultMode: 0o400, items: [{ key: ".dockerconfigjson", path: "auth.json" }] } },
        { name: "containers", emptyDir: {} },
      ],
    },
  };
}

/** Keeps the last `max` characters of what passes through. */
class Tail {
  text = "";
  constructor(private readonly max: number) {}
  push(chunk: string) {
    this.text += chunk;
    if (this.text.length > this.max * 2) this.text = this.text.slice(-this.max);
  }
}

/** `<RFC3339Nano> <line>` as `kubectl logs --timestamps` prints; the stamp as a comparable pair. */
function stamped(line: string): { at: [number, number]; text: string } | undefined {
  const space = line.indexOf(" ");
  const match = /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)(?:\.(\d{1,9}))?Z$/.exec(line.slice(0, space));
  if (!match) return undefined;
  return { at: [Date.parse(`${match[1]}Z`), Number((match[2] ?? "").padEnd(9, "0"))], text: line.slice(space + 1) };
}
const after = (a: [number, number], b: [number, number]) => a[0] > b[0] || (a[0] === b[0] && a[1] > b[1]);

/**
 * Runs each build attempt as one pod in the builder's namespace and streams
 * its log; the context travels in a ConfigMap the pod owns, so deleting the
 * pod removes both.
 */
export class KubernetesBuildRunner implements BuildRunner {
  constructor(
    private readonly api: KubernetesApi,
    private readonly config: BuildPodConfig,
    private readonly clock: Clock,
  ) {}

  private get base() {
    return `/api/v1/namespaces/${encodeURIComponent(this.config.namespace)}`;
  }

  async run(job: BuildJob, io: { log: BuildLogSink; signal: AbortSignal }): Promise<BuildRunResult> {
    const name = buildPodName(job.buildId, job.attempt);
    const tail = new Tail(OUTPUT_TAIL);
    const log = (text: string) => { tail.push(text); io.log(text); };
    io.signal.throwIfAborted();
    try {
      const pod = await this.createPod(job);
      await this.api.request("POST", `${this.base}/configmaps`, {
        body: {
          apiVersion: "v1", kind: "ConfigMap",
          metadata: {
            name, labels: buildPodManifest(job, this.config).metadata.labels,
            ownerReferences: [{ apiVersion: "v1", kind: "Pod", name, uid: pod.metadata.uid }],
          },
          data: job.context,
        },
      });
      const start = await this.waitStarted(name, io);
      if (start) return start;
      await this.followLogs(name, log, io.signal);
      return this.outcome(await this.waitTerminated(name, io.signal), tail.text, job.nonce);
    } finally {
      await this.delete(name).catch(() => {});
    }
  }

  async cleanup(buildId: string): Promise<void> {
    const selector = `${MANAGED_BY},${BUILD_LABEL}=${buildHash(buildId)}`;
    for (const kind of ["pods", "configmaps"] as const) {
      const list = await this.api.request<{ items: Pod[] }>("GET", `${this.base}/${kind}?labelSelector=${encodeURIComponent(selector)}`);
      for (const item of list.items) await this.remove(kind, item.metadata.name);
    }
  }

  async sweep(keep: KeepAttempt): Promise<number> {
    const selector = `${MANAGED_BY},oma.dev/deployment=${this.config.deployment}`;
    const list = await this.api.request<{ items: Pod[] }>("GET", `${this.base}/pods?labelSelector=${encodeURIComponent(selector)}`);
    let deleted = 0;
    for (const pod of list.items) {
      const ref = attemptOf(pod);
      if (ref && await keep(ref)) continue;
      await this.delete(pod.metadata.name);
      deleted++;
    }
    return deleted;
  }

  private async createPod(job: BuildJob): Promise<Pod> {
    const manifest = buildPodManifest(job, this.config);
    try {
      return await this.api.request<Pod>("POST", `${this.base}/pods`, { body: manifest });
    } catch (error) {
      if (!isConflict(error)) throw error;
      // A pod of this very attempt is left over: replace it.
      await this.delete(manifest.metadata.name);
      for (let waited = 0; waited < 60_000; waited += this.config.pollMs) {
        try { return await this.api.request<Pod>("POST", `${this.base}/pods`, { body: manifest }); }
        catch (retry) { if (!isConflict(retry)) throw retry; }
        await this.clock.sleep(this.config.pollMs);
      }
      throw error;
    }
  }

  /** Wait until the container runs or ended; a result when it never will. */
  private async waitStarted(name: string, io: { log: BuildLogSink; signal: AbortSignal }): Promise<BuildRunResult | undefined> {
    const deadline = this.clock.now() + this.config.startTimeoutMs;
    let last = "";
    for (;;) {
      const pod = await this.getPod(name, io.signal);
      if (!pod) return { outcome: "infrastructure_failed", stage: "pod_start", message: "The build pod was deleted before it started" };
      const state = container(pod);
      if (state?.running || state?.terminated || pod.status?.phase === "Succeeded" || pod.status?.phase === "Failed") return undefined;
      const waiting = state?.waiting;
      if (waiting?.reason && START_FAILURES.has(waiting.reason)) {
        return { outcome: "infrastructure_failed", stage: "pod_start", message: `The build pod could not start: ${waiting.reason}${waiting.message ? `: ${waiting.message}` : ""}` };
      }
      const unscheduled = pod.status?.conditions?.find((condition) => condition.type === "PodScheduled" && condition.status === "False");
      const now = `${pod.status?.phase ?? "Pending"}${waiting?.reason ? ` (${waiting.reason})` : unscheduled?.reason ? ` (${unscheduled.reason})` : ""}`;
      if (now !== last) { io.log(`[oma-builder] Build pod ${name}: ${now}\n`); last = now; }
      if (this.clock.now() >= deadline) {
        const detail = unscheduled?.message ?? waiting?.message;
        return { outcome: "infrastructure_failed", stage: "pod_start", message: `The build pod did not start within ${Math.round(this.config.startTimeoutMs / 60_000)} minutes: ${now}${detail ? `: ${detail}` : ""}` };
      }
      await this.clock.sleep(this.config.pollMs, io.signal);
    }
  }

  /**
   * Follow the container's log until it ends. A dropped stream is resumed
   * from its last line's timestamp, skipping what was already passed on.
   */
  private async followLogs(name: string, log: BuildLogSink, signal: AbortSignal): Promise<void> {
    let last: [number, number] | undefined;
    for (;;) {
      let pending = "";
      const decoder = new TextDecoder();
      const since = last ? `&sinceTime=${encodeURIComponent(new Date(last[0]).toISOString().replace(/\.\d{3}Z$/, "Z"))}` : "";
      try {
        const stream = await this.api.stream(`${this.base}/pods/${name}/log?container=build&follow=true&timestamps=true${since}`, signal);
        for await (const chunk of stream) {
          pending += decoder.decode(chunk, { stream: true });
          const end = pending.lastIndexOf("\n");
          if (end < 0) continue;
          for (const line of pending.slice(0, end).split("\n")) {
            const entry = stamped(line);
            if (!entry) { log(`${line}\n`); continue; }
            if (last && !after(entry.at, last)) continue;
            last = entry.at;
            log(`${entry.text}\n`);
          }
          pending = pending.slice(end + 1);
        }
        const rest = stamped(pending);
        if (rest && (!last || after(rest.at, last))) log(`${rest.text}\n`);
      } catch (error) {
        signal.throwIfAborted();
        if (isNotFound(error)) return;
      }
      const pod = await this.getPod(name, signal);
      if (!pod || container(pod)?.terminated || pod.status?.phase === "Succeeded" || pod.status?.phase === "Failed") return;
      await this.clock.sleep(this.config.pollMs, signal);
    }
  }

  private async waitTerminated(name: string, signal: AbortSignal): Promise<Pod | undefined> {
    for (;;) {
      const pod = await this.getPod(name, signal);
      if (!pod || container(pod)?.terminated || pod.status?.phase === "Failed") return pod;
      await this.clock.sleep(this.config.pollMs, signal);
    }
  }

  /** How the attempt ended, from the container's exit and the driver's report. */
  private outcome(pod: Pod | undefined, output: string, nonce: string): BuildRunResult {
    if (!pod) return { outcome: "infrastructure_failed", stage: "pod", message: "The build pod disappeared while it ran" };
    const terminated = container(pod)?.terminated;
    if (pod.status?.reason === "Evicted") return { outcome: "script_failed", message: `The build was evicted: ${pod.status.message ?? "it used more than its 60 GiB of disk"}` };
    if (!terminated) return { outcome: "infrastructure_failed", stage: "pod", message: `The build pod failed: ${pod.status?.reason ?? pod.status?.phase ?? "unknown"}${pod.status?.message ? `: ${pod.status.message}` : ""}` };
    if (terminated.reason === "OOMKilled") return { outcome: "script_failed", message: "The build ran out of memory (8 GiB)" };
    const report = parseDriverReport(terminated.message, nonce) ?? parseDriverReport(output, nonce);
    switch (terminated.exitCode) {
      case 0:
        return report?.stage === "pushed" && report.digest
          ? { outcome: "pushed", digest: report.digest }
          : { outcome: "infrastructure_failed", stage: "push", message: "The build pod ended without reporting the pushed digest" };
      case 11: return { outcome: "script_failed", message: scriptFailureMessage(output, nonce) };
      case 12: return { outcome: "script_failed", message: "Listing the installed software (/opt/oma/bin/write-manifest) failed after the init script; see the log" };
      case 10: return { outcome: "infrastructure_failed", stage: "pull", message: "Pulling the Base Image failed" };
      case 13: return { outcome: "infrastructure_failed", stage: "build", message: "buildah failed outside the init script" };
      case 14: return { outcome: "infrastructure_failed", stage: "push", message: "Pushing the image failed" };
      default:
        return { outcome: "infrastructure_failed", stage: "pod", message: `The build pod exited with ${terminated.exitCode}${terminated.reason ? ` (${terminated.reason})` : ""}` };
    }
  }

  private async getPod(name: string, signal?: AbortSignal): Promise<Pod | undefined> {
    try {
      return await this.api.request<Pod>("GET", `${this.base}/pods/${name}`, { signal });
    } catch (error) {
      if (isNotFound(error)) return undefined;
      throw error;
    }
  }

  private async delete(name: string): Promise<void> {
    await this.remove("pods", name);
    await this.remove("configmaps", name);
  }

  private async remove(kind: "pods" | "configmaps", name: string): Promise<void> {
    try {
      await this.api.request("DELETE", `${this.base}/${kind}/${name}`, { body: { gracePeriodSeconds: 0, propagationPolicy: "Background" } });
    } catch (error) {
      if (!isNotFound(error)) throw error;
    }
  }
}

function container(pod: Pod): ContainerState | undefined {
  return pod.status?.containerStatuses?.find((status) => status.name === "build")?.state;
}

function attemptOf(pod: Pod): BuildAttemptRef | undefined {
  const annotations = pod.metadata.annotations ?? {};
  const attempt = Number(annotations[ANNOTATIONS.attempt]);
  const environmentId = annotations[ANNOTATIONS.environment];
  const buildId = annotations[ANNOTATIONS.build];
  return environmentId && buildId && Number.isSafeInteger(attempt) ? { environmentId, buildId, attempt } : undefined;
}
