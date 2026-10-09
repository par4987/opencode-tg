/**
 * Multi-bot topology: which Telegram bot mirrors which session.
 *
 * The bridge used to be one bot, one forum, one thread per session. With
 * extra tokens in `~/.opencode/tg/.env` (`TELEGRAM_BOT_TOKEN_<NAME>`) it can
 * run several bots at once, and this module answers the only question that
 * matters: when an event for session X arrives, which bot's chat renders it?
 *
 * Topologies:
 *   single       — one bot mirrors everything (the classic bridge).
 *   per-project  — each project directory owns one bot; its sessions are
 *                  threads of that bot's forum. Assignments come from
 *                  `bots.assign` in config.json (explicit) or are claimed
 *                  from the free pool on first real activity (auto).
 *   per-session  — each session claims a bot from the pool; the session's
 *                  conversation lives at that chat's ROOT and the threads
 *                  are its subagents.
 *
 * Claims are pinned and persisted (`~/.opencode/tg/bots.json`) so restarts
 * keep the same session in the same bot; the primary bot is never in the
 * auto pool — it is the hub everything without a bot of its own falls back
 * to. A claim is only taken on CLAIM_TRIGGERS (a turn actually running or
 * finishing): the server replays dozens of dormant sessions at startup, and
 * letting those eat the pool would starve every live session.
 *
 * No Telegram I/O lives here — the routing is pure enough to test against
 * stubs, and index.ts owns the transports.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { log, safe } from "./log.js";
import type { Config } from "./config.js";

export type Topology = "single" | "per-project" | "per-session";

export interface BotSpec {
  /** Token key suffix: TELEGRAM_BOT_TOKEN_<NAME> in the .env. */
  name: string;
  /** Filesystem-safe form of `name` (offset files, logs). */
  slug: string;
  token: string;
  /** Where this bot writes; defaults to the first allowed user. */
  chatId?: number;
  offsetPath: string;
  primary: boolean;
}

export interface BotAssign {
  project: string;
  bot: string;
}

/**
 * The only events that prove a session is alive — a turn starting, a tool
 * running, or a turn finishing. Session listings and `session.created` alone
 * never claim: dormant sessions replayed at server startup would drain the
 * pool before anything real got a chance.
 */
export const CLAIM_TRIGGERS = new Set([
  "session.text.started",
  "session.reasoning.started",
  "session.tool.input.started",
  "session.tool.called",
  "session.idle",
]);

/** Windows-robust directory comparison: case, slashes and trailing slash die. */
export function normDir(dir: string): string {
  return dir.replace(/[\\/]+/g, "/").replace(/\/+$/, "").toLowerCase();
}

/** "SAP Research!" -> "sap-research"; the fallback keeps files nameable. */
export function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "bot";
}

/** Each bot acknowledges its own updates, so each needs its own offset file. */
export function offsetPathFor(slug: string): string {
  const dir = process.env.TG_STATE_DIR ?? join(homedir(), ".opencode", "tg");
  return join(dir, slug === "main" ? "offset.txt" : `offset-${slug}.txt`);
}

/** The primary bot plus every extra token the .env declared, in order. */
export function buildSpecs(config: Config): BotSpec[] {
  const specs: BotSpec[] = [
    {
      name: "main",
      slug: "main",
      token: config.token,
      chatId: config.allowedUsers[0],
      offsetPath: offsetPathFor("main"),
      primary: true,
    },
  ];
  const slugs = new Set(["main"]);
  const names = new Set(["main"]);
  for (const extra of config.extraBots) {
    const slug = slugify(extra.name);
    if (names.has(extra.name) || slugs.has(slug)) {
      log("WARN", `bot ${extra.name}: nombre o slug duplicado — ignorado`);
      continue;
    }
    names.add(extra.name);
    slugs.add(slug);
    specs.push({
      name: extra.name,
      slug,
      token: extra.token,
      chatId: extra.chatId ?? config.allowedUsers[0],
      offsetPath: offsetPathFor(slug),
      primary: false,
    });
  }
  return specs;
}

export interface Claim {
  kind: "project" | "session";
  /** Normalized directory (project) or session id (session). */
  key: string;
  at: number;
}

interface ClaimsFile {
  claims?: Record<string, Claim>;
}

/** What the registry needs to know about a session it is asked to route. */
export interface RegistryLookup {
  session(sessionID: string): { parentID?: string; directory?: string } | undefined;
}

const DEFAULT_CLAIMS_FILE = () => join(homedir(), ".opencode", "tg", "bots.json");

export class BotRegistry {
  private claims: Record<string, Claim> = {};
  private loaded = false;

  constructor(
    readonly specs: BotSpec[],
    readonly topology: Topology,
    readonly assign: BotAssign[],
    private readonly file: string,
    private readonly lookup: RegistryLookup,
    private readonly now: () => number = () => Date.now(),
  ) {}

  private load(): void {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const parsed = JSON.parse(readFileSync(this.file, "utf8")) as ClaimsFile;
      if (parsed?.claims && typeof parsed.claims === "object") this.claims = parsed.claims;
    } catch {
      /* first run, or a corrupt file — start empty */
    }
  }

  private persist(): void {
    try {
      if (!existsSync(this.file)) mkdirSync(dirname(this.file), { recursive: true });
      writeFileSync(this.file, JSON.stringify({ claims: this.claims }, null, 2), "utf8");
    } catch (error) {
      log("WARN", "bots: no se pudo persistir el claim", safe(error));
    }
  }

  primary(): BotSpec {
    return this.specs[0];
  }

  byName(name: string): BotSpec | undefined {
    return this.specs.find((spec) => spec.name === name);
  }

  /** The bot a key is already pinned to (no side effects). */
  private heldBy(key: string, kind: Claim["kind"]): BotSpec | undefined {
    this.load();
    for (const spec of this.specs) {
      const claim = this.claims[spec.name];
      if (claim && claim.kind === kind && claim.key === key) return spec;
    }
    return undefined;
  }

  private assignFor(dir: string): BotSpec | undefined {
    for (const entry of this.assign) {
      if (normDir(entry.project) !== dir) continue;
      const spec = this.byName(entry.bot);
      if (spec) return spec;
    }
    return undefined;
  }

  /** The auto pool: extras only — the primary is the fallback hub, never auto-claimed. */
  private firstFree(): BotSpec | undefined {
    this.load();
    return this.specs.find((spec) => !spec.primary && !this.claims[spec.name]);
  }

  private claim(spec: BotSpec, kind: Claim["kind"], key: string): void {
    this.load();
    this.claims[spec.name] = { kind, key, at: this.now() };
    this.persist();
  }

  /**
   * The owning bot for a session. `mayClaim` is the pump saying "a turn is
   * really happening" — without it the registry only resolves from what is
   * already pinned, so listings and lookups never consume the pool.
   */
  of(sessionID: string, mayClaim = false, dirHint?: string): BotSpec {
    if (this.topology === "single") return this.primary();

    // A subagent belongs to its parent's bot: its thread mirrors next to the
    // conversation that spawned it (in per-session mode that is exactly the
    // "threads are the subagents" shape). Walk up with a depth guard against
    // bad parent chains.
    let hop = 0;
    let session = this.lookup.session(sessionID);
    while (session?.parentID && hop++ < 5) {
      const parent = this.lookup.session(session.parentID);
      if (!parent) break;
      return this.of(session.parentID, mayClaim, dirHint);
    }

    if (this.topology === "per-session") {
      const held = this.heldBy(sessionID, "session");
      if (held) return held;
      if (mayClaim) {
        const free = this.firstFree();
        if (free) {
          this.claim(free, "session", sessionID);
          log("INFO", `bot ${free.name} reclama la sesion ${sessionID.slice(0, 18)}`);
          return free;
        }
      }
      return this.primary();
    }

    // per-project
    const dir = normDir(dirHint ?? session?.directory ?? "");
    if (dir) {
      const held = this.heldBy(dir, "project");
      if (held) return held;
      const mapped = this.assignFor(dir);
      if (mapped) {
        if (this.claims[mapped.name]?.key !== dir) this.claim(mapped, "project", dir);
        return mapped;
      }
      if (mayClaim) {
        const free = this.firstFree();
        if (free) {
          this.claim(free, "project", dir);
          log("INFO", `bot ${free.name} reclama el proyecto ${dir}`);
          return free;
        }
      }
    }
    return this.primary();
  }

  /** True when per-session mode has no free bot for this session — the hub
   * will mirror it and deserves a heads-up (sent once per session). */
  exhausted(sessionID: string): boolean {
    if (this.topology !== "per-session") return false;
    this.load();
    const session = this.lookup.session(sessionID);
    if (session?.parentID) return false;
    if (this.heldBy(sessionID, "session")) return false;
    return this.firstFree() === undefined;
  }

  /** Is this session this bot's business? Used to scope listings per chat. */
  isMine(spec: BotSpec, sessionID: string, dirHint?: string): boolean {
    return this.of(sessionID, false, dirHint).name === spec.name;
  }

  /** The session this bot owns in per-session mode (its chat's root conversation). */
  ownedSession(spec: BotSpec): string | undefined {
    this.load();
    const claim = this.claims[spec.name];
    return claim?.kind === "session" ? claim.key : undefined;
  }

  /** The project this bot is pinned to in per-project mode, if any. */
  heldProject(spec: BotSpec): string | undefined {
    this.load();
    const claim = this.claims[spec.name];
    return claim?.kind === "project" ? claim.key : undefined;
  }

  claimedBy(spec: BotSpec): Claim | undefined {
    this.load();
    return this.claims[spec.name];
  }

  /** Give a bot back to the pool — its session falls to the hub. */
  release(spec: BotSpec): boolean {
    this.load();
    if (!this.claims[spec.name]) return false;
    delete this.claims[spec.name];
    this.persist();
    return true;
  }

  allClaims(): Record<string, Claim> {
    this.load();
    return { ...this.claims };
  }
}

/** Where the claims live — tests point this at a temp file. */
export function claimsFilePath(): string {
  return process.env.TG_BOTS_FILE ?? DEFAULT_CLAIMS_FILE();
}
