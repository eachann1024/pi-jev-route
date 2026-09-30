import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_SUPERVISION, constrainSupervisionDecision, createSupervisionTask, parseSupervisionSettings, planSupervisionCheck } from '../lib/supervision-policy.ts';
import { judgeSupervision } from '../lib/supervision-judge.ts';

const base = { enabled: true, mode: 'recover', monitorMain: true, monitorChildren: true, allowMainTakeover: false, correctionModel: 'provider/model', correctionThinking: 'medium' };
const settings = parseSupervisionSettings(base);
const capability = { steer: true, interrupt: true, resume: true, replace: true };
function observation(patch = {}) {
  return { taskId: 'task-1', sessionId: 'session-1', target: 'child', runId: 'run-1', goal: 'finish the bounded task', evidence: ['tool result shows the same goal'], now: 100_000, startedAt: 0, lastActivityAt: 95_000, lastProgressAt: 95_000, toolCount: 1, activeTools: [], lifecycle: 'running', waitingForUser: false, waitingForChildren: false, processTerminal: 'unknown', capability, evidenceVersion: 1, ...patch };
}
function task(input = observation(), patch = {}) {
  const created = createSupervisionTask(input);
  return { ...created, checks: 1, revision: 1, lastReviewedToolCount: input.toolCount, lastReviewedVersion: input.evidenceVersion, ...patch };
}
function jev(choice, scores = [2, 2, 2], support = '0') {
  return { model: 'jev-1.13.0', answers: { action: { type: 'choice', choice, probabilities: { [choice]: 1 }, confidence: 1 }, alignment: { type: 'score', score: scores[0], legend: {}, probabilities: {}, confidence: 1 }, progress: { type: 'score', score: scores[1], legend: {}, probabilities: {}, confidence: 1 }, constraints: { type: 'score', score: scores[2], legend: {}, probabilities: {}, confidence: 1 }, evidence: { type: 'choice', choice: support, probabilities: { [support]: 1 }, confidence: 1 } }, usage: { input_tokens: 1, output_tokens: 1 } };
}
function fakeFetch(payload, capture = {}) {
  return async (url, init) => {
    capture.url = url; capture.body = JSON.parse(init.body); capture.authorization = init.headers.Authorization;
    if (payload instanceof Error) throw payload;
    return { ok: payload.ok !== false, status: payload.status ?? 200, json: async () => payload.json ?? payload };
  };
}

assert.equal(DEFAULT_SUPERVISION.enabled, true);
assert.equal(parseSupervisionSettings({ mode: 'observe' }).mode, 'recover');
assert.equal(parseSupervisionSettings({ mode: 'correct' }).mode, 'recover');
assert.equal(parseSupervisionSettings({ enabled: false }).enabled, false);
assert.equal(DEFAULT_SUPERVISION.allowMainTakeover, false);
assert.equal(DEFAULT_SUPERVISION.correctionThinking, 'high');
assert.equal(DEFAULT_SUPERVISION.pollMs, 5_000);
assert.deepEqual(parseSupervisionSettings(undefined), DEFAULT_SUPERVISION);
assert.equal(parseSupervisionSettings({ maxInterventions: 1, maxRecoveries: 2, maxTakeovers: 1 }).maxInterventions, 1);
assert.equal(parseSupervisionSettings({ correctionModel: '' }).correctionModel, '');
assert.equal(parseSupervisionSettings({ correctionModel: 'provider/model' }).correctionModel, 'provider/model');
for (const invalid of [{ unknown: true }, { correctionModel: 'bare' }, { correctionModel: 'provider/bad model' }, { pollMs: 1 }, { decisionTimeoutMs: 20 }, { reviewEveryTools: 0 }, { maxChecksPerTask: 0 }, { maxRecoveries: 101 }, { deepThinkingIdleMs: 1_000 }]) assert.throws(() => parseSupervisionSettings(invalid), TypeError);

const fresh = observation();
assert.equal(planSupervisionCheck(task(fresh), fresh, settings).kind, 'none');
const idle = observation({ now: 95_000 + settings.idleMs });
assert.deepEqual(planSupervisionCheck(task(idle), idle, settings), { kind: 'suspect', reasonCode: 'idle_timeout' });
const deep = observation({ thinking: 'high', now: 95_000 + settings.idleMs, evidenceVersion: 0 });
assert.equal(planSupervisionCheck(task(deep), deep, settings).reasonCode, 'within_bounds');
const deepDue = observation({ thinking: 'high', now: 95_000 + settings.deepThinkingIdleMs });
assert.equal(planSupervisionCheck(task(deepDue), deepDue, settings).reasonCode, 'deep_thinking_idle');
const tools = observation({ activeTools: ['bash'], now: 95_000 + settings.deepThinkingIdleMs });
assert.equal(planSupervisionCheck(task(tools), tools, settings).reasonCode, 'tool_active');
const review = observation({ toolCount: 9, evidenceVersion: 2 });
assert.equal(planSupervisionCheck(task(review, { lastReviewedToolCount: 1, lastReviewedVersion: 1 }), review, settings).reasonCode, 'tool_review');
const capped = observation();
assert.deepEqual(planSupervisionCheck(task(capped, { checks: settings.maxChecksPerTask }), capped, settings), { kind: 'none', reasonCode: 'check_cap' });
const expired = observation({ now: settings.maxTaskMs });
assert.deepEqual(planSupervisionCheck(task(expired), expired, settings), { kind: 'none', reasonCode: 'task_deadline' });
const inFlight = observation();
assert.equal(planSupervisionCheck(task(inFlight, { pendingAction: 'recover' }), inFlight, settings).reasonCode, 'action_in_flight');

const suspect = task(observation(), { checks: 0, phase: 'suspect', suspectAt: 70_000 });
const recheck = observation({ now: 70_000 + settings.recheckMs, lastActivityAt: 70_000, lastProgressAt: 70_000 });
assert.equal(planSupervisionCheck(suspect, recheck, settings).reasonCode, 'suspect_recheck');
const resumed = observation({ now: 70_000 + settings.recheckMs, lastActivityAt: 70_001, lastProgressAt: 70_000 });
assert.equal(planSupervisionCheck(suspect, resumed, settings).reasonCode, 'activity_cleared_suspect');
const newEvidence = observation({ now: 70_000 + settings.recheckMs, lastActivityAt: 70_000, lastProgressAt: 70_000, toolCount: 2, evidenceVersion: 2 });
assert.equal(planSupervisionCheck(suspect, newEvidence, settings).reasonCode, 'activity_cleared_suspect');
const failed = observation({ lifecycle: 'failed', processTerminal: 'unknown', now: 95_000 + settings.handoffMs });
assert.equal(planSupervisionCheck(task(failed), failed, settings).reasonCode, 'unknown_lifecycle');
const proven = observation({ lifecycle: 'failed', processTerminal: 'observed', now: 95_000 + settings.handoffMs });
assert.equal(planSupervisionCheck(task(proven), proven, settings).reasonCode, 'failed_handoff');

const scores = { alignment: 0.1, progress: 0.1, constraints: 0.1 };
const reviewEvidence = observation({ toolCount: 9, evidenceVersion: 2 });
const correctSettings = parseSupervisionSettings({ ...base, mode: 'correct', correctionModel: '' });
const corrected = constrainSupervisionDecision(task(reviewEvidence, { lastReviewedToolCount: 1, lastReviewedVersion: 1 }), reviewEvidence, correctSettings, { action: 'correct', reasonCode: 'model', evidenceIds: [0, 9], scores });
assert.equal(corrected.action, 'correct');
assert.deepEqual(corrected.evidenceIds, [0]);
assert.equal(constrainSupervisionDecision(task(reviewEvidence, { lastReviewedToolCount: 1, lastReviewedVersion: 1 }), reviewEvidence, correctSettings, { action: 'recover', reasonCode: 'model', evidenceIds: [0], scores }).action, 'recover');
const recoverable = observation({ consecutiveFailures: 3, lifecycle: 'running', processTerminal: 'unknown', lastActivityAt: 0, lastProgressAt: 0, capability: { ...capability, replace: false } });
const recovered = constrainSupervisionDecision(task(recoverable, { phase: 'suspect', suspectAt: 0, checks: 0 }), observation({ ...recoverable, now: settings.recheckMs }), parseSupervisionSettings({ ...base, correctionModel: '' }), { action: 'recover', reasonCode: 'model', evidenceIds: [0], scores });
assert.equal(recovered.action, 'recover');
assert.equal(constrainSupervisionDecision(task(reviewEvidence, { lastReviewedToolCount: 1, lastReviewedVersion: 1 }), reviewEvidence, parseSupervisionSettings({ ...base, enabled: false }), { action: 'stop', reasonCode: 'model', evidenceIds: [0], scores }).reasonCode, 'supervision_disabled');
assert.equal(constrainSupervisionDecision(task(reviewEvidence, { lastReviewedToolCount: 1, lastReviewedVersion: 1 }), reviewEvidence, correctSettings, { action: 'stop', reasonCode: 'model', evidenceIds: [0], scores }).action, 'stop');
const stale = constrainSupervisionDecision(task(reviewEvidence, { lastReviewedToolCount: 1, lastReviewedVersion: 1 }), reviewEvidence, settings, { action: 'continue', reasonCode: 'stale_generation', evidenceIds: [0], scores });
assert.equal(stale.reasonCode, 'stale_generation');
const takeoverObservation = observation({ lifecycle: 'failed', processTerminal: 'unknown', now: 95_000 + settings.handoffMs });
assert.equal(constrainSupervisionDecision(task(takeoverObservation), takeoverObservation, settings, { action: 'takeover', reasonCode: 'model', evidenceIds: [0], scores }).action, 'wait');
assert.equal(constrainSupervisionDecision(task(takeoverObservation), takeoverObservation, parseSupervisionSettings({ ...base, correctionModel: '' }), { action: 'takeover', reasonCode: 'model', evidenceIds: [0], scores }).reasonCode, 'action_not_permitted');
const main = observation({ ...proven, target: 'main' });
assert.equal(constrainSupervisionDecision(task(main), main, settings, { action: 'takeover', reasonCode: 'model', evidenceIds: [0], scores }).reasonCode, 'action_not_permitted');
const cappedRecovery = task(recoverable, { phase: 'suspect', suspectAt: 0, checks: 0, recoveries: settings.maxRecoveries });
assert.equal(constrainSupervisionDecision(cappedRecovery, observation({ ...recoverable, now: settings.recheckMs }), settings, { action: 'recover', reasonCode: 'model', evidenceIds: [0], scores }).reasonCode, 'recovery_cap');

const savedKey = process.env.TYPESAFE_API_KEY;
process.env.TYPESAFE_API_KEY = 'policy-test-key';
const capture = {};
const judged = await judgeSupervision(reviewEvidence, task(reviewEvidence, { lastReviewedToolCount: 1, lastReviewedVersion: 1 }), parseSupervisionSettings({ ...base, mode: 'correct' }), new AbortController().signal, { fetch: fakeFetch(jev('correct'), capture) });
assert.equal(judged.action, 'correct');
assert.equal(judged.reasonCode, 'jev_judgment');
assert.deepEqual(judged.scores, { alignment: 1, progress: 1, constraints: 1 });
assert.equal(capture.url, 'https://api.typesafe.ai/v1/systemone');
assert.equal(capture.body.model, 'jev-latest');
assert.equal(capture.body.questions.action.type, 'choice');
assert.equal(capture.body.questions.alignment.type, 'score');
assert.equal(capture.authorization.includes('policy-test-key'), true);
assert.equal(Object.hasOwn(capture.body.state, 'consecutiveFailures'), false, 'unknown child failures are omitted rather than fabricated as zero');
const zeroCapture = {};
const zeroFailures = observation({ ...reviewEvidence, target: 'main', consecutiveFailures: 0 });
await judgeSupervision(zeroFailures, task(zeroFailures, { lastReviewedToolCount: 1, lastReviewedVersion: 1 }), correctSettings, new AbortController().signal, { fetch: fakeFetch(jev('correct'), zeroCapture) });
assert.equal(zeroCapture.body.state.consecutiveFailures, 0, 'observed main failure count retains real zero');

const lowScore = await judgeSupervision(reviewEvidence, task(reviewEvidence, { lastReviewedToolCount: 1, lastReviewedVersion: 1 }), correctSettings, new AbortController().signal, { fetch: fakeFetch(jev('correct', [0, 0, 0.4])) });
assert.equal(lowScore.action, 'correct');
assert.deepEqual(lowScore.scores, { alignment: 0, progress: 0, constraints: 0.2 });
const http = await judgeSupervision(reviewEvidence, task(reviewEvidence, { lastReviewedToolCount: 1, lastReviewedVersion: 1 }), settings, new AbortController().signal, { fetch: fakeFetch({ ok: false, status: 500 }) });
assert.equal(http.reasonCode, 'jev_http_error');
const malformed = await judgeSupervision(reviewEvidence, task(reviewEvidence, { lastReviewedToolCount: 1, lastReviewedVersion: 1 }), settings, new AbortController().signal, { fetch: fakeFetch({ json: { answers: {} } }) });
assert.equal(malformed.reasonCode, 'invalid_response');
const controller = new AbortController();
const hung = judgeSupervision(reviewEvidence, task(reviewEvidence, { lastReviewedToolCount: 1, lastReviewedVersion: 1 }), parseSupervisionSettings({ ...settings, decisionTimeoutMs: 1_000 }), controller.signal, { fetch: () => new Promise(() => {}) });
assert.equal((await hung).reasonCode, 'jev_timeout');
controller.abort();
await assert.rejects(judgeSupervision(reviewEvidence, task(reviewEvidence, { lastReviewedToolCount: 1, lastReviewedVersion: 1 }), settings, AbortSignal.abort(), { fetch: async () => { throw new Error('must not fetch'); } }), /aborted/);

const secret = observation({ goal: 'token=supersecret', evidence: ['api_key: abcdefghijklmnop', 'normal evidence'], toolCount: 9, evidenceVersion: 2 });
const secretCapture = {};
await judgeSupervision(secret, task(secret, { lastReviewedToolCount: 1, lastReviewedVersion: 1 }), parseSupervisionSettings({ ...base, mode: 'correct' }), new AbortController().signal, { fetch: fakeFetch(jev('correct', [2, 2, 2], '1'), secretCapture) });
assert.equal(secretCapture.body.state.goal, '[redacted]');
assert.equal(secretCapture.body.state.evidence[0].text, '[redacted]');
assert.equal(JSON.stringify(secretCapture.body).includes('supersecret'), false);

delete process.env.TYPESAFE_API_KEY;
const dir = mkdtempSync(join(tmpdir(), 'supervision-policy-'));
const savedHome = process.env.HOME;
process.env.HOME = dir;
mkdirSync(join(dir, '.config/typesafe'), { recursive: true });
mkdirSync(join(dir, '.config/typesafe'), { recursive: true });
writeFileSync(join(dir, '.config/typesafe/api_key'), 'file-key');
const fileCapture = {};
await judgeSupervision(reviewEvidence, task(reviewEvidence, { lastReviewedToolCount: 1, lastReviewedVersion: 1 }), settings, new AbortController().signal, { fetch: fakeFetch(jev('wait'), fileCapture) });
assert.equal(fileCapture.authorization, 'Bearer file-key');
process.env.HOME = savedHome;
const missing = await judgeSupervision(reviewEvidence, task(reviewEvidence, { lastReviewedToolCount: 1, lastReviewedVersion: 1 }), settings, new AbortController().signal, { readCredential: () => undefined });
assert.equal(missing.reasonCode, 'missing_credentials');
if (savedKey === undefined) delete process.env.TYPESAFE_API_KEY; else process.env.TYPESAFE_API_KEY = savedKey;
console.log('supervision policy tests passed');

// Time alone cannot authorize destructive recovery, even if the judge requests it.
const silence = observation({ now: 200_000, lastActivityAt: 0, lastProgressAt: 0 });
for (const action of ['recover', 'stop', 'takeover']) {
  const result = constrainSupervisionDecision(task(silence, { checks: 0, phase: 'suspect', suspectAt: 180_000 }), silence, settings, { action, reasonCode: 'model', evidenceIds: [0] });
  assert.equal(result.action, 'insufficient'); assert.equal(result.reasonCode, 'timing_only');
}
const busy = observation({ now: 500_000, lastActivityAt: 499_000, lastProgressAt: 0, progressKnown: true });
assert.equal(planSupervisionCheck(task(busy), busy, settings).reasonCode, 'no_progress', 'activity does not extend progress deadline');
const failing = { ...busy, lastProgressAt: 499_000, consecutiveFailures: 3 };
assert.equal(planSupervisionCheck(task(failing), failing, settings).reasonCode, 'repeated_tool_failure');
const stalledTool = { ...busy, activeTools: ['bash'], activeToolStartedAt: 0 };
assert.equal(planSupervisionCheck(task(stalledTool), stalledTool, settings).reasonCode, 'tool_stall');
assert.equal(constrainSupervisionDecision(task(stalledTool), stalledTool, settings, { action: 'recover', reasonCode: 'model', evidenceIds: [0] }).action, 'insufficient');
const unknown = { ...silence, lifecycle: 'unknown' };
assert.notEqual(constrainSupervisionDecision(task(unknown), unknown, settings, { action: 'recover', reasonCode: 'model', evidenceIds: [0] }).action, 'recover');
assert.equal(planSupervisionCheck(task(busy), { ...busy, waitingForChildren: true }, settings).reasonCode, 'waiting_for_children');
assert.equal(planSupervisionCheck(task(busy), { ...busy, waitingForSupervisor: true }, settings).reasonCode, 'waiting_for_supervisor');
