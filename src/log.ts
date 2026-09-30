/**
 * Plugin logger.
 *
 * The plugin runs inside the OpenCode server, so `console` output only reaches
 * the server log. Everything is mirrored to a file we own, which is what we
 * actually read while developing (and what `/dry` mode prints instead of
 * sending).
 */
import { appendFileSync, mkdirSync, renameSync, statSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const LOG_DIR = join(homedir(), ".opencode", "tg", "logs");
const LOG_FILE = join(LOG_DIR, "plugin.log");
const LOG_OLD = join(LOG_DIR, "plugin.log.1");
/** Rotating is cheaper than unbounded growth: 4 MB is plenty for a session. */
const MAX_BYTES = 4 * 1024 * 1024;

let ready = false;
let calls = 0;

function rotate(): void {
  try {
    if (statSync(LOG_FILE).size < MAX_BYTES) return;
    try {
      unlinkSync(LOG_OLD);
    } catch {
      /* no previous rotation */
    }
    renameSync(LOG_FILE, LOG_OLD);
  } catch {
    /* rotation is best effort */
  }
}

export function log(level: "INFO" | "WARN" | "ERROR", message: string, detail?: unknown): void {
  const stamp = new Date().toISOString().replace("T", " ").slice(0, 23);
  // The pid is how we tell one plugin instance from another when several
  // processes (service, TUI, CLI) all load the same plugin.
  let line = `${stamp} ${level.padEnd(5)} [tg] #${process.pid} ${message}`;
  if (detail !== undefined) {
    const text = typeof detail === "string" ? detail : safe(detail);
    line += ` ${text}`;
  }
  try {
    if (!ready) {
      mkdirSync(LOG_DIR, { recursive: true });
      ready = true;
    }
    if (calls++ % 50 === 0) rotate();
    appendFileSync(LOG_FILE, line + "\n");
  } catch {
    /* logging must never break the plugin */
  }
  if (level === "ERROR") console.error(line);
  else if (level === "WARN") console.warn(line);
  else console.log(line);
}

/** JSON that survives circular structures and huge blobs. */
export function safe(value: unknown, limit = 400): string {
  try {
    // `JSON.stringify(new Error("x"))` is `"{}"` — the standard properties are
    // non-enumerable, so an error logged this way says nothing at all. Give it
    // a real shape first; this is the difference between a blind fix and one.
    if (value instanceof Error) {
      const record: Record<string, unknown> = {
        name: value.name,
        message: value.message,
        stack: value.stack,
      };
      for (const [key, item] of Object.entries(value)) record[key] = item;
      value = record;
    }
    const text = JSON.stringify(value, (_key, item) => {
      if (typeof item === "string" && item.length > 400) return item.slice(0, 400) + "…";
      return item;
    });
    if (text === undefined) return String(value);
    return text.length > limit ? text.slice(0, limit) + "…" : text;
  } catch {
    return String(value);
  }
}

export function logPath(): string {
  return LOG_FILE;
}
