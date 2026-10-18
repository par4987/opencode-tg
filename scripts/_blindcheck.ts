/**
 * Coverage watchdog: the pure decision `blindCoverage`.
 *
 * A leader that has delivered nothing for a while while the server holds
 * active sessions it never tracked is blind — the event stream silently
 * stopped fanning out foreign sessions (measured 2026-10-18: eight sessions
 * worked through the afternoon, only one left a trace). The helper is pure so
 * the self-heal trigger can be unit-tested without a live server.
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

  // Freshly started: never fire, even with untracked active sessions.
  check("recien arrancado no se releva", !blindCoverage(["ses_x"], tracked, now - 1_000, now), "90 s de gracia");

  // Recent delivery: healthy, no self-heal.
  check("entrega reciente no se releva", !blindCoverage(["ses_x"], tracked, now - 30_000, now), "30 s sin entrega");

  // Blind: idle long enough AND an active session never tracked.
  check("ciego: entrega vieja + sesion activa sin trackear", blindCoverage(["ses_x"], tracked, now - 200_000, now));

  // All active sessions already tracked: nothing missing -> healthy.
  check("todas las activas trackeadas: no se releva", !blindCoverage(["ses_a", "ses_b"], tracked, now - 200_000, now));

  // No active sessions at all: the bridge is simply idle.
  check("sin sesiones activas: no se releva", !blindCoverage([], tracked, now - 200_000, now));

  // Custom threshold: a longer minIdleMs.
  check("umbral largo: 90 s no alcanza con minIdleMs 300s", !blindCoverage(["ses_x"], tracked, now - 90_000, now, 300_000));
  check("umbral largo: 5 min sí", blindCoverage(["ses_x"], tracked, now - 310_000, now, 300_000));

  console.log(`\n${failures === 0 ? "BLINDCHECK OK" : `${failures} FALLOS`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main();