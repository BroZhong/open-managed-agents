import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import test from "node:test";

const root = new URL("../", import.meta.url);
const digest = (c) => `sha256:${c.repeat(64)}`;

function render(env) {
  const output = execFileSync(
    "node",
    [new URL("deploy/scripts/render.mjs", root).pathname, env, digest("a"), digest("b"), digest("c"), digest("d")],
    { encoding: "utf8" },
  );
  return output.split(/^---$/m).map((doc) => doc.trim()).filter(Boolean);
}

const field = (doc, key) => doc.match(new RegExp(`^\\s+${key}: "?([^"\\n]*)"?$`, "m"))?.[1];
const configMap = (docs, name) => docs.find((doc) => /^kind: ConfigMap$/m.test(doc) && doc.includes(`name: ${name}\n`));
const ingress = (docs) => docs.find((doc) => /^kind: Ingress$/m.test(doc));
const deployment = (docs, name) => docs.find((doc) => /^kind: Deployment$/m.test(doc) && doc.includes(`  name: ${name}\n`));
const ofKind = (docs, kind, name) => docs.find((doc) => new RegExp(`^kind: ${kind}$`, "m").test(doc) && new RegExp(`^  name: ${name}$`, "m").test(doc));

test("each overlay renders every image and keeps resources in its namespace", () => {
  for (const [env, namespace] of [["production", "oma-infra"], ["test", "oma-test"]]) {
    const docs = render(env);
    const text = docs.join("\n");
    assert.doesNotMatch(text, /OMA_(API|RUNNER|WEB|BUILDER)_IMAGE/);
    assert.match(text, new RegExp(`oma-server@${digest("a")}`));
    assert.match(text, new RegExp(`oma-server@${digest("b")}`));
    assert.match(text, new RegExp(`oma-web@${digest("c")}`));
    assert.match(deployment(docs, "oma-image-builder"), new RegExp(`image: registry-vpc.cn-shanghai.aliyuncs.com/welltop/oma-server@${digest("d")}$`, "m"));
    for (const doc of docs.filter((d) => !/^kind: Namespace$/m.test(d))) {
      assert.equal(field(doc, "namespace"), namespace, `${env}: ${doc.split("\n").slice(0, 4).join(" ")}`);
    }
  }
});

test("test never points at production data or hosts", () => {
  const docs = render("test");
  for (const name of ["oma-api-config", "oma-runner-config"]) {
    const cm = configMap(docs, name);
    assert.equal(field(cm, "PG_SCHEMA"), "oma_test");
    assert.equal(field(cm, "PG_USER"), "oma_test_app");
    assert.equal(field(cm, "REDIS_HOST"), "redis");
    assert.equal(field(cm, "S3_BUCKET"), "workspace-test");
  }
  assert.equal(field(configMap(docs, "oma-api-config"), "PUBLIC_API_URL"), "https://agentry-test.welltop.tech/api");
  const route = ingress(docs);
  assert.doesNotMatch(route, /agentry\.welltop\.tech/);
  assert.match(route, /- backend:\s+service:\s+name: oma-api\s+port:\s+number: 3000\s+path: \/api\s/);
  assert.match(docs.join("\n"), /^kind: Deployment\n[\s\S]*?name: redis$/m);
});

test("production keeps live configuration and routing", () => {
  const docs = render("production");
  for (const name of ["oma-api-config", "oma-runner-config"]) {
    const cm = configMap(docs, name);
    assert.equal(field(cm, "PG_SCHEMA"), "oma");
    assert.equal(field(cm, "PG_USER"), "oma_app");
    assert.equal(field(cm, "S3_BUCKET"), "workspace");
  }
  assert.equal(field(configMap(docs, "oma-runner-config"), "PG_POOL_MAX"), "30");
  assert.match(ingress(docs), /- host: agentry\.welltop\.tech/);
  assert.match(ingress(docs), /- backend:\s+service:\s+name: oma-server\s+port:\s+number: 3000\s+path: \/api\s/);
  assert.doesNotMatch(docs.join("\n"), /name: redis$/m);
});

test("Runners call the gateway in-cluster; request budgets come from code, not configuration", () => {
  for (const env of ["test", "production"]) {
    const docs = render(env);
    const cm = configMap(docs, "oma-runner-config");
    assert.equal(field(cm, "E2B_API_URL"), "http://sandbox-manager.sandbox-system.svc.cluster.local:8080", env);
    assert.doesNotMatch(docs.join("\n"), /E2B_REQUEST_TIMEOUT_MS/, env);
  }
  assert.doesNotMatch(readFileSync(new URL("deploy/k8s.yaml", root), "utf8"), /E2B_REQUEST_TIMEOUT_MS/);
});

test("each environment's Runners label their Sandboxes with it; the API creates none", () => {
  for (const env of ["test", "production"]) {
    const docs = render(env);
    assert.equal(field(configMap(docs, "oma-runner-config"), "OMA_ENVIRONMENT"), env);
    assert.equal(field(configMap(docs, "oma-api-config"), "OMA_ENVIRONMENT"), undefined, env);
  }
  assert.match(readFileSync(new URL("deploy/k8s.yaml", root), "utf8"), /^  OMA_ENVIRONMENT: "production"$/m);
});

const digestPinned = /^[a-z0-9.-]+\/[a-z0-9._/-]+@sha256:[0-9a-f]{64}$/;

test("each environment's Runners claim from their Warm Pool; the image is each Session's Environment's (ADR-0024)", () => {
  const pool = readFileSync(new URL("sandbox/warm-pool/oma-test-sandbox.yaml", root), "utf8");
  assert.match(pool.match(/^\s+image: (\S+)$/m)?.[1] ?? "", digestPinned);
  const test = configMap(render("test"), "oma-runner-config");
  assert.equal(field(test, "SANDBOX_TEMPLATE"), "oma-test-sandbox");
  const production = configMap(render("production"), "oma-runner-config");
  assert.equal(field(production, "SANDBOX_TEMPLATE"), "auto-story-v2");
  for (const docs of [test, production]) assert.equal(field(docs, "SANDBOX_IMAGE"), undefined);
  assert.doesNotMatch(readFileSync(new URL("deploy/k8s.yaml", root), "utf8"), /SANDBOX_IMAGE/);
});

test("no environment injects the removed per-Agent or default Sandbox variables (ADR-0024)", () => {
  for (const env of ["test", "production"]) {
    const text = render(env).join("\n---\n");
    assert.doesNotMatch(text, /oma-auto-story-env|AUTO_STORY_|OPENGROVE_WW_|name: DEFAULT_SANDBOX_/, env);
  }
  assert.doesNotMatch(readFileSync(new URL("deploy/k8s.yaml", root), "utf8"), /oma-auto-story-env|AUTO_STORY_|OPENGROVE_WW_|name: DEFAULT_SANDBOX_/);
});

test("the oma-test Warm Pool is the auto-story-v2 template without base-secret pod env or the policy mount (ADR-0024)", () => {
  const pool = readFileSync(new URL("sandbox/warm-pool/oma-test-sandbox.yaml", root), "utf8");
  const manifest = pool.split("\n").filter((line) => !line.startsWith("#")).join("\n");
  assert.match(manifest, /^kind: SandboxSet\nmetadata:\n  name: oma-test-sandbox\n  namespace: sandbox-system\n  labels:\n    oma\.dev\/test-only: "true"$/m);
  assert.match(manifest, /^  replicas: 1$/m);
  assert.match(manifest, /image\.alibabacloud\.com\/enable-image-cache: "true"/);
  // video-production carries /etc/vfs-cli/policy.json in its image.
  assert.doesNotMatch(manifest, /base-secret|secretKeyRef|auto-story-source|vfs-cli|^\s+env:|^\s+volumes:/m);
  assert.doesNotMatch(manifest, /name: auto-story-v2/);
});

test("test sandbox RBAC grants only the oma-test Runner identity", () => {
  const rbac = readFileSync(new URL("deploy/environments/test/sandbox-rbac.yaml", root), "utf8");
  assert.match(rbac, /namespace: sandbox-system/);
  assert.match(rbac, /name: oma-read-base-secret/);
  assert.match(rbac, /kind: ServiceAccount\s+name: oma-server\s+namespace: oma-test/);
});

test("every migration rewrites cleanly for the test schema", () => {
  const dir = new URL("deploy/migrations/", root);
  for (const name of readdirSync(dir).filter((n) => n.endsWith(".sql"))) {
    const file = new URL(name, dir).pathname;
    const out = (env) => execFileSync("node", [new URL("deploy/scripts/migration-for-env.mjs", root).pathname, env, file], { encoding: "utf8" });
    assert.equal(out("production"), readFileSync(file, "utf8"), name);
    assert.doesNotMatch(out("test"), /(^|[^_\w])oma\.|\boma_app\b|\bSCHEMA oma\b/, name);
  }
});

const runner = (docs) => docs.find((doc) => /^kind: Deployment$/m.test(doc) && doc.includes("name: oma-runner\n"));

test("both environments run two rolling 2-CPU Runners; only test can kill them abruptly", () => {
  for (const env of ["test", "production"]) {
    const doc = runner(render(env));
    assert.match(doc, /^  replicas: 2$/m, env);
    assert.match(doc, /^    type: RollingUpdate$/m, env);
    assert.match(doc, /^      maxSurge: 1$/m, env);
    assert.match(doc, /^      maxUnavailable: 0$/m, env);
    assert.match(doc, /^            cpu: "2"$/m, env);
    assert.match(doc, /^            memory: 8Gi$/m, env);
  }
  assert.match(runner(render("test")), /^      shareProcessNamespace: true$/m);
  assert.doesNotMatch(runner(render("production")), /shareProcessNamespace/);
});

const welltopPinned = (image) => /^registry-vpc\.cn-shanghai\.aliyuncs\.com\/welltop\/[a-z0-9._-]+@sha256:[0-9a-f]{64}$/.test(image);
const lockedRef = (name) => JSON.parse(readFileSync(new URL(`sandbox/${name}/image.lock.json`, root), "utf8")).ref;

test("each environment runs one image builder with pinned Base Images, buildah and the Runner's Warm Pool (ADR-0024)", () => {
  for (const [env, namespace, pg] of [["production", "oma-infra", ["oma_app", "oma"]], ["test", "oma-test", ["oma_test_app", "oma_test"]]]) {
    const docs = render(env);
    const cm = configMap(docs, "oma-image-builder-config");
    assert.equal(field(cm, "OMA_ENVIRONMENT"), env);
    assert.deepEqual([field(cm, "PG_USER"), field(cm, "PG_SCHEMA")], pg, env);
    assert.equal(field(cm, "ENVIRONMENT_IMAGE_REPOSITORY"), "registry-vpc.cn-shanghai.aliyuncs.com/welltop/oma-environments");
    // The Base Images the recipes published, by digest; buildah by digest.
    assert.equal(field(cm, "BASE_IMAGE_OMA_BASE"), lockedRef("oma-base"), env);
    assert.equal(field(cm, "BASE_IMAGE_OMA_MEDIA"), lockedRef("oma-media"), env);
    for (const key of ["BASE_IMAGE_OMA_BASE", "BASE_IMAGE_OMA_MEDIA", "BUILDAH_IMAGE"]) assert.ok(welltopPinned(field(cm, key)), `${env} ${key}`);
    // Verification claims from the pool the Runners claim from.
    assert.equal(field(cm, "SANDBOX_TEMPLATE"), field(configMap(docs, "oma-runner-config"), "SANDBOX_TEMPLATE"), env);
    assert.equal(field(cm, "E2B_API_URL"), field(configMap(docs, "oma-runner-config"), "E2B_API_URL"), env);
    // The build proxy never lets the Aliyun mirrors through sing-box.
    assert.match(field(cm, "BUILD_PROXY_URL"), /^http:\/\/sing-box\.oma-infra\.svc\.cluster\.local:7890$/);
    for (const host of [".aliyuncs.com", ".aliyun.com", ".npmmirror.com", ".svc", ".cluster.local"]) assert.ok(field(cm, "BUILD_NO_PROXY").split(",").includes(host), host);
    assert.equal(field(cm, "BUILD_REGISTRY_AUTH_SECRET"), "ali-shanghai");

    const builder = deployment(docs, "oma-image-builder");
    assert.match(builder, new RegExp(`^  namespace: ${namespace}$`, "m"));
    assert.match(builder, /^  replicas: 1$/m);
    assert.match(builder, /^    type: Recreate$/m);
    assert.match(builder, /^      serviceAccountName: oma-image-builder$/m);
    assert.match(builder, /- src\/builder-server\.ts$/m);
    assert.match(builder, /fieldPath: metadata\.namespace/);
    // The builder holds no secret it does not use: no encryption key, no Sandbox base Secret.
    const secretKeys = [...builder.matchAll(/^\s+key: (\S+)$/gm)].map((match) => match[1]).sort();
    assert.deepEqual(secretKeys, ["E2B_API_KEY", "E2B_DOMAIN", "PG_PASSWORD", "WORKSPACE_OSS_ACCESS_KEY_ID", "WORKSPACE_OSS_ACCESS_KEY_SECRET"], env);
    assert.doesNotMatch(builder + cm, /OMA_PROVIDER_ENCRYPTION_KEY|base-secret|SANDBOX_BASE_SECRET/);
  }
});

test("the image builder's own Role covers build pods, their logs and context ConfigMaps only", () => {
  for (const [env, namespace] of [["production", "oma-infra"], ["test", "oma-test"]]) {
    const docs = render(env);
    const role = ofKind(docs, "Role", "oma-image-builder");
    const rules = role.slice(role.indexOf("rules:"));
    assert.equal(rules, [
      "rules:",
      "- apiGroups:", '  - ""', "  resources:", "  - pods", "  verbs:", "  - create", "  - delete", "  - get", "  - list", "  - watch",
      "- apiGroups:", '  - ""', "  resources:", "  - pods/log", "  verbs:", "  - get",
      "- apiGroups:", '  - ""', "  resources:", "  - configmaps", "  verbs:", "  - create", "  - delete", "  - list",
    ].join("\n"), env);
    const binding = ofKind(docs, "RoleBinding", "oma-image-builder");
    assert.match(binding, new RegExp(`kind: ServiceAccount\\s+name: oma-image-builder\\s+namespace: ${namespace}`));
    assert.ok(ofKind(docs, "ServiceAccount", "oma-image-builder"), env);
  }
});

test("each image builder may read and patch only its environment's Warm Pool", () => {
  for (const [file, pool, namespace] of [
    ["deploy/environments/test/image-builder-warm-pool-rbac.yaml", "oma-test-sandbox", "oma-test"],
    ["deploy/image-builder-warm-pool-rbac.yaml", "oma-sandbox", "oma-infra"],
  ]) {
    const text = readFileSync(new URL(file, root), "utf8").split("\n").filter((line) => !line.startsWith("#")).join("\n");
    assert.equal((text.match(/namespace: sandbox-system/g) ?? []).length, 2, file);
    assert.match(text, new RegExp(`- apiGroups: \\[agents\\.kruise\\.io\\]\\n  resources: \\[sandboxsets\\]\\n  resourceNames: \\[${pool}\\]\\n  verbs: \\[get, patch\\]\\n---`), file);
    assert.equal((text.match(/apiGroups/g) ?? []).length, 1, file);
    assert.match(text, new RegExp(`kind: ServiceAccount\\n  name: oma-image-builder\\n  namespace: ${namespace}\\n?$`), file);
  }
});
