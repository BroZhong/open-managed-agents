#!/usr/bin/env node
// Live acceptance for Resumed Turns (#234, #255). Run inside the API Pod of the TEST
// environment with node --import tsx; it refuses any other schema. It creates its own
// tenant, uses temporary revoked API keys, and only reads its own Sessions.
//
// The script never kills or restarts workloads itself. Between a `*-start` and its
// `*-finish` phase the operator disrupts the Runner that owns the Turn:
//   kill-start    → `kill -9` the owning Runner's node process (needs shareProcessNamespace) → kill-finish
//   handoff-start → `kubectl delete pod <owner>` (graceful: SIGTERM; a 12 s tool finishes
//                   first, then the Turn is handed over)                                        → handoff-finish
//   detach-start  → `kubectl delete pod <owner>` (a 90 s tool outlives the 20 s shutdown
//                   deadline and is detached, not cancelled)                                    → detach-finish
// `kubectl rollout restart deploy/oma-runner` is no handoff trigger: with maxSurge 1 the new Pod
// starts (40–60 s on ECI) before the old one is SIGTERMed, so a short tool has finished by then.
// It is the F6 smoke: a Turn running through a rollout completes without recovery errors.
// A takeover is bounded from the disruption by the 20 s shutdown deadline plus 10 s; a handoff
// is also bounded from the last event its old owner committed, since the old owner legitimately
// runs its tool to the end after SIGTERM.
// `mark-disrupted <evidence> <name>` records the disruption time; `big` runs one Turn with a
// ≈160 KB tool result for the journal flush statistics; `file <evidence> <name>` re-reads a marker.
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);const {Pool}=require('/app/server/packages/store/node_modules/pg');
const {PgApiKeyStore}=await import('/app/server/packages/store/src/postgres/api-key-store.ts');
const {presentEvent}=await import('/app/server/packages/store/src/event-presentation.ts');
const [phase,file='/tmp/oma-resume-evidence.json']=process.argv.slice(2);
const schema=process.env.VERIFY_SCHEMA;assert.equal(schema,'oma_test','Resumed Turn fault injection runs on oma_test only');
const base=process.env.OMA_LIVE_BASE_URL;assert.equal(base,'https://agentry-test.welltop.tech/api');
const pool=new Pool({host:process.env.PG_HOST,port:Number(process.env.PG_PORT),user:process.env.PG_USER,password:process.env.PG_PASSWORD,database:process.env.PG_DATABASE,options:`-c search_path=${schema}`,max:2});
const keys=new PgApiKeyStore(pool);
let e;try{e=JSON.parse(await readFile(file,'utf8'))}catch{assert.equal(phase,'init');e={runId:`resume-${Date.now()}`,schema,checks:[],sessions:{}}}
const key=await keys.create(e.runId,phase);const headers={'x-api-key':key.rawKey,'content-type':'application/json'};
const save=()=>writeFile(file,JSON.stringify(e,null,2),{mode:0o600});
function check(name,ok,details){e.checks.push({name,ok:!!ok,phase,at:new Date().toISOString(),details});console.log(JSON.stringify({check:name,ok:!!ok,details}));assert(ok,name)}
async function api(path,body,method=body===undefined?'GET':'POST'){const r=await fetch(base+path,{method,headers,...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(60000)});const t=await r.text();if(!r.ok)throw Error(`HTTP ${r.status} ${path}: ${t.slice(0,300)}`);return JSON.parse(t)}
const delay=ms=>new Promise(r=>setTimeout(r,ms));
async function wait(label,read,ok,ms=600000){const end=Date.now()+ms;let log=0;while(Date.now()<end){const v=await read();if(ok(v))return v;if(Date.now()>log){console.log(JSON.stringify({waiting:label}));log=Date.now()+15000}await delay(1000)}throw Error('Timeout '+label)}
async function events(id){let after=0,out=[];for(let i=0;i<50;i++){const r=await api(`/v1/sessions/${id}/events?after_seq=${after}&limit=1000`);out.push(...r.data);if(!r.has_more)return out;after=r.data.at(-1).seq}throw Error('pagination')}
// The display events of every native entry, as the Host derives them, beside every event.
const presented=es=>es.flatMap(x=>presentEvent(x));
const textOf=x=>(x?.data?.content??[]).map(c=>c.text??'').join('');
async function session(name){const s=await api('/v1/sessions',{agent:e.agent,workspace_name:`${e.runId}-${name}`});e.sessions[name]={id:s.id,workspaceId:s.workspaceId};await save();return e.sessions[name]}
const prompt=(marker,seconds)=>`Use bash exactly once with this exact command: ${JSON.stringify(`printf START > /home/user/workspace/${marker}.txt; sleep ${seconds}; printf DONE >> /home/user/workspace/${marker}.txt`)}. When it returns, or if its outcome is reported as unknown, inspect /home/user/workspace/${marker}.txt with bash before deciding anything, never run the sleep command again, and finally reply with exactly the file content prefixed by RESULT:.`;
async function start(name,seconds){const s=await session(name);const marker=`${e.runId}-${name}`;e.sessions[name].marker=marker;await api(`/v1/sessions/${s.id}/events`,{events:[{type:'user.message',data:{content:[{type:'text',text:prompt(marker,seconds)}]}}]});
 const es=await wait('bash tool committed',()=>events(s.id),es=>presented(es).some(x=>x.type==='agent.tool_use'&&x.data.name==='bash'));e.sessions[name].toolCommittedAt=new Date().toISOString();await save();
 check(`${name}: long bash committed before disruption`,true,{sessionId:s.id,turnId:presented(es).find(x=>x.type==='agent.tool_use')?.data.turnId});console.log(`DISRUPT_NOW session=${s.id}`)}
async function finish(name,expectReason,maxTakeoverMs,expectUnknown,maxHandoffGapMs){const s=e.sessions[name];const es=await wait('Turn completion',()=>events(s.id),es=>es.some(x=>x.type==='session.turn_completed'));const p=presented(es);
 const turnIds=new Set(p.map(x=>x.data?.turnId).filter(Boolean));const resumed=es.filter(x=>x.type==='session.turn_resumed');const errors=es.filter(x=>x.type==='session.error');
 check(`${name}: one Turn, one turnId`,turnIds.size===1&&es.filter(x=>x.type==='session.turn_completed').length===1,{turnIds:[...turnIds]});
 check(`${name}: takeover recorded`,resumed.length>=1&&resumed.every(x=>x.data?.reason===expectReason),{resumed:resumed.map(x=>({seq:x.seq,ts:x.ts,...x.data}))});
 check(`${name}: no recovery errors`,!errors.some(x=>/recovery/.test(x.data?.error?.code??'')),{errors:errors.map(x=>x.data?.error)});
 // The events API returns native entries and the display events derived from them; key by toolUseId.
 const byId=(type)=>[...new Map(p.filter(x=>x.type===type&&x.data.toolUseId).map(x=>[x.data.toolUseId,x])).values()];
 const uses=byId('agent.tool_use'),results=p.filter(x=>x.type==='agent.tool_result'&&x.data.toolUseId);
 // Count original result sources only: a native toolResult entry, or a Host-written result
 // (recovery repair / delegation result). Display events the API derives from a native entry
 // are the same result again.
 const sources=es.flatMap(x=>x.type==='agent.context_entry'&&x.data?.entry?.message?.role==='toolResult'?[x.data.entry.message.toolCallId]
   :x.type==='agent.tool_result'&&/^(recovery_|delegation_result_)/.test(x.data?.id??'')?[x.data.toolUseId]:[]);
 const resultIds=uses.map(u=>sources.filter(id=>id===u.data.toolUseId).length);
 check(`${name}: every tool call has exactly one result`,resultIds.every(n=>n===1),{uses:uses.length,resultsPerCall:resultIds});
 const sleeps=uses.filter(u=>JSON.stringify(u.data.input).includes('sleep'));check(`${name}: the long command was not rerun`,sleeps.length===1,{sleeps:sleeps.length});
 const first=results.find(r=>r.data.toolUseId===sleeps[0]?.data.toolUseId);const unknown=JSON.stringify(first?.data.content??'').includes('outcome is unknown');
 e.sessions[name].outcome={unknown,isError:first?.data.isError};const after=uses.filter(u=>u.seq>first.seq);
 if(expectUnknown!==undefined)check(`${name}: long call outcome ${expectUnknown?'unknown':'committed'}`,unknown===expectUnknown,{unknown,isError:first?.data.isError});
 if(unknown)check(`${name}: model inspected state after an unknown outcome`,after.some(u=>JSON.stringify(u.data.input).includes(s.marker)),{followUps:after.map(u=>u.data.input)});
 const final=textOf(p.filter(x=>x.type==='agent.message').at(-1));check(`${name}: final answer reports the file`,final.includes('RESULT:'),{final:final.slice(0,200)});
 if(resumed.length&&s.disruptedAt){const t=Date.parse(resumed[0].ts)-Date.parse(s.disruptedAt);e.sessions[name].takeoverMs=t;check(`${name}: takeover within ${maxTakeoverMs||'∞'} ms of the disruption`,!maxTakeoverMs||t<=maxTakeoverMs,{msFromDisruptionToTakeover:t,disruptedAt:s.disruptedAt,resumedAt:resumed[0].ts})}
 // A handed-over Turn moves as soon as its old owner stops: the takeover follows the last event it committed.
 if(resumed.length&&maxHandoffGapMs){const last=es.filter(x=>x.seq<resumed[0].seq).at(-1);const g=Date.parse(resumed[0].ts)-Date.parse(last.ts);e.sessions[name].handoffGapMs=g;check(`${name}: takeover within ${maxHandoffGapMs} ms of the last committed event`,g<=maxHandoffGapMs,{msFromLastCommitToTakeover:g,lastCommitted:{seq:last.seq,type:last.type,ts:last.ts},resumedAt:resumed[0].ts})}
 const access=await api(`/v1/workspaces/${s.workspaceId}/files/${s.marker}.txt`);const bytes=await (await fetch(access.url)).text();check(`${name}: Workspace file`,bytes.startsWith('START'),{bytes})}
const failures=[];
try{
 if(phase==='init'){e.agent=(await api('/v1/agents',{name:`${e.runId}-agent`,model:process.env.VERIFY_MODEL||'openai-codex/gpt-5.6-sol',runtime:'pi-agent',sandbox:{enabled:true},mcpServers:[],skills:[],system:'Follow the verification instructions exactly. Use only bash. Never repeat a command whose outcome is unknown without first inspecting the current state.'})).id;check('verification agent created',true,{tenant:e.runId})}
 else if(phase==='kill-start')await start('kill',120);
 else if(phase==='kill-finish')await finish('kill','expired',35000,true);
 else if(phase==='handoff-start')await start('handoff',12);
 else if(phase==='handoff-finish')await finish('handoff','released',35000,false,5000);
 else if(phase==='detach-start')await start('detach',90);
 else if(phase==='detach-finish')await finish('detach','released',35000,true);
 else if(phase==='big'){const s=await session('big');await api(`/v1/sessions/${s.id}/events`,{events:[{type:'user.message',data:{content:[{type:'text',text:'Use bash exactly once with this exact command: "head -c 120000 /dev/urandom | base64 -w 0 | head -c 160000". Then reply with exactly BIG_DONE.'}]}}]});
  const es=await wait('Turn completion',()=>events(s.id),es=>es.some(x=>x.type==='session.turn_completed'));check('big: Turn with a large tool result completed',es.some(x=>x.type==='agent.context_entry'&&x.data?.entry?.message?.role==='toolResult'),{sessionId:s.id})}
 else if(phase==='mark-disrupted'){const name=process.argv[4];e.sessions[name].disruptedAt=new Date().toISOString();check(`${name}: disruption marked`,true)}
 else if(phase==='file'){const s=e.sessions[process.argv[4]];const access=await api(`/v1/workspaces/${s.workspaceId}/files/${s.marker}.txt`);const bytes=await (await fetch(access.url)).text();e.sessions[process.argv[4]].fileLater=bytes;check(`${process.argv[4]}: marker file now`,true,{bytes,at:new Date().toISOString()})}
 else if(phase==='cleanup'){for(const s of Object.values(e.sessions)){try{await api(`/v1/sessions/${s.id}`,undefined,'DELETE')}catch(error){failures.push(error)}}check('verification Sessions terminated',true,{count:Object.keys(e.sessions).length})}
 else throw Error('unknown phase')
}catch(error){failures.push(error)}finally{for(const f of [save,()=>keys.revoke(e.runId,key.apiKey.id),()=>pool.end()]){try{await f()}catch(error){failures.push(error)}}}
if(failures.length)throw new AggregateError(failures,'Resumed Turn verification failed');
