/**
 * Turn rendering: ordered blocks of OpenCode events -> ordered Telegram messages.
 *
 * Two things are hard here and both are handled explicitly:
 *
 *  ORDER. Telegram shows messages in the order they are *created*, not edited.
 *  So a block gets its message the moment it starts — a text block sends a `▌`
 *  caret, a tool block sends its first card — and every later update edits that
 *  same message. The transcript therefore matches the PC's chronology.
 *
 *  CONCURRENCY. A delta can arrive while the creation request is still in
 *  flight. `sending` marks the block as reserved so a second message is never
 *  created; the newest HTML is kept and re-sent once the id is known.
 */
import { Telegram } from "./telegram.js";
import { t } from "./locale.js";
import { chunkHtml, escapeHtml, formatDiff, formatToolCard, guessToolName, toHtml, type ToolStatus } from "./render.js";
import type { RenderOptions } from "./render-options.js";
interface ToolRecord {
  id: string;
  name: string;
  input: Record<string, unknown>;
  status: ToolStatus;
  output: string;
  error?: string;
  pendingDiff?: string;
}

/** A tool is only worth a line once we know what it was asked to do (or did). */
function hasContent(tool: ToolRecord): boolean {
  return Object.keys(tool.input).length > 0 || tool.output !== "" || tool.error !== undefined;
}

/**
 * One colour dot per session, stable for the session's lifetime. When several
 * sessions interleave in one chat the dot is what lets the eye follow a single
 * conversation without reading every header.
 */
const DOTS = ["\u{1F534}", "\u{1F7E0}", "\u{1F7E1}", "\u{1F7E2}", "\u{1F535}", "\u{1F7E3}", "\u{1F7E4}", "\u{26AB}"];
function dotFor(sessionID: string): string {
  let hash = 0;
  for (let i = 0; i < sessionID.length; i++) hash = (hash * 31 + sessionID.charCodeAt(i)) >>> 0;
  return DOTS[hash % DOTS.length] ?? DOTS[0]!;
}

interface BlockBase {
  messageId?: number;
  sending: boolean;
  lastEdit: number;
  dirty: boolean;
  /** Payload actually pushed (truncated): identical re-renders skip the edit. */
  lastHtml?: string;
}

type TextBlock = BlockBase & {
  kind: "text";
  key: string;
  prefix: string;
  parts: Map<number, string>;
  text: string;
  done: boolean;
};

type ToolsBlock = BlockBase & {
  kind: "tools";
  tools: Map<string, ToolRecord>;
  done: boolean;
};

type Block = TextBlock | ToolsBlock;

class SessionView {
  readonly blocks: Block[] = [];
  private readonly textByKey = new Map<string, TextBlock>();
  private lastTools?: ToolsBlock;

  constructor(
    readonly sessionID: string,
    private readonly chatId: number,
    private readonly telegram: Telegram,
    private readonly options: RenderOptions,
    private readonly isWatched: () => boolean,
    private readonly notify: (error: unknown) => void,
    /** Resolves the session's current title, so the label tracks renames. */
    private readonly titleOf: () => string,
    /** Forum thread for this session, or undefined when topics are off. */
    private readonly threadOf: () => number | undefined,
  ) {}

  /**
   * The one-line header every message from this session carries. Without it the
   * chat is a single undifferentiated stream: two sessions working at once
   * arrive interleaved and there is nothing to say which block belongs to whom.
   * When each session has its own thread the topic title already identifies it,
   * so the header is only needed at the chat root.
   */
  private header(): string {
    if (this.threadOf() !== undefined) return "";
    const title = this.titleOf().trim() || t("no_title");
    return `${dotFor(this.sessionID)} <b>${escapeHtml(title.slice(0, 60))}</b>`;
  }

  // ── text / reasoning ──────────────────────────────────────────────────────

  textStarted(key: string, prefix = ""): void {
    if (this.textByKey.has(key)) return;
    const block: TextBlock = {
      kind: "text", key, prefix, parts: new Map(), text: "",
      done: false, sending: false, lastEdit: 0, dirty: false,
    };
    this.blocks.push(block);
    this.textByKey.set(key, block);
    // A new text block closes the previous run of tools, so tools that follow
    // form their own message instead of jumping above this one.
    this.lastTools = undefined;
    const head = this.header();
    this.create(block, head ? `${head}\n${escapeHtml(prefix + "\u258C")}` : escapeHtml(prefix + "\u258C"));
  }

  textDelta(key: string, ordinal: number, delta: string): void {
    let block = this.textByKey.get(key);
    if (!block) {
      this.textStarted(key);
      block = this.textByKey.get(key);
      if (!block) return;
    }
    block.parts.set(ordinal, (block.parts.get(ordinal) ?? "") + delta);
    block.text = [...block.parts.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([, value]) => value)
      .join("");
    if (block.prefix && block.text.startsWith(block.prefix)) block.text = block.text.slice(block.prefix.length);
    block.dirty = true;
    this.flush(block, false);
  }

  textEnded(key: string): void {
    const block = this.textByKey.get(key);
    if (!block) return;
    block.done = true;
    block.dirty = true;
    this.flush(block, true);
  }

  // ── tools ─────────────────────────────────────────────────────────────────

  toolEvent(record: Partial<ToolRecord> & { id: string }): void {
    if (!this.isWatched()) return;
    let block = this.lastTools;
    if (!block) {
      block = { kind: "tools", tools: new Map(), done: false, sending: false, lastEdit: 0, dirty: false };
      this.blocks.push(block);
      this.lastTools = block;
    }
    const existing = block.tools.get(record.id);
    const provided = record.name && record.name !== "tool" ? record.name : undefined;
    const carried = existing?.name && existing.name !== "tool" ? existing.name : undefined;
    const merged: ToolRecord = {
      id: record.id,
      name: provided ?? carried ?? "tool",
      input: { ...(existing?.input ?? {}), ...(record.input ?? {}) },
      status: record.status ?? existing?.status ?? "running",
      output: record.output ?? existing?.output ?? "",
      error: record.error ?? existing?.error,
      pendingDiff: existing?.pendingDiff,
    };
    if (merged.name === "tool") merged.name = guessToolName(merged.input);
    if (this.options.showDiffs && merged.status === "completed" && !merged.pendingDiff && !existing?.pendingDiff) {
      merged.pendingDiff = this.buildDiff(merged);
    }
    block.tools.set(record.id, merged);
    block.dirty = true;
    this.flush(block, false);
  }

  // ── flushing ──────────────────────────────────────────────────────────────

  /** Reserve the block's message. The id arrives asynchronously. */
  private create(block: Block, html: string): void {
    if (!this.isWatched() || block.messageId !== undefined || block.sending) return;
    const chunks = chunkHtml(html);
    block.sending = true;
    block.dirty = false;
    block.lastHtml = html;
    const thread = this.threadOf();
    void this.telegram
      .sendMessage(this.chatId, chunks[0], { parseMode: "HTML", messageThreadId: thread })
      .then((messageId) => {
        block.sending = false;
        if (messageId) block.messageId = messageId;
        block.lastEdit = Date.now();
        // Overflow pieces are append-only snapshots; never edit them.
        for (const extra of chunks.slice(1)) {
          void this.telegram
            .sendMessage(this.chatId, extra, { parseMode: "HTML", messageThreadId: thread })
            .catch(this.notify);
        }
        if (block.dirty) this.flush(block, true);
        this.sendPendingDiff(block);
      })
      .catch((error) => {
        block.sending = false;
        this.notify(error);
      });
  }

  private flush(block: Block, force: boolean): void {
    if (!this.isWatched()) return;
    if (!block.dirty && !force) return;
    const html = this.render(block);
    if (!html) {
      block.dirty = false;
      return;
    }
    // Identical to what Telegram already holds: skip the call. Redundant edits
    // are the main way a bridge trips Telegram's flood limit.
    if (html === block.lastHtml) {
      block.dirty = false;
      this.sendPendingDiff(block);
      return;
    }

    if (block.messageId === undefined) {
      if (block.sending) return; // creation in flight; latest html is re-read after it lands
      this.create(block, html);
      return;
    }

    const now = Date.now();
    if (!force && now - block.lastEdit < this.options.editIntervalMs) return;

    block.lastEdit = now;
    block.dirty = false;
    // Edits must respect the same ceiling as creation: a text block that grew
    // past 4096 while streaming would otherwise fail with "message is too long"
    // and the mirror would silently freeze on that block forever. `lastHtml`
    // stores the truncated payload actually sent, so the identity check above
    // keeps suppressing redundant edits instead of always missing.
    const sent = chunkHtml(html)[0];
    void this.telegram
      .editMessageText(this.chatId, block.messageId, sent, {
        parseMode: "HTML",
        messageThreadId: this.threadOf(),
      })
      .then((changed) => {
        if (changed) block.lastHtml = sent;
        else block.dirty = false;
        this.sendPendingDiff(block);
      })
      .catch(this.notify);
  }

  /** Non-forced pass; used by the periodic tick so nothing stalls. */
  tick(): void {
    for (const block of this.blocks) if (block.dirty) this.flush(block, false);
  }

  finalize(): void {
    for (const block of this.blocks) {
      block.done = true;
      this.flush(block, true);
      this.sendPendingDiff(block);
    }
  }

  private render(block: Block): string {
    const head = this.header();
    if (block.kind === "text") {
      if (!block.text) return "";
      const body = toHtml(block.text);
      const inner = block.prefix ? `${escapeHtml(block.prefix)}\n${body}` : body;
      return `${head}\n${inner}`;
    }
    // `session.tool.input.started` registers the name before the input exists.
    // A card with nothing to say would be sent and rewritten a millisecond
    // later, so it waits here until there is something to show.
    const cards = [...block.tools.values()].filter(hasContent).map((tool) => formatToolCard(tool)).join("\n");
    if (!cards) return "";
    return `${head}\n${cards}`;
  }

  private buildDiff(tool: ToolRecord): string | undefined {
    const input = tool.input as { oldString?: string; newString?: string; oldText?: string; newText?: string };
    const before = input.oldString ?? input.oldText;
    const after = input.newString ?? input.newText;
    if (typeof before !== "string" || typeof after !== "string") return undefined;
    if (before === after || before.length > 60_000 || after.length > 60_000) return undefined;
    return formatDiff(before, after, this.options.diffMaxLines) || undefined;
  }

  /**
   * Diffs are their own message: long, immutable, and they must not compete
   * with streaming text for the one-edit-per-second budget. Sent only once the
   * owning block exists so they land after the tool card, not before it.
   */
  private sendPendingDiff(block: Block): void {
    if (block.kind !== "tools" || block.messageId === undefined || !this.isWatched()) return;
    const thread = this.threadOf();
    for (const tool of block.tools.values()) {
      const diff = tool.pendingDiff;
      if (!diff) continue;
      tool.pendingDiff = undefined;
      // A big rewrite can produce a diff well past the limit on its own.
      for (const piece of chunkHtml(diff)) {
        void this.telegram
          .sendMessage(this.chatId, piece, { parseMode: "HTML", messageThreadId: thread })
          .catch(this.notify);
      }
    }
  }
}

/** Owns the session -> view mapping and the periodic tick. */
export class TurnRenderer {
  private readonly views = new Map<string, SessionView>();
  private timer?: ReturnType<typeof setInterval>;

  constructor(
    private readonly telegram: Telegram,
    private readonly chatId: number,
    private readonly options: RenderOptions,
    private readonly isWatched: (sessionID: string) => boolean,
    private readonly notify: (error: unknown) => void,
    /** Session titles, for the header each message carries. */
    private readonly titleOf: (sessionID: string) => string,
    /** Forum thread per session; `undefined` when topic mode is off. */
    private readonly threadOf: (sessionID: string) => number | undefined,
  ) {}

  private view(sessionID: string): SessionView {
    let view = this.views.get(sessionID);
    if (!view) {
      view = new SessionView(
        sessionID, this.chatId, this.telegram, this.options,
        () => this.isWatched(sessionID), this.notify, () => this.titleOf(sessionID),
        () => this.threadOf(sessionID),
      );
      this.views.set(sessionID, view);
    }
    return view;
  }

  start(): void {
    // Safety net: a missed "ended"/"idle" event must not leave text frozen.
    this.timer = setInterval(() => this.tick(), 2000);
  }

  tick(): void {
    for (const view of this.views.values()) view.tick();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    for (const view of this.views.values()) view.finalize();
  }

  textStarted(sessionID: string, key: string, prefix = ""): void {
    this.view(sessionID).textStarted(key, prefix);
  }
  textDelta(sessionID: string, key: string, ordinal: number, delta: string): void {
    this.view(sessionID).textDelta(key, ordinal, delta);
  }
  textEnded(sessionID: string, key: string): void {
    this.view(sessionID).textEnded(key);
  }
  toolEvent(sessionID: string, record: Partial<ToolRecord> & { id: string }): void {
    this.view(sessionID).toolEvent(record);
  }
  finalize(sessionID: string): void {
    this.views.get(sessionID)?.finalize();
  }
}

export type { ToolRecord };
