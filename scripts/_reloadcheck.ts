/**
 * Pruebas de /reload — marcador de recibo (src/reload-notice.ts).
 *
 * El POST a /location/reload y el despacho del comando /reload se verifican
 * en vivo (el comando reconstruye todas las locations, incluido este plugin,
 * y solo puede probarse de verdad contra el bot). Aquí se prueba la lógica
 * del marcador que hace posible el recibo:
 *
 *  - escritura + lectura fresca (pendiente y hecho, con duración)
 *  - chat distinto no coincide
 *  - expiración por antigüedad (por defecto 180 s y maxAge personalizado)
 *  - limpieza explícita y archivo corrupto
 *  - ruta dentro del directorio de estado del token
 *
 * Además se arranca el plugin real contra una API mock local para confirmar
 * que el transporte descubre el endpoint (GET /api/info) en modo dry.
 */
import { mkdtempSync, writeFileSync, readFileSync, unlinkSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createServer, type Server } from "node:http";
import {
  writeReloadNotice,
  clearReloadNotice,
  readFreshReloadNotice,
  reloadNoticePath,
  type ReloadNotice,
} from "../src/reload-notice.js";

let failures = 0;
function check(name: string, condition: boolean, detail = ""): void {
  console.log(`${condition ? "  ok  " : "FAIL  "} ${name}${detail ? `  ${detail}` : ""}`);
  if (!condition) failures++;
}

const STATE_DIR = mkdtempSync(join(tmpdir(), "tg-reload-state-"));
process.env.TG_TOKEN_STATE_DIR = STATE_DIR;

// ── API mock local (mismos paths que usa FormClient) ─────────────────────────
let reloadCalls = 0;
let infoCalls = 0;
const api = createServer((req, res) => {
  const url = req.url ?? "";
  if (url === "/api/info") {
    infoCalls += 1;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ pid: process.pid }));
    return;
  }
  if (url === "/location/reload" && req.method === "POST") {
    reloadCalls += 1;
    res.writeHead(204);
    res.end();
    return;
  }
  res.writeHead(404, { "content-type": "application/json" });
  res.end("{}");
});
await new Promise<void>((resolve) => api.listen(0, "127.0.0.1", resolve));

// service.json para que servicePassword() devuelva algo y forms.connect() pueda
// autenticar contra la API mock; el .env real queda enmascarado por process.env.
const xdg = mkdtempSync(join(tmpdir(), "tg-reload-xdg-"));
mkdirSync(join(xdg, "opencode"), { recursive: true });
writeFileSync(join(xdg, "opencode", "service.json"), JSON.stringify({ password: "reload-test-pw" }));
process.env.XDG_CONFIG_HOME = xdg;
process.env.TELEGRAM_BOT_TOKEN = "test-fake-token-no-secrets";
process.env.ALLOWED_USERS = "123456789";
process.env.TG_MODE = "dry";
process.env.TG_PUMP_REFRESH_MS = "120";
delete process.env.TG_LOCALE;

const CHAT = 6844904367;
const OTHER = 111111111;

// ── 1. sin marcador ──────────────────────────────────────────────────────────
check("sin marcador devuelve undefined", readFreshReloadNotice(CHAT) === undefined);
check("no deja archivo residual", !existsSync(reloadNoticePath()));

// ── 2. escribir pendiente y leer fresco ──────────────────────────────────────
const at = Date.now();
writeReloadNotice({ chatId: CHAT, threadId: 7, at, stage: "pending" });
const n = readFreshReloadNotice(CHAT);
check("lee marcador pendiente", n !== undefined && n.stage === "pending" && n.chatId === CHAT && n.threadId === 7);
check("marcador persistido en disco", existsSync(reloadNoticePath()));

// ── 3. chat distinto no coincide ─────────────────────────────────────────────
check("chat distinto devuelve undefined", readFreshReloadNotice(OTHER) === undefined);

// ── 4. hecho con duración ────────────────────────────────────────────────────
const at2 = Date.now();
writeReloadNotice({ chatId: CHAT, at: at2, stage: "done", secs: 4.5 });
const d = readFreshReloadNotice(CHAT);
check("lee marcador done con secs", d !== undefined && d.stage === "done" && typeof d.secs === "number" && d.secs === 4.5);

// ── 5. expiración por antigüedad (default 180 s) ─────────────────────────────
const old = Date.now() - 200_000;
writeReloadNotice({ chatId: CHAT, at: old, stage: "pending" });
check("marcador caducado devuelve undefined", readFreshReloadNotice(CHAT) === undefined);
check("marcador caducado se limpia", !existsSync(reloadNoticePath()));

// ── 6. maxAge personalizado ──────────────────────────────────────────────────
const justo = Date.now() - 10_000;
writeReloadNotice({ chatId: CHAT, at: justo, stage: "pending" });
check("dentro de maxAge personalizado", readFreshReloadNotice(CHAT, 60_000) !== undefined);
check("fuera de maxAge personalizado", readFreshReloadNotice(CHAT, 5_000) === undefined);
clearReloadNotice();

// ── 7. archivo corrupto ──────────────────────────────────────────────────────
writeFileSync(reloadNoticePath(), "{ no es json valido", "utf8");
check("archivo corrupto devuelve undefined", readFreshReloadNotice(CHAT) === undefined);

// ── 8. limpieza explícita ────────────────────────────────────────────────────
writeReloadNotice({ chatId: CHAT, at: Date.now(), stage: "pending" });
clearReloadNotice();
check("clear borra el archivo", !existsSync(reloadNoticePath()));

// ── 9. ruta dentro del directorio de estado del token ────────────────────────
check("ruta bajo TG_TOKEN_STATE_DIR", reloadNoticePath().startsWith(STATE_DIR));

// ── 10. arranque real del plugin contra la API mock ──────────────────────────
const { setup } = (await import("../index.js")).default as { setup: (c: unknown) => unknown };
const captured: string[] = [];
const origLog = console.log;
console.log = (...args: unknown[]) => captured.push(args.map(String).join(" "));
const ctx = {
  event: {
    subscribe: () => {
      const gen = (async function* () { })();
      return gen;
    },
  },
  skill: { list: async () => [] },
} as never;
let cleanup: (() => Promise<void>) | undefined;
try {
  const result = await setup(ctx);
  cleanup = typeof result === "function" ? (result as () => Promise<void>) : undefined;
  // El log de arranque puede llegar justo después de que setup() resuelva
  // (la bomba de eventos arranca en segundo plano); esperarlo con tope.
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline && !captured.some((line) => line.includes("setup mode=dry"))) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  if (cleanup) await cleanup();
} finally {
  console.log = origLog;
  api.close();
}
const text = captured.join("\n");
check("plugin arranca en modo dry", /setup mode=dry/.test(text));
check("la bomba descubrio la API local (GET /api/info)", infoCalls >= 1, `${infoCalls} llamadas`);

console.log(`\n${failures === 0 ? "TODO OK" : `${failures} FALLOS`}`);
process.exit(failures === 0 ? 0 : 1);
