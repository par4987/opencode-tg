/**
 * Lost sessions — sessions the user tried to reach but the server doesn't
 * hold in memory anymore (after a restart, or once the PC closed them).
 *
 * Every `SessionNotFound` error is recorded here so `/lost` can show "which
 * sessions did I lose?" and offer one-tap reopen (create a new session in
 * the same project). Mirrors `tasks.json`: JSON array, best-effort writes,
 * corrupt → empty.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface LostSession {
  sessionID: string;
  title?: string;
  directory?: string;
  /** Epoch ms when it was last detected as unloaded. */
  at: number;
}

export function lostSessionsFile(): string {
  return join(homedir(), ".opencode", "tg", "data", "lost-sessions.json");
}

export function readLostSessions(file: string = lostSessionsFile(), limit = 50): LostSession[] {
  try {
    if (!existsSync(file)) return [];
    const parsed = JSON.parse(readFileSync(file, "utf8")) as unknown;
    const arr = Array.isArray(parsed) ? (parsed as LostSession[]) : [];
    return arr.slice(-limit);
  } catch {
    return [];
  }
}

export function addLostSession(
  sessionID: string,
  title?: string,
  directory?: string,
  file: string = lostSessionsFile(),
): void {
  const entry: LostSession = { sessionID, title, directory, at: Date.now() };
  const prev = readLostSessions(file, 199);
  const idx = prev.findIndex((s) => s.sessionID === sessionID);
  if (idx >= 0) prev[idx] = entry;
  else prev.push(entry);
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(prev, null, 2), "utf8");
  } catch {
    /* best effort: /lost works without persistence */
  }
}

export function removeLostSession(sessionID: string, file: string = lostSessionsFile()): boolean {
  const all = readLostSessions(file);
  const before = all.length;
  const kept = all.filter((s) => s.sessionID !== sessionID);
  if (kept.length === before) return false;
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(kept, null, 2), "utf8");
  } catch {
    /* best effort */
  }
  return true;
}

export function clearLostSessions(file: string = lostSessionsFile()): void {
  try {
    if (existsSync(file)) writeFileSync(file, "", "utf8");
  } catch {
    /* nothing to clear */
  }
}
