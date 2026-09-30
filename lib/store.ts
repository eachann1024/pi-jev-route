import { chmodSync, lstatSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { DEFAULT_SUPERVISION, parseSupervisionSettings } from './supervision-policy.ts';
import type { SupervisionAction, SupervisionEvent, SupervisionSettings, SupervisionTask } from './supervision-types.ts';

export type Settings = {
  enabled: boolean; fallbackModel: string; styleUseMain: boolean; confidenceThreshold: number;
  timeoutMs: number; locale: 'zh' | 'en'; instructions: string; models: Record<string, { enabled: boolean; description: string }>;
  supervision: SupervisionSettings;
};
export const DEFAULTS: Settings = { enabled: true, fallbackModel: '', styleUseMain: true, confidenceThreshold: .55, timeoutMs: 5000, locale: 'en', instructions: '', models: {}, supervision: DEFAULT_SUPERVISION };
export type RouteLog = {
  id: string; at: string | number; sessionId: string; toolCallId: string; agent: string; taskHash: string;
  outcome: 'selected' | 'fallback' | 'explicit' | 'blocked' | 'skipped' | 'error'; requestedModel: string;
  reason: string; note: string; confidence?: number; actualModel?: string; actualThinking?: string; actualStatus?: string;
  audit?: { reasonCode: string; durationMs: number; candidateIds: string[]; fallbackSource: 'configured' | 'low_alias' | 'main' | 'none'; httpStatus?: number; timeoutMs: number; rules: { styleUseMain: boolean; confidenceThreshold: number } };
  asyncId?: string; runId?: string; executionState?: 'not_started' | 'accepted' | 'running' | 'completed' | 'failed' | 'unknown'; updatedAt?: string; evidence?: { source: 'tool_result'; exitCode?: number; resultCount?: number };
};
const modelId = /^[^\s/]+\/[^\s]+$/u;
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new TypeError('必须是普通对象');
  return value as Record<string, unknown>;
}
function keys(value: Record<string, unknown>, allowed: string[]) {
  if (Object.keys(value).some(key => !allowed.includes(key))) throw new TypeError('包含未知字段');
}
function string(value: unknown, max: number): asserts value is string {
  if (typeof value !== 'string' || value.length > max) throw new TypeError('字符串类型或长度无效');
}
function id(value: unknown, empty = false): asserts value is string {
  string(value, 256);
  if (!(empty && value === '') && !modelId.test(value)) throw new TypeError('模型必须是 provider/model，且不能含空白');
}
function range(value: unknown, min: number, max: number): asserts value is number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) throw new TypeError('数值超出范围');
}
export function parseSettings(value: unknown): Settings {
  const input = object(value);
  keys(input, Object.keys(DEFAULTS));
  const { supervision: rawSupervision, ...routing } = input;
  const result = { ...DEFAULTS, ...routing, models: {}, supervision: parseSupervisionSettings(rawSupervision ?? {}) } as Settings;
  for (const key of ['enabled', 'styleUseMain'] as const) if (typeof result[key] !== 'boolean') throw new TypeError('开关必须是布尔值');
  if (result.locale !== 'zh' && result.locale !== 'en') throw new TypeError('语言必须是 zh 或 en');
  id(result.fallbackModel, true);
  range(result.confidenceThreshold, 0, 1);
  range(result.timeoutMs, 1000, 30000);
  if (!Number.isInteger(result.timeoutMs)) throw new TypeError('超时必须是整数');
  string(result.instructions, 2000);
  const models = Object.hasOwn(input, 'models') ? object(input.models) : {};
  if (Object.keys(models).length > 200) throw new TypeError('模型最多 200 个');
  for (const [key, raw] of Object.entries(models)) {
    id(key);
    const model = object(raw);
    keys(model, ['enabled', 'description']);
    if (typeof model.enabled !== 'boolean') throw new TypeError('模型开关必须是布尔值');
    string(model.description, 1000);
    result.models[key] = { enabled: model.enabled, description: model.description };
  }
  return result;
}
const TASK_LIMIT = 50, EVENT_LIMIT = 200, GOAL_LIMIT = 240, MESSAGE_LIMIT = 500, EVIDENCE_LIMIT = 12, EVIDENCE_ITEM_LIMIT = 160;
const phases = ['running', 'suspect', 'waiting', 'correcting', 'recovering', 'completed', 'stopped', 'blocked'];
const actions = ['continue', 'wait', 'correct', 'recover', 'takeover', 'stop', 'insufficient'];
const eventKinds = ['observation', 'decision', 'action', 'result', 'error'];
function boundedText(value: unknown, max: number, label: string): string {
  string(value, max);
  const text = (value as string).replace(/[\u0000-\u001f]/g, ' ');
  if (!text) throw new TypeError(label);
  return text.slice(0, max);
}
function count(value: unknown, max: number, label: string): asserts value is number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > max) throw new TypeError(label);
}
function optionalId(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  return boundedText(value, 256, '标识无效');
}
function redactEvidence(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > EVIDENCE_LIMIT) throw new TypeError('证据数量无效');
  return value.map(item => boundedText(item, EVIDENCE_ITEM_LIMIT, '证据无效').replace(/(?:sk-|key-|secret)[A-Za-z0-9_\-]{8,}/gi, '[redacted]'));
}
function validateTask(value: SupervisionTask): SupervisionTask {
  const row = object(value);
  keys(row, ['id', 'sessionId', 'target', 'runId', 'goal', 'phase', 'startedAt', 'lastActivityAt', 'lastProgressAt', 'lastReviewAt', 'lastReviewedVersion', 'lastReviewedToolCount', 'suspectAt', 'recoveries', 'takeovers', 'interventions', 'checks', 'revision', 'pendingAction', 'pendingIntent', 'rootGoal', 'proofRunId', 'userStopped', 'autoInterventionBlocked', 'chainId', 'lastReason', 'pausedMs', 'budgetPaused', 'lastObservedAt', 'observationGraceUntil', 'lastFeedbackAt', 'lastFeedbackKey', 'softBudgetNotified', 'deadlineNotified', 'lastToolStallKey', 'progressKnown', 'consecutiveFailures', 'failureTool', 'progressDigests', 'suspectReason', 'lastTimingReviewKey', 'terminalObservedAt']);
  if (row.target !== 'main' && row.target !== 'child') throw new TypeError('监督目标无效');
  if (!phases.includes(String(row.phase))) throw new TypeError('任务阶段无效');
  const task: SupervisionTask = {
    id: boundedText(row.id, 256, '任务标识无效'),
    sessionId: boundedText(row.sessionId, 256, '会话标识无效'),
    target: row.target,
    goal: boundedText(row.goal, GOAL_LIMIT, '任务目标无效'),
    phase: row.phase as SupervisionTask['phase'],
    startedAt: 0, lastActivityAt: 0, lastProgressAt: 0, lastReviewAt: 0,
    lastReviewedVersion: 0, lastReviewedToolCount: 0, recoveries: 0, takeovers: 0, interventions: 0, checks: 0, revision: 0,
  };
  for (const key of ['startedAt', 'lastActivityAt', 'lastProgressAt', 'lastReviewAt'] as const) {
    count(row[key], Number.MAX_SAFE_INTEGER, '任务时间无效');
    task[key] = row[key];
  }
  for (const key of ['lastReviewedVersion', 'lastReviewedToolCount', 'recoveries', 'takeovers', 'interventions', 'checks', 'revision'] as const) {
    count(row[key], 1_000_000, '任务计数无效');
    task[key] = row[key];
  }
  const runId = optionalId(row.runId);
  if (runId !== undefined) task.runId = runId;
  if (row.suspectAt !== undefined) { count(row.suspectAt, Number.MAX_SAFE_INTEGER, '可疑时间无效'); task.suspectAt = row.suspectAt; }
  if (row.pendingAction !== undefined) {
    if (!actions.includes(String(row.pendingAction))) throw new TypeError('待执行动作无效');
    task.pendingAction = row.pendingAction as SupervisionTask['pendingAction'];
  }
  if (row.pendingIntent !== undefined) {
    const intent = object(row.pendingIntent);
    keys(intent, ['action', 'reasonCode', 'generation', 'at']);
    if (!actions.includes(String(intent.action))) throw new TypeError('待执行意图无效');
    count(intent.generation, 1_000_000, '意图代际无效');
    count(intent.at, Number.MAX_SAFE_INTEGER, '意图时间无效');
    task.pendingIntent = { action: intent.action as SupervisionAction, reasonCode: boundedText(intent.reasonCode, 64, '原因码无效'), generation: intent.generation, at: intent.at };
  }
  if (row.rootGoal !== undefined) task.rootGoal = boundedText(row.rootGoal, GOAL_LIMIT, '任务目标无效');
  if (row.proofRunId !== undefined) task.proofRunId = optionalId(row.proofRunId) ?? (() => { throw new TypeError('证明运行无效'); })();
  if (row.userStopped !== undefined) { if (typeof row.userStopped !== 'boolean') throw new TypeError('用户停止标记无效'); task.userStopped = row.userStopped; }
  if (row.autoInterventionBlocked !== undefined) { if (typeof row.autoInterventionBlocked !== 'boolean') throw new TypeError('自动干预标记无效'); task.autoInterventionBlocked = row.autoInterventionBlocked; }
  if (row.chainId !== undefined) task.chainId = optionalId(row.chainId) ?? (() => { throw new TypeError('任务链标识无效'); })();
  if (row.lastReason !== undefined) task.lastReason = boundedText(row.lastReason, 64, '原因码无效');
  for (const key of ['pausedMs', 'lastObservedAt', 'observationGraceUntil', 'lastFeedbackAt', 'consecutiveFailures', 'terminalObservedAt'] as const) if (row[key] !== undefined) {
    count(row[key], Number.MAX_SAFE_INTEGER, '监督时间或计数无效'); task[key] = row[key];
  }
  for (const key of ['budgetPaused', 'softBudgetNotified', 'deadlineNotified', 'progressKnown'] as const) if (row[key] !== undefined) {
    if (typeof row[key] !== 'boolean') throw new TypeError('监督标记无效'); task[key] = row[key];
  }
  for (const key of ['lastFeedbackKey', 'lastToolStallKey', 'failureTool', 'suspectReason', 'lastTimingReviewKey'] as const) if (row[key] !== undefined) task[key] = boundedText(row[key], 256, '监督事实无效');
  if (row.progressDigests !== undefined) {
    if (!Array.isArray(row.progressDigests) || row.progressDigests.length > 32 || row.progressDigests.some(value => typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value))) throw new TypeError('进展摘要无效');
    task.progressDigests = [...row.progressDigests] as string[];
  }
  return task;
}
function validateEvent(value: SupervisionEvent): SupervisionEvent {
  const row = object(value);
  keys(row, ['id', 'at', 'sessionId', 'taskId', 'target', 'runId', 'kind', 'action', 'reasonCode', 'message', 'evidence', 'scores']);
  count(row.at, Number.MAX_SAFE_INTEGER, '事件时间无效');
  if (row.target !== 'main' && row.target !== 'child') throw new TypeError('监督目标无效');
  if (!eventKinds.includes(String(row.kind))) throw new TypeError('事件类型无效');
  const event: SupervisionEvent = {
    id: boundedText(row.id, 256, '事件标识无效'),
    at: row.at as number,
    sessionId: boundedText(row.sessionId, 256, '会话标识无效'),
    taskId: boundedText(row.taskId, 256, '任务标识无效'),
    target: row.target,
    kind: row.kind as SupervisionEvent['kind'],
    reasonCode: boundedText(row.reasonCode, 64, '原因码无效'),
    message: boundedText(row.message, MESSAGE_LIMIT, '事件说明无效'),
  };
  const runId = optionalId(row.runId);
  if (runId !== undefined) event.runId = runId;
  if (row.action !== undefined) {
    if (!actions.includes(String(row.action))) throw new TypeError('事件动作无效');
    event.action = row.action as SupervisionEvent['action'];
  }
  const evidence = redactEvidence(row.evidence);
  if (evidence) event.evidence = evidence;
  if (row.scores !== undefined) {
    const scores = object(row.scores);
    keys(scores, ['alignment', 'progress', 'constraints']);
    for (const key of ['alignment', 'progress', 'constraints'] as const) range(scores[key], 0, 1);
    event.scores = { alignment: scores.alignment as number, progress: scores.progress as number, constraints: scores.constraints as number };
  }
  return event;
}
function validateLog(value: RouteLog): RouteLog {
  const row = object(value);
  keys(row, ['id', 'at', 'sessionId', 'toolCallId', 'agent', 'taskHash', 'outcome', 'requestedModel', 'reason', 'note', 'confidence', 'actualModel', 'actualThinking', 'actualStatus', 'audit', 'asyncId', 'runId', 'executionState', 'updatedAt', 'evidence']);
  for (const key of ['id', 'sessionId', 'toolCallId', 'agent', 'taskHash', 'requestedModel', 'reason', 'note'] as const) string(row[key], key === 'note' ? 1000 : 4096);
  if (!value.id || !['selected', 'fallback', 'explicit', 'blocked', 'skipped', 'error'].includes(value.outcome)) throw new TypeError('日志身份或状态无效');
  if (typeof value.at !== 'string' && (typeof value.at !== 'number' || !Number.isFinite(value.at))) throw new TypeError('日志时间无效');
  if (value.confidence !== undefined) range(value.confidence, 0, 1);
  for (const key of ['actualModel', 'actualThinking', 'actualStatus'] as const) if (row[key] !== undefined) string(row[key], 1000);
  if (row.asyncId !== undefined) string(row.asyncId, 256);
  if (row.runId !== undefined) string(row.runId, 256);
  if (row.executionState !== undefined && !['not_started', 'accepted', 'running', 'completed', 'failed', 'unknown'].includes(String(row.executionState))) throw new TypeError('执行状态无效');
  if (row.updatedAt !== undefined) string(row.updatedAt, 64);
  if (row.evidence !== undefined) { const evidence = object(row.evidence); keys(evidence, ['source', 'exitCode', 'resultCount']); if (evidence.source !== 'tool_result') throw new TypeError('证据来源无效'); if (evidence.exitCode !== undefined && (typeof evidence.exitCode !== 'number' || !Number.isInteger(evidence.exitCode))) throw new TypeError('退出码无效'); if (evidence.resultCount !== undefined && (!Number.isInteger(evidence.resultCount) || Number(evidence.resultCount) < 0 || Number(evidence.resultCount) > 100)) throw new TypeError('结果数量无效'); }
  if (row.audit !== undefined) {
    const audit = object(row.audit);
    keys(audit, ['reasonCode', 'durationMs', 'candidateIds', 'fallbackSource', 'httpStatus', 'timeoutMs', 'rules']);
    string(audit.reasonCode, 64); range(audit.durationMs, 0, 3600000);
    if (audit.timeoutMs !== undefined) { range(audit.timeoutMs, 1000, 30000); if (!Number.isInteger(audit.timeoutMs)) throw new TypeError('超时快照无效'); }
    if (audit.httpStatus !== undefined) { range(audit.httpStatus, 100, 599); if (!Number.isInteger(audit.httpStatus)) throw new TypeError('HTTP 状态无效'); }
    if (!Number.isInteger(audit.durationMs) || !Array.isArray(audit.candidateIds) || audit.candidateIds.length > 200) throw new TypeError('审计字段无效');
    for (const candidate of audit.candidateIds) id(candidate);
    if (!['configured', 'low_alias', 'main', 'none'].includes(String(audit.fallbackSource))) throw new TypeError('回退来源无效');
    if (audit.rules !== undefined) {
      const rules = object(audit.rules); keys(rules, ['styleUseMain', 'confidenceThreshold']);
      if (typeof rules.styleUseMain !== 'boolean') throw new TypeError('规则快照无效');
      range(rules.confidenceThreshold, 0, 1);
    }
  }
  return value;
}
function stored<T>(json: string, validate: (value: any) => T): T {
  try { return validate(JSON.parse(json)); }
  catch (error) { throw new Error('数据库中保存的数据无效', { cause: error }); }
}
export function openStore(path: string) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  chmodSync(dirname(path), 0o700);
  try { if (!lstatSync(path).isFile()) throw new Error('数据库路径必须是普通文件'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const db = new DatabaseSync(path);
  try {
    chmodSync(path, 0o600);
    db.exec('PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL;');
    db.exec('CREATE TABLE IF NOT EXISTS settings (id INTEGER PRIMARY KEY CHECK(id=1), json TEXT NOT NULL); CREATE TABLE IF NOT EXISTS logs (id TEXT PRIMARY KEY, json TEXT NOT NULL); CREATE TABLE IF NOT EXISTS plugin_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL); CREATE TABLE IF NOT EXISTS supervision_tasks (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, json TEXT NOT NULL); CREATE TABLE IF NOT EXISTS supervision_events (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, task_id TEXT NOT NULL, at INTEGER NOT NULL, json TEXT NOT NULL);');
    db.exec('CREATE INDEX IF NOT EXISTS supervision_tasks_session ON supervision_tasks(session_id); CREATE INDEX IF NOT EXISTS supervision_events_session_at ON supervision_events(session_id, at DESC);');
    const saved = db.prepare('SELECT json FROM settings WHERE id=1').get();
    if (saved) stored(saved.json as string, parseSettings);
    transaction(() => {
      if (!db.prepare("SELECT 1 FROM plugin_metadata WHERE key='onboarding-state'").get()) {
        const legacy = saved || db.prepare('SELECT 1 FROM logs LIMIT 1').get();
        db.prepare("INSERT INTO plugin_metadata(key,value) VALUES('onboarding-state',?)").run(legacy ? 'legacy' : 'pending');
        if (legacy) db.prepare("INSERT OR IGNORE INTO plugin_metadata(key,value) VALUES('onboarding-complete','yes')").run();
      }
    });
  } catch (error) { db.close(); throw error; }
  function transaction<T>(run: () => T): T {
    db.exec('BEGIN IMMEDIATE');
    try { const result = run(); db.exec('COMMIT'); return result; }
    catch (error) { db.exec('ROLLBACK'); throw error; }
  }
  function getSettings(): Settings {
    const row = db.prepare('SELECT json FROM settings WHERE id=1').get();
    return row ? stored(row.json as string, parseSettings) : parseSettings({});
  }
  function getLog(id: string): RouteLog | undefined {
    string(id, 4096);
    const row = db.prepare('SELECT json FROM logs WHERE id=?').get(id);
    return row ? stored(row.json as string, validateLog) : undefined;
  }
  function edit(id: string, change: (log: RouteLog) => RouteLog) {
    transaction(() => {
      const log = getLog(id);
      if (!log) throw new TypeError('日志不存在');
      db.prepare('UPDATE logs SET json=? WHERE id=?').run(JSON.stringify(validateLog(change(log))), id);
    });
  }
  return {
    getSettings, getLog,
    claimOnboarding(owner: string, now = Date.now()): boolean {
      return transaction(() => {
        if (db.prepare("SELECT 1 FROM plugin_metadata WHERE key='onboarding-complete'").get()) return false;
        const row = db.prepare("SELECT value FROM plugin_metadata WHERE key='onboarding-lease'").get();
        if (row) { const lease = JSON.parse(String(row.value)); if (lease.until > now) return false; }
        db.prepare("INSERT INTO plugin_metadata(key,value) VALUES('onboarding-lease',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(JSON.stringify({ owner, until: now + 300000 }));
        return true;
      });
    },
    releaseOnboarding(owner: string) {
      transaction(() => {
        const row = db.prepare("SELECT value FROM plugin_metadata WHERE key='onboarding-lease'").get();
        if (row && JSON.parse(String(row.value)).owner === owner) db.prepare("DELETE FROM plugin_metadata WHERE key='onboarding-lease'").run();
      });
    },
    getMetadata(key: string): string | undefined { string(key, 128); const row = db.prepare('SELECT value FROM plugin_metadata WHERE key=?').get(key); return row?.value as string | undefined; },
    setMetadata(key: string, value: string) { string(key, 128); string(value, 1024); db.prepare('INSERT INTO plugin_metadata(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, value); },
    findLog(reference: string): { log?: RouteLog; ambiguous: boolean } {
      string(reference, 256);
      if (!reference) return { ambiguous: false };
      const exact = getLog(reference);
      if (exact) return { log: exact, ambiguous: false };
      const rows = db.prepare('SELECT json FROM logs WHERE substr(id, 1, length(?))=? LIMIT 2').all(reference, reference);
      if (rows.length > 1) return { ambiguous: true };
      return { log: rows[0] ? stored(rows[0].json as string, validateLog) : undefined, ambiguous: false };
    },
    getLatestLog(): RouteLog | undefined {
      const row = db.prepare('SELECT json FROM logs ORDER BY rowid DESC LIMIT 1').get();
      return row ? stored(row.json as string, validateLog) : undefined;
    },
    saveSettings(value: unknown, expectedJson?: string) {
      const settings = parseSettings(value);
      if (expectedJson !== undefined) string(expectedJson, 300000);
      transaction(() => {
        if (expectedJson !== undefined && JSON.stringify(getSettings()) !== expectedJson) throw new Error('conflict');
        db.prepare('INSERT INTO settings(id,json) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET json=excluded.json').run(JSON.stringify(settings));
      });
    },
    addLog(log: RouteLog) { db.prepare('INSERT INTO logs(id,json) VALUES(?,?)').run(validateLog(log).id, JSON.stringify(log)); },
    updateLog(id: string, patch: Partial<Pick<RouteLog, 'actualModel' | 'actualThinking' | 'actualStatus' | 'asyncId' | 'runId' | 'executionState' | 'updatedAt' | 'evidence'>>) {
      const valid = object(patch);
      keys(valid, ['actualModel', 'actualThinking', 'actualStatus', 'asyncId', 'runId', 'executionState', 'updatedAt', 'evidence']);
      for (const key of ['actualModel', 'actualThinking', 'actualStatus', 'asyncId', 'runId'] as const) if (valid[key] !== undefined) string(valid[key], 1000);
      edit(id, log => ({ ...log, ...patch }));
    },
    setNote(id: string, note: string, expectedNote?: string) {
      string(note, 1000);
      if (expectedNote !== undefined) string(expectedNote, 1000);
      edit(id, log => {
        if (expectedNote !== undefined && log.note !== expectedNote) throw new Error('conflict');
        return { ...log, note };
      });
    },
    getLogsBySession(sessionId: string, limit = 20): RouteLog[] {
      string(sessionId, 256);
      range(limit, 1, 100);
      if (!Number.isInteger(limit)) throw new TypeError('条数必须是整数');
      return db.prepare("SELECT json FROM logs WHERE json_extract(json, '$.sessionId')=? ORDER BY rowid DESC LIMIT ?")
        .all(sessionId, limit).map(row => stored(row.json as string, validateLog));
    },
    findLogById(id: string, sessionId?: string): RouteLog | undefined {
      string(id, 4096);
      if (sessionId === undefined) return getLog(id);
      string(sessionId, 256);
      const row = db.prepare("SELECT json FROM logs WHERE id=? AND json_extract(json, '$.sessionId')=?").get(id, sessionId);
      return row ? stored(row.json as string, validateLog) : undefined;
    },
    getLogs(limit = 100): RouteLog[] {
      range(limit, 1, 1000);
      if (!Number.isInteger(limit)) throw new TypeError('条数必须是整数');
      return db.prepare('SELECT json FROM logs ORDER BY rowid DESC LIMIT ?').all(limit).map(row => stored(row.json as string, validateLog));
    },
    getSupervisionTasks(sessionId: string): SupervisionTask[] {
      string(sessionId, 256);
      return db.prepare('SELECT json FROM supervision_tasks WHERE session_id=? ORDER BY rowid DESC')
        .all(sessionId).map(row => stored(row.json as string, validateTask));
    },
    saveSupervisionTask(task: SupervisionTask) {
      const valid = validateTask(task);
      transaction(() => {
        const rows = db.prepare('SELECT id,json FROM supervision_tasks WHERE session_id=? ORDER BY rowid ASC').all(valid.sessionId)
          .map(row => ({ id: String(row.id), task: stored(row.json as string, validateTask) }));
        const known = rows.some(row => row.id === valid.id);
        const projected = known ? rows.length : rows.length + 1;
        const removable = rows.filter(row => row.id !== valid.id && !row.task.pendingAction && ['completed', 'stopped', 'blocked'].includes(row.task.phase));
        const overflow = projected - TASK_LIMIT;
        if (overflow > removable.length) throw new Error('supervision task capacity reached');
        for (const row of removable.slice(0, Math.max(0, overflow))) db.prepare('DELETE FROM supervision_tasks WHERE id=?').run(row.id);
        db.prepare('INSERT INTO supervision_tasks(id,session_id,json) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET session_id=excluded.session_id, json=excluded.json').run(valid.id, valid.sessionId, JSON.stringify(valid));
      });
    },
    addSupervisionEvent(event: SupervisionEvent) {
      const valid = validateEvent(event);
      transaction(() => {
        db.prepare('INSERT INTO supervision_events(id,session_id,task_id,at,json) VALUES(?,?,?,?,?)').run(valid.id, valid.sessionId, valid.taskId, valid.at, JSON.stringify(valid));
        const overflow = db.prepare('SELECT id FROM supervision_events WHERE session_id=? ORDER BY at DESC, rowid DESC LIMIT -1 OFFSET ?').all(valid.sessionId, EVENT_LIMIT);
        for (const row of overflow) db.prepare('DELETE FROM supervision_events WHERE id=?').run(row.id);
      });
    },
    getSupervisionEvents(sessionId?: string, limit = EVENT_LIMIT): SupervisionEvent[] {
      if (sessionId !== undefined) string(sessionId, 256);
      range(limit, 1, EVENT_LIMIT);
      if (!Number.isInteger(limit)) throw new TypeError('条数必须是整数');
      const rows = sessionId === undefined
        ? db.prepare('SELECT json FROM supervision_events ORDER BY at DESC, rowid DESC LIMIT ?').all(limit)
        : db.prepare('SELECT json FROM supervision_events WHERE session_id=? ORDER BY at DESC, rowid DESC LIMIT ?').all(sessionId, limit);
      return rows.map(row => stored(row.json as string, validateEvent));
    },
    close() { db.close(); },
  };
}
