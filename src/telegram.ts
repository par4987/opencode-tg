/**
 * Minimal Telegram Bot API client over `fetch` — no dependencies.
 *
 * Why not grammY: this plugin lives in a OneDrive-synced project folder, so a
 * node_modules tree would be synced/locked constantly. Everything we need is
 * small and worth owning: long polling, throttled edits, HTML escaping and the
 * two error codes that actually occur (429 flood, "message is not modified").
 */

import { readFileSync, writeFileSync } from "node:fs";

import { log } from "./log.js";

export interface TelegramConfig {
  token: string;
  /** Defaults to https://api.telegram.org */
  baseUrl?: string;
  /** Long-poll timeout in seconds. */
  pollTimeout?: number;
  /**
   * Where the last acknowledged update id is kept. Without this, a process
   * that dies mid-command restarts with offset 0 and Telegram re-delivers
   * everything pending — measured: a `/sh` that restarted the OpenCode
   * server never finished, the server came back, the update arrived again,
   * and the bridge looped a restart every ~10s until the plugin was
   * disabled. The file is the memory between restarts.
   */
  offsetPath?: string;
}

export interface TelegramErrorInfo {
  method: string;
  code?: number;
  description: string;
  retryAfter?: number;
}

export class TelegramError extends Error {
  readonly info: TelegramErrorInfo;
  constructor(info: TelegramErrorInfo) {
    super(`${info.method}: ${info.description}`);
    this.name = "TelegramError";
    this.info = info;
  }
  /** The message already exists unchanged — editing it was a no-op. */
  get isNotModified(): boolean {
    return /message is not modified/i.test(this.info.description);
  }
  get isFlood(): boolean {
    return this.info.code === 429 || /too many requests/i.test(this.info.description);
  }
  /** The target message/channel was deleted or is too old to edit. */
  get isStaleTarget(): boolean {
    return /message to edit not found|message can't be edited|message to delete not found|chat not found/i.test(
      this.info.description,
    );
  }
}

export interface SendMessageOptions {
  parseMode?: "HTML";
  disableNotification?: boolean;
  replyToMessageId?: number;
  /** Inline keyboard rows (callback_data limited to 64 bytes by Telegram). */
  replyMarkup?: Record<string, unknown>;
  /** Forum topic: when set the message goes into that thread instead of the chat root. */
  messageThreadId?: number;
}

interface ApiResult<T> {
  ok: boolean;
  result?: T;
  description?: string;
  error_code?: number;
  parameters?: { retry_after?: number };
}

export interface Update {
  update_id: number;
  message?: {
    message_id: number;
    chat: { id: number; type: string; title?: string; first_name?: string; username?: string };
    from?: { id: number; username?: string; first_name?: string };
    date: number;
    text?: string;
    /** Photos carry their caption here. */
    caption?: string;
    /** Forum thread the message was sent in; absent at the chat root. */
    message_thread_id?: number;
    document?: { file_id?: string; file_name?: string; mime_type?: string };
    /** Telegram sends several sizes; the last is the biggest. */
    photo?: Array<{ file_id?: string; width?: number; height?: number; file_size?: number }>;
    voice?: { file_id?: string; duration?: number };
    video?: { file_id?: string; file_name?: string; duration?: number };
    /** Reply context — what the user is replying to, for quoting in prompts. */
    reply_to_message?: {
      message_id: number;
      text?: string;
      caption?: string;
      photo?: unknown[];
      document?: { file_name?: string };
      sticker?: { emoji?: string };
      voice?: { duration?: number };
      video?: { file_name?: string };
      /** GIFs and animations arrive here, not in `video`. */
      animation?: { mime_type?: string };
      /** Music files — as opposed to recorded voice notes. */
      audio?: { duration?: number };
      /** Circular video messages. */
      video_note?: { duration?: number };
      poll?: { question?: string };
      dice?: { emoji?: string };
      location?: { latitude?: number };
      contact?: { first_name?: string };
      /** Service message that opens a forum thread. */
      forum_topic_created?: { name?: string };
    };
  };
  callback_query?: {
    id: string;
    from: { id: number; username?: string };
    data?: string;
    message?: { message_id: number; chat: { id: number }; message_thread_id?: number };
  };
}

/** Methods that Telegram answers with "message is not modified" as a no-op. */
const EDIT_METHODS = new Set(["editMessageText", "editMessageReplyMarkup", "editMessageCaption"]);

export class Telegram {
  private readonly base: string;
  private readonly pollTimeout: number;
  private offset = 0;
  /** Path of the persisted offset, if any. */
  private readonly offsetFile?: string;
  /** Debounce the offset write: one write per settled batch, not per update. */
  private offsetDirty = false;
  private offsetTimer: ReturnType<typeof setTimeout> | undefined;
  /**
   * The long poll's heartbeat — touched on every loop turn. A leader whose
   * poll is stuck inside one never-returning call shows no errors at all;
   * the bridge's alive() uses this to notice and hand leadership over.
   */
  private lastPollAt = Date.now();

  /**
   * Dead-thread healing, registered by the plugin. When a send hits a topic
   * that was deleted on the phone (verified live: "Bad Request: message
   * thread not found"), this drops the stale mapping so the resolver builds
   * a fresh topic on the next event; the transport then retries the send
   * once at the chat root. One straggler per healing — the transcript
   * continues in the new thread instead of vanishing with the old one.
   */
  onDeadThread?: (chatId: number, threadId: number) => void;

  /** True when Telegram just said that thread does not exist anymore. */
  private isDeadThreadError(error: unknown): boolean {
    return error instanceof TelegramError && /message thread not found/i.test(error.message);
  }
  /** True while the long poll is actually turning (or was, seconds ago). */
  pollAlive(maxGapMs = 90_000): boolean {
    return !this.aborted && Date.now() - this.lastPollAt < maxGapMs;
  }
  private aborted = false;
  /** One controller for every in-flight request, so `stop()` is instantaneous. */
  private controller = new AbortController();
  private get signal(): AbortSignal {
    return this.controller.signal;
  }
  /** Backoff waits register here so `stop()` can cut them short. */
  private delays = new Set<() => void>();
  /**
   * The in-flight requests, so `stop()` can await their actual teardown.
   * Aborting a fetch cancels it locally, but Telegram keeps the connection
   * open for a beat — a replacement leader that starts polling in that window
   * gets HTTP 409 "terminated by other getUpdates" and the two fight forever
   * (measured live, 2026-10-08). The promise resolves only when the socket is
   * gone, which is what makes a hand-over overlap-free.
   */
  private inflight = new Set<Promise<void>>();
  /**
   * Set once Telegram rejects a topic creation: the bot has no forum mode. The
   * rest of the run keeps using the single chat so nothing else has to fail.
   */
  private topicsBroken = false;
  /** Cache of the forum-mode probe, so it happens once per process. */
  private topicsChecked = false;

  constructor(config: TelegramConfig) {
    if (!config.token) throw new Error("Telegram: missing bot token");
    this.base = `${(config.baseUrl ?? "https://api.telegram.org").replace(/\/+$/, "")}/bot${config.token}`;
    this.pollTimeout = config.pollTimeout ?? 30;
    this.offsetFile = config.offsetPath;
    this.offset = this.loadOffset();
  }

  /** Read the last acknowledged id so a restart never replays old updates. */
  private loadOffset(): number {
    if (!this.offsetFile) return 0;
    try {
      const raw = readFileSync(this.offsetFile, "utf8").trim();
      const id = Number(raw);
      return Number.isFinite(id) && id > 0 ? id : 0;
    } catch {
      return 0;
    }
  }

  /**
   * Persist the offset. Telegram drops everything below this id only after
   * it is echoed back on the next call, so surviving a crash is what stops a
   * re-delivery loop. Sync write: the process can be killed a tick later.
   */
  private saveOffset(): void {
    if (!this.offsetFile) return;
    try {
      writeFileSync(this.offsetFile, String(this.offset));
    } catch {
      /* best effort */
    }
  }

  /** Raw Bot API call with flood control and no-op edit suppression. */
  /**
   * Global flood gate — the 2026-10-02 incident: three subagents + the
   * parent each rendering in parallel burst ~28 edits in one second,
   * Telegram answered 429, and every in-flight call retried on its own
   * clock inside the penalty window, RENEWING it: 1929 errors and a muted
   * bot for hours. Now (a) short calls leave through a serial queue with
   * spacing, so bursts cannot happen; (b) one 429 mutes EVERYONE until its
   * retry_after expires, so the penalty is served once — not forever.
   */
  private muteUntil = 0;
  private queue: Promise<void> = Promise.resolve();
  private static readonly SPACING_MS = 50;

  /**
   * Serialize the API call stream. The long poll is a single 35s-parked
   * request — serializing it would freeze every other call behind it, so
   * it skips the queue; the flood mute still applies to it.
   */
  private async gate(longPoll: boolean): Promise<void> {
    if (longPoll) {
      if (Date.now() < this.muteUntil) {
        await delay(this.muteUntil - Date.now() + 50, () => this.aborted, (cancel) => this.delays.add(cancel));
      }
      return;
    }
    const previous = this.queue;
    let release!: () => void;
    this.queue = new Promise<void>((resolve) => {
      release = resolve;
    });
    try {
      await previous;
      // Spacing between outgoing calls keeps the stream far below
      // Telegram's global rate limit no matter how many sessions render.
      await delay(Telegram.SPACING_MS, () => this.aborted, (cancel) => this.delays.add(cancel));
      if (Date.now() < this.muteUntil) {
        await delay(this.muteUntil - Date.now() + 50, () => this.aborted, (cancel) => this.delays.add(cancel));
      }
    } finally {
      release();
    }
  }

  async call<T = unknown>(method: string, body: Record<string, unknown>, attempt = 0): Promise<T> {
    const longPoll = method === "getUpdates";
    await this.gate(longPoll);
    // Tying the in-flight request to `aborted` means `stop()` cancels a
    // 30-second getUpdates instead of leaving the loop parked in it.
    // A request-specific timeout means a *dead* one can never park the
    // loop forever either: Telegram answers a long poll within its
    // `timeout` seconds by contract, so anything past that plus slack is
    // a corpse (NAT dropped it, the socket died mid-answer) and aborting
    // it is what keeps the poller turning.
    const timeoutMs = (longPoll ? (this.pollTimeout + 15) * 1000 : 15_000) + attempt * 5_000;
    const signal =
      typeof AbortSignal.any === "function"
        ? AbortSignal.any([this.signal, AbortSignal.timeout(timeoutMs)])
        : this.signal;
    // The socket promise: resolves with the Response, rejects on network
    // error. Tracked in `inflight` so `stop()` awaits the socket actually
    // closing — aborting cancels locally, but Telegram keeps the connection
    // open a beat, and a replacement leader starting in that window gets
    // HTTP 409 forever (measured, 2026-10-08).
    const socket = fetch(`${this.base}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal,
    });
    // Tracked inline so `stop()` can await the socket actually closing —
    // aborting cancels locally, but Telegram keeps the connection open a
    // beat, and a replacement leader starting in that window gets HTTP 409
    // forever (measured, 2026-10-08). Inlined deliberately: a helper method
    // left the file reloadable into a state where the call site existed and
    // the helper did not, and the poll died on a TypeError instead of
    // degrading.
    const tracked: Promise<void> = socket.then(
      () => undefined,
      () => undefined,
    );
    this.inflight.add(tracked);
    void tracked.finally(() => {
      this.inflight.delete(tracked);
    });
    let response: Response;
    try {
      response = await socket;
    } catch (error) {
      if (this.aborted) throw new TelegramError({ method, description: "aborted" });
      // Network hiccup — Telegram clients are expected to retry.
      if (attempt < 2) {
        await delay(500 * (attempt + 1), () => this.aborted, (cancel) => this.delays.add(cancel));
        return this.call<T>(method, body, attempt + 1);
      }
      throw new TelegramError({ method, description: String(error) });
    }

    let payload: ApiResult<T>;
    try {
      payload = (await response.json()) as ApiResult<T>;
    } catch {
      throw new TelegramError({ method, code: response.status, description: `HTTP ${response.status}` });
    }

    if (payload.ok) return payload.result as T;

    const error = new TelegramError({
      method,
      code: payload.error_code,
      description: payload.description ?? `HTTP ${response.status}`,
      retryAfter: payload.parameters?.retry_after,
    });

    if (EDIT_METHODS.has(method) && error.isNotModified) {
      // Not an error: the caller already had the current text.
      return undefined as T;
    }
    if (error.isFlood && attempt < 4) {
      // One flood sets the GLOBAL gate: every call — not just this one —
      // waits the penalty out, so nothing re-fires inside the window and
      // the mute ends when Telegram says it ends. The retry goes through
      // the gate, which is what holds it.
      const retryAfter = error.info.retryAfter ?? (attempt + 1) * 3;
      this.muteUntil = Math.max(this.muteUntil, Date.now() + retryAfter * 1000 + 500);
      return this.call<T>(method, body, attempt + 1);
    }
    throw error;
  }

  async sendMessage(chatId: number, text: string, options: SendMessageOptions = {}): Promise<number | null> {
    if (!text) return null;
    const body: Record<string, unknown> = {
      chat_id: chatId,
      text,
      disable_web_page_preview: true,
    };
    if (options.parseMode) body.parse_mode = options.parseMode;
    if (options.disableNotification) body.disable_notification = true;
    if (options.replyToMessageId) body.reply_to_message_id = options.replyToMessageId;
    if (options.replyMarkup) body.reply_markup = options.replyMarkup;
    if (options.messageThreadId) body.message_thread_id = options.messageThreadId;
    try {
      const message = await this.call<{ message_id: number }>("sendMessage", body);
      return message?.message_id ?? null;
    } catch (error) {
      if (error instanceof TelegramError && error.isStaleTarget) return null;
      if (options.messageThreadId !== undefined && this.isDeadThreadError(error)) {
        this.onDeadThread?.(chatId, options.messageThreadId);
        const healed: Record<string, unknown> = { ...body };
        delete healed.message_thread_id;
        const message = await this.call<{ message_id: number }>("sendMessage", healed);
        return message?.message_id ?? null;
      }
      // "can't parse entities" must not eat a message: one raw `<` in the
      // text used to lose the whole send. Retry once with no parse mode —
      // plain but delivered (verified live: the mirror died silently on
      // an "Unsupported start tag" until this).
      if (error instanceof TelegramError && /can't parse entities/i.test(error.message)) {
        const plain: Record<string, unknown> = { ...body };
        delete plain.parse_mode;
        try {
          const message = await this.call<{ message_id: number }>("sendMessage", plain);
          return message?.message_id ?? null;
        } catch {
          throw error;
        }
      }
      throw error;
    }
  }

  /** Returns null when the message vanished or the content was identical. */
  async editMessageText(chatId: number, messageId: number, text: string, options: SendMessageOptions = {}): Promise<boolean> {
    if (!text) return false;
    const body: Record<string, unknown> = {
      chat_id: chatId,
      message_id: messageId,
      text,
      disable_web_page_preview: true,
    };
    if (options.parseMode) body.parse_mode = options.parseMode;
    if (options.replyMarkup) body.reply_markup = options.replyMarkup;
    if (options.messageThreadId) body.message_thread_id = options.messageThreadId;
    try {
      await this.call("editMessageText", body);
      return true;
    } catch (error) {
      if (error instanceof TelegramError && (error.isNotModified || error.isStaleTarget)) return false;
      throw error;
    }
  }

  async editMessageReplyMarkup(chatId: number, messageId: number, replyMarkup?: Record<string, unknown>): Promise<boolean> {
    try {
      await this.call("editMessageReplyMarkup", {
        chat_id: chatId,
        message_id: messageId,
        reply_markup: replyMarkup ?? { inline_keyboard: [] },
      });
      return true;
    } catch (error) {
      if (error instanceof TelegramError && (error.isNotModified || error.isStaleTarget)) return false;
      throw error;
    }
  }

  async deleteMessage(chatId: number, messageId: number): Promise<boolean> {
    try {
      await this.call("deleteMessage", { chat_id: chatId, message_id: messageId });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Send a photo from a local file path. Uses multipart upload, so it
   * bypasses `call`'s JSON body but keeps the same signal discipline.
   */
  async sendPhoto(
    chatId: number,
    filePath: string,
    options: { caption?: string; messageThreadId?: number } = {},
  ): Promise<number | null> {
    const sendOnce = async (tid?: number): Promise<ApiResult<{ message_id: number }>> => {
      const fs = await import("node:fs");
      const buffer = fs.readFileSync(filePath);
      const boundary = "----opencode-tg-" + Date.now();
      const parts: Buffer[] = [];
      const push = (name: string, value: string): void => {
        parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`));
      };
      push("chat_id", String(chatId));
      if (options.caption) push("caption", options.caption.slice(0, 1024));
      if (tid) push("message_thread_id", String(tid));
      const name = filePath.split(/[\\/]/).pop() ?? "photo.png";
      parts.push(
        Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="photo"; filename="${name}"\r\nContent-Type: application/octet-stream\r\n\r\n`),
      );
      parts.push(buffer, Buffer.from(`\r\n--${boundary}--\r\n`));
      const body = Buffer.concat(parts);
      const signal =
        typeof AbortSignal.any === "function"
          ? AbortSignal.any([this.signal, AbortSignal.timeout(30_000)])
          : this.signal;
      const response = await fetch(`${this.base}/sendPhoto`, {
        method: "POST",
        headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
        body,
        signal,
      });
      return (await response.json()) as ApiResult<{ message_id: number }>;
    };
    let payload = await sendOnce(options.messageThreadId);
    if (
      !payload.ok &&
      options.messageThreadId !== undefined &&
      /message thread not found/i.test(payload.description ?? "")
    ) {
      this.onDeadThread?.(chatId, options.messageThreadId);
      payload = await sendOnce(undefined);
    }
    return payload.ok ? (payload.result?.message_id ?? null) : null;
  }

  /**
   * Send a document (any file) as a downloadable attachment.
   */
  async sendDocument(
    chatId: number,
    filePath: string,
    options: { caption?: string; messageThreadId?: number } = {},
  ): Promise<number | null> {
    const sendOnce = async (tid?: number): Promise<ApiResult<{ message_id: number }>> => {
      const fs = await import("node:fs");
      const buffer = fs.readFileSync(filePath);
      const boundary = "----opencode-tg-" + Date.now();
      const parts: Buffer[] = [];
      const push = (name: string, value: string): void => {
        parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`));
      };
      push("chat_id", String(chatId));
      if (options.caption) push("caption", options.caption.slice(0, 1024));
      if (tid) push("message_thread_id", String(tid));
      const name = filePath.split(/[\\/]/).pop() ?? "archivo.bin";
      parts.push(
        Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="document"; filename="${name}"\r\nContent-Type: application/octet-stream\r\n\r\n`),
      );
      parts.push(buffer, Buffer.from(`\r\n--${boundary}--\r\n`));
      const body = Buffer.concat(parts);
      const signal =
        typeof AbortSignal.any === "function"
          ? AbortSignal.any([this.signal, AbortSignal.timeout(30_000)])
          : this.signal;
      const response = await fetch(`${this.base}/sendDocument`, {
        method: "POST",
        headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
        body,
        signal,
      });
      return (await response.json()) as ApiResult<{ message_id: number }>;
    };
    let payload = await sendOnce(options.messageThreadId);
    if (
      !payload.ok &&
      options.messageThreadId !== undefined &&
      /message thread not found/i.test(payload.description ?? "")
    ) {
      this.onDeadThread?.(chatId, options.messageThreadId);
      payload = await sendOnce(undefined);
    }
    return payload.ok ? (payload.result?.message_id ?? null) : null;
  }

  /**
   * Thread lifecycle. "Archive" in Telegram terms is `close`: the thread
   * stays visible, nobody can write into it, and `reopen` restores it. All
   * three tolerate already-done states so a race (or a manual close in the
   * app) reads as success rather than an error.
   */
  async closeForumTopic(chatId: number, threadId: number): Promise<boolean> {
    try {
      await this.call("closeForumTopic", { chat_id: chatId, message_thread_id: threadId });
      return true;
    } catch (error) {
      if (error instanceof TelegramError && this.isThreadStateError(error)) return true;
      throw error;
    }
  }

  async reopenForumTopic(chatId: number, threadId: number): Promise<boolean> {
    try {
      await this.call("reopenForumTopic", { chat_id: chatId, message_thread_id: threadId });
      return true;
    } catch (error) {
      if (error instanceof TelegramError && this.isThreadStateError(error)) return true;
      throw error;
    }
  }

  /**
   * Rename a topic — sessions get retitled all the time (the title agent
   * after the first prompt, manual renames), and the forum thread must
   * follow to stay findable.
   */
  async editForumTopic(chatId: number, threadId: number, name: string): Promise<boolean> {
    try {
      await this.call("editForumTopic", { chat_id: chatId, message_thread_id: threadId, name: name.slice(0, 128) });
      return true;
    } catch (error) {
      if (error instanceof TelegramError && this.isThreadStateError(error)) return true;
      throw error;
    }
  }

  async deleteForumTopic(chatId: number, threadId: number): Promise<boolean> {
    try {
      await this.call("deleteForumTopic", { chat_id: chatId, message_thread_id: threadId });
      return true;
    } catch (error) {
      if (error instanceof TelegramError && this.isThreadStateError(error)) return true;
      throw error;
    }
  }

  /** "already closed/open/gone" — the operation's end state is what we asked. */
  private isThreadStateError(error: TelegramError): boolean {
    return /TOPIC_CLOSED|TOPIC_ID_INVALID|message thread not found/i.test(error.info.description);
  }

  /**
   * Telegram tells us whether the bot has forum topic mode enabled in private
   * chats via `getMe`. Without it `createForumTopic` fails with "the chat is
   * not a forum", which is the signal to fall back to a single chat.
   */
  async hasTopics(): Promise<boolean> {
    try {
      const me = await this.call<{ has_topics_enabled?: boolean }>("getMe", {});
      return me?.has_topics_enabled === true;
    } catch {
      return false;
    }
  }

  /**
   * Create a forum topic in the private chat. Returns the thread id, or
   * `undefined` when the bot does not have topic mode enabled — in that case
   * the chat stays a single stream and callers must not pass thread ids.
   */
  async createForumTopic(chatId: number, name: string): Promise<number | undefined> {
    // Probe once per process: topic mode is a BotFather setting, not something
    // that changes while we are running.
    if (!this.topicsChecked) {
      this.topicsChecked = true;
      const enabled = await this.hasTopics();
      if (!enabled) this.topicsBroken = true;
    }
    if (this.topicsBroken) return undefined;
    try {
      const topic = await this.call<{ message_thread_id: number }>("createForumTopic", {
        chat_id: chatId,
        name: name.slice(0, 128),
      });
      return topic?.message_thread_id;
    } catch (error) {
      if (error instanceof TelegramError) {
        // Forum topics are not enabled for this bot (or the chat is not a
        // forum). Downgrade to single-chat mode rather than failing per event.
        if (/not a forum|forums disabled|method not available for this chat type/i.test(error.info.description)) {
          this.topicsBroken = true;
          return undefined;
        }
      }
      throw error;
    }
  }

  /** Whether this bot can use forum topics right now. */
  topicsEnabled(): boolean {
    return !this.topicsBroken;
  }

  async answerCallbackQuery(id: string, text?: string, showAlert = false): Promise<void> {    await this.call("answerCallbackQuery", {
      callback_query_id: id,
      ...(text ? { text, show_alert: showAlert } : {}),
    }).catch(() => undefined);
  }

  /**
   * Publish our command list. Telegram caches menus **per scope** and the
   * narrower scope wins — the previous bot wrote a `{type:"chat"}` list that
   * outranked the default scope, which is why removed commands lingered.
   * We therefore publish under every scope that can win.
   */
  async setCommandsEverywhere(commands: { command: string; description: string }[], chatIds: number[] = []): Promise<void> {
    const scopes: Record<string, unknown>[] = [
      { type: "all_private_chats" },
      { type: "all_group_chats" },
      ...chatIds.map((chat_id) => ({ type: "chat", chat_id })),
    ];
    for (const scope of scopes) {
      await this.call("setMyCommands", { commands, scope }).catch((error) => {
        if (error instanceof TelegramError && error.isStaleTarget) return;
        throw error;
      });
    }
  }

  async getMe(): Promise<{ id: number; username: string; first_name: string }> {
    return this.call("getMe", {});
  }

  /** A file's download path — the Bot API's two-step dance. */
  async getFile(fileId: string): Promise<{ file_id: string; file_size?: number; file_path?: string }> {
    return this.call("getFile", { file_id: fileId });
  }

  /**
   * The file bytes behind a `file_path`. This is a raw GET (no JSON envelope),
   * so it bypasses `call` but keeps the same per-request timeout discipline.
   */
  async downloadFile(filePath: string): Promise<Buffer> {
    const signal =
      typeof AbortSignal.any === "function"
        ? AbortSignal.any([this.signal, AbortSignal.timeout(30_000)])
        : this.signal;
    const response = await fetch(`${this.base.replace("/bot", "/file/bot")}/${filePath}`, { signal });
    if (!response.ok) throw new TelegramError({ method: "file download", code: response.status, description: `HTTP ${response.status}` });
    return Buffer.from(await response.arrayBuffer());
  }

  /**
   * Long-poll forever until `stop()`. Confirms there is no webhook first —
   * `getUpdates` and a webhook are mutually exclusive.
   *
   * `drop_pending_updates` is on for a reason: whatever queued up while nobody
   * was polling — the previous bot's last seconds, a service restart, or an
   * earlier instance — is history, and answering all of it at once would flood
   * the chat. Telegram keeps undelivered updates for ~24h, so on a first live
   * start this can be hours of backlog.
   */
  /**
   * Bring a stopped transport back to life. `stop()` aborts the controller
   * for good, so a re-promoted instance would lead with a corpse: every
   * call answered "aborted", the mirror went silent while the seat was
   * held, and the poll died on its first tick past the startup grace
   * (measured 2026-10-08). The bridge calls this before a (re)start, and
   * the poll re-revives defensively. In-flight requests keep the old
   * aborted signal — only calls made after the revive use the fresh one.
   */
  revive(): void {
    this.aborted = false;
    this.lastPollAt = Date.now();
    this.controller = new AbortController();
  }

  async longPoll(onUpdate: (update: Update) => void | Promise<void>, onError?: (error: unknown) => void): Promise<void> {
    // One instance can lead, be deposed, and lead again — the poll's
    // first act is making sure the transport is not the corpse the last
    // stop left behind.
    this.revive();
    // NOT drop_pending_updates: every poll restart wiped whatever the user
    // sent while no poller was listening (today that ate real messages).
    // The webhook only exists once in a bot's life — deleting it without
    // dropping keeps the pending updates for the first getUpdates to fetch.
    await this.call("deleteWebhook", { drop_pending_updates: false }).catch(() => undefined);

    let conflicts = 0;
    while (!this.aborted) {
      // The loop's heartbeat: a leader whose poll is stuck inside one call
      // (dead socket, vanished network) shows no errors and no logs — but
      // this timestamp stops moving, and the bridge's alive() catches it.
      this.lastPollAt = Date.now();
      let updates: Update[] = [];
      try {
        updates = await this.call<Update[]>("getUpdates", {
          offset: this.offset,
          timeout: this.pollTimeout,
          limit: 100,
          allowed_updates: ["message", "callback_query"],
        });
        conflicts = 0;
      } catch (error) {
        if (this.aborted) return;
        onError?.(error);
        // "Terminated by other getUpdates request": another process is polling
        // this token. Retrying just keeps the fight alive — log it once and
        // back off hard, because the other poller is winning for a reason
        // (an OpenCode desktop app, a stale service, our own other instance).
        if (error instanceof TelegramError && error.info.code === 409) {
          conflicts += 1;
          if (conflicts === 1) {
            onError?.(new Error("409: otro proceso sondea este token — este poller se rinde"));
          }
          if (conflicts >= 3) {
            // Three consecutive conflicts: the other process won the
            // lock and is polling. Stop — the watchdog hands the seat to
            // another instance, and the bridge keeps working there.
            log("WARN", "poll: 3 conflictos 409 seguidos — cediendo el poll al otro proceso");
            // Mark the loop dead NOW: a clean exit leaves `aborted` false and
            // `pollAlive()` answering true until the heartbeat ages out (90s),
            // so the watchdog keeps this wedged leader in the seat and nothing
            // re-contests. The bridge stayed leaderless-but-occupied for that
            // whole window (measured live, 2026-10-08).
            this.aborted = true;
            this.controller.abort();
            for (const cancel of this.delays) cancel();
            this.delays.clear();
            return;
          }
          // Short backoff with jitter: the system converges faster than
          // a fixed 30s, and two fighting pollers desynchronize.
          const backoff = 10_000 + Math.random() * 5_000;
          await delay(backoff, () => this.aborted, (cancel) => this.delays.add(cancel));
        } else {
          await delay(2000, () => this.aborted, (cancel) => this.delays.add(cancel));
        }
        continue;
      }

      for (const update of updates ?? []) {
        // Advance the offset before handling so a crash never re-delivers.
        this.offset = Math.max(this.offset, update.update_id + 1);
        // Persist NOW, before the handler runs: a handler that kills this
        // process (measured: `/sh opencode service restart`) must not come
        // back as a fresh update on the next start and loop forever. Sync
        // write — the process can be dead a tick later.
        this.saveOffset();
        try {
          await onUpdate(update);
        } catch (error) {
          onError?.(error);
        }
      }
    }
  }

  async stop(): Promise<void> {
    this.aborted = true;
    this.controller.abort();
    // A long-poll mid-backoff is parked in `delay`; resolving it here makes the
    // loop re-check `aborted` now instead of up to 30s later, which is the
    // difference between a clean hand-over and a stray poller fighting the
    // new leader with HTTP 409s for half a minute per round.
    for (const cancel of this.delays) cancel();
    this.delays.clear();
    // Wait for the sockets to actually close. Abort is local and instant, but
    // Telegram still sees the connection open until the socket drains — a
    // replacement leader polling inside that window gets HTTP 409 "terminated
    // by other getUpdates" and the two fight indefinitely (measured live).
    // Bounded: a socket that refuses to close must not wedge the hand-over.
    const pending = [...this.inflight];
    this.inflight.clear();
    await Promise.race([
      Promise.allSettled(pending),
      new Promise<void>((resolve) => setTimeout(resolve, 2000)),
    ]);
  }
}

function delay(ms: number, aborted?: () => boolean, onCancel?: (cancel: () => void) => void): Promise<void> {
  return new Promise((resolve) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const cancel = (): void => {
      if (timer !== undefined) clearTimeout(timer);
      resolve();
    };
    timer = setTimeout(() => {
      onCancel?.(cancel);
      resolve();
    }, ms);
    if (aborted?.()) {
      clearTimeout(timer);
      resolve();
      return;
    }
    onCancel?.(cancel);
  });
}

/**
 * A Telegram client that never touches the network.
 *
 * Migration tool: while `mode: "dry"` the previous bot still owns the token's
 * long poll, so this logs exactly what would have been sent. Same call surface
 * as the real client, so `TurnRenderer` needs no branching.
 */
export class DryRunTelegram extends Telegram {
  private nextId = 900_000;
  private readonly onSend: (kind: "send" | "edit" | "other", text: string) => void;

  constructor(onSend: (kind: "send" | "edit" | "other", text: string) => void) {
    super({ token: "dry-run" });
    this.onSend = onSend;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  override async call<T = unknown>(method: string, body: Record<string, unknown>): Promise<T> {
    const text = typeof body.text === "string" ? body.text : "";
    if (method === "sendMessage") {
      this.onSend("send", text);
      return { message_id: ++this.nextId } as T;
    }
    if (method === "editMessageText") {
      this.onSend("edit", text);
      return true as unknown as T;
    }
    if (method === "getUpdates" || method === "deleteWebhook") return [] as T;
    this.onSend("other", `${method} ${JSON.stringify(body).slice(0, 200)}`);
    return undefined as T;
  }
}

