/**
 * Cross-process leader election.
 *
 * The in-process registry keeps one bridge per *process*, but OpenCode runs
 * several: the service daemon, one or more TUIs, CLI invocations. All of them
 * load this plugin, all of them see the whole event stream, and in live mode
 * each would start its own `getUpdates` — Telegram answers that with HTTP 409
 * and serves only one of them.
 *
 * So the in-process leader also has to win a process-wide election. The lock
 * is a small JSON file carrying the winner's pid and a heartbeat: the holder
 * refreshes the heartbeat while it works, and a holder whose heartbeat went
 * stale (or whose pid is gone) is considered dead and can be replaced.
 *
 * This deliberately favours "one bridge, always" over "fastest to grab": a
 * tie is resolved by the last writer, and `firstSighting()` in index.ts is the
 * backstop that drops the duplicate events a hand-over can leak.
 *
 * The lock file is keyed by the TOKEN FINGERPRINT (src/bots.ts): every
 * instance running the same bot token — even from a different checkout or
 * state directory — contends the SAME file, so one token always has exactly
 * one poller. Callers that pass no file keep the legacy path (tests).
 */
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const LOCK_DIR = join(homedir(), ".opencode", "tg");
const LOCK_FILE = join(LOCK_DIR, "leader.lock");

const HEARTBEAT_MS = 5_000;
/**
 * A live pid whose heartbeat froze this long is *wedged* — the process
 * breathes but its event loop (or just its poll) is stuck, so no code of
 * its will ever release the lock. Measured failure: a hand-off-installed
 * leader lost its monitor, the poll hung mid-handler, the heartbeat froze,
 * and every healthy process waited forever on an "alive" holder. Past this
 * margin the lock must be contestable or one hung process takes the whole
 * bridge down.
 */
export const WEDGED_MS = 60_000;

interface LockFile {
  pid: number;
  since: number;
  beat: number;
}

/** Tests point this at a temp file so they never touch the real election. */
function lockPath(): string {
  return process.env.TG_LOCK_FILE ?? LOCK_FILE;
}

function readLock(file: string): LockFile | undefined {
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as LockFile;
    if (typeof parsed.pid !== "number" || typeof parsed.beat !== "number") return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}

function writeLock(file: string, lock: LockFile): void {
  try {
    writeFileSync(file, JSON.stringify(lock));
  } catch {
    /* the lock is best effort; the plugin still works without it */
  }
}

/** A pid we cannot signal is not running. */
function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Take the lock if it is free, its holder is dead, or its holder is wedged
 * (alive but heartbeat-frozen past WEDGED_MS). Returns whether this process
 * is now the leader.
 */
export function acquireLock(file?: string): boolean {
  const path = file ?? lockPath();
  const now = Date.now();
  const existing = readLock(path);

  if (existing && existing.pid !== process.pid) {
    const dead = !pidAlive(existing.pid);
    const wedged = !dead && now - existing.beat > WEDGED_MS;
    if (!dead && !wedged) return false;
  }

  writeLock(path, { pid: process.pid, since: existing?.since ?? now, beat: now });

  // Re-read: if a faster writer won, bow out instead of splitting the poll.
  const after = readLock(path);
  return !!after && after.pid === process.pid;
}

/** Refresh the heartbeat so other processes know we are still here. */
export function heartbeat(file?: string): void {
  const path = file ?? lockPath();
  const existing = readLock(path);
  if (!existing || existing.pid !== process.pid) return;
  writeLock(path, { ...existing, beat: Date.now() });
}

/** Release only if the lock is still ours. */
export function releaseLock(file?: string): void {
  const path = file ?? lockPath();
  const existing = readLock(path);
  if (!existing || existing.pid !== process.pid) return;
  try {
    unlinkSync(path);
  } catch {
    /* already gone */
  }
}

export function lockHeldBy(file?: string): number | undefined {
  return readLock(file ?? lockPath())?.pid;
}

export const LOCK_INTERVAL = HEARTBEAT_MS;
export const LOCK_PATH = LOCK_FILE;

/** Directory creation is lazy: dry mode never needs the lock. */
export function ensureLockDir(): void {
  try {
    if (!existsSync(LOCK_DIR)) mkdirSync(LOCK_DIR, { recursive: true });
  } catch {
    /* best effort */
  }
}
