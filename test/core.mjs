import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { DEFAULTS, openStore, parseSettings } from '../lib/store.ts';
import { defaultModelDescription, LIGHT_MODEL_DESCRIPTION, STRONG_MODEL_DESCRIPTION } from '../lib/describe.ts';
import { loadPiEnabledModels, resolveEnabledIds, resolveListedModel, splitModelRef } from '../lib/enabled.ts';
import { routeTask } from '../lib/router.ts';

const dir = mkdtempSync(join(tmpdir(), 'pi-jev-route-test-'));
const savedFetch = globalThis.fetch, savedKey = process.env.TYPESAFE_API_KEY, savedHome = process.env.HOME;
process.env.TYPESAFE_API_KEY = 'fake-test-key';
process.env.HOME = dir;
let store;
try {
  assert.deepEqual(parseSettings({}), DEFAULTS);
  assert.equal(defaultModelDescription('google/gemini-2.5-flash', 'Flash'), LIGHT_MODEL_DESCRIPTION);
  assert.equal(defaultModelDescription('9router/low', 'low'), LIGHT_MODEL_DESCRIPTION);
  assert.equal(defaultModelDescription('cursor/grok-4.6', 'Cursor Grok 4.6 Medium'), STRONG_MODEL_DESCRIPTION);
  for (const [id, name] of [['openai/gpt-6', 'GPT 6'], ['x/sol', 'Sol'], ['moonshot/kimi-k3', 'Kimi K3'], ['z/glm-5.1', 'GLM 5.1'], ['anthropic/opus-4', 'Opus'], ['anthropic/sonnet-4', 'Sonnet'], ['x/fable', 'Fable']]) {
    assert.equal(defaultModelDescription(id, name), STRONG_MODEL_DESCRIPTION, id);
  }
  assert.equal(defaultModelDescription('openai/gpt-4o', 'GPT-4o'), '');
  writeFileSync(join(dir, 'settings.json'), JSON.stringify({ defaultProvider: '9router', enabledModels: ['low', 'high', 'loop', 'missing'] }));
  assert.deepEqual(loadPiEnabledModels(dir), { tokens: ['low', 'high', 'loop', 'missing'], defaultProvider: '9router' });
  const catalog = new Map([
    ['9router/low', { provider: '9router', id: 'low', name: 'low', reasoning: true }],
    ['9router/high', { provider: '9router', id: 'high', name: 'high', reasoning: true }],
    ['9router/loop', { provider: '9router', id: 'loop', name: 'loop', reasoning: true }],
    ['fixture/other', { provider: 'fixture', id: 'other', name: 'Other', reasoning: false }],
  ]);
  assert.deepEqual(resolveEnabledIds(['low', 'high', 'loop', 'missing'], catalog, '9router'), ['9router/low', '9router/high', '9router/loop', '9router/missing']);
  assert.deepEqual(resolveEnabledIds(['9router/low'], catalog, '9router'), ['9router/low']);
  assert.deepEqual(resolveEnabledIds(['low', 'high'], new Map(), '9router'), ['9router/low', '9router/high']);
  assert.deepEqual(resolveEnabledIds([], catalog, '9router'), []);
  assert.deepEqual(loadPiEnabledModels(join(dir, 'missing-agent')), { tokens: [], defaultProvider: '' });
  const listed = ['9router/low', '9router/high', '9router/loop'];
  assert.deepEqual(splitModelRef('google/gemini-3.8-flash:low'), { token: 'google/gemini-3.8-flash', thinking: 'low' });
  assert.deepEqual(splitModelRef('9router/low'), { token: '9router/low' });
  assert.equal(resolveListedModel('9router/low:high', listed, '9router'), '9router/low');
  assert.equal(resolveListedModel('low', listed, '9router'), '9router/low');
  assert.equal(resolveListedModel('loop:low', listed, '9router'), '9router/loop');
  assert.equal(resolveListedModel('google/gemini-3.8-flash:low', listed, '9router'), undefined);
  assert.equal(resolveListedModel('pi-jev-route', listed, '9router'), undefined);
  assert.equal(resolveListedModel('high', listed, ''), '9router/high');
  assert.equal(resolveListedModel('high', ['a/high', 'b/high'], ''), undefined);
  for (const invalid of [null, [], { extra: true }, { enabled: 1 }, { models: [] }, { timeoutMs: 999 }, { timeoutMs: 30001 }, { timeoutMs: 1000.5 }, { confidenceThreshold: NaN }, { confidenceThreshold: 1.1 }, { locale: 'fr' }, { instructions: 'x'.repeat(2001) }, { fallbackModel: 'bare' }, { fallbackModel: 'p/bad id' }, { models: { 'p/m': { enabled: true, description: 'x', extra: 1 } } }, { models: { 'p/m': { enabled: true, description: 'x'.repeat(1001) } } }, { models: Object.fromEntries(Array.from({ length: 201 }, (_, i) => [`p/m${i}`, { enabled: true, description: '' }])) }]) assert.throws(() => parseSettings(invalid), TypeError);
  const path = join(dir, 'private', 'route.sqlite');
  store = openStore(path);
  assert.equal(statSync(join(dir, 'private')).mode & 0o777, 0o700);
  assert.equal(statSync(path).mode & 0o777, 0o600);
  const initial = JSON.stringify(store.getSettings());
  store.saveSettings({ ...DEFAULTS, instructions: '只用允许范围' }, initial);
  assert.throws(() => store.saveSettings(DEFAULTS, initial), /conflict/);
  const row = { id: 'test-1', at: new Date().toISOString(), sessionId: 's', toolCallId: 't', agent: 'worker', taskHash: 'sha256', outcome: 'selected', requestedModel: 'p/low:low', reason: '测试', note: '' };
  store.addLog(row);
  assert.throws(() => store.addLog(row));
  store.setNote(row.id, '保留备注', '');
  assert.throws(() => store.setNote(row.id, '旧页面覆盖', ''), /conflict/);
  store.updateLog(row.id, { actualModel: 'p/low', actualThinking: 'low', actualStatus: 'completed' });
  assert.equal(store.getLog(row.id).note, '保留备注');
  assert.throws(() => store.setNote('missing', 'x'));
  assert.throws(() => store.setNote(row.id, 'x'.repeat(1001)), TypeError);
  assert.throws(() => store.updateLog(row.id, { note: '不得覆盖' }));
  assert.throws(() => store.getLogs(0));
  store.close(); store = openStore(path);
  assert.equal(store.getSettings().instructions, '只用允许范围');
  assert.equal(store.getLogs()[0].actualThinking, 'low');
  store.close(); store = undefined;
  const corrupt = join(dir, 'private', 'broken.sqlite');
  writeFileSync(corrupt, 'not a database');
  assert.throws(() => openStore(corrupt));
  assert.equal(readFileSync(corrupt, 'utf8'), 'not a database');
  const db = new DatabaseSync(path);
  db.prepare('UPDATE settings SET json=? WHERE id=1').run('{"enabled":"bad"}'); db.close();
  assert.throws(() => openStore(path), error => error instanceof Error && !(error instanceof TypeError));
  const check = new DatabaseSync(path);
  assert.equal(check.prepare('SELECT json FROM settings').get().json, '{"enabled":"bad"}'); check.close();

  const candidates = [
    { id: 'p/high', name: 'Strong', reasoning: true, description: '复杂任务', enabled: true },
    { id: 'p/low', name: 'Fast', reasoning: true, description: '日常任务', enabled: true },
    { id: 'q/plain', name: 'Plain', reasoning: false, description: '', enabled: true },
  ];
  const main = candidates[0], settings = parseSettings({});
  let requests = 0, payload;
  function mock({ choice = 'm1', kind = 'routine', score = 1, confidence = .95, status = 200, modelType = 'choice', kindType = 'choice', effortType = 'score', effortConfidence } = {}) {
    globalThis.fetch = async (url, init) => {
      requests++; payload = JSON.parse(init.body);
      assert.equal(url, 'https://api.typesafe.ai/v1/systemone');
      assert.equal(init.redirect, 'error');
      return new Response(JSON.stringify({ answers: { model: { type: modelType, choice, confidence }, kind: { type: kindType, choice: kind, confidence }, effort: { type: effortType, score, confidence: effortConfidence } } }), { status });
    };
  }
  const run = (task = '检查编译错误', opts = settings, models = candidates, current = main, signal = new AbortController().signal) => routeTask(task, 'worker', models, opts, current, signal);
  mock(); let decision = await run();
  assert.equal(decision.model, 'p/low'); assert.equal(decision.thinking, 'low'); assert.equal(decision.outcome, 'selected');
  assert.deepEqual(Object.keys(JSON.parse(payload.state)), ['task', 'agent', 'rules']);
  assert.deepEqual(Object.keys(payload.questions.model.criteria), ['m0', 'm1', 'm2']);
  mock({ choice: 'm0', kind: 'complex', score: 1.5 }); assert.equal((await run()).thinking, 'high');
  mock({ choice: 'm2', score: 2 }); assert.equal((await run()).thinking, 'off');
  mock({ choice: 'p/injected' }); assert.equal((await run()).outcome, 'fallback');
  mock({ choice: '__proto__' }); assert.equal((await run()).outcome, 'fallback');
  mock({ score: 3 }); assert.equal((await run()).outcome, 'fallback');
  globalThis.fetch = async () => new Response(JSON.stringify({ answers: { model: { choice: 'm1', confidence: .95 }, kind: { type: 'choice', choice: 'routine', confidence: .95 }, effort: { type: 'score', score: 1 } } }));
  assert.equal((await run()).outcome, 'fallback');
  await assert.rejects(() => run(12), TypeError);
  await assert.rejects(() => run('x', settings, [{ ...main, enabled: 'true' }]), TypeError);
  mock({ confidence: 2 }); assert.equal((await run()).outcome, 'fallback');
  mock({ confidence: '0.9' }); assert.equal((await run()).outcome, 'fallback');
  mock({ confidence: .1 }); decision = await run(); assert.equal(decision.outcome, 'fallback'); assert.equal(decision.confidence, .1);
  mock({ score: .79, effortConfidence: 0 }); decision = await run(); assert.equal(decision.outcome, 'selected'); assert.equal(decision.confidence, .95);
  mock({ effortConfidence: 2 }); assert.equal((await run()).outcome, 'fallback');
  for (const override of [{ modelType: 'score' }, { kindType: null }, { effortType: 'choice' }]) { mock(override); assert.equal((await run()).outcome, 'fallback'); }
  mock({ kind: 'human', confidence: .1 }); assert.equal((await run()).outcome, 'blocked');
  mock({ kind: 'style', score: 2 }); decision = await run(); assert.equal(decision.model, main.id); assert.equal(decision.thinking, 'low');
  assert.equal((await run('调样式', settings, candidates.slice(1))).outcome, 'blocked');
  assert.equal((await run('调样式', { ...settings, models: { [main.id]: { enabled: false, description: '' } } })).outcome, 'blocked');
  assert.equal((await run('调样式', { ...settings, styleUseMain: false })).model, 'p/low');
  mock({ status: 503 }); assert.equal((await run()).model, 'p/low');
  assert.equal((await run('x', { ...settings, fallbackModel: 'q/plain' })).thinking, 'off');
  assert.equal((await run('x', { ...settings, fallbackModel: 'other/not-allowed' }, [main])).model, main.id);
  assert.equal((await run('x', settings, [candidates[2]], undefined)).outcome, 'blocked');
  mock(); const before = requests;
  for (const task of ['Password: test-password', 'api_key=abc123', 'Bearer abc.def.xyz', '密钥：不要外发', 'https://name:password@example.com', '-----BEGIN OPENSSH PRIVATE KEY-----', 'sk-abcdefghijk', 'token=fake-token', 'npm_fakeabcdefgh', ...['p', 'o', 'u', 's', 'r'].map(kind => `gh${kind}_fakeabcdefgh`), JSON.stringify({ token: 'fake-only' }), JSON.stringify({ '密钥': 'fake-only' }), JSON.stringify(JSON.stringify({ api_key: 'fake-only' })), '汉'.repeat(6000)]) assert.equal((await run(task)).outcome, 'fallback');
  assert.equal(requests, before);
  assert.equal((await run('x', { ...settings, instructions: 'password: hidden' })).outcome, 'fallback');
  assert.equal((await run('x', settings, [{ ...main, description: 'x'.repeat(49000) }, candidates[1]])).outcome, 'fallback');
  assert.equal(requests, before);
  delete process.env.TYPESAFE_API_KEY;
  assert.equal((await run()).outcome, 'fallback'); assert.equal(requests, before);
  process.env.TYPESAFE_API_KEY = 'fake-test-key';
  const preAborted = new AbortController(); preAborted.abort(); await assert.rejects(() => run('x', settings, candidates, main, preAborted.signal));
  globalThis.fetch = () => new Promise(() => {});
  const pendingAbort = new AbortController();
  const pending = run('x', settings, candidates, main, pendingAbort.signal); pendingAbort.abort(); await assert.rejects(pending);
  const timed = await run('x', { ...settings, timeoutMs: 1000 }); assert.equal(timed.outcome, 'fallback'); assert.match(timed.reason, /超时/);
  mock(); const english = await run('x', { ...settings, locale: 'en' }); assert.match(english.reason, /default low thinking/);
  assert.equal(defaultModelDescription('9router/low', 'low', 'en'), 'Lightweight model. Use for bounded, reversible reads, cleanup, small edits, and routine implementation; prefer this for most subtasks.');
  console.log('core: settings, SQLite persistence/CAS, routing, scope, redaction, abort and timeout passed');
} finally {
  store?.close(); globalThis.fetch = savedFetch;
  if (savedKey === undefined) delete process.env.TYPESAFE_API_KEY; else process.env.TYPESAFE_API_KEY = savedKey;
  if (savedHome === undefined) delete process.env.HOME; else process.env.HOME = savedHome;
  rmSync(dir, { recursive: true, force: true });
}
