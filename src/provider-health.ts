/**
 * Provider-failure diagnostics: what the phone should say when the model
 * never answers.
 *
 * The measured silence (2026-10-09): when a provider fails BEFORE the turn
 * starts — credits used up ("Your monthly allowance is used up", apmix),
 * rate limit, an unavailable model — the server fails the inbox drain and
 * logs `level=ERROR … Failed to drain Session … sessionID=…` to its global
 * log, and emits NO session event at all. The bridge, which lives on
 * events, never hears about it: the thread shows the prompt receipt and
 * then nothing, and the only way to learn why is opening the desktop.
 *
 * This module reads the server's log directly (the plugin runs in the same
 * process, same machine) and classifies the failure, so the bridge can say
 * WHAT happened in plain words:
 *
 *   ❌ Tu mensaje no salió: créditos/cupo agotados del proveedor
 *      <code>AI.Error: Your monthly allowance is used up…</code>
 *      💡 Tocá recargar o cambiar de proveedor: /models
 *
 * Everything here is pure and side-effect-free (except the log tail read)
 * so the classification and the parsing are testable against recorded log
 * lines, including the real ones from the incident.
 */
import { openSync, readSync, closeSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** The server's global log — where drain failures actually surface. */
export function serverLogPath(): string {
  return process.env.TG_SERVER_LOG ?? join(homedir(), ".local", "share", "opencode", "log", "opencode.log");
}

/**
 * The last ~1MB of the server log. The file grows to tens of MB; the
 * watchdog ticks every 30s, so reading the whole thing is not an option —
 * and fresh failures are always at the tail. The measured chatter on a busy
 * box (a long streaming turn logs an event per token) blows past 64KB in
 * well under two minutes, which is the watchdog's own horizon; 1MB covers
 * it with room to spare. Stale errors cannot leak in: `since` filters
 * everything older than the prompt being checked.
 */
export function serverLogTail(maxBytes = 1_048_576): string {
  try {
    const path = serverLogPath();
    const fd = openSync(path, "r");
    try {
      const size = statSync(path).size;
      const start = Math.max(0, size - maxBytes);
      const buffer = Buffer.alloc(size - start);
      readSync(fd, buffer, 0, buffer.length, start);
      return buffer.toString("utf8");
    } finally {
      closeSync(fd);
    }
  } catch {
    return ""; /* no log, no verdict — the caller falls back to a generic card */
  }
}

export interface SessionErrorHit {
  /** When the server logged it (epoch ms). */
  at: number;
  /** The human-readable cause, first line, quotes unescaped. */
  message: string;
}

/**
 * The freshest ERROR entry that mentions the session and is newer than
 * `since` (epoch ms). Entries are chunked on their `timestamp=` prefix; a
 * logged shell command may also contain that word, so each chunk must start
 * with a plausible ISO date before it is considered an entry.
 *
 * The cause is extracted from `cause="…"`, cut at the first escaped newline
 * (the stack trace is noise for a phone), with `\"` unescaped. Field order
 * verified against the live server: `sessionID=` sits at the end of the
 * entry's first physical line.
 */
export function lastSessionError(tail: string, sessionID: string, since: number): SessionErrorHit | undefined {
  let best: SessionErrorHit | undefined;
  const chunks = tail.split("timestamp=");
  for (let i = 1; i < chunks.length; i++) {
    const chunk = chunks[i];
    // Only real entries: ISO date right at the chunk start.
    if (!/^\d{4}-\d{2}-\d{2}T/.test(chunk)) continue;
    if (!chunk.includes(sessionID)) continue;
    if (!/level=ERROR/.test(chunk)) continue;
    const at = Date.parse(chunk.slice(0, 24));
    if (!Number.isFinite(at) || at < since) continue;
    const cause = /cause="((?:[^"\\]|\\.)*)/.exec(chunk)?.[1] ?? "";
    const firstLine = cause.split("\\n")[0].replace(/\\"/g, '"').trim();
    const message = firstLine || (/message="([^"]*)"/.exec(chunk)?.[1] ?? "");
    if (!message) continue;
    if (!best || at > best.at) best = { at, message };
  }
  return best;
}

/**
 * What KIND of failure this is, so the card can say the useful thing instead
 * of dumping a provider stack. Ordered: the specific classes first, the
 * broad "network" family last (an "unavailable" inside ModelUnavailableError
 * must not classify as a network problem).
 *
 * Patterns verified against the real incidents of 2026-10-09
 * ("AI.Error.QuotaExceeded: Your monthly allowance is used up…",
 * "AI.Error: Rate limit exceeded. Please try again later.",
 * "SessionRunnerModel.ModelUnavailableError: Model unavailable: …").
 */
export type FailureClass = "credits" | "ratelimit" | "model" | "auth" | "network" | "other";

export function classifyFailure(text: string): FailureClass {
  const s = text.toLowerCase();
  if (/quotaexceeded|allowance|insufficient|credits?\b|\bbalance\b|\bquota\b|\b402\b/.test(s)) return "credits";
  if (/rate limit|ratelimit|\b429\b|too many requests/.test(s)) return "ratelimit";
  if (/model unavailable|modelunavailable|model not found|no such model/.test(s)) return "model";
  if (/\b40[13]\b|unauthorized|forbidden|api key|invalid[^.]{0,16}key|authentication/.test(s)) return "auth";
  if (/econn|fetch failed|network|enotfound|timeout|timed out|\b5\d\d\b|unavailable|overload|capacity/.test(s)) return "network";
  return "other";
}
