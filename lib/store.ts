import { chmodSync, lstatSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export type Settings = {
  enabled: boolean; fallbackModel: string; styleUseMain: boolean; confidenceThreshold: number;
  timeoutMs: number; locale: 'zh' | 'en'; instructions: string; models: Record<string, { enabled: boolean; description: string }>;
};
export const DEFAULTS: Settings = { enabled: true, fallbackModel: '', styleUseMain: true, confidenceThreshold: .55, timeoutMs: 5000, locale: 'zh', instructions: '', models: {} };
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
  const result = { ...DEFAULTS, ...input, models: {} } as Settings;
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
    db.exec('CREATE TABLE IF NOT EXISTS settings (id INTEGER PRIMARY KEY CHECK(id=1), json TEXT NOT NULL); CREATE TABLE IF NOT EXISTS logs (id TEXT PRIMARY KEY, json TEXT NOT NULL);');
    const saved = db.prepare('SELECT json FROM settings WHERE id=1').get();
    if (saved) stored(saved.json as string, parseSettings);
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
    findLog(reference: string): { log?: RouteLog; ambiguous: boolean } {
      string(reference, 256);
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
    close() { db.close(); },
  };
}
