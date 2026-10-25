import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import test from "node:test";

const root = new URL("../", import.meta.url);
const digest = (c) => `sha256:${c.repeat(64)}`;

function render(env) {
  const output = execFileSync(
    "node",
    [new URL("deploy/scripts/render.mjs", root).pathname, env, digest("a"), digest("b"), digest("c")],
    { encoding: "utf8" },
  );
  return output.split(/^---$/m).map((doc) => doc.trim()).filter(Boolean);
}

const field = (doc, key) => doc.match(new RegExp(`^\\s+${key}: "?([^"\\n]*)"?$`, "m"))?.[1];
const configMap = (docs, name) => docs.find((doc) => /^kind: ConfigMap$/m.test(doc) && doc.includes(`name: ${name}\n`));
const ingress = (docs) => docs.find((doc) => /^kind: Ingress$/m.test(doc));

test("each overlay renders every image and keeps resources in its namespace", () => {
  for (const [env, namespace] of [["production", "oma-infra"], ["test", "oma-test"]]) {
    const docs = render(env);
    const text = docs.join("\n");
    assert.doesNotMatch(text, /OMA_(API|RUNNER|WEB)_IMAGE/);
    assert.match(text, new RegExp(`oma-server@${digest("a")}`));
    assert.match(text, new RegExp(`oma-server@${digest("b")}`));
    assert.match(text, new RegExp(`oma-web@${digest("c")}`));
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

test("each environment's Runners claim from their Warm Pool with its exact image (ADR-0024)", () => {
  const pool = readFileSync(new URL("sandbox/warm-pool/oma-test-sandbox.yaml", root), "utf8");
  const poolImage = pool.match(/^\s+image: (\S+)$/m)?.[1];
  const test = configMap(render("test"), "oma-runner-config");
  assert.equal(field(test, "SANDBOX_TEMPLATE"), "oma-test-sandbox");
  // The gateway compares references as strings: anything else swaps every claim.
  assert.equal(field(test, "SANDBOX_IMAGE").replace(/^'|'$/g, ""), poolImage);
  const production = configMap(render("production"), "oma-runner-config");
  assert.equal(field(production, "SANDBOX_TEMPLATE"), "auto-story-v2");
  for (const image of [poolImage, field(production, "SANDBOX_IMAGE")]) assert.match(image, digestPinned);
  assert.match(readFileSync(new URL("deploy/k8s.yaml", root), "utf8"), new RegExp(`^  SANDBOX_IMAGE: "${field(production, "SANDBOX_IMAGE")}"$`, "m"));
});

test("the oma-test Warm Pool is the auto-story-v2 template without base-secret pod env (ADR-0024)", () => {
  const pool = readFileSync(new URL("sandbox/warm-pool/oma-test-sandbox.yaml", root), "utf8");
  const manifest = pool.split("\n").filter((line) => !line.startsWith("#")).join("\n");
  assert.match(manifest, /^kind: SandboxSet\nmetadata:\n  name: oma-test-sandbox\n  namespace: sandbox-system\n  labels:\n    oma\.dev\/test-only: "true"$/m);
  assert.match(manifest, /^  replicas: 1$/m);
  assert.match(manifest, /image\.alibabacloud\.com\/enable-image-cache: "true"/);
  assert.match(manifest, /- mountPath: \/etc\/vfs-cli\n\s+name: vfs-cli-policy\n\s+readOnly: true/);
  assert.doesNotMatch(manifest, /base-secret|secretKeyRef|auto-story-source|^\s+env:/m);
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
