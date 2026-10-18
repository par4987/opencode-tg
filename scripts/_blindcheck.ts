/**
 * Coverage watchdog: the pure decision `blindCoverage`.
 *
 * Two ways to be blind, both must trip:
 *  - FAST: a session the mirror has never tracked is active past the grace
 *    window (the seat changed mid-run).
 *  - SLOW: the mirror has delivered nothing for a long while even though a
 *    session is running — the stream went quiet for sessions it USED to
 *    deliver (the 2026-10-18 failure: silent for 84 minutes with no trigger,
 *    because "tracked" was sticky).
 */
import { blindCoverage } from "../index.js";

let failures = 0;
function check(name: string, condition: boolean, detail = ""): void {
  console.log(`${condition ? "  ok  " : "FAIL  "} ${name}${detail ? `  ${detail}` : ""}`);
  if (!condition) failures++;
}

function main(): void {
  const now = 10_000;
  const tracked = new Set<string>(["ses_a", "ses_b"]);

  // Grace: freshly started leader, never fire.
  check("recien arrancado no se releva", !blindCoverage(["ses_x"], tracked, now - 90_000, now), "90 s");

  // Recent delivery: healthy.
  check("entrega reciente no se releva", !blindCoverage(["ses_x"], tracked, now - 30_000, now), "30 s");

  // Fast path: past the grace with a never-tracked active session.
  check("rapida: sesion activa sin trackear", blindCoverage(["ses_x"], tracked, now - 200_000, now), "3 min 20 s");

  // Fast path but every active session is tracked: wait for the slow path.
  check("rapida: todo trackeado no se releva", !blindCoverage(["ses_a"], tracked, now - 200_000, now), "3 min 20 s");

  // Slow path: prolonged silence even for sessions already tracked.
  check("lenta: 10 min+ de silencio aunque este trackeada", blindCoverage(["ses_a"], tracked, now - 610_000, now));
  check("lenta: 9 min 50 s no alcanza", !blindCoverage(["ses_a"], tracked, now - 590_000, now));

  // Bridge simply idle: nothing running, nothing to mirror.
  check("sin sesiones activas: no se releva", !blindCoverage([], tracked, now - 610_000, now));

  // Custom slow threshold.
  check("umbral lento custom (15 min): 15 min 10 s si", blindCoverage(["ses_a"], tracked, now - 910_000, now, 120_000, 900_000));
  check("umbral lento custom (15 min): 14 min 50 s no", !blindCoverage(["ses_a"], tracked, now - 890_000, now, 120_000, 900_000));

  console.log(`\n${failures === 0 ? "BLINDCHECK OK" : `${failures} FALLOS`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
