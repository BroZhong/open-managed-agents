import { describe, expect, it } from "vitest";
import { KubernetesApiError, type KubernetesApi } from "../src/image-builder/kubernetes-api.js";
import { buildHash, buildPodManifest, buildPodName, KubernetesBuildRunner } from "../src/image-builder/pod-runner.js";
import { buildContext } from "../src/image-builder/build-context.js";
import type { BuildJob } from "../src/image-builder/ports.js";
import { ManualClock, settle } from "./fixtures/manual-clock.js";

const NS = "/api/v1/namespaces/oma-test";
const BASE = `registry-vpc.cn-shanghai.aliyuncs.com/welltop/oma-sandbox@sha256:${"a".repeat(64)}`;
const BUILDAH = `registry-vpc.cn-shanghai.aliyuncs.com/welltop/buildah@sha256:${"b".repeat(64)}`;
const DIGEST = `sha256:${"d".repeat(64)}`;
const config = {
  namespace: "oma-test", deployment: "test", buildahImage: BUILDAH, registryAuthSecret: "ali-shanghai", imagePullSecret: "ali-shanghai",
  startTimeoutMs: 15 * 60_000, pollMs: 2_000,
};

function job(attempt = 1): BuildJob {
  return {
    environmentId: "env_A1", buildId: "envb_Xy_-9", attempt, baseImage: BASE, nonce: "n0nce",
    target: "registry-vpc.cn-shanghai.aliyuncs.com/welltop/oma-environments:test-env_A1-envb_Xy_-9",
    context: buildContext({
      environmentId: "env_A1", buildId: "envb_Xy_-9", baseImage: BASE, initScript: "false\n", nonce: "n0nce",
      env: [{ name: "FOO", value: "bar" }], platformDefaults: {}, proxy: null,
    }),
  };
}

type Phase = { status: Record<string, unknown> };
const pending = (waiting?: string, scheduled = true): Phase => ({ status: {
  phase: "Pending",
  conditions: scheduled ? [] : [{ type: "PodScheduled", status: "False", reason: "Unschedulable", message: "0/3 nodes are available" }],
  containerStatuses: waiting ? [{ name: "build", state: { waiting: { reason: waiting, message: `${waiting} details` } } }] : [],
} });
const running: Phase = { status: { phase: "Running", containerStatuses: [{ name: "build", state: { running: { startedAt: "2026-10-26T01:00:00Z" } } }] } };
const terminated = (exitCode: number, message?: string, reason?: string): Phase => ({ status: {
  phase: exitCode === 0 ? "Succeeded" : "Failed",
  containerStatuses: [{ name: "build", state: { terminated: { exitCode, message, reason } } }],
} });

/** An API server holding pods and ConfigMaps; each pod walks through `phases`, one per status read. */
class FakeKube implements KubernetesApi {
  readonly pods = new Map<string, { manifest: any; reads: number }>();
  readonly configMaps = new Map<string, any>();
  readonly calls: string[] = [];
  /** Log streams served in order; each a list of lines (or an error to throw mid-stream). */
  streams: Array<Array<string | Error>> = [];
  readonly streamPaths: string[] = [];
  phases: Phase[] = [running, terminated(0, `{"stage":"pushed","digest":"${DIGEST}"}`)];
  createConflicts = 0;

  async request<T>(method: string, path: string, options: { body?: any } = {}): Promise<T> {
    this.calls.push(`${method} ${path}`);
    const missing = () => new KubernetesApiError(404, "NotFound", "not found");
    if (method === "POST" && path === `${NS}/pods`) {
      if (this.createConflicts-- > 0 || this.pods.has(options.body.metadata.name)) throw new KubernetesApiError(409, "AlreadyExists", "exists");
      const manifest = { ...options.body, metadata: { ...options.body.metadata, uid: `uid-${options.body.metadata.name}` } };
      this.pods.set(manifest.metadata.name, { manifest, reads: 0 });
      return manifest as T;
    }
    if (method === "POST" && path === `${NS}/configmaps`) {
      this.configMaps.set(options.body.metadata.name, options.body);
      return options.body as T;
    }
    const [, kind, name] = path.slice(NS.length).split(/[/?]/);
    if (method === "GET" && path.includes("?labelSelector=")) {
      const selector = decodeURIComponent(path.split("labelSelector=")[1]!).split(",").map((pair) => pair.split("="));
      const source = kind === "pods" ? [...this.pods.values()].map((pod) => pod.manifest) : [...this.configMaps.values()];
      return { items: source.filter((item) => selector.every(([key, value]) => item.metadata.labels?.[key!] === value)) } as T;
    }
    if (method === "GET" && kind === "pods") {
      const pod = this.pods.get(name!);
      if (!pod) throw missing();
      const phase = this.phases[Math.min(pod.reads++, this.phases.length - 1)]!;
      return { ...pod.manifest, ...phase } as T;
    }
    if (method === "DELETE") {
      const map = kind === "pods" ? this.pods : this.configMaps;
      if (!map.delete(name!)) throw missing();
      return {} as T;
    }
    throw new Error(`unexpected ${method} ${path}`);
  }

  async stream(path: string, signal: AbortSignal): Promise<AsyncIterable<Uint8Array>> {
    this.streamPaths.push(path);
    const lines = this.streams.shift() ?? [];
    const encoder = new TextEncoder();
    return (async function* () {
      for (const line of lines) {
        signal.throwIfAborted();
        if (line instanceof Error) throw line;
        // Split each line across two chunks.
        const bytes = encoder.encode(`${line}\n`);
        yield bytes.subarray(0, 5);
        yield bytes.subarray(5);
      }
    })();
  }
}

function setup() {
  const kube = new FakeKube();
  const clock = new ManualClock();
  const runner = new KubernetesBuildRunner(kube, config, clock);
  const logged: string[] = [];
  const run = (signal = new AbortController().signal, attempt = 1) => runner.run(job(attempt), { log: (text) => logged.push(text), signal });
  /** Run while time advances by the pod poll interval until it settles. */
  const runToEnd = async (signal?: AbortSignal) => {
    let result: unknown;
    let error: unknown;
    let done = false;
    void run(signal).then((value) => { result = value; done = true; }, (caught) => { error = caught; done = true; });
    for (let i = 0; i < 2000 && !done; i++) await clock.advance(config.pollMs);
    await settle();
    if (error) throw error;
    return result;
  };
  return { kube, clock, runner, logged, run, runToEnd };
}

const ts = (second: number, nanos = "") => `2026-10-26T01:00:${String(second).padStart(2, "0")}${nanos}Z`;

describe("KubernetesBuildRunner", () => {
  it("runs an attempt in one unprivileged ACS pod with the context in a ConfigMap it owns, and reports the pushed digest", async () => {
    const { kube, logged, runToEnd } = setup();
    kube.streams = [[`${ts(1, ".5")} ==> Pulling the Base Image`, `${ts(2)} Pushed ${DIGEST}`]];
    expect(await runToEnd()).toEqual({ outcome: "pushed", digest: DIGEST });
    const name = buildPodName("envb_Xy_-9", 1);
    expect(name).toMatch(/^oma-env-build-[0-9a-f]{16}-1$/);
    const created = kube.calls.filter((call) => call.startsWith("POST"));
    expect(created).toEqual([`POST ${NS}/pods`, `POST ${NS}/configmaps`]);
    expect(kube.calls.slice(-2)).toEqual([`DELETE ${NS}/pods/${name}`, `DELETE ${NS}/configmaps/${name}`]);
    expect(kube.pods.size + kube.configMaps.size).toBe(0);
    expect(logged.join("")).toContain("==> Pulling the Base Image\nPushed ");
    expect(logged.join("")).not.toContain("2026-10-26T01:00:01");
    expect(kube.streamPaths[0]).toBe(`${NS}/pods/${name}/log?container=build&follow=true&timestamps=true`);
  });

  it("builds the pod #299 settled on: no privileges, no service account token, 4 vCPU / 8 GiB / 60 GiB, only the push credential", () => {
    const manifest = buildPodManifest(job(2), config);
    expect(manifest.metadata).toMatchObject({
      name: buildPodName("envb_Xy_-9", 2),
      labels: {
        "app.kubernetes.io/managed-by": "oma-image-builder", "oma.dev/deployment": "test",
        "oma.dev/environment-build": buildHash("envb_Xy_-9"),
        "alibabacloud.com/compute-class": "general-purpose", "alibabacloud.com/compute-qos": "default",
      },
      annotations: { "oma.dev/environment-id": "env_A1", "oma.dev/environment-build-id": "envb_Xy_-9", "oma.dev/build-attempt": "2" },
    });
    const { spec } = manifest;
    expect(spec).toMatchObject({ restartPolicy: "Never", automountServiceAccountToken: false, enableServiceLinks: false, imagePullSecrets: [{ name: "ali-shanghai" }] });
    const [container] = spec.containers;
    expect(container).toMatchObject({
      image: BUILDAH, command: ["bash", "/oma/context/build.sh"], securityContext: { privileged: false },
      resources: { requests: { cpu: "4", memory: "8Gi", "ephemeral-storage": "60Gi" }, limits: { cpu: "4", memory: "8Gi", "ephemeral-storage": "60Gi" } },
    });
    expect(JSON.stringify(container)).not.toMatch(/SYS_ADMIN|fuse|capabilities/);
    expect(container!.env.map((variable) => variable.name)).toEqual(["OMA_BASE_IMAGE", "OMA_TARGET_IMAGE", "OMA_BUILD_NONCE", "CONTAINERS_STORAGE_CONF", "BUILDAH_ISOLATION", "REGISTRY_AUTH_FILE"]);
    expect(JSON.stringify(container!.env)).not.toMatch(/valueFrom|secretKeyRef|PROXY/);
    const secrets = spec.volumes.filter((volume) => "secret" in volume);
    expect(secrets).toEqual([{ name: "registry-auth", secret: { secretName: "ali-shanghai", defaultMode: 0o400, items: [{ key: ".dockerconfigjson", path: "auth.json" }] } }]);
    expect(spec.volumes).toContainEqual({ name: "containers", emptyDir: {} });
    expect(container!.volumeMounts).toContainEqual({ name: "containers", mountPath: "/var/lib/containers" });
  });

  it("gives the context ConfigMap to the pod, so deleting the pod deletes it too", async () => {
    const { kube, run, clock } = setup();
    kube.phases = [pending("ContainerCreating")];
    const controller = new AbortController();
    const result = run(controller.signal).catch((error) => error);
    await clock.advance(config.pollMs);
    const [configMap] = kube.configMaps.values();
    expect(configMap.metadata.ownerReferences).toEqual([{ apiVersion: "v1", kind: "Pod", name: buildPodName("envb_Xy_-9", 1), uid: `uid-${buildPodName("envb_Xy_-9", 1)}` }]);
    expect(Object.keys(configMap.data).sort()).toEqual(["Dockerfile", "build.env", "build.sh", "init-trap.sh", "init.sh", "storage.conf"]);
    expect(configMap.data["build.env"]).toContain("FOO='bar'");
    controller.abort(new Error("superseded"));
    expect(await result).toMatchObject({ message: "superseded" });
    expect(kube.pods.size + kube.configMaps.size).toBe(0);
  });

  it("reports a script failure with the failing line, from that attempt's output", async () => {
    const { kube, runToEnd } = setup();
    kube.streams = [[
      `${ts(1)} STEP 2/4: RUN … echo "OMA_INIT_FAILED n0nce exit=$status" …`,
      `${ts(2)} [oma] init script failed at line 1: false (exit status 1)`,
      `${ts(2, ".1")} OMA_INIT_FAILED n0nce exit=1`,
    ]];
    kube.phases = [running, terminated(11, '{"stage":"script"}')];
    expect(await runToEnd()).toEqual({ outcome: "script_failed", message: "The init script failed at line 1: false (exit status 1)" });
  });

  it.each([
    [10, '{"stage":"pull"}', undefined, { outcome: "infrastructure_failed", stage: "pull" }],
    [13, '{"stage":"build"}', undefined, { outcome: "infrastructure_failed", stage: "build" }],
    [14, '{"stage":"push"}', undefined, { outcome: "infrastructure_failed", stage: "push" }],
    [12, '{"stage":"manifest"}', undefined, { outcome: "script_failed" }],
    [137, "", "OOMKilled", { outcome: "script_failed", message: "The build ran out of memory (8 GiB)" }],
    [0, "", undefined, { outcome: "infrastructure_failed", stage: "push" }],
    [1, "", "Error", { outcome: "infrastructure_failed", stage: "pod" }],
  ])("maps exit %i to its outcome", async (exitCode, message, reason, expected) => {
    const { kube, runToEnd } = setup();
    kube.phases = [running, terminated(exitCode, message, reason)];
    expect(await runToEnd()).toMatchObject(expected);
  });

  it("fails as infrastructure when the pod cannot pull its image or does not start in time", async () => {
    const pull = setup();
    pull.kube.phases = [pending(), pending("ErrImagePull")];
    expect(await pull.runToEnd()).toMatchObject({ outcome: "infrastructure_failed", stage: "pod_start", message: expect.stringContaining("ErrImagePull") });
    expect(pull.kube.pods.size).toBe(0);

    const unscheduled = setup();
    unscheduled.kube.phases = [pending(undefined, false)];
    const result = await unscheduled.runToEnd();
    expect(result).toMatchObject({ outcome: "infrastructure_failed", stage: "pod_start", message: expect.stringContaining("did not start within 15 minutes: Pending (Unschedulable): 0/3 nodes are available") });
    expect(unscheduled.logged.filter((line) => line.includes("Pending (Unschedulable)"))).toHaveLength(1);
  });

  it("resumes a dropped log stream from its last timestamp without repeating lines", async () => {
    const { kube, logged, runToEnd } = setup();
    kube.streams = [
      [`${ts(1, ".25")} one`, `${ts(2, ".5")} two`, new Error("connection reset")],
      [`${ts(2)} zero`, `${ts(2, ".5")} two`, `${ts(2, ".75")} three`, `${ts(3)} four`],
    ];
    kube.phases = [running, running, running, terminated(0, `{"stage":"pushed","digest":"${DIGEST}"}`)];
    expect(await runToEnd()).toEqual({ outcome: "pushed", digest: DIGEST });
    expect(logged.join("")).toBe("one\ntwo\nthree\nfour\n");
    expect(kube.streamPaths[1]).toContain(`&sinceTime=${encodeURIComponent("2026-10-26T01:00:02Z")}`);
  });

  it("replaces a leftover pod of the same attempt", async () => {
    const { kube, runToEnd } = setup();
    kube.createConflicts = 1;
    kube.pods.set(buildPodName("envb_Xy_-9", 1), { manifest: { metadata: { name: buildPodName("envb_Xy_-9", 1) } }, reads: 0 });
    expect(await runToEnd()).toMatchObject({ outcome: "pushed" });
  });

  it("cleans up every attempt of a build by label, and sweeps the pods `keep` rejects", async () => {
    const { kube, runner } = setup();
    for (const attempt of [1, 2]) {
      const manifest = buildPodManifest(job(attempt), config);
      kube.pods.set(manifest.metadata.name, { manifest: { ...manifest, metadata: { ...manifest.metadata, uid: "u" } }, reads: 0 });
      kube.configMaps.set(manifest.metadata.name, { metadata: { name: manifest.metadata.name, labels: manifest.metadata.labels } });
    }
    const other = buildPodManifest({ ...job(1), buildId: "envb_other", environmentId: "env_B" }, config);
    kube.pods.set(other.metadata.name, { manifest: other, reads: 0 });
    const production = buildPodManifest({ ...job(1), buildId: "envb_prod" }, { ...config, deployment: "production" });
    kube.pods.set(production.metadata.name, { manifest: production, reads: 0 });

    const seen: unknown[] = [];
    expect(await runner.sweep(async (ref) => { seen.push(ref); return ref.attempt === 2; })).toBe(2);
    expect(seen).toEqual(expect.arrayContaining([
      { environmentId: "env_A1", buildId: "envb_Xy_-9", attempt: 1 },
      { environmentId: "env_A1", buildId: "envb_Xy_-9", attempt: 2 },
      { environmentId: "env_B", buildId: "envb_other", attempt: 1 },
    ]));
    expect([...kube.pods.keys()].sort()).toEqual([buildPodName("envb_Xy_-9", 2), production.metadata.name].sort());

    await runner.cleanup("envb_Xy_-9");
    expect([...kube.pods.keys()]).toEqual([production.metadata.name]);
    expect(kube.configMaps.size).toBe(0);
  });
});
