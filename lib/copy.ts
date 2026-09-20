export type Locale = "zh" | "en";
export function isLocale(value: unknown): value is Locale {
  return value === "zh" || value === "en";
}

export const ROUTING_PROMPT = {
  zh: "Jev 子代理路由：主会话保持当前模型。主会话负责需求对齐、任务调度、关键决策和总结；应先调研清楚风险点并给出完整解决方案。激进地使用子代理，越多越好，目的是节省时间；不要派没有独立产出的空代理。绝大部分情况使用 enabledModels 里的 low。样式编写：子代理 + 当前模型 + low 思考强度。验收只需要编译成功即通过。首次自动派发前先调用 subagent({action:'list',capabilities:true})。结构化 subagent({agent, task}) 请省略 model，由 Jev 只从 enabledModels 列表选型。不要填写列表外的模型名（包括插件名 pi-jev-route 或其他供应商）。列表内别名（如 low）按该模型执行；列表外指定会被忽略并重新选型。脚本和工作流不走本路由。",
  en: "Jev subagent routing: keep the parent session model. The parent aligns requirements, schedules work, makes key decisions, and summarizes; it must investigate risks and supply a complete plan first. Dispatch independent subagents aggressively to save time; do not spawn empty agents. Use the enabledModels low alias in most cases. Styling: a subagent plus the current model at low thinking. Acceptance is compile success only. Before the first automatic dispatch, call subagent({action:'list',capabilities:true}). Structured subagent({agent, task}) should omit model; Jev selects only from enabledModels. Do not pass out-of-list names, including the plugin name pi-jev-route or other providers. In-list aliases such as low are kept; out-of-list pins are ignored and re-selected. Scripts and workflows are not routed.",
} as const;

export const LIGHT_MODEL_DESCRIPTION = {
  zh: "轻量模型。适合边界清楚、可逆的读取、整理、小改动和常规实现；绝大多数子任务优先用这一档。",
  en: "Lightweight model. Use for bounded, reversible reads, cleanup, small edits, and routine implementation; prefer this for most subtasks.",
} as const;
export const STRONG_MODEL_DESCRIPTION = {
  zh: "强模型。适合复杂架构、含糊需求、疑难排错或需要更强判断的任务；不要作为常规默认。",
  en: "Strong model. Use for complex architecture, ambiguous work, hard debugging, or higher judgment; not the routine default.",
} as const;

const zh = {
  noCandidates: "没有启用的候选模型",
  routingOff: "自动选型已关闭",
  taskTooLong: "任务超过出站长度上限，未调用 Jev",
  sensitive: "检测到可能的敏感信息，未调用 Jev",
  requestTooLong: "请求超过出站长度上限，未调用 Jev",
  noKey: "Jev 密钥不可用，使用本地回退",
  needHuman: "Jev 判定需要用户先确认，未派发。",
  lowConfidence: "Jev 置信度不足，使用本地回退",
  styleMain: "样式任务使用当前主模型与低思考；未切换主会话模型。",
  styleMainOff: "样式任务使用当前主模型；该模型不支持思考强度，使用 off。",
  styleMainMissing: "样式规则要求主模型，但主模型不在当前启用范围，未派发。",
  selectedOff: "Jev 从允许候选中选型；该模型不支持思考强度，使用 off。",
  selectedHigh: "Jev 从允许候选中选型；复杂度评分达到高思考阈值。",
  selectedLow: "Jev 从允许候选中选型；使用默认低思考。",
  timeout: "Jev 请求超时，使用本地回退",
  requestFailed: "Jev 请求失败或回答无效，使用本地回退",
  noFallback: (reason: string) => `${reason}；当前范围内没有有效回退模型，未派发。`,
  workflowSkip: "此工作流或远程派发不在当前拦截范围，参数未修改",
  explicitCall: "保留调用方在允许列表内指定的模型；不调用 Jev",
  missingTask: "没有可独立判定的 agent/task，保留原参数",
  unknownAgent: "尚未确认代理类型，请先调用 subagent({action:'list',capabilities:true})，再使用列表中的准确代理名派发",
  externalAgent: "外部执行器不参与 Pi 模型路由，保留原参数",
  explicitProfile: "保留代理配置中允许列表内的明确模型，不调用 Jev",
  ignoredExplicit: (requested: string, reason: string) => `忽略列表外指定 ${requested}；${reason}`,
  sessionChanged: "会话已变化，取消旧派发。",
  scopeChanged: "判定期间模型范围或配置变化，请重新派发",
  cancelled: "Jev 派发已取消或无法安全记录判定；子代理未启动，请检查 /pi-jev-route status。",
  notDispatched: (reason: string) => `Jev 未派发：${reason}`,
  toolError: "工具返回错误",
  agentDone: "子代理报告完成",
  agentFailed: "子代理报告非成功退出",
  asyncAccepted: "后台已受理；完成与模型尚未报告",
  resultMissing: "工具已返回；执行结果未报告",
  parentModel: "当前主会话模型",
} as const;

const en = {
  noCandidates: "No enabled candidate models",
  routingOff: "Automatic routing is off",
  taskTooLong: "Task exceeds outbound size; Jev was not called",
  sensitive: "Possible secret detected; Jev was not called",
  requestTooLong: "Request exceeds outbound size; Jev was not called",
  noKey: "Jev key unavailable; using local fallback",
  needHuman: "Jev requires the user first; dispatch blocked.",
  lowConfidence: "Jev confidence too low; using local fallback",
  styleMain: "Style work uses the current parent model at low thinking.",
  styleMainOff: "Style work uses the current parent model; thinking is off.",
  styleMainMissing: "Style work needs the parent model, which is not enabled; dispatch blocked.",
  selectedOff: "Jev selected an allowed model; thinking is off.",
  selectedHigh: "Jev selected an allowed model; complexity reached high thinking.",
  selectedLow: "Jev selected an allowed model; using default low thinking.",
  timeout: "Jev timed out; using local fallback",
  requestFailed: "Jev failed or returned an invalid answer; using local fallback",
  noFallback: (reason: string) => `${reason}; no valid fallback in range, dispatch blocked.`,
  workflowSkip: "This workflow or remote dispatch is out of scope; parameters unchanged",
  explicitCall: "Kept the caller-specified model in the allowed list; Jev was not called",
  missingTask: "No standalone agent/task; parameters unchanged",
  unknownAgent: "Agent type is unknown; call subagent({action:'list',capabilities:true}) first, then dispatch with an exact name",
  externalAgent: "External runners are not routed; parameters unchanged",
  explicitProfile: "Kept the in-list agent-profile model; Jev was not called",
  ignoredExplicit: (requested: string, reason: string) => `Ignored out-of-list pin ${requested}; ${reason}`,
  sessionChanged: "Session changed; cancelled the stale dispatch.",
  scopeChanged: "Model range or settings changed during routing; retry",
  cancelled: "Dispatch cancelled or could not be logged; the subagent did not start. Check /pi-jev-route status.",
  notDispatched: (reason: string) => `Jev did not dispatch: ${reason}`,
  toolError: "Tool returned an error",
  agentDone: "Subagent reported completion",
  agentFailed: "Subagent reported a non-zero exit",
  asyncAccepted: "Accepted in background; completion and model not yet reported",
  resultMissing: "Tool returned; execution result not reported",
  parentModel: "Current parent model",
} as const;

export function copy(locale: Locale | undefined) {
  return locale === "en" ? en : zh;
}
