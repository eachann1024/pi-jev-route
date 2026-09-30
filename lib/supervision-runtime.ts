import { randomUUID, createHash } from 'node:crypto';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import type { Model } from '@earendil-works/pi-ai';
import { Type } from '@earendil-works/pi-ai';
import { DEFAULT_SUPERVISION, activeElapsedMs, timingReviewKey, constrainSupervisionDecision, createSupervisionTask, planSupervisionCheck } from './supervision-policy.ts';
import { judgeSupervision } from './supervision-judge.ts';
import { SUPERVISION_PROMPT } from './copy.ts';
import type {
  RegisterSupervision, SupervisionAction, SupervisionDecision, SupervisionEvent, SupervisionObservation,
  SupervisionRuntime, SupervisionRuntimeOptions, SupervisionSettings, SupervisionStore, SupervisionTask,
} from './supervision-types.ts';

export type { SupervisionRuntime } from './supervision-types.ts';

const RPC_REQUEST = 'subagents:rpc:v1:request';
const RPC_REPLY_PREFIX = 'subagents:rpc:v1:reply:';
const RPC_READY = 'subagents:rpc:v1:ready';
const PROCESS_TERMINAL = 'subagent:process-terminal';
const ASYNC_COMPLETE = 'subagent:async-complete';
const SNAPSHOT_KIND = 'pi-subagents.async-status-snapshot';
const POLL_FLOOR_MS = 1_000;
const RPC_TIMEOUT_MS = 5_000;
const MESSAGE_LIMIT = 240;
const CUSTOM_TYPE = 'jev-supervision';

type Plan = ReturnType<typeof planSupervisionCheck>;
export type SupervisionRpcMethod = 'ping' | 'status' | 'steer' | 'interrupt' | 'stop' | 'resume' | 'spawn';
export type SupervisionRpcRequest = { version: 1; requestId: string; method: SupervisionRpcMethod; params?: Record<string, unknown> };
export type SupervisionRpcReply = { version?: unknown; requestId?: unknown; success?: unknown; data?: unknown; error?: { code?: unknown; message?: unknown } };
export type SupervisionRpc = { request(request: SupervisionRpcRequest, signal: AbortSignal): Promise<SupervisionRpcReply> };

/** Injectable test seams. Production registerSupervision binds real implementations and never reads the environment. */
export type SupervisionRuntimeDeps = {
  now?: () => number;
  randomId?: () => string;
  judge?: typeof judgeSupervision;
  plan?: typeof planSupervisionCheck;
  constrain?: typeof constrainSupervisionDecision;
  createTask?: typeof createSupervisionTask;
  rpc?: SupervisionRpc;
  setTimer?: (callback: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
};

type RunFacts = {
  id: string;
  state: string;
  goal?: string;
  startedAt?: number;
  updatedAt?: number;
  endedAt?: number;
  toolCount: number;
  activeTools: string[];
  lastActivityAt?: number;
  activeToolStartedAt?: number;
  waitingForSupervisor: boolean;
  childrenWaiting: boolean;
  launchKnown: boolean;
  launch?: Record<string, unknown>;
};

type LiveTask = {
  task: SupervisionTask;
  generation: number;
  inFlight: boolean;
  controller?: AbortController;
  proof: 'observed' | 'unknown';
  launchKnown: boolean;
  ownerSessionId: string;
  blockedIntent: boolean;
};

type MainFacts = {
  startedAt: number;
  lastActivityAt: number;
  lastProgressAt: number;
  toolCount: number;
  activeTools: Map<string, { name: string; startedAt: number }>;
  supervisorCalls: Set<string>;
  dependencyCalls: Set<string>;
  consecutiveFailures: number;
  failureTool?: string;
  progressDigests: string[];
  progressKnown: boolean;
  thinking: boolean;
  lifecycle: SupervisionObservation['lifecycle'];
  waitingForUser: boolean;
  evidence: string[];
  evidenceVersion: number;
  goal: string;
};

function row(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
function text(value: unknown, max = 160): string | undefined {
  if (typeof value !== 'string') return undefined;
  const cleaned = value.replace(/[\u0000-\u001f]/g, ' ').trim();
  return cleaned ? cleaned.slice(0, max) : undefined;
}
function clip(value: string): string { return value.length > MESSAGE_LIMIT ? value.slice(0, MESSAGE_LIMIT) : value; }
function whole(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}
function list<T>(value: Iterable<T>): T[] { return Array.from(value); }

/** Match one reply by request id. Timeout and cancellation both unsubscribe. */
export function createPiEventRpc(events: { on(channel: string, handler: (data: unknown) => void): (() => void) | void; emit(channel: string, data: unknown): void }, timeoutMs = RPC_TIMEOUT_MS): SupervisionRpc {
  return {
    request(request, signal) {
      return new Promise((resolve, reject) => {
        if (signal.aborted) { reject(signal.reason instanceof Error ? signal.reason : new Error('aborted')); return; }
        let settled = false;
        let unsubscribe = () => {};
        const timer = setTimeout(() => finish(() => reject(new Error('subagent RPC timed out'))), timeoutMs);
        const finish = (done: () => void) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          unsubscribe();
          signal.removeEventListener('abort', onAbort);
          done();
        };
        const onAbort = () => finish(() => reject(signal.reason instanceof Error ? signal.reason : new Error('aborted')));
        const subscribed = events.on(`${RPC_REPLY_PREFIX}${request.requestId}`, raw => {
          const reply = row(raw);
          if (!reply || reply.requestId !== request.requestId) return;
          finish(() => resolve(reply as SupervisionRpcReply));
        });
        if (typeof subscribed === 'function') unsubscribe = subscribed;
        signal.addEventListener('abort', onAbort, { once: true });
        try { events.emit(RPC_REQUEST, request); }
        catch (error) { finish(() => reject(error)); }
      });
    },
  };
}

function capabilityOn(capabilities: Record<string, unknown>, key: string): boolean {
  const value = capabilities[key];
  return value === true || row(value)?.version === 1;
}

export function proofState(value: unknown, runId: string): 'observed' | 'unknown' | undefined {
  const proof = row(value);
  if (!proof || proof.runId !== runId || proof.version !== 1) return undefined;
  if (proof.state === 'observed' && whole(proof.observedAt) !== undefined && typeof proof.runnerProcessInstanceId === 'string' && Array.isArray(proof.instances) && proof.instances.some(instance => row(instance)?.kind === 'runner' && row(instance)?.processInstanceId === proof.runnerProcessInstanceId)) return 'observed';
  if (proof.state === 'unknown' || proof.state === 'pending' || proof.state === 'not-started') return 'unknown';
  return undefined;
}

function runFromNode(node: Record<string, unknown>): RunFacts | undefined {
  const id = text(node.id, 256);
  const state = text(node.state, 32);
  if (!id || !state || node.kind === 'step' || node.kind === 'host-step') return undefined;
  const activity = row(node.activity);
  const tool = text(activity?.currentTool, 80);
  const launch = row(node.launch) ?? row(node.contract);
  return {
    id, state, goal: text(node.goal, 160) ?? text(launch?.goal, 160) ?? text(node.label, 80),
    endedAt: whole(node.endedAt), startedAt: whole(node.startedAt), updatedAt: whole(node.updatedAt) ?? whole(activity?.lastActivityAt),
    toolCount: whole(activity?.toolCount) ?? 0, activeTools: tool ? [tool] : [],
    lastActivityAt: whole(activity?.lastActivityAt) ?? whole(node.updatedAt),
    activeToolStartedAt: whole(activity?.currentToolStartedAt),
    waitingForSupervisor: tool === 'contact_supervisor',
    childrenWaiting: Array.isArray(node.children) && node.children.some(child => {
      const item = row(child); return item?.state === 'running' || item?.state === 'queued';
    }),
    launchKnown: Array.isArray(launch?.tools) || typeof launch?.agent === 'string',
    ...(launch ? { launch } : {}),
  };
}

/** Fleet keys are opaque. Only current-session asyncSnapshot root runs[].id is an owned async run id. Nested children are visible but not intervention targets. */
export function runsFromStatus(data: unknown): RunFacts[] {
  const snapshot = row(row(data)?.asyncSnapshot);
  if (!snapshot || snapshot.kind !== SNAPSHOT_KIND || snapshot.version !== 1 || !Array.isArray(snapshot.runs)) return [];
  const runs: RunFacts[] = [];
  for (const value of snapshot.runs) {
    const node = row(value);
    const facts = node ? runFromNode(node) : undefined;
    if (!facts) continue;
    if (node && Array.isArray(node.children)) facts.childrenWaiting ||= node.children.some(child => {
      const item = row(child); return item?.state === 'running' || item?.state === 'queued';
    });
    runs.push(facts);
  }
  return runs;
}

function lifecycleOf(state: string, proof: 'observed' | 'unknown'): SupervisionObservation['lifecycle'] {
  if (state === 'queued') return 'queued';
  if (state === 'paused') return 'paused';
  if (state === 'running') return 'running';
  if (proof !== 'observed') return state === 'running' ? 'running' : 'unknown';
  if (state === 'stopped') return 'stopped';
  if (state === 'failed' || state === 'rejected') return 'failed';
  if (state === 'complete') return 'completed';
  return 'unknown';
}

function childObservation(task: SupervisionTask, run: RunFacts, stamp: number, capabilities: Record<string, unknown>, proof: 'observed' | 'unknown'): SupervisionObservation {
  const startedAt = task.startedAt;
  const seen = Math.max(run.lastActivityAt ?? run.updatedAt ?? task.lastActivityAt, run.endedAt ?? 0, task.terminalObservedAt ?? 0);
  const lifecycle = lifecycleOf(run.state, proof);
  return {
    taskId: task.id, sessionId: task.sessionId, target: 'child', runId: run.id, goal: task.goal,
    evidence: [`state=${run.state}`, `tools=${run.toolCount}`, `proof=${proof}`],
    now: stamp, startedAt, lastActivityAt: seen, lastProgressAt: task.lastProgressAt ?? startedAt, progressKnown: false, activeToolStartedAt: run.activeToolStartedAt, toolCount: run.toolCount,
    activeTools: run.activeTools, waitingForSupervisor: run.waitingForSupervisor, lifecycle,
    waitingForUser: false, waitingForChildren: run.childrenWaiting, processTerminal: proof,
    capability: {
      steer: capabilityOn(capabilities, 'steer') && lifecycle === 'running',
      interrupt: capabilityOn(capabilities, 'interrupt') && (lifecycle === 'running' || lifecycle === 'paused'),
      resume: capabilityOn(capabilities, 'resume') && (lifecycle === 'running' || lifecycle === 'paused' || lifecycle === 'failed'),
      replace: capabilityOn(capabilities, 'replace') && proof === 'observed' && run.launchKnown,
    },
    evidenceVersion: run.toolCount + (proof === 'observed' ? 1 : 0),
  };
}

function mainObservation(task: SupervisionTask, facts: MainFacts, stamp: number): SupervisionObservation {
  return {
    taskId: task.id, sessionId: task.sessionId, target: 'main', goal: facts.goal || task.goal,
    evidence: facts.evidence.slice(-8), now: stamp, startedAt: facts.startedAt,
    lastActivityAt: facts.lastActivityAt, lastProgressAt: facts.lastProgressAt, toolCount: facts.toolCount,
    activeTools: list(facts.activeTools.values()).map(tool => tool.name),
    activeToolStartedAt: facts.activeTools.size ? Math.min(...list(facts.activeTools.values()).map(tool => tool.startedAt)) : undefined,
    progressKnown: facts.progressKnown, consecutiveFailures: facts.consecutiveFailures, failureTool: facts.failureTool,
    waitingForSupervisor: facts.supervisorCalls.size > 0, ...(facts.thinking ? { thinking: 'on' } : {}),
    lifecycle: facts.lifecycle, waitingForUser: facts.waitingForUser, waitingForChildren: facts.dependencyCalls.size > 0,
    processTerminal: 'unknown', capability: { steer: true, interrupt: true, resume: false, replace: false },
    evidenceVersion: facts.evidenceVersion,
  };
}

function modelFor(ctx: ExtensionContext, id: string, allowed: string[]): Model<any> | undefined {
  if (!allowed.includes(id)) return undefined;
  return ctx.modelRegistry.getAvailable().find(model => `${model.provider}/${model.id}` === id);
}

export function registerSupervision(pi: ExtensionAPI, options: SupervisionRuntimeOptions): SupervisionRuntime {
  return createSupervisionRuntime(pi, options, {
    now: () => Date.now(), randomId: () => randomUUID(), judge: judgeSupervision, plan: planSupervisionCheck,
    constrain: constrainSupervisionDecision, createTask: createSupervisionTask, rpc: createPiEventRpc(pi.events),
    setTimer: (callback, ms) => setTimeout(callback, ms), clearTimer: handle => clearTimeout(handle as ReturnType<typeof setTimeout>),
  });
}

export function createSupervisionRuntime(pi: ExtensionAPI, options: SupervisionRuntimeOptions, deps: SupervisionRuntimeDeps = {}): SupervisionRuntime {
  const now = deps.now ?? (() => Date.now());
  const randomId = deps.randomId ?? (() => randomUUID());
  const plan = deps.plan ?? planSupervisionCheck;
  const constrain = deps.constrain ?? constrainSupervisionDecision;
  const judge = deps.judge ?? judgeSupervision;
  const createTask = deps.createTask ?? createSupervisionTask;
  const rpc = deps.rpc ?? createPiEventRpc(pi.events);
  const setTimer = deps.setTimer ?? ((callback: () => void, ms: number) => setTimeout(callback, ms));
  const clearTimer = deps.clearTimer ?? ((handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  const tasks = new Map<string, LiveTask>();
  const runs = new Map<string, RunFacts>();
  const proofs = new Map<string, 'observed' | 'unknown'>();
  const coverage = new Set<string>();
  const unsubscribers: Array<() => void> = [];
  let context: ExtensionContext | undefined;
  let main: MainFacts | undefined;
  let generation = 0;
  let disposed = false;
  let timer: unknown;
  let capabilities: Record<string, unknown> = {};
  let rpcReady = false;
  let mainTaskId: string | undefined;
  let sessionDisabled = false;
  let lastEnabled: boolean | undefined;

  const currentSettings = () => {
    try { return options.settings(); }
    catch { coverage.add('settings-unavailable'); return { ...DEFAULT_SUPERVISION, enabled: false }; }
  };
  const currentStore = () => options.store();
  const currentSession = () => { try { return context?.sessionManager.getSessionId() ?? ''; } catch { return ''; } };
  const say = (en: string, zh: string) => { try { return options.locale() === 'zh' ? zh : en; } catch { return en; } };
  const gap = (item: string) => { coverage.add(item); };
  const copy = (task: SupervisionTask): SupervisionTask => ({ ...task });
  const save = (live: LiveTask) => {
    try { currentStore().saveSupervisionTask(copy(live.task)); return true; }
    catch { gap('persistence-unavailable'); return false; }
  };
  const audit = (live: LiveTask, kind: SupervisionEvent['kind'], reasonCode: string, message: string, extra: Partial<SupervisionEvent> = {}) => {
    try { currentStore().addSupervisionEvent({ id: randomId(), at: now(), sessionId: live.task.sessionId, taskId: live.task.id, target: live.task.target, ...(live.task.runId ? { runId: live.task.runId } : {}), kind, reasonCode, message: clip(message), ...extra }); }
    catch { gap('event-persistence-unavailable'); }
  };

  const cancelAll = (reasonCode: string, blockAuto = false) => {
    generation += 1;
    const stopped = reasonCode === 'user_stop';
    for (const live of tasks.values()) {
      if (live.ownerSessionId !== currentSession()) continue;
      live.generation = generation;
      live.controller?.abort();
      live.controller = undefined;
      const uncertain = Boolean(live.task.pendingAction || live.task.pendingIntent);
      const changed = uncertain || (blockAuto && (!live.task.autoInterventionBlocked || live.task.lastReason !== reasonCode));
      if (!changed) continue;
      if (blockAuto) live.task.autoInterventionBlocked = true;
      if (stopped) { live.task.userStopped = true; live.task.phase = 'stopped'; }
      // Preserve uncertain intents across shutdown, settings changes and reload.
      live.blockedIntent ||= uncertain;
      live.task.revision += 1;
      live.task.lastReason = reasonCode;
      save(live);
      audit(live, uncertain ? 'error' : 'observation', reasonCode,
        uncertain ? 'An unfinished intervention is preserved and will not be replayed.' :
        stopped ? 'The user cancelled the task; automatic revival is blocked.' :
        'Supervision is paused. The task itself was not stopped.');
    }
  };

  const ensureMain = (ctx: ExtensionContext) => {
    const id = ctx.sessionManager.getSessionId();
    if (mainTaskId && tasks.get(mainTaskId)?.ownerSessionId === id && main) return;
    let stored: SupervisionTask | undefined;
    try { stored = currentStore().getSupervisionTasks(id).filter(task => task.target === 'main').sort((a, b) => b.startedAt - a.startedAt)[0]; }
    catch { gap('persistence-unavailable'); }
    const stamp = now();
    const key = stored?.id ?? `main:${id}`;
    mainTaskId = key;
    main = { startedAt: stored?.startedAt ?? stamp, lastActivityAt: stored?.lastActivityAt ?? stamp, lastProgressAt: stored?.lastProgressAt ?? stamp, toolCount: stored?.lastReviewedToolCount ?? 0, activeTools: new Map(), supervisorCalls: new Set(), dependencyCalls: new Set(), consecutiveFailures: stored?.consecutiveFailures ?? 0, failureTool: stored?.failureTool, progressDigests: stored?.progressDigests ?? [], progressKnown: stored?.progressKnown ?? false, thinking: false, lifecycle: 'paused', waitingForUser: true, evidence: [], evidenceVersion: stored?.lastReviewedVersion ?? 0, goal: stored?.rootGoal || stored?.goal || '' };
    const task = stored ?? createTask({
      taskId: key, sessionId: id, target: 'main', goal: '', evidence: [], now: stamp, startedAt: stamp,
      lastActivityAt: stamp, lastProgressAt: stamp, toolCount: 0, activeTools: [], lifecycle: 'paused',
      waitingForUser: true, waitingForChildren: false, processTerminal: 'unknown',
      capability: { steer: true, interrupt: false, resume: false, replace: false }, evidenceVersion: 0,
    });
    if (stored) task.observationGraceUntil = stamp + currentSettings().recheckMs;
    const blocked = Boolean(task.pendingIntent || task.pendingAction);
    tasks.set(key, { task, generation, inFlight: false, proof: 'unknown', launchKnown: false, ownerSessionId: id, blockedIntent: blocked });
    if (blocked) gap(`uncertain-intent:${key}`);
    // An idle session is not a task. Persist only after a user goal exists.
  };

  const touchMain = (ctx: ExtensionContext) => { context = ctx; if (currentSettings().monitorMain) ensureMain(ctx); };

  const upsert = (run: RunFacts) => {
    const session = currentSession();
    if (!session) return;
    runs.set(run.id, run);
    const proof = proofs.get(run.id) ?? 'unknown';
    if (proof !== 'observed' && ['complete', 'failed', 'stopped', 'rejected', 'partial'].includes(run.state)) gap(`unproven-terminal:${run.id}`);
    const id = `child:${session}:${run.id}`;
    const existing = tasks.get(id);
    if (existing) {
      if (proof === 'observed' && existing.task.proofRunId === run.id) existing.proof = 'observed';
      if (run.launchKnown) existing.launchKnown = true;
      return;
    }
    const stored = currentStore().getSupervisionTasks(session).find(task => task.id === id && task.sessionId === session && task.runId === run.id);
    if (stored) {
      const blocked = Boolean(stored.pendingIntent || stored.pendingAction);
      tasks.set(id, { task: { ...stored, observationGraceUntil: now() + currentSettings().recheckMs, pendingAction: undefined, phase: blocked ? 'blocked' : stored.phase, lastReason: blocked ? 'uncertain_intent' : stored.lastReason }, generation, inFlight: false, proof: stored.proofRunId === run.id ? 'observed' : 'unknown', launchKnown: run.launchKnown, ownerSessionId: session, blockedIntent: blocked });
      if (blocked) audit(tasks.get(id)!, 'error', 'uncertain_intent', 'Reload found an in-flight intent. It stays blocked and is not replayed.');
      return;
    }
    const stamp = run.startedAt ?? now();
    const task = createTask({ ...childObservation({ id, sessionId: session, target: 'child', runId: run.id, goal: run.goal || run.id, startedAt: stamp, lastActivityAt: stamp, lastProgressAt: stamp } as SupervisionTask, run, stamp, capabilities, proof), taskId: id });
    task.chainId = run.id; task.rootGoal = task.goal;
    tasks.set(id, { task, generation, inFlight: false, proof, launchKnown: run.launchKnown, ownerSessionId: session, blockedIntent: false });
    save(tasks.get(id)!);
  };

  const call = async (method: SupervisionRpcMethod, params: Record<string, unknown>, signal: AbortSignal) => {
    const reply = await rpc.request({ version: 1, requestId: randomId(), method, params }, signal);
    if (reply.success !== true) throw new Error(text(row(reply.error)?.message, 180) ?? `${method} failed`);
    return row(reply.data) ?? {};
  };

  const sideEffect = async (live: LiveTask, ctx: ExtensionContext, observation: SupervisionObservation, decision: SupervisionDecision, _config: SupervisionSettings) => {
    const action = decision.action;
    if (action === 'continue' || action === 'wait' || action === 'insufficient') {
      if (action === 'continue' && live.task.phase === 'suspect') { live.task.phase = 'running'; delete live.task.suspectAt; }
      live.task.lastReason = decision.reasonCode;
      live.task.revision += 1;
      save(live);
      audit(live, 'result', decision.reasonCode, `No side effect for ${action}.`, { action });
      return;
    }
    if (live.blockedIntent || live.task.pendingAction || live.task.autoInterventionBlocked || live.task.userStopped) { audit(live, 'error', 'intent_blocked', 'An uncertain or user-stopped intent blocks another side effect.'); return; }
    const controller = new AbortController();
    const abort = () => controller.abort();
    ctx.signal?.addEventListener('abort', abort, { once: true });
    live.controller = controller;
    const startedGeneration = live.generation;
    const fresh = () => !disposed && !controller.signal.aborted && tasks.get(live.task.id) === live && live.generation === startedGeneration && currentSession() === live.ownerSessionId && !live.task.userStopped && !live.task.autoInterventionBlocked;
    const allowedNow = () => {
      const latest = currentSettings();
      return fresh() && activeElapsedMs(live.task, now()) < latest.maxTaskMs && latest.enabled && (observation.target === 'main' ? latest.monitorMain : latest.monitorChildren) && (action !== 'takeover' || !latest.correctionModel || options.allowedModels(ctx).includes(latest.correctionModel)) ? latest : undefined;
    };
    const gate = () => { if (!allowedNow()) throw new Error('stale'); };
    const withholdCorrection = () => {
      const aligned = decision.scores === undefined || decision.scores.alignment >= 0.5;
      const repeated = live.task.interventions > 1;
      if (!aligned && !repeated) return false;
      delete live.task.pendingAction;
      delete live.task.pendingIntent;
      live.task.phase = 'running';
      live.task.lastReason = aligned ? 'alignment_ok' : 'correction_already_sent';
      live.task.revision += 1;
      if (!save(live)) throw new Error('result persistence failed');
      audit(live, 'result', live.task.lastReason, aligned ? 'Correction withheld: alignment is not clearly off.' : 'Correction withheld: this task was already reminded once.', { action: 'continue', evidence: observation.evidence });
      return true;
    };
    const intended = copy(live.task);
    intended.pendingAction = action;
    intended.pendingIntent = { action, reasonCode: decision.reasonCode, generation: startedGeneration, at: now() };
    if (action === 'recover' || action === 'takeover' || action === 'correct' || action === 'stop') intended.interventions += 1;
    if (action === 'recover') intended.recoveries += 1;
    if (action === 'takeover') intended.takeovers += 1;
    intended.revision += 1;
    intended.lastReason = decision.reasonCode;
    try {
      currentStore().saveSupervisionTask(intended);
      currentStore().addSupervisionEvent({ id: randomId(), at: now(), sessionId: intended.sessionId, taskId: intended.id, target: intended.target, ...(intended.runId ? { runId: intended.runId } : {}), kind: 'action', action, reasonCode: decision.reasonCode, message: `Persisted ${action} before side effect.` });
    } catch {
      live.blockedIntent = true;
      audit(live, 'error', 'persistence_failed', 'Side effect prohibited because the intent was not persisted.');
      ctx.signal?.removeEventListener('abort', abort);
      return;
    }
    live.task = intended;
    try {
      gate();
      const signal = controller.signal;
      const runId = observation.runId;
      if (action === 'correct' && withholdCorrection()) return;
      if (action === 'correct' && observation.target === 'main') {
        pi.sendMessage({ customType: CUSTOM_TYPE, content: say(SUPERVISION_PROMPT.en.correct, SUPERVISION_PROMPT.zh.correct), details: { reasonCode: decision.reasonCode }, display: true }, { triggerTurn: true, deliverAs: 'steer' });
      } else if (action === 'correct') {
        const receipt = await call('steer', { id: observation.runId, message: say(SUPERVISION_PROMPT.en.correct, SUPERVISION_PROMPT.zh.correct), mode: 'steer' }, signal);
        gate();
        const delivery = text(receipt.deliveryStatus, 32);
        live.task.phase = 'correcting';
        live.task.lastReason = delivery === 'queued' || delivery === 'delivered' ? 'correction_delivered' : decision.reasonCode;
        audit(live, 'result', 'correction_delivered', `Correction was ${delivery ?? 'sent'}, not yet proven by later evidence.`, { action, evidence: observation.evidence });
      } else if (action === 'recover' && observation.target === 'main') {
        gap('main-recover-unsupported');
        throw new Error('main recover cannot be closed safely: abort does not await completion and there is no pause/resume seam');
      } else if (action === 'takeover' && observation.target === 'main') {
        gap('main-takeover-unsupported');
        throw new Error('main takeover has no observed process-terminal proof or replacement capability');
      } else if (action === 'recover') {
        await call('interrupt', { id: observation.runId }, signal);
        gate();
        const status = await call('status', { id: runId }, signal);
        gate();
        const proof = row(row(status.details)?.lifecycleStatus)?.processTerminal ?? row(status.details)?.processTerminalProof ?? status.processTerminalProof;
        if (proofState(proof, runId!) === 'observed') proofs.set(runId!, 'observed');
        if (proofs.get(runId!) !== 'observed') { gap(`recover-exit-unproven:${runId}`); throw new Error('recover requires the exact run observed process-terminal proof'); }
        const resumed = await call('resume', { id: observation.runId, message: say(SUPERVISION_PROMPT.en.recover, SUPERVISION_PROMPT.zh.recover) }, signal);
        gate();
        const nextRun = text(resumed.runId, 256) ?? text(resumed.id, 256) ?? text(row(resumed.details)?.runId, 256);
        if (nextRun && nextRun !== observation.runId) {
          const inherited = copy(live.task);
          inherited.id = `child:${live.ownerSessionId}:${nextRun}`;
          inherited.chainId = inherited.chainId ?? observation.runId;
          inherited.runId = nextRun;
          inherited.pendingAction = undefined;
          inherited.pendingIntent = undefined;
          inherited.proofRunId = undefined;
          inherited.terminalObservedAt = undefined;
          inherited.observationGraceUntil = now() + currentSettings().recheckMs;
          inherited.phase = 'recovering';
          tasks.set(inherited.id, { ...live, task: inherited, proof: 'unknown', inFlight: false, controller: undefined, blockedIntent: false });
          if (!save(tasks.get(inherited.id)!)) throw new Error('successor persistence failed');
          live.task.autoInterventionBlocked = true;
        }
      } else if (action === 'takeover') {
        gap(`replacement-unsupported:${observation.runId}`);
        throw new Error('takeover fails closed: public status does not carry the original agent, tools, or model, and resume cannot replace the model');
      } else if (action === 'stop') {
        if (observation.target === 'main') { gap('main-stop-unsupported'); throw new Error('main stop cannot be closed safely because abort does not await settlement'); }
        await call('stop', { id: observation.runId }, signal);
        gate();
      } else throw new Error('unsupported action');
      if (!allowedNow() && !live.task.autoInterventionBlocked) throw new Error('stale');
      delete live.task.pendingAction;
      delete live.task.pendingIntent;
      live.task.revision += 1;
      if (action !== 'correct' || observation.target === 'main') live.task.phase = action === 'stop' ? 'stopped' : action === 'correct' ? 'correcting' : 'recovering';
      live.task.lastReason = action === 'correct' ? 'correction_delivered' : decision.reasonCode;
      if (!save(live)) throw new Error('result persistence failed');
      if (action !== 'correct' || observation.target === 'main') audit(live, 'result', live.task.lastReason ?? decision.reasonCode, action === 'correct' ? 'Main correction was delivered, not yet proven.' : `Completed ${action}.`, { action, evidence: observation.evidence });
    } catch (error) {
      const stale = error instanceof Error && error.message === 'stale';
      // Unknown RPC outcomes retain their durable intent so reload cannot replay them.
      live.task.autoInterventionBlocked = true;
      live.task.revision += 1;
      live.task.lastReason = stale ? 'stale_generation' : 'action_failed';
      live.blockedIntent = true;
      save(live);
      audit(live, 'error', live.task.lastReason, `Action ${action} stopped: ${error instanceof Error ? error.message : 'unknown'}.`);
      if (!stale) gap(`action-failed:${action}`);
    } finally {
      ctx.signal?.removeEventListener('abort', abort);
      if (live.controller === controller) live.controller = undefined;
    }
  };

  const observeTiming = (live: LiveTask, seen: SupervisionObservation, ctx: ExtensionContext) => {
    const task = live.task, config = currentSettings();
    if (!config.enabled || sessionDisabled || live.ownerSessionId !== currentSession() || task.sessionId !== currentSession() || (task.target === 'main' ? !config.monitorMain : !config.monitorChildren)) return;
    const previous = task.lastObservedAt;
    const delta = previous === undefined ? 0 : Math.max(0, seen.now - previous);
    const gapLimit = Math.max(30_000, config.pollMs * 3);
    if (previous !== undefined && delta > gapLimit) {
      task.observationGraceUntil = seen.now + config.recheckMs;
      delete task.suspectAt; delete task.suspectReason;
      if (task.phase === 'suspect') task.phase = 'running';
      audit(live, 'observation', 'observation_grace', 'Observation resumed after a polling gap; refresh facts before intervention.');
    }
    if (task.budgetPaused) task.pausedMs = (task.pausedMs ?? 0) + delta;
    const paused = seen.waitingForUser || seen.waitingForSupervisor === true || seen.lifecycle === 'queued' || seen.lifecycle === 'paused';
    if (task.budgetPaused && !paused) task.observationGraceUntil = seen.now + config.recheckMs;
    task.budgetPaused = paused; task.lastObservedAt = seen.now;
    task.lastActivityAt = seen.lastActivityAt; task.lastProgressAt = seen.lastProgressAt;
    task.progressKnown = seen.progressKnown;
    const state = seen.waitingForUser ? 'waiting_for_user' : seen.waitingForSupervisor ? 'waiting_for_supervisor'
      : seen.waitingForChildren ? 'waiting_for_children' : seen.lifecycle === 'queued' ? 'queued'
      : seen.lifecycle === 'paused' ? 'paused' : seen.lifecycle === 'unknown' ? 'missing_updates'
      : seen.lifecycle === 'failed' ? 'failed' : seen.activeTools.length ? 'tool_active'
      : seen.thinking ? 'thinking' : 'missing_updates';
    const descriptions: Record<string, [string, string]> = {
      waiting_for_user: ['Waiting for user input', '等待用户输入'], waiting_for_supervisor: ['Waiting for a supervisor decision', '等待主管决策'],
      waiting_for_children: ['Waiting for child tasks', '等待子任务'], queued: ['Queued', '排队中'], paused: ['Paused', '已暂停'],
      missing_updates: ['No recent execution detail is available', '缺少近期执行详情'], failed: ['Process failure observed', '已观测到进程失败'],
      tool_active: ['Tool executing', '工具执行中'], thinking: ['Thinking', '思考中'],
    };
    const [en, zh] = descriptions[state]!;
    const fact = say(en, zh);
    const notify = (reason: string, message: string, warning = false) => {
      save(live);
      audit(live, 'observation', reason, message);
      try { ctx.ui?.notify(message, warning ? 'warning' : 'info'); } catch { gap('feedback-ui-unavailable'); }
    };
    if (seen.lifecycle === 'completed' || seen.lifecycle === 'stopped') { save(live); return; }
    const feedbackKey = `${state}:${seen.evidenceVersion}:${seen.activeTools.join(',')}`.slice(0, 256);
    const supervisorNew = state === 'waiting_for_supervisor' && !task.lastFeedbackKey?.startsWith('waiting_for_supervisor:');
    if ((supervisorNew || seen.now - task.startedAt >= config.feedbackAfterMs && seen.now - (task.lastFeedbackAt ?? task.startedAt) >= (task.lastFeedbackAt === undefined ? config.feedbackAfterMs : config.feedbackIntervalMs)) && feedbackKey !== task.lastFeedbackKey) {
      task.lastFeedbackAt = seen.now; task.lastFeedbackKey = feedbackKey;
      notify(`feedback_${state}`, `${live.task.target}: ${fact}`);
    }
    const elapsed = activeElapsedMs(task, seen.now);
    if (elapsed >= config.softBudgetMs && !task.softBudgetNotified) {
      task.softBudgetNotified = true;
      notify('soft_budget', say(`Expected time budget exceeded. ${fact}.`, `已超过预计时间预算。${fact}。`), true);
    }
    if (elapsed >= config.maxTaskMs && !task.deadlineNotified) {
      task.deadlineNotified = true; task.autoInterventionBlocked = true; task.lastReason = 'task_deadline';
      notify('task_deadline', say(`Automatic intervention time limit reached. ${fact}. Observation continues.`, `自动干预时限已到。${fact}，继续观察状态。`), true);
    }
    if (seen.activeTools.length && seen.activeToolStartedAt !== undefined && seen.now - seen.activeToolStartedAt >= config.toolStallMs && !paused && !seen.waitingForChildren) {
      const key = `${seen.activeToolStartedAt}:${seen.activeTools.join(',')}`.slice(0, 256);
      if (task.lastToolStallKey !== key) {
        task.lastToolStallKey = key;
        notify('tool_stall', say('Tool duration exceeded the observation threshold; execution continues.', '工具执行已超过观察阈值，继续执行。'), true);
      }
    }
    save(live);
  };

  const review = async (live: LiveTask, observation: SupervisionObservation, ctx: ExtensionContext) => {
    if (live.ownerSessionId !== currentSession() || live.task.userStopped || !observation.goal.trim()) return;
    observeTiming(live, observation, ctx);
    live.task.lastActivityAt = observation.lastActivityAt;
    live.task.lastProgressAt = observation.lastProgressAt;
    if (observation.lifecycle === 'completed' || observation.lifecycle === 'stopped') {
      live.task.phase = observation.lifecycle;
      live.task.lastReason = observation.lifecycle;
      save(live); return;
    }
    if (live.inFlight || live.task.pendingAction || live.task.pendingIntent || live.blockedIntent || live.task.autoInterventionBlocked || sessionDisabled) return;
    if (live.task.checks >= currentSettings().maxChecksPerTask) {
      if (live.task.lastReason !== 'check_cap') {
        live.task.lastReason = 'check_cap';
        save(live);
        audit(live, 'decision', 'check_cap', 'Check cap reached. Supervision stopped. The task was left running.', { action: 'insufficient' });
        gap(`check-cap:${live.task.id}`);
        ctx.ui?.notify(say('Supervision check limit reached. Task execution is unchanged.', '监督检查次数已达上限，任务继续执行。'), 'warning');
      }
      return;
    }
    if (live.blockedIntent && live.task.lastReason !== 'action_failed') return;
    const config = currentSettings();
    let planned: Plan;
    try { planned = plan(live.task, observation, config); }
    catch { audit(live, 'error', 'policy_invalid', 'Policy rejected the observation.'); return; }
    if (planned.kind === 'suspect') {
      if (live.task.phase !== 'suspect') {
        live.task.phase = 'suspect';
        live.task.suspectAt ??= now();
        live.task.suspectReason = planned.reasonCode;
        live.task.lastReviewedToolCount = observation.toolCount;
        live.task.lastReason = planned.reasonCode;
        live.task.revision += 1;
        save(live);
        audit(live, 'observation', planned.reasonCode, 'First silence recorded. Recheck comes before judgment.', { evidence: observation.evidence });
      }
      return;
    }
    if (planned.kind === 'none') {
      if (planned.reasonCode === 'task_deadline' && live.task.lastReason !== 'task_deadline') {
        live.task.lastReason = 'task_deadline'; live.task.autoInterventionBlocked = true;
        save(live); audit(live, 'observation', 'task_deadline', 'Supervision time limit reached; the task was not stopped.');
        ctx.ui?.notify(say('Supervision time limit reached. Task execution is unchanged.', '监督时限已到，任务继续执行。'), 'warning');
      }
      if (planned.reasonCode === 'check_cap' && live.task.lastReason !== 'check_cap') {
        live.task.lastReason = planned.reasonCode;
        save(live);
        audit(live, 'decision', planned.reasonCode, 'Check cap reached. Supervision stopped. The task was left running.', { action: 'insufficient' });
        gap(`check-cap:${live.task.id}`);
      }
      if (planned.reasonCode === 'activity_cleared_suspect' && live.task.phase === 'suspect') {
        live.task.phase = 'running'; delete live.task.suspectAt; live.task.lastReason = planned.reasonCode; live.task.revision += 1; save(live);
      }
      return;
    }
    if (planned.kind === 'stop' && planned.reasonCode !== 'task_deadline') return;
    if (live.task.checks >= config.maxChecksPerTask) return;
    const priorTask = copy(live.task);
    const counted = copy(live.task);
    if (planned.reasonCode === 'suspect_recheck' || planned.reasonCode === 'failed_handoff') counted.lastTimingReviewKey = timingReviewKey(live.task, observation);
    counted.checks += 1; counted.revision += 1; counted.lastReviewAt = now(); counted.lastReason = planned.reasonCode;
    try { currentStore().saveSupervisionTask(counted); }
    catch { live.blockedIntent = true; audit(live, 'error', 'persistence_failed', 'Check was not counted, so no decision was requested.'); return; }
    live.task = counted;
    live.inFlight = true;
    const seen = live.generation;
    const controller = live.controller ?? new AbortController();
    live.controller = controller;
    const timeout = setTimer(() => controller.abort(), config.decisionTimeoutMs);
    try {
      audit(live, 'observation', planned.reasonCode, `Check ${planned.kind}.`, { evidence: observation.evidence });
      const judged = await judge(observation, priorTask, config, controller.signal);
      if (disposed || controller.signal.aborted || live.generation !== seen || currentSession() !== observation.sessionId) { audit(live, 'error', 'stale_generation', 'Discarded a stale supervision result.'); return; }
      const currentRun = observation.runId ? runs.get(observation.runId) : undefined;
      const latestObservation = observation.target === 'main' && main ? mainObservation(live.task, main, now())
        : currentRun ? childObservation(live.task, currentRun, now(), capabilities, proofs.get(currentRun.id) ?? live.proof) : undefined;
      if (!latestObservation || latestObservation.evidenceVersion !== observation.evidenceVersion
        || latestObservation.lifecycle !== observation.lifecycle || latestObservation.waitingForUser !== observation.waitingForUser
        || latestObservation.waitingForSupervisor !== observation.waitingForSupervisor || latestObservation.waitingForChildren !== observation.waitingForChildren
        || latestObservation.lastActivityAt !== observation.lastActivityAt || latestObservation.lastProgressAt !== observation.lastProgressAt
        || latestObservation.activeTools.join(',') !== observation.activeTools.join(',')) {
        audit(live, 'observation', 'facts_changed', 'Execution facts changed during review; no action was dispatched.'); return;
      }
      const decision = constrain(priorTask, latestObservation, currentSettings(), judged);
      live.task.lastReviewAt = now();
      live.task.lastReviewedVersion = observation.evidenceVersion;
      live.task.lastReviewedToolCount = observation.toolCount;
      live.task.revision += 1;
      live.task.lastReason = decision.reasonCode;
      save(live);
      audit(live, 'decision', decision.reasonCode, `Decision ${decision.action}.`, { action: decision.action, ...(decision.scores ? { scores: decision.scores } : {}) });
      await sideEffect(live, ctx, observation, decision, currentSettings());
    } catch {
      live.task.lastReviewedVersion = observation.evidenceVersion;
      save(live);
      audit(live, 'error', controller.signal.aborted ? 'decision_timeout' : 'judge_failed', 'Decision failed. The check still counts and no side effect was sent.');
    } finally {
      clearTimer(timeout);
      live.inFlight = false;
      if (live.controller === controller) live.controller = undefined;
    }
  };

  const poll = async () => {
    if (disposed || !context || !currentSettings().enabled) return;
    const ctx = context;
    if (currentSettings().monitorChildren && !sessionDisabled) {
      if (!rpcReady && !capabilityOn(capabilities, 'status')) gap('child-rpc-unavailable');
      const signal = new AbortController();
      const timeout = setTimer(() => signal.abort(), RPC_TIMEOUT_MS);
      try {
        if (!capabilityOn(capabilities, 'status')) {
          const pong = await call('ping', {}, signal.signal);
          const owner = row(pong.session)?.sessionId;
          if (owner && owner !== currentSession()) throw new Error('RPC session mismatch');
          capabilities = row(pong.capabilities) ?? {};
        }
        const data = await call('status', {}, signal.signal);
        const reported = row(data.capabilities);
        if (reported) capabilities = reported;
        const observed = runsFromStatus(data);
        const observedIds = new Set(observed.map(run => run.id));
        for (const [id, run] of runs) if (!observedIds.has(id)) runs.set(id, { ...run, state: 'unknown', activeTools: [], waitingForSupervisor: false });
        for (const run of observed) upsert(run);
      } catch { gap('child-status-unavailable'); for (const [id, run] of runs) runs.set(id, { ...run, state: 'unknown', activeTools: [], waitingForSupervisor: false }); }
      finally { clearTimer(timeout); }
    }
    for (const live of Array.from(tasks.values())) {
      if (live.ownerSessionId !== currentSession() || live.task.phase === 'completed' || live.task.phase === 'stopped') continue;
      if (live.task.target === 'main') {
        if (currentSettings().monitorMain && main && live.task.id === mainTaskId && main.goal && main.lifecycle !== 'completed' && main.lifecycle !== 'stopped') await review(live, mainObservation(live.task, main, now()), ctx);
      } else if (live.task.runId) {
        const run = runs.get(live.task.runId);
        if (!run) { gap(`child-unobserved:${live.task.runId}`); continue; }
        await review(live, childObservation(live.task, run, now(), capabilities, proofs.get(run.id) ?? live.proof), ctx);
      }
    }
  };

  const schedule = () => {
    if (timer !== undefined) clearTimer(timer);
    if (disposed) return;
    timer = setTimer(() => poll().catch(() => gap('poll-failed')).finally(schedule), Math.max(POLL_FLOOR_MS, currentSettings().pollMs || POLL_FLOOR_MS));
  };

  const subscribe = (unsubscribe: (() => void) | void) => { if (typeof unsubscribe === 'function') unsubscribers.push(unsubscribe); };
  subscribe(pi.on('session_start', (_event, ctx) => { sessionDisabled = false; mainTaskId = undefined; main = undefined; touchMain(ctx); lastEnabled = currentSettings().enabled; schedule(); }));
  subscribe(pi.on('session_shutdown', () => { disposed = true; if (timer !== undefined) { clearTimer(timer); timer = undefined; } cancelAll('session_shutdown'); for (const unsubscribe of unsubscribers.splice(0)) unsubscribe(); }));
  subscribe(pi.on('session_before_switch', () => cancelAll('session_switch', true)));
  subscribe(pi.on('session_before_fork', () => cancelAll('session_fork', true)));
  subscribe(pi.on('session_before_tree', () => cancelAll('session_tree', true)));
  subscribe(pi.on('input', (event, ctx) => {
    touchMain(ctx);
    if (event.source === 'extension') return;
    const command = event.text.trim();
    if (command === '/stop' || command === '/jev-supervision off') {
      if (command !== '/stop') sessionDisabled = true;
      cancelAll(command === '/stop' ? 'user_stop' : 'user_disabled', true); return;
    }
    if (!main) return;
    let live = mainTaskId ? tasks.get(mainTaskId) : undefined;
    const goal = text(event.text, 160);
    if (!goal) return;
    if (!live || !live.task.goal || live.task.phase === 'completed' || live.task.userStopped) {
      const stamp = now();
      main = { startedAt: stamp, lastActivityAt: stamp, lastProgressAt: stamp, toolCount: 0, activeTools: new Map(), supervisorCalls: new Set(), dependencyCalls: new Set(), consecutiveFailures: 0, progressDigests: [], progressKnown: false, thinking: false, lifecycle: 'running', waitingForUser: false, evidence: ['User goal: ' + goal], evidenceVersion: 1, goal };
      const id = live?.task.goal ? `main:${currentSession()}:${randomId()}` : `main:${currentSession()}`;
      const next = createTask({ ...mainObservation({ id, sessionId: currentSession(), target: 'main', goal } as SupervisionTask, main, stamp), taskId: id });
      next.rootGoal = goal;
      next.autoInterventionBlocked = sessionDisabled || !currentSettings().enabled;
      live = { task: next, generation, inFlight: false, proof: 'unknown', launchKnown: false, ownerSessionId: currentSession(), blockedIntent: false };
      tasks.set(id, live); mainTaskId = id;
    }
    main.waitingForUser = false; main.lifecycle = 'running'; main.lastActivityAt = now();
    main.evidence = [...main.evidence, 'User input: ' + goal].slice(-8); main.evidenceVersion += 1;
    save(live);
  }));
  subscribe(pi.on('agent_start', (_event, ctx) => { touchMain(ctx); if (main) { main.lifecycle = 'running'; main.thinking = false; main.lastActivityAt = now(); } }));
  subscribe(pi.on('message_update', (event, ctx) => {
    touchMain(ctx); if (!main) return;
    const kind = event.assistantMessageEvent.type;
    if (kind === 'thinking_start' || kind === 'thinking_delta') { main.thinking = true; main.lastActivityAt = now(); }
    if (kind === 'thinking_end' || kind === 'text_delta') { main.thinking = false; main.lastActivityAt = now(); }
  }));
  subscribe(pi.on('tool_execution_start', (event, ctx) => { touchMain(ctx); if (main) { main.activeTools.set(event.toolCallId, { name: event.toolName, startedAt: now() }); main.thinking = false; main.lastActivityAt = now(); } }));
  subscribe(pi.on('tool_execution_end', (event, ctx) => {
    touchMain(ctx); if (!main) return;
    main.activeTools.delete(event.toolCallId); main.supervisorCalls.delete(event.toolCallId); main.dependencyCalls.delete(event.toolCallId);
    main.toolCount += 1; main.lastActivityAt = now();
    if (event.isError) {
      main.consecutiveFailures = main.failureTool === event.toolName ? main.consecutiveFailures + 1 : 1;
      main.failureTool = event.toolName;
    } else { main.consecutiveFailures = 0; main.failureTool = undefined; }
    // Hash bounded result content, never arguments or retained sensitive result text.
    const content = row(event.result)?.content;
    const bounded = Array.isArray(content) ? content.slice(0, 16).map(item => {
      const part = row(item); return typeof part?.text === 'string' ? part.text.slice(0, 4096) : '';
    }).join('\n').trim() : '';
    if (!event.isError && bounded) {
      const digest = createHash('sha256').update(bounded).digest('hex');
      if (!main.progressDigests.includes(digest)) {
        main.lastProgressAt = now(); main.progressKnown = true;
        main.progressDigests = [...main.progressDigests, digest].slice(-32);
      }
    }
    main.evidence = [...main.evidence, `${event.toolName}:${event.isError ? 'error' : 'ok'}`].slice(-8);
    main.evidenceVersion += 1;
    syncMainTiming(ctx);
    const live = mainTaskId ? tasks.get(mainTaskId) : undefined;
    if (live) {
      Object.assign(live.task, { lastActivityAt: main.lastActivityAt, lastProgressAt: main.lastProgressAt, progressKnown: main.progressKnown,
        consecutiveFailures: main.consecutiveFailures, failureTool: main.failureTool, progressDigests: main.progressDigests });
      save(live);
    }
    if (event.toolName === 'subagent') {
      const details = row(row(event.result)?.details);
      if (!text(details?.asyncId, 256) && !text(details?.runId, 256)) gap('foreground-or-unidentified-child');
    }
  }));
  const syncMainTiming = (ctx: ExtensionContext) => {
    const live = mainTaskId ? tasks.get(mainTaskId) : undefined;
    if (main && live && main.goal && live.ownerSessionId === currentSession() && live.task.sessionId === currentSession() && !live.task.userStopped && currentSettings().enabled && currentSettings().monitorMain && !sessionDisabled) observeTiming(live, mainObservation(live.task, main, now()), ctx);
  };
  subscribe(pi.on('ui_prompt_start', (_event, ctx) => { touchMain(ctx); if (main) { main.waitingForUser = true; main.lastActivityAt = now(); syncMainTiming(ctx); } }));
  subscribe(pi.on('ui_prompt_end', (_event, ctx) => { touchMain(ctx); if (main) { main.waitingForUser = false; syncMainTiming(ctx); } }));
  subscribe(pi.on('agent_settled', (_event, ctx) => {
    touchMain(ctx); if (!main) return;
    main.lifecycle = 'completed'; main.thinking = false; main.activeTools.clear(); main.lastActivityAt = now(); main.lastProgressAt = now();
    const live = mainTaskId ? tasks.get(mainTaskId) : undefined;
    if (live && live.task.goal && !live.task.userStopped && !live.task.pendingIntent) { live.task.phase = 'completed'; live.task.lastActivityAt = now(); live.task.lastReason = 'completed'; live.task.revision += 1; save(live); }
  }));
  subscribe(pi.on('tool_call', (event, ctx) => {
    touchMain(ctx);
    if (main && event.toolName === 'contact_supervisor' && ['need_decision', 'interview_request'].includes(String(event.input.reason))) main.supervisorCalls.add(event.toolCallId);
    if (main && event.toolName === 'bg_wait' && event.input.nonBlocking !== true) main.dependencyCalls.add(event.toolCallId);
    if (main && (event.toolName === 'contact_supervisor' || event.toolName === 'bg_wait')) syncMainTiming(ctx);
    if (event.toolName !== 'subagent') return;
    const input = event.input;
    if (input.action !== undefined || input.workflow !== undefined || input.workflowScript !== undefined || input.chain !== undefined || input.parallel !== undefined || input.tasks !== undefined) gap('workflow-or-control-not-supervised');
  }));
  const events = row(pi.events);
  if (events && typeof events.on === 'function') {
    const listen = events.on.bind(pi.events) as (channel: string, handler: (data: unknown) => void) => (() => void) | void;
    subscribe(listen(RPC_READY, () => { rpcReady = true; }));
    subscribe(listen(PROCESS_TERMINAL, (raw: unknown) => {
    const runId = text(row(raw)?.runId, 256);
    const state = runId ? proofState(raw, runId) : undefined;
    if (!runId || !state) return;
    proofs.set(runId, state);
    const live = tasks.get(`child:${currentSession()}:${runId}`);
    if (live && state === 'observed') { live.task.terminalObservedAt ??= now(); live.proof = 'observed'; live.task.proofRunId = runId; save(live); }
  }));
  subscribe(listen(ASYNC_COMPLETE, (raw: unknown) => {
    const payload = row(raw);
    const runId = text(payload?.runId, 256) ?? text(payload?.id, 256);
    const existing = runId ? runs.get(runId) : undefined;
    if (runId && existing) runs.set(runId, { ...existing, state: payload?.success === false ? 'failed' : 'complete', endedAt: now(), updatedAt: now() });
  }));
  }

  pi.registerCommand('jev-supervision', {
    description: 'Show task supervision status and coverage gaps',
    handler: async (args, ctx) => {
      context = ctx;
      if (args.trim() === 'off') { sessionDisabled = true; cancelAll('user_disabled', true); ctx.ui.notify(say('Automatic supervision stays blocked. Settings were not changed.', '自动监督保持阻断，未修改设置。'), 'info'); return; }
      const rows = Array.from(tasks.values()).filter(live => live.ownerSessionId === currentSession()).slice(-10);
      const summary = rows.map(live => `${live.task.target}${live.task.runId ? `:${live.task.runId}` : ''} ${live.task.phase} ${live.task.lastReason ?? ''}`.trim()).join('\n') || say('No supervised tasks yet.', '还没有被监督的任务。');
      const gaps = list(coverage).slice(-8).join(', ');
      ctx.ui.notify(gaps ? `${summary}\n${say('Coverage gaps', '覆盖缺口')}: ${gaps}` : summary, 'info');
    },
  });
  pi.registerTool({
    name: 'jev_supervision_status', label: 'Jev supervision status',
    description: 'Read bounded supervision phase, reason, and coverage gaps for the current session. Does not expose raw transcripts.',
    parameters: Type.Object({ limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 20 })) }),
    async execute(_id, params, _signal, _update, ctx) {
      context = ctx;
      const limit = Math.min(typeof params.limit === 'number' ? params.limit : 10, 20);
      const session = currentSession();
      const visible = Array.from(tasks.values()).filter(live => live.ownerSessionId === session).slice(-limit).map(live => ({ id: live.task.id, target: live.task.target, runId: live.task.runId, phase: live.task.phase, reason: live.task.lastReason, checks: live.task.checks, interventions: live.task.interventions, pending: Boolean(live.task.pendingAction), blocked: live.blockedIntent }));
      return { content: [{ type: 'text', text: JSON.stringify({ tasks: visible, coverage: list(coverage).slice(-12) }) }], details: undefined };
    },
  });

  coverage.add('child-progress-and-wait-reasons-unavailable');
  coverage.add('queue-retry-after-and-tool-native-timeouts-unavailable');
  coverage.add('main-recovery-and-model-takeover-unavailable');
  void poll().catch(() => gap('poll-failed')).finally(schedule);
  return {
    snapshot() {
      const session = currentSession();
      let events: SupervisionEvent[] = [];
      let stored: SupervisionTask[] = [];
      try { stored = session ? currentStore().getSupervisionTasks(session) : []; events = currentStore().getSupervisionEvents(session || undefined, 50); }
      catch { gap('snapshot-unavailable'); }
      const merged = new Map(stored.map(task => [task.id, task]));
      for (const live of Array.from(tasks.values())) if (!session || live.ownerSessionId === session) merged.set(live.task.id, copy(live.task));
      return { tasks: Array.from(merged.values()), events, coverage: list(coverage) };
    },
    settingsChanged() {
      const enabled = currentSettings().enabled;
      generation += 1;
      for (const live of tasks.values()) {
        if (live.ownerSessionId !== currentSession()) continue;
        live.generation = generation; live.controller?.abort();
        if (enabled && lastEnabled === false && !live.task.userStopped && !live.task.pendingAction && !live.task.pendingIntent && live.task.lastReason === 'supervision_disabled') {
          live.task.autoInterventionBlocked = false;
          live.task.lastReason = 'supervision_enabled';
          save(live); audit(live, 'observation', 'supervision_enabled', 'Supervision enabled.');
        }
      }
      if (!enabled) cancelAll('supervision_disabled', true);
      lastEnabled = enabled;
    },
    dispose() { disposed = true; if (timer !== undefined) { clearTimer(timer); timer = undefined; } cancelAll('disposed'); for (const unsubscribe of unsubscribers.splice(0)) unsubscribe(); },
  };
}

export const __supervisionTest = { runsFromStatus, proofState, createPiEventRpc };
