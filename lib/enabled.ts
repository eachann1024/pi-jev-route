import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export type CatalogModel = { provider: string; id: string; name: string; reasoning: boolean };
export const modelId = (model: { provider: string; id: string }) => `${model.provider}/${model.id}`;

export function loadPiEnabledModels(dir = getAgentDir()): { tokens: string[]; defaultProvider: string } {
  try {
    const raw: unknown = JSON.parse(readFileSync(join(dir, "settings.json"), "utf8"));
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { tokens: [], defaultProvider: "" };
    const settings = raw as Record<string, unknown>;
    const tokens = Array.isArray(settings.enabledModels)
      ? settings.enabledModels.filter((item): item is string => typeof item === "string" && item.trim() !== "").map(item => item.trim())
      : [];
    const defaultProvider = typeof settings.defaultProvider === "string" ? settings.defaultProvider.trim() : "";
    return { tokens, defaultProvider };
  } catch {
    return { tokens: [], defaultProvider: "" };
  }
}

export function splitModelRef(raw: string): { token: string; thinking?: "off" | "low" | "high" } {
  const value = raw.trim();
  const match = value.match(/^(.*?)(?::(off|low|high))$/iu);
  if (match?.[1]?.trim()) return { token: match[1].trim(), thinking: match[2].toLowerCase() as "off" | "low" | "high" };
  return { token: value };
}

export function resolveListedModel(raw: string, ids: readonly string[], defaultProvider = "") {
  const { token } = splitModelRef(raw);
  if (!token) return;
  if (ids.includes(token)) return token;
  if (defaultProvider) {
    const prefixed = `${defaultProvider}/${token}`;
    if (ids.includes(prefixed)) return prefixed;
  }
  const suffix = ids.filter(id => id.endsWith(`/${token}`));
  if (suffix.length === 1) return suffix[0];
}

export function resolveEnabledIds(tokens: string[], available: Map<string, CatalogModel>, defaultProvider = "") {
  const ids: string[] = [];
  for (const token of tokens) {
    const id = matchToken(token, available, defaultProvider)
      ?? (token.includes("/") ? token : defaultProvider ? `${defaultProvider}/${token}` : token);
    if (!ids.includes(id)) ids.push(id);
  }
  return ids;
}

function matchToken(token: string, available: Map<string, CatalogModel>, defaultProvider: string) {
  if (available.has(token)) return token;
  if (defaultProvider) {
    const prefixed = `${defaultProvider}/${token}`;
    if (available.has(prefixed)) return prefixed;
  }
  const byId = [...available.values()].filter(model => model.id === token);
  if (byId.length === 1) return modelId(byId[0]);
  const suffix = [...available.keys()].filter(id => id.endsWith(`/${token}`));
  if (suffix.length === 1) return suffix[0];
}
