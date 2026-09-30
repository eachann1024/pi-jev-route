import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { DEFAULTS, openStore, parseSettings } from '../lib/store.ts';
import { DEFAULT_SUPERVISION, SUPERVISION_TIMING_PRESETS, parseSupervisionSettings } from '../lib/supervision-policy.ts';
import { startWeb } from '../lib/web.ts';
import { readFile } from 'node:fs/promises';

const dir = mkdtempSync(join(tmpdir(), 'pi-jev-supervision-settings-'));
const legacyPath = join(dir, 'legacy.sqlite');
const legacy = new DatabaseSync(legacyPath);
legacy.exec('CREATE TABLE settings (id INTEGER PRIMARY KEY, json TEXT NOT NULL); CREATE TABLE logs (id TEXT PRIMARY KEY, json TEXT NOT NULL);');
const oldSettings = { enabled: true, fallbackModel: '', styleUseMain: true, confidenceThreshold: .55, timeoutMs: 5000, locale: 'zh', instructions: 'keep me', models: { 'p/low': { enabled: true, description: 'kept' } } };
legacy.prepare('INSERT INTO settings(id,json) VALUES(1,?)').run(JSON.stringify(oldSettings));
legacy.prepare('INSERT INTO logs(id,json) VALUES(?,?)').run('route-1', JSON.stringify({ id: 'route-1', at: '2026-01-01T00:00:00.000Z', sessionId: 's', toolCallId: 't', agent: 'worker', taskHash: 'hash', outcome: 'selected', requestedModel: 'p/low', reason: 'kept', note: 'old note' }));
legacy.close();

const task = (id, sessionId = 's', revision = 1) => ({ id, sessionId, target: 'child', goal: 'bounded goal', phase: 'running', startedAt: 1, lastActivityAt: revision, lastProgressAt: 1, lastReviewAt: 0, lastReviewedVersion: 0, lastReviewedToolCount: 0, recoveries: 0, takeovers: 0, interventions: 0, checks: 0, revision });
const event = (id, at, sessionId = 's') => ({ id, at, sessionId, taskId: 'task-1', target: 'child', kind: 'decision', reasonCode: 'observe', message: 'recorded', evidence: ['secret sk-abcdefghijklmnopqrstuvwxyz must not persist'] });

let store, ui;
try {
  store = openStore(legacyPath);
  const migrated = store.getSettings();
  assert.equal(migrated.supervision.enabled, true);
  assert.equal(migrated.supervision.mode, 'recover');
  assert.equal(parseSettings({ supervision: { enabled: false } }).supervision.enabled, false);
  assert.equal(migrated.supervision.allowMainTakeover, false);
  assert.equal(migrated.supervision.correctionModel, '');
  assert.equal(migrated.instructions, 'keep me');
  assert.equal(migrated.models['p/low'].description, 'kept');
  assert.equal(store.getLog('route-1').note, 'old note');
  assert.equal(JSON.stringify(store.getSettings()).includes('secret'), false);

  const omitted = parseSettings({});
  assert.equal(omitted.supervision.enabled, true);
  assert.deepEqual(omitted.supervision, DEFAULTS.supervision);
  const samples = [{ enabled: 'yes' }, { mode: 'takeover' }, { pollMs: 10_000.5 }, { correctionThinking: 'max' }, { extra: true }, { pollMs: 10_000 }, { correctionModel: '' }, { maxInterventions: 1, maxRecoveries: 2 }];
  for (const sample of samples) {
    let accepted;
    try { accepted = parseSupervisionSettings(sample); }
    catch { accepted = undefined; }
    if (accepted) assert.deepEqual(parseSettings({ supervision: sample }).supervision, accepted);
    else assert.throws(() => parseSettings({ supervision: sample }), TypeError);
  }
  assert.equal(parseSettings({}).supervision.correctionModel, '');
  assert.equal(parseSettings({ supervision: { correctionThinking: 'high' } }).supervision.correctionThinking, 'high');

  const oldTiming = parseSupervisionSettings({ pollMs: 10_000, idleMs: 90_000, deepThinkingIdleMs: 300_000, recheckMs: 30_000, handoffMs: 60_000 });
  assert.equal(oldTiming.pollMs, 10_000); assert.equal(oldTiming.idleMs, 90_000);
  assert.equal(oldTiming.feedbackAfterMs, 30_000); assert.equal(oldTiming.softBudgetMs, 600_000);
  for (const preset of Object.values(SUPERVISION_TIMING_PRESETS)) assert.deepEqual(parseSupervisionSettings(preset), { ...DEFAULT_SUPERVISION, ...preset });
  assert.equal(SUPERVISION_TIMING_PRESETS.quick.noProgressMs, 60_000);
  assert.equal(SUPERVISION_TIMING_PRESETS.long.maxTaskMs, 7_200_000);
  for (const key of ['feedbackAfterMs', 'feedbackIntervalMs', 'noProgressMs', 'toolStallMs', 'softBudgetMs']) {
    for (const bad of [999, 1000.5, Infinity, '1000', key === 'softBudgetMs' ? 86_400_001 : 3_600_001]) assert.throws(() => parseSupervisionSettings({ [key]: bad }), TypeError);
    assert.equal(parseSupervisionSettings({ [key]: 1000 })[key], 1000);
  }
  for (const bad of [1, 21, 2.5, '3']) assert.throws(() => parseSupervisionSettings({ repeatFailureLimit: bad }), TypeError);
  assert.equal(parseSupervisionSettings({ repeatFailureLimit: 20 }).repeatFailureLimit, 20);
  store.saveSupervisionTask(task('task-1'));
  assert.equal(store.getSupervisionTasks('s')[0].pausedMs, undefined, 'old tasks have safe optional defaults');
  const durableTiming = { ...task('timing', 'timing'), pausedMs: 6000, budgetPaused: true, lastObservedAt: 7000, observationGraceUntil: 8000,
    lastFeedbackAt: 5000, lastFeedbackKey: 'waiting_for_user:1:', softBudgetNotified: true, deadlineNotified: false,
    lastToolStallKey: '1:bash', progressKnown: false, consecutiveFailures: 3, failureTool: 'read', progressDigests: ['a'.repeat(64)],
    suspectReason: 'progress_unknown', lastTimingReviewKey: 'progress_unknown:1:0:running:0', terminalObservedAt: 2 };
  store.saveSupervisionTask(durableTiming);
  assert.deepEqual(store.getSupervisionTasks('timing')[0], durableTiming);
  for (const extra of [{ pausedMs: -1 }, { budgetPaused: 'yes' }, { consecutiveFailures: 1.2 }, { progressDigests: ['raw secret'] }, { lastFeedbackKey: 'x'.repeat(257) }]) assert.throws(() => store.saveSupervisionTask({ ...task('bad', 'timing'), ...extra }), TypeError);
  store.addSupervisionEvent(event('event-1', 10));
  assert.equal(store.getSupervisionEvents('s')[0].evidence[0].includes('sk-abcdefghijklmnopqrstuvwxyz'), false);
  assert.match(store.getSupervisionEvents('s')[0].evidence[0], /\[redacted\]/);
  assert.throws(() => store.saveSupervisionTask({ ...task('bad'), phase: 'invented' }), TypeError);
  assert.throws(() => store.addSupervisionEvent({ ...event('bad', 1), message: 'x'.repeat(501) }), TypeError);
  assert.throws(() => store.getSupervisionEvents('s', 0), TypeError);
  assert.throws(() => store.getSupervisionEvents('s', 201), TypeError);

  store.saveSupervisionTask({ ...task('done-old', 'trim'), phase: 'completed' });
  for (let index = 0; index < 49; index++) store.saveSupervisionTask({ ...task('trim-' + index, 'trim'), phase: 'running', pendingAction: index === 0 ? 'recover' : undefined });
  store.saveSupervisionTask({ ...task('trim-new', 'trim'), phase: 'stopped' });
  const trimmed = store.getSupervisionTasks('trim');
  assert.equal(trimmed.length, 50);
  assert.equal(trimmed.some(item => item.id === 'done-old'), false);
  assert.equal(trimmed.some(item => item.id === 'trim-0' && item.pendingAction === 'recover'), true);
  for (let index = 0; index < 49; index++) store.saveSupervisionTask({ ...task('live-' + index), phase: 'running', pendingAction: index === 0 ? 'correct' : undefined });
  assert.equal(store.getSupervisionTasks('s').length, 50);
  for (let index = 0; index < 49; index++) store.saveSupervisionTask(task('hold-' + index, 'hold'));
  store.saveSupervisionTask({ ...task('hold-pending', 'hold'), phase: 'completed', pendingAction: 'recover' });
  assert.throws(() => store.saveSupervisionTask(task('hold-extra', 'hold')), /capacity/);
  assert.equal(store.getSupervisionTasks('hold').some(item => item.id === 'hold-pending' && item.pendingAction === 'recover'), true);
  assert.throws(() => store.saveSupervisionTask(task('overflow')), /capacity/);
  assert.equal(store.getSupervisionTasks('s').some(item => item.id === 'overflow'), false);
  store.saveSupervisionTask({ ...task('live-0', 's', 4), pendingAction: 'correct', checks: 3 });
  assert.equal(store.getSupervisionTasks('s').find(item => item.id === 'live-0').checks, 3);
  assert.equal(store.getSupervisionTasks('s').length, 50);
  for (let index = 0; index < 205; index++) store.addSupervisionEvent(event('bulk-' + index, index));
  const events = store.getSupervisionEvents('s');
  assert.equal(events.length, 200);
  assert.equal(events[0].id, 'bulk-204');
  assert.equal(store.getLog('route-1').note, 'old note');
  const other = task('other-session', 'other');
  store.saveSupervisionTask(other);
  assert.equal(store.getSupervisionTasks('other').length, 1);
  assert.equal(store.getSupervisionTasks('s').some(item => item.sessionId === 'other'), false);

  const previous = JSON.stringify(store.getSettings());
  ui = await startWeb(() => ({ settings: store.getSettings(), models: [], logs: store.getLogs(), supervision: { tasks: store.getSupervisionTasks('s'), events: store.getSupervisionEvents('s', 20), coverage: ['foreign runners are reported only'] } }), (value, expected) => store.saveSettings(value, expected), () => {});
  const url = new URL(ui.url);
  const authorization = 'Bearer ' + url.hash.slice(1);
  const initial = await fetch(url.origin + '/settings', { headers: { authorization } });
  const etag = initial.headers.get('etag');
  const snapshot = await initial.json();
  assert.equal(snapshot.settings.supervision.enabled, true);
  assert.equal(snapshot.supervision.tasks.length, 50);
  assert.equal(snapshot.supervision.events.length, 20);
  assert.deepEqual(snapshot.supervision.coverage, ['foreign runners are reported only']);
  const changed = { ...snapshot.settings, supervision: { ...snapshot.settings.supervision, enabled: false, mode: 'correct' } };
  const saved = await fetch(url.origin + '/settings', { method: 'PUT', headers: { authorization, 'content-type': 'application/json', 'if-match': etag }, body: JSON.stringify(changed) });
  assert.equal(saved.status, 200);
  assert.equal(store.getSettings().supervision.enabled, false);
  assert.equal((await fetch(url.origin + '/settings', { method: 'PUT', headers: { authorization, 'content-type': 'application/json', 'if-match': etag }, body: JSON.stringify(changed) })).status, 409);
  assert.equal(store.getSettings().instructions, 'keep me');
  assert.equal(JSON.stringify(store.getSettings()), JSON.stringify(store.getSettings()));
  console.log('settings: migration, persistence, retention and ETag conflict passed');
} finally {
  ui?.close();
  store?.close();
  rmSync(dir, { recursive: true, force: true });
}
