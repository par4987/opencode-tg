/**
 * Session metadata read from disk.
 *
 * The plugin learns about sessions from `ctx.event`, which only carries titles
 * in `session.created` / `session.renamed`. Sessions that were already running
 * when the server (re)started never emit those — so the chat lists them as
 * "(sin t\u00edtulo)" even though OpenCode has a title on disk. This is the
 * fallback: every session has `<id>.json` next to its transcript.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

interface SessionJson {
  title?: string;
  directory?: string;
}

/** Where OpenCode keeps per-session metadata, accounting for XDG. */
function sessionsDir(): string {
  const xdg = process.env.XDG_DATA_HOME;
  const base = xdg && xdg.length > 0 ? xdg : join(homedir(), ".local", "share");
  return join(base, "opencode", "sessions");
}

/**
 * Read `<id>.json` for a session. Returns `undefined` when the file is absent
 * or unreadable — never throws, since a metadata miss must not break the
 * bridge.
 */
export function readSessionMeta(id: string): SessionJson | undefined {
  if (!/^ses_[A-Za-z0-9]+$/.test(id)) return undefined;
  try {
    const raw = readFileSync(join(sessionsDir(), `${id}.json`), "utf-8");
    const parsed = JSON.parse(raw) as SessionJson;
    if (parsed && typeof parsed === "object") return parsed;
  } catch {
    /* the session has no metadata file yet, or it is mid-write */
  }
  return undefined;
}
