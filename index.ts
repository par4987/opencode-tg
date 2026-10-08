/**
 * opencode-tg — a Telegram bridge that lives *inside* the OpenCode server.
 *
 * Why a plugin and not a separate bot process: the previous bridge spoke ACP
 * over stdio, which only ever sees sessions it creates itself — so it needed a
 * SQLite mirror, a 15-minute activity heuristic and a file tail just to
 * approximate what the PC shows. Running in-process means `ctx.event` delivers
 * the very same events the TUI renders, for every session, as they happen.
 *
 * Runtime dependencies: none. `@opencode/plugin` is imported type-only, so it
 * is erased at compile time and this folder needs no node_modules.
 */
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { configProviders } from "./src/config-models.js";
import { projectConfigFile, withDefaultModel } from "./src/config-edit.js";
import { fmtSize, LS_HIDDEN, safeResolve } from "./src/lsbrowse.js";
import { decodeText, DOC_MAX_CHARS, isTextLike, saveBinary } from "./src/ingest.js";
import { describeReplyTarget, extractFilePaths, isForumEcho, qualifyingImage, selectImages, withReplyContext, MAX_IMAGES } from "./src/media-out.js";
import { sttAvailable, transcribeFile } from "./src/stt.js";
import { clearDraft, fmtDateTime, formatSchedule, newTaskId, nextRunOf, parseScheduleDetail, readDraft, readTasks, updateTaskPrompt, writeDraft, writeTasks, type Task, type TaskDraft, type TaskSchedule } from "./src/tasks.js";
import { desktopVisibleModels } from "./src/desktop-models.js";
import { AcpClient, type PermissionOutcome, type RequestPermissionParams } from "./src/acp.js";
import { loadConfig, type Mode } from "./src/config.js";
import { acquireLock, ensureLockDir, heartbeat, lockHeldBy, releaseLock, LOCK_INTERVAL } from "./src/leader.js";
import { log, safe } from "./src/log.js";
import { DryRunTelegram, Telegram, type Update } from "./src/telegram.js";
import { TurnRenderer } from "./src/stream.js";
import { RebuildSession, TopicResolver, TopicStore, rebuildCandidates, sweepTopics } from "./src/topics.js";
import { escapeHtml } from "./src/render.js";
import { readSessionMeta } from "./src/session-meta.js";
import { MessageCards } from "./src/message-cards.js";
import { NATIVE_NAMES, availableLocales, locale, setLocale, t } from "./src/locale.js";
import { dangerousCommand, explainCommand } from "./src/dangerous.js";
import { parseSseData, generateTextOf, titleOptionsFrom } from "./src/extra.js";
import { commandSections } from "./src/help.js";
import { readHistory, jsonlPath, entriesFromExport, type HistoryEntry } from "./src/history.js";
import { FormClient, choicesOf, answerFor, answerFree, parseFreeCommand, pickOption, formatAnswer, mergeAnswer, formComplete, formatFullAnswer, type FormInfo, type FormOption, type FormChoice } from "./src/forms.js";
import type { Plugin } from "@opencode/plugin";

type Context = Plugin.Context;


interface TrackedSession {
  id: string;
  title: string;
  directory: string;
  /** Set for subagent (task) sessions: the parent session's id. */
  parentID?: string;
  lastSeen: number;
  /** Cleared on every event, set by `session.idle`: the turn finished. */
  idle: boolean;
}

/** A form open in a session, together with the Telegram message showing it. */
interface OpenForm {
  formID: string;
  sessionID: string;
  title: string;
  choices: FormChoice[];
  messageId?: number;
  threadId?: number;
  /** The message as posted, so the receipt can replace it verbatim. */
  body: string;
  /** Set once somebody answered, so a late tap is not sent twice. */
  settled: boolean;
  /** Armed by the "Otra respuesta" button: the next message answers freely. */
  freeText?: boolean;
  /**
   * Multi-question forms accumulate here, one key per field; the reply only
   * goes out when every option-bearing field has an answer.
   */
  answers: Record<string, string | string[]>;
}

/**
 * Events whose payload shape is verified against the real server when
 * `debugEvents` is on. Deliberately excludes `*.delta` — those arrive per token.
 */
const DEBUG_EVENTS = new Set([
  "session.created",
  "session.renamed",
  "session.metadata.updated",
  "session.text.started",
  "session.text.ended",
  "session.reasoning.started",
  "session.tool.input.started",
  "session.tool.called",
  "session.tool.progress",
  "session.tool.success",
  "session.tool.failed",
  "session.status",
  "session.idle",
  "session.execution.succeeded",
  "session.execution.failed",
  "permission.asked",
]);

interface ToolPayload {
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  content?: unknown;
  metadata?: Record<string, unknown>;
  error?: { message?: string };
  status?: string;
}

function dataOf(event: { data?: unknown }): Record<string, unknown> {
  const value = event.data;
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** Tool results are blocks; only text blocks are worth showing. */
function contentText(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .filter((block): block is { text: string } => !!block && typeof block === "object" && str((block as Record<string, unknown>).type) === "text")
    .map((block) => block.text)
    .join("\n")
    .trim();
}

function textKey(data: Record<string, unknown>): string {
  const messageID = str(data.assistantMessageID ?? data.messageID) || "msg";
  const ordinal = typeof data.ordinal === "number" ? data.ordinal : 0;
  return `${messageID}#${ordinal}`;
}

/** 40622318 → "40.6M"; 356583 → "357k"; 912 → "912". */
function fmtTokens(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${Math.round(value / 1_000)}k`;
  return String(value);
}

/** 0.004213 → "$0.0042"; 0 → "$0". */
function fmtCost(value: number): string {
  if (value === 0) return "$0";
  if (value < 0.01) return `$${value.toFixed(4)}`;
  return `$${value.toFixed(2)}`;
}

/** Timestamp → "hace un momento" / "hace 3 min" / "hace 2 h" / "hace 5 d". */
function fmtAgo(ts: number): string {
  const seconds = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (seconds < 60) return t("ago_now");
  if (seconds < 3600) return t("ago_min", { n: Math.floor(seconds / 60) });
  if (seconds < 86_400) return t("ago_hour", { n: Math.floor(seconds / 3600) });
  return t("ago_day", { n: Math.floor(seconds / 86_400) });
}

/**
 * OpenCode local API shapes, trimmed to the fields the bridge reads. Full
 * contracts live in `@opencode/client`'s generated types; these are the subsets
 * verified against the running server.
 */
interface ApiSession {
  id: string;
  agent?: string;
  projectID?: string;
  model?: { id?: string; providerID?: string; variant?: string };
  cost?: number;
  tokens?: { input?: number; output?: number; reasoning?: number; cache?: { read?: number; write?: number } };
  time?: { created?: number; updated?: number; idle?: number };
  title?: string;
  location?: { directory?: string };
}
interface ApiMcpServer {
  name: string;
  status?: { status?: string };
}
interface ApiModel {
  id: string;
  modelID?: string;
  providerID: string;
  /** Display name — what the desktop selector shows. */
  name?: string;
  /** The catalogue also carries disabled/deprecated entries; they stay out. */
  enabled?: boolean;
  status?: string;
}
interface ApiAgent {
  id: string;
  name?: string;
}


// ── one bridge per process ───────────────────────────────────────────────────
/**
 * OpenCode does not call `setup()` once. It calls it per plugin instance, and
 * it churns them constantly — a CLI invocation, a TUI reconnect, a project
 * change each build a fresh instance and tear the old one down (the log shows
 * bursts of four setups with a cleanup milliseconds before each).
 *
 * Letting every instance subscribe on its own mirrors the same turn N times,
 * and in live mode two long polls on one token collide with Telegram's HTTP
 * 409. So instances in this process share a single leader: the first one to
 * join starts the bridge, the rest idle, and if the leader is torn down while
 * others remain, the next one takes over.
 *
 * `Symbol.for` (not a module symbol) because OpenCode may evaluate this module
 * once per instance; the key must survive that.
 */
interface BridgeInstance {
  start: () => Promise<void>;
  stop: () => Promise<void>;
  /** False once the event stream closed on its own, i.e. OpenCode tore this
   *  instance down. A leader in that state is a corpse: it holds the lock and
   *  the registry slot but pumps nothing. */
  alive?: () => boolean;
}

interface BridgeRegistry {
  leader?: BridgeInstance;
  /** Mode the sitting leader was built for — a config flip leaves it stale. */
  leaderMode?: Mode;
  members: Set<BridgeInstance>;
  /** The mode each member was created for, so a hand-over reinstates the right one. */
  memberModes: WeakMap<BridgeInstance, Mode>;
  /** Each member's guarded wrapper, so a hand-over installs the same object the
   *  registry compares leaders against (`reg.leader === guarded`). */
  wrappers: WeakMap<BridgeInstance, BridgeInstance>;
}

/** joinBridge's per-instance seat: the watchdog tick plus the teardown. */
export interface BridgeSeat {
  /** One watchdog round — the caller's timer fires this every LOCK_INTERVAL. */
  tick: () => Promise<void>;
  /** Removes the member; a leader hands the seat over on its way out. */
  cleanup: () => Promise<void>;
}

/**
 * A leader is exempt from `alive()` scrutiny for this long after its start
 * begins. `start()` awaits Telegram (setMyCommands x3) and the poll only
 * becomes observable once longPoll's first iteration stamps `lastPollAt` —
 * inside that window `alive()` legitimately answers false, and the first
 * watchdog to see it deposed the fresh leader and took the seat itself
 * (measured: five "toma el liderazgo" in one second, then five polls
 * fighting over one token, 2026-10-08). The grace must outlive a
 * pathological start — three hanging setMyCommands are 45s of timeout —
 * while staying in the same order as WEDGED_MS so a wedged start cannot
 * hold the seat much longer than a wedged holder. Tests shrink it through
 * TG_STARTUP_GRACE_MS.
 */
const STARTUP_GRACE_MS = Number(process.env.TG_STARTUP_GRACE_MS ?? 60_000);

const REGISTRY_KEY = Symbol.for("opencode-tg.registry");
const SEEN_KEY = Symbol.for("opencode-tg.seen");

interface SeenEvents {
  ids: Set<string>;
  order: string[];
  /** Event types the server already repeated, logged once each. */
  dupes: Set<string>;
}

function registry(): BridgeRegistry {
  const holder = globalThis as unknown as Record<PropertyKey, unknown>;
  let reg = holder[REGISTRY_KEY] as BridgeRegistry | undefined;
  if (!reg) {
    reg = { members: new Set(), memberModes: new WeakMap(), wrappers: new WeakMap() };
    holder[REGISTRY_KEY] = reg;
  }
  return reg;
}

function seenEvents(): SeenEvents {
  const holder = globalThis as unknown as Record<PropertyKey, unknown>;
  let seen = holder[SEEN_KEY] as SeenEvents | undefined;
  if (!seen) {
    seen = { ids: new Set(), order: [], dupes: new Set() };
    holder[SEEN_KEY] = seen;
  }
  return seen;
}

/**
 * Belt and braces for the leader: if the server itself repeats an event, or a
 * hand-over overlaps two leaders for a beat, the second copy is dropped
 * instead of being mirrored twice. Bounded — the oldest ids fall off.
 */
function firstSighting(event: { id?: unknown; type?: unknown }): boolean {
  const id = typeof event.id === "string" ? event.id : "";
  if (!id) return true;
  const seen = seenEvents();
  if (seen.ids.has(id)) {
    const type = str(event.type);
    if (type && !seen.dupes.has(type)) {
      seen.dupes.add(type);
      log("WARN", `evento duplicado del servidor: ${type} — ignorado`);
    }
    return false;
  }
  seen.ids.add(id);
  seen.order.push(id);
  if (seen.order.length > 5000) {
    for (const dropped of seen.order.splice(0, 1000)) seen.ids.delete(dropped);
  }
  return true;
}

export async function joinBridge(instance: BridgeInstance, mode: Mode): Promise<BridgeSeat> {
  const reg = registry();
  reg.members.add(instance);
  reg.memberModes.set(instance, mode);

  // The wrapper owns the start/stop lifecycle, because two registry races
  // lived in the old `started` flag (both measured in the 2026-10-08 storm):
  //
  // 1. A freshly installed leader answered alive() === false until start()
  //    resolved — it awaits setMyCommands — so any watchdog ticking in those
  //    seconds deposed it and took the seat, each waiter in turn: five
  //    "toma el liderazgo" in one second, then five polls on one token.
  //    "starting" now counts as alive within STARTUP_GRACE_MS.
  // 2. stop() during "starting" still aborts the transport: the abort fails
  //    the in-flight start, and the phase guard keeps that failure from
  //    marking a stopped instance "running".
  // Cleanup keeps its guarantee — stop what was started, even if ousted
  // since — because stop() proceeds from "starting" and "running" alike.
  type Phase = "idle" | "starting" | "running" | "stopped";
  let phase: Phase = "idle";
  let startedAt = 0;
  const guarded: BridgeInstance = {
    start: async () => {
      if (phase === "starting" || phase === "running") return;
      phase = "starting";
      startedAt = Date.now();
      try {
        await instance.start();
        if (phase === "starting") phase = "running";
      } catch (error) {
        if (phase === "starting") phase = "idle";
        throw error;
      }
    },
    stop: async () => {
      if (phase === "idle" || phase === "stopped") return;
      phase = "stopped";
      await instance.stop();
    },
    alive: () => {
      if (phase !== "starting" && phase !== "running") return false;
      // Within the grace a starting/running leader is presumed healthy: the
      // poll's first heartbeat only lands after start()'s awaits resolve.
      if (Date.now() - startedAt < STARTUP_GRACE_MS) return true;
      return phase === "running" && (instance.alive ? instance.alive() : true);
    },
  };
  // A hand-over must install the same object the registry compares leaders
  // against (`reg.leader === guarded`), so keep raw -> wrapper mapped.
  reg.wrappers.set(instance, guarded);

  // Live mode needs one bridge *across processes*, not just within this one:
  // the file lock is what keeps a second OpenCode from polling the same token.
  const needsLock = mode === "live";
  if (needsLock) ensureLockDir();

  // The leader was chosen by the FIRST instance to join, which read whatever
  // mode config.json had at that moment. If the file has been flipped since
  // (dry -> live after stopping the old bot), the sitting leader is driving
  // the wrong transport — a DryRunTelegram that can never reach Telegram, or
  // a live one that should stop touching the token. A newer instance with a
  // different mode takes over instead of idling behind the stale leader.
  if (reg.leader && reg.leaderMode !== undefined && reg.leaderMode !== mode) {
    log("INFO", `cambio de modo ${reg.leaderMode} -> ${mode}: relevando al líder`);
    const previous = reg.leader;
    reg.leader = undefined;
    reg.leaderMode = undefined;
    await previous.stop().catch((error) => log("ERROR", "stop del líder relevado", safe(error)));
  }

  // Only the leader may hold the cross-process lock — a waiting instance that
  // grabbed it would block the real leader in another process.
  const isLeading = !reg.leader && (!needsLock || acquireLock());
  if (isLeading) {
    reg.leader = guarded;
    reg.leaderMode = mode;
    try {
      await guarded.start();
    } catch (error) {
      reg.leader = undefined;
      reg.leaderMode = undefined;
      if (needsLock) releaseLock();
      throw error;
    }
  } else {
    const reason = reg.leader ? "líder en este proceso" : "líder en otro proceso";
    log("INFO", `instancia en espera (${reason}; ${reg.members.size} en el proceso)`);
  }

  /**
   * The watchdog EVERY instance runs, leader or waiter. Before this, only a
   * joining leader ever got a monitor: a leader installed by hand-off never
   * did, and when its poll hung mid-handler the lock heartbeat froze with
   * it — no waiting instance ever re-contested (they only tried once, at
   * join), and an "alive but silent" holder could not be replaced. The
   * bridge went silent for every process until a manual restart. One tick
   * per instance closes all three gaps: it watches WHOEVER holds the
   * registry seat (hand-off leaders included), replaces one whose poll
   * heartbeat froze, and re-contests a leaderless seat the lock says is
   * contestable. The tick is a returned closure rather than a wired timer
   * so tests can drive the exact interleavings that once produced the
   * storm without waiting on real clocks.
   */
  const tick = async (): Promise<void> => {
    const leader = reg.leader;
    if (leader === guarded) {
      // We lead: the file is the arbiter, not our own belief that we won,
      // and a frozen pollAlive means the loop is stuck inside one call or
      // one handler — make room rather than hold the seat while polling
      // nothing.
      const holder = lockHeldBy();
      if (needsLock && holder !== process.pid) {
        log("WARN", `lock perdido (lo tiene #${holder ?? "?"}) — este proceso deja de sondear`);
        reg.leader = undefined;
        reg.leaderMode = undefined;
        void guarded.stop().catch((error) => log("ERROR", "stop tras perder lock", safe(error)));
        return;
      }
      const alive = guarded.alive ? guarded.alive() : true;
      if (!alive) {
        log("WARN", "l\u00edder muerto: el stream o el poll se congel\u00f3; cediendo el asiento");
        reg.leader = undefined;
        reg.leaderMode = undefined;
        // Await the stop: the old leader's getUpdates socket takes a beat to
        // close after abort, and a replacement starting inside that window
        // collides with it at Telegram (HTTP 409 forever, measured).
        await guarded.stop().catch((error) => log("ERROR", "stop del l\u00edder muerto", safe(error)));
        // Hand the seat to a *different* live member: picking ourselves would
        // restart the same dead instance and loop forever. If there is none,
        // the seat stays open for any other process to contest below — and
        // this process's own waiters will keep watching. But only if it is
        // STILL empty: every waiter in this process watches the same dead
        // leader and contests the seat the moment it empties, so one of them
        // will already have taken it while the stop above was awaited.
        // Overwriting that winner here is how several instances each
        // believed they led (measured: five "toma el liderazgo" in one
        // second, then five polls fighting over one token).
        if (reg.leader !== undefined) return;
        const next = [...reg.members].find((member) => member !== instance);
        const wrapper = next ? reg.wrappers.get(next) : undefined;
        if (next && wrapper) {
          reg.leader = wrapper;
          reg.leaderMode = reg.memberModes.get(next);
          log("INFO", "traspaso de liderazgo a otra instancia");
          await wrapper.start().catch((error) => {
            if (reg.leader === wrapper) {
              reg.leader = undefined;
              reg.leaderMode = undefined;
            }
            log("ERROR", "traspaso", safe(error));
          });
          // The lock stays with this pid: the promoted member refreshes its
          // heartbeat on its own next tick. Releasing here would open a
          // window where another process grabs the lock mid-hand-off while
          // our own replacement is already starting to poll.
        } else if (needsLock) {
          releaseLock();
        }
        return;
      }
      if (needsLock) heartbeat();
      return;
    }
    if (leader) {
      // Another member of THIS process holds the seat. Its own watchdog may
      // be the piece that died — watch it: a leader nobody watches is how
      // the bridge went dark for good.
      const holder = lockHeldBy();
      if (needsLock && holder !== process.pid) {
        log("WARN", `lock en manos de #${holder ?? "?"} — el líder local cede el asiento`);
        reg.leader = undefined;
        reg.leaderMode = undefined;
        await leader.stop().catch((error) => log("ERROR", "stop del líder con lock ajeno", safe(error)));
      } else {
        const alive = leader.alive ? leader.alive() : true;
        if (alive) return;
        log("WARN", "líder local muerto — el asiento queda libre");
        reg.leader = undefined;
        reg.leaderMode = undefined;
        // Await the stop before the re-contest below: the old poll's socket
        // outlives its abort by a beat, and starting a replacement in the
        // same tick puts two getUpdates on one token — Telegram answers both
        // with HTTP 409 and the hand-over never converges (measured live).
        await leader.stop().catch((error) => log("ERROR", "stop del líder muerto", safe(error)));
      }
    }
    // The seat is empty and we are alive: contest it. Waiting instances
    // never re-tried before — a leaderless bridge stayed leaderless until a
    // restart. The lock decides: a fresh foreign holder keeps it, a dead or
    // wedged one does not (see leader.ts for the wedge margin). The seat is
    // re-checked HERE, at contest time: the read at the top of this tick is
    // stale by now — deposing a dead leader awaits its stop, and every
    // waiter that walked the same path resumes after that await believing
    // the seat is empty. Each one used to install itself right below, and
    // the file lock could not say no: it is per PID, so every instance of
    // THIS process "wins" it (measured 2026-10-08). This block is
    // synchronous, so check-and-set is atomic within the process — exactly
    // one waiter wins.
    if (!reg.leader && (!needsLock || acquireLock())) {
      reg.leader = guarded;
      reg.leaderMode = mode;
      log("INFO", `toma el liderazgo (pid ${process.pid})`);
      guarded.start().catch((error) => {
        if (reg.leader === guarded) {
          reg.leader = undefined;
          reg.leaderMode = undefined;
        }
        if (needsLock) releaseLock();
        log("ERROR", "toma de liderazgo", safe(error));
      });
    }
  };

  const cleanup = async (): Promise<void> => {
    reg.members.delete(instance);
    if (reg.leader === guarded) {
      reg.leader = undefined;
      reg.leaderMode = undefined;
      await guarded.stop();
      // A waiter may have won the seat while the stop above was awaited —
      // handing over on top of it installs a second leader. Act only if
      // the seat is still empty.
      if (reg.leader !== undefined) return;
      const next = [...reg.members].find((member) => member !== instance);
      const wrapper = next ? reg.wrappers.get(next) : undefined;
      if (next && wrapper) {
        reg.leader = wrapper;
        reg.leaderMode = reg.memberModes.get(next);
        log("INFO", "traspaso de liderazgo a otra instancia");
        try {
          await wrapper.start();
        } catch (error) {
          reg.leader = undefined;
          reg.leaderMode = undefined;
          // The failed heir holds nothing; give the lock back so another
          // process does not have to wait out the wedge margin for it.
          if (needsLock) releaseLock();
          log("ERROR", "traspaso", safe(error));
        }
        // The lock stays with this pid: the promoted member refreshes its
        // heartbeat on its own next tick. The old cleanup released it here,
        // opening a window where another process grabbed the lock
        // mid-hand-off while the promoted member was already polling.
      } else if (needsLock) {
        releaseLock();
      }
    } else {
      // Not the leader, but we may have started as one before being ousted —
      // shut our transport down rather than leaving a stray poller.
      await guarded.stop().catch((error) => log("ERROR", "stop de instancia relevada", safe(error)));
    }
  };

  return { tick, cleanup };
}

export default {
  id: "opencode-tg",

  async setup(ctx: Context) {
    const config = loadConfig();
    log("INFO", `setup mode=${config.mode} mirror=${config.mirror} allowed=${config.allowedUsers.length} debug=${config.debugEvents}`);

    if (config.mode === "off") return;
    if (!config.token) {
      log("ERROR", "no TELEGRAM_BOT_TOKEN \u2014 plugin disabled");
      return;
    }
    const chatId = config.allowedUsers[0];
    if (chatId === undefined && config.mode === "live") {
      log("ERROR", "ALLOWED_USERS is empty \u2014 nowhere to send");
      return;
    }

    // ── transport ────────────────────────────────────────────────────────────
    const dry = config.mode === "dry";
    const telegram: Telegram = dry
      ? new DryRunTelegram((kind, text) => log("INFO", `${kind.toUpperCase()} ${text}`))
      : new Telegram({
          token: config.token,
          // The last acknowledged update id lives next to the log so a
          // restart cannot replay anything. Without it, a `/sh` that kills
          // this process re-delivered forever (measured, 2026-10-07).
          offsetPath: join(homedir(), ".opencode", "tg", "offset.txt"),
        });

    // ── write side: prompts and permission answers ───────────────────────────
    // Mirroring is read-only by design; the ACP client is what lets the chat
    // push a prompt back into a session and approve/deny a tool call.
    const acp = new AcpClient();
    const pendingPermissions = new Map<string, { messageId?: number; options: RequestPermissionParams["options"] }>();
    /**
     * Armed confirmations for shell commands the guard flagged. `/sh` never
     * runs one directly: it stores the text here and sends a confirm card,
     * so a restart/stop only happens when the person taps the button — and
     * the persisted offset means even that tap cannot be re-delivered into a
     * loop if the command takes the server down.
     */
    const pendingSh = new Map<string, { command: string; target: string }>();

    acp.permissionHandler = async (params: RequestPermissionParams): Promise<PermissionOutcome> => {
      if (chatId === undefined) return { outcome: { outcome: "cancelled" } };
      const reqId = String(pendingPermissions.size + 1) + ":" + Date.now();
      const opts = params.options ?? [];
      const keyboard: Record<string, unknown> = {
        inline_keyboard: [opts.map((o, i) => ({ text: o.name, callback_data: `perm:${reqId}:${i}` }))],
      };
      const tool = params.toolCall?.title ?? "tool";
      const text = `\u{1F510} <b>${escapeHtml(tool)}</b>\n${escapeHtml(params.toolCall?.kind ?? "")}`.trimEnd();
      let messageId: number | undefined;
      try {
        // The handler is only installed when chatId is set; assert it here for
        // the type checker, which cannot see the guard through the closure.
        if (chatId === undefined) return { outcome: { outcome: "cancelled" } };
        const sent = await telegram.sendMessage(chatId, text, { parseMode: "HTML", replyMarkup: keyboard });
        messageId = sent ?? undefined;
      } catch (error) {
        log("ERROR", "acp: no se pudo pedir permiso", safe(error));
        return { outcome: { outcome: "cancelled" } };
      }
      pendingPermissions.set(reqId, { messageId, options: opts });
      // Resolve when a button tap lands; until then leave the request open.
      return new Promise<PermissionOutcome>((resolve) => {
        permissionResolvers.set(reqId, resolve);
      });
    };
    const permissionResolvers = new Map<string, (outcome: PermissionOutcome) => void>();

    // ── session bookkeeping ──────────────────────────────────────────────────
    const sessions = new Map<string, TrackedSession>();
    /**
     * Sessions with a `question` tool still open. A question is not a normal
     * turn: the agent is blocked waiting for the answer. Knowing it is open is
     * what lets the bridge say so instead of silently queueing a message that
     * will not be read until the question is gone.
     */
    const openQuestions = new Set<string>();
    /**
     * Tool-call ids behind the open questions. The renderer skips its own
     * pending card for them (the form card replaces it), so a nameless
     * progress tick must not upsert a phantom "tool" record either.
     */
    const questionToolIds = new Set<string>();
    /**
     * The /models picker's whole state — providers first, then the chosen
     * provider's models with their display names, mirroring the desktop
     * selector. The state rides on the message carrying its keyboard: a
     * callback only ever addresses the card it lives in, so two threads
     * can hold two pickers without one acting on the other's session
     * ("queue mezcla chats" was this class).
     */
    interface ModelPicker {
      target: string;
      /** The filtered catalogue; `mpk:` indexes are stable against it. */
      items: ApiModel[];
      providers: Array<{ id: string; name: string }>;
      /** The provider whose models are showing; undefined in the provider list. */
      chosen?: string;
      search: string;
      /** Wizard mode: picking sets the task's model instead of POSTing. */
      taskMode?: boolean;
    }
    /** One card per message, for every index-addressed picker. */
    const modelCards = new MessageCards<ModelPicker>();
    const agentCards = new MessageCards<{ target: string; items: ApiAgent[] }>();
    /** Projects behind a /projects or wizard card, freshest first. */
    const projectCards = new MessageCards<Array<{ directory: string; name: string; updated?: number }>>();
    /** A /queue card: its session and its items — a button addresses only
     *  the list it was drawn from, never another thread's inbox. */
    const inboxCards = new MessageCards<{ session: string; items: Array<{ id: string; text: string }> }>();
    /** /rename suggestions, bound to the message that offers them. */
    const suggestCards = new MessageCards<{ session: string; options: string[] }>();
    /** Armed by the edit button: the next message replaces that inbox item. */
    let inboxEdit: { id: string; text: string; session: string } | undefined;
    /**
     * The /queue card: one row per pending message with up/down reorder,
     * steer, cancel and replace — plus the "send in this order" button that
     * replays the arranged sequence into the running turn.
     */
    const renderInboxList = (
      card: { session: string; items: Array<{ id: string; text: string }> },
    ): { text: string; keyboard: Array<Array<{ text: string; callback_data: string }>> } => {
      const label = sessions.get(card.session)?.title ?? card.session.slice(0, 18);
      const lines = card.items.map((item, i) => `${i + 1}. ${escapeHtml(item.text.slice(0, 120))}`);
      const keyboard = card.items.map((_, i) => [
        ...(i > 0 ? [{ text: "\u2191", callback_data: `ib:up:${i}` }] : []),
        ...(i < card.items.length - 1 ? [{ text: "\u2193", callback_data: `ib:down:${i}` }] : []),
        { text: "\u25B6", callback_data: `ib:steer:${i}` },
        { text: "\u2716", callback_data: `ib:cancel:${i}` },
        { text: "\u270F\uFE0F", callback_data: `ib:edit:${i}` },
      ]);
      keyboard.push([{ text: t("btn_send_order"), callback_data: "ib:order:all" }]);
      return {
        text:
          `\u{1F4E5} <b>${escapeHtml(label)}</b> \u2014 ${card.items.length} en el inbox.\n` +
          `\u2191\u2193 reordena, \u25B6 adelanta, \u2716 cancela, \u270F\uFE0F reemplaza.\n${lines.join("\n")}`,
        keyboard,
      };
    };



    /**
     * The forms behind those questions, keyed by form id — the same object the
     * desktop client answers, so either side can settle it and `form.replied`
     * tells the loser what happened.
     */
    const openForms = new Map<string, OpenForm>();
    /** The /newtask wizard, one at a time; steps consume thread text.
     * TaskDraft (from the tasks module) doubles as its persisted mirror. */
    let taskWizard: TaskDraft | undefined;
    /** Skills behind the last /skills listing, for the invocation buttons. */
    let skillItems: Array<{ id: string; name: string }> = [];
    const turnImages = new Map<string, { since: number; paths: Set<string> }>();
    /** Grace timers: deliver captured images without waiting for the turn. */
    const turnImageTimers = new Map<string, ReturnType<typeof setTimeout>>();
    /**
     * Send whatever accumulated for a session and forget it. Shared by the
     * grace timer and `session.idle` — the idle-only send died with the
     * process every time the server was restarted mid-turn, which is how the
     * first generated-PNG test was lost.
     */
    const flushTurnImages = (sessionID: string): void => {
      const entry = turnImages.get(sessionID);
      turnImages.delete(sessionID);
      const timer = turnImageTimers.get(sessionID);
      if (timer) {
        clearTimeout(timer);
        turnImageTimers.delete(sessionID);
      }
      if (!entry || entry.paths.size === 0 || chatId === undefined || !isWatched(sessionID)) return;
      const chat = chatId;
      const found = selectImages([...entry.paths], entry.since);
      const threadId = threadOf(sessionID);
      void (async () => {
        let sent = 0;
        for (const img of found) {
          try {
            if (img.as === "photo") {
              await telegram.sendPhoto(chat, img.path, { messageThreadId: threadId });
              sent++;
            } else if (img.as === "text") {
              // Readable text (markdown, notes): read it so it can be read
              // in the chat itself — opening an attachment on the phone is
              // the worse path for a file the agent just wrote. Files under
              // TEXT_INLINE_LIMIT arrive complete, split on line boundaries
              // into numbered parts; bigger ones already ride as documents.
              const fs = await import("node:fs");
              const name = img.path.split(/[\\/]/).pop() ?? "archivo";
              const content = fs.readFileSync(img.path, "utf8");
              const parts: string[] = [];
              let current = "";
              for (const line of content.split("\n")) {
                if (current.length + line.length + 1 > 3400) {
                  parts.push(current);
                  current = line;
                } else {
                  current = current.length === 0 ? line : current + "\n" + line;
                }
              }
              if (current.length > 0) parts.push(current);
              for (const [index, part] of parts.entries()) {
                await send(
                  `\u{1F4C4} <b>${escapeHtml(name)}</b>${parts.length > 1 ? ` (${index + 1}/${parts.length})` : ""}\n<pre>${escapeHtml(part)}</pre>`,
                  sessionID,
                );
              }
              sent++;
            } else {
              await telegram.sendDocument(chat, img.path, { messageThreadId: threadId });
              sent++;
            }
          } catch (error) {
            log("WARN", "send generated image", safe(error));
          }
        }
        if (sent > 0) log("INFO", sent + " archivo(s) generado(s) enviados");
      })();
    };
    /**
     * Accumulate a file path the agent produced. The first capture of a
     * turn also arms the grace timer: deliver without waiting for the turn
     * to end, because "at idle" alone loses everything when the server is
     * restarted mid-turn.
     */
    const noteTurnImage = (sessionID: string, path: string): void => {
      let entry = turnImages.get(sessionID);
      if (!entry) {
        entry = { since: Date.now() - 60_000, paths: new Set() };
        turnImages.set(sessionID, entry);
        if (!turnImageTimers.has(sessionID)) {
          turnImageTimers.set(
            sessionID,
            setTimeout(() => {
              turnImageTimers.delete(sessionID);
              flushTurnImages(sessionID);
            }, 30_000),
          );
        }
      }
      entry.paths.add(path);
    };
    interface Coalesced { parts: string[]; timer: ReturnType<typeof setTimeout> | undefined }
    const coalescing = new Map<string, Coalesced>();
    const COALESCE_MS = config.coalesceMs;
    /** Burst window while busy: merges rapid follow-ups, still reaches /queue fast. */
    const COALESCE_BUSY_MS = config.coalesceBusyMs;
    /** Pending permission.asked requests, keyed by the server's real requestID. */
    const permissionRequests = new Map<string, { sessionID: string }>();
    /** Armed by a /skills tap: the next text becomes that skill's prompt. */
    let skillArmed: { id: string; name: string } | undefined;
    /** Armed by a /tasks "✏️ Prompt" tap: the next text in that thread becomes that task's new prompt. */
    let taskPromptEdit: { id: string; name: string; threadId: number | undefined; armedAt: number } | undefined;
    const watched = new Set<string>();
    /**
     * Subagent sessions under `"subagents": "off"` — ignored from the first
     * `session.created` (which carries the parentID) until the run ends.
     */
    const ignoredSubagents = new Set<string>();
    const mirrorAll = config.mirror === "all";
    // One Telegram thread per session. The resolver is a no-op (returns
    // undefined) until the store has a mapping, and schedules the topic
    // creation on first sight so it is ready by the next event.
    const topicStore = dry || chatId === undefined ? null : new TopicStore(chatId);
    const topicResolver =
      topicStore && chatId !== undefined
        ? new TopicResolver(
            topicStore,
            chatId,
            telegram,
            async (id: string) => {
              const tracked = sessions.get(id);
              // The live title first: the server knows the CURRENT name
              // (the desktop shows it); the tracked map and the disk json
              // are fallbacks for sessions this server does not hold.
              const live = await forms
                .request<ApiSession>("GET", "/session/" + encodeURIComponent(id))
                .then((info) => info?.title?.trim() ?? "")
                .catch(() => "");
              const base = live || tracked?.title || readSessionMeta(id)?.title || "";
              // A subagent's topic is born badged: the forum reads "child of
              // something" at a glance, exactly like the desktop's task view.
              return tracked?.parentID ? `\u{1F916} ${base}` : base;
            },
            () => {
              // Topics are unavailable for this bot: stop trying and keep the
              // chat as a single stream for the rest of the run.
              log("WARN", "topics: modo hilo no disponible — usando chat unico");
            },
          )
        : null;
    if (telegram instanceof Telegram && topicStore) {
      // A topic deleted on the phone (Telegram's own "delete thread") leaves
      // a stale mapping behind: the resolver would keep sending into a
      // grave forever. When the transport hits "message thread not found"
      // it calls this — the mapping goes, the archived flag survives (a
      // deleted window on an archived session must not resurrect it), and
      // the next event builds the fresh topic.
      telegram.onDeadThread = (_chatId, tid) => {
        const sid = topicStore.sessionOf(tid);
        if (sid === undefined) return;
        const wasArchived = topicStore.isArchived(sid);
        topicStore.remove(sid);
        if (wasArchived) topicStore.setArchived(sid, true);
        log("INFO", `hilo ${tid} borrado desde el teléfono — mapeo soltado, se recrea con el próximo evento (${sid.slice(0, 18)})`);
      };
    }
    /**
     * The live title beats every cached copy — this is the rename safety
     * net. `session.renamed` is the primary sync, but it only reaches the
     * pump of the process hosting the session WHILE the plugin watches: a
     * rename landing during a restart, a hung turn, or before the
     * subscription took is missed forever, and the topic wears its birth
     * name (measured: the desktop said "Bot Telegram" while the thread
     * still carried its September name). Throttled from track() — the hot
     * path stays cheap, and any active session heals within minutes.
     */
    const titleSyncAt = new Map<string, number>();
    const syncSessionTitle = async (sessionID: string): Promise<void> => {
      if (topicStore?.isArchived(sessionID) === true) return;
      try {
        const info = await forms.request<ApiSession>("GET", "/session/" + encodeURIComponent(sessionID));
        const fresh = info?.title?.trim();
        const session = sessions.get(sessionID);
        if (!fresh || !session || fresh === session.title) return;
        const old = session.title;
        session.title = fresh;
        const tid = topicStore?.get(sessionID);
        if (tid !== undefined && chatId !== undefined) {
          const name = session.parentID ? `\u{1F916} ${fresh}` : fresh;
          await telegram.editForumTopic(chatId, tid, name.slice(0, 128)).catch(() => undefined);
        }
        log("INFO", `t\u00edtulo sincronizado ("${old.slice(0, 24)}" \u2192 "${fresh.slice(0, 24)}"): ${sessionID.slice(0, 18)}`);
      } catch {
        /* not in this server (or the API is down): the event path and the
           next throttle window carry it */
      }
    };
    const track = (id: string): TrackedSession => {
      // A closed thread whose session woke up: reopen it and pick the
      // mirroring back up where it left off.
      if (topicStore?.isArchived(id) === true) {
        topicStore.setArchived(id, false);
        const tid = topicStore.get(id);
        if (chatId !== undefined && tid !== undefined) {
          void telegram
            .reopenForumTopic(chatId, tid)
            .then(() => log("INFO", "sesi\u00f3n revivida \u2014 hilo reabierto: " + id.slice(0, 18)))
            .catch((error) => {
              if (!/not a supergroup/i.test(String((error as Error)?.message ?? ""))) {
                log("WARN", "reopen", safe(error));
                return;
              }
              // Private chat: the archive DELETED the topic, so there is
              // nothing to reopen. Drop the mapping and let the resolver
              // build the window fresh on the next event — one straggler
              // in the root, then business as usual in the new thread.
              topicStore.remove(id);
              log("INFO", "sesi\u00f3n revivida \u2014 hilo se recrea con el pr\u00f3ximo evento: " + id.slice(0, 18));
            });
        }
      }
      let session = sessions.get(id);
      if (!session) {
        // Sessions that were already running when the server (re)started never
        // emit `session.created`/`session.renamed`, so their title is only on
        // disk. Read it once, at first sight; events still win afterwards.
        const meta = readSessionMeta(id);
        session = {
          id,
          title: meta?.title || "(sin t\u00edtulo)",
          directory: meta?.directory ?? "",
          lastSeen: 0,
          idle: false,
        };
        sessions.set(id, session);
      }
      session.lastSeen = Date.now();
      session.idle = false;
      // Rename drift check, throttled: one API probe per session per 5 min.
      if (!dry && (titleSyncAt.get(id) ?? 0) < Date.now() - 5 * 60_000) {
        titleSyncAt.set(id, Date.now());
        void syncSessionTitle(id);
      }
      return session;
    };
    /**
     * `mirror: "all"` means every session, full stop. Letting an empty
     * `watched` set override it made `/watch <id>` silently kill mirroring for
     * every *other* session, and `/watch off` look broken when it restored
     * `all` instead of nothing.
     */
    const isWatched = (id: string): boolean =>
      (mirrorAll ? watched.size === 0 || watched.has(id) : watched.has(id)) &&
      topicStore?.isArchived(id) !== true;
    const threadOf = (id: string | undefined): number | undefined =>
      id ? (isWatched(id) ? topicResolver?.get(id) : undefined) : undefined;

    /**
     * Archive a thread the way THIS chat can. In a supergroup forum that is
     * Telegram's own `close` (visible, read-only, reopenable). A private
     * chat cannot close topics (verified live: "the chat is not a
     * supergroup") but CAN delete them — so there, archive means what the
     * phone expects: the thread leaves the chat and the session stays
     * silent until /unarchive (or a revival) rebuilds the window.
     */
    const archiveThread = (tid: number): void => {
      if (chatId === undefined) return;
      void telegram.closeForumTopic(chatId, tid).catch((error) => {
        if (!/not a supergroup/i.test(String((error as Error)?.message ?? ""))) {
          log("WARN", "archive", safe(error));
          return;
        }
        telegram
          .deleteForumTopic(chatId, tid)
          .catch((delError) => log("WARN", "archive delete", safe(delError)));
      });
    };

    const renderer = new TurnRenderer(
      telegram, chatId ?? 0, config.render, isWatched,
      (error) => log("ERROR", "render", safe(error)),
      (id: string) => sessions.get(id)?.title ?? "",
      threadOf,
    );

    // ── commands ─────────────────────────────────────────────────────────────
    const send = async (text: string, session?: string): Promise<void> => {
      if (chatId === undefined) return;
      await telegram.sendMessage(chatId, text, {
        parseMode: "HTML",
        ...(session ? { messageThreadId: threadOf(session) } : {}),
      });
    };

    // ── typing indicator: the thread's "typing…" while a turn runs ───────────
    /**
     * A session grinding through a long turn shows nothing else in its thread
     * — the answer only lands when the turn ends. The indicator is the only
     * "I heard you and I'm on it" the phone gets in the meantime; without it,
     * every prompt sent mid-turn looked stuck ("queda colgado").
     */
    const TURN_START_EVENTS = new Set([
      "session.execution.started",
      "session.text.started",
      "session.reasoning.started",
      "session.tool.input.started",
      "session.tool.called",
    ]);
    const typingTimers = new Map<string, ReturnType<typeof setInterval>>();
    const startTyping = (sessionID: string): void => {
      if (typingTimers.has(sessionID) || dry || chatId === undefined) return;
      const chat = chatId;
      const threadId = threadOf(sessionID);
      if (threadId === undefined) return;
      // Telegram auto-expires the lamp after ~5s, so renew it on a shorter beat.
      const tick = (): void => {
        void telegram
          .call("sendChatAction", { chat_id: chat, action: "typing", message_thread_id: threadId })
          .catch(() => undefined);
      };
      tick();
      typingTimers.set(sessionID, setInterval(tick, 4000));
    };
    const stopTyping = (sessionID: string): void => {
      const timer = typingTimers.get(sessionID);
      if (timer) {
        clearInterval(timer);
        typingTimers.delete(sessionID);
      }
    };

    // ── forms: answering the agent's `question` from either side ─────────────
    /**
     * `question` opens a *form* and blocks the turn until somebody answers it;
     * the answer normally belongs to the desktop client, which is why a message
     * arriving during one used to be queued with "answer it on the PC". This
     * puts the same form in its session's Telegram thread as real buttons and
     * settles it over OpenCode's local API — so the PC and Telegram race for it
     * and `form.replied` tells the loser which side won.
     */
    const forms = new FormClient();

    /**
     * A session's project directory, restart-proof.
     *
     * The server only serves sessions it holds in memory: after a restart
     * every id-addressed endpoint 404s (verified live — GET info, prompt,
     * inbox, fork and context all answer SessionNotFound on an idle
     * session, and all go 200 the moment it is opened on the PC). The
     * plugin's own records survive restarts — the tracked map and the
     * session's <id>.json on disk — so directory questions never depend
     * on the server's mood.
     */
    const directoryOf = async (sessionID: string | undefined): Promise<string | undefined> => {
      if (!sessionID) return undefined;
      const info = await forms
        .request<ApiSession>("GET", "/session/" + encodeURIComponent(sessionID))
        .catch(() => undefined);
      return (
        info?.location?.directory ?? sessions.get(sessionID)?.directory ?? readSessionMeta(sessionID)?.directory
      );
    };

    /** True when the server answered "session not found" — after a restart
     *  that is every session not re-opened on the PC. */
    const isSessionNotFound = (error: unknown): boolean =>
      String((error as Error)?.message ?? "").includes("SessionNotFound");

    /** The one honest answer for id-addressed calls on an unloaded session. */
    const SESSION_UNLOADED = t("session_not_found_restart");

    /**
     * A session's model and agent, even when the server's payload forgets
     * them. Measured (the CJ31 ALV report): a session with 106K input
     * tokens answered GET /session with `model: undefined` and
     * `agent: undefined` — the fields are simply not tracked for some
     * sessions. The transcript always knows: the LAST assistant message
     * carries the model that produced it. Read-only and cheap when the
     * payload is healthy — the export is only fetched on the miss.
     */
    const sessionIdentityOf = async (
      sessionID: string,
      info: ApiSession | undefined,
    ): Promise<{ model?: { id?: string; providerID?: string }; agent?: string } | undefined> => {
      if (info?.model?.id) return { model: info.model, agent: info.agent };
      const exported = await forms
        .request<{ messages?: Array<{ type?: string; model?: { id?: string; providerID?: string }; agent?: string }> }>(
          "GET",
          "/api/experimental/session/" + encodeURIComponent(sessionID) + "/export",
        )
        .catch(() => undefined);
      const messages = Array.isArray(exported?.messages) ? exported.messages : [];
      for (let i = messages.length - 1; i >= 0; i--) {
        const m = messages[i];
        if (m.type === "assistant" && m.model?.id) {
          return { model: m.model, agent: info?.agent ?? m.agent };
        }
      }
      return info ? { model: info.model, agent: info.agent } : undefined;
    };

    /**
     * Rename a session everywhere at once: server title, tracked title,
     * forum topic. Returns an error message, or undefined on success —
     * shared by /rename and the suggestion picker so both paths behave
     * identically.
     */
    const applyRename = async (target: string, clean: string): Promise<string | undefined> => {
      const tracked = sessions.get(target);
      try {
        await forms.request("PATCH", "/session/" + encodeURIComponent(target), { title: clean });
        if (tracked) tracked.title = clean;
        const tid = topicStore?.get(target);
        if (tid !== undefined && chatId !== undefined) {
          const name = tracked?.parentID ? `\u{1F916} ${clean}` : clean;
          await telegram.editForumTopic(chatId, tid, name).catch(() => undefined);
        }
        return undefined;
      } catch (error) {
        log("WARN", "rename", safe(error));
        if (isSessionNotFound(error)) return SESSION_UNLOADED + "\n(Renombrar necesita la sesi\u00f3n activa en el server.)";
        return "No se pudo renombrar: " + escapeHtml(String((error as Error).message).slice(0, 200));
      }
    };

    /** The form waiting on this session, if any. */
    const openFormFor = (sessionID: string): OpenForm | undefined => {
      for (const form of openForms.values()) {
        if (form.sessionID === sessionID && !form.settled) return form;
      }
      return undefined;
    };

    /**
     * /ls — one directory of the session's project as a tappable listing.
     * Directories navigate, files download, 📎 arms a file as the next
     * prompt's attachment. The rel key rides the callback after the
     * prefix, so a ':' inside a filename shifts the parse — the callbacks
     * split on the FIRST ':' only and paths with ':' are rare enough.
     */
    const pendingAttach = new Map<string, { uri: string; name: string }>();
    /**
     * /ls keyboard keys. Telegram's callback_data caps at 64 bytes — a deep
     * path ("lsfile:project/src/components/Navbar.tsx") blows the limit and
     * Telegram rejects the WHOLE message with BUTTON_DATA_INVALID, which is
     * why subfolders never appeared. Keys are cheap: the path lives here,
     * the button only carries a short base-36 index. Old listings beyond
     * the cap answer "re-abre /ls" — a keyboard is cheap to redraw.
     */
    const lsKeys = new Map<string, string>();
    let lsKeySeq = 0;
    const lsKeyOf = (rel: string): string => {
      const key = (++lsKeySeq).toString(36);
      lsKeys.set(key, rel);
      if (lsKeys.size > 500) {
        for (const k of [...lsKeys.keys()].slice(0, 250)) lsKeys.delete(k);
      }
      return key;
    };
    const browseDirectory = async (sessionID: string, directory: string, rel: string): Promise<void> => {
      if (chatId === undefined) return;
      const full = safeResolve(directory, rel);
      if (!full) {
        await send(t("bad_path"), sessionID);
        return;
      }
      const fs = await import("node:fs");
      let entries: Array<{ name: string; dir: boolean; size: number }>;
      try {
        entries = fs
          .readdirSync(full, { withFileTypes: true })
          .filter((e) => !LS_HIDDEN.has(e.name))
          .map((e) => ({ name: e.name, dir: e.isDirectory(), size: e.isFile() ? fs.statSync(join(full, e.name)).size : 0 }))
          .sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name) : a.dir ? -1 : 1));
      } catch {
        await send("No pude leer esa carpeta.", sessionID);
        return;
      }
      const shown = entries.slice(0, 30);
      const label = rel ? rel.replace(/\\/g, "/") : (directory.split(/[\\/]/).filter(Boolean).pop() ?? "proyecto");
      const lines = [
        `\u{1F4C2} <b>${escapeHtml(label)}</b> \u2014 ${entries.length} entradas${entries.length > 30 ? " (primeras 30)" : ""}`,
        "Carpeta para entrar \u00b7 archivo para descargar \u00b7 \u{1F4CE} lo adjunta al pr\u00f3ximo mensaje.",
      ];
      const cleanRel = rel.replace(/\\/g, "/");
      const rows: Array<Array<{ text: string; callback_data: string }>> = [];
      if (cleanRel) rows.push([{ text: t("btn_up"), callback_data: `lsg:${lsKeyOf(cleanRel.split("/").slice(0, -1).join("/"))}` }]);
      for (const entry of shown) {
        const child = cleanRel ? `${cleanRel}/${entry.name}` : entry.name;
        if (entry.dir) {
          rows.push([{ text: `\u{1F4C1} ${entry.name.slice(0, 50)}`, callback_data: `lsg:${lsKeyOf(child)}` }]);
        } else {
          rows.push([
            { text: `\u{1F4C4} ${entry.name.slice(0, 50)} (${fmtSize(entry.size)})`, callback_data: `lsd:${lsKeyOf(child)}` },
            { text: "\u{1F4CE}", callback_data: `lsa:${lsKeyOf(child)}` },
          ]);
        }
      }
      if (rows.length === 0) rows.push([{ text: t("btn_empty_folder"), callback_data: `lsg:${lsKeyOf(cleanRel)}` }]);
      await telegram
        .sendMessage(chatId, lines.join("\n"), {
          parseMode: "HTML",
          messageThreadId: threadOf(sessionID),
          replyMarkup: { inline_keyboard: rows },
        })
        .catch((error) => log("WARN", "ls send", safe(error)));
    };

    /** Replace the form's message with a receipt, and forget it. */
    const closeForm = async (entry: OpenForm, receipt: string): Promise<void> => {
      // A late `form.replied` can race the tap's own close; a second close
      // would double-edit the card — or worse, double-send the fallback.
      if (entry.settled) return;
      entry.settled = true;
      openForms.delete(entry.formID);
      if (chatId === undefined) return;
      const text = `${entry.body}\n${receipt}`;
      if (entry.messageId !== undefined) {
        // message_id alone identifies the message; the thread rides along for
        // nothing, so it stays out of the edit call.
        const edited = await telegram
          .editMessageText(chatId, entry.messageId, text, { parseMode: "HTML" })
          .catch((error) => {
            log("WARN", "form edit", safe(error));
            return false;
          });
        if (edited) return;
        log("WARN", `form edit falló para msg ${entry.messageId} — recibo como mensaje nuevo`);
      } else {
        log("WARN", `form ${entry.formID} sin messageId — recibo como mensaje nuevo`);
      }
      // A receipt the user never sees is a silent lie; a duplicate one is
      // just noise. Prefer noise.
      await telegram
        .sendMessage(chatId, text, { parseMode: "HTML", messageThreadId: entry.threadId })
        .catch((error) => log("WARN", "form receipt", safe(error)));
    };

    /** Hand the answer to OpenCode and turn the message into a receipt.
     * Returns what happened, so a callback tap can tell the user. */
    const settleForm = async (
      entry: OpenForm,
      answer: Record<string, string | string[]>,
      chosen: string,
    ): Promise<"ok" | "already" | "error" | "dry"> => {
      if (entry.settled) return "already";
      // Dry mode is read-only by contract: show what would happen, touch nothing.
      if (dry) {
        await closeForm(entry, `\u{1F4E4} (dry) responder\u00eda: <b>${escapeHtml(chosen)}</b>`);
        return "dry";
      }
      let outcome: "ok" | "already";
      try {
        outcome = await forms.reply(entry.sessionID, entry.formID, answer);
        log("INFO", `form reply ${entry.formID} → ${outcome} ("${chosen.slice(0, 60)}")`);
      } catch (error) {
        // Leave it open: the PC can still answer it, so a failed reply is not
        // the end of the question — it is a reason to say so plainly.
        log("ERROR", "form reply", safe(error));
        await send(`\u274C no se pudo responder: ${escapeHtml(String((error as Error).message).slice(0, 240))}`);
        return "error";
      }
      await closeForm(
        entry,
        outcome === "already"
          ? `\u{1FED1} Ya la hab\u00edan respondido en la PC.`
          : `\u2705 Respondido: <b>${escapeHtml(chosen)}</b>`,
      );
      return outcome;
    };

    /** Body + keyboard for a form: progress, answered picks, prefixes per question. */
    const renderFormBody = (entry: OpenForm): { body: string; rows: Array<Array<{ text: string; callback_data: string }>> } => {
      const multi = entry.choices.length > 1;
      const answered = entry.choices.filter((choice) => entry.answers[choice.fieldKey] !== undefined).length;
      const lines = [
        `\u2753 <b>${escapeHtml(entry.title)}</b>${multi ? ` (${answered}/${entry.choices.length})` : ""}`,
      ];
      const rows: Array<Array<{ text: string; callback_data: string }>> = [];
      entry.choices.forEach((choice, position) => {
        // Several questions in one form: each needs its own heading, otherwise
        // the first question's title would vanish behind the header.
        if (multi) {
          lines.push(""); // blank separator between questions
          lines.push(`<b>${escapeHtml(choice.title || `Pregunta ${position + 1}`)}</b>`);
        } else if (choice.title) {
          lines.push(escapeHtml(choice.title));
        }
        const chosenValue = entry.answers[choice.fieldKey];
        choice.options.forEach((option, index) => {
          const picked =
            chosenValue === option.value ||
            (Array.isArray(chosenValue) && chosenValue.includes(option.value));
          const detail = option.description ? ` \u2014 ${escapeHtml(option.description)}` : "";
          lines.push(`${index + 1}. ${picked ? "\u2713 " : ""}${escapeHtml(option.label)}${detail}`);
        });
        // The running answer rides under its question so the re-render (each
        // tap edits this very message) reads as progress, not noise.
        if (chosenValue !== undefined) {
          const shown = Array.isArray(chosenValue) ? chosenValue.join(", ") : String(chosenValue);
          lines.push(`\u2794 tu respuesta: ${escapeHtml(shown)}`);
        }
        // With several questions the buttons carry the question number, so
        // options from different questions cannot read as one flat list.
        const prefix = multi ? `${position + 1}: ` : "";
        rows.push(
          choice.options.map((option, index) => ({
            // The form id goes last so a stray ':' in it cannot shift the parse.
            // Telegram rejects an empty button label outright.
            text: (prefix + (option.label || option.value || `${index + 1}`)).slice(0, 64),
            callback_data: `form:${choice.fieldIndex}:${index}:${entry.formID}`,
          })),
        );
      });
      if (entry.choices.length === 0) {
        lines.push(`\u{1F4CC} Respondela desde la PC.`);
      } else if (entry.choices.length === 1) {
        lines.push(`\nToc\u00e1 una opci\u00f3n o mand\u00e1 el n\u00famero. Otra respuesta: <code>/txt tu texto</code>`);
        // The free-text door: one button, only for single-field questions —
        // with several fields a bare text would be a guess.
        rows.push([{ text: t("btn_other_answer"), callback_data: `formfree:${entry.formID}` }]);
      } else {
        lines.push(`\nToc\u00e1 una opci\u00f3n por pregunta \u2014 podes corregir mientras no est\u00e9 completa.`);
      }
      return { body: lines.join("\n"), rows };
    };

    /** Re-edit the form's message after each answer: progress, not a new card. */
    const rerenderForm = async (entry: OpenForm): Promise<void> => {
      const rendered = renderFormBody(entry);
      entry.body = rendered.body;
      if (chatId === undefined || entry.messageId === undefined) return;
      await telegram
        .editMessageText(chatId, entry.messageId, rendered.body, {
          parseMode: "HTML",
          ...(rendered.rows.length > 0 ? { replyMarkup: { inline_keyboard: rendered.rows } } : {}),
        })
        .catch((error) => log("WARN", "form rerender", safe(error)));
    };

    /** Post a form into its session's thread, one button per option. */
    const showForm = async (form: FormInfo): Promise<void> => {
      if (chatId === undefined) return;
      const choices = choicesOf(form);
      const entry: OpenForm = {
        formID: form.id,
        sessionID: form.sessionID,
        title: form.title || "Pregunta",
        choices,
        settled: false,
        body: "",
        answers: {},
      };
      openForms.set(form.id, entry);

      const rendered = renderFormBody(entry);
      const rows = rendered.rows;
      entry.body = rendered.body;

      try {
        const messageId = await telegram.sendMessage(chatId, entry.body, {
          parseMode: "HTML",
          messageThreadId: threadOf(form.sessionID),
          ...(rows.length > 0 ? { replyMarkup: { inline_keyboard: rows } } : {}),
        });
        entry.messageId = messageId ?? undefined;
        entry.threadId = threadOf(form.sessionID);
      } catch (error) {
        log("ERROR", "form send", safe(error));
      }
      log("INFO", `form ${form.id} en ${form.sessionID.slice(0, 18)} — ${choices.length} campo(s) con opciones, msg=${entry.messageId ?? "?"}`);
      // Background heads-up: the form lives in its session's thread, but the
      // user may be looking at any other one. One short line in General keeps
      // a question in another thread from sitting unseen.
      if (threadOf(form.sessionID) !== undefined && chatId !== undefined) {
        void telegram
          .sendMessage(chatId, `\u{1F4AC} <b>${escapeHtml(entry.title)}</b> tiene una pregunta pendiente \u2014 respondela en su hilo.`, {
            parseMode: "HTML",
          })
          .catch((error) => log("WARN", "form heads-up", safe(error)));
      }
    };

    /**
     * Hand one session's open form a free-text answer. False means "no
     * single-field form open here" and the caller says so in plain words.
     */
    const answerFreeForm = async (sessionID: string | undefined, text: string): Promise<boolean> => {
      const target = sessionID ?? targetSession();
      if (!target || !text.trim()) return false;
      const entry = openFormFor(target);
      // More than one field needs the buttons — a bare text would be a guess.
      if (!entry || entry.choices.length !== 1) return false;
      await settleForm(entry, answerFree(entry.choices[0], text), text.trim().slice(0, 80));
      return true;
    };

    /**
     * Interpret a typed message as the answer to this session's open form.
     * False means "not an answer" and it falls through to a normal prompt.
     */
    const answerFormFromText = async (sessionID: string | undefined, text: string): Promise<boolean> => {
      const target = sessionID ?? targetSession();
      if (!target) return false;
      const entry = openFormFor(target);
      // More than one field needs the buttons — a bare `1` would be a guess.
      if (!entry || entry.choices.length !== 1) return false;
      const choice = entry.choices[0];
      // `/txt <respuesta>` is an explicit free answer, even when the text
      // would otherwise read as a number.
      const forced = parseFreeCommand(text);
      if (forced) {
        await settleForm(entry, answerFree(choice, forced), forced.slice(0, 80));
        return true;
      }
      const picked = pickOption(choice, text);
      if (picked) {
        await settleForm(entry, answerFor(choice, picked), picked.label);
        return true;
      }
      // "Otra respuesta" was armed: the next words, whatever they are.
      if (entry.freeText) return answerFreeForm(target, text);
      return false;
    };

    /**
     * The three moments of a form. `created` opens it here; `replied` and
     * `cancelled` mean somebody — usually the desktop client — settled it
     * first, so the message becomes a receipt instead of staying clickable.
     */
    const handleFormEvent = async (type: string, data: Record<string, unknown>): Promise<void> => {
      const form = data.form as Partial<FormInfo> | undefined;
      if (type === "form.created") {
        if (!form?.id || !form.sessionID) return;
        log("INFO", `evento ${type} ${form.id}`);
        await showForm(form as FormInfo);
        return;
      }
      const formID = str(form?.id ?? data.id);
      const entry = formID ? openForms.get(formID) : undefined;
      // Already settled by a tap in this thread: the edit went out with it.
      if (!entry) return;
      if (type === "form.replied") {
        await closeForm(entry, `\u2705 Respondido en la PC: <b>${escapeHtml(formatAnswer(data.answer))}</b>`);
      } else if (type === "form.cancelled") {
        await closeForm(entry, `\u{1F6AB} Cancelado en la PC.`);
      }
    };

    /**
     * The session plain messages go to. Foreground is an explicit choice
     * (`/use <id>`) that sticks — without it the bridge would send to whatever
     * happened to be most active, and the chat would have no way to tell which
     * one that was.
     */
    let foreground: string | undefined;
    const targetSession = (): string | undefined => {
      if (foreground && sessions.has(foreground)) return foreground;
      const sorted = [...sessions.values()].sort((a, b) => b.lastSeen - a.lastSeen);
      return sorted[0]?.id;
    };
    const sending = new Set<string>();

    /**
     * The actual prompt push. The turn runs in THE server — the same one that
     * owns the session — so the desktop sees the message and the events flow
     * through the same bus the bridge mirrors. A busy session goes to the
     * server's own inbox (`delivery: "queue"`), which outlives restarts and
     * delivers itself the moment the turn ends — the previous in-memory queue
     * died with the process and leaned on an idle event that did not always
     * fire, which is why messages used to need a manual /flush.
     */
    /** Flush a session's coalescing buffer as a single prompt. */
    const flushCoalesced = (sessionID: string): void => {
      const buf = coalescing.get(sessionID);
      if (!buf) return;
      coalescing.delete(sessionID);
      if (buf.timer) clearTimeout(buf.timer);
      const merged = buf.parts.join("\n\n");
      // sendPrompt (not bare deliver) so the receipt lands in the session's
      // thread — deliver() without a thread sent them to the chat root, which
      // is why a queued prompt looked stuck: the confirmation was sitting in
      // General. It also restores the dry-mode veto and the open-question
      // pointer that direct deliver() skipped.
      if (merged.length > 0) void sendPrompt(merged, sessionID);
    };

    const deliver = async (
      text: string,
      target: string,
      files?: Array<{ uri: string; name: string }>,
      replyThread?: string,
      quiet = false,
      skills?: Array<{ id: string }>,
    ): Promise<void> => {
      if (chatId === undefined) return;
      // Subagent sessions are read-only from Telegram — the parent drives
      // their input, exactly like the desktop. A direct prompt here would
      // only pollute a task the parent owns.
      const parentCheck = sessions.get(target);
      if (parentCheck?.parentID) {
        const parent = sessions.get(parentCheck.parentID);
        await send(
          t("subagent_readonly") + (parent ? ` ${t("subagent_owner")} <b>${escapeHtml(parent.title)}</b>` : "") + " \u2014 " + t("subagent_advice"),
          replyThread,
        );
        return;
      }
      const key = `${target}:${text.slice(0, 40)}`;
      if (sending.has(key)) return;
      sending.add(key);
      const tracked = sessions.get(target);
      const label = tracked?.title ?? t("no_title");
      const queued = tracked !== undefined && !tracked.idle;
      if (!quiet) {
        await send(
          queued
            ? t("queued_notice", { label: escapeHtml(label) })
            : t("sending_prompt", { label: escapeHtml(label), id: target.slice(0, 18), text: escapeHtml(text.slice(0, 200)) }),
          replyThread,
        );
      }
      if (queued) log("INFO", "queue", `al inbox del server: ${target.slice(0, 18)}`);
      try {
        if (!(await forms.connect())) throw new Error("API local de OpenCode no disponible");
        const sent = await forms.request<{ id?: string; delivery?: string }>(
          "POST",
          `/session/${encodeURIComponent(target)}/prompt`,
          {
            text,
            ...(files && files.length > 0 ? { files } : {}),
            ...(skills && skills.length > 0 ? { skills } : {}),
            delivery: queued ? "queue" : "steer",
          },
        );
        if (!sent?.id) log("WARN", `prompt a ${target.slice(0, 18)} sin message id`);
      } catch (error) {
        log("ERROR", "prompt", safe(error));
        const raw = String((error as Error).message);
        // SessionNotFound is the unloaded-session state, verified live: the
        // server only holds sessions in memory and never reloads them from
        // disk — after a restart (or once the PC closes one) every
        // id-addressed call 404s until it is opened again. Saying so plainly
        // beats a cryptic 404 the user cannot act on.
        if (raw.includes("SessionNotFound")) {
          await send(t("session_not_found_restart"), replyThread);
        } else {
          await send(t("err_send_fail", { detail: escapeHtml(raw.slice(0, 300)) }), replyThread);
        }
      } finally {
        sending.delete(key);
      }
    };

    const sendPrompt = async (
      text: string,
      sessionId?: string,
      files?: Array<{ uri: string; name: string }>,
      skills?: Array<{ id: string }>,
    ): Promise<void> => {
      if (chatId === undefined) return;
      // Dry mode is read-only by contract: it must never reach the agent, even
      // by accident.
      if (dry) {
        await send(`\u{1F4E4} (dry) a <code>${escapeHtml((sessionId ?? targetSession() ?? "?").slice(0, 18))}\u2026</code>: ${escapeHtml(text.slice(0, 200))}`);
        return;
      }
      const target = sessionId ?? targetSession();
      if (!target) {
        await send(t("send_no_target"));
        return;
      }
      const tracked = sessions.get(target);
      // A `question` tool is open: the agent is blocked on a choice, and the
      // inbox will hold this message until the turn unblocks. Point at the
      // form instead of hiding where the answer goes.
      if (openQuestions.has(target)) {
        const pending = openFormFor(target);
        const answerable = pending !== undefined && pending.choices.length > 0;
        await send(
          t("pending_question_header", { label: escapeHtml(tracked?.title ?? target.slice(0, 18)) }) +
            (answerable ? t("pending_question_answerable") : t("pending_question_desktop")) +
            t("pending_question_queued"),
          sessionId,
        );
        await deliver(text, target, files, sessionId, true, skills);
        return;
      }
      await deliver(text, target, files, sessionId, false, skills);
    };
    /**
     * A Telegram photo (or image document) as a data: URI the prompt can
     * carry — the server inlines it into the turn, the same way the desktop
     * attaches an image. Photos come in several sizes; the last is the best.
     */
    const mediaOf = async (
      message: NonNullable<Update["message"]>,
    ): Promise<{ uri: string; name: string } | undefined> => {
      const best = message.photo?.[message.photo.length - 1]?.file_id;
      const imageDoc =
        message.document && (message.document.mime_type ?? "").startsWith("image/")
          ? message.document.file_id
          : undefined;
      const fileId = best ?? imageDoc;
      if (!fileId) return undefined;
      try {
        const file = await telegram.getFile(fileId);
        if (!file.file_path) return undefined;
        const buffer = await telegram.downloadFile(file.file_path);
        if (buffer.length > 10 * 1024 * 1024) {
          await send(t("photo_too_big", { name: escapeHtml(message.document?.file_name ?? t("photo_fallback_name")), n: (buffer.length / 1024 / 1024).toFixed(1) }));
          return undefined;
        }
        const mime = best ? "image/jpeg" : (message.document?.mime_type ?? "image/jpeg");
        return {
          uri: `data:${mime};base64,${buffer.toString("base64")}`,
          name: message.document?.file_name ?? "foto.jpg",
        };
      } catch (error) {
        log("WARN", "media", safe(error));
        await send(`\u26A0\uFE0F No pude descargar ${escapeHtml(message.document?.file_name ?? "la foto")}.`);
        return undefined;
      }
    };
    /**
     * The question for the wizard's current step, numbered and with the
     * progress so far — the same function serves a fresh step, a re-ask after
     * a bad answer, and the resume after a restart ate the live one.
     */
    const wizardAsk = async (thread?: string): Promise<void> => {
      const w = taskWizard;
      if (!w) return;
      const sofar = w.name ? "\u2705 <b>" + escapeHtml(w.name) + "</b>\n" : "";
      if (w.step === "name") {
        await send(t("wizard_step_name"), thread);
        return;
      }
      if (w.step === "prompt") {
        await send(sofar + t("wizard_step_prompt"), thread);
        return;
      }
      if (w.step === "detail") {
        const hint =
          w.scheduleType === "once" ? t("wizard_hint_once")
          : w.scheduleType === "daily" ? t("wizard_hint_daily")
          : w.scheduleType === "weekly" ? t("wizard_hint_weekly")
          : t("wizard_hint_every");
        await send(sofar + "(6/6) \u23F1 " + hint, thread);
        return;
      }
      if (w.step === "schedule") {
        if (!(await forms.connect())) {
          await send(t("wizard_api_down"), thread);
          return;
        }
        const projects = await forms.request<Array<{ canonical?: string; time?: { updated?: number } }>>("GET", "/project").catch(() => undefined);
        const projectList = (Array.isArray(projects) ? projects : [])
          .filter((p) => typeof p.canonical === "string" && existsSync(p.canonical as string))
          .sort((a, b) => (b.time?.updated ?? 0) - (a.time?.updated ?? 0))
          .slice(0, 12)
          .map((p) => ({
            directory: p.canonical as string,
            name: ((p.canonical as string).split(/[\\/]/).filter(Boolean).pop() ?? p.canonical) as string,
          }));
        if (chatId === undefined || projectList.length === 0) {
          await send(t("wizard_projects_fail"), thread);
          return;
        }
        const keyboard = projectList.map((p, i) => [{ text: p.name.slice(0, 64), callback_data: "task:proj:" + i }]);
        const sent = await telegram.sendMessage(chatId, sofar + t("wizard_ask_project"), {
          parseMode: "HTML",
          messageThreadId: threadOf(thread),
          replyMarkup: { inline_keyboard: keyboard },
        });
        if (sent !== null) projectCards.set(sent, projectList);
        return;
      }
      if (w.step === "model") {
        // The task runs unattended: the model must be one that answers, not
        // whatever the server defaults to (which may have no balance at all).
        if (chatId === undefined) return;
        if (!(await forms.connect())) {
          await send(t("wizard_api_down"), thread);
          return;
        }
        const current = thread
          ? await forms.request<ApiSession>("GET", "/session/" + encodeURIComponent(thread)).catch(() => undefined)
          : undefined;
        const cm = current?.model;
        const buttons: Array<Array<{ text: string; callback_data: string }>> = [];
        if (cm?.id && cm.providerID) {
          // Pre-load so "inherit" is one tap.
          w.model = { id: cm.id, providerID: cm.providerID };
          writeDraft(w);
          buttons.push([{ text: t("btn_inherit_model", { model: cm.id }).slice(0, 64), callback_data: "task:model:inherit" }]);
        }
        // Resolve the actual default for the TASK's directory — not the
        // server-wide fallback — so the label never lies about what runs.
        const taskDirDefault = w.directory
          ? await forms
              .request<ApiSession>("GET", "/model/default?location%5Bdirectory%5D=" + encodeURIComponent(w.directory))
              .then((r) => (r as unknown as { model?: { id?: string; providerID?: string } }).model)
              .catch(() => undefined)
          : undefined;
        if (taskDirDefault?.id && taskDirDefault.providerID) {
          w.model = { id: taskDirDefault.id, providerID: taskDirDefault.providerID };
          writeDraft(w);
          buttons.push([{ text: t("btn_dir_default", { dir: w.directoryName ?? t("fallback_project"), model: taskDirDefault.id }).slice(0, 64), callback_data: "task:model:default" }]);
        } else {
          buttons.push([{ text: t("btn_server_default"), callback_data: "task:model:default" }]);
        }
        buttons.push([{ text: t("btn_pick_selector"), callback_data: "task:model:pick" }]);
        await telegram.sendMessage(chatId, sofar + t("wizard_ask_model"), {
          parseMode: "HTML",
          messageThreadId: threadOf(thread),
          replyMarkup: { inline_keyboard: buttons },
        });
        return;
      }
      if (w.step === "type") {
        if (chatId === undefined) return;
        await telegram.sendMessage(chatId, sofar + t("wizard_ask_schedule"), {
          parseMode: "HTML",
          messageThreadId: threadOf(thread),
          replyMarkup: { inline_keyboard: [
            [{ text: t("btn_once"), callback_data: "task:stype:once" }, { text: t("btn_daily"), callback_data: "task:stype:daily" }],
            [{ text: t("btn_weekly"), callback_data: "task:stype:weekly" }, { text: t("btn_every_n"), callback_data: "task:stype:minutes" }],
          ] },
        });
        return;
      }
      // confirm: model included, next run calculated
      if (!w.schedule || !w.directory) {
        w.step = w.directory ? "detail" : "schedule";
        writeDraft(w);
        await wizardAsk(thread);
        return;
      }
      if (chatId === undefined) return;
      const when = fmtDateTime(nextRunOf(w.schedule));
      await telegram.sendMessage(
        chatId,
        t("wizard_confirm_title") +
          "\u{1F5D3} <b>" + escapeHtml(w.name) + "</b>\n" +
          "\u{1F4CB} " + escapeHtml(w.prompt.slice(0, 300)) + "\n" +
          "\u{1F4C1} " + escapeHtml(w.directoryName ?? w.directory) + "\n" +
          "\u{1F9F1} " + escapeHtml(w.model ? w.model.id : t("wizard_model_fallback")) + "\n" +
          t("wizard_next_at", { schedule: escapeHtml(formatSchedule(w.schedule)), when: escapeHtml(when) }),
        {
          parseMode: "HTML",
          messageThreadId: threadOf(thread),
          replyMarkup: { inline_keyboard: [[{ text: t("btn_save"), callback_data: "task:save" }, { text: t("btn_cancel"), callback_data: "task:cancel" }]] },
        },
      );
    };

    /** One wizard step consuming the text the user just wrote. */
    const wizardStep = async (text: string, thread?: string): Promise<void> => {
      const w = taskWizard;
      if (!w) return;
      if (w.step === "name") {
        w.name = text.slice(0, 80);
        w.step = "prompt";
        writeDraft(w);
        await wizardAsk(thread);
        return;
      }
      if (w.step === "prompt") {
        w.prompt = text.slice(0, 4000);
        w.step = "schedule";
        writeDraft(w);
        await wizardAsk(thread);
        return;
      }
      if (w.step === "detail") {
        const schedule = parseScheduleDetail(w.scheduleType ?? "minutes", text);
        if (!schedule) {
          await wizardAsk(thread);
          return;
        }
        w.schedule = schedule;
        w.step = "confirm";
        writeDraft(w);
        await wizardAsk(thread);
        return;
      }
      await send(t("wizard_waiting"), thread);
    };

    /** Fire a task now: open its session, prompt, and let the mirror stream. */
    const runTaskNow = async (task: Task): Promise<void> => {
      if (!existsSync(task.directory)) throw new Error("directorio inexistente: " + task.directory);
      if (!(await forms.connect())) throw new Error("API local no disponible");
      const created = await forms.request<{ id?: string }>("POST", "/session", {
        location: { directory: task.directory },
        title: "\u23F0 " + task.name,
        ...(task.model ? { model: { id: task.model.id, providerID: task.model.providerID } } : {}),
      });
      if (!created?.id) throw new Error("sin id de sesi\u00f3n");
      await forms.request("POST", "/session/" + encodeURIComponent(created.id) + "/prompt", { text: task.prompt });
    };

    /** The leader's 30-second tick: anything due fires once and reschedules. */
    const tickTasks = (): void => {
      const all = readTasks();
      let dirty = false;
      for (const t of all) {
        if (!t.enabled || t.nextRun > Date.now()) continue;
        // A task pointing at a directory that no longer exists (the workspace
        // moved, a repo was deleted) would open ghost sessions in a dead cwd:
        // disable it and say so, plainly.
        if (!existsSync(t.directory)) {
          t.enabled = false;
          t.lastStatus = "directorio inexistente: " + t.directory;
          dirty = true;
          log("WARN", "task deshabilitada por directorio inexistente: " + t.directory);
          continue;
        }
        t.lastRun = Date.now();
        t.nextRun = nextRunOf(t.schedule, Date.now() + 1000);
        if (t.schedule.type === "once") t.enabled = false;
        dirty = true;
        const id = t.id;
        runTaskNow(t)
          .then(() => {
            const tasks = readTasks();
            const x = tasks.find((y) => y.id === id);
            if (x) { x.lastStatus = "ok"; writeTasks(tasks); }
          })
          .catch((error) => {
            const tasks = readTasks();
            const x = tasks.find((y) => y.id === id);
            if (x) { x.lastStatus = String(error).slice(0, 200); writeTasks(tasks); }
          });
      }
      if (dirty) writeTasks(all);
    };

    /**
     * Idle sessions get their threads closed after archiveAfterDays —
     * Telegram's version of archiving: visible, read-only, and reopened by
     * the revival check in track() the moment the session wakes up.
     */
    const tickArchive = (): void => {
      const days = config.archiveAfterDays;
      if (days <= 0 || !topicStore || chatId === undefined) return;
      const cutoff = Date.now() - days * 86_400_000;
      for (const s of sessions.values()) {
        if (s.lastSeen === 0 || s.lastSeen > cutoff) continue;
        const tid = topicStore.get(s.id);
        if (tid === undefined || topicStore.isArchived(s.id)) continue;
        topicStore.setArchived(s.id, true);
        archiveThread(tid);
        log("INFO", "auto-archivada (" + days + "d sin actividad): " + s.id.slice(0, 18));
      }
    };

    let taskTimer: ReturnType<typeof setInterval> | undefined;
    const startTaskTimer = (): void => {
      if (taskTimer !== undefined) return;
      taskTimer = setInterval(() => {
        tickTasks();
        tickArchive();
      }, 30_000);
    };
    const stopTaskTimer = (): void => {
      if (taskTimer === undefined) return;
      clearInterval(taskTimer);
      taskTimer = undefined;
    };

    /** One page of the /models picker — shared by the command and its pagination. */
    const MODEL_PAGE_SIZE = 8;
    /** The provider list the picker opens with — the desktop selector's first step. */
    const modelProviderPage = (state: ModelPicker): { text: string; keyboard: Array<Array<{ text: string; callback_data: string }>> } => {
      const tracked = sessions.get(state.target);
      const keyboard = state.providers.map((p, i) => [
        { text: `${p.name} (${p.id})`.slice(0, 64), callback_data: `mpv:${i}` },
      ]);
      return {
        text:
          `\u{1F9F1} Modelo para <b>${escapeHtml(tracked?.title ?? state.target.slice(0, 18))}</b>\n` +
          `Eleg\u00ed un proveedor para ver sus modelos.`,
        keyboard,
      };
    };
    /** The chosen provider's models, display names first — like the selector. */
    const modelPickerPage = (
      state: ModelPicker,
      page: number,
    ): { text: string; keyboard: Array<Array<{ text: string; callback_data: string }>> } => {
      const scoped = state.items
        .map((m, idx) => ({ m, idx }))
        .filter(({ m }) => (state.chosen ? m.providerID === state.chosen : true));
      const pages = Math.max(1, Math.ceil(scoped.length / MODEL_PAGE_SIZE));
      const safe = Math.min(Math.max(0, page), pages - 1);
      const slice = scoped.slice(safe * MODEL_PAGE_SIZE, safe * MODEL_PAGE_SIZE + MODEL_PAGE_SIZE);
      const keyboard = slice.map(({ m, idx }) => [
        {
          // The display name is what the desktop selector shows; the id only
          // matters to the receipt.
          text: (m.name ?? m.id).slice(0, 64),
          callback_data: `mpk:${idx}`,
        },
      ]);
      const nav: Array<{ text: string; callback_data: string }> = [{ text: t("btn_providers"), callback_data: "mpb:0" }];
      if (safe > 0) nav.push({ text: "\u25C0", callback_data: `mp:${safe - 1}` });
      nav.push({ text: `${safe + 1}/${pages}`, callback_data: "mp:noop" });
      if (safe < pages - 1) nav.push({ text: "\u25B6", callback_data: `mp:${safe + 1}` });
      keyboard.push(nav);
      const tracked = sessions.get(state.target);
      const heading = state.chosen
        ? (state.providers.find((p) => p.id === state.chosen)?.name ?? state.chosen)
        : state.search
          ? `B\u00fasqueda: ${state.search}`
          : "Todos";
      return {
        text:
          `\u{1F9F1} Modelo para <b>${escapeHtml(tracked?.title ?? state.target.slice(0, 18))}</b>\n` +
          `<b>${escapeHtml(heading)}</b> \u2014 p\u00e1gina ${safe + 1} de ${pages}\n` +
          `Toc\u00e1 uno para cambiarlo (o <code>/models texto</code> para buscar otro).`,
        keyboard,
      };
    };

    /** The /agents picker — few enough to need no pagination. */
    const agentPickerPage = (
      card: { target: string; items: ApiAgent[] },
    ): { text: string; keyboard: Array<Array<{ text: string; callback_data: string }>> } => {
      const keyboard = card.items.map((a, i) => [
        { text: (a.name ?? a.id).slice(0, 64), callback_data: `ag:${i}` },
      ]);
      const tracked = sessions.get(card.target);
      return {
        text: `\u{1F916} Agente para <b>${escapeHtml(tracked?.title ?? card.target.slice(0, 18))}</b>\nToc\u00e1 uno para cambiarlo.`,
        keyboard,
      };
    };

    const commands = [
      { command: "help", description: "Show this help" },
      { command: "sessions", description: "Sessions seen by the server" },
      { command: "ls", description: "Browse project files: /ls [folder]" },
      { command: "find", description: "Search files by name: /find <text>" },
      { command: "git", description: "What the agent changed (git status + diff)" },
      { command: "revert", description: "Undo a session's last turn (confirm first)" },
      { command: "context", description: "Session tokens, cost and compactions" },
      { command: "worktree", description: "List/create git worktrees; open a session in one" },
      { command: "fork", description: "Fork a session to try ideas safely" },
      { command: "export", description: "Download a session's transcript as JSON" },
      { command: "config", description: "Project config: /config model <provider/model>" },
      { command: "use", description: "Where prompts go: /use <id>" },
      { command: "watch", description: "Watch a session: /watch <id|all|off>" },
      { command: "send", description: "Send a prompt: /send <id> <text>" },
      { command: "txt", description: "Free-text answer to the open question" },
      { command: "menu", description: "Command menu with buttons" },
      { command: "running", description: "Sessions running right now" },
      { command: "usage", description: "Tokens and cost of a session" },
      { command: "mcp", description: "MCP servers status" },
      { command: "models", description: "Change a session's model (active providers only)" },
      { command: "agents", description: "Change a session's agent" },
      { command: "projects", description: "Open a new session in a project" },
      { command: "tasks", description: "Scheduled tasks" },
      { command: "newtask", description: "Create a scheduled task" },
      { command: "new", description: "New session: /new <title?>" },
      { command: "skill", description: "Run a skill prompt: /skill <id> <text>" },
      { command: "archive", description: "Archive a session's thread (closes or removes it)" },
      { command: "unarchive", description: "Wake an archived session — rebuilds its thread" },
      { command: "delthread", description: "Delete a session\u0027s thread" },
      { command: "rebuild", description: "Wipe all threads & rebuild the forum clean" },
      { command: "rename", description: "Rename a session: /rename <title>" },
      { command: "sh", description: "Run a shell command inside the session" },
      { command: "note", description: "Leave a note in the transcript (agent asleep)" },
      { command: "instructions", description: "The session's persistent instructions" },
      { command: "perms", description: "Saved permissions: list, or /perms del <id>" },
      { command: "turns", description: "What the session's turns changed" },
      { command: "log", description: "A sample of the session's server log" },
      { command: "terminal", description: "Read-only look at the session's terminal" },
      { command: "detach", description: "Detach the chat root from its session" },
      { command: "move", description: "Move a session to another project" },
      { command: "commands", description: "List custom commands, or /commands run <text>" },
      { command: "compact", description: "Compact context: /compact <ses_id?>" },
      { command: "locale", description: "Switch the bot's language: /locale <es|en>" },
      { command: "usagestats", description: "Token/cost stats: /usagestats <days?>" },

      { command: "queue", description: "Show queued messages" },
      { command: "flush", description: "Send the queue now; /flush <text> steers" },
      { command: "clearqueue", description: "Drop queued messages" },
      { command: "history", description: "Recent messages: /history <ses_id?>" },
      { command: "kill", description: "Cancel a running turn" },
      { command: "skills", description: "Installed OpenCode skills" },
      { command: "status", description: "Bridge status" },
    ];

    /**
     * `threadSession` is the session whose thread the command was typed into.
     * Commands that target a session fall back to it, so `/send hola` inside a
     * thread needs no id at all.
     */
    const handleCommand = async (name: string, argument: string, threadSession?: string): Promise<void> => {
      // A reply belongs where the command was typed: the session's thread when
      // written there, the chat root when not. The switch talks through
      // `reply`, never bare `send`.
      const reply = (text: string): Promise<void> => send(text, threadSession);
      switch (name) {
        case "start":
        case "help": {
          // /help ? the brief list PLUS a menu: tap a command and get its
          // detailed section (what it does, syntax, examples, notes) from
          // docs/COMMANDS.md, the single source of truth.
          const sections = commandSections();
          if (sections.length === 0) {
            await reply(t("help_missing"));
            return;
          }
          const brief = sections.map((s) => `• <code>/${s.name}</code> — ${escapeHtml(s.brief.slice(0, 60))}`).join("\n");
          // One button per command, grouped under its category header.
          const keyboard: Array<Array<{ text: string; callback_data: string }>> = [];
          let lastCategory = "";
          for (const s of sections) {
            if (s.category !== lastCategory) {
              keyboard.push([{ text: s.category, callback_data: "help:_" }]);
              lastCategory = s.category;
            }
            keyboard.push([{ text: "/" + s.name, callback_data: "help:" + s.name }]);
          }
          if (chatId === undefined) return;
          await telegram.sendMessage(chatId, t("help_menu_header", { brief }), {
            parseMode: "HTML",
            messageThreadId: threadOf(threadSession),
            replyMarkup: { inline_keyboard: keyboard },
          });
          return;
        }

        case "txt": {
          if (!argument) {
            await reply(t("txt_usage"));
            return;
          }
          if (!(await answerFreeForm(threadSession, argument))) {
            await reply(t("txt_no_open"));
          }
          return;
        }

        case "menu": {
          if (chatId === undefined) return;
          const target = threadSession || targetSession();
          const tracked = target ? sessions.get(target) : undefined;
          await telegram.sendMessage(
            chatId,
            `\u2630 <b>opencode-tg</b>${tracked ? ` \u2014 hilo de <b>${escapeHtml(tracked.title.slice(0, 48))}</b>` : ""}`,
            {
              parseMode: "HTML",
              ...(threadSession ? { messageThreadId: threadOf(threadSession) } : {}),
              replyMarkup: {
                inline_keyboard: [
                  [
                    { text: "\u{1F9ED} Running", callback_data: "cmd:running" },
                    { text: t("btn_sessions"), callback_data: "cmd:sessions" },
                  ],
                  [
                    { text: t("btn_usage"), callback_data: "cmd:usage" },
                    { text: "\u{1F9EA} MCP", callback_data: "cmd:mcp" },
                  ],
                  [
                    { text: t("btn_agent"), callback_data: "cmd:agents" },
                    { text: t("btn_models"), callback_data: "cmd:models" },
                  ],
                  [
                    { text: "\u{1F6E0} Skills", callback_data: "cmd:skills" },
                    { text: t("btn_status"), callback_data: "cmd:status" },
                  ],
                  [{ text: t("btn_close"), callback_data: "menu:close" }],
                ],
              },
            },
          );
          return;
        }

        case "running": {
          // The REST signal DOES exist — found in the docs after probing
          // everything else first: GET /session/active is a map of sessionID
          // -> {type:"running"} carrying exactly the in-flight turns
          // (measured live: this session mid-turn is in the map, while a
          // loaded-but-idle parent is NOT — only its two working subagents
          // are). It survives restarts, which the event-driven map does
          // not: right after a reload the tracked map is empty while turns
          // keep running server-side. Merge both — the API map is the
          // source of truth, the tracked map contributes when the API
          // cannot answer and knows which sessions are subagents.
          const now = Date.now();
          const activeIds = new Set<string>();
          const identity = new Map<string, { title?: string; model?: string; agent?: string }>();
          if (await forms.connect()) {
            const active = await forms
              .request<Record<string, { type?: string }>>("GET", "/session/active")
              .catch(() => undefined);
            for (const id of Object.keys(active ?? {})) activeIds.add(id);
            const list = await forms.request<Array<ApiSession>>("GET", "/session").catch(() => undefined);
            for (const s of Array.isArray(list) ? list : []) {
              if (!s?.id) continue;
              const short = s.model?.id ? s.model.id.split("/").pop() : undefined;
              const model = short ? `${short}${s.model?.variant ? ` (${s.model.variant})` : ""}` : undefined;
              identity.set(s.id, { title: s.title, model, agent: s.agent });
            }
          }
          const merged = new Map<string, TrackedSession>();
          for (const s of sessions.values()) {
            if (!s.idle && now - s.lastSeen < 5 * 60_000) merged.set(s.id, s);
          }
          for (const id of activeIds) {
            if (!merged.has(id)) {
              const info = identity.get(id);
              merged.set(id, {
                id,
                title: info?.title ?? "",
                directory: "",
                lastSeen: now,
                idle: false,
              });
            }
          }
          // Subagents mirror in their own threads; the parent line sums them.
          const subs = [...merged.values()].filter((s) => s.parentID).length;
          const active = [...merged.values()]
            .filter((s) => !s.parentID)
            .sort((a, b) => b.lastSeen - a.lastSeen)
            .slice(0, 12);
          if (active.length === 0) {
            await reply(t("running_none"));
            return;
          }
          const lines = active.map((s) => {
            const meta = identity.get(s.id);
            const title = (s.title || meta?.title || "").trim() || t("running_unknown");
            const model = meta?.model ? ` · ${escapeHtml(meta.model)}` : "";
            const agent = meta?.agent && meta.agent !== "build" ? ` · ${escapeHtml(meta.agent)}` : "";
            const here = s.id === threadSession ? ` — <i>${t("running_here")}</i>` : "";
            return `• <b>${escapeHtml(title.slice(0, 64))}</b>${here}${model}${agent} — ${fmtAgo(s.lastSeen)} · <code>${s.id.slice(0, 18)}…</code>`;
          });
          const suffix = subs > 0 ? `\n${t("running_subagents", { n: subs })}` : "";
          await reply(`${t("running_header", { n: active.length })}\n${lines.join("\n")}${suffix}`);
          return;
        }

        case "usage": {
          const target = argument || threadSession || targetSession();
          if (!target) {
            await reply(t("usage_needs_session"));
            return;
          }
          if (!(await forms.connect())) {
            await reply(t("err_api_numbers"));
            return;
          }
          let info: ApiSession | undefined;
          try {
            info = await forms.request<ApiSession>("GET", `/session/${encodeURIComponent(target)}`);
          } catch (error) {
            await reply(
              isSessionNotFound(error)
                ? SESSION_UNLOADED
                : "No pude leer la sesi\u00f3n: " + escapeHtml(String((error as Error).message).slice(0, 150)),
            );
            return;
          }
          if (!info) {
            await reply(t("usage_not_found"));
            return;
          }
          const providers = await forms
            .request<Array<{ id?: string; name?: string }>>("GET", "/provider")
            .catch(() => undefined);
          const provName = new Map(
            (Array.isArray(providers) ? providers : [])
              .filter((p) => p.id !== undefined)
              .map((p) => [p.id as string, p.name ?? (p.id as string)]),
          );
          const tokens = info.tokens ?? {};
          const identity = (await sessionIdentityOf(target, info)) ?? { model: info.model, agent: info.agent };
          const modelLine = identity.model?.id
            ? `🧪 <b>${escapeHtml(identity.model.providerID ? (provName.get(identity.model.providerID) ?? identity.model.providerID) + " · " : "")}</b><code>${escapeHtml(identity.model.id)}</code>`
            : "🧪 aún sin turnos registrados";
          const lines = [
            `📊 <b>${escapeHtml(info.title ?? sessions.get(target)?.title ?? target.slice(0, 18))}</b>`,
            `${modelLine} · agente <code>${escapeHtml(identity.agent ?? "?")}</code>`,
            `🪙 ${fmtCost(info.cost ?? 0)} · 📥 ${fmtTokens(tokens.input ?? 0)} · 📤 ${fmtTokens(tokens.output ?? 0)} · 🧠 ${fmtTokens(tokens.reasoning ?? 0)} · ⚡ ${fmtTokens(tokens.cache?.read ?? 0)}`,
          ];
          if (info.time?.updated) lines.push(`\u{1F550} \u00daltima actividad ${fmtAgo(info.time.updated)}`);
          if (Array.isArray(providers) && providers.length > 0) {
            const names = providers
              .slice(0, 8)
              .map((p) => escapeHtml(p.name ?? p.id ?? "?"))
              .join(", ");
            lines.push(`\u{1F50C} ${names}${providers.length > 8 ? " \u2026" : ""}`);
          }
          await reply(lines.join("\n"));
          return;
        }

        case "mcp": {
          if (!(await forms.connect())) {
            await reply(t("api_down"));
            return;
          }
          // /mcp connect|disconnect <server> — the ops pair of the list
          // (verified: POST /experimental/mcp/{server}/connect|disconnect
          // with no body -> 204).
          const parts = argument.trim().split(/\s+/);
          const action = (parts[0] ?? "").toLowerCase();
          if (action === "connect" || action === "disconnect") {
            const name = parts.slice(1).join(" ");
            if (!name) {
              await reply(t("err_no_mcp_server", { action }));
              return;
            }
            try {
              await forms.request("POST", `/api/experimental/mcp/${encodeURIComponent(name)}/${action}`, {});
              await reply(
                `\u{1F50C} MCP ${action === "connect" ? "conectado" : "desconectado"}: <b>${escapeHtml(name)}</b>`,
              );
            } catch (error) {
              log("WARN", "mcp " + action, safe(error));
              await reply(
                t("mcp_action_fail", { action, detail: escapeHtml(String((error as Error).message).slice(0, 200)) }),
              );
            }
            return;
          }
          const servers = await forms.request<ApiMcpServer[]>("GET", "/mcp");
          if (!Array.isArray(servers) || servers.length === 0) {
            await reply(t("mcp_none"));
            return;
          }
          const connected = servers.filter((s) => s.status?.status === "connected").length;
          const lines = servers.slice(0, 40).map(
            (s) =>
              `${s.status?.status === "connected" ? "\u{1F7E2}" : "\u{1F534}"} <b>${escapeHtml(s.name)}</b>` +
              `${s.status?.status === "connected" ? "" : ` \u2014 ${escapeHtml(s.status?.status ?? "?")}`}`,
          );
          await reply(`\u{1F9EA} MCP \u2014 ${connected}/${servers.length} conectados\n${lines.join("\n")}`);
          return;
        }

        case "models":
        case "model": {
          const target = threadSession || targetSession();
          if (!target) {
            await reply(t("model_needs_session"));
            return;
          }
          if (!(await forms.connect())) {
            await reply(t("api_down"));
            return;
          }
          const [all, providers] = await Promise.all([
            forms.request<ApiModel[]>("GET", "/model"),
            forms.request<Array<{ id?: string; activation?: string; name?: string }>>("GET", "/provider"),
          ]);
          if (!Array.isArray(all) || all.length === 0) {
            await reply(t("model_none"));
            return;
          }
          // The picker mirrors the DESKTOP's own "Modelos" screen: the models
          // the user switched on there (drafts.sqlite, visibility "show").
          // The config file is the fallback when that state cannot be read —
          // a gateway-listed model neither source vouches for is a door that
          // may not even open with this account's key.
          const provNames = new Map(
            (Array.isArray(providers) ? providers : [])
              .filter((p) => p.id !== undefined)
              .map((p) => [p.id as string, p.name ?? (p.id as string)]),
          );
          const current = await forms
            .request<ApiSession>("GET", `/session/${encodeURIComponent(target)}`)
            .catch(() => undefined);
          // The curated lookup needs the directory; for an unloaded session
          // the API GET 404s — the plugin's own records know it anyway.
          const currentDirectory = current?.location?.directory ?? (await directoryOf(target));
          const curated = configProviders(currentDirectory ? [currentDirectory] : []);
          const enabledKeys = curated
            .map((p) => [p.id, p.models.filter((m) => !m.disabled)] as const)
            .filter(([, models]) => models.length > 0);
          const curatedNames = new Map<string, string | undefined>(
            curated.flatMap((p): Array<[string, string | undefined]> =>
              p.models.map((m) => [`${p.id}\u0000${m.key}`, m.name]),
            ),
          );
          const byProviderKey = new Map(
            (Array.isArray(all) ? all : []).map((x) => [`${x.providerID}\u0000${x.modelID ?? x.id}`, x]),
          );
          // Build the visible set: desktop toggles when readable, config
          // otherwise. Both worlds speak "providerID\u0000modelID".
          const showKeys = new Set<string>();
          const toggles = await desktopVisibleModels();
          if (toggles.length > 0) {
            for (const t of toggles) {
              if (t.visible) showKeys.add(`${t.providerID}\u0000${t.modelID}`);
            }
          } else {
            for (const [pid, models] of enabledKeys) {
              for (const m of models) showKeys.add(`${pid}\u0000${m.key}`);
            }
          }
          const items: ApiModel[] = [];
          for (const key of showKeys) {
            const known = byProviderKey.get(key);
            if (known) {
              items.push(known);
            } else {
              const [pid, modelID] = key.split("\u0000");
              if (!modelID) continue;
              items.push({
                id: `${pid}/${modelID}`,
                modelID,
                providerID: pid,
                name: curatedNames.get(key),
              });
            }
          }
          items.sort((a, b) => a.id.localeCompare(b.id));
          const provList = [...new Set(items.map((m) => m.providerID))]
            .map((pid) => ({ id: pid, name: provNames.get(pid) ?? pid }))
            .sort((a, b) => a.name.localeCompare(b.name));
          // Where the picker opens: the session's own provider by default,
          // a matching provider name when the argument is one, a model search
          // when it is not. The provider list is always one tap away.
          const home = current?.model?.providerID ?? "";
          const arg = argument.trim().toLowerCase();
          const matchedProvider = arg
            ? provList.find((p) => p.id.toLowerCase() === arg || p.name.toLowerCase().includes(arg))
            : undefined;
          const chosen = matchedProvider?.id ?? (arg ? undefined : home || undefined);
          const search = !matchedProvider && arg ? arg : "";
          if (items.length === 0) {
            await reply(t("models_nothing_enabled"));
            return;
          }
          const state: ModelPicker = { target, items, providers: provList, chosen, search };
          if (chatId === undefined) return;
          const chosenPage = chosen || search;
          const { text, keyboard } = chosenPage ? modelPickerPage(state, 0) : modelProviderPage(state);
          const sent = await telegram.sendMessage(chatId, text, {
            parseMode: "HTML",
            messageThreadId: threadOf(threadSession),
            replyMarkup: { inline_keyboard: keyboard },
          });
          if (sent !== null) modelCards.set(sent, state);
          return;
        }

        case "agents":
        case "agent": {
          const target = threadSession || targetSession();
          if (!target) {
            await reply(t("agent_needs_session"));
            return;
          }
          if (!(await forms.connect())) {
            await reply(t("api_down"));
            return;
          }
          const all = await forms.request<ApiAgent[]>("GET", "/agent");
          if (!Array.isArray(all) || all.length === 0) {
            await reply(t("agent_none"));
            return;
          }
          const card = { target, items: all.slice(0, 20) };
          if (chatId === undefined) return;
          const { text, keyboard } = agentPickerPage(card);
          const sent = await telegram.sendMessage(chatId, text, {
            parseMode: "HTML",
            messageThreadId: threadOf(threadSession),
            replyMarkup: { inline_keyboard: keyboard },
          });
          if (sent !== null) agentCards.set(sent, card);
          return;
        }

        case "status": {
          const mode: Mode = config.mode;
          await reply(
            [
              t("status_title", { mode }),
              t("status_mirror") + ` <code>${watched.size === 0 ? (mirrorAll ? "all" : "none") : [...watched].join(", ")}</code>`,
              foreground
                ? t("status_write_active", { id: foreground.slice(0, 18), title: escapeHtml(sessions.get(foreground)?.title ?? "") })
                : topicResolver && telegram.topicsEnabled()
                  ? t("status_write_thread")
                  : t("status_write_recent"),
              t("status_seen", { n: sessions.size }),
              `log: <code>~/.opencode/tg/logs/plugin.log</code>`,
            ].join("\n"),
          );
          return;
        }

        case "config": {
          // /config — the project's opencode.jsonc from the phone: read the
          // key facts, or /config model <provider/model> to change the
          // default every NEW session is born with.
          const target = threadSession || targetSession();
          if (!target) {
            await reply(t("err_in_thread_project"));
            return;
          }
          const directory = await directoryOf(target);
          if (!directory) {
            await reply(t("project_unseen"));
            return;
          }
          const sub = (argument.split(/\s+/)[0] ?? "").toLowerCase();
          const rest = argument.slice(sub.length).trim();
          if (sub === "model") {
            if (!rest) {
              await reply(t("config_needs_model"));
              return;
            }
            // Validate against the live catalogue: a typo would silently
            // break every new session in the project.
            const catalogue = await ctx.model.list().then((res) => res.data ?? []).catch(() => []);
            const hit = catalogue.find(
              (m) => `${m.providerID}/${m.modelID}` === rest || m.modelID === rest,
            );
            if (!hit) {
              await reply(`No encuentro <code>${escapeHtml(rest)}</code> en el cat\u00e1logo \u2014 mir\u00e1 <code>/models</code>`);
              return;
            }
            const full = `${hit.providerID}/${hit.modelID}`;
            let file = projectConfigFile(directory);
            let raw: string | undefined;
            if (file) {
              raw = (await import("node:fs")).readFileSync(file, "utf8");
            } else {
              // No project config yet: create the JSONC form.
              file = join(directory, "opencode.jsonc");
              raw = "{}";
            }
            if (!file || raw === undefined) {
              await reply(t("config_locate_fail"));
              return;
            }
            const edited = withDefaultModel(raw, full);
            if (!edited) {
              await reply(t("config_invalid"));
              return;
            }
            // Prove the edit still parses before it touches disk.
            const { stripJsonc } = await import("./src/config-models.js");
            try {
              JSON.parse(stripJsonc(edited));
            } catch {
              await reply(t("config_edit_invalid"));
              return;
            }
            const fs = await import("node:fs");
            fs.writeFileSync(file, edited, "utf8");
            // The location-reload endpoint (verified live: 204) makes the new
            // default reach new sessions right away — no server restart.
            let reloaded = false;
            try {
              await forms.request("POST", "/location/reload", {});
              reloaded = true;
            } catch (error) {
              log("WARN", "config reload", safe(error));
            }
            await reply(
              t("config_model_set", { model: escapeHtml(full) }) +
                (reloaded ? t("config_model_reloaded") : t("config_model_restart")),
            );
            return;
          }
          // Read view: the key facts of the project config.
          const file = projectConfigFile(directory);
          if (!file) {
            await reply(t("config_no_project_file"));
            return;
          }
          const { stripJsonc } = await import("./src/config-models.js");
          const parsed = (await import("node:fs")).readFileSync(file, "utf8");
          try {
            const cfg = JSON.parse(stripJsonc(parsed)) as Record<string, unknown>;
            const lines = [`\u{1F527} <b>Config del proyecto</b> \u00b7 <code>${escapeHtml((directory.split(/[\\/]/).filter(Boolean).pop() ?? directory))}</code>`];
            lines.push(`Modelo default: <code>${escapeHtml(typeof cfg.model === "string" ? cfg.model : "(ninguno \u2014 global)")}</code>`);
            if (cfg.agents && typeof cfg.agents === "object") lines.push(`Agents custom: ${Object.keys(cfg.agents as object).length}`);
            if (cfg.mcp && typeof cfg.mcp === "object" && "servers" in (cfg.mcp as object)) {
              lines.push(`MCP servers: ${Object.keys((cfg.mcp as Record<string, unknown>).servers as object).join(", ")}`);
            }
            if (Array.isArray(cfg.permissions)) lines.push(`Reglas de permiso: ${cfg.permissions.length}`);
            lines.push(`\nCambiar default: <code>/config model proveedor/modelo</code>`);
            await reply(lines.join("\n"));
          } catch {
            await reply(t("config_parse_fail"));
          }
          return;
        }

        case "ls": {
          // /ls — browse the project from the phone: see what the agent sees,
          // download files by tapping, attach one to the next prompt.
          const target = threadSession || targetSession();
          if (!target) {
            await reply(t("err_in_thread_project"));
            return;
          }
          const directory = await directoryOf(target);
          if (!directory) {
            await reply(t("project_unseen"));
            return;
          }
          await browseDirectory(target, directory, argument.trim());
          return;
        }

        case "git": {
          // /git — what the agent touched in the session's project: vcs status
          // with add/del lines, and the working diff one tap away.
          const target = threadSession || targetSession();
          if (!target) {
            await reply(t("err_in_thread_project"));
            return;
          }
          const directory = await directoryOf(target);
          if (!directory) {
            await reply(t("project_unseen"));
            return;
          }
          const status = await forms.request<Array<Record<string, unknown>>>(
            "GET",
            "/vcs/status?location%5Bdirectory%5D=" + encodeURIComponent(directory),
          ).catch(() => undefined);
          const rows = Array.isArray(status) ? status : [];
          if (rows.length === 0) {
            await reply(t("vcs_clean"));
            return;
          }
          const lines = [`\u{1F5C3} <b>Git \u00b7 cambios en el proyecto</b> \u2014 ${rows.length} archivo(s)`];
          for (const row of rows.slice(0, 25)) {
            const file = String(row.file ?? "?");
            const add = Number(row.additions ?? 0);
            const del = Number(row.deletions ?? 0);
            const mark = String(row.status ?? "") === "added" ? "+" : String(row.status ?? "") === "deleted" ? "\u2212" : "~";
            lines.push(`<code>${mark}</code> ${escapeHtml(file)} <b>+${add}</b> <i>\u2212${del}</i>`);
          }
          if (rows.length > 25) lines.push(`(\u2026y ${rows.length - 25} m\u00e1s)`);
          if (chatId !== undefined) {
            await telegram
              .sendMessage(chatId, lines.join("\n"), {
                parseMode: "HTML",
                messageThreadId: threadOf(threadSession),
                replyMarkup: { inline_keyboard: [[{ text: t("btn_view_diff"), callback_data: `gitdiff:${target}` }]] },
              })
              .catch((error) => log("WARN", "git send", safe(error)));
          }
          return;
        }

        case "revert": {
          // /revert — undo a session's last turn. The API commit is one call;
          // the inline confirmation is the plugin's, because undoing agent
          // work must never happen by accident.
          const target = argument.trim() || threadSession || targetSession();
          if (!target) {
            await reply(t("err_in_thread_revert"));
            return;
          }
          const tracked = sessions.get(target);
          if (chatId !== undefined) {
            await telegram
              .sendMessage(
                chatId,
                t("revert_card_title", { label: escapeHtml(tracked?.title ?? target.slice(0, 18)) }) +
                  t("revert_card_body"),
                {
                  parseMode: "HTML",
                  messageThreadId: threadOf(threadSession),
                  replyMarkup: {
                    inline_keyboard: [
                      [
                        { text: t("btn_undo"), callback_data: "revertok:" + target },
                        { text: t("btn_cancel"), callback_data: "revertno:" + target },
                      ],
                    ],
                  },
                },
              )
              .catch((error) => log("WARN", "revert send", safe(error)));
          }
          return;
        }

        case "find": {
          // /find <text> — fuzzy file search over the session's project; the
          // results are tappable and download like /ls rows.
          const query = argument.trim();
          const target = threadSession || targetSession();
          if (!query || !target) {
            await reply(t("find_needs"));
            return;
          }
          const directory = await directoryOf(target);
          if (!directory) {
            await reply(t("project_unseen"));
            return;
          }
          const found = await forms.request<Array<Record<string, unknown>>>(
            "GET",
            "/api/fs/find?location%5Bdirectory%5D=" + encodeURIComponent(directory) + "&query=" + encodeURIComponent(query),
          ).catch(() => undefined);
          const results = Array.isArray(found) ? found : [];
          if (results.length === 0) {
            await reply(`Nada con \u00ab${escapeHtml(query)}\u00bb en el proyecto.`);
            return;
          }
          const rows: Array<Array<{ text: string; callback_data: string }>> = [];
          for (const item of results.slice(0, 25)) {
            const p = String(item.path ?? "");
            if (!p) continue;
            rows.push([{ text: "\u{1F4C4} " + p.slice(0, 55), callback_data: "lsd:" + lsKeyOf(p) }]);
          }
          if (results.length > 25) rows.push([{ text: `(\u2026y ${results.length - 25} m\u00e1s)`, callback_data: "find:" + query }]);
          if (chatId !== undefined) {
            await telegram
              .sendMessage(chatId, t("find_results_header", { n: results.length, query: escapeHtml(query) }), {
                parseMode: "HTML",
                messageThreadId: threadOf(threadSession),
                replyMarkup: { inline_keyboard: rows },
              })
              .catch((error) => log("WARN", "find send", safe(error)));
          }
          return;
        }

        case "context": {
          // /context — the session's footprint: tokens, cost, model limit and
          // compaction history, so the phone can answer "is it time to /compact?".
          const target = argument.trim() || threadSession || targetSession();
          if (!target) {
            await reply(t("err_in_thread_context"));
            return;
          }
          let info: ApiSession | undefined;
          try {
            info = await forms.request<ApiSession>("GET", "/session/" + encodeURIComponent(target));
          } catch (error) {
            await reply(isSessionNotFound(error) ? SESSION_UNLOADED : t("find_not_found"));
            return;
          }
          if (!info) {
            await reply(t("find_not_found"));
            return;
          }
          const catalogue = await ctx.model.list().then((res) => res.data ?? []).catch(() => []);
          const identity = (await sessionIdentityOf(target, info)) ?? { model: info.model, agent: info.agent };
          const modelRef = identity.model;
          const modelHit = catalogue.find(
            (m) => m.providerID === modelRef?.providerID && m.modelID === modelRef?.id,
          );
          const limit = modelHit?.limit?.context;
          const compactions = await forms.request<Array<Record<string, unknown>>>(
            "GET",
            "/session/" + encodeURIComponent(target) + "/context",
          ).catch(() => undefined);
          const comps = Array.isArray(compactions) ? compactions : [];
          const lines = [
            `\u{1F4CA} <b>Contexto de la sesi\u00f3n</b>`,
            `Modelo: <code>${escapeHtml(modelRef?.providerID ?? "?")}/${escapeHtml(modelRef?.id ?? "?")}</code> (l\u00edmite: ${limit !== undefined ? fmtTokens(limit) : "?"})`,
          ];
          const toks = info.tokens;
          if (toks) {
            lines.push(
              `\u{1F4E5} Input acumulado: ${fmtTokens((toks.input ?? 0) + (toks.reasoning ?? 0) + (toks.cache?.read ?? 0))}` +
                ` \u00b7 \u{1F4E4} Output: ${fmtTokens(toks.output ?? 0)}`,
            );
          }
          if (info.cost !== undefined) lines.push(`\u{1FA99} Costo: ${fmtCost(info.cost)}`);
          lines.push(
            comps.length > 0
              ? `\u{1F4DC} Compactaciones: ${comps.length} (\u00faltima: ${escapeHtml(String(comps[comps.length - 1]?.reason ?? "?"))})`
              : `\u{1F4DC} Sin compactaciones a\u00fan.`,
          );
          if (comps.length > 0) {
            const summary = String(comps[comps.length - 1]?.summary ?? "").slice(0, 200);
            if (summary) lines.push(`\n<i>${escapeHtml(summary)}\u2026</i>`);
          }
          lines.push(`\n${limit !== undefined && toks !== undefined && (toks.input ?? 0) + (toks.cache?.read ?? 0) > limit * 0.5 ? "\u26A0\uFE0F Va denso \u2014 consider\u00e1 <code>/compact</code>." : ""}`);
          await reply(lines.filter((l) => l.length > 1).join("\n"));
          return;
        }

        case "worktree": {
          // /worktree — the project's git worktrees: switch the NEXT session
          // to one with a tap, or /worktree new <name> to carve a fresh one.
          const sub = (argument.split(/\s+/)[0] ?? "").toLowerCase();
          const target = threadSession || targetSession();
          if (!target) {
            await reply(t("err_in_thread_project"));
            return;
          }
          const directory = await directoryOf(target);
          if (!directory) {
            await reply(t("project_unseen"));
            return;
          }
          const projects = await forms.request<Array<Record<string, unknown>>>("GET", "/api/project").catch(() => undefined);
          const list = Array.isArray(projects) ? projects : [];
          const proj = list.find((p) => String(p.canonical ?? "").replace(/\\/g, "/") === directory.replace(/\\/g, "/"));
          // /api/worktree wants the 40-char projectID from /api/project —
          // the 39-char one inside the session 404s the endpoint.
          const projectID = proj ? String(proj.id) : "";
          if (!projectID) {
            await reply(t("project_not_on_server"));
            return;
          }
          const trees = await forms.request<Array<Record<string, unknown>>>(
            "GET",
            "/api/worktree?projectID=" + encodeURIComponent(projectID),
          ).catch(() => undefined);
          const rowsTrees = Array.isArray(trees) ? trees : [];
          if (sub === "new") {
            const name = argument.slice(3).trim();
            if (!name) {
              await reply(t("worktree_needs_name"));
              return;
            }
            try {
              await forms.request("POST", "/api/worktree", { projectID, name });
              await reply(t("worktree_created", { name: escapeHtml(name) }));
            } catch (error) {
              log("WARN", "worktree create", safe(error));
              await reply(t("err_generic", { action: "pudo crear el worktree", detail: escapeHtml(String((error as Error).message).slice(0, 200)) }));
            }
            return;
          }
          if (rowsTrees.length === 0) {
            await reply(t("worktrees_none"));
            return;
          }
          const rows: Array<Array<{ text: string; callback_data: string }>> = [];
          for (const tree of rowsTrees.slice(0, 20)) {
            const dir = String(tree.directory ?? "");
            if (!dir) continue;
            const name = dir.split(/[\\/]/).filter(Boolean).pop() ?? dir;
            rows.push([{ text: "\u{1F33F} " + name.slice(0, 50), callback_data: "wtnew:" + lsKeyOf(dir) }]);
          }
          if (chatId !== undefined) {
            await telegram
              .sendMessage(chatId, t("worktree_header", { n: rowsTrees.length }), {
                parseMode: "HTML",
                messageThreadId: threadOf(threadSession),
                replyMarkup: { inline_keyboard: rows },
              })
              .catch((error) => log("WARN", "worktree send", safe(error)));
          }
          return;
        }

        case "fork": {
          // /fork — a session's copy from its last message: try ideas without
          // dirtying the original.
          const target = argument.trim() || threadSession || targetSession();
          if (!target) {
            await reply(t("err_in_thread_fork"));
            return;
          }
          const tracked = sessions.get(target);
          try {
            const forked = await forms.request<{ id?: string }>("POST", "/session/" + encodeURIComponent(target) + "/fork", {});
            if (!forked?.id) throw new Error("sin id del fork");
            await reply(
              `\u{1F374} Fork de <b>${escapeHtml(tracked?.title ?? target.slice(0, 18))}</b> creado: <code>${forked.id.slice(0, 22)}\u2026</code>\nEscribile \u2014 su hilo se crea con el primer mensaje.`,
            );
          } catch (error) {
            log("WARN", "fork", safe(error));
            await reply(
              isSessionNotFound(error)
                ? SESSION_UNLOADED
                : "No se pudo forkear: " + escapeHtml(String((error as Error).message).slice(0, 200)),
            );
          }
          return;
        }

        case "export": {
          // /export — download a session's full transcript as JSON from the
          // phone. The server wraps {info, messages}; we ship it verbatim.
          const target = argument.trim() || threadSession || targetSession();
          if (!target) {
            await reply(t("err_in_thread_export"));
            return;
          }
          const tracked = sessions.get(target);
          if (chatId === undefined) return;
          await reply(t("export_working"));
          try {
            const exported = await forms.request<Record<string, unknown>>(
              "GET",
              "/api/experimental/session/" + encodeURIComponent(target) + "/export",
            );
            if (!exported) throw new Error("respuesta vac\u00eda del export");
            const text = JSON.stringify(exported, null, 2);
            if (text.length > 40 * 1024 * 1024) {
              await reply(t("export_too_big"));
              return;
            }
            const fs = await import("node:fs");
            const os = await import("node:os");
            const pathMod = await import("node:path");
            const safeName = (tracked?.title ?? target.slice(0, 18)).replace(/[^\w\u00c0-\u017f-]+/g, "_").slice(0, 40) || "sesion";
            const tmp = pathMod.join(os.tmpdir(), `tg-export-${safeName}-${Date.now()}.json`);
            fs.writeFileSync(tmp, text, "utf8");
            try {
              const thread = threadOf(threadSession);
              await telegram.sendDocument(chatId, tmp, {
                caption: `\u{1F4C2} ${escapeHtml(tracked?.title ?? target.slice(0, 18))} \u00b7 ${(text.length / 1024 / 1024).toFixed(1)} MB`,
                messageThreadId: thread,
              });
            } finally {
              fs.rmSync(tmp, { force: true });
            }
          } catch (error) {
            log("WARN", "export", safe(error));
            // The server only exports sessions it holds in memory — after a
            // restart (or once the PC closes one) the endpoint 404s until it
            // is opened again (verified live). The transcript on disk is the
            // same history either way, so the file IS the export here.
            try {
              const fs = await import("node:fs");
              const os = await import("node:os");
              const pathMod = await import("node:path");
              const legacy = pathMod.join(os.homedir(), ".local", "share", "opencode", "sessions", target + ".jsonl");
              if (existsSync(legacy)) {
                const size = fs.statSync(legacy).size;
                if (size > 40 * 1024 * 1024) {
                  await reply(t("export_legacy_too_big"));
                  return;
                }
                if (chatId !== undefined) {
                  await telegram
                    .sendDocument(chatId, legacy, {
                      caption: `\u{1F4C2} ${escapeHtml(tracked?.title ?? target.slice(0, 18))} \u00b7 transcript de disco \u00b7 ${(size / 1024 / 1024).toFixed(1)} MB`,
                      messageThreadId: threadOf(threadSession),
                    })
                    .catch((sendError) => log("WARN", "export legacy send", safe(sendError)));
                }
                return;
              }
            } catch (legacyError) {
              log("WARN", "export legacy", safe(legacyError));
            }
            await reply(
              isSessionNotFound(error)
                ? t("export_unloaded")
                : t("err_generic", { action: "exportar", detail: escapeHtml(String((error as Error).message).slice(0, 200)) }),
            );
          }
          return;
        }

        case "projects": {
          if (!(await forms.connect())) {
            await reply(t("api_down"));
            return;
          }
          const projects = await forms.request<
            Array<{ id?: string; canonical?: string; time?: { updated?: number; created?: number } }>
          >("GET", "/project");
          if (!Array.isArray(projects) || projects.length === 0) {
            await reply(t("projects_none"));
            return;
          }
          // Most recently touched first — that is the order the desktop
          // shows, and folders nobody opens are noise in a picker.
          const projectList = projects
            .filter((p) => typeof p.canonical === "string" && existsSync(p.canonical as string))
            .sort((a, b) => (b.time?.updated ?? b.time?.created ?? 0) - (a.time?.updated ?? a.time?.created ?? 0))
            .slice(0, 12)
            .map((p) => ({
              directory: p.canonical as string,
              name: ((p.canonical as string).split(/[\\/]/).filter(Boolean).pop() ?? p.canonical) as string,
              updated: p.time?.updated,
            }));
          if (chatId === undefined) return;
          const keyboard = projectList.map((p, i) => [
            {
              text: `${p.name}${p.updated ? ` \u00b7 ${fmtAgo(p.updated)}` : ""}`.slice(0, 64),
              callback_data: `proj:${i}`,
            },
          ]);
          const sent = await telegram.sendMessage(
            chatId,
            t("projects_pick_header"),
            { parseMode: "HTML", messageThreadId: threadOf(threadSession), replyMarkup: { inline_keyboard: keyboard } },
          );
          if (sent !== null) projectCards.set(sent, projectList);
          return;
        }
        case "sessions": {
          if (sessions.size === 0) {
            await reply(t("sessions_none_seen"));
            return;
          }
          const row = (session: TrackedSession): string => {
            const mark = foreground === session.id
              ? "\u{1F3AF}"
              : isWatched(session.id)
                ? "\u{1F4E1}"
                : session.idle
                  ? "\u{1F4A4}"
                  : "\u{1F7E2}";
            const title = session.title || "(sin t\u00edtulo)";
            const badge = session.parentID ? " \u{1F916} sub" : "";
            return `${mark} <code>${session.id.slice(0, 18)}\u2026</code> ${escapeHtml(title)}${badge}`;
          };
          const all = [...sessions.values()].sort((a, b) => b.lastSeen - a.lastSeen);
          const active = all.filter((session) => !session.idle).slice(0, 20).map(row);
          const dormant = all.filter((session) => session.idle).slice(0, 20).map(row);
          const parts = [t("sessions_header")];
          if (active.length > 0) parts.push(active.join("\n"));
          if (dormant.length > 0) {
            parts.push((active.length > 0 ? t("sessions_dormant_mid") : t("sessions_dormant_head")), dormant.join("\n"));
          }
          await reply(parts.join("\n"));
          return;
        }

        case "use": {
          // `/use` is the explicit counterpart to the mirror: it says where
          // prompts go, and watching the same session means the answers land
          // in the chat too.
          const arg = argument.trim().toLowerCase();
          const target = arg || threadSession || [...sessions.values()].sort((a, b) => b.lastSeen - a.lastSeen)[0]?.id || "";
          if (!target) {
            await reply(t("use_needs"));
            return;
          }
          foreground = target;
          watched.add(target);
          track(target);
          const label = sessions.get(target)?.title ?? "(sin t\u00edtulo)";
          await reply(`\u{1F3AF} Escribo a <b>${escapeHtml(label)}</b> <code>${target.slice(0, 18)}\u2026</code>\nY vigilo sus novedades.`);
          return;
        }

        case "watch": {
          const arg = argument.trim().toLowerCase();
          if (arg === "all") {
            watched.clear();
            await reply(t("mirror_all_on"));
            return;
          }
          if (arg === "off" || arg === "none") {
            watched.clear();
            // In `all` mode an empty set means "everything", not "nothing" —
            // so say plainly that nothing is being mirrored.
            await reply(mirrorAll ? t("mirror_off_all") : t("mirror_off"));
            return;
          }
          const target = arg || [...sessions.values()].sort((a, b) => b.lastSeen - a.lastSeen)[0]?.id || "";
          if (!target) {
            await reply(t("watch_needs"));
            return;
          }
          watched.add(target);
          track(target);
          // In `all` mode one /watch silences EVERY other session — the 2026-10
          // debugging lost half a day to this being invisible. Say it plainly.
          await reply(
            mirrorAll
              ? `Vigilando <code>${escapeHtml(target)}</code>.\n\u26A0\uFE0F Est\u00e1s en <code>mirror=all</code>: ahora SOLO esta sesi\u00f3n se espeja \u2014 las dem\u00e1s quedan mudas. <code>/watch off</code> restaura el espejo completo.`
              : `Vigilando <code>${escapeHtml(target)}</code>`,
          );
          return;
        }

        case "send": {
          const parts = argument.trim().split(/\s+/);
          const first = parts[0] ?? "";
          // `<id> <text>` when the first word looks like a session id,
          // otherwise the whole argument goes to the thread's session — or the
          // foreground one when typed at the chat root.
          const looksLikeId = /^ses_[a-z0-9]+$/i.test(first);
          const target = looksLikeId ? first : threadSession;
          const text = (looksLikeId ? parts.slice(1) : parts).join(" ").trim();
          if (!text) {
            await reply(t("send_needs"));
            return;
          }
          await sendPrompt(text, target);
          return;
        }

        case "queue": {
          const target = argument.trim() || threadSession || targetSession();
          if (!target) {
            await reply(t("queue_needs_session"));
            return;
          }
          if (!(await forms.connect())) {
            await reply(t("api_down"));
            return;
          }
          let inbox: Array<Record<string, unknown>> | undefined;
          try {
            inbox = await forms.request<Array<Record<string, unknown>>>(
              "GET",
              `/session/${encodeURIComponent(target)}/inbox`,
            );
          } catch (error) {
            await reply(isSessionNotFound(error) ? SESSION_UNLOADED : `No pude leer el inbox: ${escapeHtml(String((error as Error).message).slice(0, 150))}`);
            return;
          }
          const card = {
            session: target,
            items: (Array.isArray(inbox) ? inbox : []).map((item) => {
              const payload = item.payload as { text?: string } | undefined;
              // The inbox carries more than text now (verified in the API
              // schemas): synthetic messages, compactions and moves have
              // no text payload — label them instead of "(sin texto)".
              const itemType = String(item.type ?? "");
              const text =
                payload?.text ??
                (itemType === "synthetic"
                  ? "mensaje sintético"
                  : itemType === "compaction"
                    ? "compactación"
                    : itemType === "move"
                      ? "movimiento"
                      : "(sin texto)");
              return { id: String(item.id ?? ""), text };
            }),
          };
          if (card.items.length === 0) {
            await reply(t("inbox_empty"));
            return;
          }
          if (chatId === undefined) return;
          const { text, keyboard } = renderInboxList(card);
          // The card is BOUND to this message: its buttons address this
          // list and no other thread's, no matter what gets queued later.
          const sent = await telegram.sendMessage(chatId, text, {
            parseMode: "HTML",
            messageThreadId: threadOf(threadSession),
            replyMarkup: { inline_keyboard: keyboard },
          });
          if (sent !== null) inboxCards.set(sent, card);
          return;
        }
        case "flush": {
          const body = argument.trim();
          const session = threadSession || targetSession();
          if (!session) {
            await reply(t("flush_needs_session"));
            return;
          }
          if (!(await forms.connect())) {
            await reply(t("api_down"));
            return;
          }
          // First drain anything the busy coalescing buffer is still holding:
          // those messages never reached the server, so flushing the inbox
          // alone would miss them.
          for (const pending of [...coalescing.keys()]) flushCoalesced(pending);
          // Texto: steering directo — entra al turno en curso YA.
          if (body.length > 0) {
            // A subagent takes no direct prompts — the flush must not be the
            // back door around the deliver guard.
            const flushTarget = sessions.get(session);
            if (flushTarget?.parentID) {
              const parent = sessions.get(flushTarget.parentID);
              await reply(
                `\u{1F916} Ese es un subagente${parent ? ` de <b>${escapeHtml(parent.title)}</b>` : ""} \u2014 su tarea la maneja la sesi\u00f3n padre. No se inyect\u00f3 nada.`,
              );
              return;
            }
            try {
              const sent = await forms.request<{ id?: string }>(
                "POST",
                `/session/${encodeURIComponent(session)}/prompt`,
                { text: body, delivery: "steer" },
              );
              if (!sent?.id) throw new Error("sin message id");
              await reply(`\u25B6 Inyectado al turno en curso: ${escapeHtml(body.slice(0, 160))}`);
            } catch (error) {
              log("WARN", "flush steer", safe(error));
              await reply(`\u274C No se pudo inyectar: ${escapeHtml(String((error as Error).message).slice(0, 200))}`);
            }
            return;
          }
          // Sin texto: adelantar todo lo que el inbox retenga.
          let inbox: Array<Record<string, unknown>> | undefined;
          try {
            inbox = await forms.request<Array<Record<string, unknown>>>(
              "GET",
              `/session/${encodeURIComponent(session)}/inbox`,
            );
          } catch (error) {
            await reply(isSessionNotFound(error) ? SESSION_UNLOADED : `No pude leer el inbox: ${escapeHtml(String((error as Error).message).slice(0, 150))}`);
            return;
          }
          const items = Array.isArray(inbox) ? inbox : [];
          let moved = 0;
          for (const item of items) {
            const id = String(item.id ?? "");
            if (!id) continue;
            try {
               // Empty 204 is success for this PATCH — the item leaving the
               // inbox is the point, not the body.
               await forms.request(
                 "PATCH",
                 `/session/${encodeURIComponent(session)}/inbox/${encodeURIComponent(id)}`,
                 { delivery: "steer" },
               );
               moved += 1;
             } catch {
               // one stuck item does not stop the rest of the flush
             }
          }
          await reply(
            moved > 0
              ? `\u25B6 ${moved} mensaje(s) adelantado(s) al turno en curso.`
              : "\u{1F4E5} El inbox no retiene nada ahora \u2014 todo lo que mandaste ya est\u00e1 dentro del turno.",
          );
          return;
        }
        case "clearqueue": {
          const target = argument.trim() || threadSession || targetSession();
          if (!target) {
            await reply(t("clearqueue_needs_session"));
            return;
          }
          if (!(await forms.connect())) {
            await reply(t("api_down"));
            return;
          }
          let inbox: Array<Record<string, unknown>> | undefined;
          try {
            inbox = await forms.request<Array<Record<string, unknown>>>(
              "GET",
              `/session/${encodeURIComponent(target)}/inbox`,
            );
          } catch (error) {
            await reply(isSessionNotFound(error) ? SESSION_UNLOADED : `No pude leer el inbox: ${escapeHtml(String((error as Error).message).slice(0, 150))}`);
            return;
          }
          const items = Array.isArray(inbox) ? inbox : [];
          let cancelled = 0;
          for (const item of items) {
            const id = String(item.id ?? "");
            if (!id) continue;
            await forms
              .request("DELETE", `/session/${encodeURIComponent(target)}/inbox/${encodeURIComponent(id)}`)
              .catch(() => undefined);
            cancelled += 1;
          }
          await reply(t("inbox_cancelled", { n: cancelled }));
          return;
        }
        case "history": {
          const target = argument.trim() || threadSession || targetSession();
          if (!target) {
            await reply(t("history_needs_session"));
            return;
          }
          const label = sessions.get(target)?.title ?? target.slice(0, 18);
          // The API export first: newer sessions live only in the server's
          // memory, so the legacy .jsonl never appears for them — but while
          // the session is loaded, the export endpoint carries the whole
          // conversation (verified live).
          let entries: HistoryEntry[] = [];
          if (await forms.connect()) {
            const exported = await forms
              .request<Record<string, unknown>>(
                "GET",
                "/api/experimental/session/" + encodeURIComponent(target) + "/export",
              )
              .catch(() => undefined);
            if (exported) entries = entriesFromExport(exported, 16);
          }
          if (entries.length === 0) entries = readHistory(jsonlPath(target), 16);
          if (entries.length === 0) {
            await reply(t("history_no_access", { label: escapeHtml(label) }));
            return;
          }
          const ROLE_ICON: Record<HistoryEntry["role"], string> = {
            user: "\u{1F464}",
            assistant: "\u{1F916}",
            tool: "\u{1F527}",
          };
          const body = entries
            .map((e) => {
              const icon = e.tool ? "\u{1F527}" : ROLE_ICON[e.role];
              const text = e.text.slice(0, 180).replace(/\s+/g, " ");
              return `${icon} ${e.tool ? `<code>${escapeHtml(e.tool)}</code> ` : ""}${escapeHtml(text)}`;
            })
            .join("\n");
          await reply(`\u{1F4DC} <b>${escapeHtml(label)}</b> — \u00faltimos ${entries.length}\n${body}`);
          return;
        }

                case "kill": {
          const target = argument.trim() || threadSession || targetSession();
          if (!target) {
            await reply(t("kill_needs_session"));
            return;
          }
          const label = sessions.get(target)?.title ?? target.slice(0, 18);
          if (!(await forms.connect())) {
            await reply(t("api_down"));
            return;
          }
          // Interrupting through the server is the safe stop: it cancels the
          // session's turn wherever the server is running it, without taking
          // any process down.
          try {
            const result = await forms.request<{ interrupted?: boolean }>(
              "POST",
              `/session/${encodeURIComponent(target)}/interrupt`,
              {},
            );
            await reply(
              result?.interrupted
                ? `\u{1F6D1} Cancelado el turno de <b>${escapeHtml(label)}</b>.`
                : `\u{1F6D1} <b>${escapeHtml(label)}</b> no ten\u00eda turno corriendo.`,
            );
          } catch (error) {
            log("WARN", "kill", safe(error));
            await reply(
              isSessionNotFound(error)
                ? SESSION_UNLOADED + "\n(No est\u00e1 activa \u2014 no hay turno que cancelar.)"
                : `\u274C no se pudo cancelar: ${escapeHtml(String((error as Error).message).slice(0, 200))}`,
            );
          }
          return;
        }
        case "new": {
          // A new session in the CURRENT project — /projects is the picker
          // for jumping elsewhere; this is the one-tap everyday case.
          const target = threadSession || targetSession();
          if (!(await forms.connect())) {
            await reply(t("api_down"));
            return;
          }
          const directory = await directoryOf(target);
          if (!directory) {
            await reply(t("newtask_needs_project"));
            return;
          }
          try {
            // /new <título> — the session is born with the title; the forum
            // topic (created on the first message) carries it as its name.
            const title = argument.trim();
            const created = await forms.request<{ id?: string }>("POST", "/session", {
              location: { directory },
              ...(title ? { title: title.slice(0, 60) } : {}),
            });
            if (!created?.id) throw new Error("sin id de sesi\u00f3n");
            const short = (directory.split(/[\\/]/).filter(Boolean).pop() ?? directory) as string;
            await reply(
              t("new_session_done", { id: created.id.slice(0, 22), project: escapeHtml(short) }) +
                (title
                  ? "\n" + t("new_session_titled", { title: escapeHtml(title.slice(0, 60)) })
                  : "\n" + t("new_session_untitled_hint")) +
                "\n" +
                t("new_session_write_hint", { id: created.id }),
            );
          } catch (error) {
            log("WARN", "new session", safe(error));
            await reply(t("newtask_create_fail", { detail: escapeHtml(String((error as Error).message).slice(0, 200)) }));
          }
          return;
        }

        case "tasks": {
          const list = readTasks();
          if (list.length === 0) {
            await reply(t("tasks_none") + (readDraft() ? "\n" + t("tasks_draft_pending") : ""));
            return;
          }
          if (chatId === undefined) return;
          const lines = list.slice(0, 10).map((t) =>
            (t.enabled ? "\u{1F7E2}" : "\u26AA") + " <b>" + escapeHtml(t.name.slice(0, 40)) + "</b> \u2014 " + escapeHtml(formatSchedule(t.schedule)),
          );
          const keyboard = list.slice(0, 10).map((t) => [
            { text: (t.name.slice(0, 24)) + (t.enabled ? "" : " (off)"), callback_data: "task:view:" + t.id },
          ]);
          await telegram.sendMessage(chatId, t("tasks_list_header", { n: list.length }) + lines.join("\n"), {
            parseMode: "HTML",
            messageThreadId: threadOf(threadSession),
            replyMarkup: { inline_keyboard: keyboard },
          });
          return;
        }

        case "newtask": {
          // A half-built draft means a restart ate the live wizard mid-way;
          // picking up where it stood is the whole point of persisting it.
          const existing = readDraft();
          if (existing && existing.updatedAt > Date.now() - 24 * 3600_000) {
            taskWizard = existing;
            await reply(t("newtask_resume", { step: existing.step }));
            await wizardAsk(threadSession);
            return;
          }
          taskWizard = { step: "name", name: "", prompt: "", updatedAt: Date.now() };
          writeDraft(taskWizard);
          await wizardAsk(threadSession);
          return;
        }

        case "taskcancel": {
          taskWizard = undefined;
          clearDraft();
          await reply(t("newtask_cancelled"));
          return;
        }

                case "skill": {
          // /skill <id> <texto> — run a prompt with a skill explicitly
          // attached, the same way the desktop's input does when you pick one.
          const parts = argument.trim().split(/\s+/);
          const skillId = parts[0] ?? "";
          const text = parts.slice(1).join(" ");
          const target = threadSession || targetSession();
          if (!target) {
            await reply(t("skill_needs_session"));
            return;
          }
          if (!skillId || !text) {
            await reply(t("skill_usage"));
            return;
          }
          await sendPrompt(text, target, undefined, [{ id: skillId }]);
          return;
        }

        case "compact": {
          const target = argument.trim() || threadSession || targetSession();
          if (!target) { await reply(t("compact_needs_session")); return; }
          if (!(await forms.connect())) { await reply(t("api_down")); return; }
          try {
            await forms.request("POST", "/session/" + encodeURIComponent(target) + "/compact", {});
            await reply(t("compact_done"));
          } catch (error) {
            log("WARN", "compact", safe(error));
            await reply(
              isSessionNotFound(error)
                ? SESSION_UNLOADED
                : t("err_generic", { action: "compactar", detail: escapeHtml(String((error as Error).message).slice(0, 200)) }),
            );
          }
          return;
        }

        case "locale": {
          // /locale — the bot's language, switched from the phone. The
          // catalog is the only source of strings; this only changes which
          // one t() reads, so every message after this moment comes in the
          // new language — no reload, and the receipt is IN that language:
          // the proof rides with the confirmation. The choice persists in
          // ~/.opencode/tg/locale.txt so a restart keeps it; TG_LOCALE in
          // .env is only the initial value now.
          const wanted = argument.trim().toLowerCase();
          const available = availableLocales();
          if (wanted) {
            if (!setLocale(wanted)) {
              await reply(t("locale_unknown", { wanted: escapeHtml(wanted), available: available.join(", ") }));
              return;
            }
            await reply(t("locale_switched", { locale: wanted }));
            return;
          }
          const current = locale();
          const keyboard = available.map((code) => [
            { text: `${NATIVE_NAMES[code] ?? code}${code === current ? " ✓" : ""}`, callback_data: "loc:" + code },
          ]);
          await telegram
            .sendMessage(chatId ?? 0, t("locale_current", { locale: current }), {
              parseMode: "HTML",
              replyMarkup: { inline_keyboard: keyboard },
            })
            .catch((error) => log("WARN", "locale card", safe(error)));
          return;
        }

        case "usagestats": {
          const days = Math.min(Math.max(Number(argument) || 7, 1), 90);
          if (!(await forms.connect())) { await reply(t("api_down")); return; }
          const to = Date.now();
          const from = to - days * 86_400_000;
          try {
            // Real contract (validated live against the server): the endpoint
            // is /experimental/session/stats — the old handler missed the
            // "experimental" prefix and the `data` wrapper, so every call
            // 404'd into "No pude leer las estad\u00edsticas". from/to are
            // milliseconds; tools=none keeps the payload small.
            const raw = await forms.request<Record<string, unknown>>(
              "GET",
              "/experimental/session/stats?from=" + from + "&to=" + to + "&tools=none",
            );
            // FormClient.call already unwraps the { data: ... } envelope the
            // OpenCode API wraps every payload in — the first version of this
            // unwrapped it twice and always landed on undefined, which read
            // as "(sin datos en el rango)".
            const d = raw as {
              sessions?: number;
              subagents?: number;
              prompts?: number;
              steps?: number;
              tokens?: { input?: number; output?: number; reasoning?: number; cache?: { read?: number; write?: number } };
              cost?: number;
              activeDays?: number;
              streak?: number;
            } | undefined;
            const lines = [t("stats_header", { n: days })];
            if (d) {
              lines.push(
                t("stats_line", { prompts: d.prompts ?? 0, sessions: d.sessions ?? 0, subagents: d.subagents ?? 0 }),
              );
              lines.push(t("stats_steps", { n: (d.steps ?? 0).toLocaleString("es-AR") }));
              if (d.tokens?.input !== undefined) lines.push(t("stats_input", { n: fmtTokens(d.tokens.input + (d.tokens.cache?.write ?? 0)) }));
              if (d.tokens?.output !== undefined) {
                lines.push(t("stats_output", { n: fmtTokens(d.tokens.output + (d.tokens.reasoning ?? 0)) }));
              }
              if (d.tokens?.cache?.read) lines.push(t("stats_cache", { n: fmtTokens(d.tokens.cache.read) }));
              if (d.cost !== undefined) lines.push(t("stats_cost", { n: fmtCost(d.cost) }));
              if (d.streak !== undefined) lines.push(t("stats_streak", { streak: d.streak, active: d.activeDays ?? 0, days }));
            } else lines.push(t("stats_no_data"));
            await reply(lines.join("\n"));
          } catch (error) {
            log("WARN", "usagestats", safe(error));
            await reply(t("stats_read_fail", { detail: escapeHtml(String((error as Error).message).slice(0, 200)) }));
          }
          return;
        }

        case "archive": {
          const target = argument.trim() || threadSession;
          if (!target || !topicStore || chatId === undefined) {
            await reply(t("archive_needs_thread"));
            return;
          }
          const tid = topicStore.get(target);
          if (tid === undefined) {
            await reply(t("no_thread"));
            return;
          }
          try {
            await telegram.closeForumTopic(chatId, tid);
            topicStore.setArchived(target, true);
            await reply(t("archived_done"));
          } catch (error) {
            log("WARN", "archive", safe(error));
            if (!/not a supergroup/i.test(String((error as Error)?.message ?? ""))) {
              await reply(t("archive_fail", { detail: escapeHtml(String((error as Error).message).slice(0, 200)) }));
              return;
            }
            // A private chat cannot close topics (verified live: "the chat
            // is not a supergroup") but CAN delete them — so archive here is
            // what the phone expects: the thread leaves the chat, the
            // session goes silent, and /unarchive rebuilds the window.
            topicStore.setArchived(target, true);
            await telegram.deleteForumTopic(chatId, tid).catch((delError) => log("WARN", "archive delete", safe(delError)));
            // The confirmation cannot ride the thread that just died — it
            // goes to the chat root.
            await send(t("archived_privately"));
          }
          return;
        }

        case "unarchive": {
          const target = argument.trim() || threadSession;
          if (!target || !topicStore || chatId === undefined) {
            await reply(t("unarchive_needs_thread"));
            return;
          }
          const tid = topicStore.get(target);
          if (tid === undefined) {
            await reply(t("no_thread"));
            return;
          }
          try {
            await telegram.reopenForumTopic(chatId, tid);
            topicStore.setArchived(target, false);
            await reply(t("unarchive_done"));
          } catch (error) {
            log("WARN", "unarchive", safe(error));
            topicStore.setArchived(target, false);
            const tracked = sessions.get(target);
            // The live title first — a woken thread must wear the name the
            // desktop shows, not the cached one.
            const live = await forms
              .request<ApiSession>("GET", "/session/" + encodeURIComponent(target))
              .then((info) => info?.title?.trim() ?? "")
              .catch(() => "");
            if (live && tracked && tracked.title !== live) tracked.title = live;
            const raw = (live || tracked?.title || target.slice(0, 18)).replace(/^📦 /, "");
            // If the old topic still lives (a forum archive, or the badge-only
            // one), dropping the badge is the whole wake-up — a rename that
            // lands proves the thread exists.
            const renamed = await telegram.editForumTopic(chatId, tid, raw.slice(0, 128)).then(() => true).catch(() => false);
            if (renamed) {
              await reply(t("unarchive_revived"));
              return;
            }
            // The topic is gone (deleted on the phone, or our private-chat
            // archive removed it): rebuild the window fresh, rebind the
            // mapping, and greet inside \u2014 the mirror continues there.
            const fresh = await telegram.createForumTopic(chatId, raw.slice(0, 128)).catch(() => undefined);
            if (fresh !== undefined) {
              topicStore.set(target, fresh);
              await telegram
                .sendMessage(chatId, t("unarchive_new_thread"), {
                  parseMode: "HTML",
                  messageThreadId: fresh,
                })
                .catch(() => undefined);
            } else {
              await reply(t("unarchive_revived_no_thread"));
            }
          }
          return;
        }

        case "delthread": {
          // Destructive on purpose and only on purpose: deletes the thread
          // from Telegram. The server session is untouched — only its window
          // into the chat goes away.
          const target = argument.trim() || threadSession;
          if (!target || !topicStore || chatId === undefined) {
            await reply(t("delthread_needs_thread"));
            return;
          }
          const tid = topicStore.get(target);
          if (tid === undefined) {
            await reply(t("no_thread"));
            return;
          }
          try {
            await telegram.deleteForumTopic(chatId, tid);
            topicStore.remove(target);
            await reply(t("delthread_done"));
          } catch (error) {
            log("WARN", "delthread", safe(error));
            await reply(t("delthread_fail"));
          }
          return;
        }

        case "rebuild": {
          // /rebuild — wipe every session thread and rebuild the forum
          // clean. The desktop's session list cannot be mirrored into
          // Telegram's order, and months of topics pile up stale; this is
          // the reset button. Every mapped thread goes, then the sessions
          // the server holds get fresh threads — oldest first so the most
          // recent ends at the top — and everything else rebuilds on its
          // next event (the resolver's whole job).
          if (!topicStore || chatId === undefined) {
            await reply(t("forum_only"));
            return;
          }
          const total = topicStore.entries().length;
          const win = config.rebuildIdleHours === 0 ? t("win_hours") : `${config.rebuildIdleHours}h`;
          await telegram
            .sendMessage(
              chatId,
              t("rebuild_card_title") +
                t("rebuild_card_body", { total, window: win }) +
                t("rebuild_card_foot"),
              {
                parseMode: "HTML",
                messageThreadId: threadOf(threadSession),
                replyMarkup: {
                  inline_keyboard: [
                    [
                      { text: t("btn_rebuild_yes"), callback_data: "rbld:ok" },
                      { text: t("btn_cancel"), callback_data: "rbld:no" },
                    ],
                  ],
                },
              },
            )
            .catch((error) => log("WARN", "rebuild ask", safe(error)));
          return;
        }

        case "rename": {
          // /rename <título> — rename a session from the phone (the
          // thread's own session, or /rename <ses_id> <título>). The
          // desktop's renames ride the same endpoint (verified live:
          // PATCH /session/{id} -> 204, the title follows), and its
          // `session.renamed` event would carry it here anyway — doing it
          // eagerly means the receipt is instant and the topic follows now.
          // Without a title, the one-shot generator reads the transcript
          // and proposes three tappables.
          const first = argument.trim().split(/\s+/)[0] ?? "";
          const looksLikeId = /^ses_[a-z0-9]+$/i.test(first);
          const target = looksLikeId ? first : threadSession || targetSession();
          const title = (looksLikeId ? argument.slice(first.length) : argument).trim();
          if (!target) {
            await reply(t("err_no_target"));
            return;
          }
          if (!(await forms.connect())) {
            await reply(t("api_down"));
            return;
          }
          // 128 is Telegram's topic-name ceiling; the server takes more,
          // but a title the thread cannot wear is half a rename.
          if (!title) {
            // Suggestions: the model must be explicit (verified: without
            // one the endpoint 400s) and cold-starts can outlast the
            // regular timeout — a raw call carries the long one.
            await reply(t("rename_suggesting"));
            try {
              const info = await forms.request<ApiSession>("GET", "/session/" + encodeURIComponent(target)).catch(() => undefined);
              const identity = await sessionIdentityOf(target, info);
              const modelRef = identity?.model;
              if (!modelRef?.id) throw new Error("sin modelo para la sesión");
              const exported = await forms
                .request<Record<string, unknown>>("GET", "/api/experimental/session/" + encodeURIComponent(target) + "/export")
                .catch(() => undefined);
              const recent = entriesFromExport(exported, 6)
                .map((e) => e.role + ": " + e.text.slice(0, 120))
                .join(" | ")
                .slice(0, 700);
              const raw = await forms.raw(
                "POST",
                "/api/experimental/generate",
                {
                  prompt:
                    `Una conversación se titula "${info?.title ?? identity?.model?.id ?? ""}". ` +
                    `Fragmentos recientes: ${recent || "(sin mensajes)"}.\n` +
                    "Proponé 3 títulos cortos (máximo 6 palabras cada uno) para esta conversación. " +
                    "Respondé SOLO los 3 títulos, uno por línea, sin numeración ni comillas.",
                  model: { id: modelRef.id, providerID: modelRef.providerID },
                },
                150_000,
              );
              const options = titleOptionsFrom(generateTextOf(raw));
              if (options.length === 0) throw new Error("sin sugerencias");
              const keyboard = options.map((o, i) => [{ text: o.slice(0, 60), callback_data: `rnme:${i}` }]);
              const sent = await telegram.sendMessage(chatId ?? 0, t("rename_pick_header"), {
                parseMode: "HTML",
                messageThreadId: threadOf(threadSession),
                replyMarkup: { inline_keyboard: keyboard },
              });
              if (sent !== null) suggestCards.set(sent, { session: target, options });
            } catch (error) {
              log("WARN", "rename suggest", safe(error));
              await reply(t("rename_suggest_fail"));
            }
            return;
          }
          const clean = title.slice(0, 128);
          const failure = await applyRename(target, clean);
          if (failure) await reply(failure);
          return;
        }

        case "sh": {
          // /sh <cmd> — run a shell command INSIDE the session (verified
          // live: POST /session/{id}/shell -> 204 async; the output lands
          // on a type:"shell" message with {command, status, exit,
          // output.output}). Background by contract — the agent is not
          // disturbed. On Windows the session's shell is PowerShell: `&&`
          // exits 1 (measured), the warning says so.
          const cmdText = argument.trim();
          const target = threadSession || targetSession();
          if (!cmdText) {
            await reply(t("err_no_cmd"));
            return;
          }
          if (!target) {
            await reply(t("err_no_sub_arg"));
            return;
          }
          // The guard: a command that can stop the OpenCode server or the
          // machine never runs on first sight. Forbidden ones never run at
          // all — no recovery from a formatted disk — and the rest wait for
          // a tap. Measured: `/sh opencode service restart` killed the host
          // mid-command, the unconfirmed update re-delivered on every
          // restart, and the bridge looped until it was disabled by hand.
          //
          // The project folder is the one place destruction is allowed
          // (`rm temp.txt` is a normal day), so it is passed in as scope.
          const projectDir = (await directoryOf(target)) ?? "";
          const danger = dangerousCommand(cmdText, projectDir);
          // One line per command it would run, alias-resolved and explained,
          // so the approval is about what the command does, not about a
          // string of text.
          const explained =
            danger.commands.length > 0
              ? t("sh_explained_header") +
                danger.commands
                  .map((c) => {
                    const shown = c.resolved ?? c.asWritten ?? c.raw;
                    const args = c.args.length ? " " + c.args.slice(0, 8).join(" ") : "";
                    return `<code>${escapeHtml((shown + args).slice(0, 200))}</code>\n${escapeHtml(explainCommand(c))}`;
                  })
                  .join("\n\n")
              : "";
          if (danger.level === "forbidden") {
            log("WARN", `sh bloqueado (prohibido): ${cmdText.slice(0, 80)}`);
            await reply(
              t("sh_blocked_title") +
                t("sh_blocked_body", { reason: escapeHtml(danger.reason) }) +
                explained +
                `\n\n<code>${escapeHtml(cmdText.slice(0, 300))}</code>\n\n` +
                t("sh_blocked_foot"),
            );
            return;
          }
          if (danger.level === "confirm") {
            const shId = "sh" + Date.now() + ":" + Math.random().toString(36).slice(2, 6);
            pendingSh.set(shId, { command: cmdText, target });
            if (chatId !== undefined) {
              const keyboard = [
                [
                  { text: t("btn_confirm_exec"), callback_data: `shok:${shId}` },
                  { text: t("btn_cancel"), callback_data: `shno:${shId}` },
                ],
              ];
              await telegram
                .sendMessage(
                  chatId,
                  t("sh_confirm_title", { reason: escapeHtml(danger.reason) }) +
                    t("sh_confirm_body") +
                    explained +
                    `\n\n<code>${escapeHtml(cmdText.slice(0, 400))}</code>`,
                  {
                    parseMode: "HTML",
                    messageThreadId: threadOf(threadSession),
                    replyMarkup: { inline_keyboard: keyboard },
                  },
                )
                .catch((error) => log("WARN", "sh confirm card", safe(error)));
            }
            return;
          }
          if (!(await forms.connect())) {
            await reply(t("api_down"));
            return;
          }
          try {
            await forms.request("POST", "/session/" + encodeURIComponent(target) + "/shell", { command: cmdText });
            await reply(
              t("sh_sent") + (cmdText.includes("&&") ? "\n\u26A0\uFE0F " + t("sh_ps_note") : ""),
            );
            const deadline = Date.now() + 45_000;
            let settled = false;
            while (Date.now() < deadline && !settled) {
              await new Promise((resolve) => setTimeout(resolve, 1500));
              const messages = await forms
                .request<Array<Record<string, unknown>>>("GET", "/session/" + encodeURIComponent(target) + "/message")
                .catch(() => undefined);
              const shells = (Array.isArray(messages) ? messages : []).filter((m) => m?.type === "shell");
              const last = shells[shells.length - 1];
              if (last && last.command === cmdText && (last.status === "exited" || last.status === "failed")) {
                settled = true;
                const output = String((last.output as { output?: unknown } | undefined)?.output ?? "");
                const exit = Number(last.exit ?? "?");
                const tail = output.length > 900 ? "\u2026" + output.slice(-900) : output || "(sin salida)";
                await reply(`${t("sh_done", { exit })}\n<code>${escapeHtml(tail)}</code>`);
              }
            }
            if (!settled) await reply(t("sh_timeout", { secs: 45 }));
          } catch (error) {
            log("WARN", "sh", safe(error));
            await reply(
              isSessionNotFound(error)
                ? SESSION_UNLOADED
                : "No se pudo correr: " + escapeHtml(String((error as Error).message).slice(0, 200)),
            );
          }
          return;
        }

        case "note": {
          // /note <texto> — a synthetic message in the transcript: the
          // agent reads it as part of the conversation on its next turn,
          // but nothing runs now (verified: 200, no turn started).
          const text = argument.trim();
          const target = threadSession || targetSession();
          if (!text) {
            await reply(t("err_no_note"));
            return;
          }
          if (!target) {
            await reply(t("err_no_sub_arg"));
            return;
          }
          if (!(await forms.connect())) {
            await reply(t("api_down"));
            return;
          }
          try {
            await forms.request("POST", "/session/" + encodeURIComponent(target) + "/synthetic", { text });
            await reply(t("note_added"));
          } catch (error) {
            log("WARN", "note", safe(error));
            await reply(
              isSessionNotFound(error)
                ? SESSION_UNLOADED
                : "No se pudo anotar: " + escapeHtml(String((error as Error).message).slice(0, 200)),
            );
          }
          return;
        }

        case "instructions": {
          // /instructions — the session's persistent instruction entries
          // (verified live: GET {data:[{key,value}]}, PUT {value} -> 204,
          // DELETE -> 204). The session's long-lived rules, from the phone.
          const target = threadSession || targetSession();
          if (!target) {
            await reply(t("err_in_thread_use"));
            return;
          }
          if (!(await forms.connect())) {
            await reply(t("api_down"));
            return;
          }
          const parts = argument.trim().split(/\s+/);
          const sub = (parts[0] ?? "").toLowerCase();
          try {
            if (sub === "del") {
              const key = parts[1] ?? "";
              if (!key) {
                await reply(t("err_no_instr_key"));
                return;
              }
              await forms.request(
                "DELETE",
                "/api/experimental/session/" + encodeURIComponent(target) + "/instructions/entries/" + encodeURIComponent(key),
              );
              await reply(t("instr_deleted", { key }));
              return;
            }
            if (sub && parts.length >= 2) {
              const key = parts[0] ?? "";
              const value = argument.trim().slice(key.length).trim();
              if (!value) {
                await reply(t("instr_needs_key_value"));
                return;
              }
              await forms.request(
                "PUT",
                "/api/experimental/session/" + encodeURIComponent(target) + "/instructions/entries/" + encodeURIComponent(key),
                { value },
              );
              await reply(t("instr_added", { key }));
              return;
            }
            const entries = await forms.request<Array<{ key?: string; value?: string }>>(
              "GET",
              "/api/experimental/session/" + encodeURIComponent(target) + "/instructions/entries",
            );
            const rows = Array.isArray(entries) ? entries : [];
            if (rows.length === 0) {
              await reply(t("instr_empty"));
              return;
            }
            const lines = rows
              .slice(0, 15)
              .map((e) => `\u2022 <code>${escapeHtml(String(e.key ?? "?"))}</code> \u2014 ${escapeHtml(String(e.value ?? "").slice(0, 120))}`);
            await reply(t("instr_header") + "\n" + lines.join("\n"));
          } catch (error) {
            log("WARN", "instructions", safe(error));
            await reply(
              isSessionNotFound(error)
                ? SESSION_UNLOADED
                : "No pude leer las instrucciones: " + escapeHtml(String((error as Error).message).slice(0, 200)),
            );
          }
          return;
        }

        case "perms": {
          // /perms — the "always" answers saved in the server (verified:
          // GET /api/permission/saved -> [{id, projectID, action, ...}]).
          // The natural pair of the 🔁 button: see what accumulated,
          // take one back.
          const parts = argument.trim().split(/\s+/);
          if (!(await forms.connect())) {
            await reply(t("api_down"));
            return;
          }
          try {
            if ((parts[0] ?? "").toLowerCase() === "del") {
              const id = parts[1] ?? "";
              if (!id) {
                await reply(t("perms_needs_id"));
                return;
              }
              await forms.request("DELETE", "/api/permission/saved/" + encodeURIComponent(id));
              await reply(t("perms_deleted"));
              return;
            }
            const saved = await forms.request<Array<Record<string, unknown>>>("GET", "/api/permission/saved");
            const rows = Array.isArray(saved) ? saved : [];
            if (rows.length === 0) {
              await reply(t("perms_empty"));
              return;
            }
            const lines = rows.slice(0, 20).map(
              (p) =>
                `\u2022 <code>${escapeHtml(String(p.id ?? "?").slice(0, 24))}</code> ${escapeHtml(String(p.action ?? "?").slice(0, 60))}` +
                (p.projectID ? ` \u00b7 ${escapeHtml(String(p.projectID).slice(0, 8))}` : ""),
            );
            await reply(t("perms_header") + "\n" + lines.join("\n"));
          } catch (error) {
            log("WARN", "perms", safe(error));
            await reply(t("err_generic", { action: "leer los permisos", detail: escapeHtml(String((error as Error).message).slice(0, 200)) }));
          }
          return;
        }

        case "turns": {
          // /turns — the session's own turn diff (verified: 200 {data:[]}
          // when nothing is recorded). Finer-grained than /git: what THIS
          // session's turns changed.
          const target = argument.trim() || threadSession || targetSession();
          if (!target) {
            await reply(t("err_in_thread_turns"));
            return;
          }
          if (!(await forms.connect())) {
            await reply(t("api_down"));
            return;
          }
          const diff = await forms
            .request<Array<Record<string, unknown>>>("GET", "/session/" + encodeURIComponent(target) + "/diff")
            .catch(() => undefined);
          const rows = Array.isArray(diff) ? diff : [];
          if (rows.length === 0) {
            await reply(t("turns_empty"));
            return;
          }
          const lines = rows.slice(0, 20).map((d) => "\u2022 " + escapeHtml(JSON.stringify(d).slice(0, 140)));
          await reply(t("turns_header") + "\n" + lines.join("\n"));
          return;
        }

        case "log": {
          // /log — a sample of the session's server-side log (verified:
          // SSE "data: {json}" lines). The raw call reads a window and
          // cuts; the tail is what the phone sees.
          const target = argument.trim() || threadSession || targetSession();
          if (!target) {
            await reply(t("err_in_thread_log"));
            return;
          }
          if (!(await forms.connect())) {
            await reply(t("api_down"));
            return;
          }
          const raw = await forms
            .raw("GET", "/api/experimental/session/" + encodeURIComponent(target) + "/log", undefined, 8000, 4000)
            .catch(() => "");
          const events = parseSseData(raw).slice(-10);
          if (events.length === 0) {
            await reply(t("log_empty"));
            return;
          }
          const lines = events.map((e) => "\u2022 " + escapeHtml(e.slice(0, 130)));
          await reply(t("log_header", { n: events.length }) + "\n" + lines.join("\n"));
          return;
        }

        case "terminal": {
          // /terminal — read-only look at the session's persistent PTY
          // (verified: {data:null} when nothing is attached). Interactive
          // control stays on the PC on purpose — this is the viewport.
          const target = argument.trim() || threadSession || targetSession();
          if (!target) {
            await reply(t("err_in_thread_terminal"));
            return;
          }
          if (!(await forms.connect())) {
            await reply(t("api_down"));
            return;
          }
          const read = await forms
            .request<{ lines?: unknown } | null>("GET", "/api/experimental/session/" + encodeURIComponent(target) + "/terminal/read")
            .catch(() => undefined);
          if (!read) {
            await reply(t("term_none"));
            return;
          }
          const lines = Array.isArray(read.lines) ? (read.lines as string[]) : [JSON.stringify(read)];
          const tail = lines.slice(-15).join("\n");
          await reply(t("term_header") + "\n<code>" + escapeHtml(tail.slice(0, 1500)) + "</code>");
          return;
        }

        case "detach": {
          // /detach — the chat root stops pointing at a session: what you
          // type at the root goes nowhere until /use or a thread. The
          // competitor's detach, ours: per-thread sessions stay put.
          if (foreground === undefined) {
            await reply(t("detach_none"));
            return;
          }
          foreground = undefined;
          await reply(t("detach_done"));
          return;
        }

        case "move": {
          // /move <proyecto> — move the session to another project
          // (verified: POST /session/{id}/move with {directory}).
          const target = threadSession || targetSession();
          const directory = argument.trim();
          if (!target) {
            await reply(t("err_in_thread_move"));
            return;
          }
          if (!directory) {
            await reply(t("err_no_project"));
            return;
          }
          if (!(await forms.connect())) {
            await reply(t("api_down"));
            return;
          }
          try {
            await forms.request("POST", "/session/" + encodeURIComponent(target) + "/move", { directory });
            const tracked = sessions.get(target);
            if (tracked) tracked.directory = directory;
            await reply(t("move_done", { directory: escapeHtml(directory) }));
          } catch (error) {
            log("WARN", "move", safe(error));
            await reply(
              isSessionNotFound(error)
                ? SESSION_UNLOADED
                : "No se pudo mover: " + escapeHtml(String((error as Error).message).slice(0, 200)),
            );
          }
          return;
        }

        case "commands": {
          // /commands — the custom commands from the config (verified:
          // GET /api/command -> {data:[{name, description}]}; running one
          // is POST /session/{id}/command with {text}).
          const parts = argument.trim().split(/\s+/);
          const sub = (parts[0] ?? "").toLowerCase();
          if (!(await forms.connect())) {
            await reply(t("api_down"));
            return;
          }
          if (sub === "run") {
            const target = threadSession || targetSession();
            const text = argument.slice(3).trim();
            if (!target || !text) {
              await reply(t("err_no_command_text"));
              return;
            }
            try {
              await forms.request("POST", "/session/" + encodeURIComponent(target) + "/command", { text });
              await reply(`\u23F1 Comando corriendo: <code>${escapeHtml(text.slice(0, 80))}</code>`);
            } catch (error) {
              log("WARN", "command run", safe(error));
              await reply(t("err_generic", { action: "correr", detail: escapeHtml(String((error as Error).message).slice(0, 200)) }));
            }
            return;
          }
          const list = await forms
            .request<Array<{ name?: string; description?: string }>>("GET", "/api/command")
            .catch(() => undefined);
          const rows = Array.isArray(list) ? list : [];
          if (rows.length === 0) {
            await reply(t("commands_none"));
            return;
          }
          const lines = rows
            .slice(0, 30)
            .map((c) => `\u2022 <code>${escapeHtml(String(c.name ?? "?"))}</code> \u2014 ${escapeHtml(String(c.description ?? "").slice(0, 80))}`);
          await reply(`\u2328\uFE0F Comandos custom (${rows.length}):\n${lines.join("\n")}`);
          return;
        }

        case "skills": {
          // `list` is on SkillApi but its exact input has shifted between
          // releases, so call it defensively and normalise the rows.
          const list = (ctx.skill as unknown as { list?: (...args: unknown[]) => Promise<unknown> }).list;
          if (!list) {
            await reply(t("skills_not_exposed"));
            return;
          }
          try {
            const result = (await list.call(ctx.skill)) as unknown;
            const rows = Array.isArray(result) ? result : ((result as { data?: unknown[] })?.data ?? []);
            if (rows.length === 0) {
              await reply(t("skills_none"));
              return;
            }
            const lines = rows.slice(0, 60).map((row) => {
              const item = (row ?? {}) as Record<string, unknown>;
              const id = str(item.id) || str(item.name) || "?";
              const description = str(item.description).replace(/\s+/g, " ").slice(0, 90);
              return `\u{1F3F7} <code>${escapeHtml(id)}</code>${description ? ` \u2014 ${escapeHtml(description)}` : ""}`;
            });
            skillItems = rows.slice(0, 60).map((row) => {
              const item = (row ?? {}) as Record<string, unknown>;
              return { id: str(item.id) || str(item.name) || "?", name: str(item.name) || str(item.id) || "?" };
            });
            if (chatId === undefined) return;
            const keyboard = skillItems.map((s, i) => [
              { text: s.name.slice(0, 64), callback_data: "skl:" + i },
            ]);
            await telegram.sendMessage(
              chatId,
              t("skills_header", { n: rows.length, lines: lines.join("\n") }),
              { parseMode: "HTML", messageThreadId: threadOf(threadSession), replyMarkup: { inline_keyboard: keyboard } },
            );
          } catch (error) {
            log("WARN", "skill.list failed", safe(error));
            await reply(`No pude listar las skills: <code>${escapeHtml(String(error))}</code>`);
          }
          return;
        }

        default:
          await reply(t("unknown_command", { name: escapeHtml(name) }));
      }
    };

    // ── event subscription ───────────────────────────────────────────────────
    const subscription = new AbortController();
    let pump: Promise<void> | undefined;
    let poll: Promise<void> | undefined;
    let started = false;
    let streamClosed = false;

    function startPump(): void {
      if (pump) return;
      pump = (async () => {
        try {
          for await (const event of ctx.event.subscribe({ signal: subscription.signal })) {
            if (!firstSighting(event as { id?: unknown; type?: unknown })) continue;
            // Deltas fire once per token; logging those would bury the shapes we
            // actually want to verify, so only the structural events are dumped.
            if (config.debugEvents && DEBUG_EVENTS.has(event.type)) {
              log("INFO", `event ${event.type}`, safe(event.data, 300));
            }
            route(event as { type: string; data?: unknown });
          }
          // Reaching the end of the async iterator without an abort means the
          // server closed the subscription underneath us — OpenCode dismantled
          // this instance. Flag it so the bridge can hand leadership to a
          // survivor instead of leaving a corpse holding the token.
          if (!subscription.signal.aborted) {
            streamClosed = true;
            log("WARN", "event stream cerrado por el servidor");
          }
        } catch (error) {
          if (!subscription.signal.aborted) log("ERROR", "event stream", safe(error));
        }
      })();
    }

    function route(event: { type: string; data?: unknown }): void {
      const data = dataOf(event);
      // A form carries its session inside `data.form`, not at the top level, so
      // it has to be handled before the guard below would reject the event.
      if (event.type.startsWith("form.")) {
        handleFormEvent(event.type, data).catch((error) => log("ERROR", `evento ${event.type}`, safe(error)));
        return;
      }
      const sessionID = str(data.sessionID ?? data.sessionId);
      if (!sessionID) return;
      // "subagents": "off" drops parented sessions from the mirror entirely:
      // no topic, no rendering, no notifications — they live in the parent.
      if (config.subagents === "off" && str(data.parentID)) ignoredSubagents.add(sessionID);
      if (ignoredSubagents.has(sessionID)) return;
      const session = track(sessionID);
      // The first event of a running turn lights the thread's "typing…" lamp;
      // `session.idle` — and a failed execution — put it out.
      if (TURN_START_EVENTS.has(event.type) && isWatched(sessionID)) startTyping(sessionID);

      switch (event.type) {
        case "session.renamed":
        case "session.metadata.updated": {
          const fresh = str(data.title);
          if (!fresh || fresh === session.title) return;
          // A session gets retitled all the time (the title agent after the
          // first prompt, manual renames) — the forum topic must follow or
          // the thread keeps its birth name forever.
          session.title = fresh;
          const renameThreadId = threadOf(sessionID);
          if (chatId !== undefined && renameThreadId !== undefined) {
            const name = session.parentID ? `\u{1F916} ${fresh}` : fresh;
            void telegram
              .editForumTopic(chatId, renameThreadId, name)
              .catch((error) => log("WARN", "topic rename", safe(error)));
          }
          return;
        }
        case "session.created":
          // Subagent (task) sessions are born with their parent in the event:
          // the badge, the read-only guard and the auto-archive all key on it.
          {
            const bornParent = str(data.parentID);
            if (bornParent) {
              session.parentID = bornParent;
              log("INFO", `subagente ${sessionID.slice(0, 18)} de ${bornParent.slice(0, 18)}`);
            }
          }
          if (data.location && typeof data.location === "object") {
            session.directory = str((data.location as Record<string, unknown>).directory);
          }
          // The first `session.created` for a pre-existing session carries no
          // title; the file on disk is the only place it lives.
          if (!str(data.title)) {
            const meta = readSessionMeta(sessionID);
            if (meta?.title) session.title = meta.title;
            if (!session.directory && meta?.directory) session.directory = meta.directory;
          } else {
            session.title = str(data.title);
          }
          return;

        case "session.text.started":
          renderer.textStarted(sessionID, textKey(data));
          return;
        case "session.text.delta":
          renderer.textDelta(sessionID, textKey(data), typeof data.ordinal === "number" ? data.ordinal : 0, str(data.delta));
          return;
        case "session.text.ended":
          renderer.textEnded(sessionID, textKey(data));
          return;

        case "session.reasoning.started":
          if (config.render.showReasoning) renderer.textStarted(sessionID, textKey(data), "\u{1F4AD} ");
          return;
        case "session.reasoning.delta":
          if (config.render.showReasoning) {
            renderer.textDelta(sessionID, textKey(data), typeof data.ordinal === "number" ? data.ordinal : 0, str(data.delta));
          }
          return;
        case "session.reasoning.ended":
          if (config.render.showReasoning) renderer.textEnded(sessionID, textKey(data));
          return;

        case "session.tool.input.started": {
          const payload = data as ToolPayload;
          // No pending card for `question`: its form arrives a beat later as a
          // card with real buttons, and two "the agent asks" cards for one
          // question read as a glitch. The answer still renders on success.
          if (str(payload.name) === "question") {
            if (payload.id) questionToolIds.add(payload.id);
            return;
          }
          if (payload.id) renderer.toolEvent(sessionID, { id: payload.id, name: str(payload.name) || "tool", status: "pending" });
          return;
        }
        case "session.tool.called": {
          const payload = data as ToolPayload;
          if (payload.id) {
            // A `question` is the one tool that waits on the human. Track it so
            // an incoming message gets told where to go instead of queueing
            // behind a turn that cannot move until the desktop answers.
            // The name does not ride with this event — only the input does —
            // so the input's shape and the started-id are the witnesses.
            const isQuestion =
              str(payload.name) === "question" ||
              questionToolIds.has(payload.id) ||
              Array.isArray(payload.input?.questions);
            if (isQuestion) {
              openQuestions.add(sessionID);
              questionToolIds.add(payload.id);
              // The turn now waits on a human answer — no more "typing…" lamp.
              stopTyping(sessionID);
              return;
            }
            renderer.toolEvent(sessionID, {
              id: payload.id,
              name: str(payload.name) || "tool",
              input: (payload.input ?? {}) as Record<string, unknown>,
              status: "running",
            });
          }
          return;
        }
        case "session.tool.progress": {
          const payload = data as ToolPayload;
          // A progress tick would upsert a nameless "tool" record for a
          // question whose pending card was skipped above — stay silent.
          if (payload.id && !questionToolIds.has(payload.id)) {
            renderer.toolEvent(sessionID, { id: payload.id, status: "running" });
          }
          return;
        }
        case "session.tool.success": {
          const payload = data as ToolPayload;
          {
            const output = contentText(payload.content);
            if (output) for (const p of extractFilePaths(output)) noteTurnImage(sessionID, p);
            const inputStr = JSON.stringify(payload.input ?? {});
            for (const p of extractFilePaths(inputStr)) noteTurnImage(sessionID, p);
          }
          if (payload.id) {
            // A question renders as a form card whose receipt already shows
            // the answer; a renderer card repeating the question with no
            // buttons is the duplicate users report. Stay silent for it.
            if (str(payload.name) !== "question" && !questionToolIds.has(payload.id)) {
              renderer.toolEvent(sessionID, {
                id: payload.id,
                name: str(payload.name) || "tool",
                status: "completed",
                output: contentText(payload.content),
              });
            }
            if (str(payload.name) === "question" || questionToolIds.has(payload.id)) {
              openQuestions.delete(sessionID);
              questionToolIds.delete(payload.id);
            }
          }
          return;
        }
        case "session.tool.failed": {
          const payload = data as ToolPayload;
          if (payload.id) {
            if (str(payload.name) !== "question" && !questionToolIds.has(payload.id)) {
              renderer.toolEvent(sessionID, {
                id: payload.id,
                name: str(payload.name) || "tool",
                status: "failed",
                error: str(payload.error?.message),
                output: contentText(payload.content),
              });
            }
            if (str(payload.name) === "question" || questionToolIds.has(payload.id)) {
              openQuestions.delete(sessionID);
              questionToolIds.delete(payload.id);
            }
          }
          return;
        }

        case "session.idle":
          // `track` already cleared the flag for this event; mark it now so
          // `/sessions` can tell a finished turn from one still streaming.
          session.idle = true;
          stopTyping(sessionID);
          renderer.finalize(sessionID);
          flushTurnImages(sessionID);
          flushCoalesced(sessionID);
          // A finished subagent archives its own topic: the forum stays clean
          // and the parent keeps the spotlight. Marking the store keeps the
          // revive logic consistent (a revived subagent reopens on first sight).
          if (session.parentID && chatId !== undefined) {
            const subThreadId = threadOf(sessionID);
            if (subThreadId !== undefined) {
              topicStore?.setArchived(sessionID, true);
              archiveThread(subThreadId);
              log("INFO", `subagente ${sessionID.slice(0, 18)} termin\u00f3 \u2014 hilo archivado`);
            }
          }
          return;

        case "session.execution.failed": {
          stopTyping(sessionID);
          const error = (data.error ?? {}) as { message?: string };
          const message = str(error.message) || "fallo desconocido";
          void send(`\u274C <b>${escapeHtml(session.title)}</b>\n<code>${escapeHtml(message.slice(0, 600))}</code>`);
          return;
        }

        case "permission.asked": {
          // Real contract (validated against @opencode/client): the event's
          // `id` is the requestID the reply must address — a synthetic id
          // would 404. The three buttons map 1:1 to the server's decisions:
          // once / always / reject.
          const requestId = str(data.id);
          if (!requestId) return;
          const resources = Array.isArray(data.resources) ? data.resources.map(str).join(", ") : str(data.resources);
          const action = str(data.action) || "?";
          permissionRequests.set(requestId, { sessionID });
          if (chatId !== undefined && isWatched(sessionID)) {
            const keyboard = {
              inline_keyboard: [[
                { text: t("btn_approve"), callback_data: "perm2:ok:" + requestId },
                { text: t("btn_always"), callback_data: "perm2:always:" + requestId },
                { text: t("btn_reject"), callback_data: "perm2:no:" + requestId },
              ]],
            };
            void telegram
              .sendMessage(chatId, t("perm_card", { title: escapeHtml(session.title), action: escapeHtml(action), resources: escapeHtml(resources.slice(0, 300)) }), {
                parseMode: "HTML", messageThreadId: threadOf(sessionID), replyMarkup: keyboard,
              })
              .catch((error) => log("WARN", "perm send", safe(error)));
            // Background heads-up — same reasoning as the form's: the request
            // sits in its thread, this line makes sure General says so.
            if (threadOf(sessionID) !== undefined) {
              void telegram
                .sendMessage(chatId, t("perm_card_general", { title: escapeHtml(session.title) }), {
                  parseMode: "HTML",
                })
                .catch((error) => log("WARN", "perm heads-up", safe(error)));
            }
          }
          return;
        }
      }
    }

    // ── inbound messages (live mode only) ────────────────────────────────────
    /** Only the leader polls: two `getUpdates` on one token → HTTP 409. */
    function startPoll(): void {
      if (poll || dry || chatId === undefined) return;
      poll = telegram
        .longPoll(
          async (update) => {
            const message = update.message;
            if (message) {
              const from = message.from?.id;
              const authorised = config.allowedUsers.includes(message.chat.id) || (from !== undefined && config.allowedUsers.includes(from));
              if (!authorised) {
                log("WARN", `rejected message from chat ${message.chat.id}`);
                return;
              }
              const text = (message.text ?? "").trim();
              // A message written inside a session's thread is addressed to
              // that session; at the chat root it goes to the foreground one.
              const byThread = message.message_thread_id !== undefined
                ? topicStore?.sessionOf(message.message_thread_id)
                : undefined;
              // A skill is armed: this text becomes that skill's prompt.
              if (skillArmed && text && !text.startsWith("/")) {
                const armed = skillArmed;
                skillArmed = undefined;
                await sendPrompt(text, byThread, undefined, [{ id: armed.id }]);
                return;
              }
              // A task-prompt edit is armed: this text replaces that task's
              // prompt. Stale (10 min) or written in another thread, it just
              // falls through as a normal prompt — the edit forgets itself.
              if (taskPromptEdit && text && !text.startsWith("/")) {
                const edit = taskPromptEdit;
                taskPromptEdit = undefined;
                if (Date.now() - edit.armedAt < 10 * 60_000 && message.message_thread_id === edit.threadId) {
                  const updated = updateTaskPrompt(edit.id, text);
                  await send(
                    updated
                      ? `\u2705 Prompt de <b>${escapeHtml(edit.name)}</b> actualizado:\n<code>${escapeHtml(updated.prompt.slice(0, 400))}</code>`
                      : t("task_run_gone"),
                    byThread,
                  );
                  return;
                }
              }
              // The /newtask wizard consumes this text as its current step.
              if (taskWizard && text && !text.startsWith("/")) {
                await wizardStep(text, byThread);
                return;
              }
              // An inbox edit is armed: this message replaces that pending
              // item — cancel it and send the new text through the same inbox.
              if (inboxEdit && text && !text.startsWith("/") && (byThread ?? targetSession()) === inboxEdit.session) {
                const item = inboxEdit;
                inboxEdit = undefined;
                if (await forms.connect()) {
                  await forms
                    .request("DELETE", `/session/${encodeURIComponent(item.session)}/inbox/${encodeURIComponent(item.id)}`)
                    .catch((error) => log("WARN", "inbox edit cancel", safe(error)));
                  await forms
                    .request("POST", `/session/${encodeURIComponent(item.session)}/prompt`, { text, delivery: "queue" })
                    .catch((error) => log("WARN", "inbox edit send", safe(error)));
                  await send(t("inbox_replaced"), byThread);
                } else {
                  await send(t("inbox_edit_fail"), byThread);
                }
                return;
              }
              if (inboxEdit && text.startsWith("/")) inboxEdit = undefined;
              // Media is content for the agent, never a form answer: a photo
              // (or an image document) downloads and rides the prompt as an
              // image block, with the caption as its text.
              const media = await mediaOf(message);
              if (media) {
                const caption = ((message.caption ?? "").trim()) || `(${media.name})`;
                await sendPrompt(caption, byThread, [media]);
                return;
              }
              if (message.voice) {
                // Voice → local transcription (whisper.cpp): the OGG/Opus that
                // Telegram hands over rides the OS temp dir, and the text enters
                // the prompt as if typed. An open question takes it as the answer.
                const voiceId = message.voice.file_id;
                if (!voiceId) {
                  await send(t("voice_no_file"), byThread);
                  return;
                }
                const file = await telegram.getFile(voiceId);
                const filePath = file.file_path;
                if (!filePath) {
                  await send(t("voice_no_audio_file"), byThread);
                  return;
                }
                const buffer = await telegram.downloadFile(filePath);
                const fs = await import("node:fs");
                const os = await import("node:os");
                const path = await import("node:path");
                const oggPath = path.join(os.tmpdir(), `tg-voz-${Date.now()}.ogg`);
                fs.writeFileSync(oggPath, buffer);
                try {
                  if (!sttAvailable(config.stt)) {
                    await send(t("voice_not_configured"), byThread);
                    return;
                  }
                  await send(t("voice_transcribing_secs", { secs: message.voice.duration ?? "?" }), byThread);
                  const text = await transcribeFile(oggPath, config.stt);
                  if (text.length === 0) {
                    await send(t("voice_nothing"), byThread);
                    return;
                  }
                  await send(`\u{1F3A4} \u00ab${escapeHtml(text.slice(0, 400))}\u00bb`, byThread);
                  const target = byThread ?? targetSession();
                  if (target) {
                    // An open single-question form gets the transcription as its
                    // answer; otherwise it is a normal prompt for the session.
                    if (!(await answerFreeForm(target, text))) {
                      await sendPrompt(`\u{1F3A4} (nota de voz, transcrita)\n${text}`, target);
                    }
                  } else {
                    await send(t("msg_no_target"), byThread);
                  }
                } catch (error) {
                  log("WARN", "stt", safe(error));
                  await send(t("voice_transcribe_fail", { detail: escapeHtml(String((error as Error).message).slice(0, 200)) }), byThread);
                } finally {
                  fs.rmSync(oggPath, { force: true });
                }
                return;
              }
              if (message.document?.file_id) {
                // A document that is not an image: inline it when it is text
                // (code, config, data — the agent reads it right away), or
                // park the binary on disk and hand over the path.
                try {
                  const doc = await telegram.getFile(message.document.file_id);
                  if (!doc.file_path) throw new Error("sin file_path");
                  const buffer = await telegram.downloadFile(doc.file_path);
                  const name = message.document.file_name ?? "archivo";
                  const mime = message.document.mime_type ?? "";
                  const caption = ((message.caption ?? "").trim()) || "";
                  if (buffer.length > 20 * 1024 * 1024) {
                    await send("\u26A0\uFE0F El documento supera los 20 MB que Telegram entrega a un bot.", byThread);
                    return;
                  }
                  if (isTextLike(name, mime, buffer)) {
                    const content = decodeText(buffer).slice(0, DOC_MAX_CHARS);
                    const truncated = content.length >= DOC_MAX_CHARS ? "\n\n(truncado)" : "";
                    const body = caption
                      ? caption + "\n\nArchivo adjunto \"" + name + "\":\n```\n" + content + truncated + "\n```"
                      : "El usuario envi\u00f3 el contenido del archivo \"" + name + "\":\n```\n" + content + truncated + "\n```";
                    await sendPrompt(body, byThread);
                  } else {
                    const saved = saveBinary(name, buffer);
                    const size = (buffer.length / 1024 / 1024).toFixed(2);
                    const body = caption
                      ? caption + "\n\nEl usuario envi\u00f3 el archivo binario \"" + name + "\" (" + mime + ", " + size + " MB), guardado en: " + saved
                      : "El usuario envi\u00f3 el archivo binario \"" + name + "\" (" + mime + ", " + size + " MB), guardado en: " + saved + " \u2014 abrilo con tus file tools si lo necesit\u00e1s.";
                    await sendPrompt(body, byThread);
                  }
                } catch (error) {
                  log("WARN", "document ingest", safe(error));
                  await send(t("doc_download_fail"), byThread);
                }
                return;
              }
              if (message.video?.file_id) {
                // Videos are always binary: save to disk, hand over the path.
                try {
                  const file = await telegram.getFile(message.video.file_id);
                  if (!file.file_path) throw new Error("sin file_path");
                  const buffer = await telegram.downloadFile(file.file_path);
                  if (buffer.length > 20 * 1024 * 1024) {
                    await send(t("video_too_big"), byThread);
                    return;
                  }
                  const saved = saveBinary(message.video.file_name ?? "video.mp4", buffer);
                  const size = (buffer.length / 1024 / 1024).toFixed(2);
                  const body = t("video_ingest_prompt", { size: escapeHtml(size), path: escapeHtml(saved) });
                  await sendPrompt(body, byThread);
                } catch (error) {
                  log("WARN", "video ingest", safe(error));
                  await send(t("video_download_fail"), byThread);
                }
                return;
              }
              if (text.startsWith("/")) {
                const [command, ...rest] = text.slice(1).split(/\s+/);
                await handleCommand(command.split("@")[0], rest.join(" "), byThread);
              } else if (!(await answerFormFromText(byThread, text))) {
                // Not the open form's answer — a normal prompt, possibly
                // with reply context and coalescing.
                // A forum thread pins its opener at the top and Telegram echoes
                // it in reply_to_message for ordinary messages — the user
                // replied to nothing. A real reply points at another message.
                if (message.reply_to_message) {
                  log(
                    "INFO",
                    `reply: thread=${message.message_thread_id ?? "-"} to=${message.reply_to_message.message_id} echo=${isForumEcho(message)}`,
                  );
                }
                const quote = isForumEcho(message)
                  ? undefined
                  : describeReplyTarget(message.reply_to_message);
                const prompt = withReplyContext(text, quote);
                const target = byThread ?? targetSession();
                if (!target) {
                  await send(t("msg_no_target"), byThread);
                  return;
                }
                // An armed /ls attachment rides along with this text.
                const attached = pendingAttach.get(target);
                if (attached) {
                  pendingAttach.delete(target);
                  await sendPrompt(prompt, byThread, [attached]);
                  return;
                }
                // Coalesce: an idle session takes the short window; a busy one
                // takes a slightly wider burst window — rapid follow-ups
                // still merge, but the batch reaches the server's inbox (and
                // /queue) in seconds, keeping the steer control alive. A long
                // hold until idle made every message invisible to /queue.
                const trackedTarget = sessions.get(target);
                const busy = trackedTarget !== undefined && !trackedTarget.idle;
                const delay = busy ? COALESCE_BUSY_MS : COALESCE_MS;
                const existing = coalescing.get(target);
                if (existing) {
                  existing.parts.push(prompt);
                  if (existing.timer) clearTimeout(existing.timer);
                  existing.timer = setTimeout(() => flushCoalesced(target), delay);
                  log("INFO", `coalesce: +1 (${existing.parts.length} en cola) para ${target.slice(0, 18)}`);
                } else {
                  const buf: Coalesced = { parts: [prompt], timer: undefined };
                  buf.timer = setTimeout(() => flushCoalesced(target), delay);
                  coalescing.set(target, buf);
                  log("INFO", `coalesce: nuevo buffer (${delay}ms${busy ? " busy" : ""}) para ${target.slice(0, 18)}`);
                }
              }
              return;
            }
            if (update.callback_query) {
              const cq = update.callback_query;
              const payload = cq.data ?? "";
              const from = cq.from?.id;
              const authorised =
                payload.startsWith("perm:") ||
                config.allowedUsers.includes(cq.message?.chat.id ?? 0) ||
                (from !== undefined && config.allowedUsers.includes(from));
              if (!authorised) {
                log("WARN", `rejected callback from user ${String(from)}`);
                return;
              }
              // Every tap spins a loader in the client until the query is
              // answered; an ack with no words is how "nothing happened" feels.
              const ack = (text?: string) =>
                telegram.answerCallbackQuery(cq.id, text).catch((error) => log("WARN", "callback", safe(error)));
              const ripDeadButtons = async (formID: string): Promise<void> => {
                log("WARN", `callback form sin entrada: ${formID || "?"} (abiertas: ${openForms.size})`);
                // A button outliving its form (a restart dropped the entry, or
                // the PC already answered) would lie forever — rip it off at
                // first touch. The card text stays; only the buttons go.
                const deadChat = cq.message?.chat?.id ?? chatId;
                const deadMsg = cq.message?.message_id;
                if (deadChat !== undefined && deadMsg !== undefined) {
                  await telegram
                    .editMessageReplyMarkup(deadChat, deadMsg)
                    .catch((error) => log("WARN", "form strip", safe(error)));
                }
                await ack(t("form_inactive"));
              };
              if (payload.startsWith("shok:") || payload.startsWith("shno:")) {
                // Confirm/cancel of a guarded /sh. The command only runs
                // here — never on first sight — and it is deleted before the
                // POST so a crash mid-run cannot re-trigger it.
                const shId = payload.slice(5);
                const pending = pendingSh.get(shId);
                if (!pending) {
                  await ripDeadButtons("sh:" + shId);
                  return;
                }
                if (payload.startsWith("shno:")) {
                  pendingSh.delete(shId);
                  await ack(t("perm_cancelled"));
                  log("INFO", `sh cancelado por el usuario: ${pending.command.slice(0, 60)}`);
                  await telegram
                    .editMessageReplyMarkup(cq.message?.chat?.id ?? chatId ?? 0, cq.message?.message_id ?? 0)
                    .catch(() => undefined);
                  return;
                }
                pendingSh.delete(shId);
                await ack(t("ack_running"));
                log("INFO", `sh confirmado por el usuario: ${pending.command.slice(0, 60)}`);
                if (!(await forms.connect())) {
                  await telegram
                    .sendMessage(cq.message?.chat?.id ?? chatId ?? 0, "La API local no responde.", {
                      parseMode: "HTML",
                      ...(cq.message?.message_thread_id !== undefined
                        ? { messageThreadId: cq.message.message_thread_id }
                        : {}),
                    })
                    .catch(() => undefined);
                  return;
                }
                try {
                  await forms.request("POST", "/session/" + encodeURIComponent(pending.target) + "/shell", {
                    command: pending.command,
                  });
                  await telegram
                    .sendMessage(
                      cq.message?.chat?.id ?? chatId ?? 0,
                      `▶️ Ejecutando (confirmado):\n<code>${escapeHtml(pending.command.slice(0, 300))}</code>`,
                      {
                        parseMode: "HTML",
                        ...(cq.message?.message_thread_id !== undefined
                          ? { messageThreadId: cq.message.message_thread_id }
                          : {}),
                      },
                    )
                    .catch(() => undefined);
                } catch (error) {
                  log("WARN", "sh confirmado", safe(error));
                  await telegram
                    .sendMessage(
                      cq.message?.chat?.id ?? chatId ?? 0,
                      isSessionNotFound(error)
                        ? SESSION_UNLOADED
                        : "No se pudo correr: " + escapeHtml(String((error as Error).message).slice(0, 200)),
                      {
                        parseMode: "HTML",
                        ...(cq.message?.message_thread_id !== undefined
                          ? { messageThreadId: cq.message.message_thread_id }
                          : {}),
                      },
                    )
                    .catch(() => undefined);
                }
                return;
              }
              if (payload.startsWith("help:")) {
                // help:<command> — the detailed section of the tapped
                // command, from docs/COMMANDS.md (the source of truth).
                const name = payload.slice(5);
                if (name === "_") {
                  await ack();
                  return;
                }
                const section = commandSections().find((s) => s.name === name);
                if (!section) {
                  await ack(t("help_gone"));
                  return;
                }
                await ack();
                const chat = cq.message?.chat.id ?? chatId ?? 0;
                const thread = cq.message?.message_thread_id;
                // Long sections travel in parts — Telegram caps at 4096.
                const body = section.body;
                if (body.length > 4000) {
                  const parts = body.match(/.{1,4000}/gs) ?? [body];
                  for (const part of parts) {
                    await telegram
                      .sendMessage(chat, part, { parseMode: "HTML", ...(thread !== undefined ? { messageThreadId: thread } : {}) })
                      .catch(() => undefined);
                  }
                } else {
                  await telegram
                    .sendMessage(chat, body, { parseMode: "HTML", ...(thread !== undefined ? { messageThreadId: thread } : {}) })
                    .catch(() => undefined);
                }
                return;
              }
              if (payload.startsWith("rnme:")) {
                const card = suggestCards.get(cq.message?.message_id);
                const option = card?.options[Number(payload.slice(5))];
                if (!card || !option) {
                  await ack(t("rename_suggest_expired"));
                  return;
                }
                await ack(t("rename_working"));
                const failure = await applyRename(card.session, option.slice(0, 128));
                if (failure) {
                  await ack(failure.replace(/<[^>]+>/g, "").slice(0, 160));
                  return;
                }
                suggestCards.drop(cq.message?.message_id);
                if (cq.message) {
                  await telegram
                    .editMessageText(cq.message.chat.id, cq.message.message_id, `\u{1F3F7}\uFE0F Renombrada: <b>${escapeHtml(option.slice(0, 128))}</b>`, { parseMode: "HTML" })
                    .catch(() => undefined);
                }
                return;
              }
              if (payload === "rbld:ok" || payload === "rbld:no") {
                if (payload === "rbld:no") {
                  await ack(t("rebuild_cancelled"));
                  if (cq.message) {
                    await telegram
                      .editMessageText(cq.message.chat.id, cq.message.message_id, t("rebuild_cancelled_card"), { parseMode: "HTML" })
                      .catch(() => undefined);
                  }
                  return;
                }
                if (!topicStore || !cq.message) {
                  await ack(t("rebuild_no_store"));
                  return;
                }
                await ack(t("rebuild_working"));
                const chat = cq.message.chat.id;
                try {
                  // 1) The wipe, one confirmed delete at a time: a mapping is
                  //    only forgotten when Telegram says the topic is gone.
                  //    The old fire-and-forget + clear() forgot everything up
                  //    front, so one failed delete (rate limit, restart
                  //    mid-burst, transport aborted by a hand-over — all in
                  //    one day) left a live topic nobody could name again,
                  //    and the Bot API has no way to list topics.
                  const all = topicStore.entries();
                  const { deleted, failed } = await sweepTopics(topicStore, telegram, chat, (tid) =>
                    log("WARN", `rebuild: el hilo ${tid} no se pudo borrar \u2014 queda mapeado`),
                  );
                  // 2) fresh threads for the sessions the server holds,
                  //    oldest first so the most recent lands at the top of
                  //    the topic list; the flood gate serializes the burst.
                  let created = 0;
                  if (await forms.connect()) {
                    const list = await forms.request<Array<ApiSession>>("GET", "/session").catch(() => undefined);
                    // `idle` is the last real interaction; `updated` is also
                    // bumped by the server's own housekeeping — every session
                    // gets touched at startup, so ordering by it resurrected
                    // sessions nobody had opened for days (measured: eight
                    // sessions sharing one `updated` minute, the service
                    // restart, with idle times of 10h and 2d).
                    const rows = rebuildCandidates(
                      (Array.isArray(list) ? list : []) as RebuildSession[],
                      Date.now(),
                      config.rebuildIdleHours,
                    );
                    for (const s of rows) {
                      // A session whose topic survived the sweep (failed
                      // delete) keeps it — recreating on top would orphan
                      // the old one, which is the bug this path is about.
                      if (topicStore.get(s.id) !== undefined) continue;
                      const title = (s.title?.trim() || s.id.slice(0, 24)).slice(0, 128);
                      const tid = await telegram.createForumTopic(chat, title).catch(() => undefined);
                      if (tid === undefined) continue;
                      topicStore.set(s.id, tid);
                      created += 1;
                      await telegram
                        .sendMessage(
                          chat,
                          t("rebuild_thread_done"),
                          { parseMode: "HTML", messageThreadId: tid },
                        )
                        .catch(() => undefined);
                    }
                  }
                  const windowTxt = config.rebuildIdleHours === 0 ? t("win_hours") : `${config.rebuildIdleHours}h`;
                  let summary = t("rebuild_deleted_line", { n: deleted });
                  if (failed > 0) {
                    summary += t("rebuild_failed_line", { n: failed });
                  }
                  if (created > 0) {
                    summary += t("rebuild_recreated_line", { created, window: windowTxt });
                  } else if (failed === 0) {
                    summary += t("rebuild_empty_line", { window: windowTxt });
                  }
                  log(
                    "INFO",
                    `rebuild: ${all.length} mapeados, ${deleted} borrados, ${failed} fallidos, ${created} recreados (idle<=${windowTxt})`,
                  );
                  await telegram
                    .editMessageText(chat, cq.message.message_id, summary, { parseMode: "HTML" })
                    .catch(() => undefined);
                } catch (error) {
                  log("WARN", "rebuild", safe(error));
                  await ack(t("rebuild_failed"));
                }
                return;
              }
              if (payload.startsWith("gitdiff:")) {
                // gitdiff:<sessionID> — the working diff of the session's
                // project, as a preview plus the full patch downloadable.
                const sessionID = payload.slice(8);
                await ack(t("gitdiff_loading"));
                const directory = await directoryOf(sessionID);
                if (!directory || chatId === undefined || !cq.message) {
                  await ack(t("project_unseen_ack"));
                  return;
                }
                const diff = await forms.request<Array<Record<string, unknown>>>(
                  "GET",
                  "/vcs/diff?location%5Bdirectory%5D=" + encodeURIComponent(directory) + "&mode=working",
                ).catch(() => undefined);
                const files = Array.isArray(diff) ? diff : [];
                if (files.length === 0) {
                  await ack(t("gitdiff_clean"));
                  return;
                }
                // Full patch as a downloadable .diff; short preview inline.
                const fs = await import("node:fs");
                const os = await import("node:os");
                const pathMod = await import("node:path");
                const patch = files.map((f) => String(f.patch ?? "")).join("\n");
                const tmp = pathMod.join(os.tmpdir(), `tg-diff-${Date.now()}.patch`);
                fs.writeFileSync(tmp, patch, "utf8");
                const preview = patch.length > 1500 ? patch.slice(0, 1500) + "\n\u2026 (recortado \u2014 el .patch va completo)" : patch;
                try {
                  await telegram.sendMessage(chatId, `<pre>${escapeHtml(preview)}</pre>`, {
                    parseMode: "HTML",
                    messageThreadId: cq.message.message_thread_id,
                  });
                  await telegram.sendDocument(chatId, tmp, { messageThreadId: cq.message.message_thread_id });
                } finally {
                  fs.rmSync(tmp, { force: true });
                }
                return;
              }
              if (payload.startsWith("revertok:")) {
                // revertok:<sessionID> — the confirmed undo.
                const sessionID = payload.slice(9);
                await ack(t("gitundo_working"));
                try {
                  await forms.request("POST", "/session/" + encodeURIComponent(sessionID) + "/revert/commit");
                  log("INFO", "revert confirmado desde TG: " + sessionID.slice(0, 18));
                  if (cq.message) {
                    await telegram
                      .editMessageText(cq.message.chat.id, cq.message.message_id, "\u21A9\uFE0F Turno deshecho.", { parseMode: "HTML" })
                      .catch(() => undefined);
                  }
                } catch (error) {
                  log("WARN", "revert commit", safe(error));
                  await ack(
                    isSessionNotFound(error)
                      ? "Esa sesi\u00f3n no est\u00e1 activa en el server \u2014 abrila en la PC primero."
                      : "No se pudo deshacer: " + String((error as Error).message).slice(0, 120),
                  );
                }
                return;
              }
              if (payload.startsWith("revertno:")) {
                const sessionID = payload.slice(9);
                await ack(t("cancelled"));
                if (cq.message) {
                  await telegram
                    .editMessageText(cq.message.chat.id, cq.message.message_id, t("revert_cancelled_card"), { parseMode: "HTML" })
                    .catch(() => undefined);
                }
                return;
              }
              if (payload.startsWith("lsg:")) {
                // lsg:<key> — navigate to the stored rel path.
                const key = payload.slice(4);
                const rel = lsKeys.get(key);
                if (rel === undefined) {
                  await ack(t("ls_stale"));
                  return;
                }
                const menuSession = cq.message?.message_thread_id !== undefined ? topicStore?.sessionOf(cq.message.message_thread_id) : undefined;
                const sessionID = menuSession ?? targetSession();
                if (!sessionID) {
                  await ack(t("ls_needs_thread"));
                  return;
                }
                const directory = await directoryOf(sessionID);
                if (!directory) {
                  await ack(t("project_unseen_ack"));
                  return;
                }
                await ack();
                await browseDirectory(sessionID, directory, rel);
                return;
              }
              if (payload.startsWith("lsd:")) {
                // lsd:<key> — download the stored file.
                const key = payload.slice(4);
                const rel = lsKeys.get(key);
                const menuSession = cq.message?.message_thread_id !== undefined ? topicStore?.sessionOf(cq.message.message_thread_id) : undefined;
                const sessionID = menuSession ?? targetSession();
                const directory = await directoryOf(sessionID);
                if (rel === undefined) {
                  await ack(t("ls_stale"));
                  return;
                }
                if (!sessionID || !directory || chatId === undefined || !cq.message) {
                  await ack(t("ls_file_missing"));
                  return;
                }
                const full = safeResolve(directory, rel);
                if (!full || !existsSync(full)) {
                  await ack(t("ls_file_gone"));
                  return;
                }
                const size = (await import("node:fs")).statSync(full).size;
                if (size > 45 * 1024 * 1024) {
                  await ack(t("ls_file_too_big"));
                  return;
                }
                await ack(t("ls_sending"));
                await telegram
                  .sendDocument(chatId, full, { messageThreadId: cq.message.message_thread_id })
                  .catch((error) => {
                    log("WARN", "ls download", safe(error));
                  });
                return;
              }
              if (payload.startsWith("lsa:")) {
                // lsa:<key> — arm the stored text file as the next attachment.
                const key = payload.slice(4);
                const rel = lsKeys.get(key);
                const menuSession = cq.message?.message_thread_id !== undefined ? topicStore?.sessionOf(cq.message.message_thread_id) : undefined;
                const sessionID = menuSession ?? targetSession();
                const directory = await directoryOf(sessionID);
                if (rel === undefined) {
                  await ack(t("ls_stale"));
                  return;
                }
                if (!sessionID || !directory) {
                  await ack(t("ls_file_missing"));
                  return;
                }
                const full = safeResolve(directory, rel);
                if (!full || !existsSync(full)) {
                  await ack(t("ls_file_gone"));
                  return;
                }
                const fs = await import("node:fs");
                const size = fs.statSync(full).size;
                const name = full.split(/[\\/]/).pop() ?? "archivo";
                if (!isTextLike(name, "", Buffer.alloc(0))) {
                  await ack(t("ls_binary"));
                  return;
                }
                if (size > 200 * 1024) {
                  await ack(t("ls_too_big_attach"));
                  return;
                }
                const content = decodeText(fs.readFileSync(full));
                pendingAttach.set(sessionID, { uri: `data:text/plain;filename="${encodeURIComponent(name)}";base64,${Buffer.from(content, "utf8").toString("base64")}`, name });
                await ack(t("ls_attached"));
                return;
              }
              if (payload.startsWith("wtnew:")) {
                // wtnew:<key> — open a new session in that worktree.
                const dir = lsKeys.get(payload.slice(6));
                if (dir === undefined) {
                  await ack(t("worktree_stale"));
                  return;
                }
                await ack(t("worktree_opening"));
                try {
                  const created = await forms.request<{ id?: string }>("POST", "/session", { location: { directory: dir } });
                  if (!created?.id) throw new Error("sin id");
                  const name = dir.split(/[\\/]/).filter(Boolean).pop() ?? dir;
                  if (cq.message) {
                    await telegram
                      .sendMessage(
                        cq.message.chat.id,
                        t("new_session_bare", { id: created.id.slice(0, 22), name: escapeHtml(name) }),
                        { parseMode: "HTML", messageThreadId: cq.message.message_thread_id },
                      )
                      .catch(() => undefined);
                  }
                } catch (error) {
                  log("WARN", "worktree session", safe(error));
                  await ack(t("worktree_open_fail"));
                }
                return;
              }
              if (payload.startsWith("perm2:")) {
                // Real contract (from @opencode/client): POST to
                // /session/{sid}/permission/{requestID}/reply with
                // { decision: "once" | "always" | "reject" } — and a 204
                // with an empty body IS the success, so only a throw counts.
                const [, outcome, requestId] = payload.split(":");
                const req = permissionRequests.get(requestId);
                if (!req) { await ack(t("perm_already_resolved")); return; }
                permissionRequests.delete(requestId);
                const decision = outcome === "always" ? "always" : outcome === "ok" ? "once" : "reject";
                await ack(decision === "reject" ? t("perm_rejected") : decision === "always" ? t("perm_always") : t("perm_once_ok"));
                if (cq.message) {
                  const label = decision === "reject"
                    ? "\u2716 Permiso rechazado desde Telegram."
                    : decision === "always"
                      ? "\u2705 Aprobado siempre (el server recuerda la regla)."
                      : "\u2705 Aprobado por esta vez.";
                  await telegram.editMessageText(cq.message.chat.id, cq.message.message_id, label, { parseMode: "HTML" }).catch(() => undefined);
                }
                if (await forms.connect()) {
                  try {
                    await forms.request(
                      "POST",
                      "/session/" + encodeURIComponent(req.sessionID) + "/permission/" + encodeURIComponent(requestId) + "/reply",
                      { decision },
                    );
                    log("INFO", "permiso resuelto desde TG: " + decision);
                  } catch (error) { log("WARN", "perm resolve", safe(error)); }
                }
                return;
              }
              if (payload.startsWith("form:")) {
                // form:<fieldIndex>:<optionIndex>:<formID> — the id rides last so
                // a ':' inside it cannot shift the parse.
                log("INFO", `callback form de ${String(from)}: ${payload.slice(0, 80)} (msg ${String(cq.message?.message_id ?? "?")})`);
                const parts = payload.split(":");
                const fieldIndex = Number(parts[1]);
                const optionIndex = Number(parts[2]);
                const formID = parts.slice(3).join(":");
                const entry = formID ? openForms.get(formID) : undefined;
                if (!entry) {
                  await ripDeadButtons(formID);
                  return;
                }
                if (entry.settled) {
                  await ack(t("form_already_answered"));
                  return;
                }
                const choice = entry.choices.find((c) => c.fieldIndex === fieldIndex);
                const option = choice?.options[optionIndex];
                if (choice && option) {
                  // Multi-question forms accumulate one field at a time and
                  // only settle when every option-bearing field is answered —
                  // a single-question form settles immediately as it always did.
                  const partial = answerFor(choice, option);
                  if (entry.choices.length === 1) {
                    const result = await settleForm(entry, partial, option.label);
                    await ack(
                      result === "ok"
                        ? "Respondido"
                        : result === "already"
                          ? "Ya estaba respondida"
                          : result === "dry"
                            ? "(dry) anotado"
                            : "No se pudo responder",
                    );
                  } else {
                    entry.answers = mergeAnswer(entry.answers, partial);
                    if (formComplete(entry.choices, entry.answers)) {
                      const chosen = formatFullAnswer(entry.choices, entry.answers);
                      const result = await settleForm(entry, entry.answers, chosen);
                      await ack(
                        result === "ok"
                          ? "Respondido"
                          : result === "already"
                            ? "Ya estaba respondida"
                            : "No se pudo responder",
                      );
                    } else {
                      await rerenderForm(entry);
                      const done = entry.choices.filter((c) => entry.answers[c.fieldKey] !== undefined).length;
                      await ack(`Pregunta respondida (${done}/${entry.choices.length})`);
                    }
                  }
                } else {
                  log("WARN", `callback form sin opción: field=${parts[1]} option=${parts[2]} en ${formID}`);
                  await ack(t("form_invalid_option"));
                }
                return;
              }
              if (payload.startsWith("formfree:")) {
                // "✏️ Otra respuesta": arm (or disarm) the next thread message
                // as a free-text answer.
                const formID = payload.slice("formfree:".length);
                const entry = formID ? openForms.get(formID) : undefined;
                if (!entry) {
                  await ripDeadButtons(formID);
                  return;
                }
                if (entry.settled) {
                  await ack(t("form_already_answered"));
                  return;
                }
                entry.freeText = !entry.freeText;
                await ack(
                  entry.freeText
                    ? "Modo texto libre: tu próximo mensaje se toma tal cual como respuesta"
                    : "Modo texto cancelado",
                );
                return;
              }
              if (payload.startsWith("menu:")) {
                await ack();
                if (payload === "menu:close" && cq.message) {
                  await telegram.deleteMessage(cq.message.chat.id, cq.message.message_id).catch(() => undefined);
                }
                return;
              }
              if (payload.startsWith("loc:")) {
                // loc:<code> — the picker's tap. Switch and answer in the
                // language just chosen: the ack IS the proof it took.
                const code = payload.slice(4);
                if (!setLocale(code)) {
                  await ack(t("locale_unknown", { wanted: escapeHtml(code), available: availableLocales().join(", ") }));
                  return;
                }
                await ack(t("locale_switched", { locale: code }));
                if (cq.message) {
                  await telegram
                    .editMessageText(cq.message.chat.id, cq.message.message_id, t("locale_switched", { locale: code }), {
                      parseMode: "HTML",
                    })
                    .catch(() => undefined);
                }
                return;
              }
              if (payload.startsWith("cmd:")) {
                const name = payload.slice(4);
                await ack();
                const thread = cq.message?.message_thread_id;
                const menuSession = thread !== undefined ? topicStore?.sessionOf(thread) : undefined;
                // The menu is ephemeral: close it and let the command answer.
                if (cq.message) {
                  await telegram.deleteMessage(cq.message.chat.id, cq.message.message_id).catch(() => undefined);
                }
                await handleCommand(name, "", menuSession);
                return;
              }
              if (payload.startsWith("mpv:")) {
                const state = modelCards.get(cq.message?.message_id);
                const prov = state?.providers[Number(payload.slice(4))];
                if (!state || !prov) {
                  await ack(t("models_stale"));
                  return;
                }
                state.chosen = prov.id;
                state.search = "";
                if (cq.message) {
                  const { text, keyboard } = modelPickerPage(state, 0);
                  await telegram
                    .editMessageText(cq.message.chat.id, cq.message.message_id, text, {
                      parseMode: "HTML",
                      replyMarkup: { inline_keyboard: keyboard },
                    })
                    .catch((error) => log("WARN", "model picker", safe(error)));
                }
                await ack();
                return;
              }
              if (payload.startsWith("mpb:")) {
                const state = modelCards.get(cq.message?.message_id);
                if (!state) {
                  await ack(t("models_stale"));
                  return;
                }
                state.chosen = undefined;
                state.search = "";
                if (cq.message) {
                  const { text, keyboard } = modelProviderPage(state);
                  await telegram
                    .editMessageText(cq.message.chat.id, cq.message.message_id, text, {
                      parseMode: "HTML",
                      replyMarkup: { inline_keyboard: keyboard },
                    })
                    .catch((error) => log("WARN", "model picker", safe(error)));
                }
                await ack();
                return;
              }
              if (payload.startsWith("mp:")) {
                const state = modelCards.get(cq.message?.message_id);
                if (!state) {
                  await ack(t("models_stale"));
                  return;
                }
                if (payload !== "mp:noop" && cq.message) {
                  const page = Number(payload.slice(3));
                  const { text, keyboard } = modelPickerPage(state, Number.isFinite(page) ? page : 0);
                  await telegram
                    .editMessageText(cq.message.chat.id, cq.message.message_id, text, {
                      parseMode: "HTML",
                      replyMarkup: { inline_keyboard: keyboard },
                    })
                    .catch((error) => log("WARN", "model picker", safe(error)));
                }
                await ack();
                return;
              }
              if (payload.startsWith("mpk:")) {
                const state = modelCards.get(cq.message?.message_id);
                const chosen = state?.items[Number(payload.slice(4))];
                const target = state?.target;
                // Wizard mode: the pick becomes the task's model, not a switch.
                if (state?.taskMode && taskWizard && chosen) {
                  const tsession = cq.message?.message_thread_id !== undefined ? topicStore?.sessionOf(cq.message.message_thread_id) : undefined;
                  taskWizard.model = { id: chosen.id, providerID: chosen.providerID };
                  taskWizard.step = "type";
                  writeDraft(taskWizard);
                  modelCards.drop(cq.message?.message_id);
                  await ack(t("models_chosen", { name: chosen.name ?? chosen.id }));
                  if (cq.message) {
                    await telegram
                      .editMessageText(cq.message.chat.id, cq.message.message_id, "\u{1F9F1} Modelo: <code>" + escapeHtml(chosen.id) + "</code>", { parseMode: "HTML" })
                      .catch(() => undefined);
                  }
                  await wizardAsk(tsession);
                  return;
                }
                if (!chosen || !target) {
                  await ack(t("models_stale"));
                  return;
                }
                if (!(await forms.connect())) {
                  await ack(t("api_down_ack"));
                  return;
                }
                try {
                  await forms.request("POST", `/session/${encodeURIComponent(target)}/model`, {
                    model: { id: chosen.id, providerID: chosen.providerID },
                  });
                  if (cq.message) {
                    await telegram
                      .editMessageText(
                        cq.message.chat.id,
                        cq.message.message_id,
                        `\u{1F9F1} Modelo \u2192 <b>${escapeHtml(chosen.name ?? chosen.id)}</b> <code>${escapeHtml(chosen.id)}</code>`,
                        { parseMode: "HTML" },
                      )
                      .catch(() => undefined);
                  }
                  await ack(t("models_changed"));
                  // A settled pick must not be re-applied by a second tap on
                  // the same card.
                  modelCards.drop(cq.message?.message_id);
                } catch (error) {
                  log("WARN", "model set", safe(error));
                  await ack(t("models_change_fail"));
                }
                return;
              }
              if (payload.startsWith("skl:")) {
                const chosen = skillItems[Number(payload.slice(4))];
                if (!chosen) {
                  await ack(t("skills_stale"));
                  return;
                }
                skillArmed = chosen;
                await ack(t("skill_chosen", { name: chosen.name }));
                return;
              }
              if (payload.startsWith("task:")) {
                const [, action, arg] = payload.split(":");
                const task = arg !== undefined && arg !== "save" && arg !== "cancel" ? readTasks().find((t) => t.id === arg) : undefined;
                if (action === "proj") {
                  const chosen = projectCards.get(cq.message?.message_id)?.[Number(arg)];
                  const tsession = cq.message?.message_thread_id !== undefined ? topicStore?.sessionOf(cq.message.message_thread_id) : undefined;
                  if (taskWizard && chosen) {
                    projectCards.drop(cq.message?.message_id);
                    taskWizard.directory = chosen.directory;
                    taskWizard.directoryName = chosen.name;
                    taskWizard.step = "model";
                    writeDraft(taskWizard);
                    await ack();
                    if (cq.message) {
                      await telegram
                        .editMessageText(cq.message.chat.id, cq.message.message_id, "(3/6) \u{1F4C1} " + escapeHtml(chosen.name), { parseMode: "HTML" })
                        .catch(() => undefined);
                    }
                    await wizardAsk(tsession);
                  } else {
                    await ack(t("newtask_stale"));
                  }
                  return;
                }
                if (action === "model") {
                  const tsession = cq.message?.message_thread_id !== undefined ? topicStore?.sessionOf(cq.message.message_thread_id) : undefined;
                  if (!taskWizard) { await ack(t("newtask_stale")); return; }
                  if (arg === "default") taskWizard.model = undefined;
                  // "inherit" already pre-loaded the session's model in the ask.
                  taskWizard.step = "type";
                  writeDraft(taskWizard);
                  await ack(arg === "pick" ? t("models_pick_prompt") : t("models_picked_ack"));
                  if (arg === "pick") {
                    // Reuse the /models mirror: desktop-shown models only.
                    if (!(await forms.connect())) { await ack(t("api_down_ack")); return; }
                    const [all, providers] = await Promise.all([
                      forms.request<Array<{ id: string; modelID?: string; providerID: string; name?: string; enabled?: boolean; status?: string }>>("GET", "/model").catch(() => undefined),
                      forms.request<Array<{ id?: string; name?: string; activation?: string }>>("GET", "/provider").catch(() => undefined),
                    ]);
                    const provNames = new Map(
                      (Array.isArray(providers) ? providers : []).filter((p) => p.id !== undefined).map((p) => [p.id as string, p.name ?? (p.id as string)]),
                    );
                    const toggles = await desktopVisibleModels();
                    const showKeys = new Set<string>();
                    if (toggles.length > 0) {
                      for (const tg of toggles) if (tg.visible) showKeys.add(tg.providerID + "\u0000" + tg.modelID);
                    } else {
                      for (const p of configProviders()) {
                        for (const m of p.models) if (!m.disabled) showKeys.add(p.id + "\u0000" + m.key);
                      }
                    }
                    const byKey = new Map((Array.isArray(all) ? all : []).map((x) => [x.providerID + "\u0000" + (x.modelID ?? x.id), x]));
                    const items: Array<{ id: string; modelID?: string; providerID: string; name?: string; enabled?: boolean; status?: string }> = [];
                    for (const key of showKeys) {
                      const known = byKey.get(key);
                      if (known) items.push(known);
                      else {
                        const [pid, modelID] = key.split("\u0000");
                        if (modelID) items.push({ id: pid + "/" + modelID, modelID, providerID: pid });
                      }
                    }
                    items.sort((a, b) => a.id.localeCompare(b.id));
                    const wizardPicker: ModelPicker = {
                      target: tsession ?? "",
                      items,
                      providers: [...new Set(items.map((m) => m.providerID))].map((pid) => ({ id: pid, name: provNames.get(pid) ?? pid })).sort((a, b) => a.name.localeCompare(b.name)),
                      search: "",
                      taskMode: true,
                    };
                    if (cq.message && chatId !== undefined) {
                      const { text, keyboard } = modelProviderPage(wizardPicker);
                      modelCards.set(cq.message.message_id, wizardPicker);
                      await telegram
                        .editMessageText(cq.message.chat.id, cq.message.message_id, text, { parseMode: "HTML", replyMarkup: { inline_keyboard: keyboard } })
                        .catch(() => undefined);
                    }
                  } else {
                    await wizardAsk(tsession);
                  }
                  return;
                }
                if (action === "stype") {
                  const type = arg as TaskSchedule["type"];
                  const tsession = cq.message?.message_thread_id !== undefined ? topicStore?.sessionOf(cq.message.message_thread_id) : undefined;
                  if (!taskWizard || !type) { await ack(t("newtask_stale")); return; }
                  taskWizard.scheduleType = type;
                  taskWizard.step = "detail";
                  writeDraft(taskWizard);
                  await ack();
                  await wizardAsk(tsession);
                  return;
                }
                if (action === "save") {
                  if (!taskWizard || !taskWizard.schedule || !taskWizard.directory) { await ack(t("newtask_stale")); return; }
                  const task: Task = {
                    id: newTaskId(),
                    name: taskWizard.name,
                    prompt: taskWizard.prompt,
                    directory: taskWizard.directory,
                    ...(taskWizard.model ? { model: taskWizard.model } : {}),
                    schedule: taskWizard.schedule,
                    enabled: true,
                    createdAt: Date.now(),
                    nextRun: nextRunOf(taskWizard.schedule),
                    lastRun: 0,
                    lastStatus: "",
                  };
                  const all = readTasks();
                  all.push(task);
                  writeTasks(all);
                  taskWizard = undefined;
                  clearDraft();
                  await ack(t("newtask_created"));
                  if (cq.message) {
                    const when = fmtDateTime(task.nextRun);
                    await telegram
                      .editMessageText(cq.message.chat.id, cq.message.message_id, t("task_created_card", { name: escapeHtml(task.name), when: escapeHtml(when) }), { parseMode: "HTML" })
                      .catch(() => undefined);
                  }
                  return;
                }
                if (action === "cancel") {
                  taskWizard = undefined;
                  await ack(t("cancelled"));
                  if (cq.message) {
                    await telegram.deleteMessage(cq.message.chat.id, cq.message.message_id).catch(() => undefined);
                  }
                  return;
                }
                if (!task) { await ack(t("tasks_gone")); return; }
                if (!(await forms.connect())) { await ack(t("api_down_ack")); return; }
                if (action === "view") {
                  await ack();
                  if (cq.message) {
                    const when = new Date(task.nextRun).toLocaleString("es-AR");
                    await telegram
                      .editMessageText(
                        cq.message.chat.id,
                        cq.message.message_id,
                        "\u23F0 <b>" + escapeHtml(task.name) + "</b> " + (task.enabled ? "\u{1F7E2}" : "\u26AA") + "\n" +
                          "\u{1F4CB} " + escapeHtml(task.prompt.slice(0, 300)) + "\n" +
                          "\u{1F4C1} " + escapeHtml(task.directory) + "\n" +
                          t("task_next_at", { schedule: escapeHtml(formatSchedule(task.schedule)), when: escapeHtml(when) }) + "\n" +
                          t("task_last_at", { status: task.lastRun > 0 ? escapeHtml(task.lastStatus || t("task_no_status")) : t("task_never") }),
                        { parseMode: "HTML",
                          replyMarkup: { inline_keyboard: [
                            [{ text: t("btn_run_now"), callback_data: "task:run:" + task.id }, { text: task.enabled ? t("btn_task_disable") : t("btn_task_enable"), callback_data: "task:toggle:" + task.id }],
                            [{ text: "\u270F\uFE0F Prompt", callback_data: "task:prompt:" + task.id }],
                            [{ text: t("btn_delete"), callback_data: "task:del:" + task.id }, { text: "\u2B05", callback_data: "task:back" }],
                          ] } },
                      )
                      .catch(() => undefined);
                  }
                  return;
                }
                if (action === "prompt") {
                  // Arm the edit: the next text in this thread becomes the
                  // task's new prompt (checked with a 10-minute window).
                  await ack(t("newtask_prompting"));
                  taskPromptEdit = { id: task.id, name: task.name, threadId: cq.message?.message_thread_id, armedAt: Date.now() };
                  if (cq.message) {
                    await telegram
                      .sendMessage(
                        cq.message.chat.id,
                        "\u270F\uFE0F " + t("task_prompt_card", { name: escapeHtml(task.name), current: escapeHtml(task.prompt.slice(0, 500)) }),
                        { parseMode: "HTML", messageThreadId: cq.message.message_thread_id },
                      )
                      .catch((error) => log("WARN", "task prompt arm", safe(error)));
                  }
                  return;
                }
                if (action === "run") {
                  await ack(t("ack_running_plain"));
                  try {
                    await runTaskNow(task);
                    const all = readTasks();
                    const x = all.find((t) => t.id === task.id);
                    if (x) { x.lastRun = Date.now(); x.lastStatus = "ok (manual)"; writeTasks(all); }
                  } catch (error) {
                    log("WARN", "task run", safe(error));
                    await ack(t("newtask_run_fail"));
                  }
                  return;
                }
                if (action === "toggle") {
                  const all = readTasks();
                  const x = all.find((t) => t.id === task.id);
                  if (x) {
                    x.enabled = !x.enabled;
                    if (x.enabled) x.nextRun = nextRunOf(x.schedule);
                    writeTasks(all);
                    await ack(x.enabled ? t("task_on") : t("task_off"));
                  } else await ack(t("gone"));
                  return;
                }
                if (action === "del") {
                  writeTasks(readTasks().filter((t) => t.id !== task.id));
                  await ack(t("newtask_deleted"));
                  if (cq.message) {
                    await telegram.deleteMessage(cq.message.chat.id, cq.message.message_id).catch(() => undefined);
                  }
                  return;
                }
                if (action === "back") {
                  await ack();
                  if (cq.message) {
                    const list = readTasks();
                    const keyboard = list.map((t) => [{ text: t.name.slice(0, 24) + (t.enabled ? "" : " (off)"), callback_data: "task:view:" + t.id }]);
                    await telegram
                      .editMessageText(cq.message.chat.id, cq.message.message_id, t("tasks_list_back", { n: list.length }), { parseMode: "HTML", replyMarkup: { inline_keyboard: keyboard } })
                      .catch(() => undefined);
                  }
                  return;
                }
                await ack(t("action_unknown"));
                return;
              }
              if (payload.startsWith("ib:")) {
                // Inbox item buttons: reorder, steer, cancel, replace — the
                // same handle the desktop gives its pending-message list.
                // The state is THIS message's card: a /queue opened in
                // another thread never rebinds these buttons.
                const [, action, indexText] = payload.split(":");
                const index = Number(indexText);
                const card = inboxCards.get(cq.message?.message_id);
                const session = card?.session;
                if (!card || !session) {
                  await ack(t("queue_stale"));
                  return;
                }
                if (!(await forms.connect())) {
                  await ack(t("api_down_ack"));
                  return;
                }
                const rerender = async (): Promise<void> => {
                  if (!cq.message) return;
                  const { text, keyboard } = renderInboxList(card);
                  await telegram
                    .editMessageText(cq.message.chat.id, cq.message.message_id, text, {
                      parseMode: "HTML",
                      replyMarkup: { inline_keyboard: keyboard },
                    })
                    .catch((error) => log("WARN", "inbox render", safe(error)));
                };
                if (action === "order") {
                  // Replay the arranged sequence: cancel the pending items on
                  // the server, then steer each text back in exactly this
                  // order — the agent receives them in the user's arrangement.
                  const ordered = [...card.items];
                  for (const entry of ordered) {
                    await forms
                      .request("DELETE", `/session/${encodeURIComponent(session)}/inbox/${encodeURIComponent(entry.id)}`)
                      .catch((error) => log("WARN", "inbox order cancel", safe(error)));
                  }
                  for (const entry of ordered) {
                    await forms
                      .request("POST", `/session/${encodeURIComponent(session)}/prompt`, { text: entry.text, delivery: "steer" })
                      .catch((error) => log("WARN", "inbox order send", safe(error)));
                  }
                  await ack(`Enviados ${ordered.length} en el orden elegido`);
                  if (cq.message) {
                    await telegram
                      .editMessageText(cq.message.chat.id, cq.message.message_id, `\u25B6 ${ordered.length} mensaje(s) enviados en el orden elegido.`, { parseMode: "HTML" })
                      .catch(() => undefined);
                  }
                  inboxCards.drop(cq.message?.message_id);
                  return;
                }
                const item = card.items[index];
                if (!item) {
                  await ack(t("queue_stale"));
                  return;
                }
                if (action === "up" || action === "down") {
                  const to = action === "up" ? index - 1 : index + 1;
                  if (to >= 0 && to < card.items.length) {
                    const [moved] = card.items.splice(index, 1);
                    card.items.splice(to, 0, moved);
                    await rerender();
                  }
                  await ack(t("queue_reordered"));
                  return;
                }
                if (action === "steer") {
                  try {
                    // A 204/empty body is the normal answer for this PATCH:
                    // the item leaving the inbox IS the success, not the
                    // body. Only a thrown non-2xx is a real "could not".
                    await forms.request(
                      "PATCH",
                      `/session/${encodeURIComponent(session)}/inbox/${encodeURIComponent(item.id)}`,
                      { delivery: "steer" },
                    );
                    await ack(t("queue_steered"));
                  } catch (error) {
                    log("WARN", "inbox steer", safe(error));
                    await ack(t("queue_steer_fail", { detail: String((error as Error).message).slice(0, 120) }));
                  }
                  return;
                }
                if (action === "cancel") {
                  await forms
                    .request("DELETE", `/session/${encodeURIComponent(session)}/inbox/${encodeURIComponent(item.id)}`)
                    .catch((error) => log("WARN", "inbox cancel", safe(error)));
                  card.items.splice(index, 1);
                  if (card.items.length === 0) {
                    inboxCards.drop(cq.message?.message_id);
                    if (cq.message) {
                      await telegram
                        .editMessageText(cq.message.chat.id, cq.message.message_id, t("inbox_emptied"), { parseMode: "HTML" })
                        .catch(() => undefined);
                    }
                    await ack(t("cancelled"));
                  } else {
                    await rerender();
                    await ack(t("cancelled"));
                  }
                  return;
                }
                if (action === "edit") {
                  inboxEdit = { id: item.id, text: item.text, session };
                  await ack(`Reemplazo armado \u2014 mand\u00e1 el texto nuevo para: "${item.text.slice(0, 60)}"`);
                  return;
                }
                await ack(t("action_unknown"));
                return;
              }
              if (payload.startsWith("proj:")) {
                const chosen = projectCards.get(cq.message?.message_id)?.[Number(payload.slice(5))];
                if (!chosen) {
                  await ack(t("projects_stale"));
                  return;
                }
                if (!(await forms.connect())) {
                  await ack(t("api_down_ack"));
                  return;
                }
                try {
                  const created = await forms.request<{ id?: string }>("POST", "/session", {
                    location: { directory: chosen.directory },
                  });
                  if (!created?.id) {
                    await ack(t("session_create_fail"));
                    return;
                  }
                  const id = created.id;
                  log("INFO", `sesi\u00f3n nueva ${id.slice(0, 18)} en ${chosen.directory}`);
                  if (cq.message) {
                    await telegram
                      .editMessageText(
                        cq.message.chat.id,
                        cq.message.message_id,
                        t("projects_session_created", { id: id.slice(0, 22), name: escapeHtml(chosen.name), full: id }),
                        { parseMode: "HTML" },
                      )
                      .catch(() => undefined);
                  }
                  await ack(t("session_created"));
                } catch (error) {
                  log("WARN", "project session", safe(error));
                  await ack(t("session_create_fail"));
                }
                return;
              }              if (payload.startsWith("ag:")) {
                const card = agentCards.get(cq.message?.message_id);
                const chosen = card?.items[Number(payload.slice(3))];
                const target = card?.target;
                if (!chosen || !target) {
                  await ack(t("agents_stale"));
                  return;
                }
                if (!(await forms.connect())) {
                  await ack(t("api_down_ack"));
                  return;
                }
                try {
                  await forms.request("POST", `/session/${encodeURIComponent(target)}/agent`, { agent: chosen.id });
                  if (cq.message) {
                    await telegram
                      .editMessageText(
                        cq.message.chat.id,
                        cq.message.message_id,
                        `\u{1F916} Agente \u2192 <code>${escapeHtml(chosen.name ?? chosen.id)}</code>`,
                        { parseMode: "HTML" },
                      )
                      .catch(() => undefined);
                  }
                  await ack(t("agents_changed"));
                } catch (error) {
                  log("WARN", "agent set", safe(error));
                  await ack(t("agents_change_fail"));
                }
                return;
              }
              if (payload.startsWith("perm:")) {
                await ack();
                const [, reqId, indexText] = payload.split(":");
                const index = Number(indexText);
                const entry = reqId === undefined ? undefined : pendingPermissions.get(reqId);
                const resolve = reqId === undefined ? undefined : permissionResolvers.get(reqId);
                if (entry && resolve) {
                  const option = entry.options[index];
                  pendingPermissions.delete(reqId);
                  permissionResolvers.delete(reqId);
                  if (option) {
                    resolve({ outcome: { outcome: "selected", optionId: option.optionId } });
                    if (entry.messageId !== undefined) {
                      await telegram
                        .editMessageText(chatId ?? 0, entry.messageId, `\u2705 ${escapeHtml(option.name)}`, { parseMode: "HTML" })
                        .catch((error) => log("WARN", "perm edit", safe(error)));
                    }
                  } else {
                    resolve({ outcome: { outcome: "cancelled" } });
                  }
                }
                return;
              }
              await ack();
            }
          },
          (error) => log("WARN", "poll", safe(error)),
        )
        .catch((error) => log("ERROR", "longPoll", safe(error)));
    }

    async function start(): Promise<void> {
      if (started) return;
      started = true;
      // A re-promoted instance may be reusing a transport stopped earlier —
      // the hand-over picks any live member, and its Telegram could be the
      // corpse that deposal left behind. Revive it before anything talks
      // through it, or setMyCommands fails with "aborted" and the mirror
      // stays silent while the seat is held (measured 2026-10-08).
      telegram.revive();
      if (!dry && chatId !== undefined) {
        await telegram
          .setCommandsEverywhere(commands, config.allowedUsers)
          .catch((error) => log("WARN", "setMyCommands", safe(error)));
      }
      renderer.start();
      startTaskTimer();
      startPump();
      startPoll();
      log("INFO", `ready (${config.mode})`);
    }

    async function stop(): Promise<void> {
      if (!started) return;
      started = false;
      log("INFO", "cleanup");
      subscription.abort();
      renderer.stop();
      stopTaskTimer();
      // Await the transport first: its poll socket outlives the abort signal
      // by a beat, and a replacement leader starting inside that window
      // collides at Telegram with HTTP 409. Settling `poll` afterwards only
      // knows the loop exited, not that the socket closed.
      await telegram.stop();
      await Promise.allSettled([pump, poll, acp.stop()]);
      pump = undefined;
      poll = undefined;
    }

    const seat = await joinBridge(
      { start, stop, alive: () => !streamClosed && (dry ? true : telegram.pollAlive()) },
      config.mode,
    );
    // The watchdog timer lives here, outside joinBridge, so the tick is a
    // plain function tests can drive through the exact interleavings that
    // once put five leaders on one token.
    const timer = setInterval(
      () => void seat.tick().catch((error) => log("ERROR", "watchdog", safe(error))),
      LOCK_INTERVAL,
    );
    return async () => {
      clearInterval(timer);
      await seat.cleanup();
    };
  },
};
