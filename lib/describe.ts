export const DESCRIPTION_PLACEHOLDER = "写何时选用。轻量（flash 等）：边界清楚、可逆的小改动与常规实现。强模型（gpt 6、sol、kimi k3、glm 5、opus、sonnet、fable、grok）：复杂架构、含糊需求或疑难排错。";
export const LIGHT_MODEL_DESCRIPTION = "轻量模型。适合边界清楚、可逆的读取、整理、小改动和常规实现；绝大多数子任务优先用这一档。";
export const STRONG_MODEL_DESCRIPTION = "强模型。适合复杂架构、含糊需求、疑难排错或需要更强判断的任务；不要作为常规默认。";

function tokens(id: string, name = "") {
  const raw = `${id} ${name}`.toLowerCase();
  const last = id.split("/").at(-1)?.toLowerCase() ?? "";
  return { raw, last, compact: `${raw} ${last}`.replace(/[\s._-]+/g, "") };
}

export function defaultModelDescription(id: string, name = ""): string {
  if (typeof id !== "string" || typeof name !== "string") return "";
  const { raw, last, compact } = tokens(id, name);
  if (last === "low" || /\b(flash|lite|mini|nano|haiku)\b/.test(raw) || /(flash|lite|mini|nano|haiku)/.test(compact)) return LIGHT_MODEL_DESCRIPTION;
  if (last === "high" || /\bgpt[\s._-]*6\b/.test(raw) || compact.includes("gpt6")
    || last === "sol" || last.startsWith("sol-") || /\bsol\b/.test(name.toLowerCase())
    || /\bkimi[\s._-]*k3\b/.test(raw) || compact.includes("kimik3")
    || /\bglm[\s._-]*5(\b|\.|x)/.test(raw) || compact.includes("glm5")
    || /\b(opus|sonnet|fable|grok)\b/.test(raw)) return STRONG_MODEL_DESCRIPTION;
  return "";
}

export const ROUTING_PROMPT = "Jev 子代理路由：主会话保持当前模型。主会话负责需求对齐、任务调度、关键决策和总结；派发前先调研风险并给出完整方案。有独立工作就并行派发子代理，尽量重叠以节省时间，不要派没有独立产出的空代理。绝大多数任务使用 low。样式编写：子代理 + 当前主模型 + low 思考。验收默认编译成功即通过；用户未要求时不要把编译说成运行或视觉已验证。首次自动派发前先调用 subagent({action:'list',capabilities:true})。结构化 subagent({agent, task, async:true}) 且省略 model 时由 Jev 在允许范围内选型。脚本和工作流不走本路由。调用方或代理配置写死的模型不覆盖。路由不授予额外权限。";
