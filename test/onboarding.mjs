import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openStore, DEFAULTS } from '../lib/store.ts';
import extension from '../index.ts';
const root = await mkdtemp(join(tmpdir(), 'jev-first-run-'));
const keys=['PI_CODING_AGENT_DIR','TYPESAFE_API_KEY','SSH_CONNECTION','SSH_CLIENT','SSH_TTY','CI','GITHUB_ACTIONS','PI_SUBAGENT'];
const prior=Object.fromEntries(keys.map(k=>[k,process.env[k]]));
for(const k of keys) delete process.env[k];
process.env.TYPESAFE_API_KEY='test-only';
let active;
function fixture(dir, mode='tui', fail=false) {
  process.env.PI_CODING_AGENT_DIR=join(root,dir);
  const hooks=new Map(),commands=new Map(),urls=[],notices=[];
  const ctx={mode,model:undefined,modelRegistry:{getAvailable:()=>[]},sessionManager:{getSessionId:()=>dir},ui:{notify:m=>notices.push(m)}};
  extension({on:(n,f)=>hooks.set(n,f),registerCommand:(n,c)=>commands.set(n,c),registerTool:()=>{},registerEntryRenderer:()=>{},getAllTools:()=>[{name:'subagent'}],exec:async(_cmd,args)=>{urls.push(args.at(-1));if(fail)throw Error('unavailable');return {code:0}}});
  const f={ctx,urls,notices,start:()=>hooks.get('session_start')({},ctx),welcome:()=>commands.get('pi-jev-route-setting').handler('welcome',ctx),shutdown:()=>hooks.get('session_shutdown')(),prompt:()=>hooks.get('before_agent_start')({systemPrompt:'original'},ctx)};
  active=f;return f;
}
try {
  const f=fixture('fresh');await f.start();assert.equal(f.urls.length,1);
  const url=new URL(f.urls[0]);assert.equal(url.pathname,'/welcome');assert.match(url.hash,/^#[a-f0-9]{48}$/);
  assert.match(await(await fetch(url)).text(),/<html lang="en">/);
  const headers={authorization:`Bearer ${url.hash.slice(1)}`};
  assert.equal((await fetch(new URL('/onboarding/complete',url),{method:'POST'})).status,403);
  assert.equal((await fetch(new URL('/onboarding/complete',url),{method:'POST',headers:{...headers,origin:'https://hostile.invalid'}})).status,403);
  await f.start();assert.equal(f.urls.length,1,'reload must not repeat within the presentation lease');
  await f.welcome();const reopen=new URL(f.urls.at(-1));
  assert.equal((await fetch(new URL('/onboarding/complete',reopen),{method:'POST',headers:{authorization:`Bearer ${reopen.hash.slice(1)}`}})).status,200);
  await f.start();assert.equal(f.urls.length,2,'completed guide must not open automatically');
  await f.welcome();assert.equal(f.urls.length,3);assert.equal((await fetch(f.urls.at(-1))).status,200,'manual reopen after completion');
  f.shutdown();
  const rpc=fixture('rpc','rpc');await rpc.start();await rpc.welcome();assert.equal(rpc.urls.length,0);rpc.shutdown();
  for(const key of ['SSH_CONNECTION','SSH_TTY','CI','PI_SUBAGENT']) {process.env[key]='1';const remote=fixture(key);await remote.start();await remote.welcome();assert.equal(remote.urls.length,0,key);remote.shutdown();delete process.env[key];}
  const failed=fixture('browser-failure','tui',true);await failed.start();assert(failed.prompt().systemPrompt.startsWith('original'));await failed.start();assert.equal(failed.urls.length,2,'failed browser launch can retry');failed.shutdown();
  const path=join(root,'legacy.sqlite');const legacy=new DatabaseSync(path);legacy.exec('CREATE TABLE settings(id INTEGER PRIMARY KEY,json TEXT NOT NULL)');legacy.prepare('INSERT INTO settings VALUES(1,?)').run(JSON.stringify({...DEFAULTS,locale:'zh'}));legacy.close();const db=openStore(path);assert.equal(db.getSettings().locale,'zh');assert.equal(db.claimOnboarding('test'),false);db.close();
  const freshPath=join(root,'claims.sqlite');const first=openStore(freshPath),second=openStore(freshPath);assert.equal(first.claimOnboarding('a',1000),true);assert.equal(second.claimOnboarding('b',1001),false);second.releaseOnboarding('b');assert.equal(second.claimOnboarding('b',1002),false);first.releaseOnboarding('a');assert.equal(second.claimOnboarding('b',1003),true);assert.equal(first.claimOnboarding('c',301004),true);first.saveSettings({...DEFAULTS,locale:'zh'});first.close();second.close();const saved=openStore(freshPath);assert.equal(saved.getMetadata('onboarding-complete'),undefined,'new settings must not be mistaken for legacy migration');saved.close();
  const racing=fixture('transition');const beginning=racing.start();racing.shutdown();await beginning;assert.equal(racing.urls.length,0,'transition cancels pending browser launch');
  console.log('onboarding: first launch, token, completion, reopen, lease/CAS, legacy language, remote/headless, browser failure and shutdown passed');
} finally {active?.shutdown();for(const k of keys)if(prior[k]===undefined)delete process.env[k];else process.env[k]=prior[k];await rm(root,{recursive:true,force:true});}
