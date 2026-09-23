#!/usr/bin/env node
// Run inside an authorized deployed Host with node --import tsx.
// Creates a separate verification tenant, uses temporary revoked API keys, and
// never reads or modifies another tenant's Sessions. Preserve the evidence JSON
// across Pod replacement. See docs/api-runner-operations.md for invocation.
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);const {Pool}=require('/app/server/packages/store/node_modules/pg');
const {PgApiKeyStore}=await import('/app/server/packages/store/src/postgres/api-key-store.ts');
const [phase,file='/tmp/oma-split-evidence.json']=process.argv.slice(2);const schema=process.env.VERIFY_SCHEMA||'oma';assert(/^(oma|oma_split_stage)$/.test(schema));
const pool=new Pool({host:process.env.PG_HOST,port:Number(process.env.PG_PORT),user:process.env.PG_USER,password:process.env.PG_PASSWORD,database:process.env.PG_DATABASE,options:`-c search_path=${schema}`,max:3});
const keys=new PgApiKeyStore(pool);const base=process.env.OMA_LIVE_BASE_URL||'https://agentry.welltop.tech/api';
let e;try{e=JSON.parse(await readFile(file,'utf8'))}catch{assert.equal(phase,'init');e={runId:`split-release-${Date.now()}`,schema,checks:[],sessions:{}}}assert.equal(e.schema,schema);assert(/^split-release-\d+$/.test(e.runId));
const key=await keys.create(e.runId,phase);const headers={'x-api-key':key.rawKey,'content-type':'application/json'};
const save=()=>writeFile(file,JSON.stringify(e,null,2),{mode:0o600});
function check(name,ok,details){e.checks.push({name,ok:!!ok,phase,at:new Date().toISOString(),details});assert(ok,name);console.log(JSON.stringify({check:name,ok:true,details}));}
async function api(path,body,method=body===undefined?'GET':'POST',target=base){const r=await fetch(target+path,{method,headers,...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(60000)});const txt=await r.text();if(!r.ok)throw Error(`HTTP ${r.status} ${path}: ${txt.slice(0,300)}`);return JSON.parse(txt)}
const delay=ms=>new Promise(r=>setTimeout(r,ms));
async function wait(label,read,ok,ms=180000){const end=Date.now()+ms;let log=0;while(Date.now()<end){const v=await read();if(ok(v))return v;if(Date.now()>log){console.log(JSON.stringify({waiting:label}));log=Date.now()+15000}await delay(1000)}throw Error('Timeout '+label)}
async function events(id){let after=0,out=[];for(let i=0;i<30;i++){const r=await api(`/v1/sessions/${id}/events?after_seq=${after}&limit=1000`);out.push(...r.data);if(!r.has_more)return out;after=r.data.at(-1).seq}throw Error('pagination')}
async function session(name,real=false){if(e.sessions[name])e.sessions[name+'-'+Date.now()]=e.sessions[name];const s=await api('/v1/sessions',{agent:real?e.realAgent:e.mockAgent,workspace_name:e.runId+'-'+name});e.sessions[name]={id:s.id,workspaceId:s.workspaceId};await save();return e.sessions[name]}
async function input(s,text){return api(`/v1/sessions/${s.id}/events`,{events:[{type:'user.message',data:{content:[{type:'text',text}]}}]})}
async function completed(s,n=1){return wait('Turn completion',()=>events(s.id),es=>es.filter(x=>x.type==='session.turn_completed').length>=n)}
async function stream(s,target=base,after=0){const abort=new AbortController(),frames=[];let cursor=after,reconnects=0;
const run=(async()=>{while(!abort.signal.aborted){try{const r=await fetch(`${target}/v1/sessions/${s.id}/events?replay=1&include=chunks`,{headers:{...headers,accept:'text/event-stream','last-event-id':String(cursor)},signal:abort.signal});assert(r.ok);const reader=r.body.getReader();let buf='';const d=new TextDecoder();while(true){const n=await reader.read();if(n.done)break;buf+=d.decode(n.value,{stream:true});let b;while((b=buf.indexOf('\n\n'))>=0){const raw=buf.slice(0,b);buf=buf.slice(b+2);const type=/^event: (.*)$/m.exec(raw)?.[1];if(!type)continue;const seq=/^id: (\d+)$/m.exec(raw)?.[1];const data=JSON.parse(/^data: (.*)$/m.exec(raw)[1]);frames.push({type,...(seq?{seq:Number(seq)}:{}),data});if(seq)cursor=Number(seq)}}}catch(err){if(abort.signal.aborted)break;}if(!abort.signal.aborted){reconnects++;target=base;await delay(100)}}})();
return{frames,close:async()=>{abort.abort();await run;return reconnects}}}
const failures=[];
try{
if(phase==='init'){
 e.mockAgent=(await api('/v1/agents',{name:e.runId+'-mock',model:'mock-model',runtime:'mock',system:'Verification',sandbox:{enabled:false}})).id;
 e.realAgent=(await api('/v1/agents',{name:e.runId+'-real',model:'openai-codex/gpt-5.6-sol',runtime:'pi-agent',sandbox:{enabled:true},mcpServers:[],skills:[],system:'Execute the exact verification instructions using bash. Do not use web or MCP. Call Agent only when explicitly asked. Children do not delegate. On result notification only acknowledge.'})).id;check('isolated verification tenant created',true,{tenant:e.runId,schema});
}else if(phase==='basic'||phase==='outage'){
 const s=await session(phase);const targets=(process.env.OMA_API_TARGETS||base).split(',');const streams=await Promise.all(targets.map(t=>stream(s,t)));try{check('input accepted', (await input(s,'hello')).accepted);const es=await completed(s);await wait('all streams complete',async()=>streams,ss=>ss.every(x=>x.frames.some(f=>f.type==='session.turn_completed')));
 check('one promoted input and final message',es.filter(x=>x.type==='user.message').length===1&&es.filter(x=>x.type==='agent.message').length===1);
 for(const [i,x]of streams.entries()){const seqs=x.frames.flatMap(f=>f.seq?[f.seq]:[]);check(`stream ${i} ordered unique history`,JSON.stringify(seqs)===JSON.stringify([...new Set(seqs)].sort((a,b)=>a-b)),{count:seqs.length,chunks:x.frames.filter(f=>f.type==='agent.message_chunk').length});if(phase==='basic')check(`stream ${i} live deltas`,x.frames.some(f=>f.type==='agent.message_chunk'));}
 const last=es.at(-1).seq;const resumed=await stream(s,targets.at(-1),last);await delay(300);await resumed.close();check('reconnect does not duplicate history',resumed.frames.every(f=>!f.seq||f.seq>last));
 }finally{for(const x of streams)await x.close()}
}else if(phase==='real-start'){
 const s=await session('real',true);e.marker=`PERSIST_${e.runId}`;await save();await input(s,`Call bash exactly once with command ${JSON.stringify(`printf %s ${e.marker} > /home/user/workspace/split-release.txt; sleep 45; cat /home/user/workspace/split-release.txt`)}. Then reply VERIFIED.`);
 await wait('real tool starts',()=>events(s.id),es=>es.some(x=>x.type==='agent.tool_use'&&x.data?.name==='bash'));check('real model started long Sandbox command',true,{sessionId:s.id});
}else if(phase==='real-finish'){
 const s=e.sessions.real;const targets=(process.env.OMA_API_TARGETS||base).split(',');const streams=await Promise.all(targets.map(t=>stream(s,t)));console.log('STREAMS_READY');try{const es=await completed(s);check('real model and Sandbox succeeded',es.some(x=>x.type==='span.model_request_end')&&es.some(x=>x.type==='agent.tool_result'&&!x.data?.isError&&JSON.stringify(x.data).includes(e.marker))&&!es.some(x=>['session.error','session.turn_aborted'].includes(x.type)));
 await wait('stream completion',async()=>streams,ss=>ss.every(x=>x.frames.some(f=>f.type==='session.turn_completed')));
 for(const[i,x]of streams.entries()){const seqs=x.frames.flatMap(f=>f.seq?[f.seq]:[]);check(`real stream ${i} no duplicate history`,seqs.length===new Set(seqs).size)}
 const access=await api(`/v1/workspaces/${s.workspaceId}/files/split-release.txt`);const r=await fetch(access.url);check('saved Workspace bytes available',r.ok&&await r.text()===e.marker);
 }finally{for(const[i,x]of streams.entries())check(`stream ${i} closed`,true,{reconnects:await x.close()})}
}else if(phase==='interrupt'){
 const s=await session('interrupt',true);await input(s,'Call bash exactly once with command "sleep 45; echo TOO_LATE" then reply DONE.');await wait('active interrupt tool',()=>events(s.id),es=>es.some(x=>x.type==='agent.tool_use'&&x.data?.name==='bash'));
 await input(s,'Reply exactly PRESERVED_TAIL without using tools.');const r=await api(`/v1/sessions/${s.id}/events`,{events:[{type:'user.interrupt',data:{}}]});check('Interrupt durably accepted',r.requested&&!r.interrupted);const es=await completed(s,2);check('one interrupted Turn and preserved tail',es.filter(x=>x.type==='session.turn_aborted').length===1&&es.filter(x=>x.type==='user.message').length===2&&es.some(x=>x.type==='agent.message'&&JSON.stringify(x.data).includes('PRESERVED_TAIL')));const late=await api(`/v1/sessions/${s.id}/events`,{events:[{type:'user.interrupt',data:{}}]});check('late Interrupt does not affect future input',!late.requested);
}else if(phase==='terminate'){
 const s=e.sessions.real;await api(`/v1/sessions/${s.id}`,undefined,'DELETE');await wait('durable cleanup',async()=> (await pool.query('SELECT completed_at FROM session_cleanup WHERE session_id=$1',[s.id])).rows[0],r=>r?.completed_at);const es=await events(s.id);check('termination durable with preserved history',es.some(x=>x.type==='session.status_terminated')&&es.some(x=>x.type==='agent.message'));const r=await pool.query('SELECT sandbox_id FROM delegation_environments WHERE id=$1',[s.id]);check('real Sandbox binding reclaimed',r.rows[0]?.sandbox_id==null);const access=await api(`/v1/workspaces/${s.workspaceId}/files/split-release.txt`);check('Workspace survives termination',await(await fetch(access.url)).text()===e.marker);
}else if(phase==='active-terminate'){
 const s=await session('activeTermination',true);await input(s,'Call bash exactly once with command "sleep 30; echo ACTIVE_TERMINATION" then reply DONE.');await wait('active termination tool',()=>events(s.id),es=>es.some(x=>x.type==='agent.tool_use'&&x.data?.name==='bash'));await api(`/v1/sessions/${s.id}`,undefined,'DELETE');check('active Session terminated immediately',(await api(`/v1/sessions/${s.id}`)).status==='terminated');await wait('active cleanup settled',async()=> (await pool.query('SELECT completed_at FROM session_cleanup WHERE session_id=$1',[s.id])).rows[0],r=>r?.completed_at);check('active termination cleanup completed',true);
}else if(phase.startsWith('delegation-')){
 const background=phase==='delegation-async';const s=e.sessions[phase]??await session(phase,true);const args={prompt:'Call bash exactly once with command "printf DELEGATION_VERIFIED". Then reply CHILD_VERIFIED. Do not delegate.',run_in_background:background};if(!(await events(s.id)).some(x=>x.type==='user.message'))await input(s,`Call Agent exactly once with these exact arguments: ${JSON.stringify(args)}. Do not perform the child task yourself. After it returns reply PARENT_DONE. On a background result notification reply ACKNOWLEDGED only.`);
 const xs=await wait('Child completion',async()=>(await api(`/v1/sessions/${s.id}/delegations`)).data,xs=>xs.some(x=>x.status==='completed'));
 const x=xs.find(x=>x.status==='completed');await completed(s,background?2:1);const es=await events(s.id);check('real Child completed',xs.length===1,{executionId:x.id,background});if(background)check('one consumed background result',es.filter(x=>x.type==='subagent.result_claimed').length===1);const trace=await api(`/v1/sessions/${s.id}/delegations/${x.id}/events?limit=100`);check('Child executed real Sandbox tool',trace.data.some(x=>x.type==='agent.tool_result'&&!x.data?.isError&&JSON.stringify(x.data).includes('DELEGATION_VERIFIED')));
}else if(phase==='loop'){
 const loop=await api(`/v1/agents/${e.mockAgent}/loops`,{name:e.runId,prompt:'loop verification',intervalMinutes:5,enabled:true});e.loopId=loop.id;await save();const before=await api(`/v1/loops/${loop.id}`);const s=await api(`/v1/loops/${loop.id}/run`,{});e.sessions.loop={id:s.id,workspaceId:s.workspaceId};await completed(s);const after=await api(`/v1/loops/${loop.id}`);check('manual Loop execution preserves cadence',before.nextRunAt===after.nextRunAt);await api(`/v1/loops/${loop.id}`,{enabled:false},'POST');
}else if(phase==='loop-disable'){
 await api(`/v1/loops/${e.loopId}`,{enabled:false},'POST');check('verification Loop disabled',true);
}else if(phase==='cleanup'){
 const cleanupErrors=[];
 if(e.loopId){try{await api(`/v1/loops/${e.loopId}`,{enabled:false},'POST')}catch(error){cleanupErrors.push(error)}}
 const ids=new Set(Object.values(e.sessions).map(s=>s.id));
 // Include completed Child Sessions that are not listed in the phase evidence.
 try{for(const row of (await pool.query('SELECT id FROM sessions WHERE tenant_id=$1',[e.runId])).rows)ids.add(row.id)}catch(error){cleanupErrors.push(error)}
 for(const id of ids){try{await api(`/v1/sessions/${id}`,undefined,'DELETE')}catch(error){cleanupErrors.push(error)}}
 if(cleanupErrors.length)throw new AggregateError(cleanupErrors,'Verification cleanup incomplete');
 await wait('all verification cleanup settled',async()=>(await pool.query('SELECT count(*)::int AS count FROM session_cleanup c JOIN sessions s ON s.id=c.session_id WHERE s.tenant_id=$1 AND c.completed_at IS NULL',[e.runId])).rows[0].count,count=>count===0);
 check('verification Sessions terminated',true,{count:ids.size});
}else throw Error('unknown phase');
}catch(error){failures.push(error)}finally{
 for(const finalize of [save,()=>keys.revoke(e.runId,key.apiKey.id),()=>pool.end()]){
  try{await finalize()}catch(error){failures.push(error)}
 }
}
if(failures.length)throw new AggregateError(failures,'Verification phase or finalization failed');
