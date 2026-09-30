import type { SupervisionAction, SupervisionDecision, SupervisionObservation, SupervisionSettings, SupervisionTask } from './supervision-types.ts';

export const DEFAULT_SUPERVISION: SupervisionSettings = {
  enabled: true,
  mode: 'recover',
  monitorMain: true,
  monitorChildren: true,
  allowMainTakeover: false,
  correctionModel: '',
  correctionThinking: 'high',
  feedbackAfterMs: 30_000,
  feedbackIntervalMs: 60_000,
  noProgressMs: 180_000,
  toolStallMs: 300_000,
  softBudgetMs: 600_000,
  repeatFailureLimit: 3,
  pollMs: 5_000,
  idleMs: 45_000,
  deepThinkingIdleMs: 120_000,
  recheckMs: 15_000,
  reviewIntervalMs: 120_000,
  reviewEveryTools: 8,
  handoffMs: 5_000,
  maxRecoveries: 2,
  maxTakeovers: 1,
  maxInterventions: 3,
  maxTaskMs: 1_800_000,
  decisionTimeoutMs: 5_000,
  maxChecksPerTask: 30,
};

/** Explicit numeric shortcuts; runtime policy never classifies task text. */
const timingDefaults = {
  pollMs: DEFAULT_SUPERVISION.pollMs, idleMs: DEFAULT_SUPERVISION.idleMs,
  deepThinkingIdleMs: DEFAULT_SUPERVISION.deepThinkingIdleMs, recheckMs: DEFAULT_SUPERVISION.recheckMs,
  handoffMs: DEFAULT_SUPERVISION.handoffMs, feedbackAfterMs: DEFAULT_SUPERVISION.feedbackAfterMs,
  feedbackIntervalMs: DEFAULT_SUPERVISION.feedbackIntervalMs, noProgressMs: DEFAULT_SUPERVISION.noProgressMs,
  toolStallMs: DEFAULT_SUPERVISION.toolStallMs, softBudgetMs: DEFAULT_SUPERVISION.softBudgetMs,
  repeatFailureLimit: DEFAULT_SUPERVISION.repeatFailureLimit, maxTaskMs: DEFAULT_SUPERVISION.maxTaskMs,
};
export const SUPERVISION_TIMING_PRESETS = {
  adaptive: { ...timingDefaults },
  quick: { ...timingDefaults, softBudgetMs: 120_000, noProgressMs: 60_000, toolStallMs: 180_000, deepThinkingIdleMs: 90_000, idleMs: 30_000 },
  long: { ...timingDefaults, softBudgetMs: 1_800_000, noProgressMs: 600_000, toolStallMs: 900_000, deepThinkingIdleMs: 300_000, idleMs: 90_000, maxTaskMs: 7_200_000 },
} as const;

export function activeElapsedMs(task: SupervisionTask, now: number): number {
  return Math.max(0, now - task.startedAt - (task.pausedMs ?? 0) - (task.budgetPaused ? Math.max(0, now - (task.lastObservedAt ?? now)) : 0));
}

const MODES = ['observe', 'correct', 'recover'] as const;
const THINKING = ['off', 'low', 'medium', 'high'] as const;
const ACTIONS = ['continue', 'wait', 'correct', 'recover', 'takeover', 'stop', 'insufficient'] as const;
const TIMING_KEYS = ['feedbackAfterMs', 'feedbackIntervalMs', 'noProgressMs', 'toolStallMs', 'softBudgetMs', 'pollMs', 'idleMs', 'deepThinkingIdleMs', 'recheckMs', 'reviewIntervalMs', 'handoffMs', 'maxTaskMs', 'decisionTimeoutMs'] as const;
const COUNT_KEYS = ['repeatFailureLimit', 'reviewEveryTools', 'maxRecoveries', 'maxTakeovers', 'maxInterventions', 'maxChecksPerTask'] as const;
const MODEL_ID = /^[^\s/]+\/[^\s]+$/u;
const LIMITS = {
  feedbackAfterMs: [1_000, 3_600_000], feedbackIntervalMs: [1_000, 3_600_000], noProgressMs: [1_000, 3_600_000],
  toolStallMs: [1_000, 3_600_000], softBudgetMs: [1_000, 86_400_000], repeatFailureLimit: [2, 20],
  pollMs: [1_000, 60_000], idleMs: [1_000, 3_600_000], deepThinkingIdleMs: [1_000, 3_600_000], recheckMs: [1_000, 300_000],
  reviewIntervalMs: [1_000, 3_600_000], handoffMs: [1_000, 3_600_000], maxTaskMs: [1_000, 86_400_000], decisionTimeoutMs: [1_000, 30_000],
  reviewEveryTools: [1, 1_000], maxRecoveries: [0, 100], maxTakeovers: [0, 100], maxInterventions: [0, 100], maxChecksPerTask: [1, 1_000],
} as const;
const BOOLEAN_KEYS = ['enabled', 'monitorMain', 'monitorChildren', 'allowMainTakeover'] as const;
const KNOWN_KEYS = new Set<string>([...BOOLEAN_KEYS, 'mode', 'correctionModel', 'correctionThinking', ...TIMING_KEYS, ...COUNT_KEYS]);
const TERMINAL = new Set(['completed', 'stopped', 'blocked']);
const DESTRUCTIVE = new Set<SupervisionAction>(['correct', 'recover', 'takeover', 'stop']);

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}
function copySettings(settings: SupervisionSettings): SupervisionSettings {
  return { ...settings };
}
function invalid(message: string): never {
  throw new TypeError(message);
}

export function parseSupervisionSettings(value: unknown): SupervisionSettings {
  const settings = copySettings(DEFAULT_SUPERVISION);
  if (value == null) return settings;
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid('supervision settings must be an object');
  const source = value as Record<string, unknown>;
  for (const key of Object.keys(source)) if (!KNOWN_KEYS.has(key)) invalid(`unknown supervision setting: ${key}`);
  for (const key of BOOLEAN_KEYS) if (key in source) {
    if (typeof source[key] !== 'boolean') invalid(`${key} must be boolean`);
    settings[key] = source[key];
  }
  if ('mode' in source) {
    if (typeof source.mode !== 'string' || !MODES.includes(source.mode as typeof MODES[number])) invalid('mode is invalid');
    settings.mode = 'recover';
  }
  if ('correctionModel' in source) {
    if (typeof source.correctionModel !== 'string' || !(source.correctionModel === '' || MODEL_ID.test(source.correctionModel))) invalid('correctionModel is invalid');
    settings.correctionModel = source.correctionModel;
  }
  if ('correctionThinking' in source) {
    if (typeof source.correctionThinking !== 'string' || !THINKING.includes(source.correctionThinking as typeof THINKING[number])) invalid('correctionThinking is invalid');
    settings.correctionThinking = source.correctionThinking as SupervisionSettings['correctionThinking'];
  }
  for (const key of [...TIMING_KEYS, ...COUNT_KEYS]) if (key in source) {
    const number = source[key];
    const [min, max] = LIMITS[key];
    if (!finite(number) || !Number.isInteger(number) || number < min || number > max) invalid(`${key} is invalid`);
    settings[key] = number;
  }
  if (!(settings.deepThinkingIdleMs >= settings.idleMs)) invalid('deepThinkingIdleMs must be at least idleMs');
  return settings;
}

function observation(value: SupervisionObservation): SupervisionObservation {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid('observation is invalid');
  if (typeof value.taskId !== 'string' || !value.taskId || value.taskId.length > 256) invalid('task id is invalid');
  if (typeof value.sessionId !== 'string' || !value.sessionId || value.sessionId.length > 256) invalid('session id is invalid');
  if (value.target !== 'main' && value.target !== 'child') invalid('target is invalid');
  if (value.runId !== undefined && (typeof value.runId !== 'string' || !value.runId || value.runId.length > 256)) invalid('run id is invalid');
  if (typeof value.goal !== 'string') invalid('goal is invalid');
  if (!Array.isArray(value.evidence) || value.evidence.some(item => typeof item !== 'string')) invalid('evidence is invalid');
  for (const key of ['now', 'startedAt', 'lastActivityAt', 'lastProgressAt'] as const) if (!finite(value[key])) invalid(`${key} is invalid`);
  for (const key of ['progressKnown', 'waitingForSupervisor'] as const) if (value[key] !== undefined && typeof value[key] !== 'boolean') invalid(`${key} is invalid`);
  if (value.activeToolStartedAt !== undefined && (!Number.isSafeInteger(value.activeToolStartedAt) || value.activeToolStartedAt < 0)) invalid('tool start is invalid');
  if (value.consecutiveFailures !== undefined && (!Number.isSafeInteger(value.consecutiveFailures) || value.consecutiveFailures < 0)) invalid('failure count is invalid');
  if (value.failureTool !== undefined && typeof value.failureTool !== 'string') invalid('failure tool is invalid');
  if (!Number.isInteger(value.toolCount) || value.toolCount < 0) invalid('tool count is invalid');
  if (!Array.isArray(value.activeTools) || value.activeTools.some(item => typeof item !== 'string')) invalid('active tools are invalid');
  if (value.thinking !== undefined && typeof value.thinking !== 'string') invalid('thinking is invalid');
  if (!['running', 'queued', 'paused', 'completed', 'failed', 'stopped', 'unknown'].includes(value.lifecycle)) invalid('lifecycle is invalid');
  if (typeof value.waitingForUser !== 'boolean' || typeof value.waitingForChildren !== 'boolean') invalid('wait flags are invalid');
  if (value.processTerminal !== 'observed' && value.processTerminal !== 'unknown') invalid('process proof is invalid');
  const capability = value.capability;
  if (!capability || typeof capability !== 'object' || ['steer', 'interrupt', 'resume', 'replace'].some(key => typeof capability[key as keyof typeof capability] !== 'boolean')) invalid('capability is invalid');
  if (!Number.isInteger(value.evidenceVersion) || value.evidenceVersion < 0) invalid('evidence version is invalid');
  return value;
}
function taskState(value: SupervisionTask): SupervisionTask {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid('task is invalid');
  if (typeof value.id !== 'string' || !value.id) invalid('task id is invalid');
  if (!['running', 'suspect', 'waiting', 'correcting', 'recovering', 'completed', 'stopped', 'blocked'].includes(value.phase)) invalid('phase is invalid');
  for (const key of ['recoveries', 'takeovers', 'interventions', 'checks', 'revision', 'lastReviewedVersion', 'lastReviewedToolCount'] as const) if (!Number.isInteger(value[key]) || value[key] < 0) invalid(`${key} is invalid`);
  return value;
}

export function createSupervisionTask(input: SupervisionObservation): SupervisionTask {
  const seen = observation(input);
  return {
    id: seen.taskId,
    sessionId: seen.sessionId,
    target: seen.target,
    ...(seen.runId === undefined ? {} : { runId: seen.runId }),
    goal: seen.goal,
    phase: seen.lifecycle === 'completed' ? 'completed' : seen.lifecycle === 'stopped' ? 'stopped' : 'running',
    startedAt: seen.startedAt,
    lastActivityAt: seen.lastActivityAt,
    lastProgressAt: seen.lastProgressAt,
    lastReviewAt: seen.startedAt,
    lastReviewedVersion: 0,
    lastReviewedToolCount: 0,
    recoveries: 0,
    takeovers: 0,
    interventions: 0,
    checks: 0,
    revision: 0,
  };
}

function monitored(settings: SupervisionSettings, target: SupervisionObservation['target']): boolean {
  return target === 'main' ? settings.monitorMain : settings.monitorChildren;
}
function deepThinking(input: SupervisionObservation): boolean {
  return Boolean(input.thinking && input.thinking !== 'off');
}
function idleLimit(settings: SupervisionSettings, input: SupervisionObservation): number {
  return deepThinking(input) ? settings.deepThinkingIdleMs : settings.idleMs;
}
function quietFor(input: SupervisionObservation): number {
  return input.now - Math.max(input.lastActivityAt, input.lastProgressAt);
}
function alive(input: SupervisionObservation): boolean {
  return input.lifecycle === 'running' || input.lifecycle === 'paused';
}
function allowed(settings: SupervisionSettings, input: SupervisionObservation, action: SupervisionAction): boolean {
  if (action === 'continue' || action === 'wait' || action === 'insufficient') return true;
  if (settings.mode === 'observe' || !settings.enabled || !monitored(settings, input.target) || input.lifecycle === 'unknown') return false;
  if (input.lifecycle === 'failed' && input.processTerminal !== 'observed') return false;
  if (action === 'stop') return (settings.mode === 'correct' || settings.mode === 'recover') && alive(input);
  if (action === 'correct') return (settings.mode === 'correct' || settings.mode === 'recover') && input.lifecycle === 'running' && input.capability.steer;
  if (action === 'recover') return settings.mode === 'recover' && alive(input) && input.capability.interrupt && input.capability.resume;
  return action === 'takeover' && input.processTerminal === 'observed' && settings.mode === 'recover' && (input.target === 'child' || settings.allowMainTakeover) && input.capability.replace && Boolean(settings.correctionModel);
}

export function timingReviewKey(task: SupervisionTask, seen: SupervisionObservation): string {
  return `${task.suspectReason ?? 'idle'}:${seen.lastProgressAt}:${seen.consecutiveFailures ?? 0}:${seen.lifecycle}:${task.suspectReason === 'no_progress' || task.suspectReason === 'progress_unknown' || task.suspectReason === 'repeated_tool_failure' ? 0 : seen.lastActivityAt}`;
}

export function planSupervisionCheck(task: SupervisionTask, input: SupervisionObservation, rawSettings: SupervisionSettings): { kind: 'none' | 'suspect' | 'review' | 'stop'; reasonCode: string } {
  const current = taskState(task);
  const seen = observation(input);
  const settings = parseSupervisionSettings(rawSettings);
  if (!settings.enabled || !monitored(settings, seen.target)) return { kind: 'none', reasonCode: 'supervision_disabled' };
  if (current.id !== seen.taskId || current.sessionId !== seen.sessionId || current.target !== seen.target || current.runId !== seen.runId) return { kind: 'none', reasonCode: 'identity_mismatch' };
  if (current.pendingAction) return { kind: 'none', reasonCode: 'action_in_flight' };
  if (TERMINAL.has(current.phase) || seen.lifecycle === 'completed' || seen.lifecycle === 'stopped') return { kind: 'none', reasonCode: 'terminal' };
  if (current.checks >= settings.maxChecksPerTask) return { kind: 'none', reasonCode: 'check_cap' };
  if (seen.waitingForSupervisor) return { kind: 'none', reasonCode: 'waiting_for_supervisor' };
  if (seen.waitingForUser) return { kind: 'none', reasonCode: 'waiting_for_user' };
  if (seen.waitingForChildren) return { kind: 'none', reasonCode: 'waiting_for_children' };
  if (activeElapsedMs(current, seen.now) >= settings.maxTaskMs) return { kind: 'none', reasonCode: 'task_deadline' };
  if (seen.lifecycle === 'paused' || seen.lifecycle === 'queued') return { kind: 'none', reasonCode: 'not_running' };
  if (seen.lifecycle === 'unknown' || seen.lifecycle === 'failed' && seen.processTerminal !== 'observed') return { kind: 'suspect', reasonCode: 'unknown_lifecycle' };
  if (seen.now < (current.observationGraceUntil ?? 0)) return { kind: 'none', reasonCode: 'observation_grace' };
  if (seen.activeTools.length > 0) return { kind: 'none', reasonCode: seen.activeToolStartedAt !== undefined && seen.now - seen.activeToolStartedAt >= settings.toolStallMs ? 'tool_stall' : 'tool_active' };
  const noProgress = seen.now - seen.lastProgressAt >= settings.noProgressMs;
  const repeatedFailure = (seen.consecutiveFailures ?? 0) >= settings.repeatFailureLimit;
  const stalled = noProgress || repeatedFailure;
  const newEvidence = seen.evidenceVersion > current.lastReviewedVersion;
  const backoff = seen.now - current.lastReviewAt >= settings.recheckMs;
  const idle = quietFor(seen) >= idleLimit(settings, seen);
  const reviewDue = seen.now - current.lastReviewAt >= settings.reviewIntervalMs;
  const toolDue = seen.toolCount - current.lastReviewedToolCount >= settings.reviewEveryTools && seen.evidenceVersion > current.lastReviewedVersion;
  const resumed = !stalled && current.suspectAt !== undefined && (seen.lastActivityAt > current.suspectAt || seen.lastProgressAt > current.suspectAt || seen.toolCount > current.lastReviewedToolCount);
  if (resumed && current.phase === 'suspect') return { kind: 'none', reasonCode: 'activity_cleared_suspect' };
  const suspectDue = current.phase === 'suspect' && current.suspectAt !== undefined && !resumed && seen.now - current.suspectAt >= settings.recheckMs;
  const handoffDue = seen.lifecycle === 'failed' && seen.processTerminal === 'observed' && quietFor(seen) >= settings.handoffMs;
  if (current.checks > 0 && (suspectDue || handoffDue) && (!backoff || !newEvidence && current.lastTimingReviewKey === timingReviewKey(current, seen))) return { kind: 'none', reasonCode: 'review_backoff' };
  if (handoffDue) return { kind: 'review', reasonCode: 'failed_handoff' };
  if (suspectDue) return { kind: 'review', reasonCode: 'suspect_recheck' };
  if (current.phase === 'suspect') return { kind: 'none', reasonCode: 'suspect_waiting' };
  if (stalled) return { kind: 'suspect', reasonCode: repeatedFailure ? 'repeated_tool_failure' : seen.progressKnown === false ? 'progress_unknown' : 'no_progress' };
  if (idle) return { kind: 'suspect', reasonCode: deepThinking(seen) ? 'deep_thinking_idle' : 'idle_timeout' };
  if ((reviewDue || toolDue) && seen.evidenceVersion > current.lastReviewedVersion) return { kind: 'review', reasonCode: toolDue ? 'tool_review' : 'interval_review' };
  return { kind: 'none', reasonCode: 'within_bounds' };
}

function decision(action: SupervisionAction, reasonCode: string, evidenceIds: number[] = [], scores?: SupervisionDecision['scores']): SupervisionDecision {
  return { action, reasonCode, evidenceIds: [...new Set(evidenceIds)].filter(id => Number.isInteger(id) && id >= 0), ...(scores ? { scores } : {}) };
}
function score(value: unknown): number | undefined {
  return finite(value) && value >= 0 && value <= 1 ? value : undefined;
}

export function constrainSupervisionDecision(task: SupervisionTask, input: SupervisionObservation, rawSettings: SupervisionSettings, rawDecision: SupervisionDecision): SupervisionDecision {
  const current = taskState(task);
  const seen = observation(input);
  const settings = parseSupervisionSettings(rawSettings);
  if (!rawDecision || typeof rawDecision !== 'object' || !ACTIONS.includes(rawDecision.action) || typeof rawDecision.reasonCode !== 'string' || !rawDecision.reasonCode || !Array.isArray(rawDecision.evidenceIds)) invalid('decision is invalid');
  const ids = rawDecision.evidenceIds.filter(id => Number.isInteger(id) && id >= 0 && id < seen.evidence.length);
  const scores = rawDecision.scores;
  const safeScores = scores && ['alignment', 'progress', 'constraints'].every(key => score(scores[key as keyof typeof scores]) !== undefined)
    ? { alignment: scores.alignment, progress: scores.progress, constraints: scores.constraints } : undefined;
  const plan = planSupervisionCheck(current, seen, settings);
  if (rawDecision.reasonCode === 'stale_generation') return decision('insufficient', 'stale_generation', ids, safeScores);
  if (plan.reasonCode === 'task_deadline') return decision('insufficient', 'task_deadline', ids, safeScores);
  if (plan.kind === 'none') return decision('insufficient', plan.reasonCode, ids, safeScores);
  // Timing, unknown progress and active tools are never evidence authorizing interruption.
  const timeOnly = ['idle_timeout', 'deep_thinking_idle', 'no_progress', 'progress_unknown'].includes(plan.reasonCode)
    || plan.reasonCode === 'suspect_recheck' && (seen.consecutiveFailures ?? 0) < settings.repeatFailureLimit;
  if (['recover', 'stop', 'takeover'].includes(rawDecision.action) && (timeOnly || seen.activeTools.length > 0)) return decision('insufficient', 'timing_only', ids, safeScores);
  if (current.interventions >= settings.maxInterventions) return decision(plan.kind === 'suspect' ? 'wait' : 'insufficient', 'intervention_cap', ids, safeScores);
  if (!allowed(settings, seen, rawDecision.action)) return decision(plan.kind === 'suspect' ? 'wait' : 'insufficient', 'action_not_permitted', ids, safeScores);
  if (rawDecision.action === 'recover' && current.recoveries >= settings.maxRecoveries) return decision('insufficient', 'recovery_cap', ids, safeScores);
  if (rawDecision.action === 'takeover' && current.takeovers >= settings.maxTakeovers) return decision('insufficient', 'takeover_cap', ids, safeScores);
  if (DESTRUCTIVE.has(rawDecision.action) && seen.evidence.length === 0) return decision('insufficient', 'unknown_evidence', ids, safeScores);
  return decision(rawDecision.action, rawDecision.reasonCode, ids, safeScores);
}
