import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../..', import.meta.url));
const infra = spawnSync('docker', ['compose', '-f', 'server/compose.local.yaml', 'up', '-d', '--wait'], { cwd: root, stdio: 'inherit' });
if (infra.status !== 0) process.exit(infra.status ?? 1);
const env = {
  ...process.env, OMA_LOCAL_INFRA: 'true', AUTH_DISABLED: 'true',
  PG_URL: 'postgres://oma_local:oma_local@127.0.0.1:55432/oma_local',
  PG_SCHEMA: 'oma', REDIS_URL: 'redis://127.0.0.1:56379',
  PG_ENSURE_SCHEMA: 'true', API_BASE_PATH: '',
};
// Sequential readiness prevents two fresh-process DDL bootstraps racing.
const children = [];
function start(role, port) {
  const child = spawn('pnpm', ['--dir', 'server/packages/api', 'exec', 'tsx', `src/${role}-server.ts`], {
    cwd: root, env: { ...env, PORT: String(port) }, stdio: 'inherit', detached: true,
  });
  children.push(child);
  child.once('exit', code => { if (!stopping) stop(code ?? 1); });
}
let stopping = false;
function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const child of children) { try { process.kill(-child.pid, 'SIGTERM'); } catch {} }
  process.exitCode = code;
}
process.on('SIGINT', () => stop());
process.on('SIGTERM', () => stop());
start('api', 3000);
for (let i = 0; i < 120; i++) {
  if (stopping) break;
  try { if ((await fetch('http://127.0.0.1:3000/ready')).ok) { start('runner', 3001); break; } } catch {}
  if (i === 119) { console.error('API startup timed out'); stop(1); }
  await new Promise(resolve => setTimeout(resolve, 500));
}
