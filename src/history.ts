/**
 * Session history — turn a session's `.jsonl` transcript into readable entries.
 *
 * OpenCode appends one JSON object per line for every message it persists: prompts,
 * assistant turns and tool calls. That file is the authoritative record of a
 * conversation — the event stream only carries what happens while we are
 * listening, so `/history` is how you see what a session said before you opened
 * Telegram.
 *
 * Transcripts grow without bound, so only the tail is ever read.
 */
import { closeSync, openSync, readSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface HistoryEntry {
  role: "user" | "assistant" | "tool";
  text: string;
  /** Tool name for `tool` entries, so the icon can name the tool. */
  tool?: string;
  timestamp?: number;
}

interface RawEvent {
  kind?: string;
  data?: {
    content?: Array<{ kind?: string; data?: unknown; text?: unknown }>;
    meta?: { timestamp?: number };
    name?: string;
    tool_name?: string;
  };
}

const TAIL_WINDOWS = [256 * 1024, 1024 * 1024, 4 * 1024 * 1024];

/** Where OpenCode keeps transcripts, accounting for XDG. */
export function sessionsDir(): string {
  const xdg = process.env.XDG_DATA_HOME;
  const base = xdg && xdg.length > 0 ? xdg : join(homedir(), ".local", "share");
  return join(base, "opencode", "sessions");
}

/** Transcript path for a session id. */
export function jsonlPath(sessionId: string): string {
  return join(sessionsDir(), `${sessionId}.jsonl`);
}

/**
 * The API export as a history source. The 2.0.19+ servers keep newer
 * sessions in memory only — their transcript never lands in the legacy
 * `.jsonl` dir (measured: the server's own drain can fail upstream, and
 * even healthy sessions do not show up there). While the session is
 * loaded, though, `/experimental/session/{id}/export` hands the full
 * conversation over — this maps that shape into history entries.
 *
 * Export shape (verified live): `messages` is an event log — `type:
 * "user"` carries `metadata.displayText`, `type: "assistant"` carries
 * `content` blocks (`text` is the visible answer, `reasoning` is skipped),
 * and the rest (idle, model-switched, agent-switched, compaction, system,
 * synthetic) is lifecycle noise the history view does not need.
 */
export function entriesFromExport(exported: unknown, maxEntries = 20): HistoryEntry[] {
  const messages = (exported as { messages?: unknown } | undefined)?.messages;
  if (!Array.isArray(messages)) return [];
  const entries: HistoryEntry[] = [];
  for (const raw of messages) {
    const m = raw as {
      type?: string;
      metadata?: { displayText?: unknown };
      content?: Array<{ type?: string; text?: unknown }>;
      time?: { created?: number };
    };
    if (m.type === "user") {
      const text = typeof m.metadata?.displayText === "string" ? m.metadata.displayText.trim() : "";
      if (text) entries.push({ role: "user", text, timestamp: m.time?.created });
    } else if (m.type === "assistant") {
      const text = (Array.isArray(m.content) ? m.content : [])
        .filter((block) => block?.type === "text" && typeof block.text === "string")
        .map((block) => block.text as string)
        .join("")
        .trim();
      if (text) entries.push({ role: "assistant", text, timestamp: m.time?.created });
    }
  }
  return entries.slice(-maxEntries);
}

/**
 * Parse the most recent `maxEntries` entries from a transcript.
 *
 * The window grows until something is found: a long session whose last
 * megabytes are all one tool output would otherwise yield an empty history
 * even though the conversation is right there.
 */
export function readHistory(path: string, maxEntries = 20): HistoryEntry[] {
  for (const window of TAIL_WINDOWS) {
    const entries = parseTail(path, window, maxEntries);
    if (entries.length > 0) return entries;
  }
  return [];
}

/** Byte size of a transcript (0 when it does not exist). */
export function jsonlSize(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

function parseTail(path: string, window: number, maxEntries: number): HistoryEntry[] {
  const text = readTail(path, window);
  if (!text) return [];
  const entries: HistoryEntry[] = [];
  for (const line of text.split("\n")) {
    const entry = parseEventLine(line);
    if (entry) entries.push(entry);
  }
  return entries.slice(-maxEntries);
}

/** Parse one `.jsonl` line, or `undefined` for blanks and unparsable text. */
export function parseEventLine(line: string): HistoryEntry | undefined {
  const trimmed = line.trim();
  if (!trimmed) return undefined;
  let ev: RawEvent;
  try {
    ev = JSON.parse(trimmed) as RawEvent;
  } catch {
    return undefined;
  }
  return toEntry(ev);
}

function toEntry(ev: RawEvent): HistoryEntry | undefined {
  const role = roleOf(ev.kind);
  if (!role) return undefined;
  const text = extractText(ev.data?.content);
  const tool = ev.data?.tool_name || ev.data?.name;
  // A tool call with no visible text still counts: it is a line of work.
  if (!text && !tool) return undefined;
  return {
    role,
    text: text || (tool ? `(${tool})` : ""),
    tool,
    timestamp: ev.data?.meta?.timestamp,
  };
}

function roleOf(kind?: string): HistoryEntry["role"] | undefined {
  switch (kind) {
    case "Prompt":
    case "UserMessage":
      return "user";
    case "AssistantMessage":
    case "Response":
      return "assistant";
    case "ToolUse":
    case "ToolUseResults":
      return "tool";
    default:
      return undefined;
  }
}

/**
 * OpenCode stores text in `{kind: "text", data: "…"}` blocks; the older
 * `{kind: "text", text: "…"}` shape still appears in some tool results, so
 * both are read.
 */
function extractText(content?: Array<{ kind?: string; data?: unknown; text?: unknown }>): string {
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (block.kind === "text") {
      // `data` is the current shape; `text` is the older one. Some tool
      // results carry neither, and a text block with no payload is not an
      // error — it just contributes nothing.
      if (typeof block.data === "string") parts.push(block.data);
      else if (block.data && typeof (block.data as { text?: unknown }).text === "string") {
        parts.push((block.data as { text: string }).text);
      } else if (typeof block.text === "string") {
        parts.push(block.text);
      }
    } else if (typeof block.text === "string") {
      parts.push(block.text);
    }
  }
  return parts.join("").trim();
}

/** Read up to `maxBytes` from the end of a file as UTF-8. */
function readTail(path: string, maxBytes: number): string {
  let size: number;
  try {
    size = statSync(path).size;
  } catch {
    return "";
  }
  if (size === 0) return "";
  const start = Math.max(0, size - maxBytes);
  const length = size - start;
  const fd = openSync(path, "r");
  try {
    const buf = Buffer.alloc(length);
    readSync(fd, buf, 0, length, start);
    let text = buf.toString("utf-8");
    // Starting mid-file means the first line is cut in half; drop it.
    if (start > 0) {
      const nl = text.indexOf("\n");
      if (nl !== -1) text = text.slice(nl + 1);
    }
    return text;
  } finally {
    closeSync(fd);
  }
}
