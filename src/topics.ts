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
    private readonly titleOf: (sessionId: string) => string,
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
    const title = this.titleOf(sessionId).trim() || sessionId.slice(0, 24);
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
