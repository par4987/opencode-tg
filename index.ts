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
import { TopicResolver, TopicStore } from "./src/topics.js";
import { escapeHtml } from "./src/render.js";
import { readSessionMeta } from "./src/session-meta.js";
import { readHistory, jsonlPath, type HistoryEntry } from "./src/history.js";
import { FormClient, choicesOf, answerFor, answerFree, parseFreeCommand, pickOption, formatAnswer, mergeAnswer, formComplete, formatFullAnswer, type FormInfo, type FormOption, type FormChoice } from "./src/forms.js";
import type { Plugin } from "@opencode/plugin";

type Context = Plugin.Context;

const HELP = [
  "\u{1F916} opencode-tg \u2014 OpenCode en Telegram",
  "",
  "/help \u2014 esta ayuda",
  "/sessions \u2014 sesiones vistas desde el servidor (\u{1F3AF} destino, \u{1F4E1} vigilada, \u{1F7E2} activa)",
  "/use <id> \u2014 a qu\u00e9 sesi\u00f3n van tus mensajes",
  "/watch <id|all|off> \u2014 qu\u00e9 sesiones se espejan en el chat",
  "/send <id?> <texto> \u2014 manda un prompt a una sesi\u00f3n",
  "/txt <texto> \u2014 responde la pregunta abierta con texto libre",
  "",
  "Multimedia: mand\u00e1 una foto al hilo y llega al agente como imagen",
  "(con su caption como texto). Los mensajes durante un turno en marcha van",
  "al inbox del server y salen solos al terminar \u2014 /queue los lista.",
  "/menu \u2014 panel de comandos con botones",
  "/running \u2014 sesiones corriendo ahora",
  "/usage <id?> \u2014 tokens y costo de una sesi\u00f3n",
  "/mcp \u2014 estado de los servidores MCP",
  "/models <texto?> \u2014 cambiar el modelo de la sesi\u00f3n (espejo de tu opencode.jsonc)",
  "/agents \u2014 cambiar el agente de la sesi\u00f3n",
  "/projects \u2014 sesi\u00f3n nueva en otro proyecto (picker con los m\u00e1s recientes)",
  "/tasks \u2014 tareas programadas \u00b7 /newtask crea una paso a paso",
  "/new \u2014 sesi\u00f3n nueva en el proyecto actual",
  "/skill <id> <texto> \u2014 corre un prompt con la skill cargada",
  "/archive \u00b7 /unarchive \u00b7 /delthread \u2014 archivar, reabrir o borrar el hilo de una sesi\u00f3n",
  "/compact \u2014 compactar el contexto de la sesi\u00f3n",
  "/usagestats <d\u00edas?> \u2014 tokens y costo de los \u00faltimos d\u00edas",
  "/ls <carpeta?> \u2014 navegar los archivos del proyecto: toc\u00e1 para descargar, \u{1F4CE} adjunta al pr\u00f3ximo",
  "/find <texto> \u2014 buscar archivos por nombre en el proyecto; toc\u00e1 un resultado para descargarlo",
  "/git \u2014 qu\u00e9 toc\u00f3 el agente en el proyecto (status + diff descargable)",
  "/revert \u2014 deshacer el \u00faltimo turno de una sesi\u00f3n (con confirmaci\u00f3n)",
  "/context \u2014 tokens, costo, l\u00edmite del modelo y compactaciones de una sesi\u00f3n",
  "/worktree \u2014 worktrees del proyecto: toc\u00e1 para abrir sesi\u00f3n ah\u00ed \u00b7 /worktree new <n>",
  "/fork \u2014 bifurcar una sesi\u00f3n para probar ideas sin ensuciar la original",
  "/export \u2014 descargar el transcript completo de una sesi\u00f3n como JSON",
  "/config \u2014 config del proyecto \u00b7 /config model <p/m> cambia el default de sesiones nuevas",
  "Respond\u00e9 a un mensaje con reply para citarlo en tu prompt",

  "/skills \u2014 skills instaladas en OpenCode",
  "/status \u2014 estado del puente",
  "",
  "Cada sesi\u00f3n tiene su propio hilo (topic) si tu bot tiene activado el modo",
  "temas en @BotFather. Escrib\u00ed dentro del hilo de una sesi\u00f3n para hablarle",
  "a ella, sin elegir nada. Si no est\u00e1 activado, todo llega al chat \u00fanico y",
  "cada mensaje lleva un punto de color + el t\u00edtulo de su sesi\u00f3n.",
].join("\n");

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
  if (seconds < 60) return "hace un momento";
  if (seconds < 3600) return `hace ${Math.floor(seconds / 60)} min`;
  if (seconds < 86_400) return `hace ${Math.floor(seconds / 3600)} h`;
  return `hace ${Math.floor(seconds / 86_400)} d`;
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

async function joinBridge(instance: BridgeInstance, mode: Mode): Promise<() => Promise<void>> {
  const reg = registry();
  reg.members.add(instance);
  reg.memberModes.set(instance, mode);

  // Track whether THIS instance ever became the leader, so its cleanup always
  // stops what it started — even if it was since replaced. Without that, a
  // leader that is ousted between `start()` and cleanup returns early and its
  // longPoll keeps running next to the new leader's: one token, two polls,
  // Telegram answers both with HTTP 409 forever.
  let started = false;
  const guarded: BridgeInstance = {
    start: async () => {
      await instance.start();
      started = true;
    },
    stop: async () => {
      if (!started) return;
      started = false;
      await instance.stop();
    },
    alive: () => started && (instance.alive ? instance.alive() : true),
  };
  // A hand-over must install the same object the registry compares leaders
  // against (`reg.leader === guarded`), so keep raw -> wrapper mapped.
  reg.wrappers.set(instance, guarded);

  // Live mode needs one bridge *across processes*, not just within this one:
  // the file lock is what keeps a second OpenCode from polling the same token.
  const needsLock = mode === "live";
  if (needsLock) ensureLockDir();

  let timer: ReturnType<typeof setInterval> | undefined;

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
    // Keep proving we are alive, and step down if another process took the
    // lock from us — the file is the arbiter, not our own belief that we won.
    // Also check our own stream: the pump can end silently when OpenCode
    // dismantles the instance, and a dead leader must make room rather than
    // hold the lock while pumping nothing.
    timer = setInterval(() => {
      if (reg.leader !== guarded) return;
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
        log("WARN", "líder muerto: el stream se cerró; cediendo el liderazgo");
        reg.leader = undefined;
        reg.leaderMode = undefined;
        if (needsLock) releaseLock();
        void guarded.stop().catch((error) => log("ERROR", "stop del líder muerto", safe(error)));
        // Hand the seat to a *different* live member: picking ourselves would
        // restart the same dead instance and loop forever.
        const next = [...reg.members].find((member) => member !== instance);
        if (!next) return;
        const wrapper = reg.wrappers.get(next);
        if (!wrapper) return;
        reg.leader = wrapper;
        reg.leaderMode = reg.memberModes.get(next);
        log("INFO", "traspaso de liderazgo a otra instancia");
        wrapper.start().catch((error) => {
          reg.leader = undefined;
          reg.leaderMode = undefined;
          log("ERROR", "traspaso", safe(error));
        });
        return;
      }
      if (needsLock) heartbeat();
    }, LOCK_INTERVAL);
  } else {
    const reason = reg.leader ? "líder en este proceso" : "líder en otro proceso";
    log("INFO", `instancia en espera (${reason}; ${reg.members.size} en el proceso)`);
  }

  return async () => {
    reg.members.delete(instance);
    if (timer) clearInterval(timer);
    if (reg.leader === guarded) {
      reg.leader = undefined;
      reg.leaderMode = undefined;
      await guarded.stop();
      if (needsLock) releaseLock();
      const next = [...reg.members].find((member) => member !== instance);
      if (!next) return;
      const wrapper = reg.wrappers.get(next);
      if (!wrapper) return;
      reg.leader = wrapper;
      reg.leaderMode = reg.memberModes.get(next);
      log("INFO", "traspaso de liderazgo a otra instancia");
      try {
        await wrapper.start();
      } catch (error) {
        reg.leader = undefined;
        reg.leaderMode = undefined;
        log("ERROR", "traspaso", safe(error));
      }
    } else {
      // Not the leader, but we may have started as one before being ousted —
      // shut our transport down rather than leaving a stray poller.
      await guarded.stop().catch((error) => log("ERROR", "stop de instancia relevada", safe(error)));
    }
  };
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
      : new Telegram({ token: config.token });

    // ── write side: prompts and permission answers ───────────────────────────
    // Mirroring is read-only by design; the ACP client is what lets the chat
    // push a prompt back into a session and approve/deny a tool call.
    const acp = new AcpClient();
    const pendingPermissions = new Map<string, { messageId?: number; options: RequestPermissionParams["options"] }>();

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
     * selector. One picker at a time: a new /models overwrites the previous
     * one, and a restart empties it — stale taps say so plainly.
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
    let modelPicker: ModelPicker | undefined;
    let agentPickerItems: ApiAgent[] = [];
    /** Projects behind the last /projects picker, freshest first. */
    let projectsPicker: Array<{ directory: string; name: string; updated?: number }> = [];
    /** The last /queue listing, so its buttons can address an item by index. */
    let inboxItems: Array<{ id: string; text: string }> = [];
    let inboxThread: string | undefined;
    /** Armed by the edit button: the next message replaces that inbox item. */
    let inboxEdit: { id: string; text: string; session: string } | undefined;
    /**
     * The /queue card: one row per pending message with up/down reorder,
     * steer, cancel and replace — plus the "send in this order" button that
     * replays the arranged sequence into the running turn.
     */
    const renderInboxList = (): { text: string; keyboard: Array<Array<{ text: string; callback_data: string }>> } => {
      const label = inboxThread ? (sessions.get(inboxThread)?.title ?? inboxThread.slice(0, 18)) : "?";
      const lines = inboxItems.map((item, i) => `${i + 1}. ${escapeHtml(item.text.slice(0, 120))}`);
      const keyboard = inboxItems.map((_, i) => [
        ...(i > 0 ? [{ text: "\u2191", callback_data: `ib:up:${i}` }] : []),
        ...(i < inboxItems.length - 1 ? [{ text: "\u2193", callback_data: `ib:down:${i}` }] : []),
        { text: "\u25B6", callback_data: `ib:steer:${i}` },
        { text: "\u2716", callback_data: `ib:cancel:${i}` },
        { text: "\u270F\uFE0F", callback_data: `ib:edit:${i}` },
      ]);
      keyboard.push([{ text: "\u25B6 Enviar en este orden", callback_data: "ib:order:all" }]);
      return {
        text:
          `\u{1F4E5} <b>${escapeHtml(label)}</b> \u2014 ${inboxItems.length} en el inbox.\n` +
          `\u2191\u2193 reordena, \u25B6 adelanta, \u2716 cancela, \u270F\uFE0F reemplaza.\n${lines.join("\n")}`,
        keyboard,
      };
    };



    let agentPickerTarget = "";
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
            (id: string) => {
              const tracked = sessions.get(id);
              // A subagent's topic is born badged: the forum reads "child of
              // something" at a glance, exactly like the desktop's task view.
              return tracked?.parentID ? `\u{1F916} ${tracked.title}` : (tracked?.title ?? "");
            },
            () => {
              // Topics are unavailable for this bot: stop trying and keep the
              // chat as a single stream for the rest of the run.
              log("WARN", "topics: modo hilo no disponible — usando chat unico");
            },
          )
        : null;
    const track = (id: string): TrackedSession => {
      // A closed thread whose session woke up: reopen it and pick the
      // mirroring back up where it left off.
      if (topicStore?.isArchived(id) === true) {
        topicStore.setArchived(id, false);
        const tid = topicStore.get(id);
        if (chatId !== undefined && tid !== undefined) {
          void telegram.reopenForumTopic(chatId, tid).catch((error) => log("WARN", "reopen", safe(error)));
        }
        log("INFO", "sesi\u00f3n revivida \u2014 hilo reabierto: " + id.slice(0, 18));
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
    const SESSION_UNLOADED =
      "\u{1F634} Esa sesi\u00f3n no est\u00e1 activa en el server \u2014 se reinici\u00f3 o la cerraste en la PC.\n" +
      "Abrila en la PC y reintent\u00e1, o cre\u00e1 otra con <code>/new</code>.";

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
        await send("Ruta inv\u00e1lida.", sessionID);
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
      if (cleanRel) rows.push([{ text: "\u2B06 subir", callback_data: `lsg:${lsKeyOf(cleanRel.split("/").slice(0, -1).join("/"))}` }]);
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
      if (rows.length === 0) rows.push([{ text: "(carpeta vac\u00eda)", callback_data: `lsg:${lsKeyOf(cleanRel)}` }]);
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
        rows.push([{ text: "\u270F\uFE0F Otra respuesta", callback_data: `formfree:${entry.formID}` }]);
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
          `\u{1F916} Este hilo es un subagente${parent ? ` de <b>${escapeHtml(parent.title)}</b>` : ""} \u2014 su tarea la maneja la sesi\u00f3n padre. Escribile al hilo del padre.`,
          replyThread,
        );
        return;
      }
      const key = `${target}:${text.slice(0, 40)}`;
      if (sending.has(key)) return;
      sending.add(key);
      const tracked = sessions.get(target);
      const label = tracked?.title ?? "(sin t\u00edtulo)";
      const queued = tracked !== undefined && !tracked.idle;
      if (!quiet) {
        await send(
          queued
            ? `\u{1F4E5} <b>${escapeHtml(label)}</b> est\u00e1 trabajando — encolado. Se env\u00eda solo al terminar el turno.`
            : `\u{1F4E4} a <b>${escapeHtml(label)}</b> <code>${target.slice(0, 18)}\u2026</code>\n${escapeHtml(text.slice(0, 200))}`,
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
          await send(
            "\u{1F6AB} Esa sesi\u00f3n no est\u00e1 activa en el server \u2014 se reinici\u00f3 o la cerraste en la PC, y no se recarga sola.\nAbrila en la PC y reintent\u00e1, o cre\u00e1 otra con <code>/new</code>.",
            replyThread,
          );
        } else {
          await send(`\u274C no se pudo enviar: ${escapeHtml(raw.slice(0, 300))}`, replyThread);
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
        await send("No hay ninguna sesi\u00f3n a la que mandar el prompt. Usa <code>/send <id> <texto></code>");
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
          `\u{1F4E5} <b>${escapeHtml(tracked?.title ?? target.slice(0, 18))}</b> tiene una <b>pregunta pendiente</b>.\n` +
            (answerable
              ? `Respondela con los botones de la pregunta (o mand\u00e1 su n\u00famero, no un texto). `
              : `Se responde en la PC. `) +
            `Tu mensaje qued\u00f3 encolado y se env\u00eda al terminar.`,
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
          await send(`\u26A0\uFE0F ${message.document?.file_name ?? "La foto"} pesa ${(buffer.length / 1024 / 1024).toFixed(1)} MB \u2014 el l\u00edmite es 10.`);
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
     * progress so far â€” the same function serves a fresh step, a re-ask after
     * a bad answer, and the resume after a restart ate the live one.
     */
    const wizardAsk = async (thread?: string): Promise<void> => {
      const w = taskWizard;
      if (!w) return;
      const sofar = w.name ? "\u2705 <b>" + escapeHtml(w.name) + "</b>\n" : "";
      if (w.step === "name") {
        await send("(1/6) \u23F0 \u00bfC\u00f3mo se llama la tarea? (un texto corto \u00b7 <code>/taskcancel</code> aborta)", thread);
        return;
      }
      if (w.step === "prompt") {
        await send(sofar + "(2/6) \u{1F5D3} \u00bfQu\u00e9 tiene que hacer el agente cada vez? (el prompt)", thread);
        return;
      }
      if (w.step === "detail") {
        const hint =
          w.scheduleType === "once" ? "\u00bfFecha y hora? <code>AAAA-MM-DD HH:MM</code> (o <code>DD/MM HH:MM</code>)"
          : w.scheduleType === "daily" ? "\u00bfA qu\u00e9 hora? <code>HH:MM</code>"
          : w.scheduleType === "weekly" ? "\u00bfD\u00eda y hora? <code>lun HH:MM</code> (lun a dom)"
          : "\u00bfCada cu\u00e1ntos minutos?";
        await send(sofar + "(6/6) \u23F1 " + hint, thread);
        return;
      }
      if (w.step === "schedule") {
        if (!(await forms.connect())) {
          await send("La API local no responde \u2014 /newtask de nuevo en un rato.", thread);
          return;
        }
        const projects = await forms.request<Array<{ canonical?: string; time?: { updated?: number } }>>("GET", "/project").catch(() => undefined);
        projectsPicker = (Array.isArray(projects) ? projects : [])
          .filter((p) => typeof p.canonical === "string" && existsSync(p.canonical as string))
          .sort((a, b) => (b.time?.updated ?? 0) - (a.time?.updated ?? 0))
          .slice(0, 12)
          .map((p) => ({
            directory: p.canonical as string,
            name: ((p.canonical as string).split(/[\\/]/).filter(Boolean).pop() ?? p.canonical) as string,
          }));
        if (chatId === undefined || projectsPicker.length === 0) {
          await send("No pude listar proyectos \u2014 prob\u00e1 /newtask m\u00e1s tarde.", thread);
          return;
        }
        const keyboard = projectsPicker.map((p, i) => [{ text: p.name.slice(0, 64), callback_data: "task:proj:" + i }]);
        await telegram.sendMessage(chatId, sofar + "(3/6) \u{1F4C1} \u00bfEn qu\u00e9 proyecto corre? Toc\u00e1 uno:", {
          parseMode: "HTML",
          messageThreadId: threadOf(thread),
          replyMarkup: { inline_keyboard: keyboard },
        });
        return;
      }
      if (w.step === "model") {
        // The task runs unattended: the model must be one that answers, not
        // whatever the server defaults to (which may have no balance at all).
        if (chatId === undefined) return;
        if (!(await forms.connect())) {
          await send("La API local no responde \u2014 /newtask de nuevo.", thread);
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
          buttons.push([{ text: ("Igual que esta sesi\u00f3n \u2014 " + cm.id).slice(0, 64), callback_data: "task:model:inherit" }]);
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
          buttons.push([{ text: ("Default de " + (w.directoryName ?? "el proyecto") + " \u2014 " + taskDirDefault.id).slice(0, 64), callback_data: "task:model:default" }]);
        } else {
          buttons.push([{ text: "Default del server", callback_data: "task:model:default" }]);
        }
        buttons.push([{ text: "\u{1F9F1} Elegir del selector\u2026", callback_data: "task:model:pick" }]);
        await telegram.sendMessage(chatId, sofar + "(4/6) \u{1F9F1} \u00bfCon qu\u00e9 modelo corre la tarea?", {
          parseMode: "HTML",
          messageThreadId: threadOf(thread),
          replyMarkup: { inline_keyboard: buttons },
        });
        return;
      }
      if (w.step === "type") {
        if (chatId === undefined) return;
        await telegram.sendMessage(chatId, sofar + "(5/6) \u23F1 \u00bfcu\u00e1ndo corre? Toc\u00e1 uno:", {
          parseMode: "HTML",
          messageThreadId: threadOf(thread),
          replyMarkup: { inline_keyboard: [
            [{ text: "Una vez", callback_data: "task:stype:once" }, { text: "Diario", callback_data: "task:stype:daily" }],
            [{ text: "Semanal", callback_data: "task:stype:weekly" }, { text: "Cada N min", callback_data: "task:stype:minutes" }],
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
        "(Confirm\u00e1) \u23F0 <b>Confirm\u00e1 la tarea</b>\n" +
          "\u{1F5D3} <b>" + escapeHtml(w.name) + "</b>\n" +
          "\u{1F4CB} " + escapeHtml(w.prompt.slice(0, 300)) + "\n" +
          "\u{1F4C1} " + escapeHtml(w.directoryName ?? w.directory) + "\n" +
          "\u{1F9F1} " + escapeHtml(w.model ? w.model.id : "default del server") + "\n" +
          "\u23F1 " + escapeHtml(formatSchedule(w.schedule)) + " \u2014 pr\u00f3xima: <b>" + escapeHtml(when) + "</b>",
        {
          parseMode: "HTML",
          messageThreadId: threadOf(thread),
          replyMarkup: { inline_keyboard: [[{ text: "\u2705 Guardar", callback_data: "task:save" }, { text: "\u2716 Cancelar", callback_data: "task:cancel" }]] },
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
      await send("\u23F0 La tarea espera sus botones o el texto del paso \u2014 /taskcancel aborta.", thread);
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
        void telegram.closeForumTopic(chatId, tid).catch((error) => log("WARN", "auto archive", safe(error)));
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
      page: number,
    ): { text: string; keyboard: Array<Array<{ text: string; callback_data: string }>> } => {
      const state = modelPicker;
      if (!state) return { text: "El picker expir\u00f3 \u2014 mand\u00e1 /models de nuevo.", keyboard: [] };
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
      const nav: Array<{ text: string; callback_data: string }> = [{ text: "\u2630 Proveedores", callback_data: "mpb:0" }];
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
    const agentPickerPage = (): { text: string; keyboard: Array<Array<{ text: string; callback_data: string }>> } => {
      const keyboard = agentPickerItems.map((a, i) => [
        { text: (a.name ?? a.id).slice(0, 64), callback_data: `ag:${i}` },
      ]);
      const tracked = sessions.get(agentPickerTarget);
      return {
        text: `\u{1F916} Agente para <b>${escapeHtml(tracked?.title ?? agentPickerTarget.slice(0, 18))}</b>\nToc\u00e1 uno para cambiarlo.`,
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
      { command: "archive", description: "Close a session\u0027s thread (archive)" },
      { command: "unarchive", description: "Reopen an archived thread" },
      { command: "delthread", description: "Delete a session\u0027s thread" },
      { command: "compact", description: "Compact context: /compact <ses_id?>" },
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
        case "help":
          await reply(`<pre>${HELP}</pre>`);
          return;

        case "txt": {
          if (!argument) {
            await reply("Usalo as\u00ed: <code>/txt tu respuesta</code> \u2014 responde la pregunta abierta con texto libre.");
            return;
          }
          if (!(await answerFreeForm(threadSession, argument))) {
            await reply("No hay una pregunta abierta en este hilo (o es de varios campos \u2014 respondela con los botones).");
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
                    { text: "\u{1F5C2} Sesiones", callback_data: "cmd:sessions" },
                  ],
                  [
                    { text: "\u{1F4CA} Uso", callback_data: "cmd:usage" },
                    { text: "\u{1F9EA} MCP", callback_data: "cmd:mcp" },
                  ],
                  [
                    { text: "\u{1F916} Agente", callback_data: "cmd:agents" },
                    { text: "\u{1F9F1} Modelos", callback_data: "cmd:models" },
                  ],
                  [
                    { text: "\u{1F6E0} Skills", callback_data: "cmd:skills" },
                    { text: "\u{1F4CB} Estado", callback_data: "cmd:status" },
                  ],
                  [{ text: "\u2716 Cerrar", callback_data: "menu:close" }],
                ],
              },
            },
          );
          return;
        }

        case "running": {
          const now = Date.now();
          const active = [...sessions.values()]
            .filter((s) => !s.idle && now - s.lastSeen < 5 * 60_000)
            .sort((a, b) => b.lastSeen - a.lastSeen)
            .slice(0, 12);
          if (active.length === 0) {
            await reply("\u{1F9ED} Ninguna sesi\u00f3n est\u00e1 corriendo ahora.");
            return;
          }
          const lines = active.map(
            (s) =>
              `\u2022 <b>${escapeHtml(s.title.slice(0, 64))}</b> \u2014 ${fmtAgo(s.lastSeen)} \u00b7 <code>${s.id.slice(0, 18)}\u2026</code>`,
          );
          await reply(`\u{1F9ED} En ejecuci\u00f3n (${active.length}):\n${lines.join("\n")}`);
          return;
        }

        case "usage": {
          const target = argument || threadSession || targetSession();
          if (!target) {
            await reply("No s\u00e9 qu\u00e9 sesi\u00f3n mirar \u2014 /usage <id>, o escrib\u00ed el comando en el hilo de una sesi\u00f3n.");
            return;
          }
          if (!(await forms.connect())) {
            await reply("La API local no responde \u2014 no puedo leer los n\u00fameros.");
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
            await reply("Esa sesi\u00f3n no existe (o la API no la encuentra).");
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
          const lines = [
            `\u{1F4CA} <b>${escapeHtml(info.title ?? sessions.get(target)?.title ?? target.slice(0, 18))}</b>`,
            `\u{1F9EA} <b>${escapeHtml(info.model?.providerID ? (provName.get(info.model.providerID) ?? info.model.providerID) + " \u00b7 " : "")}</b><code>${escapeHtml(info.model?.id ?? "?")}</code> \u00b7 agente <code>${escapeHtml(info.agent ?? "?")}</code>`,
            `\u{1FA99} ${fmtCost(info.cost ?? 0)} \u00b7 \u{1F4E5} ${fmtTokens(tokens.input ?? 0)} \u00b7 \u{1F4E4} ${fmtTokens(tokens.output ?? 0)} \u00b7 \u{1F9E0} ${fmtTokens(tokens.reasoning ?? 0)} \u00b7 \u26A1 ${fmtTokens(tokens.cache?.read ?? 0)}`,
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
            await reply("La API local no responde.");
            return;
          }
          const servers = await forms.request<ApiMcpServer[]>("GET", "/mcp");
          if (!Array.isArray(servers) || servers.length === 0) {
            await reply("\u{1F9EA} Sin servidores MCP configurados.");
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
            await reply("No s\u00e9 a qu\u00e9 sesi\u00f3n cambiarle el modelo \u2014 escribilo en el hilo de una sesi\u00f3n, o /use <id> primero.");
            return;
          }
          if (!(await forms.connect())) {
            await reply("La API local no responde.");
            return;
          }
          const [all, providers] = await Promise.all([
            forms.request<ApiModel[]>("GET", "/model"),
            forms.request<Array<{ id?: string; activation?: string; name?: string }>>("GET", "/provider"),
          ]);
          if (!Array.isArray(all) || all.length === 0) {
            await reply("No encontr\u00e9 modelos.");
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
            await reply(
              "Nada habilitado que mostrar \u2014 ni el estado del desktop ni tu <code>opencode.jsonc</code> declaran modelos activos.",
            );
            return;
          }
          modelPicker = { target, items, providers: provList, chosen, search };
          if (chatId === undefined) return;
          const chosenPage = chosen || search;
          const { text, keyboard } = chosenPage ? modelPickerPage(0) : modelProviderPage(modelPicker);
          await telegram.sendMessage(chatId, text, {
            parseMode: "HTML",
            messageThreadId: threadOf(threadSession),
            replyMarkup: { inline_keyboard: keyboard },
          });
          return;
        }

        case "agents":
        case "agent": {
          const target = threadSession || targetSession();
          if (!target) {
            await reply("No s\u00e9 a qu\u00e9 sesi\u00f3n cambiarle el agente \u2014 escribilo en el hilo de una sesi\u00f3n, o /use <id> primero.");
            return;
          }
          if (!(await forms.connect())) {
            await reply("La API local no responde.");
            return;
          }
          const all = await forms.request<ApiAgent[]>("GET", "/agent");
          if (!Array.isArray(all) || all.length === 0) {
            await reply("No encontr\u00e9 agentes.");
            return;
          }
          agentPickerItems = all.slice(0, 20);
          agentPickerTarget = target;
          if (chatId === undefined) return;
          const { text, keyboard } = agentPickerPage();
          await telegram.sendMessage(chatId, text, {
            parseMode: "HTML",
            messageThreadId: threadOf(threadSession),
            replyMarkup: { inline_keyboard: keyboard },
          });
          return;
        }

        case "status": {
          const mode: Mode = config.mode;
          await reply(
            [
              `<b>opencode-tg</b> \u2014 modo <code>${mode}</code>`,
              `espejo: <code>${watched.size === 0 ? (mirrorAll ? "all" : "none") : [...watched].join(", ")}</code>`,
              foreground
                ? `escribo a: <code>${foreground.slice(0, 18)}\u2026</code> ${escapeHtml(sessions.get(foreground)?.title ?? "")}`
                : topicResolver && telegram.topicsEnabled()
                  ? "escribo a: <i>el hilo donde escribas</i>"
                  : "escribo a: <i>la m\u00e1s activa</i>",
              `sesiones vistas: ${sessions.size}`,
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
            await reply("Escribilo en el hilo de una sesi\u00f3n (ese es su proyecto), o <code>/use</code> primero.");
            return;
          }
          const directory = await directoryOf(target);
          if (!directory) {
            await reply("No pude ver el proyecto de la sesi\u00f3n.");
            return;
          }
          const sub = (argument.split(/\s+/)[0] ?? "").toLowerCase();
          const rest = argument.slice(sub.length).trim();
          if (sub === "model") {
            if (!rest) {
              await reply("Decime el modelo: <code>/config model proveedor/modelo</code> \u2014 <code>/models</code> los lista.");
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
              await reply("No pude ubicar el config del proyecto.");
              return;
            }
            const edited = withDefaultModel(raw, full);
            if (!edited) {
              await reply("El config del proyecto no parece JSON/JSONC v\u00e1lido \u2014 no toqu\u00e9 nada.");
              return;
            }
            // Prove the edit still parses before it touches disk.
            const { stripJsonc } = await import("./src/config-models.js");
            try {
              JSON.parse(stripJsonc(edited));
            } catch {
              await reply("La edici\u00f3n no compuso un JSON v\u00e1lido \u2014 no toqu\u00e9 nada.");
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
              `\u2705 Default del proyecto: <code>${escapeHtml(full)}</code>.` +
                (reloaded
                  ? " \u{1F504} Recargado \u2014 las sesiones nuevas ya nacen con \u00e9l."
                  : "\n\u{1F504} Aplica a las sesiones NUEVAS tras reiniciar el server."),
            );
            return;
          }
          // Read view: the key facts of the project config.
          const file = projectConfigFile(directory);
          if (!file) {
            await reply(`Este proyecto no tiene <code>opencode.jsonc</code> \u2014 el default viene de la config global.`);
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
            await reply("El config del proyecto no parsea \u2014 revisalo en la PC.");
          }
          return;
        }

        case "ls": {
          // /ls — browse the project from the phone: see what the agent sees,
          // download files by tapping, attach one to the next prompt.
          const target = threadSession || targetSession();
          if (!target) {
            await reply("Escribilo en el hilo de una sesi\u00f3n (ese es su proyecto).");
            return;
          }
          const directory = await directoryOf(target);
          if (!directory) {
            await reply("No pude ver el proyecto de la sesi\u00f3n.");
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
            await reply("Escribilo en el hilo de una sesi\u00f3n (ese es su proyecto).");
            return;
          }
          const directory = await directoryOf(target);
          if (!directory) {
            await reply("No pude ver el proyecto de la sesi\u00f3n.");
            return;
          }
          const status = await forms.request<Array<Record<string, unknown>>>(
            "GET",
            "/vcs/status?location%5Bdirectory%5D=" + encodeURIComponent(directory),
          ).catch(() => undefined);
          const rows = Array.isArray(status) ? status : [];
          if (rows.length === 0) {
            await reply("\u{1F4C2} Sin cambios pendientes (o el proyecto no es un repo git).");
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
                replyMarkup: { inline_keyboard: [[{ text: "\u{1F4CA} Ver el diff", callback_data: `gitdiff:${target}` }]] },
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
            await reply("Escribilo en el hilo de una sesi\u00f3n, o <code>/revert <ses_id></code>.");
            return;
          }
          const tracked = sessions.get(target);
          if (chatId !== undefined) {
            await telegram
              .sendMessage(
                chatId,
                `\u21A9\uFE0F Deshacer el \u00faltimo turno de <b>${escapeHtml(tracked?.title ?? target.slice(0, 18))}</b>?` +
                  `\nEsto borra el intercambio completo (tu mensaje y su respuesta) \u2014 no se puede volver atr\u00e1s.`,
                {
                  parseMode: "HTML",
                  messageThreadId: threadOf(threadSession),
                  replyMarkup: {
                    inline_keyboard: [
                      [
                        { text: "\u2705 Deshacer", callback_data: "revertok:" + target },
                        { text: "\u2716 Cancelar", callback_data: "revertno:" + target },
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
            await reply("Decime qu\u00e9 buscar: <code>/find parte-del-nombre</code> \u2014 en el hilo de una sesi\u00f3n.");
            return;
          }
          const directory = await directoryOf(target);
          if (!directory) {
            await reply("No pude ver el proyecto de la sesi\u00f3n.");
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
              .sendMessage(chatId, `\u{1F50D} <b>${results.length}</b> resultado(s) para \u00ab${escapeHtml(query)}\u00bb \u2014 toc\u00e1 para descargar:`, {
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
            await reply("Escribilo en el hilo de una sesi\u00f3n, o <code>/context <ses_id></code>.");
            return;
          }
          let info: ApiSession | undefined;
          try {
            info = await forms.request<ApiSession>("GET", "/session/" + encodeURIComponent(target));
          } catch (error) {
            await reply(isSessionNotFound(error) ? SESSION_UNLOADED : "No encontr\u00e9 esa sesi\u00f3n.");
            return;
          }
          if (!info) {
            await reply("No encontr\u00e9 esa sesi\u00f3n.");
            return;
          }
          const catalogue = await ctx.model.list().then((res) => res.data ?? []).catch(() => []);
          const modelRef = info.model;
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
          const t = info.tokens;
          if (t) {
            lines.push(
              `\u{1F4E5} Input acumulado: ${fmtTokens((t.input ?? 0) + (t.reasoning ?? 0) + (t.cache?.read ?? 0))}` +
                ` \u00b7 \u{1F4E4} Output: ${fmtTokens(t.output ?? 0)}`,
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
          lines.push(`\n${limit !== undefined && t !== undefined && (t.input ?? 0) + (t.cache?.read ?? 0) > limit * 0.5 ? "\u26A0\uFE0F Va denso \u2014 consider\u00e1 <code>/compact</code>." : ""}`);
          await reply(lines.filter((l) => l.length > 1).join("\n"));
          return;
        }

        case "worktree": {
          // /worktree — the project's git worktrees: switch the NEXT session
          // to one with a tap, or /worktree new <name> to carve a fresh one.
          const sub = (argument.split(/\s+/)[0] ?? "").toLowerCase();
          const target = threadSession || targetSession();
          if (!target) {
            await reply("Escribilo en el hilo de una sesi\u00f3n (ese es su proyecto).");
            return;
          }
          const directory = await directoryOf(target);
          if (!directory) {
            await reply("No pude ver el proyecto de la sesi\u00f3n.");
            return;
          }
          const projects = await forms.request<Array<Record<string, unknown>>>("GET", "/api/project").catch(() => undefined);
          const list = Array.isArray(projects) ? projects : [];
          const proj = list.find((p) => String(p.canonical ?? "").replace(/\\/g, "/") === directory.replace(/\\/g, "/"));
          // /api/worktree wants the 40-char projectID from /api/project —
          // the 39-char one inside the session 404s the endpoint.
          const projectID = proj ? String(proj.id) : "";
          if (!projectID) {
            await reply("No encontr\u00e9 el proyecto en el server.");
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
              await reply("Decime el nombre: <code>/worktree new <nombre></code>");
              return;
            }
            try {
              await forms.request("POST", "/api/worktree", { projectID, name });
              await reply(`\u{1F33F} Worktree <b>${escapeHtml(name)}</b> creado. Abr\u00ed una sesi\u00f3n en \u00e9l con <code>/projects</code>.`);
            } catch (error) {
              log("WARN", "worktree create", safe(error));
              await reply("No se pudo crear el worktree: " + escapeHtml(String((error as Error).message).slice(0, 200)));
            }
            return;
          }
          if (rowsTrees.length === 0) {
            await reply(`Sin worktrees en el proyecto. <code>/worktree new <nombre></code> crea uno.`);
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
              .sendMessage(chatId, `\u{1F33F} <b>${rowsTrees.length}</b> worktree(s) \u2014 toc\u00e1 para abrir una sesi\u00f3n ah\u00ed:`, {
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
            await reply("Escribilo en el hilo de una sesi\u00f3n, o <code>/fork <ses_id></code>.");
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
            await reply("Escribilo en el hilo de una sesi\u00f3n, o <code>/export <ses_id></code>.");
            return;
          }
          const tracked = sessions.get(target);
          if (chatId === undefined) return;
          await reply("\u{1F4E4} Exportando\u2026");
          try {
            const exported = await forms.request<Record<string, unknown>>(
              "GET",
              "/api/experimental/session/" + encodeURIComponent(target) + "/export",
            );
            if (!exported) throw new Error("respuesta vac\u00eda del export");
            const text = JSON.stringify(exported, null, 2);
            if (text.length > 40 * 1024 * 1024) {
              await reply("El export supera los 40 MB \u2014 export\u00e1 esa sesi\u00f3n desde la PC.");
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
                  await reply("El transcript legacy supera los 40 MB \u2014 export\u00e1 esa sesi\u00f3n desde la PC.");
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
            await reply("No se pudo exportar: " + escapeHtml(String((error as Error).message).slice(0, 200)));
          }
          return;
        }

        case "projects": {
          if (!(await forms.connect())) {
            await reply("La API local no responde.");
            return;
          }
          const projects = await forms.request<
            Array<{ id?: string; canonical?: string; time?: { updated?: number; created?: number } }>
          >("GET", "/project");
          if (!Array.isArray(projects) || projects.length === 0) {
            await reply("No hay proyectos conocidos por el server.");
            return;
          }
          // Most recently touched first — that is the order the desktop
          // shows, and folders nobody opens are noise in a picker.
          projectsPicker = projects
            .filter((p) => typeof p.canonical === "string" && existsSync(p.canonical as string))
            .sort((a, b) => (b.time?.updated ?? b.time?.created ?? 0) - (a.time?.updated ?? a.time?.created ?? 0))
            .slice(0, 12)
            .map((p) => ({
              directory: p.canonical as string,
              name: ((p.canonical as string).split(/[\\/]/).filter(Boolean).pop() ?? p.canonical) as string,
              updated: p.time?.updated,
            }));
          if (chatId === undefined) return;
          const keyboard = projectsPicker.map((p, i) => [
            {
              text: `${p.name}${p.updated ? ` \u00b7 ${fmtAgo(p.updated)}` : ""}`.slice(0, 64),
              callback_data: `proj:${i}`,
            },
          ]);
          await telegram.sendMessage(
            chatId,
            "\u{1F4C1} Eleg\u00ed un proyecto para abrir una sesi\u00f3n nueva en \u00e9l.",
            { parseMode: "HTML", messageThreadId: threadOf(threadSession), replyMarkup: { inline_keyboard: keyboard } },
          );
          return;
        }
        case "sessions": {
          if (sessions.size === 0) {
            await reply("A\u00fan no he visto ninguna sesi\u00f3n.");
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
          const parts = ["<b>Sesiones</b>"];
          if (active.length > 0) parts.push(active.join("\n"));
          if (dormant.length > 0) {
            parts.push((active.length > 0 ? "\u2014 inactivas \u2014" : "<b>Inactivas</b>"), dormant.join("\n"));
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
            await reply("Dime una sesi\u00f3n: <code>/use &lt;id&gt;</code> (o <code>/use</code> para la \u00faltima activa)");
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
            await reply("Espejando todas las sesiones.");
            return;
          }
          if (arg === "off" || arg === "none") {
            watched.clear();
            // In `all` mode an empty set means "everything", not "nothing" —
            // so say plainly that nothing is being mirrored.
            await reply(mirrorAll ? "Espejo desactivado (modo config: all — /watch <id> para vigilar una)." : "Espejo desactivado.");
            return;
          }
          const target = arg || [...sessions.values()].sort((a, b) => b.lastSeen - a.lastSeen)[0]?.id || "";
          if (!target) {
            await reply("Dime una sesi\u00f3n: <code>/watch &lt;id&gt;</code> o <code>/watch all</code>");
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
            await reply("Dime qu\u00e9 enviar: <code>/send &lt;texto&gt;</code> (o <code>/send &lt;ses_id&gt; &lt;texto&gt;</code>)");
            return;
          }
          await sendPrompt(text, target);
          return;
        }

        case "queue": {
          const target = argument.trim() || threadSession || targetSession();
          if (!target) {
            await reply("Decime la sesi\u00f3n: <code>/queue <ses_id></code>, o escribilo en su hilo.");
            return;
          }
          if (!(await forms.connect())) {
            await reply("La API local no responde.");
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
          inboxThread = target;
          inboxItems = (Array.isArray(inbox) ? inbox : []).map((item) => {
            const payload = item.payload as { text?: string } | undefined;
            return { id: String(item.id ?? ""), text: payload?.text ?? "(sin texto)" };
          });
          if (inboxItems.length === 0) {
            await reply("\u{1F4E5} Inbox vac\u00edo. Los mensajes que mand\u00e9s mientras la sesi\u00f3n trabaja quedan ac\u00e1 y salen solos al terminar el turno.");
            return;
          }
          if (chatId === undefined) return;
          const { text, keyboard } = renderInboxList();
          await telegram.sendMessage(chatId, text, {
            parseMode: "HTML",
            messageThreadId: threadOf(threadSession),
            replyMarkup: { inline_keyboard: keyboard },
          });
          return;
        }
        case "flush": {
          const body = argument.trim();
          const session = threadSession || targetSession();
          if (!session) {
            await reply("No s\u00e9 a qu\u00e9 sesi\u00f3n \u2014 escribilo en su hilo o <code>/flush <ses_id> <texto></code>.");
            return;
          }
          if (!(await forms.connect())) {
            await reply("La API local no responde.");
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
            await reply("Decime la sesi\u00f3n: <code>/clearqueue <ses_id></code>, o escribilo en su hilo.");
            return;
          }
          if (!(await forms.connect())) {
            await reply("La API local no responde.");
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
          await reply(`\u{1F5D1} ${cancelled} mensaje(s) cancelado(s) del inbox.`);
          return;
        }
        case "history": {
          const target = argument.trim() || threadSession || targetSession();
          if (!target) {
            await reply("No hay sesi\u00f3n. Us\u00e1 <code>/history &lt;ses_id&gt;</code> o escribilo en su hilo.");
            return;
          }
          const label = sessions.get(target)?.title ?? target.slice(0, 18);
          const path = jsonlPath(target);
          const entries = readHistory(path, 16);
          if (entries.length === 0) {
            await reply(`\u{1F4DC} <b>${escapeHtml(label)}</b> — sin historial todav\u00eda.`);
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
            await reply("No hay sesi\u00f3n. Us\u00e1 <code>/kill <ses_id></code> o escribilo en su hilo.");
            return;
          }
          const label = sessions.get(target)?.title ?? target.slice(0, 18);
          if (!(await forms.connect())) {
            await reply("La API local no responde.");
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
            await reply("La API local no responde.");
            return;
          }
          const directory = await directoryOf(target);
          if (!directory) {
            await reply("No s\u00e9 en qu\u00e9 proyecto \u2014 us\u00e1 <code>/projects</code> y eleg\u00ed uno.");
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
              "\u2728 Nueva sesi\u00f3n <code>" + created.id.slice(0, 22) + "\u2026</code> en <b>" + escapeHtml(short) + "</b>." +
                (title
                  ? "\n\u{1F3F7}\uFE0F T\u00edtulo: <b>" + escapeHtml(title.slice(0, 60)) + "</b>"
                  : "\n\u{1F4A1} Pod\u00e9s crearla con t\u00edtulo: <code>/new <t\u00edtulo></code>") +
                "\nEscribile \u2014 su hilo se crea con el primer mensaje, o us\u00e1 <code>/use " + created.id + "</code>.",
            );
          } catch (error) {
            log("WARN", "new session", safe(error));
            await reply("\u274C No se pudo crear: " + escapeHtml(String((error as Error).message).slice(0, 200)));
          }
          return;
        }

        case "tasks": {
          const list = readTasks();
          if (list.length === 0) {
            await reply("\u23F0 No hay tareas. Cre\u00e1 una con <code>/newtask</code>." + (readDraft() ? "\n\u26A0\uFE0F Hay una tarea a medio crear \u2014 /newtask la retoma." : ""));
            return;
          }
          if (chatId === undefined) return;
          const lines = list.slice(0, 10).map((t) =>
            (t.enabled ? "\u{1F7E2}" : "\u26AA") + " <b>" + escapeHtml(t.name.slice(0, 40)) + "</b> \u2014 " + escapeHtml(formatSchedule(t.schedule)),
          );
          const keyboard = list.slice(0, 10).map((t) => [
            { text: (t.name.slice(0, 24)) + (t.enabled ? "" : " (off)"), callback_data: "task:view:" + t.id },
          ]);
          await telegram.sendMessage(chatId, "\u23F0 Tareas (" + list.length + ") \u2014 toc\u00e1 una para verla.\n" + lines.join("\n"), {
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
            await reply("\u23F0 Retomando la tarea a medio crear \u2014 faltaba: <b>" + existing.step + "</b>.");
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
          await reply("Wizard de tarea cancelado.");
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
            await reply("No s\u00e9 a qu\u00e9 sesi\u00f3n \u2014 escribilo en su hilo, o /use primero.");
            return;
          }
          if (!skillId || !text) {
            await reply("Us\u00e1 <code>/skill <id> <texto></code> \u2014 o <code>/skills</code> para verlas con botones.");
            return;
          }
          await sendPrompt(text, target, undefined, [{ id: skillId }]);
          return;
        }

        case "compact": {
          const target = argument.trim() || threadSession || targetSession();
          if (!target) { await reply("Decime la sesi\u00f3n: <code>/compact <ses_id></code>, o escribilo en su hilo."); return; }
          if (!(await forms.connect())) { await reply("La API local no responde."); return; }
          try {
            await forms.request("POST", "/session/" + encodeURIComponent(target) + "/compact", {});
            await reply("\u{1F4DC} Compactaci\u00f3n solicitada.");
          } catch (error) {
            log("WARN", "compact", safe(error));
            await reply(
              isSessionNotFound(error)
                ? SESSION_UNLOADED
                : "\u274C No se pudo compactar: " + escapeHtml(String((error as Error).message).slice(0, 200)),
            );
          }
          return;
        }

        case "usagestats": {
          const days = Math.min(Math.max(Number(argument) || 7, 1), 90);
          if (!(await forms.connect())) { await reply("La API local no responde."); return; }
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
            const lines = ["\u{1F4CA} <b>Uso de los \u00faltimos " + days + " d\u00edas</b>"];
            if (d) {
              lines.push(
                "\u{1F4AC} Prompts: " + (d.prompts ?? 0) +
                " \u00b7 \u{1F5C2}\uFE0F Sesiones: " + (d.sessions ?? 0) +
                " \u00b7 \u{1F916} Subagentes: " + (d.subagents ?? 0),
              );
              lines.push("\u{1F9E9} Steps: " + (d.steps ?? 0).toLocaleString("es-AR"));
              if (d.tokens?.input !== undefined) lines.push("\u{1F4E5} Input: " + fmtTokens(d.tokens.input + (d.tokens.cache?.write ?? 0)));
              if (d.tokens?.output !== undefined) {
                lines.push("\u{1F4E4} Output: " + fmtTokens(d.tokens.output + (d.tokens.reasoning ?? 0)) + " (incluye razonamiento)");
              }
              if (d.tokens?.cache?.read) lines.push("\u{1F4BE} Cache le\u00eddo: " + fmtTokens(d.tokens.cache.read));
              if (d.cost !== undefined) lines.push("\u{1FA99} Costo: " + fmtCost(d.cost));
              if (d.streak !== undefined) lines.push("\u{1F525} Racha: " + d.streak + " d\u00edas \u00b7 activos: " + (d.activeDays ?? 0) + "/" + days);
            } else lines.push("(sin datos en el rango)");
            await reply(lines.join("\n"));
          } catch (error) {
            log("WARN", "usagestats", safe(error));
            await reply("\u274C No pude leer las estad\u00edsticas: " + escapeHtml(String((error as Error).message).slice(0, 200)));
          }
          return;
        }

        case "archive": {
          const target = argument.trim() || threadSession;
          if (!target || !topicStore || chatId === undefined) {
            await reply("Escribilo en el hilo de la sesi\u00f3n, o <code>/archive <id></code>.");
            return;
          }
          const tid = topicStore.get(target);
          if (tid === undefined) {
            await reply("Esa sesi\u00f3n no tiene hilo propio.");
            return;
          }
          try {
            await telegram.closeForumTopic(chatId, tid);
            topicStore.setArchived(target, true);
            await reply("\u{1F4E6} Hilo archivado (cerrado, no se puede escribir) \u2014 <code>/unarchive</code> lo reabre. Si la sesi\u00f3n revive, se reabre sola.");
          } catch (error) {
            log("WARN", "archive", safe(error));
            // Private chats cannot close or reopen topics (verified live:
            // "the chat is not a supergroup") but they CAN rename them.
            // Archive on the plugin's side — silence: no mirror, no typing,
            // no prompts into it — and badge the title so the forum reads
            // "parked" at a glance.
            topicStore.setArchived(target, true);
            const tracked = sessions.get(target);
            const name = `\u{1F4E6} ${tracked?.title ?? target.slice(0, 18)}`.slice(0, 128);
            await telegram.editForumTopic(chatId, tid, name).catch(() => undefined);
            await reply(
              "\u{1F4E6} Archivado (silenciado): Telegram no permite cerrar t\u00f3picos en un chat privado \u2014 el hilo queda visible pero mudo, sin espejo ni avisos. <code>/unarchive</code> lo despierta.",
            );
          }
          return;
        }

        case "unarchive": {
          const target = argument.trim() || threadSession;
          if (!target || !topicStore || chatId === undefined) {
            await reply("Escribilo en el hilo de la sesi\u00f3n, o <code>/unarchive <id></code>.");
            return;
          }
          const tid = topicStore.get(target);
          if (tid === undefined) {
            await reply("Esa sesi\u00f3n no tiene hilo propio.");
            return;
          }
          try {
            await telegram.reopenForumTopic(chatId, tid);
            topicStore.setArchived(target, false);
            await reply("\u{1F4C2} Hilo reabierto.");
          } catch (error) {
            log("WARN", "unarchive", safe(error));
            // The private-chat fallback: nothing was closed on Telegram's
            // side, so waking it up is clearing our flag and dropping the
            // badge from the title.
            topicStore.setArchived(target, false);
            const tracked = sessions.get(target);
            const raw = tracked?.title ?? target.slice(0, 18);
            const name = raw.startsWith("\u{1F4E6} ") ? raw.slice(3) : raw;
            await telegram.editForumTopic(chatId, tid, name.slice(0, 128)).catch(() => undefined);
            await reply("\u{1F4C2} Despertado \u2014 el espejo de la sesi\u00f3n vuelve a este hilo.");
          }
          return;
        }

        case "delthread": {
          // Destructive on purpose and only on purpose: deletes the thread
          // from Telegram. The server session is untouched — only its window
          // into the chat goes away.
          const target = argument.trim() || threadSession;
          if (!target || !topicStore || chatId === undefined) {
            await reply("Escribilo en el hilo de la sesi\u00f3n, o <code>/delthread <id></code>.");
            return;
          }
          const tid = topicStore.get(target);
          if (tid === undefined) {
            await reply("Esa sesi\u00f3n no tiene hilo propio.");
            return;
          }
          try {
            await telegram.deleteForumTopic(chatId, tid);
            topicStore.remove(target);
            await reply(
              "\u{1F5D1} Hilo eliminado del chat. Ojo: la sesi\u00f3n sigue existiendo \u2014 mientras est\u00e9 activa, su pr\u00f3ximo evento crea un hilo nuevo (as\u00ed funciona el espejo). Para silenciarla en serio: <code>/archive</code>.",
            );
          } catch (error) {
            log("WARN", "delthread", safe(error));
            await reply("\u274C No se pudo eliminar el hilo.");
          }
          return;
        }

        case "skills": {
          // `list` is on SkillApi but its exact input has shifted between
          // releases, so call it defensively and normalise the rows.
          const list = (ctx.skill as unknown as { list?: (...args: unknown[]) => Promise<unknown> }).list;
          if (!list) {
            await reply("Este OpenCode no expone <code>skill.list()</code>.");
            return;
          }
          try {
            const result = (await list.call(ctx.skill)) as unknown;
            const rows = Array.isArray(result) ? result : ((result as { data?: unknown[] })?.data ?? []);
            if (rows.length === 0) {
              await reply("No hay skills instaladas.");
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
              `<b>Skills (${rows.length})</b> \u2014 toc\u00e1 una y escrib\u00ed el prompt que la usa:\n${lines.join("\n")}`,
              { parseMode: "HTML", messageThreadId: threadOf(threadSession), replyMarkup: { inline_keyboard: keyboard } },
            );
          } catch (error) {
            log("WARN", "skill.list failed", safe(error));
            await reply(`No pude listar las skills: <code>${escapeHtml(String(error))}</code>`);
          }
          return;
        }

        default:
          await reply(`Comando desconocido: <code>${escapeHtml(name)}</code>. Prueba /help`);
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
              void telegram.closeForumTopic(chatId, subThreadId).catch((error) => log("WARN", "subagent archive", safe(error)));
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
                { text: "\u2705 Aprobar", callback_data: "perm2:ok:" + requestId },
                { text: "\u{1F501} Siempre", callback_data: "perm2:always:" + requestId },
                { text: "\u2716 Rechazar", callback_data: "perm2:no:" + requestId },
              ]],
            };
            void telegram
              .sendMessage(chatId, "\u{1F510} <b>" + escapeHtml(session.title) + "</b> pide permiso:\n<code>" + escapeHtml(action) + "</code> \u00b7 " + escapeHtml(resources.slice(0, 300)), {
                parseMode: "HTML", messageThreadId: threadOf(sessionID), replyMarkup: keyboard,
              })
              .catch((error) => log("WARN", "perm send", safe(error)));
            // Background heads-up — same reasoning as the form's: the request
            // sits in its thread, this line makes sure General says so.
            if (threadOf(sessionID) !== undefined) {
              void telegram
                .sendMessage(chatId, `\u{1F510} <b>${escapeHtml(session.title)}</b> pide un permiso \u2014 su hilo espera tu respuesta.`, {
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
                      : `\u274C Esa tarea ya no existe \u2014 /tasks de nuevo.`,
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
              // item â€” cancel it and send the new text through the same inbox.
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
                  await send("\u270F\uFE0F Reemplazado \u2014 el texto nuevo qued\u00f3 esperando en el inbox.", byThread);
                } else {
                  await send("\u274C La API local no responde \u2014 el \u00edtem original sigue en el inbox.", byThread);
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
                  await send("\u26A0\uFE0F La nota de voz lleg\u00f3 sin id de archivo.", byThread);
                  return;
                }
                const file = await telegram.getFile(voiceId);
                const filePath = file.file_path;
                if (!filePath) {
                  await send("\u26A0\uFE0F Telegram no me dio el archivo de audio.", byThread);
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
                    await send("\u26A0\uFE0F Transcripci\u00f3n de voz no configurada \u2014 eleg\u00ed un proveedor en la secci\u00f3n Voz del README (local o cloud), o escribime mientras tanto.", byThread);
                    return;
                  }
                  await send(`\u{1F3A4} Transcribiendo ${message.voice.duration ?? "?"}s de audio\u2026`, byThread);
                  const text = await transcribeFile(oggPath, config.stt);
                  if (text.length === 0) {
                    await send("\u{1F3A4} No entend\u00ed nada en el audio \u2014 \u00bfera voz?", byThread);
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
                    await send("No s\u00e9 a qu\u00e9 sesi\u00f3n \u2014 escribilo en el hilo de una sesi\u00f3n, o /use primero.", byThread);
                  }
                } catch (error) {
                  log("WARN", "stt", safe(error));
                  await send(`\u274C Transcripci\u00f3n fallida: ${escapeHtml(String((error as Error).message).slice(0, 200))}`, byThread);
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
                  await send("\u26A0\uFE0F No pude descargar el documento \u2014 prob\u00e1 mandarlo como texto o imagen.", byThread);
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
                    await send("\u26A0\uFE0F El video supera los 20 MB que Telegram entrega a un bot.", byThread);
                    return;
                  }
                  const saved = saveBinary(message.video.file_name ?? "video.mp4", buffer);
                  const size = (buffer.length / 1024 / 1024).toFixed(2);
                  const body = "El usuario envi\u00f3 un video (" + size + " MB), guardado en: " + saved + " \u2014 abrilo con tus file tools si lo necesit\u00e1s.";
                  await sendPrompt(body, byThread);
                } catch (error) {
                  log("WARN", "video ingest", safe(error));
                  await send("\u26A0\uFE0F No pude descargar el video \u2014 prob\u00e1 subirlo a un lugar accesible.", byThread);
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
                  await send("No s\u00e9 a qu\u00e9 sesi\u00f3n \u2014 escrib\u00ed en el hilo de una sesi\u00f3n, o /use primero.", byThread);
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
                await ack("Esta pregunta ya no está activa");
              };
              if (payload.startsWith("gitdiff:")) {
                // gitdiff:<sessionID> — the working diff of the session's
                // project, as a preview plus the full patch downloadable.
                const sessionID = payload.slice(8);
                await ack("Cargando el diff\u2026");
                const directory = await directoryOf(sessionID);
                if (!directory || chatId === undefined || !cq.message) {
                  await ack("No pude ver el proyecto.");
                  return;
                }
                const diff = await forms.request<Array<Record<string, unknown>>>(
                  "GET",
                  "/vcs/diff?location%5Bdirectory%5D=" + encodeURIComponent(directory) + "&mode=working",
                ).catch(() => undefined);
                const files = Array.isArray(diff) ? diff : [];
                if (files.length === 0) {
                  await ack("Sin cambios que mostrar.");
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
                await ack("Deshaciendo\u2026");
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
                await ack("Cancelado");
                if (cq.message) {
                  await telegram
                    .editMessageText(cq.message.chat.id, cq.message.message_id, "\u2716 Revert cancelado.", { parseMode: "HTML" })
                    .catch(() => undefined);
                }
                return;
              }
              if (payload.startsWith("lsg:")) {
                // lsg:<key> — navigate to the stored rel path.
                const key = payload.slice(4);
                const rel = lsKeys.get(key);
                if (rel === undefined) {
                  await ack("Listing viejo \u2014 abr\u00ed /ls de nuevo");
                  return;
                }
                const menuSession = cq.message?.message_thread_id !== undefined ? topicStore?.sessionOf(cq.message.message_thread_id) : undefined;
                const sessionID = menuSession ?? targetSession();
                if (!sessionID) {
                  await ack("No s\u00e9 a qu\u00e9 proyecto \u2014 abrilo en el hilo de una sesi\u00f3n.");
                  return;
                }
                const directory = await directoryOf(sessionID);
                if (!directory) {
                  await ack("No pude ver el proyecto.");
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
                  await ack("Listing viejo \u2014 abr\u00ed /ls de nuevo");
                  return;
                }
                if (!sessionID || !directory || chatId === undefined || !cq.message) {
                  await ack("No pude ubicar el archivo.");
                  return;
                }
                const full = safeResolve(directory, rel);
                if (!full || !existsSync(full)) {
                  await ack("El archivo ya no est\u00e1.");
                  return;
                }
                const size = (await import("node:fs")).statSync(full).size;
                if (size > 45 * 1024 * 1024) {
                  await ack("Supera los 45 MB de Telegram.");
                  return;
                }
                await ack("Enviando\u2026");
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
                  await ack("Listing viejo \u2014 abr\u00ed /ls de nuevo");
                  return;
                }
                if (!sessionID || !directory) {
                  await ack("No pude ubicar el archivo.");
                  return;
                }
                const full = safeResolve(directory, rel);
                if (!full || !existsSync(full)) {
                  await ack("El archivo ya no est\u00e1.");
                  return;
                }
                const fs = await import("node:fs");
                const size = fs.statSync(full).size;
                const name = full.split(/[\\/]/).pop() ?? "archivo";
                if (!isTextLike(name, "", Buffer.alloc(0))) {
                  await ack("Solo archivos de texto se adjuntan \u2014 el binario descargalo.");
                  return;
                }
                if (size > 200 * 1024) {
                  await ack("Muy grande para adjuntar (l\u00edmite 200 KB) \u2014 descargalo.");
                  return;
                }
                const content = decodeText(fs.readFileSync(full));
                pendingAttach.set(sessionID, { uri: `data:text/plain;filename="${encodeURIComponent(name)}";base64,${Buffer.from(content, "utf8").toString("base64")}`, name });
                await ack("Adjuntado \u2014 tu pr\u00f3ximo mensaje lo lleva al agente");
                return;
              }
              if (payload.startsWith("wtnew:")) {
                // wtnew:<key> — open a new session in that worktree.
                const dir = lsKeys.get(payload.slice(6));
                if (dir === undefined) {
                  await ack("Listing viejo \u2014 reabr\u00ed /worktree");
                  return;
                }
                await ack("Abriendo\u2026");
                try {
                  const created = await forms.request<{ id?: string }>("POST", "/session", { location: { directory: dir } });
                  if (!created?.id) throw new Error("sin id");
                  const name = dir.split(/[\\/]/).filter(Boolean).pop() ?? dir;
                  if (cq.message) {
                    await telegram
                      .sendMessage(
                        cq.message.chat.id,
                        `\u2728 Sesi\u00f3n <code>${created.id.slice(0, 22)}\u2026</code> en <b>${escapeHtml(name)}</b>.\nEscribile \u2014 su hilo se crea con el primer mensaje.`,
                        { parseMode: "HTML", messageThreadId: cq.message.message_thread_id },
                      )
                      .catch(() => undefined);
                  }
                } catch (error) {
                  log("WARN", "worktree session", safe(error));
                  await ack("No se pudo abrir la sesi\u00f3n.");
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
                if (!req) { await ack("Ese permiso ya se resolvi\u00f3"); return; }
                permissionRequests.delete(requestId);
                const decision = outcome === "always" ? "always" : outcome === "ok" ? "once" : "reject";
                await ack(decision === "reject" ? "Rechazado" : decision === "always" ? "Aprobado siempre" : "Aprobado");
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
                  await ack("Ya respondida");
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
                  await ack("Opción no válida");
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
                  await ack("Ya respondida");
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
                const state = modelPicker;
                const prov = state?.providers[Number(payload.slice(4))];
                if (!state || !prov) {
                  await ack("El picker expir\u00f3 \u2014 mand\u00e1 /models de nuevo");
                  return;
                }
                state.chosen = prov.id;
                state.search = "";
                if (cq.message) {
                  const { text, keyboard } = modelPickerPage(0);
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
                const state = modelPicker;
                if (!state) {
                  await ack("El picker expir\u00f3 \u2014 mand\u00e1 /models de nuevo");
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
                if (!modelPicker) {
                  await ack("El picker expir\u00f3 \u2014 mand\u00e1 /models de nuevo");
                  return;
                }
                if (payload !== "mp:noop" && cq.message) {
                  const page = Number(payload.slice(3));
                  const { text, keyboard } = modelPickerPage(Number.isFinite(page) ? page : 0);
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
                const chosen = modelPicker?.items[Number(payload.slice(4))];
                const target = modelPicker?.target;
                // Wizard mode: the pick becomes the task's model, not a switch.
                if (modelPicker?.taskMode && taskWizard && chosen) {
                  const t = cq.message?.message_thread_id !== undefined ? topicStore?.sessionOf(cq.message.message_thread_id) : undefined;
                  taskWizard.model = { id: chosen.id, providerID: chosen.providerID };
                  taskWizard.step = "type";
                  writeDraft(taskWizard);
                  modelPicker = undefined;
                  await ack("Modelo elegido: " + (chosen.name ?? chosen.id));
                  if (cq.message) {
                    await telegram
                      .editMessageText(cq.message.chat.id, cq.message.message_id, "\u{1F9F1} Modelo: <code>" + escapeHtml(chosen.id) + "</code>", { parseMode: "HTML" })
                      .catch(() => undefined);
                  }
                  await wizardAsk(t);
                  return;
                }
                if (!chosen || !target) {
                  await ack("El picker expir\u00f3 \u2014 mand\u00e1 /models de nuevo");
                  return;
                }
                if (!(await forms.connect())) {
                  await ack("La API local no responde");
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
                  await ack("Modelo cambiado");
                } catch (error) {
                  log("WARN", "model set", safe(error));
                  await ack("No se pudo cambiar el modelo");
                }
                return;
              }
              if (payload.startsWith("skl:")) {
                const chosen = skillItems[Number(payload.slice(4))];
                if (!chosen) {
                  await ack("La lista expir\u00f3 \u2014 /skills de nuevo");
                  return;
                }
                skillArmed = chosen;
                await ack("Skill " + chosen.name + " \u2014 escrib\u00ed el prompt");
                return;
              }
              if (payload.startsWith("task:")) {
                const [, action, arg] = payload.split(":");
                const task = arg !== undefined && arg !== "save" && arg !== "cancel" ? readTasks().find((t) => t.id === arg) : undefined;
                if (action === "proj") {
                  const chosen = projectsPicker[Number(arg)];
                  const t = cq.message?.message_thread_id !== undefined ? topicStore?.sessionOf(cq.message.message_thread_id) : undefined;
                  if (taskWizard && chosen) {
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
                    await wizardAsk(t);
                  } else {
                    await ack("El wizard expir\u00f3 \u2014 /newtask de nuevo");
                  }
                  return;
                }
                if (action === "model") {
                  const t = cq.message?.message_thread_id !== undefined ? topicStore?.sessionOf(cq.message.message_thread_id) : undefined;
                  if (!taskWizard) { await ack("El wizard expir\u00f3 \u2014 /newtask de nuevo"); return; }
                  if (arg === "default") taskWizard.model = undefined;
                  // "inherit" already pre-loaded the session's model in the ask.
                  taskWizard.step = "type";
                  writeDraft(taskWizard);
                  await ack(arg === "pick" ? "Eleg\u00ed proveedor y modelo" : "Modelo elegido");
                  if (arg === "pick") {
                    // Reuse the /models mirror: desktop-shown models only.
                    if (!(await forms.connect())) { await ack("La API local no responde"); return; }
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
                    modelPicker = {
                      target: t ?? "",
                      items,
                      providers: [...new Set(items.map((m) => m.providerID))].map((pid) => ({ id: pid, name: provNames.get(pid) ?? pid })).sort((a, b) => a.name.localeCompare(b.name)),
                      search: "",
                      taskMode: true,
                    };
                    if (cq.message && chatId !== undefined) {
                      const { text, keyboard } = modelProviderPage(modelPicker);
                      await telegram
                        .editMessageText(cq.message.chat.id, cq.message.message_id, text, { parseMode: "HTML", replyMarkup: { inline_keyboard: keyboard } })
                        .catch(() => undefined);
                    }
                  } else {
                    await wizardAsk(t);
                  }
                  return;
                }
                if (action === "stype") {
                  const type = arg as TaskSchedule["type"];
                  const t = cq.message?.message_thread_id !== undefined ? topicStore?.sessionOf(cq.message.message_thread_id) : undefined;
                  if (!taskWizard || !type) { await ack("El wizard expir\u00f3 \u2014 /newtask de nuevo"); return; }
                  taskWizard.scheduleType = type;
                  taskWizard.step = "detail";
                  writeDraft(taskWizard);
                  await ack();
                  await wizardAsk(t);
                  return;
                }
                if (action === "save") {
                  if (!taskWizard || !taskWizard.schedule || !taskWizard.directory) { await ack("El wizard expir\u00f3 \u2014 /newtask de nuevo"); return; }
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
                  await ack("Tarea creada");
                  if (cq.message) {
                    const when = fmtDateTime(task.nextRun);
                    await telegram
                      .editMessageText(cq.message.chat.id, cq.message.message_id, "\u2705 Tarea <b>" + escapeHtml(task.name) + "</b> creada \u2014 pr\u00f3xima: " + escapeHtml(when), { parseMode: "HTML" })
                      .catch(() => undefined);
                  }
                  return;
                }
                if (action === "cancel") {
                  taskWizard = undefined;
                  await ack("Cancelado");
                  if (cq.message) {
                    await telegram.deleteMessage(cq.message.chat.id, cq.message.message_id).catch(() => undefined);
                  }
                  return;
                }
                if (!task) { await ack("La tarea ya no existe \u2014 /tasks de nuevo"); return; }
                if (!(await forms.connect())) { await ack("La API local no responde"); return; }
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
                          "\u23F1 " + escapeHtml(formatSchedule(task.schedule)) + " \u2014 pr\u00f3xima: " + escapeHtml(when) + "\n" +
                          "\u{1F553} \u00faltima: " + (task.lastRun > 0 ? escapeHtml(task.lastStatus || "sin estado") : "nunca"),
                        { parseMode: "HTML",
                          replyMarkup: { inline_keyboard: [
                            [{ text: "\u25B6 Ahora", callback_data: "task:run:" + task.id }, { text: task.enabled ? "\u23F8 Apagar" : "\u25B6 Encender", callback_data: "task:toggle:" + task.id }],
                            [{ text: "\u270F\uFE0F Prompt", callback_data: "task:prompt:" + task.id }],
                            [{ text: "\u{1F5D1} Eliminar", callback_data: "task:del:" + task.id }, { text: "\u2B05", callback_data: "task:back" }],
                          ] } },
                      )
                      .catch(() => undefined);
                  }
                  return;
                }
                if (action === "prompt") {
                  // Arm the edit: the next text in this thread becomes the
                  // task's new prompt (checked with a 10-minute window).
                  await ack("Mand\u00e1 el nuevo prompt");
                  taskPromptEdit = { id: task.id, name: task.name, threadId: cq.message?.message_thread_id, armedAt: Date.now() };
                  if (cq.message) {
                    await telegram
                      .sendMessage(
                        cq.message.chat.id,
                        "\u270F\uFE0F Nuevo prompt para <b>" + escapeHtml(task.name) + "</b> \u2014 mandalo como pr\u00f3ximo mensaje en este hilo (10 min para hacerlo).\n\nActual:\n<code>" + escapeHtml(task.prompt.slice(0, 500)) + "</code>",
                        { parseMode: "HTML", messageThreadId: cq.message.message_thread_id },
                      )
                      .catch((error) => log("WARN", "task prompt arm", safe(error)));
                  }
                  return;
                }
                if (action === "run") {
                  await ack("Ejecutando");
                  try {
                    await runTaskNow(task);
                    const all = readTasks();
                    const x = all.find((t) => t.id === task.id);
                    if (x) { x.lastRun = Date.now(); x.lastStatus = "ok (manual)"; writeTasks(all); }
                  } catch (error) {
                    log("WARN", "task run", safe(error));
                    await ack("No se pudo ejecutar");
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
                    await ack(x.enabled ? "Encendida" : "Apagada");
                  } else await ack("Ya no existe");
                  return;
                }
                if (action === "del") {
                  writeTasks(readTasks().filter((t) => t.id !== task.id));
                  await ack("Eliminada");
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
                      .editMessageText(cq.message.chat.id, cq.message.message_id, "\u23F0 Tareas (" + list.length + ")", { parseMode: "HTML", replyMarkup: { inline_keyboard: keyboard } })
                      .catch(() => undefined);
                  }
                  return;
                }
                await ack("Acci\u00f3n desconocida");
                return;
              }
              if (payload.startsWith("ib:")) {
                // Inbox item buttons: reorder, steer, cancel, replace — the
                // same handle the desktop gives its pending-message list.
                const [, action, indexText] = payload.split(":");
                const index = Number(indexText);
                const item = inboxItems[index];
                const session = inboxThread;
                if (!session || (action !== "order" && !item)) {
                  await ack("La lista expir\u00f3 \u2014 mand\u00e1 /queue de nuevo");
                  return;
                }
                if (!(await forms.connect())) {
                  await ack("La API local no responde");
                  return;
                }
                const rerender = async (): Promise<void> => {
                  if (!cq.message) return;
                  const { text, keyboard } = renderInboxList();
                  await telegram
                    .editMessageText(cq.message.chat.id, cq.message.message_id, text, {
                      parseMode: "HTML",
                      replyMarkup: { inline_keyboard: keyboard },
                    })
                    .catch((error) => log("WARN", "inbox render", safe(error)));
                };
                if (action === "up" || action === "down") {
                  const to = action === "up" ? index - 1 : index + 1;
                  if (to >= 0 && to < inboxItems.length) {
                    const [moved] = inboxItems.splice(index, 1);
                    inboxItems.splice(to, 0, moved);
                    await rerender();
                  }
                  await ack("Reordenado");
                  return;
                }
                if (action === "order") {
                  // Replay the arranged sequence: cancel the pending items on
                  // the server, then steer each text back in exactly this
                  // order — the agent receives them in the user's arrangement.
                  const ordered = [...inboxItems];
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
                    await ack("Adelantado al turno en curso");
                  } catch (error) {
                    log("WARN", "inbox steer", safe(error));
                    await ack("No se pudo adelantar: " + String((error as Error).message).slice(0, 120));
                  }
                  return;
                }
                if (action === "cancel") {
                  await forms
                    .request("DELETE", `/session/${encodeURIComponent(session)}/inbox/${encodeURIComponent(item.id)}`)
                    .catch((error) => log("WARN", "inbox cancel", safe(error)));
                  inboxItems.splice(index, 1);
                  if (inboxItems.length === 0) {
                    if (cq.message) {
                      await telegram
                        .editMessageText(cq.message.chat.id, cq.message.message_id, "\u{1F5D1} Inbox vac\u00edo.", { parseMode: "HTML" })
                        .catch(() => undefined);
                    }
                    await ack("Cancelado");
                  } else {
                    await rerender();
                    await ack("Cancelado");
                  }
                  return;
                }
                if (action === "edit") {
                  inboxEdit = { id: item.id, text: item.text, session };
                  await ack(`Reemplazo armado \u2014 mand\u00e1 el texto nuevo para: "${item.text.slice(0, 60)}"`);
                  return;
                }
                await ack("Acci\u00f3n desconocida");
                return;
              }
              if (payload.startsWith("proj:")) {
                const chosen = projectsPicker[Number(payload.slice(5))];
                if (!chosen) {
                  await ack("El picker expir\u00f3 \u2014 mand\u00e1 /projects de nuevo");
                  return;
                }
                if (!(await forms.connect())) {
                  await ack("La API local no responde");
                  return;
                }
                try {
                  const created = await forms.request<{ id?: string }>("POST", "/session", {
                    location: { directory: chosen.directory },
                  });
                  if (!created?.id) {
                    await ack("No se pudo crear la sesi\u00f3n");
                    return;
                  }
                  const id = created.id;
                  log("INFO", `sesi\u00f3n nueva ${id.slice(0, 18)} en ${chosen.directory}`);
                  if (cq.message) {
                    await telegram
                      .editMessageText(
                        cq.message.chat.id,
                        cq.message.message_id,
                        `\u2728 Nueva sesi\u00f3n <code>${id.slice(0, 22)}\u2026</code> en <b>${escapeHtml(chosen.name)}</b>.\nEscribile \u2014 su hilo se crea con el primer mensaje, o us\u00e1 <code>/use ${id}</code>.`,
                        { parseMode: "HTML" },
                      )
                      .catch(() => undefined);
                  }
                  await ack("Sesi\u00f3n creada");
                } catch (error) {
                  log("WARN", "project session", safe(error));
                  await ack("No se pudo crear la sesi\u00f3n");
                }
                return;
              }              if (payload.startsWith("ag:")) {
                const chosen = agentPickerItems[Number(payload.slice(3))];
                const target = agentPickerTarget;
                if (!chosen || !target) {
                  await ack("El picker expiró — mandá /agents de nuevo");
                  return;
                }
                if (!(await forms.connect())) {
                  await ack("La API local no responde");
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
                  await ack("Agente cambiado");
                } catch (error) {
                  log("WARN", "agent set", safe(error));
                  await ack("No se pudo cambiar el agente");
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
      telegram.stop();
      await Promise.allSettled([pump, poll, acp.stop()]);
      pump = undefined;
      poll = undefined;
    }

    return joinBridge({ start, stop, alive: () => !streamClosed && (dry ? true : telegram.pollAlive()) }, config.mode);
  },
};
