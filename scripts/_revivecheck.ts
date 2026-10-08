/**
 * _revivecheck — a stopped transport comes back to life when its instance
 * is promoted again.
 *
 * The incident (2026-10-08): a hand-over promoted an instance whose
 * transport had been stopped earlier (a reload's cleanup, a deposal).
 * Telegram.stop() aborted the controller FOR GOOD, so the re-promoted
 * instance led with a corpse: setMyCommands and every render answered
 * "aborted", the mirror went silent while the seat was held, and the poll
 * died on its first tick past the startup grace. The fix: revive() — a
 * fresh controller and heartbeat, called by the bridge's start() before
 * anything talks, and again by longPoll defensively.
 *
 * No network: the transport points at a dead local port. The assertion is
 * WHICH failure a send gets — a corpse send dies with "aborted" (the
 * signal fires before any connect); a revived send dies with the
 * connection error instead.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Telegram } from "../src/telegram.js";

let failures = 0;
function check(label: string, ok: boolean, extra?: string): void {
  console.log(`  ${ok ? "ok  " : "FAIL"} ${label}${extra !== undefined ? `  ${extra}` : ""}`);
  if (!ok) failures += 1;
}

const messageOf = (error: unknown): string => String((error as Error)?.message ?? error);

async function main(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "tg-revive-"));
  const tg = new Telegram({
    token: "0:dummynotoken",
    // A port nothing listens on: fetch rejects instantly, no real network.
    baseUrl: "http://127.0.0.1:59993",
    offsetPath: join(dir, "offset.txt"),
  });

  try {
    // 1. Alive: a send fails with the connection error, not with "aborted".
    const aliveError = messageOf(await tg.sendMessage(1, "hola").catch((e) => e));
    check("vivo: el send falla por red, no por abort", !/aborted/.test(aliveError), aliveError.slice(0, 60));

    // 2. Stop: the corpse signature. The aborted signal fires before any
    //    connect, so the send answers immediately with "aborted".
    await tg.stop();
    check("detenido: pollAlive false", tg.pollAlive() === false);
    const corpseError = messageOf(await tg.sendMessage(1, "hola").catch((e) => e));
    check("detenido: el send muere con 'aborted'", /aborted/.test(corpseError), corpseError.slice(0, 60));

    // 3. Re-promotion: the bridge's start() revives before talking. The
    //    sync part of revive runs before any await, so the heartbeat and
    //    the fresh controller are visible immediately.
    tg.revive();
    check("revivido: pollAlive true al instante", tg.pollAlive() === true);
    const revivedError = messageOf(await tg.sendMessage(1, "hola").catch((e) => e));
    check("revivido: el send ya NO aborta", !/aborted/.test(revivedError), revivedError.slice(0, 60));

    // 4. The whole cycle: stop again, then longPoll (what the promoted
    //    bridge runs) re-revives by itself — no manual call needed.
    await tg.stop();
    check("re-detenido: pollAlive false de nuevo", tg.pollAlive() === false);
    const corpse2 = messageOf(await tg.sendMessage(1, "hola").catch((e) => e));
    check("re-detenido: vuelve a abortar", /aborted/.test(corpse2), corpse2.slice(0, 60));
    const poll = tg.longPoll(() => undefined, () => undefined).catch(() => undefined);
    check("longPoll revive por si solo", tg.pollAlive() === true);
    const revived2 = messageOf(await tg.sendMessage(1, "hola").catch((e) => e));
    check("tras longPoll el send ya no aborta", !/aborted/.test(revived2), revived2.slice(0, 60));

    // Cleanup: stop kills the loop's backoff delays so the process can exit.
    await tg.stop();
    check("limpieza final: pollAlive false", tg.pollAlive() === false);
    void poll;
  } finally {
    await tg.stop();
    rmSync(dir, { recursive: true, force: true });
  }
}

main()
  .catch((error) => {
    console.log("  el test mismo fallo:", String(error).slice(0, 300));
    failures++;
  })
  .finally(() => {
    console.log(`\n${failures === 0 ? "TODO OK" : `${failures} FALLOS`}`);
    process.exit(failures === 0 ? 0 : 1);
  });
