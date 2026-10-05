/**
 * Cross-process leader election: the file lock's rules.
 *
 * What must hold: a free lock is taken, a healthy foreign holder keeps it,
 * a dead one loses it — and, since the measured incident of 2026-10-05, a
 * LIVE holder whose heartbeat froze past the wedge margin loses it too.
 * That last rule is the difference between "one hung process" and "the
 * whole bridge dark until a manual restart": the poll had hung, no monitor
 * existed to release the lock, and every healthy process waited forever on
 * an "alive but silent" holder.
 */
import { spawn } from "node:child_process";
import { readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The tests must never touch the real election.
const LOCK = join(tmpdir(), "opencode-tg-leader-test.lock");
process.env.TG_LOCK_FILE = LOCK;
const { acquireLock, heartbeat, lockHeldBy, releaseLock, WEDGED_MS } = await import("../src/leader.js");

let failures = 0;
function check(name: string, condition: boolean, detail = ""): void {
  console.log(`${condition ? "  ok  " : "FAIL  "} ${name}${detail ? `  ${detail}` : ""}`);
  if (!condition) failures++;
}

function writeForeignLock(pid: number, beat: number): void {
  writeFileSync(LOCK, JSON.stringify({ pid, since: beat, beat }));
}

// A foreign LIVE pid: a child that outlives the whole suite.
const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: "ignore" });
const foreignPid = child.pid ?? -1;

function main(): void {
  try {
    unlinkSync(LOCK);
  } catch {
    /* not there */
  }

  // 1. Free lock: taken, and the holder is us.
  check("lock libre se toma", acquireLock() === true);
  check("lockHeldBy somos nosotros", lockHeldBy() === process.pid);
  check("re-toma del propio pid es idempotente", acquireLock() === true);

  // 2. Heartbeat: refreshes the beat a challenger would read.
  const before = Date.now();
  heartbeat();
  const raw = JSON.parse(readFileSync(LOCK, "utf8")) as { pid: number; beat: number };
  check("heartbeat refresca el beat", raw.pid === process.pid && raw.beat >= before);

  // 3. Release: only if it is still ours.
  releaseLock();
  check("release deja el lock libre", lockHeldBy() === undefined);

  // 4. Healthy foreign holder (live pid, fresh beat): the lock is theirs.
  writeForeignLock(foreignPid, Date.now());
  check("holder extranjero vivo y fresco conserva el lock", acquireLock() === false);
  check("y sigue siendo el", lockHeldBy() === foreignPid);

  // 5. Dead foreign holder: replaced immediately, beat or no beat.
  writeForeignLock(999_999_999, Date.now());
  check("holder muerto pierde el lock", acquireLock() === true);
  releaseLock();

  // 6. THE INCIDENT: live holder, frozen heartbeat.
  //    Fresh-but-aging (inside the margin): still theirs — a healthy
  //    process must not be robbed on a single stale read.
  writeForeignLock(foreignPid, Date.now() - Math.round(WEDGED_MS / 2));
  check("holder vivo con beat a medio camino conserva el lock", acquireLock() === false);
  //    Past the wedge margin: contestable — a hung poller must be
  //    replaceable, or one wedged process takes the whole bridge down.
  writeForeignLock(foreignPid, Date.now() - WEDGED_MS - 5_000);
  check("holder WEDGED (vivo, beat congelado) pierde el lock", acquireLock() === true);
  check("el nuevo holder somos nosotros", lockHeldBy() === process.pid);

  // 7. Cleanup: release only touches our own lock.
  writeForeignLock(foreignPid, Date.now());
  releaseLock();
  check("release no toca un lock ajeno", lockHeldBy() === foreignPid);

  try {
    unlinkSync(LOCK);
  } catch {
    /* already gone */
  }
  child.kill();

  console.log(failures === 0 ? "\nLEADER OK" : `\n${failures} FALLOS`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
