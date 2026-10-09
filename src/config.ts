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
import type { SttConfig } from "./stt.js";
import type { Topology, BotAssign } from "./bots.js";

const HERE = dirname(fileURLToPath(import.meta.url));
/** Plugin root: this file lives in `src/`, config.json sits one level up. */
const ROOT = join(HERE, "..");

export type Mode = "off" | "dry" | "live";

/** A extra bot token declared as TELEGRAM_BOT_TOKEN_<NAME> in the .env. */
export interface ExtraBot {
  name: string;
  token: string;
  /** Where this bot writes; defaults to the first allowed user. */
  chatId?: number;
}

export interface BotsConfig {
  /** How sessions map to bots — see src/bots.ts for what each shape means. */
  topology: Topology;
  /** per-project: explicit project-directory → bot-name pins. */
  assign: BotAssign[];
}

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
   * /rebuild recreates threads only for sessions a human actually used
   * within this many hours. The server's `updated` field is also bumped by
   * its own housekeeping — every session gets touched on startup — so
   * sorting by it after a restart resurrected sessions nobody had opened
   * for days. `idle` is the last real interaction, which is what the forum
   * should show. 0 = no window: recreate the 12 most recent by idle,
   * however stale.
   */
  rebuildIdleHours: number;
  /**
   * Coalescing window: text messages that arrive within this many
   * milliseconds of each other merge into one prompt. Human Telegram
   * cadence runs at 1-2s between follow-ups, so 800ms only caught
   * copy-paste bursts — 2000ms catches real "ah, and also…" follow-ups.
   */
  coalesceMs: number;  /**
   * Burst window while a session is busy: rapid follow-ups merge into one
   * prompt, but the batch reaches the server's inbox in seconds — a longer
   * hold made the messages invisible to /queue and stole the steer control.
   */
  coalesceBusyMs: number;
  /** Extra: log every event type, for developing the renderer. */
  debugEvents: boolean;
  /**
   * Dead-prompt watchdog: after a prompt is delivered, the turn must start
   * within this window. When it does not, the bridge reads the server log
   * for the real cause (provider credits, rate limit, down…) and says so in
   * the thread — instead of leaving the conversation silently dead (the
   * "no news, open the desktop" experience, measured 2026-10-09). 0 = off.
   */
  deadPromptMs: number;
  /** Local voice-note transcription (whisper.cpp) — paths/language. */
  stt: SttConfig;
  /** Subagent (task) sessions in the chat: mirrored read-only topics, or off. */
  subagents: "mirror" | "off";
  /** Multi-bot: which bot mirrors which session (src/bots.ts). */
  bots: BotsConfig;
  /** Tokens beyond TELEGRAM_BOT_TOKEN, one per extra bot. Never in the repo. */
  extraBots: ExtraBot[];
}

const DEFAULTS: Omit<Config, "token"> = {
  mode: "dry",
  allowedUsers: [],
  mirror: "all",
  archiveAfterDays: 0,
  rebuildIdleHours: 24,
  coalesceMs: 2000,
  coalesceBusyMs: 8_000,
  debugEvents: false,
  deadPromptMs: 90_000,
  stt: {},
  subagents: "mirror",
  bots: { topology: "single", assign: [] },
  extraBots: [],
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
  const rebuildRaw = env.TG_REBUILD_IDLE_HOURS ?? env.rebuildIdleHours;
  const rebuildIdleHours =
    rebuildRaw !== undefined && Number.isFinite(Number(rebuildRaw)) && Number(rebuildRaw) >= 0
      ? Number(rebuildRaw)
      : DEFAULTS.rebuildIdleHours;
  const coalesceRaw = env.TG_COALESCE_MS ?? env.coalesceMs;
  const coalesceMs =
    coalesceRaw !== undefined && Number.isFinite(Number(coalesceRaw))
      ? Math.min(Math.max(Number(coalesceRaw), 200), 10_000)
      : DEFAULTS.coalesceMs;
  const coalesceBusyRaw = env.TG_COALESCE_BUSY_MS ?? env.coalesceBusyMs;
  const coalesceBusyMs =
    coalesceBusyRaw !== undefined && Number.isFinite(Number(coalesceBusyRaw))
      ? Math.min(Math.max(Number(coalesceBusyRaw), 2000), 30_000)
      : DEFAULTS.coalesceBusyMs;
  // Dead-prompt watchdog: a delivered prompt must start its turn inside this
  // window; past it, the bridge surfaces the server-log cause. 0 disables.
  const deadRaw = env.TG_DEAD_PROMPT_MS ?? env.deadPromptMs;
  const deadPromptMs =
    deadRaw !== undefined && Number.isFinite(Number(deadRaw))
      ? Number(deadRaw) === 0
        ? 0
        : Math.min(Math.max(Number(deadRaw), 20_000), 15 * 60_000)
      : DEFAULTS.deadPromptMs;
  // Voice transcription: an "stt" object in config.json, or TG_STT_* overrides.
  // The cloud key rides the .env as STT_API_KEY — never inside the repo.
  const stt = typeof env.stt === "object" && env.stt !== null ? { ...(env.stt as SttConfig) } : {};
  if (env.TG_STT_PROVIDER === "local" || env.TG_STT_PROVIDER === "openai-compatible") stt.provider = env.TG_STT_PROVIDER;
  if (env.TG_STT_WHISPER !== undefined) stt.whisper = String(env.TG_STT_WHISPER);
  if (env.TG_STT_MODEL !== undefined) stt.model = String(env.TG_STT_MODEL);
  if (env.TG_STT_FFMPEG !== undefined) stt.ffmpeg = String(env.TG_STT_FFMPEG);
  if (env.TG_STT_BASEURL !== undefined) stt.baseUrl = String(env.TG_STT_BASEURL);
  if (env.TG_STT_LANGUAGE !== undefined) stt.language = String(env.TG_STT_LANGUAGE);
  if (env.STT_API_KEY !== undefined) stt.apiKey = String(env.STT_API_KEY);

  // ── multi-bot: topology + explicit assignments (config.json), tokens in
  // the .env only. TELEGRAM_BOT_TOKEN_<NAME> declares an extra bot; its
  // chat is the first allowed user unless TG_BOT_CHAT_<NAME> says else.
  const botsObj = typeof env.bots === "object" && env.bots !== null ? (env.bots as Record<string, unknown>) : {};
  const topology =
    asChoice(env.TG_TOPOLOGY ?? botsObj.topology, ["single", "per-project", "per-session"] as const) ??
    DEFAULTS.bots.topology;
  const assign: BotAssign[] = [];
  for (const entry of Array.isArray(botsObj.assign) ? botsObj.assign : []) {
    if (!entry || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    if (typeof record.project === "string" && record.project && typeof record.bot === "string" && record.bot) {
      assign.push({ project: record.project, bot: record.bot });
    }
  }
  const extraBots: ExtraBot[] = [];
  const seenBots = new Set<string>();
  for (const [key, value] of Object.entries(env)) {
    const match = /^TELEGRAM_BOT_TOKEN_([A-Za-z0-9_-]+)$/.exec(key);
    const token = String(value ?? "").trim();
    if (!match || !token) continue;
    const name = match[1];
    if (name.toLowerCase() === "main") {
      // "main" is the primary token's reserved name.
      continue;
    }
    if (seenBots.has(name)) continue;
    seenBots.add(name);
    const chat = Number(env[`TG_BOT_CHAT_${name}`]);
    extraBots.push({ name, token, ...(Number.isFinite(chat) ? { chatId: chat } : {}) });
  }

  return {
    mode,
    token,
    allowedUsers,
    render,
    mirror: asChoice(env.TG_MIRROR, ["watched", "all"] as const) ?? asChoice(env.mirror, ["watched", "all"] as const) ?? DEFAULTS.mirror,
    archiveAfterDays,
    rebuildIdleHours,
    coalesceMs,
    coalesceBusyMs,
    debugEvents: asBool(env.TG_DEBUG_EVENTS) ?? asBool(env.debugEvents) ?? DEFAULTS.debugEvents,
    deadPromptMs,
    stt,
    subagents: asChoice(env.TG_SUBAGENTS, ["mirror", "off"] as const) ?? asChoice(env.subagents, ["mirror", "off"] as const) ?? DEFAULTS.subagents,
    bots: { topology, assign },
    extraBots,
  };
}
