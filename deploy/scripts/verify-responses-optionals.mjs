#!/usr/bin/env node
// Run in the Server image. Read credentials in memory; never emit full requests.
import { readFile, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
const models = JSON.parse(await readFile('/opt/pi-agent-seed/models.json', 'utf8'));
const auth = JSON.parse(await readFile('/opt/pi-agent-seed/auth.json', 'utf8'));
const provider = models.providers['openai-codex'];
const credential = auth['openai-codex'].key ?? process.env[provider.apiKey] ?? provider.apiKey;
const evidence = [];
for (const mode of ['omitted', 'false']) {
  const tool = { type: 'function', name: 'Agent', description: 'Create a new child by omitting resume. Resume an existing child only with its real ID.', parameters: { type: 'object', properties: { prompt: { type: 'string' }, resume: { type: 'string', minLength: 1 }, run_in_background: { type: 'boolean' } }, required: ['prompt'], additionalProperties: false }, ...(mode === 'false' ? { strict: false } : {}) };
  const r = await fetch(provider.baseUrl.replace(/\/$/, '') + '/responses', { method: 'POST', headers: { authorization: `Bearer ${credential}`, 'content-type': 'application/json' }, body: JSON.stringify({ model: 'gpt-5.6-sol', store: false, stream: false, instructions: 'Follow the exact tool arguments in the request.', input: 'Call Agent once with exactly {"prompt":"Test task","run_in_background":true}. Omit resume entirely because this is a new child. Do not add other parameters.', tools: [tool], tool_choice: { type: 'function', name: 'Agent' } }), signal: AbortSignal.timeout(90000) });
  if (!r.ok) throw new Error(`Probe ${mode}: HTTP ${r.status}`);
  const body = await r.json();
  const record = { at: new Date().toISOString(), mode, arguments: body.output?.filter(x => x.type === 'function_call').map(x => x.arguments), resolvedTools: body.tools?.map(x => ({ name: x.name, strict: x.strict, parameters: x.parameters })) };
  if (mode === 'false') {
    assert(record.arguments?.length === 1, 'Expected exactly one tool call');
    assert(!Object.hasOwn(JSON.parse(record.arguments[0]), 'resume'), 'Optional resume must remain absent');
    assert(record.resolvedTools?.[0]?.strict === false, 'Gateway must preserve explicit strict:false');
  }
  evidence.push(record); console.log(JSON.stringify(record));
}
await writeFile('/tmp/oma-responses-optionals.json', JSON.stringify(evidence, null, 2));
