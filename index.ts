import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { getAgentDir, type CustomEntry, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "@earendil-works/pi-ai";
import { copy, ROUTING_PROMPT } from "./lib/copy.ts";
import { defaultModelDescription } from "./lib/describe.ts";
import { addEnabledModel, catalogEntries, expandEnabledIds, loadPiEnabledModels, modelId, resolveListedModel, splitModelRef, type CatalogModel } from "./lib/enabled.ts";
import { DEFAULTS, openStore, parseSettings, type RouteLog, type Settings } from "./lib/store.ts";
import { routeTask, type Candidate } from "./lib/router.ts";
import { registerSupervision, type SupervisionRuntime } from "./lib/supervision-runtime.ts";

const COVERAGE = "自动覆盖模型发起的结构化 subagent 单任务（含 async）。workflow、/run、定时任务、其他扩展直接派发和子代理内部派发不保证覆盖；未覆盖的工具工作流会记为跳过。";
const PLUGIN = "pi-jev-route";
type Badge = { text?: string; summary?: string };
const clean = (value: unknown, max = 256) => typeof value === "string" ? value.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max) : "";

function availableModels(ctx: ExtensionContext) {
  return new Map(ctx.modelRegistry.getAvailable().map(model => [modelId(model), {
    provider: model.provider, id: model.id, name: model.name || model.id, reasoning: model.reasoning ?? true,
  } satisfies CatalogModel]));
}

export function scopedCandidates(ctx: ExtensionContext, settings: Settings) {
  const available = availableModels(ctx);
  const { tokens, defaultProvider } = loadPiEnabledModels();
  const ids = expandEnabledIds(tokens, available, defaultProvider);
  return ids.map(id => {
    const model = available.get(id)!;
    const saved = settings.models[id];
    return { id, name: model.name, reasoning: model.reasoning, enabled: saved?.enabled ?? true,
      description: (saved?.description?.trim() ? saved.description : defaultModelDescription(id, model.name, settings.locale)),
      current: ctx.model ? id === modelId(ctx.model) : false, scoped: tokens.length > 0 };
  });
}

function localAgentName(agent: string, locale: "zh" | "en") {
  const name = clean(agent, 80);
  const names: Record<string, [string, string]> = {
    scout: ["侦察", "Scout"], planner: ["规划", "Planner"], coder: ["编码", "Coder"],
    reviewer: ["审查", "Reviewer"], researcher: ["研究", "Researcher"],
    worker: ["执行", "Worker"], subagent: ["子代理", "Subagent"],
  };
  return names[name.toLowerCase()]?.[locale === "en" ? 1 : 0] ?? (name || (locale === "en" ? "Agent" : "代理"));
}
function displayModel(raw: string) {
  const { token } = splitModelRef(raw);
  const cleaned = clean(token, 256);
  if (!cleaned) return "";
  const parts = cleaned.split(/[\\/]/u).filter(Boolean);
  return clean(parts.at(-1) || cleaned, 80);
}
function badgeText(record: RouteLog, locale: "zh" | "en") {
  const agent = localAgentName(record.agent, locale);
  const model = displayModel(record.requestedModel);
  if (locale === "en") {
    if (record.outcome === "blocked") return `${agent}: Not started — ${clean(record.reason, 70)}`;
    if (!model) return `${agent}: Model not recorded`;
    if (record.outcome === "explicit") return `${agent}: Selected ${model} (requested)`;
    if (record.outcome === "fallback") return `${agent}: Selected ${model} (backup)`;
    return `${agent}: Selected ${model}`;
  }
  if (record.outcome === "blocked") return `${agent}：未启动，${clean(record.reason, 70)}`;
  if (!model) return `${agent}：未记录模型`;
  if (record.outcome === "explicit") return `${agent}：已选 ${model}（指定）`;
  if (record.outcome === "fallback") return `${agent}：已选 ${model}（备用）`;
  return `${agent}：已选 ${model}`;
}
function mark(pi: ExtensionAPI, ctx: ExtensionContext | undefined, record: RouteLog, locale: "zh" | "en") {
  if (!ctx || ctx.mode !== "tui" || record.outcome === "skipped") return;
  try { pi.appendEntry<Badge>(PLUGIN, { summary: badgeText(record, locale) }); }
  catch { /* 会话条目失败不影响派发 */ }
}
function status(ctx: ExtensionContext | undefined, text?: string) {
  try { ctx?.ui.setStatus(PLUGIN, text); } catch { /* 页脚状态是提示，不是门禁 */ }
}

export default function jevRoute(pi: ExtensionAPI) {
  pi.registerTool({
    name: 'jev_route_history',
    label: 'Jev route history',
    description: 'Read local Jev routing records. List recent records from the current session by default, or retrieve one record by ID. Set allSessions=true only when cross-session history is needed. Does not expose task text or tool payloads. Async lifecycle is not followed; use returned runId/asyncId with subagent status where supported.',
    parameters: Type.Object({
      id: Type.Optional(Type.String({ description: 'Exact route record ID' })),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })),
      allSessions: Type.Optional(Type.Boolean()),
    }),
    async execute(_callId, params, _signal, _update, ctx) {
      try {
        const db = ensureStore();
        const sessionId = ctx.sessionManager.getSessionId();
        if (params.id) {
          const record = db.findLogById(params.id, params.allSessions ? undefined : sessionId);
          return { content: [{ type: 'text', text: JSON.stringify({ record: record ?? null }) }], details: undefined };
        }
        const limit = Math.min(params.limit ?? 20, 50);
        const records = params.allSessions ? db.getLogs(limit) : db.getLogsBySession(sessionId, limit);
        return { content: [{ type: 'text', text: JSON.stringify({ records }) }], details: undefined };
      } catch (error) {
        throw new Error(`Route history query failed: ${error instanceof Error ? error.message : 'unknown error'}`);
      }
    },
  });
  pi.registerEntryRenderer<Badge>(PLUGIN, (entry: CustomEntry<Badge>, _, theme) => {
    const detail = entry.data?.summary ?? entry.data?.text ?? "";
    return new Text(theme.fg("dim", detail), 0, 0);
  });
  let store: ReturnType<typeof openStore> | undefined;
  let context: ExtensionContext | undefined;
  let settingsError = "", keyAvailable = false;
  let lifetime = new AbortController();
  let web: Awaited<ReturnType<typeof import("./lib/web.ts").startWeb>> | undefined;
  let opening: Promise<void> | undefined;
  let supervision: SupervisionRuntime | undefined;
  const pending = new Map<string, string>();
  const agents = new Map<string, { type: string; model?: string }>();
  const invalidate = () => { lifetime.abort(); lifetime = new AbortController(); pending.clear(); agents.clear(); web?.close(); web = undefined; opening = undefined; supervision?.settingsChanged(); };
  const settings = () => {
    try { const value = store?.getSettings() ?? { ...DEFAULTS }; settingsError = ''; return value; }
    catch { settingsError = '设置格式与当前扩展不兼容，请 /reload 加载最新版；原数据已保留。'; return { ...DEFAULTS, enabled: false, supervision: { ...DEFAULTS.supervision, enabled: false } }; }
  };
  const ensureStore = () => {
    store ??= openStore(join(getAgentDir(), "jev-route.sqlite"));
    store.getSettings();
    return store;
  };
  const snapshot = () => {
    const current = settings();
    return { settings: current, defaults: DEFAULTS,
      defaultModels: { en: context ? scopedCandidates(context, { ...DEFAULTS, locale: "en" }) : [], zh: context ? scopedCandidates(context, { ...DEFAULTS, locale: "zh" }) : [] },
      models: context ? scopedCandidates(context, current) : [],
      catalog: context ? catalogEntries(availableModels(context).values()) : [],
      currentModel: context?.model ? modelId(context.model) : "", scopeMode: loadPiEnabledModels().tokens.length ? "enabledModels" : "none",
      keyAvailable, logs: store?.getLogs() ?? [], settingsError, coverage: COVERAGE,
      supervision: supervision?.snapshot() ?? { tasks: [], events: [], coverage: [] } };
  };
  const isLocalInteractive = (ctx: ExtensionContext) => ctx.mode === "tui" && !process.env.SSH_CONNECTION && !process.env.SSH_CLIENT && !process.env.SSH_TTY && !process.env.CI && !process.env.GITHUB_ACTIONS && !process.env.PI_SUBAGENT;
  const ensureWeb = async (ctx: ExtensionContext) => {
    if (!isLocalInteractive(ctx)) return undefined;
    ensureStore();
    const operation = lifetime;
    if (web && !web.closed) return web;
    const attempt = opening ??= (async () => {
      const { startWeb } = await import("./lib/web.ts");
      const welcome = await readFile(new URL("./web/onboarding.html", import.meta.url), "utf8");
      const server = await startWeb(snapshot,
        (value, previous) => { ensureStore().saveSettings(parseSettings(value), previous); supervision?.settingsChanged(); },
        (id, value, previous) => { ensureStore().setNote(id, value, previous); },
        300000, welcome, () => ensureStore().setMetadata("onboarding-complete", "yes"),
        model => { if (!context) throw new TypeError("会话尚未就绪"); return addEnabledModel(model, availableModels(context)); });
      if (operation !== lifetime) server.close(); else web = server;
    })();
    try { await attempt; } finally { if (opening === attempt) opening = undefined; }
    return operation === lifetime && web && !web.closed ? web : undefined;
  };
  const openPage = async (ctx: ExtensionContext, page: "welcome" | "settings") => {
    const operation = lifetime;
    const server = await ensureWeb(ctx);
    if (!server || operation !== lifetime) return false;
    server.touch();
    const url = new URL(server.url);
    url.pathname = page === "welcome" ? "/welcome" : "/";
    if (operation !== lifetime) return false;
    try {
      const result = process.platform === "darwin" ? await pi.exec("open", [url.href], { timeout: 5000 }) : process.platform === "win32" ? await pi.exec("rundll32.exe", ["url.dll,FileProtocolHandler", url.href], { timeout: 5000 }) : await pi.exec("xdg-open", [url.href], { timeout: 5000 });
      if (result.code === 0) return true;
    } catch { /* Preserve routing even if the OS cannot launch a browser. */ }
    if (operation === lifetime) ctx.ui.notify(`Open this page locally: ${url.href}`, "warning");
    return false;
  };
  const initialize = async (ctx: ExtensionContext) => {
    invalidate(); context = ctx;
    try { ensureStore(); settingsError = ""; }
    catch { settingsError = "无法读取路由配置或日志；未覆盖原文件。修复后 /reload。"; ctx.ui.notify(settingsError, "warning"); return; }
    keyAvailable = Boolean(process.env.TYPESAFE_API_KEY?.trim());
    if (!keyAvailable) { try { keyAvailable = Boolean((await readFile(join(homedir(), ".config/typesafe/api_key"), "utf8")).trim()); } catch { /* Not configured. */ } }
    if (!isLocalInteractive(ctx)) return;
    const db = store!, owner = randomUUID(), operation = lifetime;
    try {
      if (!db.claimOnboarding(owner)) return;
      if (!await openPage(ctx, "welcome")) { if (store === db) db.releaseOnboarding(owner); }
    } catch {
      if (store === db) { try { db.releaseOnboarding(owner); } catch { /* Retry remains possible after the lease expires. */ } }
      if (operation === lifetime) ctx.ui.notify("Could not open the welcome page. Run /pi-jev-route-setting welcome to retry.", "warning");
    }
  };
  pi.on("session_start", (_, ctx) => initialize(ctx));
  pi.on("session_tree", (_, ctx) => { invalidate(); context = ctx; });
  supervision = registerSupervision(pi, {
    settings: () => settings().supervision,
    store: () => ensureStore(),
    allowedModels: ctx => scopedCandidates(ctx, settings()).filter(model => model.enabled).map(model => model.id),
    locale: () => settings().locale,
  });
  pi.on("session_before_switch", invalidate);
  pi.on("session_before_fork", invalidate);
  pi.on("session_before_tree", invalidate);
  pi.on("model_select", (_, ctx) => { context = ctx; });
  pi.on("session_shutdown", () => { invalidate(); store?.close(); store = undefined; });

  pi.on("before_agent_start", (event, ctx) => {
    context = ctx;
    if (settingsError || !settings().enabled || !pi.getAllTools().some(tool => tool.name === "subagent")) return;
    return { systemPrompt: event.systemPrompt + "\n\n" + ROUTING_PROMPT[settings().locale] };
  });

  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName !== "subagent" || event.input.action !== undefined) return;
    context = ctx;
    if (settingsError) return { block: true, reason: settingsError };
    const config = settings();
    if (!config.enabled) return;
    const text = copy(config.locale);
    const input = event.input;
    const id = randomUUID();
    const agent = clean(input.agent) || "workflow";
    const task = typeof input.task === "string" ? input.task : "";
    const record: RouteLog = { id, at: new Date().toISOString(), sessionId: ctx.sessionManager.getSessionId(),
      toolCallId: event.toolCallId, agent, taskHash: createHash("sha256").update(task).digest("hex").slice(0, 16),
      outcome: "skipped", requestedModel: clean(input.model), reason: "", note: "", executionState: 'unknown' };
    const log = () => { ensureStore().addLog(record); pending.set(event.toolCallId, id); mark(pi, ctx, record, settings().locale); };
    try {
      if (["workflow", "workflowScript", "workflowScriptPath", "tasks", "chain", "parallel"].some(key => input[key] !== undefined) || input.machine !== undefined) {
        record.reason = text.workflowSkip; log(); return;
      }
      const models = scopedCandidates(ctx, config);
      const allowedIds = models.filter(model => model.enabled && config.models[model.id]?.enabled !== false).map(model => model.id);
      const { defaultProvider } = loadPiEnabledModels();
      let ignoredExplicit = "";
      if (typeof input.model === "string" && input.model.trim()) {
        const listed = resolveListedModel(input.model, allowedIds, defaultProvider);
        if (listed) {
          const { thinking } = splitModelRef(input.model);
          input.model = thinking ? `${listed}:${thinking}` : listed;
          record.outcome = "explicit"; record.requestedModel = clean(input.model);
          record.reason = text.explicitCall; log(); return;
        }
        ignoredExplicit = clean(input.model);
        delete input.model;
        record.requestedModel = "";
      }
      if (typeof input.agent !== "string" || !input.agent.trim() || !task.trim()) {
        record.reason = text.missingTask; log(); return;
      }
      const profile = agents.get(input.agent);
      if (!profile) {
        record.outcome = "blocked"; record.reason = text.unknownAgent;
        log(); return { block: true, reason: record.reason };
      }
      if (profile.type !== "pi") { record.reason = text.externalAgent; log(); return; }
      if (profile.model) {
        const listed = resolveListedModel(profile.model, allowedIds, defaultProvider);
        if (listed) {
          record.outcome = "explicit"; record.requestedModel = profile.model;
          record.reason = text.explicitProfile; log(); return;
        }
        ignoredExplicit ||= clean(profile.model);
      }
      const operation = lifetime;
      const signal = AbortSignal.any([operation.signal, ...(ctx.signal ? [ctx.signal] : [])]);
      status(ctx, PLUGIN);
      const parent = ctx.model ? ctx.modelRegistry.getAvailable().find(model => modelId(model) === modelId(ctx.model!)) : undefined;
      const main: Candidate | undefined = parent ? { id: modelId(parent), name: parent.name, reasoning: parent.reasoning, enabled: true, description: text.parentModel } : undefined;
      const decision = await routeTask(task, input.agent, models, config, main, signal);
      signal.throwIfAborted();
      if (operation !== lifetime) return { block: true, reason: text.sessionChanged };
      record.outcome = decision.outcome;
      record.reason = ignoredExplicit ? text.ignoredExplicit(ignoredExplicit, decision.reason) : decision.reason;
      record.confidence = decision.confidence;
      record.audit = decision.audit;
      if (decision.outcome === "blocked" || !decision.model || !decision.thinking) {
        log(); return { block: true, reason: text.notDispatched(record.reason) };
      }
      // Refresh scope/config after classification, before changing the tool's validated input.
      if (JSON.stringify(config) !== JSON.stringify(settings()) || !scopedCandidates(ctx, config).some(model => model.enabled && model.id === decision.model)) {
        record.outcome = "blocked"; record.reason = text.scopeChanged; log();
        return { block: true, reason: record.reason };
      }
      record.requestedModel = `${decision.model}:${decision.thinking}`;
      log(); // Persist the decision before allowing execution; no unlogged automatic dispatch.
      input.model = record.requestedModel;
    } catch {
      return { block: true, reason: copy(settings().locale).cancelled };
    } finally { status(ctx); }
  });

  pi.on("tool_result", (event) => {
    if (event.toolName === "subagent" && event.input?.action !== undefined) {
      if (!event.isError && event.input.action === "list") {
        const rows = (event.details as { agentCapabilities?: { agents?: unknown } } | undefined)?.agentCapabilities?.agents;
        if (Array.isArray(rows)) {
          agents.clear();
          for (const row of rows) {
            if (!row || typeof row !== "object" || typeof row.name !== "string" || typeof row.runner?.type !== "string" || !row.executable) continue;
            agents.set(row.name, { type: row.runner.type, model: typeof row.model?.value === "string" ? row.model.value : undefined });
          }
        }
      } else if (["create", "update", "delete"].includes(String(event.input.action))) agents.clear();
    }
    if (event.toolName !== 'subagent') return;
    const id = pending.get(event.toolCallId);
    if (!id || !store) return;
    pending.delete(event.toolCallId);
    const details = event.details as { results?: { model?: unknown; thinking?: unknown; exitCode?: unknown }[]; asyncId?: unknown; runId?: unknown } | undefined;
    const result = Array.isArray(details?.results) && details.results.length === 1 ? details.results[0] : undefined;
    let receipt = '';
    try {
      const text = copy(settings().locale);
      const prior = store.getLog(id);
      const executionState = prior?.outcome === 'blocked' ? 'not_started' : event.isError ? 'failed' : result ? typeof result.exitCode !== 'number' ? 'unknown' : result.exitCode === 0 ? 'completed' : 'failed' : details?.asyncId ? 'accepted' : 'unknown';
      store.updateLog(id, { ...(typeof result?.model === "string" ? { actualModel: clean(result.model) } : {}),
        ...(typeof result?.thinking === "string" ? { actualThinking: clean(result.thinking, 20) } : {}),
        ...(typeof details?.asyncId === "string" ? { asyncId: clean(details.asyncId) } : {}),
        ...(typeof details?.runId === "string" ? { runId: clean(details.runId) } : {}), executionState,
        updatedAt: new Date().toISOString(), ...(result ? { evidence: { source: 'tool_result' as const, ...(typeof result.exitCode === 'number' ? { exitCode: result.exitCode } : {}), resultCount: 1 } } : {}),
        actualStatus: event.isError ? text.toolError : result ? executionState === 'completed' ? text.agentDone : executionState === 'failed' ? text.agentFailed : '运行状态未知；请查询 subagent 状态' : details?.asyncId ? `${text.asyncAccepted}；asyncId=${clean(details.asyncId)}` : text.resultMissing });
      const updated = store.getLog(id)!;
      receipt = `\n\n[Jev route receipt] routeId=${id}; requested=${updated.requestedModel || '(none)'}; actual=${updated.actualModel || 'unknown'}${updated.actualThinking ? `/${updated.actualThinking}` : ''}; outcome=${updated.outcome}; reason=${updated.reason || '(none)'}; execution=${executionState}; query=jev_route_history(id=${id})${updated.asyncId ? `; asyncId=${updated.asyncId}` : ''}${updated.runId ? `; runId=${updated.runId}` : ''}${updated.asyncId || updated.runId ? ' (check subagent status)' : ''}`;
    } catch { context?.ui.notify("Jev 路由执行记录更新失败；结果未持久化。", "warning"); receipt = `\n\n[Jev route receipt] routeId=${id}; execution=unknown; persistence=FAILED; query=jev_route_history(id=${id})`; }
    return { content: [...(event.content ?? []), { type: 'text', text: receipt }], details: event.details, isError: event.isError, usage: event.usage };
  });

  const command = {
    description: "Open routing settings; manage models and view routing audit logs",
    handler: async (args: string, ctx: ExtensionContext) => {
      context = ctx;
      const action = args.trim() || "settings";
      if (action === "welcome") { if (!isLocalInteractive(ctx)) { ctx.ui.notify("欢迎页只在本机交互式 Pi 中打开。", "warning"); return; } try { await openPage(ctx, "welcome"); } catch { ctx.ui.notify("无法打开欢迎页，请检查文件权限。", "error"); } return; }
      const describeLog = (record: RouteLog) => {
        const model = record.requestedModel || "未知（未记录请求模型）";
        const execution = record.actualStatus || "未收到执行结果；实际执行情况未知";
        return `审计 ${record.id} · ${record.at}\n代理：${record.agent}\n做了什么：${record.reason}\n为什么：${record.audit?.reasonCode ?? "旧日志或该路径没有结构化原因码"}${record.audit ? `；耗时 ${record.audit.durationMs}ms；回退来源 ${record.audit.fallbackSource}` : ""}\n请求模型：${model}（不等于已确认的实际模型）\n执行状态：${execution}${record.actualModel ? `；报告模型 ${record.actualModel}` : "；实际模型未确认"}${record.asyncId ? `；后台任务 ${record.asyncId}` : ""}${record.runId ? `；运行 ${record.runId}` : ""}`;
      };
      if (action === "last") {
        const latest = ensureStore().getLatestLog();
        ctx.ui.notify(latest ? describeLog(latest) : "尚无路由审计记录。", "info"); return;
      }
      if (action.startsWith("log ")) {
        const reference = action.slice(4).trim();
        if (!reference) { ctx.ui.notify("用法：/pi-jev-route-setting log <完整编号或唯一前缀>", "info"); return; }
        const found = ensureStore().findLog(reference);
        ctx.ui.notify(found.ambiguous ? "审计编号前缀有歧义，请提供更长前缀。" : found.log ? describeLog(found.log) : "未找到该审计记录。", "info"); return;
      }
      if (action === "status") {
        ctx.ui.notify(settingsError || `Jev 子代理路由${settings().enabled ? "已启用" : "已关闭"}；主会话模型不变。${COVERAGE}`, "info"); return;
      }
      if (action === "on" || action === "off") {
        try { const db = ensureStore(); db.saveSettings({ ...db.getSettings(), enabled: action === "on" }); invalidate(); ctx.ui.notify(`子代理路由已${action === "on" ? "开启" : "关闭"}；主会话模型未改变。`, "info"); }
        catch { ctx.ui.notify("设置未保存，原文件未覆盖。", "error"); }
        return;
      }
      if (action !== "settings") { ctx.ui.notify("用法：/pi-jev-route-setting [settings|welcome|on|off|status|last|log <id或唯一前缀>]", "info"); return; }
      if (!isLocalInteractive(ctx)) { ctx.ui.notify("请在本机交互式 Pi 中打开 HTML 设置。", "warning"); return; }
      try { await openPage(ctx, "settings"); }
      catch { ctx.ui.notify("无法打开路由设置，请检查文件权限。", "error"); }
    },
  };
  pi.registerCommand("pi-jev-route-setting", command);
}
