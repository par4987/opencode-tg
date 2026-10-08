/**
 * Session → forum-topic mapping, persisted.
 *
 * One Telegram thread per OpenCode session is the answer to "I cannot tell
 * which session a message belongs to": instead of a label, each session gets
 * its own conversation. The mapping must survive a service restart, otherwise
 * every restart would orphan threads and create new ones for the same
 * sessions.
 *
 * The store is a tiny JSON file next to the log. Writes are best-effort and
 * debounced by the caller's own lifecycle: correctness does not depend on
 * flushing every intermediate state, only the latest one.
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { log, safe } from "./log.js";

const STORE_DIR = join(homedir(), ".opencode", "tg");
const STORE_FILE = join(STORE_DIR, "topics.json");

interface StoredTopics {
  /** chatId -> sessionId -> thread id */
  chats?: Record<string, Record<string, number>>;
  /** chatId -> sessionIds whose threads are closed ("archived"). */
  archived?: Record<string, string[]>;
}

export class TopicStore {
  private readonly chats = new Map<string, Map<string, number>>();
  /** session -> thread id, resolved for this process's chat */
  private readonly cache = new Map<string, number>();
  private readonly archivedSet = new Set<string>();
  private loaded = false;

  constructor(
    private readonly chatId: number,
    /** Overrides the default file — tests must never touch real state. */
    private readonly file: string = STORE_FILE,
  ) {}

  private load(): void {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const raw = readFileSync(this.file, "utf-8");
      const parsed = JSON.parse(raw) as StoredTopics;
      const chat = parsed.chats?.[String(this.chatId)];
      if (chat) for (const [sessionId, threadId] of Object.entries(chat)) this.cache.set(sessionId, threadId);
      for (const sessionId of parsed.archived?.[String(this.chatId)] ?? []) this.archivedSet.add(sessionId);
    } catch {
      /* first run, or a corrupt file — start empty */
    }
  }

  private persist(): void {
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      const chat: Record<string, number> = {};
      for (const [sessionId, threadId] of this.cache) chat[sessionId] = threadId;
      const payload: StoredTopics = {
        chats: { [String(this.chatId)]: chat },
        archived: { [String(this.chatId)]: [...this.archivedSet] },
      };
      writeFileSync(this.file, JSON.stringify(payload, null, 2), "utf-8");
    } catch (error) {
      log("WARN", "topics: no se pudo persistir", safe(error));
    }
  }

  /** Known thread id for a session, if one was created before. */
  get(sessionId: string): number | undefined {
    this.load();
    return this.cache.get(sessionId);
  }

  /** Which session owns this thread — the inverse lookup for inbound replies. */
  sessionOf(threadId: number): string | undefined {
    this.load();
    for (const [sessionId, id] of this.cache) if (id === threadId) return sessionId;
    return undefined;
  }

  /** Remember the mapping so a restart reuses the same thread. */
  set(sessionId: string, threadId: number): void {
    this.load();
    // Case-insensitive dedup: a hand-typed id with wrong case would
    // otherwise create a second mapping for the same session (measured:
    // ses_f02b83363ffeyru6a16yrhohco vs ...ffeYRU6A16YRHOhcO in the wild).
    for (const existing of this.cache.keys()) {
      if (existing.toLowerCase() === sessionId.toLowerCase() && existing !== sessionId) {
        this.cache.delete(existing);
        break;
      }
    }
    this.cache.set(sessionId, threadId);
    this.persist();
  }

  /** The session's thread is closed — the mirror must stay silent for it. */
  isArchived(sessionId: string): boolean {
    this.load();
    return this.archivedSet.has(sessionId);
  }

  setArchived(sessionId: string, value: boolean): void {
    this.load();
    if (value) this.archivedSet.add(sessionId);
    else this.archivedSet.delete(sessionId);
    this.persist();
  }

  /** Forget a session entirely — its thread was deleted by hand. */
  remove(sessionId: string): void {
    this.load();
    this.cache.delete(sessionId);
    this.archivedSet.delete(sessionId);
    this.persist();
  }

  /** Every mapping, for the wipe in /rebuild. */
  entries(): Array<[string, number]> {
    this.load();
    return [...this.cache.entries()];
  }

  /** Forget every mapping — used when topics are unavailable. */
  clear(): void {
    this.cache.clear();
    this.archivedSet.clear();
    this.persist();
  }
}

/**
 * Resolves a session to its thread. The renderer is synchronous, so the lookup
 * is synchronous and the (async) topic creation is scheduled: events arriving
 * before the topic exists land in the chat root, and the *next* event finds
 * the thread. That is one straggler message, not a broken transcript.
 */
export class TopicResolver {
  private readonly pending = new Set<string>();

  constructor(
    private readonly store: TopicStore,
    private readonly chatId: number,
    private readonly telegram: { createForumTopic: (chatId: number, name: string) => Promise<number | undefined> },
    /**
     * The name a new topic gets. May be async: the live title from the
     * server beats every cached copy — a topic (re)born must carry the
     * name the desktop shows, not the stale `<id>.json` (measured: a
     * thread recreated after a native delete wore its September name
     * while the session had long been "Bot Telegram").
     */
    private readonly titleOf: (sessionId: string) => string | Promise<string>,
    private readonly onUnavailable?: () => void,
  ) {}

  /**
   * Thread id for the session if known, or `undefined` to send to the chat
   * root. Schedules a topic creation when there is none yet.
   */
  get(sessionId: string): number | undefined {
    const known = this.store.get(sessionId);
    if (known !== undefined) return known;
    if (this.pending.has(sessionId)) return undefined;
    this.pending.add(sessionId);
    void this.create(sessionId);
    return undefined;
  }

  private async create(sessionId: string): Promise<void> {
    const title = ((await this.titleOf(sessionId)) ?? "").trim() || sessionId.slice(0, 24);
    try {
      const threadId = await this.telegram.createForumTopic(this.chatId, title);
      if (threadId !== undefined) this.store.set(sessionId, threadId);
      else if (this.onUnavailable) this.onUnavailable();
    } catch (error) {
      // The transport is responsible for classifying the "not a forum" error
      // and returning undefined; a throw here is an unexpected failure. Report
      // it and do not retry, so one bad call cannot loop forever.
      if (this.onUnavailable) this.onUnavailable();
      void error;
    } finally {
      this.pending.delete(sessionId);
    }
  }
}

/**
 * A session as `/rebuild` reads it — the fields the forum cares about. Kept
 * here so the selector can be tested without importing the plugin entry.
 */
export interface RebuildSession {
  id: string;
  title?: string;
  time?: { idle?: number };
}

/**
 * Which sessions `/rebuild` gets a fresh thread: those a human actually used
 * within `idleHours`, oldest first so the most recent is created last and
 * lands at the top of the topic list.
 *
 * Selecting by `updated` was the original bug: the server bumps it for every
 * session during its own startup housekeeping, so right after a service
 * restart the "most recent" list was whatever the *service* touched, not
 * whatever the *user* touched — measured as eight sessions sharing one
 * `updated` minute with idle times of 10h and 2d, resurrected as if live.
 * `idle` is the last real interaction, which is what the forum should show.
 *
 * `idleHours: 0` drops the window and takes the 12 most recent by idle,
 * however stale. Sessions without an `idle` timestamp never qualify: they
 * are not running, and the resolver will give them a thread on first event.
 */
export function rebuildCandidates(sessions: RebuildSession[], now: number, idleHours: number): RebuildSession[] {
  const cutoff = idleHours > 0 ? now - idleHours * 3_600_000 : 0;
  return sessions
    .filter((s) => s.id && (s.time?.idle ?? 0) > cutoff)
    .sort((a, b) => (a.time?.idle ?? 0) - (b.time?.idle ?? 0))
    .slice(-12);
}

/** What sweepTopics needs from the transport — a stub is all tests require. */
export interface SweepTransport {
  deleteForumTopic(chatId: number, threadId: number): Promise<boolean>;
}

/**
 * The /rebuild wipe, one confirmed delete at a time.
 *
 * A mapping is forgotten ONLY when Telegram confirms the topic is gone (or
 * already was — the transport answers `true` for both). The old sweep fired
 * every delete and cleared the whole store up front, so any delete that
 * failed — a rate limit, a restart mid-burst, a transport aborted by a
 * hand-over (all three happened in one day, 2026-10-08) — left a live topic
 * with no mapping. The Bot API has no "list topics", so an orphaned thread
 * can never be named, retried or deleted by the bridge again: it just sits
 * in the forum. Keeping failed mappings makes the next /rebuild retry them,
 * and the recreation step skips sessions that still own a live topic.
 */
export async function sweepTopics(
  store: { entries(): Array<[string, number]>; remove(sessionId: string): void },
  telegram: SweepTransport,
  chatId: number,
  onFailed?: (threadId: number) => void,
): Promise<{ deleted: number; failed: number }> {
  let deleted = 0;
  let failed = 0;
  for (const [sessionId, tid] of store.entries()) {
    const gone = await telegram.deleteForumTopic(chatId, tid).catch(() => false);
    if (gone) {
      store.remove(sessionId);
      deleted += 1;
    } else {
      failed += 1;
      onFailed?.(tid);
    }
  }
  return { deleted, failed };
}
