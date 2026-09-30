import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { openStore } from '../lib/store.ts';

const root = await mkdtemp(join(tmpdir(), 'jev-observability-'));
const oldDir = process.env.PI_CODING_AGENT_DIR;
const oldKey = process.env.TYPESAFE_API_KEY;
const oldFetch = globalThis.fetch;
process.env.PI_CODING_AGENT_DIR = root;
process.env.TYPESAFE_API_KEY = 'observability-test-key';
const handlers = new Map();
const tools = new Map();
const notices = [];
const model = { provider: 'fixture', id: 'low', name: 'Low', reasoning: true };
const ctx = {
  mode: 'tui', model,
  modelRegistry: { getAvailable: () => [model] },
  sessionManager: { getSessionId: () => 'current-session' },
  ui: { notify: message => notices.push(message), setStatus() {} },
};
const pi = {
  on: (name, handler) => { const list = handlers.get(name) || []; list.push(handler); handlers.set(name, list); },
  registerTool: tool => tools.set(tool.name, tool),
  registerCommand() {}, registerEntryRenderer() {}, appendEntry() {},
  getAllTools: () => [{ name: 'subagent' }],
};
const { default: extension } = await import('../index.ts');
extension(pi);
const emit = async (name, event = {}) => { let result; for (const handler of [...(handlers.get(name) || [])]) { const value = await handler(event, ctx); if (value !== undefined) result = value; } return result; };
const toolEvent = (input = {}, toolCallId = randomUUID()) => ({ toolName: 'subagent', toolCallId, input });
const resultEvent = (toolCallId, fields = {}) => ({ toolName: 'subagent', toolCallId, input: {}, content: [{ type: 'text', text: 'original result' }], details: { results: [{ model: 'fixture/low', ...fields }] }, isError: false, usage: { input: 9, output: 2 } });
let store;
try {
  await writeFile(join(root, 'settings.json'), JSON.stringify({ defaultProvider: 'fixture', enabledModels: ['low'] }));
  globalThis.fetch = async () => new Response(JSON.stringify({ answers: {
    model: { type: 'choice', choice: 'm0', confidence: .99 },
    kind: { type: 'choice', choice: 'routine', confidence: .99 },
    effort: { type: 'score', score: 1, confidence: .1 },
  } }), { status: 200 });
  const originalMode = ctx.mode;
  ctx.mode = 'print';
  await emit('session_start', {});
  ctx.mode = originalMode;
  store = openStore(join(root, 'jev-route.sqlite'));

  const legacy = { id: 'legacy-record', at: new Date().toISOString(), sessionId: 'current-session', toolCallId: 'legacy-call', agent: 'worker', taskHash: 'hash', outcome: 'selected', requestedModel: 'fixture/low:low', reason: 'legacy', note: '' };
  store.addLog(legacy);
  assert.deepEqual(store.getLog(legacy.id), legacy, '旧格式记录继续可读');

  for (let index = 0; index < 130; index++) {
    store.addLog({ ...legacy, id: `other-session-${index}`, sessionId: 'other-session' });
  }
  const own = { ...legacy, id: 'current-record', toolCallId: 'current-call' };
  store.addLog(own);
  assert.deepEqual(store.getLogsBySession('current-session').map(log => log.id), [own.id, legacy.id]);
  assert.equal(store.findLogById(own.id, 'other-session'), undefined);
  assert.equal(store.findLogById(own.id, 'current-session').id, own.id);
  assert.deepEqual(store.findLog(own.id), { log: own, ambiguous: false });
  assert.equal(store.getLogs(200).length, 132);

  const historyTool = tools.get('jev_route_history');
  const ctxForSession = { ...ctx, sessionManager: { getSessionId: () => 'current-session' } };
  const listing = await historyTool.execute('list', {}, undefined, () => {}, ctxForSession);
  assert.deepEqual(JSON.parse(listing.content[0].text).records.map(log => log.id), [own.id, legacy.id]);
  const hidden = await historyTool.execute('get', { id: own.id }, undefined, () => {}, { ...ctxForSession, sessionManager: { getSessionId: () => 'other-session' } });
  assert.deepEqual(JSON.parse(hidden.content[0].text), { record: null });
  const crossSession = await historyTool.execute('get', { id: own.id, allSessions: true }, undefined, () => {}, ctxForSession);
  assert.equal(JSON.parse(crossSession.content[0].text).record.id, own.id);
  const all = await historyTool.execute('all', { allSessions: true, limit: 50 }, undefined, () => {}, ctxForSession);
  assert.equal(JSON.parse(all.content[0].text).records.length, 50);
  const wildcard = { ...legacy, id: 'literal-%-id' };
  store.addLog(wildcard);
  assert.equal(store.findLog('literal-').ambiguous, false);
  assert.equal(store.findLog('literal-X').log, undefined, '前缀查询按字面匹配通配符字符');
  const exactPreference = { ...legacy, id: 'literal-prefix-long' };
  store.addLog(exactPreference);
  assert.deepEqual(store.findLog('literal-%-id'), { log: wildcard, ambiguous: false }, '完全匹配优先于可能重叠的前缀');
  store.updateLog(own.id, { evidence: { source: 'tool_result', exitCode: 0, resultCount: 1 }, executionState: 'completed', updatedAt: new Date().toISOString() });
  assert.equal(store.getLog(own.id).evidence.exitCode, 0);

  await emit('tool_result', { toolName: 'subagent', input: { action: 'list' }, isError: false, details: { agentCapabilities: { agents: [{ name: 'worker', executable: true, runner: { type: 'pi' } }] } } });
  const event = toolEvent({ agent: 'worker', task: 'Trace a harmless formatter task.' });
  assert.equal(await emit('tool_call', event), undefined);
  const log = store.getLogs(1)[0];
  assert.equal(log.executionState, 'unknown', '派发前状态不能假定尚未启动');

  const asyncCall = toolEvent({ agent: 'worker', task: 'Trace async acceptance.', async: true });
  await emit('tool_call', asyncCall);
  const asyncResult = { ...resultEvent(asyncCall.toolCallId), details: { asyncId: 'async-123', runId: 'run-123' } };
  const returnedAsync = await emit('tool_result', asyncResult);
  assert.equal(store.findLogById(asyncCall.toolCallId, 'current-session'), undefined, '按 route ID 而非 toolCallId 查找');
  const asyncLog = store.getLogs(1)[0];
  assert.equal(asyncLog.executionState, 'accepted');
  assert.equal(asyncLog.asyncId, 'async-123');
  assert.equal(asyncLog.runId, 'run-123');
  assert.match(returnedAsync.content.at(-1).text, /runId=run-123/);
  assert.deepEqual(returnedAsync.content[0], asyncResult.content[0]);
  assert.equal(returnedAsync.details, asyncResult.details);
  assert.equal(returnedAsync.isError, asyncResult.isError);
  assert.equal(returnedAsync.usage, asyncResult.usage);

  const unknownCall = toolEvent({ agent: 'worker', task: 'Trace unknown exit code.' });
  await emit('tool_call', unknownCall);
  await emit('tool_result', resultEvent(unknownCall.toolCallId, { model: 'fixture/low' }));
  assert.equal(store.getLogs(1)[0].executionState, 'unknown');
  const failedCall = toolEvent({ agent: 'worker', task: 'Trace failing exit code.' });
  await emit('tool_call', failedCall);
  await emit('tool_result', resultEvent(failedCall.toolCallId, { exitCode: -1 }));
  assert.equal(store.getLogs(1)[0].executionState, 'failed');
  assert.equal(store.getLogs(1)[0].evidence.exitCode, -1);

  const beforeIrrelevant = store.getLogs(1)[0];
  await emit('tool_result', { toolName: 'bash', toolCallId: failedCall.toolCallId, input: {}, content: [], details: {}, isError: false });
  assert.deepEqual(store.getLogs(1)[0], beforeIrrelevant, '无关 tool_result 不应更新路由记录');

  const blocked = toolEvent({ agent: 'missing', task: 'Blocked before dispatch.' });
  // Unknown agent is blocked before dispatch, and this observed result closes the call.
  assert.equal((await emit('tool_call', blocked)).block, true);
  await emit('tool_result', { toolName: 'subagent', toolCallId: blocked.toolCallId, input: {}, content: [], details: undefined, isError: false });
  assert.equal(store.getLogs(1)[0].executionState, 'not_started');

  const skipped = toolEvent({ workflowScript: 'return 1;' });
  await emit('tool_call', skipped);
  await emit('tool_result', { ...resultEvent(skipped.toolCallId), details: { asyncId: 'workflow-run' } });
  assert.equal(store.getLogs(1)[0].executionState, 'accepted', '跳过路由不代表没有执行');

  const brokenCall = toolEvent({ agent: 'worker', task: 'Persistence failure receipt.' });
  await emit('tool_call', brokenCall);
  const logsBeforeFailure = store.getLogs();
  store.close();
  const { DatabaseSync } = await import('node:sqlite');
  const failureDb = new DatabaseSync(join(root, 'jev-route.sqlite'));
  failureDb.exec("CREATE TRIGGER fail_log_update BEFORE UPDATE ON logs BEGIN SELECT RAISE(ABORT, 'test persistence failure'); END;");
  const result = await emit('tool_result', resultEvent(brokenCall.toolCallId, { exitCode: 0 }));
  failureDb.close();
  assert.match(result.content.at(-1).text, /persistence=FAILED/);
  assert.equal(result.details.results[0].exitCode, 0);
  assert.equal(result.isError, false);
  store = openStore(join(root, 'jev-route.sqlite'));
  assert.deepEqual(store.getLogs(), logsBeforeFailure, '持久化关闭时未报告记录更新成功');
  assert(notices.some(message => /未持久化/.test(message)));
  console.log('observability: legacy compatibility, session-bound history, receipts, execution states, unrelated results and persistence failure passed');
} finally {
  await emit('session_shutdown');
  try { store?.close(); } catch {}
  if (oldDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = oldDir;
  if (oldKey === undefined) delete process.env.TYPESAFE_API_KEY; else process.env.TYPESAFE_API_KEY = oldKey;
  globalThis.fetch = oldFetch;
  await rm(root, { recursive: true, force: true });
}
