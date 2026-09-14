#!/usr/bin/env node
// Real Agent -> projected Skills -> sandbox CLI -> cloud -> Workspace test.
import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const here = fileURLToPath(new URL('.', import.meta.url));
const agentId = process.argv[2];
const output = resolve(process.argv[3] || 'auto-story-e2e-results');
if (!agentId) throw new Error('Usage: session-e2e.mjs <agent-id> <local-report-directory>');
const base = (process.env.OMA_API_URL || 'https://agentry.welltop.tech/api').replace(/\/$/, '');
const auth = process.env.OMA_BEARER_TOKEN ? { authorization: `Bearer ${process.env.OMA_BEARER_TOKEN}` } : { 'x-api-key': process.env.OMA_API_KEY };
if (!Object.values(auth)[0]) throw new Error('Set OMA_API_KEY or OMA_BEARER_TOKEN privately');
async function request(path, method = 'GET', body) {
  const response = await fetch(base + path, { method, headers: { ...auth, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(120_000) });
  if (!response.ok) throw new Error(`${method} ${path}: HTTP ${response.status}`);
  const text = await response.text();
  return text ? JSON.parse(text) : undefined;
}
await mkdir(output, { recursive: true });
const resume = process.env.AUTO_STORY_E2E_SESSION_ID;
const session = resume ? { id: resume } : await request('/v1/sessions', 'POST', { agent: agentId, workspace_name: 'auto-story skill acceptance' });
await writeFile(join(output, 'session.json'), JSON.stringify({ agentId, sessionId: session.id, url: `${base.replace(/\/api$/, '')}/sessions/${session.id}` }, null, 2));
console.log(JSON.stringify({ sessionId: session.id, phase: 'created' }));
for (const name of resume ? [] : await readdir(join(here, 'e2e'))) {
  if (!name.endsWith('.py')) continue;
  await request(`/v1/sessions/${session.id}/workspace/files/content`, 'PUT', { path: `auto-story-e2e/${name}`, content: await readFile(join(here, 'e2e', name), 'utf8') });
}
const skills = (await request(`/v1/agents/${agentId}/skills`)).data;
const paths = skills.map(s => `/skills/${s.id}/SKILL.md`);
const prompt = `请对 auto-story 做一次实际 skill 验收。先通过 read 工具阅读以下已装备的原始 Skill 文件及需要的 reference：\n${paths.join('\n')}\n然后检查 /home/user/auto-story-e2e 下的测试脚本，它们只使用合成的3秒红底白框有音轨视频、VFS只读查询、MediaKit本地裁剪和云端图片探测、官方Gemini视频上传/分析/清理，不改真实业务数据。通过 bash 工具执行 python3 /home/user/auto-story-e2e/run.py --output-dir /home/user/auto-story-acceptance，等待命令完成（允许600秒）。读取 report.json 和 video-analysis.md 核实结果，再把最终简短验收结论用 write 工具写到 /home/user/auto-story-acceptance/agent-verification.md。密钥只检查是否存在，不能输出环境变量值或VFS业务记录；失败要按实际错误报告，不能改测试脚本以跳过检查或伪造通过。`;
if (!resume) await request(`/v1/sessions/${session.id}/events`, 'POST', { events: [{ type: 'user.message', data: { content: [{ type: 'text', text: prompt }] } }] });
let after = 0;
const events = [];
const deadline = Date.now() + 15 * 60_000;
let completed = false;
while (Date.now() < deadline) {
  const page = await request(`/v1/sessions/${session.id}/events?after_seq=${after}&limit=500`);
  for (const event of page.data) {
    events.push(event);
    after = Math.max(after, event.seq);
  }
  if (page.data.some(e => e.type === 'session.turn_completed')) { completed = true; break; }
  if (!page.has_more) await new Promise(r => setTimeout(r, 5000));
}
const tools = events.filter(e => e.type === 'agent.tool_use').map(e => e.data);
const reads = new Set(tools.filter(t => t.name === 'read').map(t => t.input?.path));
const errors = events.filter(e => e.type === 'session.error').map(e => e.data?.error?.code || 'session.error');
let report;
try { report = await request(`/v1/sessions/${session.id}/workspace/files/auto-story-acceptance/report.json`); } catch { /* missing output is a failure */ }
const files = (await request(`/v1/sessions/${session.id}/workspace/files`)).data;
const summary = {
  agentId, sessionId: session.id, completed,
  skillReads: paths.map(path => ({ path, read: reads.has(path) })),
  toolNames: [...new Set(tools.map(t => t.name))], errors, report,
  // Agent statement alone is insufficient: actual report, tools and durable
  // output must all agree before this accepts the live execution.
  ok: completed && errors.length === 0 && report?.ok === true && paths.every(p => reads.has(p)) && tools.some(t => t.name === 'bash') && tools.some(t => t.name === 'write'),
  files,
};
await writeFile(join(output, 'acceptance.json'), JSON.stringify(summary, null, 2));
// Preserve only synthetic acceptance data and command metadata locally.
console.log(JSON.stringify(summary));
if (!summary.ok) process.exitCode = 1;
