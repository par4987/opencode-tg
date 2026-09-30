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
 */
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const LOCK_DIR = join(homedir(), ".opencode", "tg");
const LOCK_FILE = join(LOCK_DIR, "leader.lock");

/** No heartbeat in this window means the holder died without releasing. */
const STALE_MS = 15_000;
const HEARTBEAT_MS = 5_000;

interface LockFile {
  pid: number;
  since: number;
  beat: number;
}

function readLock(): LockFile | undefined {
  try {
    const parsed = JSON.parse(readFileSync(LOCK_FILE, "utf8")) as LockFile;
    if (typeof parsed.pid !== "number" || typeof parsed.beat !== "number") return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}

function writeLock(lock: LockFile): void {
  try {
    writeFileSync(LOCK_FILE, JSON.stringify(lock));
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
 * Take the lock if it is free or its holder is dead. Returns whether this
 * process is now the leader.
 */
export function acquireLock(): boolean {
  const now = Date.now();
  const existing = readLock();

  if (existing && existing.pid !== process.pid) {
    const dead = !pidAlive(existing.pid) || now - existing.beat > STALE_MS;
    if (!dead) return false;
    if (existing.pid > 0 && pidAlive(existing.pid)) {
      // Alive but silent: another contender may be racing us, so let the
      // heartbeat margin decide rather than seizing on a single stale read.
      return false;
    }
  }

  writeLock({ pid: process.pid, since: existing?.since ?? now, beat: now });

  // Re-read: if a faster writer won, bow out instead of splitting the poll.
  const after = readLock();
  return !!after && after.pid === process.pid;
}

/** Refresh the heartbeat so other processes know we are still here. */
export function heartbeat(): void {
  const existing = readLock();
  if (!existing || existing.pid !== process.pid) return;
  writeLock({ ...existing, beat: Date.now() });
}

/** Release only if the lock is still ours. */
export function releaseLock(): void {
  const existing = readLock();
  if (!existing || existing.pid !== process.pid) return;
  try {
    unlinkSync(LOCK_FILE);
  } catch {
    /* already gone */
  }
}

export function lockHeldBy(): number | undefined {
  const existing = readLock();
  return existing?.pid;
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
