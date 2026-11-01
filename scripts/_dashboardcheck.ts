/**
 * Pruebas del dashboard fijado por hilo.
 *
 * Cubre el módulo de estado persistente (src/dashboard-state.ts) y el
 * transporte de pin/despin en modo dry (sin red). El anclado real contra
 * Telegram se verifica en vivo.
 */
import { mkdtempSync, writeFileSync, readFileSync, unlinkSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  readDashboardState,
  writeDashboardState,
  setDashboardEntry,
  removeDashboardEntry,
  dashboardStatePath,
  type DashboardEntry,
} from "../src/dashboard-state.js";
import { DryRunTelegram } from "../src/telegram.js";

let failures = 0;
function check(name: string, condition: boolean, detail = ""): void {
  console.log(`${condition ? "  ok  " : "FAIL  "} ${name}${detail ? `  ${detail}` : ""}`);
  if (!condition) failures++;
}

const STATE_DIR = mkdtempSync(join(tmpdir(), "tg-dashboard-state-"));
process.env.TG_TOKEN_STATE_DIR = STATE_DIR;

// ── 1. estado vacío / archivo ausente ────────────────────────────────────────
check("sin archivo devuelve mapa vacío", readDashboardState().size === 0);
check("no deja archivo al leer", !existsSync(dashboardStatePath()));

// ── 2. escribir entrada y leer de vuelta ─────────────────────────────────────
const state = readDashboardState();
const entry: DashboardEntry = { chatId: 6844904367, messageId: 42, sessionID: "ses_dashboard" };
setDashboardEntry(state, 7, entry);
check("persiste en dashboard-state.json", existsSync(dashboardStatePath()));
const back = readDashboardState();
check("lee entrada escrita", back.get(7) !== undefined && back.get(7)?.messageId === 42 && back.get(7)?.sessionID === "ses_dashboard");

// ── 3. actualizar entrada existente ──────────────────────────────────────────
setDashboardEntry(state, 7, { chatId: 6844904367, messageId: 99, sessionID: "ses_dashboard" });
const back2 = readDashboardState();
check("actualiza la entrada", back2.get(7)?.messageId === 99);

// ── 4. eliminar entrada ──────────────────────────────────────────────────────
check("remove devuelve true", removeDashboardEntry(state, 7) === true);
check("después de eliminar no está", readDashboardState().get(7) === undefined);
check("remove de inexistente devuelve false", removeDashboardEntry(state, 7) === false);

// ── 5. archivo corrupto → mapa vacío ─────────────────────────────────────────
writeFileSync(dashboardStatePath(), "{ no es json", "utf8");
check("archivo corrupto devuelve mapa vacío", readDashboardState().size === 0);

// ── 6. ruta bajo TG_TOKEN_STATE_DIR ──────────────────────────────────────────
check("ruta bajo el estado del token", dashboardStatePath().startsWith(STATE_DIR));

// ── 7. pin / unpin en modo dry (sin red) ─────────────────────────────────────
const sent: string[] = [];
const tg = new DryRunTelegram((_kind, _text) => sent.push(_text));
const pinned = await tg.pinChatMessage(6844904367, 42);
check("pinChatMessage dry devuelve true", pinned === true);
const unpinned = await tg.unpinChatMessage(6844904367, 42);
check("unpinChatMessage dry devuelve true", unpinned === true);
const unpinnedAll = await tg.unpinChatMessage(6844904367);
check("unpinChatMessage sin messageId dry devuelve true", unpinnedAll === true);

console.log(`\n${failures === 0 ? "TODO OK" : `${failures} FALLOS`}`);
process.exit(failures === 0 ? 0 : 1);
