/**
 * Pruebas de integración del dashboard fijado por hilo contra un API mock local.
 *
 * Arranca el plugin real (modo dry) contra un servidor HTTP que simula el
 * endpoint local de OpenCode, y verifica:
 *  - que el transporte pinChatMessage / unpinChatMessage hace las llamadas HTTP
 *    correctas contra la API mock (no solo DryRunTelegram);
 *  - que el estado del dashboard persiste y se lee de vuelta tras un
 *    "reinicio simulado" (nueva lectura desde disco).
 */
import { mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createServer, type Server } from "node:http";
import { Telegram } from "../src/telegram.js";
import {
  readDashboardState,
  setDashboardEntry,
  removeDashboardEntry,
  dashboardStatePath,
  type DashboardEntry,
} from "../src/dashboard-state.js";

let failures = 0;
function check(name: string, condition: boolean, detail = ""): void {
  console.log(`${condition ? "  ok  " : "FAIL  "} ${name}${detail ? `  ${detail}` : ""}`);
  if (!condition) failures++;
}

const STATE_DIR = mkdtempSync(join(tmpdir(), "tg-dash-integration-"));
process.env.TG_TOKEN_STATE_DIR = STATE_DIR;

// ── API mock local ───────────────────────────────────────────────────────────
const calls: Array<{ method: string; path: string; body: string }> = [];
const api = createServer((req, res) => {
  const url = req.url ?? "";
  let body = "";
  req.on("data", (chunk: Buffer) => (body += chunk.toString("utf8")));
  req.on("end", () => {
    calls.push({ method: req.method ?? "?", path: url, body });
    if (url === "/api/info") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ pid: process.pid }));
    } else if (/^\/session\//.test(url)) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ id: "ses_x", title: "Mi sesión", model: { providerID: "anthropic", id: "claude-3" }, tokens: { input: 100, output: 50 }, cost: 0.00123 }));
    } else if (url.includes("/pinChatMessage") || url.includes("/unpinChatMessage")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, result: true }));
    } else {
      res.writeHead(404, { "content-type": "application/json" });
      res.end("{}");
    }
  });
});
await new Promise<void>((resolve) => api.listen(0, "127.0.0.1", resolve));
const address = api.address();
const port = typeof address === "object" && address ? address.port : 0;

process.env.TELEGRAM_BOT_TOKEN = "test-fake-token-no-secrets";
process.env.ALLOWED_USERS = "123456789";
process.env.TG_MODE = "dry";

// ── 1. pinChatMessage real contra la API mock ────────────────────────────────
const tg = new Telegram({ token: "test-fake-token-no-secrets", baseUrl: `http://127.0.0.1:${port}`, pollTimeout: 1 });
const pinned = await tg.pinChatMessage(6844904367, 42);
check("pinChatMessage HTTP devuelve true", pinned === true);
const pinCall = calls.find((c) => c.path.includes("/pinChatMessage"));
check("pinChatMessage llamó a la API mock", pinCall !== undefined);
check("pinChatMessage envió chat_id y message_id", pinCall?.body.includes("6844904367") && pinCall?.body.includes("42"));

const unpinned = await tg.unpinChatMessage(6844904367, 42);
check("unpinChatMessage HTTP devuelve true", unpinned === true);
const unpinCall = calls.find((c) => c.path.includes("/unpinChatMessage"));
check("unpinChatMessage llamó a la API mock", unpinCall !== undefined);
check("unpinChatMessage envió chat_id y message_id", unpinCall?.body.includes("6844904367") && unpinCall?.body.includes("42"));

// ── 2. persistencia del estado del dashboard (simulando reinicio) ────────────
const state = readDashboardState();
const entry: DashboardEntry = { chatId: 6844904367, messageId: 42, sessionID: "ses_x" };
setDashboardEntry(state, 7, entry);
check("escribe entrada en disco", existsSync(dashboardStatePath()));

// "Reinicio": nueva instancia lee el archivo desde cero
const state2 = readDashboardState();
const e2 = state2.get(7);
check("lee entrada tras reinicio simulado", e2 !== undefined && e2.messageId === 42 && e2.sessionID === "ses_x");

// ── 3. limpieza ──────────────────────────────────────────────────────────────
check("remove devuelve true", removeDashboardEntry(state2, 7) === true);
check("tras eliminar no hay entrada", readDashboardState().get(7) === undefined);

await tg.stop();
await new Promise<void>((resolve) => api.close(() => resolve()));

console.log(failures === 0 ? "\nTODO OK" : `\n${failures} FALLOS`);
process.exit(failures === 0 ? 0 : 1);
