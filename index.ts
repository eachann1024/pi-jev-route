import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { getAgentDir, type CustomEntry, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { copy, ROUTING_PROMPT } from "./lib/copy.ts";
import { defaultModelDescription } from "./lib/describe.ts";
import { loadPiEnabledModels, modelId, resolveEnabledIds, resolveListedModel, splitModelRef } from "./lib/enabled.ts";
import { DEFAULTS, openStore, parseSettings, type RouteLog, type Settings } from "./lib/store.ts";
import { routeTask, type Candidate } from "./lib/router.ts";

const COVERAGE = "自动覆盖模型发起的结构化 subagent 单任务（含 async）。workflow、/run、定时任务、其他扩展直接派发和子代理内部派发不保证覆盖；未覆盖的工具工作流会记为跳过。";
const PLUGIN = "pi-jev-route";
type Badge = { text: string };
const clean = (value: unknown, max = 256) => typeof value === "string" ? value.replace(/[\u0000-\u001f]/g, " ").slice(0, max) : "";

export function scopedCandidates(ctx: ExtensionContext, settings: Settings) {
  const available = new Map(ctx.modelRegistry.getAvailable().map(model => [modelId(model), model]));
  const { tokens, defaultProvider } = loadPiEnabledModels();
  const ids = resolveEnabledIds(tokens, available, defaultProvider);
  return ids.map(id => {
    const model = available.get(id);
    const name = model?.name || id.split("/").pop() || id;
    const saved = settings.models[id];
    return { id, name, reasoning: model?.reasoning ?? true, enabled: saved?.enabled ?? true,
      description: (saved?.description?.trim() ? saved.description : defaultModelDescription(id, name, settings.locale)),
      current: ctx.model ? id === modelId(ctx.model) : false, scoped: tokens.length > 0 };
  });
}

function badgeText(record: RouteLog) {
  const model = record.requestedModel ? ` ${record.requestedModel}` : "";
  return `${record.agent} · ${record.outcome}${model}`;
}
function mark(pi: ExtensionAPI, ctx: ExtensionContext | undefined, record: RouteLog) {
  if (!ctx || ctx.mode !== "tui" || record.outcome === "skipped") return;
  try { pi.appendEntry<Badge>(PLUGIN, { text: badgeText(record) }); }
  catch { /* 会话条目失败不影响派发 */ }
}
function status(ctx: ExtensionContext | undefined, text?: string) {
  try { ctx?.ui.setStatus(PLUGIN, text); } catch { /* 页脚状态是提示，不是门禁 */ }
}

export default function jevRoute(pi: ExtensionAPI) {
  pi.registerEntryRenderer<Badge>(PLUGIN, (entry: CustomEntry<Badge>, _, theme) => {
    const detail = entry.data?.text ? ` ${entry.data.text}` : "";
    return new Text(theme.fg("accent", PLUGIN) + theme.fg("dim", detail), 0, 0);
  });
  let store: ReturnType<typeof openStore> | undefined;
  let context: ExtensionContext | undefined;
  let settingsError = "", keyAvailable = false;
  let lifetime = new AbortController();
  let web: Awaited<ReturnType<typeof import("./lib/web.ts").startWeb>> | undefined;
  let opening: Promise<void> | undefined;
  const pending = new Map<string, string>();
  const agents = new Map<string, { type: string; model?: string }>();
  const invalidate = () => { lifetime.abort(); lifetime = new AbortController(); pending.clear(); agents.clear(); web?.close(); web = undefined; };
  const settings = () => store?.getSettings() ?? { ...DEFAULTS };
  const ensureStore = () => {
    store ??= openStore(join(getAgentDir(), "jev-route.sqlite"));
    store.getSettings();
    return store;
  };
  const snapshot = () => {
    const current = settings();
    return { settings: current, models: context ? scopedCandidates(context, current) : [],
      currentModel: context?.model ? modelId(context.model) : "", scopeMode: loadPiEnabledModels().tokens.length ? "enabledModels" : "none",
      keyAvailable, logs: store?.getLogs() ?? [], settingsError, coverage: COVERAGE };
  };
  const initialize = async (ctx: ExtensionContext) => {
    invalidate(); context = ctx;
    try { ensureStore(); settingsError = ""; }
    catch { settingsError = "无法读取路由配置或日志；未覆盖原文件。修复后 /reload。"; ctx.ui.notify(settingsError, "warning"); }
    keyAvailable = Boolean(process.env.TYPESAFE_API_KEY?.trim());
    if (!keyAvailable) { try { keyAvailable = Boolean((await readFile(join(homedir(), ".config/typesafe/api_key"), "utf8")).trim()); } catch { /* Not configured. */ } }
  };
  pi.on("session_start", (_, ctx) => initialize(ctx));
  pi.on("session_tree", (_, ctx) => { invalidate(); context = ctx; });
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
      outcome: "skipped", requestedModel: clean(input.model), reason: "", note: "" };
    const log = () => { ensureStore().addLog(record); pending.set(event.toolCallId, id); mark(pi, ctx, record); };
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
    const id = pending.get(event.toolCallId);
    if (!id || !store) return;
    pending.delete(event.toolCallId);
    const details = event.details as { results?: { model?: unknown; thinking?: unknown; exitCode?: unknown }[]; asyncId?: unknown; runId?: unknown } | undefined;
    const result = Array.isArray(details?.results) && details.results.length === 1 ? details.results[0] : undefined;
    try {
      const text = copy(settings().locale);
      store.updateLog(id, { ...(typeof result?.model === "string" ? { actualModel: clean(result.model) } : {}),
        ...(typeof result?.thinking === "string" ? { actualThinking: clean(result.thinking, 20) } : {}),
        actualStatus: event.isError ? text.toolError : result ? (result.exitCode === 0 ? text.agentDone : text.agentFailed) : details?.asyncId ? text.asyncAccepted : text.resultMissing });
    } catch { context?.ui.notify("Jev 无法更新执行报告，已保留原判定日志。", "warning"); }
  });

  const command = {
    description: "打开 Pi Jev Route 设置与日志；或 on / off / status",
    handler: async (args: string, ctx: ExtensionContext) => {
      context = ctx;
      const action = args.trim() || "settings";
      if (action === "status") {
        ctx.ui.notify(settingsError || `Jev 子代理路由${settings().enabled ? "已启用" : "已关闭"}；主会话模型不变。${COVERAGE}`, "info"); return;
      }
      if (action === "on" || action === "off") {
        try { const db = ensureStore(); db.saveSettings({ ...db.getSettings(), enabled: action === "on" }); invalidate(); ctx.ui.notify(`子代理路由已${action === "on" ? "开启" : "关闭"}；主会话模型未改变。`, "info"); }
        catch { ctx.ui.notify("设置未保存，原文件未覆盖。", "error"); }
        return;
      }
      if (action !== "settings") { ctx.ui.notify("用法：/pi-jev-route [settings|on|off|status]；不再提供主会话 auto/shadow 模式。", "info"); return; }
      if (ctx.mode !== "tui") { ctx.ui.notify("请在本机交互式 Pi 中打开 HTML 设置。", "warning"); return; }
      try {
        ensureStore();
        if (!web || web.closed) {
          const operation = lifetime;
          opening ??= (async () => {
            const { startWeb } = await import("./lib/web.ts");
            const server = await startWeb(snapshot,
              (value, previous) => { ensureStore().saveSettings(parseSettings(value), previous); },
              (id, value, previous) => { ensureStore().setNote(id, value, previous); });
            if (operation !== lifetime) server.close(); else web = server;
          })();
          try { await opening; } finally { opening = undefined; }
        }
        if (!web || web.closed) return;
        web.touch();
        const url = web.url;
        const result = process.platform === "darwin" ? await pi.exec("open", [url]) : process.platform === "win32" ? await pi.exec("rundll32.exe", ["url.dll,FileProtocolHandler", url]) : await pi.exec("xdg-open", [url]);
        if (result.code !== 0) ctx.ui.notify(`请在本机打开：${url}`, "info");
      } catch { ctx.ui.notify("无法打开路由设置，请检查文件权限。", "error"); }
    },
  };
  pi.registerCommand("pi-jev-route", command);
}
