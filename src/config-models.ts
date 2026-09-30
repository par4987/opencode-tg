/**
 * The user's own model catalogue: what `opencode.json(c)` declares, per
 * provider. This is what the desktop's model selector mirrors, and what the
 * bridge's /models picker must mirror too — a model the gateway lists but
 * the config does not declare is one this account may not even answer for,
 * and picking it is picking a door that may not open.
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** JSONC in, plain JSON out: line and block comments, trailing commas. */
export function stripJsonc(text: string): string {
  let out = "";
  let inString = false;
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    const next = text[i + 1] ?? "";
    if (inString) {
      out += ch;
      if (ch === "\\") {
        out += next;
        i += 2;
        continue;
      }
      if (ch === '"') inString = false;
      i += 1;
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
      i += 1;
      continue;
    }
    if (ch === "/" && next === "/") {
      while (i < text.length && text[i] !== "\n") i += 1;
      continue;
    }
    if (ch === "/" && next === "*") {
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i += 1;
      i += 2;
      continue;
    }
    out += ch;
    i += 1;
  }
  // Trailing commas are legal JSONC; JSON.parse wants them gone.
  let flat = out;
  let guard = 0;
  while (guard++ < 20) {
    const trimmed = flat.replace(/,(\s*[\]}])/g, "$1");
    if (trimmed === flat) break;
    flat = trimmed;
  }
  return flat;
}

export interface ConfigModel {
  /** The key in the config — the server uses it as the model's id suffix. */
  key: string;
  name?: string;
  disabled: boolean;
}

export interface ConfigProvider {
  id: string;
  models: ConfigModel[];
}

/**
 * The providers with hand-declared models in one config file. A disabled
 * model stays in the list (marked) so callers can tell "off" from "absent".
 */
export function parseConfigModels(text: string): ConfigProvider[] {
  const providers: ConfigProvider[] = [];
  let root: unknown;
  try {
    root = JSON.parse(stripJsonc(text)) as unknown;
  } catch {
    return providers;
  }
  const providerBlock =
    (root as Record<string, unknown> | null)?.providers ?? (root as Record<string, unknown> | null)?.provider;
  if (!providerBlock || typeof providerBlock !== "object") return providers;
  for (const [id, def] of Object.entries(providerBlock as Record<string, unknown>)) {
    if (!def || typeof def !== "object") continue;
    const models = (def as Record<string, unknown>).models;
    if (!models || typeof models !== "object") continue;
    const entries: ConfigModel[] = [];
    for (const [key, spec] of Object.entries(models as Record<string, unknown>)) {
      const fields = spec && typeof spec === "object" ? (spec as Record<string, unknown>) : {};
      const nameRaw = fields.name;
      entries.push({
        key,
        name: typeof nameRaw === "string" ? nameRaw : undefined,
        disabled: fields.disabled === true,
      });
    }
    if (entries.length > 0) providers.push({ id, models: entries });
  }
  return providers;
}

/**
 * The configs behind "the desktop setup": global scope first, then the given
 * project directories on top — the project's model keys win per provider.
 * Missing files contribute nothing; nothing ever throws.
 */
export function configProviders(projectDirectories: string[] = []): ConfigProvider[] {
  const files = [
    join(homedir(), ".config", "opencode", "opencode.jsonc"),
    join(homedir(), ".config", "opencode", "opencode.json"),
    ...projectDirectories.flatMap((dir) => [
      join(dir, "opencode.jsonc"),
      join(dir, "opencode.json"),
      join(dir, ".opencode", "opencode.json"),
    ]),
  ];
  const merged = new Map<string, ConfigProvider>();
  for (const file of files) {
    let text = "";
    try {
      if (!existsSync(file)) continue;
      text = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    for (const provider of parseConfigModels(text)) {
      const existing = merged.get(provider.id);
      if (!existing) {
        merged.set(provider.id, provider);
        continue;
      }
      const keys = new Map(existing.models.map((m) => [m.key, m]));
      for (const model of provider.models) keys.set(model.key, model);
      merged.set(provider.id, { id: provider.id, models: [...keys.values()] });
    }
  }
  return [...merged.values()];
}
