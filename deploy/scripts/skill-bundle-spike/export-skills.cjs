// Runs inside an oma-test API/Runner Pod (`node -e`, argv[1] = Agent id) for the
// #261 spike. Read-only: one READ ONLY transaction on schema oma_test for the
// Agent's equipped Skills, then Supabase Storage list/get of their files.
// Prints {"tenantId", "skills": [{"skillId", "name", "files": [{"path", "b64"}]}]}
// followed by a "<bytes> <sha256>" trailer line.
const { Client } = require('/app/server/packages/store/node_modules/pg');
const agentId = process.argv[1];
const retry = async (work) => {
  for (let attempt = 1; ; attempt++) {
    try { return await work(); } catch (error) {
      if (attempt === 5) throw error;
      await new Promise((resolve) => setTimeout(resolve, 500 * attempt));
    }
  }
};
(async () => {
  if (process.env.PG_SCHEMA !== 'oma_test' || process.env.S3_BUCKET !== 'workspace-test') throw new Error('not the test environment');
  const pg = new Client({ host: process.env.PG_HOST, port: Number(process.env.PG_PORT), user: process.env.PG_USER,
    password: process.env.PG_PASSWORD, database: process.env.PG_DATABASE,
    ssl: process.env.PG_SSL === 'true' ? { rejectUnauthorized: false } : undefined });
  await pg.connect();
  await pg.query('BEGIN READ ONLY');
  const agent = (await pg.query('SELECT tenant_id, skills FROM oma_test.agents WHERE id = $1', [agentId])).rows[0];
  if (!agent) throw new Error('agent not found');
  const names = new Map((await pg.query('SELECT skill_id, name FROM oma_test.skills WHERE tenant_id = $1 AND skill_id = ANY($2)',
    [agent.tenant_id, agent.skills])).rows.map((row) => [row.skill_id, row.name]));
  await pg.query('COMMIT');
  await pg.end();
  const endpoint = process.env.S3_ENDPOINT.replace(/\/+$/, '');
  const bucket = encodeURIComponent(process.env.S3_BUCKET);
  const headers = { Authorization: `Bearer ${process.env.SUPABASE_SERVICE_KEY}` };
  const list = async (prefix, keys) => {
    for (let offset = 0; ; ) {
      const entries = await retry(async () => {
        const res = await fetch(`${endpoint}/object/list/${bucket}`, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' },
          body: JSON.stringify({ prefix, limit: 1000, offset }) });
        if (!res.ok) throw new Error(`list ${res.status}`);
        return res.json();
      });
      for (const entry of entries) {
        if (entry.id == null && entry.metadata == null) await list(`${prefix}${entry.name}/`, keys);
        else keys.push(`${prefix}${entry.name}`);
      }
      if (entries.length < 1000) return;
      offset += entries.length;
    }
  };
  const skills = [];
  for (const skillId of agent.skills) {
    const base = `${encodeURIComponent(agent.tenant_id)}/skills/${encodeURIComponent(skillId)}/`;
    const keys = [];
    await list(base, keys);
    const files = [];
    for (let i = 0; i < keys.length; i += 4) {
      files.push(...await Promise.all(keys.slice(i, i + 4).map(async (key) => {
        const body = await retry(async () => {
          const res = await fetch(`${endpoint}/object/${bucket}/${key.split('/').map(encodeURIComponent).join('/')}`, { headers });
          if (!res.ok) throw new Error(`get ${res.status}`);
          return Buffer.from(await res.arrayBuffer());
        });
        return { path: key.slice(base.length), b64: body.toString('base64') };
      })));
    }
    skills.push({ skillId, name: names.get(skillId), files });
  }
  // kubectl exec can drop the tail of a large stdout when the process exits
  // at once: append a length + sha256 trailer and linger before exiting.
  const text = JSON.stringify({ tenantId: agent.tenant_id, skills });
  const digest = require('node:crypto').createHash('sha256').update(text).digest('hex');
  process.stdout.write(`${text}\n${Buffer.byteLength(text)} ${digest}\n`, () => setTimeout(() => process.exit(0), 2000));
})().catch((error) => {
  // Only the short message: storage error bodies are not echoed.
  process.stderr.write(`export failed: ${String(error && error.message).slice(0, 120)}\n`);
  process.exit(1);
});
