/**
 * Session recent prompts — what the user typed into the agent via Telegram.
 *
 * Every prompt that reaches `deliver()` is recorded here with the session it
 * went to and when, so `/recent` can show "what did I just ask?" and offer a
 * one-tap resend. The file mirrors `tasks.json`: JSON array, best-effort
 * writes, corrupt → empty.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface RecentPrompt {
  /** The session id the prompt was sent to. */
  sessionID: string;
  /** The prompt text (truncated for storage, full for resend). */
  text: string;
  /** Epoch ms when it was sent. */
  at: number;
}

/** Where the reference bot kept them, so both bots can share the file. */
export function recentFile(): string {
  return join(homedir(), ".opencode", "tg", "data", "recent.json");
}

export function readRecent(file: string = recentFile(), limit = 20): RecentPrompt[] {
  try {
    if (!existsSync(file)) return [];
    const parsed = JSON.parse(readFileSync(file, "utf8")) as unknown;
    const arr = Array.isArray(parsed) ? (parsed as RecentPrompt[]) : [];
    return arr.slice(-limit);
  } catch {
    return [];
  }
}

/** Append one recent prompt, keeping at most MAX recent entries. */
const MAX_RECENT = 200;

export function addRecent(sessionID: string, text: string, file: string = recentFile()): void {
  const entry: RecentPrompt = { sessionID, text: text.slice(0, 2000), at: Date.now() };
  const prev = readRecent(file, MAX_RECENT - 1);
  prev.push(entry);
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(prev, null, 2), "utf8");
  } catch {
    /* best effort: /recent works without persistence */
  }
}

export function clearRecent(file: string = recentFile()): void {
  try {
    if (existsSync(file)) writeFileSync(file, "", "utf8");
  } catch {
    /* nothing to clear */
  }
}
