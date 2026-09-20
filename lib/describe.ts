import { LIGHT_MODEL_DESCRIPTION as LIGHT, ROUTING_PROMPT as PROMPTS, STRONG_MODEL_DESCRIPTION as STRONG, type Locale } from "./copy.ts";

export const DESCRIPTION_PLACEHOLDER = "写何时选用。轻量（flash 等）：边界清楚、可逆的小改动与常规实现。强模型（gpt 6、sol、kimi k3、glm 5、opus、sonnet、fable、grok）：复杂架构、含糊需求或疑难排错。";
export const LIGHT_MODEL_DESCRIPTION = LIGHT.zh;
export const STRONG_MODEL_DESCRIPTION = STRONG.zh;
export const ROUTING_PROMPT = PROMPTS.zh;

function tokens(id: string, name = "") {
  const raw = `${id} ${name}`.toLowerCase();
  const last = id.split("/").at(-1)?.toLowerCase() ?? "";
  return { raw, last, compact: `${raw} ${last}`.replace(/[\s._-]+/g, "") };
}

export function defaultModelDescription(id: string, name = "", locale: Locale = "zh"): string {
  if (typeof id !== "string" || typeof name !== "string") return "";
  const { raw, last, compact } = tokens(id, name);
  if (last === "low" || /\b(flash|lite|mini|nano|haiku)\b/.test(raw) || /(flash|lite|mini|nano|haiku)/.test(compact)) return LIGHT[locale];
  if (last === "high" || /\bgpt[\s._-]*6\b/.test(raw) || compact.includes("gpt6")
    || last === "sol" || last.startsWith("sol-") || /\bsol\b/.test(name.toLowerCase())
    || /\bkimi[\s._-]*k3\b/.test(raw) || compact.includes("kimik3")
    || /\bglm[\s._-]*5(\b|\.|x)/.test(raw) || compact.includes("glm5")
    || /\b(opus|sonnet|fable|grok)\b/.test(raw)) return STRONG[locale];
  return "";
}
