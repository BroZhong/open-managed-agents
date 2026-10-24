/*
 * One-off, read-only report of what the ADR-0023 sweeper would do (#289): run
 * before the sweeper is enabled, once per environment. It lists every Sandbox
 * the gateway returns for the Pod's API key, reads their bindings and Session
 * facts from the Pod's schema, and prints the pure selection (`selectSweep`)
 * as markdown: counts, the planned `sandbox_sweep` counters and one row per
 * Sandbox.
 *
 *   deploy/scripts/run-sandbox-sweep-report.sh <test|production> > report.md
 *
 * The gateway (E2B_API_URL) is reachable only inside the cluster, so the
 * wrapper bundles this file with esbuild (the deployed image predates it),
 * copies the bundle into /tmp of one of the environment's Runner Pods, which
 * have E2B_API_URL, E2B_API_KEY and PG_*, runs it there with node and deletes
 * it. Directly, with that environment:
 *
 *   pnpm --dir server --filter @oma-server/api exec tsx src/sandbox-sweep-report.ts --environment <e> --schema <s>
 *
 * Read-only by construction: the gateway is only sent `GET /v2/sandboxes`;
 * PostgreSQL is only sent SELECTs, inside a READ ONLY transaction. Sandbox
 * metadata can hold credentials (#260, #277): only the binding id and the
 * environment label are read from it, and no gateway or database error body
 * is printed.
 *
 * Works on both schemas: before ADR-0023's migration a pending binding
 * (`creation_pending`) is read as Creating since the epoch, exactly as the
 * migration writes it; after it, `creating_since` is read as is.
 */
import { parseArgs } from "node:util";
import { Agent } from "undici";
import {
  SANDBOX_BINDING_LABEL,
  SANDBOX_ENVIRONMENT_LABEL,
  SANDBOX_IDLE_SECONDS,
  SWEEP_MAX_KILLS,
  listedSandbox,
  selectSweep,
  type GatewayListEntry,
  type ListedSandbox,
  type SandboxEnvironment,
  type SweepBinding,
  type SweepDecision,
} from "@oma-server/sandbox/sweep";
import { createPgPool, pgConfigFromEnv, type Pool } from "@oma-server/store";

/** ADR-0023: CLAIM_SECONDS + 30. */
const INTENT_DEADLINE_SECONDS = 180;
const PAGE_LIMIT = 100;

const { values: args } = parseArgs({ options: { environment: { type: "string" }, schema: { type: "string" } } });
const environment = args.environment as SandboxEnvironment;
if ((environment !== "production" && environment !== "test") || !args.schema) {
  throw new Error("Usage: sandbox-sweep-report.ts --environment <production|test> --schema <PG_SCHEMA>");
}
// The schema must be the environment's own: decisions depend on which bindings exist.
if (process.env.PG_SCHEMA !== args.schema) throw new Error(`PG_SCHEMA is not ${args.schema}`);
const apiUrl = process.env.E2B_API_URL;
const apiKey = process.env.E2B_API_KEY;
if (!apiUrl || !apiKey) throw new Error("The gateway needs E2B_API_URL and E2B_API_KEY");

async function listSandboxes(): Promise<{ sandboxes: ListedSandbox[]; pages: number; otherStates: number }> {
  // Keep the in-cluster call off any HTTP proxy, as bootstrap does for internal Storage.
  const dispatcher = new Agent();
  try {
    const sandboxes: ListedSandbox[] = [];
    let pages = 0, otherStates = 0, nextToken: string | null = null;
    do {
      const url = new URL(`${apiUrl!.replace(/\/+$/, "")}/v2/sandboxes`);
      url.searchParams.set("state", "running,paused");
      url.searchParams.set("limit", String(PAGE_LIMIT));
      if (nextToken) url.searchParams.set("nextToken", nextToken);
      const response = await fetch(url, { headers: { "X-API-Key": apiKey! }, signal: AbortSignal.timeout(30_000), dispatcher } as RequestInit);
      if (!response.ok) throw new Error(`GET /v2/sandboxes answered HTTP ${response.status}`);
      for (const entry of await response.json() as GatewayListEntry[]) {
        const sandbox = listedSandbox(entry);
        if (sandbox) sandboxes.push(sandbox); else otherStates++;
      }
      pages++;
      nextToken = response.headers.get("x-next-token");
    } while (nextToken);
    return { sandboxes, pages, otherStates };
  } finally {
    await dispatcher.close();
  }
}

interface BindingFacts { bindings: Map<string, SweepBinding>; recordedBy: Map<string, string>; column: string; rows: Record<string, number> }

/**
 * Busy as `PgSandboxLifecycleStore.claimReclamation` defines it: a resource use
 * or a pending event of a non-terminated Session of the binding.
 */
async function readBindings(pool: Pool, schema: string, bindingIds: string[], sandboxIds: string[]): Promise<BindingFacts> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN READ ONLY");
    await client.query("SET LOCAL statement_timeout = '60s'");
    const { rows: columns } = await client.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns WHERE table_schema = $1 AND table_name = 'delegation_environments'
         AND column_name IN ('creating_since', 'creation_pending')`, [schema]);
    const names = columns.map((c) => c.column_name);
    if (names.length !== 1) throw new Error(`delegation_environments has ${names.join(" and ") || "neither creating_since nor creation_pending"}: is the migration halfway?`);
    const column = names[0];
    const creatingSince = column === "creating_since" ? "e.creating_since" : "CASE WHEN e.creation_pending THEN 'epoch'::timestamptz END";
    const { rows } = await client.query<{ id: string; sandbox_id: string | null; reclaiming: boolean; creating_since: Date | null; in_use: boolean; all_sessions_terminated: boolean }>(
      `WITH alive AS (
         SELECT s.id, COALESCE(s.delegation->>'sandboxSessionId', s.id) AS binding_id FROM sessions s WHERE s.status <> 'terminated'
       ), in_use AS (
         SELECT u.record->>'sandboxSessionId' AS binding_id FROM delegation_resource_uses u JOIN alive a ON a.id = u.record->>'sessionId'
           JOIN pending_events pu ON pu.id = u.record->>'pendingEventId'
         UNION SELECT a.binding_id FROM pending_events p JOIN alive a ON a.id = p.session_id
       )
       SELECT e.id, e.sandbox_id, e.reclaiming, ${creatingSince} AS creating_since,
         EXISTS (SELECT 1 FROM in_use i WHERE i.binding_id = e.id) AS in_use,
         NOT EXISTS (SELECT 1 FROM alive a WHERE a.binding_id = e.id) AS all_sessions_terminated
       FROM delegation_environments e WHERE e.id = ANY($1::text[])`, [bindingIds]);
    const { rows: recorded } = await client.query<{ id: string; sandbox_id: string }>(
      "SELECT id, sandbox_id FROM delegation_environments WHERE sandbox_id = ANY($1::text[])", [sandboxIds]);
    const { rows: [counts] } = await client.query<Record<string, string>>(
      `SELECT count(*) AS total, count(*) FILTER (WHERE sandbox_id IS NOT NULL) AS ready,
         count(*) FILTER (WHERE sandbox_id IS NULL AND ${creatingSince} IS NOT NULL) AS creating,
         count(*) FILTER (WHERE sandbox_id IS NULL AND ${creatingSince} IS NULL) AS cold,
         count(*) FILTER (WHERE reclaiming) AS reclaiming
       FROM delegation_environments e`);
    return {
      bindings: new Map(rows.map((row) => [row.id, {
        sandboxId: row.sandbox_id, creatingSince: row.creating_since, reclaiming: row.reclaiming,
        inUse: row.in_use, allSessionsTerminated: row.all_sessions_terminated,
      }])),
      recordedBy: new Map(recorded.map((row) => [row.sandbox_id, row.id])),
      column,
      rows: Object.fromEntries(Object.entries(counts).map(([key, value]) => [key, Number(value)])),
    };
  } finally {
    await client.query("ROLLBACK").catch(() => {});
    client.release();
  }
}

const iso = (date: Date | null) => (date === null ? "none" : Number.isNaN(date.getTime()) ? "unknown" : date.toISOString().replace(".000Z", "Z"));
const describeDecision = (d: SweepDecision) =>
  d.action === "keep" || d.action === "kill" ? `${d.action}${d.action === "kill" && d.deferred ? " (deferred)" : ""} | ${d.reason}`
  : d.action === "adopt" ? `adopt | ${d.shorten ? "unresolved, shorten to 30 min" : "unresolved"}` : "shorten | unused running";
function describeRow(sandboxId: string, row: SweepBinding | undefined): string {
  if (!row) return "none";
  const state = row.sandboxId === sandboxId ? "Ready(this)" : row.sandboxId !== null ? "Ready(other)"
    : row.creatingSince !== null ? `Creating(${row.creatingSince.getTime() === 0 ? "epoch" : iso(row.creatingSince)})` : "Cold";
  const flags = [row.reclaiming && "reclaiming", row.inUse && "in use", row.allSessionsTerminated && "all terminated"].filter(Boolean);
  return [state, ...flags].join(", ");
}

const now = new Date();
const started = performance.now();
const { sandboxes, pages, otherStates } = await listSandboxes();
const listMs = Math.round(performance.now() - started);
const bindingIds = [...new Set(sandboxes.flatMap((s) => s.metadata[SANDBOX_BINDING_LABEL] ?? []))];
const pool = createPgPool({ ...pgConfigFromEnv(), max: 1 });
let facts: BindingFacts;
try {
  facts = await readBindings(pool, args.schema, bindingIds, sandboxes.map((s) => s.sandboxId));
} finally {
  await pool.end();
}
const { decisions, counts } = selectSweep(sandboxes, facts.bindings, {
  environment, now, intentDeadlineSeconds: INTENT_DEADLINE_SECONDS, idleSeconds: SANDBOX_IDLE_SECONDS, maxKills: SWEEP_MAX_KILLS,
});

const bySandbox = new Map(sandboxes.map((s) => [s.sandboxId, s]));
const tally = (keys: string[]) => [...keys.reduce((m, k) => m.set(k, (m.get(k) ?? 0) + 1), new Map<string, number>())]
  .sort(([a], [b]) => a.localeCompare(b));
const out: string[] = [];
const table = (head: string[], rows: (string | number)[][]) =>
  out.push(`| ${head.join(" | ")} |`, `|${head.map(() => "---").join("|")}|`, ...rows.map((r) => `| ${r.join(" | ")} |`), "");

out.push(`# Sandbox sweep report: ${environment} (schema ${args.schema}), ${iso(now)}`, "",
  `Read-only. Gateway list: ${sandboxes.length} Sandboxes (${tally(sandboxes.map((s) => s.state)).map(([k, n]) => `${k} ${n}`).join(", ")})` +
  ` in ${pages} pages, ${listMs} ms${otherStates ? `; ${otherStates} in another state skipped` : ""}.` +
  ` Binding column: \`${facts.column}\`${facts.column === "creation_pending" ? " (pending read as creating_since = epoch)" : ""}.`, "");
out.push("## Labels", "");
table(["oma.dev/environment", "oma.dev/binding", "Sandboxes"], tally(sandboxes.map((s) =>
  `${s.metadata[SANDBOX_ENVIRONMENT_LABEL] ?? "(none)"} | ${s.metadata[SANDBOX_BINDING_LABEL] === undefined ? "absent" : facts.bindings.has(s.metadata[SANDBOX_BINDING_LABEL]) ? "row here" : "no row here"}`))
  .map(([k, n]) => [k, n]));
out.push("## Recorded by this schema", "",
  `Sandboxes recorded as some binding's \`sandbox_id\` here: ${sandboxes.filter((s) => facts.recordedBy.has(s.sandboxId)).length};` +
  ` recorded by none: ${sandboxes.filter((s) => !facts.recordedBy.has(s.sandboxId)).length}.`, "");
out.push(`Binding rows in this schema: ${facts.rows.total} (Ready ${facts.rows.ready}, Creating ${facts.rows.creating}, Cold ${facts.rows.cold}; reclaiming ${facts.rows.reclaiming}).`, "");
out.push("## Decisions", "");
table(["decision", "reason", "Sandboxes"], tally(decisions.map(describeDecision)).map(([k, n]) => [k, n]));
out.push("Planned `sandbox_sweep` counters:", "", "```json",
  JSON.stringify({ msg: "sandbox_sweep", env: environment, ...counts }), "```", "");
out.push("## Sandboxes", "");
const rank = (d: SweepDecision) => ["kill", "adopt", "shorten", "keep"].indexOf(d.action);
table(["sandboxId", "binding", "environment", "state", "startedAt", "endAt", "binding row", "recorded", "decision", "reason"],
  [...decisions].sort((a, b) => rank(a) - rank(b) || describeDecision(a).localeCompare(describeDecision(b)) ||
    bySandbox.get(a.sandboxId)!.startedAt.getTime() - bySandbox.get(b.sandboxId)!.startedAt.getTime()).map((d) => {
    const s = bySandbox.get(d.sandboxId)!;
    return [d.sandboxId, d.bindingId ?? "-", s.metadata[SANDBOX_ENVIRONMENT_LABEL] ?? "(none)", s.state, iso(s.startedAt), iso(s.endAt),
      d.bindingId === null ? "-" : describeRow(d.sandboxId, facts.bindings.get(d.bindingId)),
      facts.recordedBy.get(d.sandboxId) === undefined ? "no" : facts.recordedBy.get(d.sandboxId) === d.bindingId ? "yes" : "by another binding",
      describeDecision(d)];
  }));
// The wrapper checks this line: kubectl exec can cut output short.
out.push("", "<!-- end of report -->");
console.log(out.join("\n"));
