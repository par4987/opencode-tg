/**
 * The in-process leadership races behind the 2026-10-08 storm.
 *
 * What must hold: when the registry seat empties, EXACTLY ONE instance of
 * the process takes it â€” no matter how many waiters' watchdogs resume from
 * the same dead leader's stop â€” and a leader that is still starting is not
 * deposed for not being alive *yet*.
 *
 * Both bugs were measured live: five "toma el liderazgo" in one second,
 * five getUpdates on one token, Telegram answering every one of them with
 * HTTP 409. The file lock could not arbitrate because it is per PID â€”
 * every instance of the process "wins" it â€” so the arbitration lives in
 * the registry, and the registry only works if check-and-set happens at
 * contest time, not on the stale read from the top of the tick.
 *
 * The starting-leader grace is shrunk through TG_STARTUP_GRACE_MS so the
 * suite can also watch it EXPIRE: a leader that dies after the grace is
 * still deposable â€” the grace must not make corpses immortal.
 */
import type { BridgeSeat } from "../index.js";
import { unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Before the import: the grace is read at module load, and live mode must
// never touch the real cross-process election.
process.env.TG_STARTUP_GRACE_MS = "300";
const LOCK = join(tmpdir(), "opencode-tg-seat-test.lock");
process.env.TG_LOCK_FILE = LOCK;
const { joinBridge } = await import("../index.js");

let failures = 0;
function check(name: string, condition: boolean, detail = ""): void {
  console.log(`${condition ? "  ok  " : "FAIL  "} ${name}${detail ? `  ${detail}` : ""}`);
  if (!condition) failures++;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/**
 * The raw side of a member â€” what the plugin wires to real transports. The
 * gates park start()/stop() mid-flight, which is what turns the tick's
 * fire-and-forget awaits into interleavings the test controls by hand.
 */
class Fake {
  startCalls = 0;
  stopCalls = 0;
  aliveNow = true;
  private readonly startGate?: Promise<void>;
  private readonly stopGate?: Promise<void>;

  constructor(
    public readonly name: string,
    gates?: { start?: Promise<void>; stop?: Promise<void> },
  ) {
    this.startGate = gates?.start;
    this.stopGate = gates?.stop;
  }

  async start(): Promise<void> {
    this.startCalls++;
    if (this.startGate) await this.startGate;
  }
  async stop(): Promise<void> {
    this.stopCalls++;
    if (this.stopGate) await this.stopGate;
  }
  alive(): boolean {
    return this.aliveNow;
  }
}

/** The registry joinBridge keeps on globalThis â€” same symbol, read-only. */
type SeatRegistry = {
  leader?: object;
  members: Set<object>;
  wrappers: WeakMap<object, object>;
};
function registry(): SeatRegistry {
  return (globalThis as unknown as Record<PropertyKey, unknown>)[
    Symbol.for("opencode-tg.registry")
  ] as SeatRegistry;
}
function leaderIs(raw: Fake): boolean {
  const reg = registry();
  return reg.leader !== undefined && reg.leader === reg.wrappers.get(raw);
}

/** Drain a scenario: waiters first, the leader last, so no hand-over fires. */
async function drain(members: Array<{ raw: Fake; seat: BridgeSeat }>): Promise<void> {
  const reg = registry();
  const leaderWrapper = reg.leader;
  const ordered = [...members].sort(
    (a, b) =>
      (reg.wrappers.get(a.raw) === leaderWrapper ? 1 : 0) -
      (reg.wrappers.get(b.raw) === leaderWrapper ? 1 : 0),
  );
  for (const m of ordered) await m.seat.cleanup();
}

async function member(name: string, gates?: { start?: Promise<void>; stop?: Promise<void> }) {
  const raw = new Fake(name, gates);
  const seat = await joinBridge(raw, "live");
  return { raw, seat };
}

async function main(): Promise<void> {
  try {
    unlinkSync(LOCK);
  } catch {
    /* not there */
  }

  // â”€â”€ 1. The storm: two waiters resume from the same dead leader â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  // B deposes A and parks inside the awaited stop; C ticks while B is parked
  // and takes the seat. When B resumes, the old code installed B too â€” the
  // lock said yes (same pid) and the registry seat was never re-checked.
  {
    const stopGate = deferred();
    const a = await member("A", { stop: stopGate.promise });
    const b = await member("B");
    const c = await member("C");
    await sleep(400); // A's startup grace must be over before it can read dead
    a.raw.aliveNow = false;
    const deposing = b.seat.tick(); // B: dead leader -> seat freed -> parked
    await c.seat.tick(); // C: seat empty -> takes it
    check("C toma el asiento mientras B espera el stop del muerto", leaderIs(c.raw));
    stopGate.resolve();
    await deposing; // B resumes: the seat is no longer empty
    check("B no se instala al reanudar (re-chequeo al momento de disputar)", leaderIs(c.raw));
    check("B nunca arranco", b.raw.startCalls === 0, `${b.raw.startCalls} llamadas`);
    check("C arranco una sola vez", c.raw.startCalls === 1, `${c.raw.startCalls} llamadas`);
    check("A fue frenado una sola vez", a.raw.stopCalls === 1, `${a.raw.stopCalls} llamadas`);
    await drain([a, b, c]);
    const reg = registry();
    check("el registro queda vacio tras el drain", reg.members.size === 0 && reg.leader === undefined);
  }

  // â”€â”€ 2. The startup grace: a starting leader is not a dead one â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  // A2's start hangs; B2's watchdog tick inside that window must leave it
  // alone. The old alive() answered false there (the started flag was not
  // set yet), and the first waiter to tick deposed the fresh leader.
  {
    const startGate = deferred();
    const a2raw = new Fake("A2", { start: startGate.promise });
    let a2seat: BridgeSeat | undefined;
    const a2joined = joinBridge(a2raw, "live").then((seat) => {
      a2seat = seat;
      return seat;
    });
    const b2 = await member("B2");
    check("A2 lleva el asiento mientras arranca", leaderIs(a2raw));
    await b2.seat.tick();
    check("el watchdog no depone a una lider arrancando", leaderIs(a2raw));
    check("A2 esta dentro de la ventana de arranque", a2raw.startCalls === 1);
    startGate.resolve();
    await a2joined;
    check("A2 termino de arrancar y retiene el asiento", leaderIs(a2raw));
    await sleep(400); // grace over: instance.alive() is authoritative again
    await b2.seat.tick();
    check("pasada la gracia, una lider viva sigue en pie", leaderIs(a2raw));
    a2raw.aliveNow = false;
    await b2.seat.tick(); // now the death is real: depose, and B2 wins
    check("tras la gracia la muerta es deponida y B2 gana", leaderIs(b2.raw));
    check("B2 arranco una sola vez", b2.raw.startCalls === 1, `${b2.raw.startCalls} llamadas`);
    if (!a2seat) throw new Error("el asiento de A2 nunca llego");
    await drain([
      { raw: a2raw, seat: a2seat },
      { raw: b2.raw, seat: b2.seat },
    ]);
  }

  // â”€â”€ 3. Cleanup hand-over: a seat won meanwhile is not overwritable â”€â”€â”€â”€â”€â”€
  // A3 leads; its cleanup parks inside stop(); C3 takes the seat meanwhile.
  // The old cleanup resumed and installed the FIRST remaining member (B3)
  // on top of C3 â€” two leaders again.
  {
    const stopGate = deferred();
    const a3 = await member("A3", { stop: stopGate.promise });
    const b3 = await member("B3");
    const c3 = await member("C3");
    const cleaningUp = a3.seat.cleanup();
    await c3.seat.tick(); // C3 wins the seat while A3's cleanup is parked
    check("C3 tomo el asiento durante el cleanup de A3", leaderIs(c3.raw));
    stopGate.resolve();
    await cleaningUp;
    check("el cleanup no sobrescribe a C3 con el traspaso a B3", leaderIs(c3.raw));
    check("B3 nunca arranco", b3.raw.startCalls === 0, `${b3.raw.startCalls} llamadas`);
    await drain([b3, c3]);
  }

  // â”€â”€ 4. The dead leader's own hand-over does not overwrite the winner â”€â”€â”€â”€
  // A4 dies; its own tick frees the seat and parks inside stop(); C4 takes
  // the seat meanwhile. Resuming, the old code installed the first remaining
  // member (B4) over C4.
  {
    const stopGate = deferred();
    const a4 = await member("A4", { stop: stopGate.promise });
    const b4 = await member("B4");
    const c4 = await member("C4");
    await sleep(400); // grace over: A4's self-check can see its own death
    a4.raw.aliveNow = false;
    const selfTick = a4.seat.tick(); // A4 deposes ITSELF, parks in stop()
    await c4.seat.tick(); // C4 wins while A4 is parked
    check("C4 tomo el asiento durante la abdicacion de A4", leaderIs(c4.raw));
    stopGate.resolve();
    await selfTick;
    check("la abdicacion no instala a B4 encima de C4", leaderIs(c4.raw));
    check("B4 nunca arranco", b4.raw.startCalls === 0, `${b4.raw.startCalls} llamadas`);
    await drain([a4, b4, c4]);
  }

  try {
    unlinkSync(LOCK);
  } catch {
    /* already gone */
  }
}

main()
  .catch((error) => {
    console.log("  el test mismo fallo:", String(error).slice(0, 400));
    failures++;
  })
  .finally(() => {
    console.log(`\n${failures === 0 ? "TODO OK" : `${failures} FALLOS`}`);
    process.exit(failures === 0 ? 0 : 1);
  });
