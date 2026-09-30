import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { minimatch } from "minimatch";

export type CatalogModel = { provider: string; id: string; name: string; reasoning: boolean };
export type CatalogEntry = CatalogModel & { label: string };
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

const isGlob = (token: string) => /[*?[]/.test(token);

/** Exact catalog ids covered by Pi enabledModels tokens, including glob patterns. */
export function expandEnabledIds(tokens: string[], available: Map<string, CatalogModel>, defaultProvider = "") {
  const ids: string[] = [];
  const add = (id?: string) => { if (id && available.has(id) && !ids.includes(id)) ids.push(id); };
  for (const raw of tokens) {
    const { token } = splitModelRef(raw);
    if (!token) continue;
    if (isGlob(token)) {
      for (const model of available.values()) {
        const id = modelId(model);
        if (minimatch(id, token, { nocase: true }) || minimatch(model.id, token, { nocase: true })) add(id);
      }
      continue;
    }
    add(matchToken(token, available, defaultProvider));
  }
  return ids;
}

export function catalogEntries(available: Iterable<CatalogModel>): CatalogEntry[] {
  return [...available]
    .map(model => ({ ...model, label: `${model.provider}/${model.id}` }))
    .sort((a, b) => a.label.localeCompare(b.label));
}

/**
 * Append one exact provider/id to Pi's global enabledModels.
 * An empty list becomes a single-model allowlist. Existing tokens, including globs, stay.
 * Concurrent file edits are merged by re-reading under a temp-file replace.
 */
export function addEnabledModel(id: string, available: Map<string, CatalogModel>, dir = getAgentDir()) {
  if (!available.has(id)) throw new TypeError("模型不在可用目录中");
  const path = join(dir, "settings.json");
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  for (let attempt = 0; attempt < 3; attempt++) {
    const before = existsSync(path) ? readFileSync(path, "utf8") : "";
    const parsed: unknown = before.trim() ? JSON.parse(before) : {};
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new TypeError("settings.json 不是对象");
    const raw = parsed as Record<string, unknown>;
    const current = Array.isArray(raw.enabledModels)
      ? raw.enabledModels.filter((item): item is string => typeof item === "string")
      : [];
    const provider = typeof raw.defaultProvider === "string" ? raw.defaultProvider.trim() : "";
    const covered = new Set(expandEnabledIds(current, available, provider));
    if (covered.has(id) || current.some(token => token.trim().toLowerCase() === id.toLowerCase())) {
      return { tokens: current, added: false };
    }
    const tokens = [...current, id];
    const again = existsSync(path) ? readFileSync(path, "utf8") : "";
    if (again !== before) continue;
    writeFileSync(temporary, `${JSON.stringify({ ...raw, enabledModels: tokens }, null, 2)}\n`, "utf8");
    if ((existsSync(path) ? readFileSync(path, "utf8") : "") !== before) continue;
    renameSync(temporary, path);
    const saved = loadPiEnabledModels(dir);
    if (saved.tokens.some(token => token.toLowerCase() === id.toLowerCase())) return { tokens: saved.tokens, added: true };
  }
  throw new Error("conflict");
}
