#!/usr/bin/env node
import { readFile, writeFile, rename } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
const phase = process.argv[2] ?? 'help';
const evidencePath = process.argv[3] ?? '/tmp/oma-live-delegation-evidence.json';
const phases = ['init','sync','async-start','async-finish','shared','resume','query','steer-start','steer-finish','interrupt-start','interrupt-finish','budget','inspect','ui','cleanup'];
if (!phases.includes(phase)) { console.log(JSON.stringify({usage:'cd /app/server/packages/api && pnpm exec tsx /tmp/oma-live-delegation.mjs <phase> [evidence.json]', phases, note:'Copy evidence JSON out before replacing pod, and back before resume. Each run creates and revokes a temporary API key; no credentials are written.'})); process.exit(phase === 'help' ? 0 : 2); }
if (phase === 'budget' && process.env.SUBAGENT_MAX_MODEL_STEPS !== '1') throw new Error('Run the budget phase only against a dedicated verification Host configured with SUBAGENT_MAX_MODEL_STEPS=1');
const root = process.env.OMA_LIVE_APP_ROOT ?? '/app';
const apiPrefix = (process.env.API_BASE_PATH ?? '').replace(/^\/*/, '/').replace(/\/+$/, '');
const base = (process.env.OMA_LIVE_BASE_URL ?? `http://127.0.0.1:3000${apiPrefix}`).replace(/\/+$/, '');
const tenant = process.env.OMA_LIVE_TENANT;
if (!tenant) throw new Error('Set OMA_LIVE_TENANT to the authorized release verification tenant');
const model = 'openai-codex/gpt-5.6-sol';
const timeout = Number(process.env.OMA_LIVE_TIMEOUT_MS ?? 900000);
let evidence;
try { evidence = JSON.parse(await readFile(evidencePath,'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; evidence = {runId:`release-${Date.now()}`,model,tenant,phases:{},checks:[]}; }
function redact(text) { const secrets=[rawKey,process.env.PGPASSWORD,process.env.PG_PASSWORD,process.env.PG_URL,process.env.DATABASE_URL].filter(v=>typeof v==='string'&&v.length>10); for(const secret of secrets) text=text.split(secret).join('[redacted]'); return text.replace(/omak_[A-Za-z0-9_-]+/g,'[redacted]'); }
async function save() { await writeFile(`${evidencePath}.tmp`,redact(JSON.stringify(evidence,null,2)),{mode:0o600}); await rename(`${evidencePath}.tmp`,evidencePath); }
function log(value) { console.log(JSON.stringify({phase,time:new Date().toISOString(),...value})); }
function check(name,ok,details) { evidence.checks.push({phase,name,ok:Boolean(ok),details,time:new Date().toISOString()}); if (!ok) throw new Error(`Assertion failed: ${name}`); }
const schema = process.env.PG_SCHEMA ?? 'oma';
if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(schema)) throw new Error('Invalid PG_SCHEMA');
const require = createRequire(import.meta.url);
const { Pool } = require(`${root}/server/packages/store/node_modules/pg`);
const { PgApiKeyStore } = await import(pathToFileURL(`${root}/server/packages/store/src/postgres/api-key-store.ts`).href);
const ssl = process.env.PGSSL ?? process.env.PG_SSL;
const pool = new Pool({connectionString:process.env.PG_URL ?? process.env.DATABASE_URL,host:process.env.PGHOST ?? process.env.PG_HOST,port:Number(process.env.PGPORT ?? process.env.PG_PORT ?? 5432),user:process.env.PGUSER ?? process.env.PG_USER,password:process.env.PGPASSWORD ?? process.env.PG_PASSWORD,database:process.env.PGDATABASE ?? process.env.PG_DATABASE,options:`-c search_path=${schema}`,max:2,...(['1','true'].includes(ssl)?{ssl:{rejectUnauthorized:false}}:{})});
const keys = new PgApiKeyStore(pool);
let temporaryKey;
let rawKey;
async function api(path,body,method=body===undefined?'GET':'POST') { const response = await fetch(`${base}${path}`,{method,headers:{'x-api-key':rawKey,'content-type':'application/json'},...(body === undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(60000)}); const text = await response.text(); if (!response.ok) throw new Error(`API ${method} ${path} returned ${response.status}: ${text.slice(0,500).replace(/omak_[A-Za-z0-9_-]+/g,'[redacted]')}`); return JSON.parse(text); }
async function events(id) { let after=0; const result=[]; for(let page=0;page<100;page++) { const data=await api(`/v1/sessions/${id}/events?after_seq=${after}&limit=200`); result.push(...data.data); if(!data.has_more || !data.data.length) return result; after=data.data.at(-1).seq; } throw new Error('Event pagination exceeded'); }
async function executions(id) { const page=await api(`/v1/sessions/${id}/delegations?limit=100`); return page.data; }
const terminal = new Set(['completed','failed','interrupted','budget_exhausted','recovery_required']);
async function wait(label,read,accept) { const deadline=Date.now()+timeout; let nextLog=0; while(Date.now()<deadline) { const value=await read(); if(accept(value)) return value; if(Date.now()>nextLog) {log({waiting:label}); nextLog=Date.now()+30000; await save();} await new Promise(resolve=>setTimeout(resolve,2000)); } throw new Error(`Timeout: ${label}`); }
async function createSession(name) { const s=await api('/v1/sessions',{agent:evidence.agentId,workspace_name:`${evidence.runId}-${name}`}); evidence.phases[name]={sessionId:s.id,workspaceId:s.workspaceId}; await save(); log({createdSession:name,sessionId:s.id,workspaceId:s.workspaceId}); return evidence.phases[name]; }
async function send(s,prompt) { const before=await events(s.sessionId); const afterSeq=before.at(-1)?.seq ?? 0; const accepted=await api(`/v1/sessions/${s.sessionId}/events`,{events:[{type:'user.message',data:{content:[{type:'text',text:prompt}]}}]}); s.inputs??=[]; s.inputs.push({afterSeq,prompt,accepted,time:new Date().toISOString()}); await save(); return afterSeq; }
function verifyTurnEvents(es,afterSeq,turnPrefix) {
  const complete=es.find(e=>e.seq>afterSeq&&e.type==='session.turn_completed'&&(!turnPrefix||e.data?.turnId?.startsWith(turnPrefix)));
  const relevant=es.filter(e=>e.seq>afterSeq&&(!complete||e.seq<=complete.seq));
  const error=relevant.find(e=>e.type==='session.error'||e.type==='session.turn_aborted');
  if(error) {evidence.turnErrors??=[];evidence.turnErrors.push({phase,sessionId:error.sessionId,seq:error.seq,data:error.data});throw new Error(`Turn failed: ${error.type} at seq ${error.seq}: ${JSON.stringify(error.data).slice(0,600)}`);}
  return {complete,relevant};
}
async function completedTurn(s,afterSeq) { return wait('parent Turn completed',()=>events(s.sessionId),es=>Boolean(verifyTurnEvents(es,afterSeq).complete)); }
async function latestExecution(s,excluded=[]) { return wait('delegation execution',async()=> { const [xs,es]=await Promise.all([executions(s.sessionId),events(s.sessionId)]); const state=verifyTurnEvents(es,s.inputs.at(-1)?.afterSeq??0); if(state.complete&&!xs.some(x=>!excluded.includes(x.id))) throw new Error('Parent Turn completed without requested delegation'); return xs; },xs=>xs.some(x=>!excluded.includes(x.id))).then(xs=>xs.find(x=>!excluded.includes(x.id))); }
async function finalExecution(s,id) { return wait('child terminal state',()=>executions(s.sessionId),xs=>xs.some(x=>x.id===id && terminal.has(x.status))).then(xs=>xs.find(x=>x.id===id)); }
async function traceAll(s,id) { let after=0, combined=[]; for(let n=0;n<100;n++) { const page=await api(`/v1/sessions/${s.sessionId}/delegations/${id}/events?after_seq=${after}&limit=100`); combined.push(...page.data); if(!page.has_more||!page.data.length) return {...page,data:combined}; after=page.next_cursor; } throw new Error('Trace pagination exceeded'); }
async function capture(s,id) { const [parentEvents,trace,usage,origin,child] = await Promise.all([events(s.sessionId),traceAll(s,id),api(`/v1/sessions/${s.sessionId}/delegation-usage`),api(`/v1/sessions/${s.childId}/delegation-origin`),api(`/v1/sessions/${s.childId}`)]); s.snapshots??=[]; s.snapshots.push({at:new Date().toISOString(),parentEvents,trace,usage,origin,child:{id:child.id,agentId:child.agentId,workspaceId:child.workspaceId,delegation:child.delegation,status:child.status}}); await save(); return s.snapshots.at(-1); }

function assertNoSecrets() { const serialized=JSON.stringify(evidence); check('evidence contains no API key or database credential',redact(serialized)===serialized); }
function assertUsage(snapshot) { const fields=['input_tokens','output_tokens','cache_read_tokens','cache_write_tokens','total_tokens']; for(const key of fields) check(`usage ${key} adds up`,Number.isFinite(snapshot.usage.self[key])&&snapshot.usage.total[key]===snapshot.usage.self[key]+snapshot.usage.delegated[key],{self:snapshot.usage.self[key],delegated:snapshot.usage.delegated[key],total:snapshot.usage.total[key]}); }
function markerOutput(es,path,token,afterSeq=0) { const calls=es.filter(e=>e.seq>afterSeq&&e.type==='agent.tool_use'&&e.data?.name==='bash'&&JSON.stringify(e.data.input).includes(path)&&/\bcat\b/.test(JSON.stringify(e.data.input))&&!JSON.stringify(e.data.input).includes(token)); const results=es.filter(e=>e.type==='agent.tool_result'&&!e.data?.isError&&calls.some(c=>c.data.toolUseId===e.data.toolUseId)&&JSON.stringify(e.data.content).includes(token)); return results.map(e=>({seq:e.seq,toolUseId:e.data.toolUseId,content:e.data.content})); }
async function assertNotification(s) {
  await wait('notification processed and parent Turn completed',async()=>({xs:await executions(s.sessionId),es:await events(s.sessionId)}),({xs,es})=> {const claim=es.find(e=>e.type==='subagent.result_claimed'&&e.data?.executionId===s.executionId); if(!claim) return false; const state=verifyTurnEvents(es,claim.seq,`turn_${claim.seq}_a`); return xs.some(x=>x.id===s.executionId&&x.notificationStatus==='processed')&&Boolean(state.complete);});
  const snap=await capture(s,s.executionId); const notifications=snap.parentEvents.filter(e=>e.type==='subagent.result'&&e.data?.executionId===s.executionId); const claims=snap.parentEvents.filter(e=>e.type==='subagent.result_claimed'&&e.data?.executionId===s.executionId);
  check('exactly one durable result notification',notifications.length===1,{count:notifications.length}); check('exactly one claimed result notification',claims.length===1,{count:claims.length});
  const turns=snap.parentEvents.filter(e=>e.type==='session.turn_completed'&&e.data?.turnId?.startsWith(`turn_${claims[0].seq}_a`));
  check('exactly one completed notification Turn',turns.length===1,{turns:turns.map(e=>e.data.turnId)});
  const callback=verifyTurnEvents(snap.parentEvents,claims[0].seq,`turn_${claims[0].seq}_a`); const turnId=turns[0].data.turnId;
  const modelSpans=callback.relevant.filter(e=>e.type==='span.model_request_end'&&e.data?.turnId===turnId); const acknowledgements=callback.relevant.filter(e=>e.type==='agent.message'&&e.data?.turnId===turnId&&e.data?.content?.some(c=>c.type==='text'&&c.text.trim()));
  check('notification callback actually called model',modelSpans.length>0,{spans:modelSpans.map(e=>({seq:e.seq,model:e.data.model}))}); check('notification callback emitted acknowledgement',acknowledgements.length>0,{messages:acknowledgements.map(e=>({seq:e.seq,content:e.data.content}))}); check('final notification status processed',snap.trace.execution.notificationStatus==='processed',{status:snap.trace.execution.notificationStatus}); assertUsage(snap); return snap;
}

async function file(s,name) {
  const access = await api(`/v1/workspaces/${s.workspaceId}/files/${name.split('/').map(encodeURIComponent).join('/')}`);
  // The signed storage request must not carry the OMA API key.
  const response = await fetch(access.url,{signal:AbortSignal.timeout(60000)});
  if (!response.ok) throw new Error(`File ${name}: storage returned HTTP ${response.status}`);
  return response.text();
}
function filePath(name) { return `/home/user/workspace/oma-release/${evidence.runId}/${name}`; }
function directive(name,token) { return `CHILD DIRECTIVE: Use Sandbox bash to create parent directories and write EXACT text ${token} (no newline) to ${filePath(name)}. Then use a second tool invocation to read it back and verify exact bytes. Do not delegate. Final answer: ${token}.`; }
function parent(args,final='PARENT_DONE') { return `PARENT: Call Agent exactly once with these exact arguments: ${JSON.stringify(args)}. Do not add arguments. Do not perform the child task yourself. After Agent returns, reply exactly ${final}. Do not call get_subagent_result unless explicitly instructed.`; }
try {
  const created=await keys.create(tenant,`${evidence.runId}-${phase}`); temporaryKey=created.apiKey; rawKey=created.rawKey;
  if(phase==='init') {
    if(!evidence.agentId) { const a=await api('/v1/agents',{name:evidence.runId,description:'Release verification #133–#141',model,runtime:'pi-agent',sandbox:{enabled:true},mcpServers:[],skills:[],system:'You are a precise release verification agent. Incoming PARENT: requests specify exact Host tool calls. Incoming CHILD DIRECTIVE: tasks must be executed yourself with Sandbox tools, never delegated. Child tasks may also appear inside delegation_input. Follow their instructions directly. Results or notifications only need a concise acknowledgement; never initiate new delegation from a result. Do not use Web or MCP. Preserve exact requested filenames and text.'}); evidence.agentId=a.id; }
    check('release Agent exists',Boolean(evidence.agentId),{agentId:evidence.agentId});
  } else {
    check('init prerequisite',Boolean(evidence.agentId));
    if(phase==='sync') {
      check('sync phase not already started',!evidence.phases.sync);
      const s=await createSession('sync'); s.token=`SYNC_${evidence.runId}`; s.file='sync.txt';
      const after=await send(s,parent({prompt:directive(s.file,s.token)}));
      const x=await latestExecution(s); s.childId=x.childId; s.executionId=x.id; await save();
      const done=await finalExecution(s,x.id); await completedTurn(s,after); const snap=await capture(s,x.id);
      check('default delegation is synchronous',done.mode==='sync'); check('sync completed',done.status==='completed',{status:done.status});
      check('child shares Workspace',snap.child.workspaceId===s.workspaceId);
      check('same Agent snapshot id',snap.child.agentId===evidence.agentId);
      check('child tool trace visible',snap.trace.data.some(e=>e.type==='agent.tool_use')&&snap.trace.data.some(e=>e.type==='agent.tool_result'));
      check('sync file bytes',await file(s,`oma-release/${evidence.runId}/${s.file}`)===s.token);
      check('sync notification not injected',!snap.parentEvents.some(e=>e.type==='subagent.result_claimed'));
      check('effective model persisted',done.effectiveConfig?.model===model,{effectiveConfig:done.effectiveConfig});
      s.status='passed';
    } else if(['async-start','steer-start','interrupt-start'].includes(phase)) {
      const kind=phase.split('-')[0]; check(`${kind} phase not already started`,!evidence.phases[kind]); const s=await createSession(kind);
      s.token=`${kind.toUpperCase()}_${evidence.runId}`; s.file=`${kind}.txt`;
      const seconds=kind==='async'?30:90;
      const childPrompt=`CHILD DIRECTIVE: First call Sandbox bash with only the command sleep ${seconds}. Wait for that command to finish. Then ${directive(s.file,s.token).replace('CHILD DIRECTIVE: ','')}`;
      const after=await send(s,parent({prompt:childPrompt,run_in_background:true},'PARENT_BACKGROUND_RETURNED'));
      const x=await latestExecution(s); s.childId=x.childId; s.executionId=x.id; await save();
      await completedTurn(s,after); const current=(await executions(s.sessionId)).find(y=>y.id===x.id);
      check('background parent completed before child',!terminal.has(current.status),{status:current.status});
      await wait('child executing sleep',()=>events(s.childId),es=>es.some(e=>e.type==='agent.tool_use'&&JSON.stringify(e.data).includes('sleep')));
      await capture(s,x.id); s.status='started';
    } else if(phase==='async-finish') {
      const s=evidence.phases.async; check('async-start prerequisite',Boolean(s?.executionId));
      const x=await finalExecution(s,s.executionId);
      await wait('background notification claimed',()=>events(s.sessionId),es=>es.some(e=>e.type==='subagent.result_claimed'&&JSON.stringify(e.data).includes(s.executionId)));
      await assertNotification(s); check('async completed',x.status==='completed',{status:x.status}); check('async file bytes',await file(s,`oma-release/${evidence.runId}/${s.file}`)===s.token); s.status='passed';
    } else if(phase==='shared') {
      const s=evidence.phases.sync; check('sync prerequisite',Boolean(s?.childId)); check('shared phase not already started',!evidence.phases.shared);
      const markerPath=`/tmp/oma-release-${evidence.runId}`; const marker=`SHARED_${evidence.runId}`; const priorChild=await events(s.childId); const old=await executions(s.sessionId);
      evidence.phases.shared={sessionId:s.sessionId,workspaceId:s.workspaceId,childId:s.childId,markerPath,marker,priorChildEventIds:priorChild.map(e=>({seq:e.seq,id:e.data?.id,type:e.type})),status:'started'}; await save();
      const childPrompt=`CHILD DIRECTIVE: Use Sandbox bash to run only cat -- ${markerPath}. Verify the command succeeds and print its output in your final answer. Do not create, write, or repair the file. Do not delegate.`;
      const after=await send(s,`PARENT: First call Sandbox bash with command ${JSON.stringify(`printf %s ${marker} > ${markerPath}`)}. Once successful, call Agent exactly once with ${JSON.stringify({resume:s.childId,prompt:childPrompt,run_in_background:false})}. After Agent returns reply SHARED_VERIFIED. Do not otherwise write files.`);
      const x=await latestExecution(s,old.map(e=>e.id)); evidence.phases.shared.executionId=x.id;await save();const done=await finalExecution(s,x.id); await completedTurn(s,after); const snap=await capture(s,x.id);
      check('parent wrote Sandbox temporary marker',snap.parentEvents.some(e=>e.seq>after&&e.type==='agent.tool_use'&&e.data?.name==='bash'&&JSON.stringify(e.data.input).includes(markerPath)&&JSON.stringify(e.data.input).includes(marker)));
      check('shared child is stable',x.childId===s.childId); check('shared execution completed',done.status==='completed',{status:done.status});
      const proof=markerOutput(snap.trace.data,markerPath,marker); check('child bash output proves shared Sandbox',proof.length>0,{proof}); evidence.phases.shared.proof=proof; evidence.phases.shared.status='passed'; assertUsage(snap);
    } else if(phase==='resume') {
      const s=evidence.phases.sync; const shared=evidence.phases.shared; check('sync prerequisite',Boolean(s?.childId)); check('shared marker prerequisite',shared?.status==='passed'); const old=await executions(s.sessionId); const childBefore=await api(`/v1/sessions/${s.childId}/delegation-origin`);
      const token=`RESUME_${evidence.runId}`;
      const after=await send(s,parent({resume:s.childId,prompt:`CHILD DIRECTIVE: After the Host restart, first use Sandbox bash with only cat -- ${shared.markerPath}. This file must already exist; do not create, write, or repair it. Next use a separate bash call with only cat -- ${filePath(s.file)} to verify the saved Workspace file. Your prior conversation contains both previous values; compare with that history, do not guess or rewrite either source. Then ${directive('resume.txt',token).replace('CHILD DIRECTIVE: ','')}`,run_in_background:false}));
      const x=await latestExecution(s,old.map(e=>e.id)); evidence.phases.resume={sessionId:s.sessionId,workspaceId:s.workspaceId,childId:x.childId,executionId:x.id,originalExecutionId:s.executionId,originBefore:childBefore}; await save();
      const done=await finalExecution(s,x.id); await completedTurn(s,after); const snap=await capture(s,x.id);
      check('resume retains stable child',x.childId===s.childId); check('resume distinct execution',x.id!==s.executionId); check('resume completed',done.status==='completed',{status:done.status});
      const tempProof=markerOutput(snap.trace.data,shared.markerPath,shared.marker);const workspaceProof=markerOutput(snap.trace.data,filePath(s.file),s.token);
      check('post-restart child bash reads original Sandbox tmp marker',tempProof.length>0,{proof:tempProof});check('post-restart child bash reads saved Workspace file',workspaceProof.length>0,{proof:workspaceProof});
      const childEvents=await events(s.childId);check('prior child history retained',shared.priorChildEventIds.every(before=>childEvents.some(e=>e.seq===before.seq&&e.type===before.type&&e.data?.id===before.id)));
      check('resume original origin stable',JSON.stringify(snap.origin.origin)===JSON.stringify(childBefore.origin)); check('resume file bytes',await file(s,`oma-release/${evidence.runId}/resume.txt`)===token); evidence.phases.resume.status='passed';assertUsage(snap);
    } else if(phase==='ui') {
      const original=evidence.phases.async; check('async prerequisite',original?.status==='passed');
      const s={sessionId:original.sessionId,workspaceId:original.workspaceId,childId:original.childId}; evidence.phases.ui=s;
      const old=await executions(s.sessionId); const after=await send(s,parent({resume:s.childId,run_in_background:true,prompt:'CHILD DIRECTIVE: Use bash to sleep 10, then reply exactly UI_REFRESH_OK. Do not delegate.'},'UI_BACKGROUND_RETURNED'));
      const x=await latestExecution(s,old.map(item=>item.id));s.executionId=x.id;await save();log({uiExecution:x.id,sessionId:s.sessionId,childId:s.childId});
      await completedTurn(s,after);const done=await finalExecution(s,x.id);await assertNotification(s);check('UI verification child completed',done.status==='completed');s.status='passed';
    } else if(phase==='query') {
      const s=evidence.phases.sync; check('sync prerequisite',Boolean(s?.childId)); const after=await send(s,`PARENT: Call get_subagent_result exactly once with ${JSON.stringify({childId:s.childId,executionId:s.executionId,wait:false})}; report the structured terminal status. Do not call Agent.`); await completedTurn(s,after); const snap=await capture(s,s.executionId); check('get result tool executed',snap.parentEvents.some(e=>e.seq>after&&e.type==='agent.tool_use'&&e.data?.name==='get_subagent_result'));
    } else if(phase==='steer-finish') {
      const s=evidence.phases.steer; check('steer-start prerequisite',Boolean(s?.executionId)); const token=`STEERED_${evidence.runId}`;
      const after=await send(s,`PARENT: Call steer_subagent exactly once with ${JSON.stringify({childId:s.childId,executionId:s.executionId,message:`CHILD DIRECTIVE: Change your task. After the current sleep completes, write exact text ${token} (no newline) to ${filePath(s.file)}, read it back, then finish. Do not write the previously requested token.`})}. Reply STEER_SENT. Do not call Agent.`);
      await completedTurn(s,after); const x=await finalExecution(s,s.executionId); const snap=await assertNotification(s);
      check('steer applied at boundary',snap.trace.execution.commands?.some(c=>c.kind==='steer'&&c.status==='applied'),{commands:snap.trace.execution.commands}); check('steered execution completed',x.status==='completed'); check('steered file bytes',await file(s,`oma-release/${evidence.runId}/${s.file}`)===token); s.status='passed';
    } else if(phase==='interrupt-finish') {
      const s=evidence.phases.interrupt; check('interrupt-start prerequisite',Boolean(s?.executionId)); s.interruptResponse=await api(`/v1/sessions/${s.childId}/events`,{events:[{type:'user.interrupt',data:{}}]}); await save(); const x=await finalExecution(s,s.executionId); await assertNotification(s); check('direct child interrupt terminal',x.status==='interrupted',{status:x.status,response:s.interruptResponse}); s.status='passed';
    } else if(phase==='budget') {
      check('budget phase not already started',!evidence.phases.budget); const s=await createSession('budget'); s.token=`BUDGET_${evidence.runId}`; s.file='budget.txt'; const after=await send(s,parent({prompt:directive(s.file,s.token)})); const x=await latestExecution(s); s.childId=x.childId;s.executionId=x.id;await save(); const done=await finalExecution(s,x.id); await completedTurn(s,after); await capture(s,x.id); check('budget terminal is truthful',done.status==='budget_exhausted',{status:done.status,result:done.result}); check('budget preserves already-written file',await file(s,`oma-release/${evidence.runId}/${s.file}`)===s.token); s.status='passed';
    } else if(phase==='inspect') {
      for(const s of Object.values(evidence.phases)) if(s.sessionId&&s.childId&&s.executionId) {const snap=await capture(s,s.executionId);assertUsage(snap);if(snap.trace.execution.mode==='async'&&terminal.has(snap.trace.execution.status)) await assertNotification(s);}
    } else if(phase==='cleanup') {
      check('cleanup follows successful final inspect',evidence.lastSuccess?.phase==='inspect');
      const parents=[...new Set(Object.values(evidence.phases).map(s=>s.sessionId).filter(Boolean))]; const children=new Set(Object.values(evidence.phases).map(s=>s.childId).filter(Boolean));
      for(const id of parents) { const xs=await executions(id);for(const x of xs) {check('cleanup execution terminal',terminal.has(x.status),{executionId:x.id,status:x.status});children.add(x.childId);} }
      const ids=[...new Set([...children,...parents])];
      for(const id of ids) {const [session,pending]=await Promise.all([api(`/v1/sessions/${id}`),api(`/v1/sessions/${id}/pending`)]);check('cleanup Session has no active or queued work',['idle','terminated'].includes(session.status)&&pending.count===0,{sessionId:id,status:session.status,pendingCount:pending.count});}
      evidence.cleanup??=[];for(const id of ids) {const result=await api(`/v1/sessions/${id}`,undefined,'DELETE');evidence.cleanup.push({id,result,at:new Date().toISOString()});await save();const session=await api(`/v1/sessions/${id}`);check('cleanup Session terminated',session.status==='terminated',{sessionId:id,status:session.status});}
    }
  }
  assertNoSecrets(); evidence.lastSuccess={phase,at:new Date().toISOString()}; await save(); log({ok:true,evidencePath,runId:evidence.runId,agentId:evidence.agentId,sessions:Object.fromEntries(Object.entries(evidence.phases).map(([name,s])=>[name,{sessionId:s.sessionId,childId:s.childId,executionId:s.executionId,status:s.status}]))});
} catch(error) { evidence.failures??=[]; const message=String(error.message).replace(/omak_[A-Za-z0-9_-]+/g,'[redacted]'); evidence.failures.push({phase,message,at:new Date().toISOString()}); await save(); log({ok:false,error:message,evidencePath}); process.exitCode=1;
} finally { rawKey=undefined; if(temporaryKey) {try {await keys.revoke(tenant,temporaryKey.id);}catch {log({ok:false,error:'Temporary API key revocation failed',apiKeyId:temporaryKey.id}); process.exitCode=1;}} await pool.end(); }
