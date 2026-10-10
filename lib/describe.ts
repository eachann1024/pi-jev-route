import { LIGHT_MODEL_DESCRIPTION as LIGHT, ROUTING_PROMPT as PROMPTS, STRONG_MODEL_DESCRIPTION as STRONG, type Locale } from "./copy.ts";

export const DESCRIPTION_PLACEHOLDER = "简述模型适用场景。例如：轻量档适合文件检索、文本整理与局部小修改；强力档适合跨文件架构重构、复杂算法编写或排查未复现 bug。";
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
