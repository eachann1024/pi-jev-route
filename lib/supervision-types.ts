import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';

/** Versioned task supervision contract shared by policy, runtime and settings UI. */
export type SupervisionSettings = {
  enabled: boolean;
  mode: 'observe' | 'correct' | 'recover';
  monitorMain: boolean;
  monitorChildren: boolean;
  allowMainTakeover: boolean;
  correctionModel: string;
  correctionThinking: 'off' | 'low' | 'medium' | 'high';
  feedbackAfterMs: number;
  feedbackIntervalMs: number;
  noProgressMs: number;
  toolStallMs: number;
  softBudgetMs: number;
  repeatFailureLimit: number;
  pollMs: number;
  idleMs: number;
  deepThinkingIdleMs: number;
  recheckMs: number;
  reviewIntervalMs: number;
  reviewEveryTools: number;
  handoffMs: number;
  maxRecoveries: number;
  maxTakeovers: number;
  maxInterventions: number;
  maxTaskMs: number;
  decisionTimeoutMs: number;
  maxChecksPerTask: number;
};
export type SupervisionAction = 'continue' | 'wait' | 'correct' | 'recover' | 'takeover' | 'stop' | 'insufficient';
export type SupervisionPhase = 'running' | 'suspect' | 'waiting' | 'correcting' | 'recovering' | 'completed' | 'stopped' | 'blocked';
export type SupervisionObservation = {
  taskId: string;
  sessionId: string;
  target: 'main' | 'child';
  runId?: string;
  goal: string;
  evidence: string[];
  now: number;
  startedAt: number;
  lastActivityAt: number;
  lastProgressAt: number;
  /** Unknown child progress must never be inferred from activity timestamps. */
  progressKnown?: boolean;
  consecutiveFailures?: number;
  failureTool?: string;
  activeToolStartedAt?: number;
  waitingForSupervisor?: boolean;
  toolCount: number;
  activeTools: string[];
  thinking?: string;
  lifecycle: 'running' | 'queued' | 'paused' | 'completed' | 'failed' | 'stopped' | 'unknown';
  waitingForUser: boolean;
  waitingForChildren: boolean;
  processTerminal: 'observed' | 'unknown';
  capability: { steer: boolean; interrupt: boolean; resume: boolean; replace: boolean };
  evidenceVersion: number;
};
export type SupervisionTask = {
  id: string;
  sessionId: string;
  target: 'main' | 'child';
  runId?: string;
  goal: string;
  phase: SupervisionPhase;
  startedAt: number;
  lastActivityAt: number;
  lastProgressAt: number;
  lastReviewAt: number;
  lastReviewedVersion: number;
  lastReviewedToolCount: number;
  suspectAt?: number;
  recoveries: number;
  takeovers: number;
  interventions: number;
  checks: number;
  revision: number;
  pendingAction?: SupervisionAction;
  /** Durable intent persisted before a side effect. Uncertain values block revival. */
  pendingIntent?: { action: SupervisionAction; reasonCode: string; generation: number; at: number };
  /** Original user goal. Supervision messages must not replace it. */
  rootGoal?: string;
  /** Exact run whose observed process-terminal proof was recorded. */
  proofRunId?: string;
  userStopped?: boolean;
  autoInterventionBlocked?: boolean;
  chainId?: string;
  lastReason?: string;
  pausedMs?: number;
  budgetPaused?: boolean;
  lastObservedAt?: number;
  observationGraceUntil?: number;
  lastFeedbackAt?: number;
  lastFeedbackKey?: string;
  softBudgetNotified?: boolean;
  deadlineNotified?: boolean;
  lastToolStallKey?: string;
  progressKnown?: boolean;
  consecutiveFailures?: number;
  failureTool?: string;
  progressDigests?: string[];
  suspectReason?: string;
  lastTimingReviewKey?: string;
  terminalObservedAt?: number;
};
export type SupervisionDecision = {
  action: SupervisionAction;
  reasonCode: string;
  evidenceIds: number[];
  scores?: { alignment: number; progress: number; constraints: number };
};
export type SupervisionEvent = {
  id: string;
  at: number;
  sessionId: string;
  taskId: string;
  target: 'main' | 'child';
  runId?: string;
  kind: 'observation' | 'decision' | 'action' | 'result' | 'error';
  action?: SupervisionAction;
  reasonCode: string;
  message: string;
  evidence?: string[];
  scores?: SupervisionDecision['scores'];
};
export type SupervisionStore = {
  getSupervisionTasks(sessionId: string): SupervisionTask[];
  saveSupervisionTask(task: SupervisionTask): void;
  addSupervisionEvent(event: SupervisionEvent): void;
  getSupervisionEvents(sessionId?: string, limit?: number): SupervisionEvent[];
};
export type SupervisionRuntimeOptions = {
  settings: () => SupervisionSettings;
  store: () => SupervisionStore;
  allowedModels: (ctx: ExtensionContext) => string[];
  locale: () => 'zh' | 'en';
};
export type SupervisionRuntime = {
  snapshot(): { tasks: SupervisionTask[]; events: SupervisionEvent[]; coverage: string[] };
  settingsChanged(): void;
  dispose(): void;
};
export type RegisterSupervision = (pi: ExtensionAPI, options: SupervisionRuntimeOptions) => SupervisionRuntime;
