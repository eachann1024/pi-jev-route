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
const writeEnabled = (ids, provider = 'fixture') => writeFile(join(root, 'settings.json'), JSON.stringify({ defaultProvider: provider, enabledModels: ids }));
const { default: extension, scopedCandidates } = await import('../index.ts');
const low = { provider: 'fixture', id: 'low', name: 'Low', reasoning: true };
const main = { provider: 'fixture', id: 'main', name: 'Main', reasoning: true };
const other = { provider: 'fixture', id: 'other', name: 'Other', reasoning: false };
let calls = 0, kind = 'routine', captured, execFail = false, openedUrls = [];
const response = () => ({ ok: true, json: async () => ({ answers: {
  model: { type: 'choice', choice: 'm0', confidence: .95 },
  kind: { type: 'choice', choice: kind, confidence: .95 },
  effort: { type: 'score', score: .6, confidence: .1 },
} }) });
const fakeFetch = async (_, options) => { calls++; captured = JSON.parse(options.body); return response(); };
globalThis.fetch = fakeFetch;
let ui, welcomeUi, db;
const hooks = new Map(), commands = new Map(), notices = [], entries = [];
const ctx = { mode: 'tui', model: main, scopedModels: [{ model: low }, { model: main }],
  modelRegistry: { getAvailable: () => [low, main, other] },
  sessionManager: { getSessionId: () => 'fixture-session' },
  ui: { notify: message => notices.push(message) }, signal: undefined,
};
const tools = new Map();
const listeners = event => hooks.get(event) ?? [];
const pi = { exec: async (_bin, args) => { openedUrls.push(args.at(-1)); if (execFail) throw new Error('browser unavailable'); return { code: 0 }; }, on: (event, handler) => { const list = listeners(event); list.push(handler); hooks.set(event, list); return () => { const index = list.indexOf(handler); if (index >= 0) list.splice(index, 1); }; }, events: { on(channel, handler) { const list = listeners(channel); list.push(handler); hooks.set(channel, list); return () => { const index = list.indexOf(handler); if (index >= 0) list.splice(index, 1); }; }, emit() {} }, registerCommand: (name, command) => commands.set(name, command), registerTool: tool => tools.set(tool.name, tool),
  registerEntryRenderer: () => {}, appendEntry: (...entry) => entries.push(entry),
  getAllTools: () => [{ name: 'subagent' }], setModel: () => { throw Error('Must never change parent model'); },
  setThinkingLevel: () => { throw Error('Must never change parent thinking'); },
};
extension(pi);
assert.deepEqual([...commands.keys()].sort(), ['jev-supervision', 'pi-jev-route-setting']);
assert.equal(commands.has('pi-jev-route'), false);
assert(tools.has('jev_route_history'));
const emit = async (type, event = {}) => { let result; for (const handler of [...listeners(type)]) { const value = await handler(event, ctx); if (value !== undefined) result = value; } return result; };
const event = (input, id = randomUUID()) => ({ toolName: 'subagent', toolCallId: id, input });

try {
  await writeEnabled(['low', 'main']);
  execFail = true;
  await emit('session_start');
  db = openStore(join(root, 'jev-route.sqlite'));
  assert.match(openedUrls[0], /\/welcome#\w{48}$/);
  const prompt = await emit('before_agent_start', { systemPrompt: 'original' });
  assert.equal(listeners('before_agent_start')[0]({ systemPrompt: 'original' }, ctx)?.systemPrompt.startsWith('original'), true);
  assert(prompt.systemPrompt.startsWith('original')); assert.match(prompt.systemPrompt, /Jev subagent routing: keep the parent session model/);
  assert.match(prompt.systemPrompt, /omit model/); assert.equal(calls, 0);
  assert.deepEqual(scopedCandidates(ctx, db.getSettings()).map(m => m.id), ['fixture/low', 'fixture/main']);
  assert.match(scopedCandidates(ctx, db.getSettings())[0].description, /Lightweight model/i);
  ctx.scopedModels = [];
  assert.deepEqual(scopedCandidates(ctx, db.getSettings()).map(m => m.id), ['fixture/low', 'fixture/main']);
  const assertNativeDispatch = async () => {
    const before = { calls, logs: db.getLogs().length, entries: entries.length };
    assert.equal(await emit('before_agent_start', { systemPrompt: 'original' }), undefined);
    await commands.get('pi-jev-route-setting').handler('status', ctx);
    assert.match(notices.at(-1), /未接管.*原生子代理派发/);
    for (const model of [undefined, 'fixture/main:high', 'outside/model:low']) {
      const input = { agent: 'undiscovered', task: 'Use native dispatch.', ...(model ? { model } : {}) };
      const call = event(input);
      const original = structuredClone(input);
      assert.equal(await emit('tool_call', call), undefined);
      assert.deepEqual(call.input, original);
      assert.equal(await emit('tool_result', { toolName: 'subagent', toolCallId: call.toolCallId, input, content: [], isError: false, details: { asyncId: 'native-run' } }), undefined);
    }
    assert.deepEqual({ calls, logs: db.getLogs().length, entries: entries.length }, before);
  };
  await writeEnabled([]);
  assert.equal(scopedCandidates(ctx, db.getSettings()).length, 0);
  await assertNativeDispatch();
  await writeEnabled(['unavailable/model']);
  await assertNativeDispatch();
  await writeEnabled(['low', 'main']);
  const routingSettings = db.getSettings();
  db.saveSettings({ ...routingSettings, models: { 'fixture/low': { enabled: false, description: '' }, 'fixture/main': { enabled: false, description: '' } } });
  await assertNativeDispatch();
  db.saveSettings(routingSettings);
  await writeEnabled(['fixture/*']);
  assert.deepEqual(scopedCandidates(ctx, db.getSettings()).map(model => model.id), ['fixture/low', 'fixture/main', 'fixture/other']);
  await writeEnabled(['low', 'main']);
  ctx.scopedModels = [{ model: low }, { model: main }];

  const undiscovered = event({ agent: 'worker', task: 'Read a bounded file.' });
  assert.equal((await emit('tool_call', undiscovered)).block, true); assert.equal(calls, 0);
  await emit('tool_result', { toolName: 'subagent', input: { action: 'list', capabilities: true }, details: { agentCapabilities: { agents: [
    { name: 'worker', executable: true, runner: { type: 'pi' } },
    { name: 'external', executable: true, runner: { type: 'external-cli' } },
    { name: 'pinned', executable: true, runner: { type: 'pi' }, model: { value: 'fixture/main' } },
    { name: 'stray', executable: true, runner: { type: 'pi' }, model: { value: 'google/gemini-3.8-flash' } },
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
  await emit('tool_result', { toolName: 'subagent', toolCallId: run.toolCallId, input: run.input, content: [], isError: false, details: { results: [{ model: 'fixture/low:low', thinking: 'low', exitCode: 0 }] } });
  assert.equal(db.getLogs()[0].actualModel, 'fixture/low:low');

  const explicit = event({ agent: 'worker', task: 'Read a file', model: 'fixture/main:high' });
  await emit('tool_call', explicit); assert.equal(calls, 1); assert.equal(explicit.input.model, 'fixture/main:high');
  assert.equal(db.getLogs()[0].outcome, 'explicit');
  const workflow = event({ workflowScript: 'return runs.all([])' });
  await emit('tool_call', workflow); assert.equal(calls, 1); assert.equal(workflow.input.model, undefined); assert.equal(db.getLogs()[0].outcome, 'skipped');
  await emit('tool_call', event({ action: 'status' })); assert.equal(calls, 1);

  const outside = event({ agent: 'worker', task: 'Read a bounded file.', model: 'google/gemini-3.8-flash:low' });
  await emit('tool_call', outside);
  assert.equal(outside.input.model, 'fixture/low:low'); assert.equal(calls, 2);
  assert.equal(db.getLogs()[0].outcome, 'selected');
  assert.match(db.getLogs()[0].reason, /google\/gemini-3\.8-flash/);

  const alias = event({ agent: 'worker', task: 'Read a file', model: 'low:high' });
  await emit('tool_call', alias); assert.equal(calls, 2);
  assert.equal(alias.input.model, 'fixture/low:high'); assert.equal(db.getLogs()[0].outcome, 'explicit');

  const pluginName = event({ agent: 'worker', task: 'Read a bounded file.', model: 'pi-jev-route' });
  await emit('tool_call', pluginName);
  assert.equal(pluginName.input.model, 'fixture/low:low'); assert.equal(calls, 3);

  const stray = event({ agent: 'stray', task: 'Read a bounded file.' });
  await emit('tool_call', stray);
  assert.equal(stray.input.model, 'fixture/low:low'); assert.equal(calls, 4);
  assert.match(db.getLogs()[0].reason, /google\/gemini-3\.8-flash/);

  kind = 'style'; const style = event({ agent: 'worker', task: 'Adjust the settings CSS spacing.' });
  await emit('tool_call', style); assert.equal(style.input.model, 'fixture/main:low');
  await writeEnabled(['low']);
  assert.equal((await emit('tool_call', event({ agent: 'worker', task: 'Adjust the CSS spacing.' }))).block, true);
  await writeEnabled(['low', 'main']); kind = 'routine';

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
  let addCalls = 0; const addedModels = [];
  ui = await startWeb(() => ({ settings: db.getSettings(), models: addedModels, logs: db.getLogs() }),
    (value, previous) => db.saveSettings(value, previous), (id, note, previous) => db.setNote(id, note, previous), 300000, undefined, undefined, id => {
      addCalls++; addedModels.push({ id }); return { tokens: [id], added: true };
    });
  const url = new URL(ui.url), authorization = `Bearer ${url.hash.slice(1)}`, origin = url.origin;
  welcomeUi = await startWeb(() => ({ settings: db.getSettings(), models: [], logs: db.getLogs() }), (value, previous) => db.saveSettings(value, previous), (id, note, previous) => db.setNote(id, note, previous), 300000, '<button>Welcome</button>', () => db.setMetadata('onboarding-complete', 'yes'));
  const welcomeBase = new URL(welcomeUi.url); welcomeBase.pathname = '/welcome';
  assert.match(await (await nativeFetch(welcomeBase)).text(), /Welcome/);
  const welcomeAuth = { authorization: `Bearer ${new URL(welcomeUi.url).hash.slice(1)}` };
  assert.equal((await nativeFetch(new URL('/onboarding/complete', welcomeUi.url), { method: 'POST', headers: welcomeAuth })).status, 200);
  assert.equal(db.getMetadata('onboarding-complete'), 'yes');
  assert.match(await (await nativeFetch(new URL('/welcome', welcomeUi.url))).text(), /Welcome/);
  execFail = false;
  await commands.get('pi-jev-route-setting').handler('', ctx);
  const productionUrl = new URL(openedUrls.at(-1));
  const productionSnapshot = await (await nativeFetch(productionUrl.origin + '/settings', { headers: { authorization: `Bearer ${productionUrl.hash.slice(1)}` } })).json();
  assert.equal(productionSnapshot.defaults.confidenceThreshold, .55);
  assert.equal(productionSnapshot.defaults.timeoutMs, 5000);
  assert.equal(productionSnapshot.defaults.locale, 'en');
  assert(productionSnapshot.defaultModels.en.every(model => model.enabled));
  assert.match(productionSnapshot.defaultModels.zh[0].description, /轻量/);
  const page = await nativeFetch(origin); assert.equal(page.status, 200); assert.match(page.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  assert.equal((await nativeFetch(origin + '/settings')).status, 403);
  assert.equal((await nativeFetch(origin + '/settings', { headers: { authorization, origin: 'https://hostile.invalid' } })).status, 403);
  for (const [path, type] of [['slimselect.js', 'text/javascript'], ['page-select.js', 'text/javascript'], ['slimselect.css', 'text/css']]) {
    const asset = await nativeFetch(origin + '/vendor/' + path);
    assert.equal(asset.status, 200);
    assert(asset.headers.get('content-type').startsWith(type));
    assert.match(asset.headers.get('content-security-policy'), /script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'/);
    assert.match(asset.headers.get('content-security-policy'), /default-src 'none'/);
    const source = await asset.text(); assert(source.length > 100);
    if (path.endsWith('.js')) new Function(source);
    assert.equal((await nativeFetch(origin + '/vendor/' + path, {headers: {Origin: 'https://hostile.invalid'}})).status, 403);
  }
  assert.equal((await nativeFetch(origin + '/vendor/LICENSE')).status, 403);
  assert.equal((await nativeFetch(origin + '/vendor/slimselect.js?other')).status, 403);
  const initial = await nativeFetch(origin + '/settings', { headers: { authorization } });
  const etag = initial.headers.get('etag'), snapshot = await initial.json();
  const put = (body, version = etag) => nativeFetch(origin + '/settings', { method: 'PUT', headers: { authorization, 'Content-Type': 'application/json', 'If-Match': version }, body: JSON.stringify(body) });
  assert.equal((await put({ ...snapshot.settings, timeoutMs: -1 })).status, 400);
  assert.equal((await put({ ...snapshot.settings, timeoutMs: 6000 })).status, 200);
  assert.equal((await put(snapshot.settings)).status, 409);
  const postModel = version => nativeFetch(origin + '/models', { method: 'POST', headers: { authorization, 'Content-Type': 'application/json', ...(version ? { 'If-Match': version } : {}) }, body: JSON.stringify({ id: 'fixture/other' }) });
  assert.equal((await postModel(etag)).status, 409, 'A old settings version cannot add models after B saves');
  assert.equal((await postModel()).status, 409, 'missing version cannot add models');
  assert.equal(addCalls, 0, 'conflict is checked before addModel side effect');
  assert.equal((await put(snapshot.settings)).status, 409, 'failed add does not legitimize A stale draft');
  assert.equal(db.getSettings().timeoutMs, 6000, 'B setting survives A requests');
  const fresh = await nativeFetch(origin + '/settings', { headers: { authorization } });
  assert.equal((await postModel(fresh.headers.get('etag'))).status, 200);
  assert.equal(addCalls, 1); assert.deepEqual(addedModels, [{ id: 'fixture/other' }]);

  const log = db.getLogs()[0];
  const patch = (note, previousNote) => nativeFetch(origin + '/notes/' + log.id, { method: 'PATCH', headers: { authorization, 'Content-Type': 'application/json' }, body: JSON.stringify({ note, previousNote }) });
  assert.equal((await patch('Reviewed the routing decision.', '')).status, 200);
  assert.equal((await patch('Overwrite stale data', '')).status, 409);
  assert.equal(db.getLog(log.id).note, 'Reviewed the routing decision.');
  const html = await readFile(new URL('../web/index.html', import.meta.url), 'utf8');
  const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1]; assert(script);
  assert.doesNotMatch(html, /id="locale"/);
  const { runInNewContext } = await import('node:vm');
  const dictionaries = runInNewContext(script.slice(script.indexOf('const ui ='), script.indexOf("let locale = 'en'")) + ';ui');
  assert.deepEqual(Object.keys(dictionaries.en).sort(), Object.keys(dictionaries.zh).sort());
  for (const locale of ['en', 'zh']) {
    for (const key of ['modes', 'phases', 'sources']) assert.equal(typeof dictionaries[locale][key], 'object', `${locale}.${key}`);
    for (const key of ['reading', 'boot', 'retry', 'connect', 'expired', 'auth']) assert.equal(typeof dictionaries[locale][key], 'string', `${locale}.${key}`);
  }
  new (await import('node:vm')).Script(script);
  for (const [, key] of html.matchAll(/data-i18n="([^"]+)"/g)) {
    assert.equal(typeof dictionaries.en[key], 'string', `Missing English text: ${key}`);
    assert.equal(typeof dictionaries.zh[key], 'string', `Missing Chinese text: ${key}`);
  }
  // Every literal UI lookup must still resolve after markup refactors.
  const staticIds = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map(match => match[1]));
  for (const [, id] of script.matchAll(/\$\('([^']+)'\)/g)) {
    assert(staticIds.has(id), `UI lookup references missing element: ${id}`);
  }
  assert.match(html, /id="style-auto" type="radio" name="style-policy"/);
  assert.match(html, /id="style-main" type="radio" name="style-policy"/);
  assert.match(html, /id="saved-toast"[^>]*role="status"/);
  assert.match(html, /position:fixed;top:var\(--space-4\);right:var\(--space-4\)/);
  assert.match(html, /position:fixed;top:var\(--space-4\);right:var\(--space-4\)/);
  assert.doesNotMatch(html, /id="save"/);
  for (const id of ['lang-en', 'lang-zh']) {
    assert.equal([...html.matchAll(new RegExp(`id="${id}"`, 'g'))].length, 1);
    assert.match(html, new RegExp(`id="${id}" type="button" aria-pressed="(?:true|false)"`));
    assert(html.indexOf(`id="${id}"`) < html.indexOf('</header>'));
  }
  assert.match(html, /role="group" aria-labelledby="language-label"/);
  assert.doesNotMatch(script, /scheduleSave|innerHTML|beforeunload/);
  assert.match(script, /function queueSave/);
  assert.match(script, /try \{[\s\S]*applyChrome\(\)[\s\S]*\} catch/);
  assert.match(html, /id="retry" type="button" hidden/);
  const pageStyle = html.match(/<style>([\s\S]*?)<\/style>/)[1];
  assert(pageStyle.lastIndexOf('@media(max-width:700px)') > pageStyle.lastIndexOf('.timing-grid{display'));
  assert.match(script, /savedToast/);
  assert.match(script, /headers\['If-Match'\]\s*=\s*etag/);
  assert.doesNotMatch(html, /保存备注/);
  assert.match(html, /id="add-model"/);
  assert.match(script, /addCatalogModel/);
  // Execute the actual add handler: conflict must preserve the old version and draft.
  const addSource = script.slice(script.indexOf('    async function addCatalogModel'), script.indexOf("    $('settings-form').addEventListener('submit'"));
  const { createContext, runInContext } = await import('node:vm');
  let postCalls = 0, putCalls = 0, uiStatus;
  const oldSnapshot = { settings: { instructions: 'A draft', models: { 'fixture/main': { description: 'exact draft description' } } } };
  const uiContext = createContext({ token: 'fixture', snapshot: oldSnapshot, etag: 'old-version', busy: false, conflicted: true, AbortSignal,
    lock(value) { uiContext.busy = value; }, status(key) { uiStatus = key; }, catalogOptions() {}, update() {},
    dirty: () => true, queueSave() { if (!uiContext.conflicted) putCalls++; },
    fetch: async (_url, options) => { postCalls++; assert.equal(options.headers['If-Match'], 'old-version'); return { ok: false, status: 409 }; }
  });
  runInContext(addSource, uiContext);
  await runInContext("addCatalogModel('fixture/other')", uiContext);
  assert.equal(postCalls, 0, 'already conflicted UI cannot POST');
  uiContext.conflicted = false;
  await runInContext("addCatalogModel('fixture/other')", uiContext);
  assert.equal(postCalls, 1); assert.equal(putCalls, 0);
  assert.equal(uiContext.snapshot, oldSnapshot); assert.equal(uiContext.etag, 'old-version');
  assert.equal(uiContext.snapshot.settings.instructions, 'A draft');
  assert.equal(uiContext.snapshot.settings.models['fixture/main'].description, 'exact draft description');
  assert.equal(uiContext.conflicted, true); assert.equal(uiStatus, 'conflict');
  const draftSettings = { instructions: 'unsaved draft', models: { 'fixture/main': { enabled: true, description: 'exact original model draft' } } };
  const freshData = { settings: { instructions: 'saved', models: { 'fixture/other': { enabled: true, description: 'new model' } } }, models: [{ id: 'fixture/other' }] };
  for (const raw of ['', '12.345']) {
    let populated; const input = { value: raw };
    uiContext.conflicted = false;
    uiContext.etag = 'fresh-version';
    uiContext.numericFields = [{ id: 'poll-ms' }]; uiContext.$ = () => input;
    uiContext.payload = () => draftSettings;
    uiContext.populate = data => { populated = data; input.value = 'server-default'; };
    uiContext.showSaved = () => {}; uiContext.applyChrome = () => {};
    uiContext.fetch = async (_url, options) => {
      assert.equal(options.headers['If-Match'], 'fresh-version');
      return { ok: true, json: async () => freshData, headers: { get: () => 'next-version' } };
    };
    await runInContext("addCatalogModel('fixture/other')", uiContext);
    assert.equal(input.value, raw, 'same-version add preserves blank or fractional numeric draft');
    assert.equal(populated.settings.instructions, draftSettings.instructions);
    assert.equal(populated.settings.models['fixture/main'].description, 'exact original model draft');
    assert.equal(populated.settings.models['fixture/other'].description, 'new model');
    assert.equal(uiContext.etag, 'next-version'); assert.equal(uiContext.snapshot, freshData);
  }

  assert.match(script.slice(script.indexOf('function queueSave'), script.indexOf('async function persist')), /conflicted/);
  for (const id of ['correction-model', 'correction-thinking', 'allow-takeover']) assert.match(html, new RegExp(`<(?:select|input) id="${id}"[^>]*disabled`));
  assert.match(dictionaries.en.takeoverHint, /original agent and model/);
  assert.match(dictionaries.zh.takeoverHint, /所选配置暂不生效/);
  const controls = new Map();
  const control = id => {
    if (!controls.has(id)) controls.set(id, { value: '', disabled: false, checked: false, classList: { toggle() {} }, replaceChildren() {}, append() {}, setCustomValidity(value) { this.error = value; } });
    return controls.get(id);
  };
  control('correction-model').value = 'disabled/reserved'; control('correction-thinking').value = 'off'; control('allow-takeover').checked = true;
  control('fields').querySelectorAll = () => [...controls.values()];
  const selectLocks = {};
  const select = name => ({ rebuild(fn) { fn(); }, lock(value) { selectLocks[name] = value; } });
  const reservedContext = createContext({ $: control, snapshot: { settings: { supervision: {} }, defaults: {}, defaultModels: {} }, token: 'fixture', savingDraft: false,
    modelInputs: new Map(), modelSelect: select('model'), thinkingSelect: select('thinking'), fallbackSelect: select('fallback'), addSelect: select('add'), filterSelect: select('filter'),
    supervisionFields: [], Option: function() {}, L: () => dictionaries.en, supported: () => true });
  const correctionSource = script.slice(script.indexOf('    function correctionOptions'), script.indexOf('    function validate'));
  const lockSource = script.slice(script.indexOf('    function setDisabled'), script.indexOf('    function update()'));
  runInContext(correctionSource + lockSource, reservedContext);
  runInContext('correctionOptions(); lock(true); lock(false);', reservedContext);
  assert.equal(selectLocks.model, true); assert.equal(selectLocks.thinking, true);
  for (const id of ['correction-model', 'correction-thinking', 'allow-takeover']) assert.equal(control(id).disabled, true, 'reserved controls stay disabled after unlock');
  assert.equal(control('correction-model').value, 'disabled/reserved'); assert.equal(control('correction-thinking').value, 'off'); assert.equal(control('allow-takeover').checked, true);
  assert.equal(control('correction-model').error, '', 'reserved unavailable model does not block saving');
  assert.equal(control('correction-model-hint').hidden, false, 'actual contract is always visible');
  const payloadSource = script.slice(script.indexOf('    function payload()'), script.indexOf('    // Raw input'));
  reservedContext.numericFields = [{ id: 'confidence' }, { id: 'timeout' }]; reservedContext.readNumber = () => 0; reservedContext.modelBase = {}; reservedContext.locale = 'en';
  runInContext(payloadSource, reservedContext);
  const reservedPayload = runInContext('payload().supervision', reservedContext);
  assert.equal(reservedPayload.correctionModel, 'disabled/reserved'); assert.equal(reservedPayload.correctionThinking, 'off'); assert.equal(reservedPayload.allowMainTakeover, true);


  assert.doesNotMatch(html, /id="model-search"/);
  const jsPath = join(root, 'ui.js'); await writeFile(jsPath, script);
  const checked = spawnSync(process.execPath, ['--check', jsPath], { encoding: 'utf8' }); assert.equal(checked.status, 0, checked.stderr);
  console.log('PASS: real extension hooks, unchanged parent, scopes, explicit pins, lifecycle, private HTTP, conflicts and HTML syntax');
} finally {
  ui?.close(); welcomeUi?.close(); db?.close(); await emit('session_shutdown');
  globalThis.fetch = nativeFetch;
  if (oldDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = oldDir;
  if (oldKey === undefined) delete process.env.TYPESAFE_API_KEY; else process.env.TYPESAFE_API_KEY = oldKey;
  await rm(root, { recursive: true, force: true });
}
