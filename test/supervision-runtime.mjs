import assert from 'node:assert/strict';
import { DEFAULT_SUPERVISION, constrainSupervisionDecision } from '../lib/supervision-policy.ts';
import { createSupervisionRuntime } from '../lib/supervision-runtime.ts';

function fixture({ action = 'continue', proof = false, persisted = new Map(), main = false, cap = 3, locale = 'en', scores } = {}) {
  let now = 100_000, counter = 0, judgments = 0;
  let config = { ...DEFAULT_SUPERVISION, monitorMain: main, monitorChildren: !main, pollMs: 1000, idleMs: 1000, recheckMs: 1000, maxChecksPerTask: cap };
  const events = [], calls = [], messages = [], requests = [], timers = new Set(), hooks = new Map();
  const on = (name, fn) => { const list = hooks.get(name) || []; list.push(fn); hooks.set(name, list); return () => {}; };
  const notices = [];
  const ctx = { sessionManager: { getSessionId: () => 's' }, ui: { notify(message, level) { notices.push({ message, level }); } }, modelRegistry: { getAvailable: () => [] } };
  const store = { getSupervisionTasks: () => [...persisted.values()], saveSupervisionTask: task => persisted.set(task.id, structuredClone(task)), addSupervisionEvent: event => events.push(event), getSupervisionEvents: () => events };
  const snapshot = { kind: 'pi-subagents.async-status-snapshot', version: 1, runs: [{ id: 'r', state: 'running', goal: 'complete bounded task', startedAt: now - 5000, activity: { toolCount: 2, lastActivityAt: now - 5000 } }] };
  const pi = { on, events: { on, emit() {} }, registerTool() {}, registerCommand() {}, sendMessage(message, options) { messages.push({ ...message, options }); } };
  const runtime = createSupervisionRuntime(pi, { settings: () => config, store: () => store, locale: () => locale, allowedModels: () => [] }, {
    // Recovery tests isolate the process-proof seam with explicit failure facts;
    // the native snapshot does not expose child failure counts.
    constrain: (task, seen, settings, decision) => constrainSupervisionDecision(task, action === 'recover' ? { ...seen, consecutiveFailures: 3 } : seen, settings, decision),
    now: () => now, randomId: () => `event-${++counter}`,
    setTimer: (fn, ms) => { const t = { fn, ms }; timers.add(t); return t; }, clearTimer: t => timers.delete(t),
    judge: async (_observation, task) => { assert(task.checks < config.maxChecksPerTask, 'judge receives state before consuming this check'); judgments++; return { action, reasonCode: 'test_evidence', evidenceIds: [0], ...(scores ? { scores } : {}) }; },
    rpc: { request: async req => {
      calls.push(req.method); requests.push(req);
      if (req.method === 'ping') return { success: true, data: { capabilities: { status: true, interrupt: true, resume: true, steer: true }, session: { sessionId: 's' } } };
      if (req.method === 'status' && !req.params.id) return { success: true, data: { asyncSnapshot: snapshot } };
      if (req.method === 'status') return { success: true, data: { state: 'paused', details: { lifecycleStatus: { processTerminal: proof ? { version: 1, runId: proof === 'wrong-run' ? 'another-run' : 'r', state: 'observed', observedAt: now, runnerProcessInstanceId: 'runner-1', instances: [{ kind: 'runner', processInstanceId: proof === 'wrong-instance' ? 'runner-2' : 'runner-1' }] } : undefined } } } };
      if (req.method === 'resume') return { success: true, data: { runId: 'next' } };
      return { success: true, data: {} };
    } },
  });
  async function emit(name, event = {}) { for (const handler of hooks.get(name) || []) await handler(event, ctx); }
  async function tick(ms = 1000) { now += ms; const t = [...timers][0]; assert(t, 'poll timer exists'); timers.delete(t); await t.fn(); await new Promise(resolve => setImmediate(resolve)); }
  return { runtime, events, calls, messages, requests, notices, snapshot, now: () => now, advance(ms) { now += ms; }, setLocale(value) { locale = value; }, persisted, emit, tick, config, judgments: () => judgments, task: () => runtime.snapshot().tasks.find(t => t.runId === 'r' || main && t.goal), disable() { config.enabled = false; runtime.settingsChanged(); }, enable() { config.enabled = true; runtime.settingsChanged(); } };
}

const uncertain = fixture({ action: 'recover' });
await uncertain.emit('session_start'); await uncertain.tick();
assert.equal(uncertain.task().phase, 'suspect'); assert.equal(uncertain.judgments(), 0);
await uncertain.tick();
assert(uncertain.calls.includes('interrupt')); assert(!uncertain.calls.includes('resume'));
assert.equal(uncertain.task().recoveries, 1, 'attempt counted before uncertain result');
assert(uncertain.task().pendingIntent, 'unknown outcome survives reload');
await uncertain.tick(); assert.equal(uncertain.judgments(), 1, 'blocked intent never retried');
uncertain.runtime.dispose();
const restored = fixture({ persisted: uncertain.persisted, action: 'recover' });
await restored.emit('session_start'); await restored.tick();
assert.equal(restored.judgments(), 0); assert.equal(restored.task().recoveries, 1); restored.runtime.dispose();

const confirmed = fixture({ action: 'recover', proof: true });
await confirmed.emit('session_start'); await confirmed.tick(); await confirmed.tick();
assert.deepEqual(confirmed.calls.slice(-3), ['interrupt', 'status', 'resume']);
const successor = confirmed.runtime.snapshot().tasks.find(t => t.runId === 'next');
assert.equal(successor.recoveries, 1); assert.equal(successor.startedAt, confirmed.task().startedAt);
assert.equal(successor.proofRunId, undefined); confirmed.runtime.dispose();

const capped = fixture({ cap: 1 });
await capped.emit('session_start'); await capped.tick(); await capped.tick(); await capped.tick(); await capped.tick();
assert.equal(capped.judgments(), 1, 'one allowed check actually runs'); assert.equal(capped.task().checks, 1);
assert.equal(capped.events.filter(e => e.reasonCode === 'check_cap').length, 1);
assert(!capped.calls.includes('stop')); capped.runtime.dispose();

const paused = fixture({ main: true });
await paused.emit('session_start'); await paused.tick(); assert.equal(paused.judgments(), 0, 'idle session is not a task');
await paused.emit('input', { text: 'first task', source: 'interactive' });
paused.disable(); paused.disable();
assert.equal(paused.task().phase, 'running'); assert(!paused.task().userStopped);
assert.equal(paused.events.filter(e => e.reasonCode === 'supervision_disabled').length, 1);
assert.equal(paused.events.find(e => e.reasonCode === 'supervision_disabled').kind, 'observation');
paused.enable(); assert.equal(paused.task().autoInterventionBlocked, false);
await paused.emit('input', { text: '/stop', source: 'interactive' }); assert(paused.task().userStopped);
await paused.emit('input', { text: 'second task', source: 'interactive' });
const second = paused.runtime.snapshot().tasks.find(t => t.goal === 'second task');
assert(second && !second.userStopped && second.checks === 0);
await paused.emit('agent_settled'); assert.equal(paused.runtime.snapshot().tasks.find(t => t.id === second.id).phase, 'completed');
paused.runtime.dispose();
for (const proof of ['wrong-run', 'wrong-instance']) {
  const mismatch = fixture({ action: 'recover', proof });
  await mismatch.emit('session_start'); await mismatch.tick(); await mismatch.tick();
  assert(!mismatch.calls.includes('resume'), `${proof} must not authorize revival`);
  mismatch.runtime.dispose();
}

const deadline = fixture();
deadline.config.maxTaskMs = 1000;
await deadline.emit('session_start'); await deadline.tick(); await deadline.tick();
assert.equal(deadline.judgments(), 0);
assert.equal(deadline.task().lastReason, 'task_deadline');
assert.equal(deadline.events.filter(e => e.reasonCode === 'task_deadline').length, 1);
assert(!deadline.calls.includes('stop') && !deadline.calls.includes('interrupt'));
deadline.runtime.dispose();

const waiting = fixture({ main: true, action: 'wait' });
waiting.config.reviewEveryTools = 1;
waiting.config.idleMs = 10000;
await waiting.emit('session_start');
await waiting.emit('input', { text: 'read a marker', source: 'interactive' });
await waiting.emit('tool_execution_start', { toolCallId: 'read-1', toolName: 'read' });
await waiting.emit('tool_execution_end', { toolCallId: 'read-1', toolName: 'read', isError: false });
await waiting.tick();
assert.equal(waiting.judgments(), 1);
assert.equal(waiting.task().phase, 'running', 'ordinary wait does not label active work as suspect');
waiting.runtime.dispose();

// Change language after startup: dispatched instructions must use the current setting.
for (const locale of ['zh', 'en']) {
  const checkMessage = message => {
    assert.match(message, locale === 'zh' ? /任务.*提醒/ : /Task .*reminder/);
    assert.doesNotMatch(message, /test_evidence|jev_judgment|Reason:|原因：/);
    if (locale === 'en') assert.doesNotMatch(message, /[\u4e00-\u9fff]/);
  };
  const parent = fixture({ main: true, action: 'correct', locale: locale === 'zh' ? 'en' : 'zh', scores: { alignment: 0.2, progress: 0.8, constraints: 0.8 } });
  parent.config.reviewEveryTools = 1; parent.config.idleMs = 10000;
  await parent.emit('session_start');
  await parent.emit('input', { text: 'finish the task', source: 'interactive' });
  await parent.emit('tool_execution_end', { toolCallId: 'read-localized', toolName: 'read', isError: false });
  parent.setLocale(locale);
  await parent.tick();
  assert.equal(parent.messages.length, 1);
  checkMessage(parent.messages[0].content);
  assert.equal(parent.messages[0].details.reasonCode, 'test_evidence');
  assert.equal(parent.messages[0].options.deliverAs, 'steer');
  parent.runtime.dispose();
  for (const action of ['correct', 'recover']) {
    const child = fixture({ action, proof: true, locale: locale === 'zh' ? 'en' : 'zh', ...(action === 'correct' ? { scores: { alignment: 0.2, progress: 0.8, constraints: 0.8 } } : {}) });
    await child.emit('session_start'); await child.tick(); child.setLocale(locale); await child.tick();
    const request = child.requests.find(r => r.method === (action === 'correct' ? 'steer' : 'resume'));
    assert(request, `${action} was dispatched`);
    checkMessage(request.params.message);
    assert(child.events.some(e => e.reasonCode === 'test_evidence'), 'diagnostic code remains in audit');
    child.runtime.dispose();
  }
}

const quiet = fixture({ main: true, action: 'correct', scores: { alignment: 0.9, progress: 0.8, constraints: 0.8 } });
quiet.config.reviewEveryTools = 1; quiet.config.idleMs = 10000;
await quiet.emit('session_start');
await quiet.emit('input', { text: 'finish the task', source: 'interactive' });
await quiet.emit('tool_execution_end', { toolCallId: 'read-quiet', toolName: 'read', isError: false });
await quiet.tick();
assert.equal(quiet.messages.length, 0, 'aligned work does not get a reminder');
assert.equal(quiet.task().lastReason, 'alignment_ok');
quiet.runtime.dispose();

const once = fixture({ main: true, action: 'correct', scores: { alignment: 0.2, progress: 0.4, constraints: 0.8 } });
once.config.reviewEveryTools = 1; once.config.idleMs = 10000; once.config.maxInterventions = 2;
await once.emit('session_start');
await once.emit('input', { text: 'finish the task', source: 'interactive' });
await once.emit('tool_execution_end', { toolCallId: 'read-once', toolName: 'read', isError: false });
await once.tick();
assert.equal(once.messages.length, 1);
await once.emit('tool_execution_end', { toolCallId: 'read-twice', toolName: 'read', isError: false });
await once.tick();
assert.equal(once.messages.length, 1, 'the same task is reminded only once');
assert.equal(once.task().lastReason, 'correction_already_sent');
once.runtime.dispose();

console.log('supervision runtime: lifecycle, limits, persistence and current-language main/child instructions passed');

const thinking = fixture({ main: true, action: 'recover' });
thinking.config.feedbackAfterMs = 1000; thinking.config.feedbackIntervalMs = 1000;
await thinking.emit('session_start'); await thinking.emit('input', { text: 'reason carefully', source: 'interactive' });
const initialProgress = thinking.task().lastProgressAt;
for (let i = 0; i < 8; i++) {
  await thinking.emit('message_update', { assistantMessageEvent: { type: 'thinking_delta' } });
  await thinking.tick();
}
assert.equal(thinking.task().lastProgressAt, initialProgress);
assert.equal(thinking.judgments(), 0); assert.equal(thinking.task().checks, 0);
assert.equal(thinking.events.filter(e => e.reasonCode === 'feedback_thinking').length, 1, 'feedback is independent and deduplicated');
thinking.runtime.dispose();

const longTool = fixture({ main: true, action: 'recover' });
longTool.config.toolStallMs = 2000;
await longTool.emit('session_start'); await longTool.emit('input', { text: 'run long tool', source: 'interactive' });
await longTool.emit('tool_execution_start', { toolCallId: 'bash-a', toolName: 'bash' });
await longTool.emit('tool_execution_start', { toolCallId: 'bash-b', toolName: 'bash' });
await longTool.emit('tool_execution_end', { toolCallId: 'bash-a', toolName: 'bash', isError: false });
await longTool.tick(); await longTool.tick(); await longTool.tick();
assert.equal(longTool.judgments(), 0, 'finishing one same-name tool does not clear its sibling');
assert.equal(longTool.events.filter(e => e.reasonCode === 'tool_stall').length, 1);
assert.equal(longTool.task().interventions, 0);
longTool.runtime.dispose();

const failures = fixture({ main: true });
failures.config.idleMs = 10000; failures.config.reviewEveryTools = 100;
await failures.emit('session_start'); await failures.emit('input', { text: 'test retries', source: 'interactive' });
const success = { toolName: 'read', isError: false, result: { content: [{ type: 'text', text: 'stable result secret=not-retained' }] } };
failures.advance(1000); await failures.emit('tool_execution_end', { ...success, toolCallId: 'one' });
const successAt = failures.task().lastProgressAt;
failures.advance(1000); await failures.emit('tool_execution_end', { ...success, toolCallId: 'two' });
assert.equal(failures.task().lastProgressAt, successAt, 'duplicate results do not extend progress');
for (let i = 0; i < 3; i++) {
  failures.advance(1000);
  await failures.emit('tool_execution_end', { toolCallId: `bad-${i}`, toolName: 'read', isError: true, result: success.result });
}
assert.equal(failures.task().lastProgressAt, successAt);
assert.equal(failures.task().consecutiveFailures, 3);
assert(!JSON.stringify([...failures.persisted.values(), ...failures.events]).includes('not-retained'));
await failures.tick(); assert.equal(failures.task().lastReason, 'repeated_tool_failure');
await failures.tick(); assert.equal(failures.judgments(), 1);
await failures.tick(); await failures.tick(); await failures.tick();
assert.equal(failures.judgments(), 1, 'unchanged failures are not repeatedly judged');
failures.runtime.dispose();

const userWait = fixture({ main: true });
userWait.config.maxTaskMs = 4000; userWait.config.softBudgetMs = 3000;
await userWait.emit('session_start'); await userWait.emit('input', { text: 'wait for answer', source: 'interactive' });
await userWait.emit('ui_prompt_start');
for (let i = 0; i < 8; i++) await userWait.tick();
assert.equal(userWait.task().pausedMs, 8000); assert(!userWait.task().deadlineNotified);
assert.equal(userWait.judgments(), 0);
await userWait.emit('ui_prompt_end');
await userWait.tick(); assert(!userWait.task().deadlineNotified);
userWait.runtime.dispose();

const dependency = fixture({ main: true });
dependency.config.softBudgetMs = 2000; dependency.config.maxTaskMs = 4000;
await dependency.emit('session_start'); await dependency.emit('input', { text: 'wait on children', source: 'interactive' });
await dependency.emit('tool_call', { toolName: 'bg_wait', toolCallId: 'wait', input: {} });
await dependency.emit('tool_execution_start', { toolName: 'bg_wait', toolCallId: 'wait' });
for (let i = 0; i < 6; i++) await dependency.tick();
assert.equal(dependency.judgments(), 0);
assert.equal(dependency.events.filter(e => e.reasonCode === 'soft_budget').length, 1);
assert.equal(dependency.events.filter(e => e.reasonCode === 'task_deadline').length, 1);
assert.equal(dependency.task().phase, 'running'); assert(!dependency.task().pausedMs, 'dependency wait consumes end-to-end budget');
dependency.runtime.dispose();

const supervisor = fixture({ main: true });
supervisor.config.maxTaskMs = 2000;
await supervisor.emit('session_start'); await supervisor.emit('input', { text: 'ask supervisor', source: 'interactive' });
await supervisor.emit('tool_call', { toolName: 'contact_supervisor', toolCallId: 'ask', input: { reason: 'need_decision' } });
assert.equal(supervisor.events.filter(e => e.reasonCode === 'feedback_waiting_for_supervisor').length, 1, 'known supervisor wait is surfaced immediately');
for (let i = 0; i < 4; i++) await supervisor.tick();
assert(!supervisor.task().deadlineNotified); assert.equal(supervisor.judgments(), 0);
supervisor.runtime.dispose();

const sleep = fixture({ main: true });
sleep.config.noProgressMs = 1000;
await sleep.emit('session_start'); await sleep.emit('input', { text: 'survive sleep', source: 'interactive' });
await sleep.tick(); const beforeSleepProgress = sleep.task().lastProgressAt;
await sleep.tick(60_000);
assert.equal(sleep.judgments(), 0); assert.equal(sleep.task().lastProgressAt, beforeSleepProgress);
assert.equal(sleep.task().observationGraceUntil, sleep.now() + 1000);
assert(sleep.events.some(e => e.reasonCode === 'observation_grace'));
await sleep.tick(); await sleep.tick(); assert.equal(sleep.judgments(), 1);
sleep.runtime.dispose();

const restoredBudget = fixture({ main: true, persisted: dependency.persisted });
await restoredBudget.emit('session_start');
assert.equal(restoredBudget.task().startedAt, dependency.task().startedAt);
assert.equal(restoredBudget.task().softBudgetNotified, true);
assert.equal(restoredBudget.task().deadlineNotified, true);
await restoredBudget.tick();
assert.equal(restoredBudget.events.filter(e => e.reasonCode === 'soft_budget').length, 0);
assert.equal(restoredBudget.judgments(), 0);
restoredBudget.runtime.dispose();

const completion = fixture(); completion.config.maxTaskMs = 1000;
await completion.emit('session_start'); await completion.tick();
completion.snapshot.runs[0].state = 'complete';
await completion.emit('subagent:process-terminal', { version: 1, runId: 'r', state: 'observed', observedAt: completion.now(), runnerProcessInstanceId: 'runner', instances: [{ kind: 'runner', processInstanceId: 'runner' }] });
await completion.tick(); assert.equal(completion.task().phase, 'completed', 'deadline does not stop local terminal observation');
completion.runtime.dispose();
console.log('timing runtime: activity/progress, waits, budgets, feedback, sleep and completion passed');


const childSupervisor = fixture();
childSupervisor.snapshot.runs[0].activity.currentTool = 'contact_supervisor';
childSupervisor.snapshot.runs[0].activity.currentToolStartedAt = childSupervisor.now();
childSupervisor.snapshot.runs[0].activity.state = 'needs_attention';
await childSupervisor.emit('session_start'); await childSupervisor.tick();
assert.equal(childSupervisor.task().budgetPaused, true);
assert.equal(childSupervisor.events.filter(e => e.reasonCode === 'feedback_waiting_for_supervisor').length, 1);
childSupervisor.snapshot.runs[0].activity.currentTool = undefined;
await childSupervisor.tick();
assert.equal(childSupervisor.task().budgetPaused, false, 'needs_attention alone is not a supervisor wait');
assert.equal(childSupervisor.judgments(), 0);
childSupervisor.runtime.dispose();
