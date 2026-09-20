import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { openStore } from '../lib/store.ts';
import { startWeb } from '../lib/web.ts';

const root = await mkdtemp(join(tmpdir(), 'pi-jev-route-check-'));
const oldDir = process.env.PI_CODING_AGENT_DIR, oldKey = process.env.TYPESAFE_API_KEY, nativeFetch = globalThis.fetch;
process.env.TYPESAFE_API_KEY = 'test-only-credential';
process.env.PI_CODING_AGENT_DIR = root;
const { default: extension, scopedCandidates } = await import('../index.ts');
const low = { provider: 'fixture', id: 'low', name: 'Low', reasoning: true };
const main = { provider: 'fixture', id: 'main', name: 'Main', reasoning: true };
const other = { provider: 'fixture', id: 'other', name: 'Other', reasoning: false };
let calls = 0, kind = 'routine', captured;
const response = () => ({ ok: true, json: async () => ({ answers: {
  model: { type: 'choice', choice: 'm0', confidence: .95 },
  kind: { type: 'choice', choice: kind, confidence: .95 },
  effort: { type: 'score', score: .6, confidence: .1 },
} }) });
const fakeFetch = async (_, options) => { calls++; captured = JSON.parse(options.body); return response(); };
globalThis.fetch = fakeFetch;
let ui, db;
const hooks = new Map(), commands = new Map(), notices = [], entries = [];
const ctx = { mode: 'tui', model: main, scopedModels: [{ model: low }, { model: main }],
  modelRegistry: { getAvailable: () => [low, main, other] },
  sessionManager: { getSessionId: () => 'fixture-session' },
  ui: { notify: message => notices.push(message) }, signal: undefined,
};
const pi = { on: (event, handler) => hooks.set(event, handler), registerCommand: (name, command) => commands.set(name, command),
  registerEntryRenderer: () => {}, appendEntry: (...entry) => entries.push(entry),
  getAllTools: () => [{ name: 'subagent' }], setModel: () => { throw Error('Must never change parent model'); },
  setThinkingLevel: () => { throw Error('Must never change parent thinking'); },
};
extension(pi);
const emit = (type, event = {}) => hooks.get(type)?.(event, ctx);
const event = (input, id = randomUUID()) => ({ toolName: 'subagent', toolCallId: id, input });

try {
  await emit('session_start');
  db = openStore(join(root, 'jev-route.sqlite'));
  const prompt = await emit('before_agent_start', { systemPrompt: 'original' });
  assert(prompt.systemPrompt.startsWith('original')); assert.match(prompt.systemPrompt, /主会话负责需求对齐/); assert.equal(calls, 0);
  assert.deepEqual(scopedCandidates(ctx, db.getSettings()).map(m => m.id), ['fixture/low', 'fixture/main']);
  assert.match(scopedCandidates(ctx, db.getSettings())[0].description, /轻量模型/);
  ctx.scopedModels = [];
  assert.equal(scopedCandidates(ctx, db.getSettings()).length, 3);
  ctx.scopedModels = [{ model: low }, { model: main }];

  const undiscovered = event({ agent: 'worker', task: 'Read a bounded file.' });
  assert.equal((await emit('tool_call', undiscovered)).block, true); assert.equal(calls, 0);
  await emit('tool_result', { toolName: 'subagent', input: { action: 'list', capabilities: true }, details: { agentCapabilities: { agents: [
    { name: 'worker', executable: true, runner: { type: 'pi' } },
    { name: 'external', executable: true, runner: { type: 'external-cli' } },
    { name: 'pinned', executable: true, runner: { type: 'pi' }, model: { value: 'fixture/main' } },
  ] } } });
  for (const agent of ['external', 'pinned']) {
    const input = event({ agent, task: 'Retain configured execution.' });
    await emit('tool_call', input); assert.equal(input.input.model, undefined); assert.equal(calls, 0);
  }

  const run = event({ agent: 'worker', task: 'Implement a bounded formatter without changing permissions.', async: true, toolBudget: { hard: 3 } });
  assert.equal(await emit('tool_call', run), undefined);
  assert.equal(run.input.model, 'fixture/low:low'); assert.equal(calls, 1);
  assert.equal(entries[0][0], 'pi-jev-route');
  assert.deepEqual(run.input.toolBudget, { hard: 3 }); assert.equal(ctx.model, main);
  assert(!JSON.stringify(db.getLogs()).includes(run.input.task));
  assert(!JSON.stringify(db.getLogs()).includes('test-only-credential'));
  assert.match(JSON.stringify(captured), /bounded formatter/);
  await emit('tool_result', { toolCallId: run.toolCallId, isError: false, details: { results: [{ model: 'fixture/low:low', thinking: 'low', exitCode: 0 }] } });
  assert.equal(db.getLogs()[0].actualModel, 'fixture/low:low');

  const explicit = event({ agent: 'worker', task: 'Read a file', model: 'fixture/main:high' });
  await emit('tool_call', explicit); assert.equal(calls, 1); assert.equal(explicit.input.model, 'fixture/main:high');
  assert.equal(db.getLogs()[0].outcome, 'explicit');
  const workflow = event({ workflowScript: 'return runs.all([])' });
  await emit('tool_call', workflow); assert.equal(calls, 1); assert.equal(workflow.input.model, undefined); assert.equal(db.getLogs()[0].outcome, 'skipped');
  await emit('tool_call', event({ action: 'status' })); assert.equal(calls, 1);

  kind = 'style'; const style = event({ agent: 'worker', task: 'Adjust the settings CSS spacing.' });
  await emit('tool_call', style); assert.equal(style.input.model, 'fixture/main:low');
  ctx.scopedModels = [{ model: low }];
  assert.equal((await emit('tool_call', event({ agent: 'worker', task: 'Adjust the CSS spacing.' }))).block, true);
  ctx.scopedModels = [{ model: low }, { model: main }]; kind = 'routine';

  let release, started;
  const began = new Promise(resolve => { started = resolve; });
  globalThis.fetch = () => new Promise(resolve => { release = () => resolve(response()); started(); });
  const cancelled = event({ agent: 'worker', task: 'A cancellable task.' });
  const waiting = emit('tool_call', cancelled); await began; await emit('session_before_switch'); release();
  assert.equal((await waiting).block, true); assert.equal(cancelled.input.model, undefined);
  globalThis.fetch = fakeFetch;

  const previous = JSON.stringify(db.getSettings());
  db.saveSettings({ ...db.getSettings(), enabled: false }, previous);
  const disabled = event({ agent: 'worker', task: 'No routing while disabled.' });
  await emit('tool_call', disabled); assert.equal(disabled.input.model, undefined);
  db.saveSettings({ ...db.getSettings(), enabled: true });

  globalThis.fetch = nativeFetch;
  ui = await startWeb(() => ({ settings: db.getSettings(), models: [], logs: db.getLogs() }),
    (value, previous) => db.saveSettings(value, previous), (id, note, previous) => db.setNote(id, note, previous));
  const url = new URL(ui.url), authorization = `Bearer ${url.hash.slice(1)}`, origin = url.origin;
  const page = await nativeFetch(origin); assert.equal(page.status, 200); assert.match(page.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  assert.equal((await nativeFetch(origin + '/settings')).status, 403);
  assert.equal((await nativeFetch(origin + '/settings', { headers: { authorization, origin: 'https://hostile.invalid' } })).status, 403);
  const initial = await nativeFetch(origin + '/settings', { headers: { authorization } });
  const etag = initial.headers.get('etag'), snapshot = await initial.json();
  const put = (body, version = etag) => nativeFetch(origin + '/settings', { method: 'PUT', headers: { authorization, 'Content-Type': 'application/json', 'If-Match': version }, body: JSON.stringify(body) });
  assert.equal((await put({ ...snapshot.settings, timeoutMs: -1 })).status, 400);
  assert.equal((await put({ ...snapshot.settings, timeoutMs: 6000 })).status, 200);
  assert.equal((await put(snapshot.settings)).status, 409);
  const log = db.getLogs()[0];
  const patch = (note, previousNote) => nativeFetch(origin + '/notes/' + log.id, { method: 'PATCH', headers: { authorization, 'Content-Type': 'application/json' }, body: JSON.stringify({ note, previousNote }) });
  assert.equal((await patch('Reviewed the routing decision.', '')).status, 200);
  assert.equal((await patch('Overwrite stale data', '')).status, 409);
  assert.equal(db.getLog(log.id).note, 'Reviewed the routing decision.');
  const html = await readFile(new URL('../web/index.html', import.meta.url), 'utf8');
  const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1]; assert(script);
  assert.match(html, /id="model-search"/);
  assert.match(html, /设置（默认收起/);
  assert.match(html, /写何时选用/);
  const jsPath = join(root, 'ui.js'); await writeFile(jsPath, script);
  const checked = spawnSync(process.execPath, ['--check', jsPath], { encoding: 'utf8' }); assert.equal(checked.status, 0, checked.stderr);
  console.log('PASS: real extension hooks, unchanged parent, scopes, explicit pins, lifecycle, private HTTP, conflicts and HTML syntax');
} finally {
  ui?.close(); db?.close(); await emit('session_shutdown');
  globalThis.fetch = nativeFetch;
  if (oldDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = oldDir;
  if (oldKey === undefined) delete process.env.TYPESAFE_API_KEY; else process.env.TYPESAFE_API_KEY = oldKey;
  await rm(root, { recursive: true, force: true });
}
