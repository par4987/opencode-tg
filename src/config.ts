/**
 * Configuration for the plugin.
 *
 * Sources, later wins:
 *   1. `~/.opencode/tg/.env`   — reused from the previous bot so the token and
 *      the allow-list are not duplicated (it is read, never written).
 *   2. `config.json` next to index.ts — everything else.
 *   3. `TG_*` environment variables.
 *
 * `mode` is what makes the migration safe:
 *   off   — plugin does nothing.
 *   dry   — subscribes and logs what it *would* send; Telegram is never touched,
 *           so the previous bot can keep running on the same token.
 *   live  — sends messages and starts long polling.
 */
import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { RenderOptions } from "./render-options.js";

const HERE = dirname(fileURLToPath(import.meta.url));
/** Plugin root: this file lives in `src/`, config.json sits one level up. */
const ROOT = join(HERE, "..");

export type Mode = "off" | "dry" | "live";

export interface Config {
  mode: Mode;
  token: string;
  allowedUsers: number[];
  render: RenderOptions;
  /** Which sessions to mirror into the chat. */
  mirror: "all" | "watched";
  /**
   * Close a session's thread automatically after this many idle days —
   * Telegram's "archive": visible, read-only, reopened on revival. 0 = off.
   */
  archiveAfterDays: number;
  /**
   * Coalescing window: text messages that arrive within this many
   * milliseconds of each other merge into one prompt. Human Telegram
   * cadence runs at 1-2s between follow-ups, so 800ms only caught
   * copy-paste bursts — 2000ms catches real "ah, and also…" follow-ups.
   */
  coalesceMs: number;
  /**
   * While a session is busy its coalescing buffer HOLDS messages until the
   * turn ends — `session.idle` flushes them as one prompt — with this safety
   * timer as the only fallback. That is what turns "several messages sent
   * while the agent works" into ONE prompt instead of one inbox row each.
   */
  coalesceBusyMs: number;
  /** Extra: log every event type, for developing the renderer. */
  debugEvents: boolean;
}

const DEFAULTS: Omit<Config, "token"> = {
  mode: "dry",
  allowedUsers: [],
  mirror: "all",
  archiveAfterDays: 0,
  coalesceMs: 2000,
  coalesceBusyMs: 30_000,
  debugEvents: false,
  render: {
    editIntervalMs: 1400,
    showDiffs: true,
    diffMaxLines: 40,
    showReasoning: true,
    reasoningChars: 1400,
  },
};

function readDotEnv(path: string): Record<string, string> {
  if (!existsSync(path)) return {};
  const out: Record<string, string> = {};
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!match) continue;
    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    out[match[1]] = value;
  }
  return out;
}

function readJson(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {};
  try {
    const parsed = JSON.parse(stripComments(readFileSync(path, "utf8"))) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/**
 * Remove `//` and `/* *\/` comments while staying inside quoted strings, so a
 * `//` in a URL survives. Keeps config files readable without a JSONC
 * dependency.
 */
function stripComments(text: string): string {
  let out = "";
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (inString) {
      out += char;
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === "\"") inString = false;
      continue;
    }
    if (char === "\"") {
      inString = true;
      out += char;
      continue;
    }
    if (char === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      out += "\n";
      continue;
    }
    if (char === "/" && text[i + 1] === "*") {
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++;
      i++;
      continue;
    }
    out += char;
  }
  return out;
}

function asMode(value: unknown): Mode | undefined {
  return value === "off" || value === "dry" || value === "live" ? value : undefined;
}

/** Accepts "true"/"1"/true from either an env string or a config.json boolean. */
function asBool(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    if (value === "1" || value === "true") return true;
    if (value === "0" || value === "false") return false;
  }
  return undefined;
}

/** Same idea for a fixed set of string choices, e.g. mirror: all | watched. */
function asChoice<T extends string>(value: unknown, allowed: readonly T[]): T | undefined {
  return typeof value === "string" && (allowed as readonly string[]).includes(value) ? (value as T) : undefined;
}

function asNumberList(value: unknown): number[] {
  if (Array.isArray(value)) return value.map(Number).filter(Number.isFinite);
  if (typeof value === "string") return value.split(/[,\s]+/).map(Number).filter(Number.isFinite);
  return [];
}

export function loadConfig(): Config {
  const env = {
    ...readDotEnv(join(homedir(), ".opencode", "tg", ".env")),
    ...readJson(join(ROOT, "config.json")),
    ...Object.fromEntries(Object.entries(process.env).filter(([, v]) => v !== undefined) as [string, string][]),
  };

  const render: RenderOptions = {
    ...DEFAULTS.render,
    ...(typeof env.render === "object" && env.render !== null ? (env.render as Partial<RenderOptions>) : {}),
  };
  for (const key of ["editIntervalMs", "diffMaxLines", "reasoningChars"] as const) {
    const value = env[`TG_${key.toUpperCase()}`];
    if (value !== undefined && Number.isFinite(Number(value))) render[key] = Number(value);
  }
  if (env.TG_SHOW_DIFFS !== undefined) render.showDiffs = env.TG_SHOW_DIFFS !== "0" && env.TG_SHOW_DIFFS !== "false";
  if (env.TG_SHOW_REASONING !== undefined) {
    render.showReasoning = env.TG_SHOW_REASONING !== "0" && env.TG_SHOW_REASONING !== "false";
  }

  const mode = asMode(env.TG_MODE) ?? asMode(env.mode) ?? DEFAULTS.mode;
  const token = String(env.TELEGRAM_BOT_TOKEN ?? "").trim();
  const allowedUsers = asNumberList(env.ALLOWED_USERS ?? env.TG_ALLOWED_USERS);
  const archiveRaw = env.TG_ARCHIVE_AFTER_DAYS ?? env.archiveAfterDays;
  const archiveAfterDays =
    archiveRaw !== undefined && Number.isFinite(Number(archiveRaw)) && Number(archiveRaw) >= 0
      ? Number(archiveRaw)
      : DEFAULTS.archiveAfterDays;
  const coalesceRaw = env.TG_COALESCE_MS ?? env.coalesceMs;
  const coalesceMs =
    coalesceRaw !== undefined && Number.isFinite(Number(coalesceRaw))
      ? Math.min(Math.max(Number(coalesceRaw), 200), 10_000)
      : DEFAULTS.coalesceMs;
  const coalesceBusyRaw = env.TG_COALESCE_BUSY_MS ?? env.coalesceBusyMs;
  const coalesceBusyMs =
    coalesceBusyRaw !== undefined && Number.isFinite(Number(coalesceBusyRaw))
      ? Math.min(Math.max(Number(coalesceBusyRaw), 5000), 300_000)
      : DEFAULTS.coalesceBusyMs;

  return {
    mode,
    token,
    allowedUsers,
    render,
    mirror: asChoice(env.TG_MIRROR, ["watched", "all"] as const) ?? asChoice(env.mirror, ["watched", "all"] as const) ?? DEFAULTS.mirror,
    archiveAfterDays,
    coalesceMs,
    coalesceBusyMs,
    debugEvents: asBool(env.TG_DEBUG_EVENTS) ?? asBool(env.debugEvents) ?? DEFAULTS.debugEvents,
  };
}
