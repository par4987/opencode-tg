/**
 * Drives the REAL plugin entry (`setup`) with a fake `ctx`, replaying the
 * event shapes documented by @opencode/schema. Temporary — deleted after run.
 *
 * Proves: the plain-object export is accepted, the event pump routes every
 * event kind, and the rendered transcript comes out in order.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import plugin from "../index.js";

let failures = 0;
function check(name: string, condition: boolean, detail = ""): void {
  console.log(`${condition ? "  ok  " : "FAIL  "} ${name}${detail ? `  ${detail}` : ""}`);
  if (!condition) failures++;
}

const SID = "ses_setupcheck";

function* events(): Generator<{ type: string; data: Record<string, unknown> }> {
  const mid = { sessionID: SID, assistantMessageID: "asst1" };

  yield { type: "session.created", data: { sessionID: SID, location: { directory: "C:/Users/user/projects/demo" } } };
  yield { type: "session.renamed", data: { sessionID: SID, title: "Demo de arranque" } };

  // text block
  yield { type: "session.text.started", data: { ...mid, ordinal: 0 } };
  yield { type: "session.text.delta", data: { ...mid, ordinal: 0, delta: "Voy a revisar " } };
  yield { type: "session.text.delta", data: { ...mid, ordinal: 0, delta: "`src/app.ts` y correr `npm test`." } };
  yield { type: "session.text.ended", data: { ...mid, ordinal: 0 } };

  // tool lifecycle
  yield { type: "session.tool.input.started", data: { ...mid, id: "tool_1", name: "shell" } };
  yield { type: "session.tool.called", data: { ...mid, id: "tool_1", input: { command: "npm test" }, state: "running" } };
  yield { type: "session.tool.success", data: { ...mid, id: "tool_1", content: [{ type: "text", text: "PASS 12 tests\n(stdout enorme)" }] } };

  yield {
    type: "session.tool.called",
    data: { ...mid, id: "tool_2", input: { path: "C:/x/src/app.ts", oldString: "let a = 1", newString: "let a = 2\nlet b = 3" } },
  };
  yield { type: "session.tool.success", data: { ...mid, id: "tool_2", content: [{ type: "text", text: "Edited app.ts (1 replacement)" }] } };

  // second text block, same assistant message
  yield { type: "session.text.started", data: { ...mid, ordinal: 1 } };
  yield { type: "session.text.delta", data: { ...mid, ordinal: 1, delta: "Todo verde ✅" } };
  yield { type: "session.text.ended", data: { ...mid, ordinal: 1 } };

  yield { type: "session.execution.failed", data: { sessionID: SID, error: { message: "boom simulado" } } };
  yield { type: "permission.asked", data: { sessionID: SID, action: "edit", resources: ["C:/x/src/app.ts"] } };
  yield { type: "session.idle", data: { sessionID: SID } };

  yield { type: "session.tool.input.started", data: { ...mid, id: "tool_3", name: "read" } };
  yield { type: "session.tool.success", data: { ...mid, id: "tool_3", content: [{ type: "text", text: "1-40\nconst x = 1\n" }] } };
  yield { type: "session.idle", data: { sessionID: SID } };
}

const ctx = {
  event: {
    subscribe: (_options?: unknown) => (async function* () {
      yield* events();
    })(),
  },
  skill: {
    list: async () => [{ id: "experto-ewm", description: "SAP EWM con base canonica" }],
  },
} as never;

// ── capture everything the plugin logs ──────────────────────────────────────
const captured: string[] = [];
const originalLog = console.log;
const originalWarn = console.warn;
const originalError = console.error;
const sink = (...args: unknown[]): void => {
  captured.push(args.map(String).join(" "));
};
console.log = sink;
console.warn = sink;
console.error = sink;

// The harness drives the REAL plugin entry, which reads config.json. If that
// file says "live" the test would contact Telegram and push the fake transcript
// into a real chat. Force "dry" for the run and always put the file back — a
// test that can send real messages is a test that eventually will. Structural
// event dumps are needed to assert the routing, so they are forced on too.
const CONFIG = join(process.cwd(), "config.json");
const backup = readFileSync(CONFIG, "utf8");
const forced = backup
  .replace(/"mode"\s*:\s*"live"/, '"mode": "dry"')
  .replace(/"debugEvents"\s*:\s*false/, '"debugEvents": true');
writeFileSync(CONFIG, forced);

let cleanup: (() => Promise<void>) | undefined;
try {
  const result = await (plugin as { setup: (c: unknown) => unknown }).setup(ctx);
  cleanup = typeof result === "function" ? (result as () => Promise<void>) : undefined;
  await new Promise((resolve) => setTimeout(resolve, 400));
  if (cleanup) await cleanup();
} finally {
  console.log = originalLog;
  console.warn = originalWarn;
  console.error = originalError;
  writeFileSync(CONFIG, backup);
}

const text = captured.join("\n");
console.log("--- salida capturada del plugin ---");
for (const line of captured) console.log("  " + line.slice(0, 200));
console.log("--- fin ---\n");

check("setup() devuelve limpieza", typeof cleanup === "function");
check("entra en modo dry", /setup mode=dry/.test(text));
check("log de arranque", /ready \(dry\)/.test(text));
check("debug de eventos activo", /event session\.text\.started/.test(text));
check("el texto hace streaming en varios edits", (text.match(/EDIT /g) ?? []).length >= 2, `${(text.match(/EDIT /g) ?? []).length} edits`);
// The header now travels in front of the caret, so "SEND ▌" is gone: the
// marker line holds the session dot + title and the caret follows on it.
const CARET = /(?:SEND|EDIT) [\s\S]*?\u258C/;
check("tarjeta de shell usa la entrada", /SEND [\s\S]*shell<\/code>[\s\S]*npm test/.test(text) && !/PASS 12 tests<\/code>/.test(text));
check("la salida del tool no se vuelca", !/stdout enorme<\/code>/.test(text));
check("diff propio con +/-", /SEND[\s\S]*- let a = 1/.test(text) && /\+ let b = 3/.test(text));
check("orden cronologico: caret antes que el texto", text.search(/SEND [\s\S]*?\u258C/) !== -1 && text.search(/SEND [\s\S]*?\u258C/) < text.indexOf("EDIT "));
check("segundo bloque de texto es mensaje aparte", (text.match(/SEND [\s\S]*?\u258C/g) ?? []).length >= 2, `${(text.match(/SEND [\s\S]*?\u258C/g) ?? []).length} carets`);
check("cada mensaje lleva la etiqueta de su sesion", (text.match(/SEND [\s\S]*?<b>Demo de arranque<\/b>/g) ?? []).length >= 2);
check("notifica el fallo de ejecucion", /boom simulado/.test(text));
check("notifica el permiso pendiente", /pide permiso/.test(text));

// Every SEND/EDIT payload must be balanced HTML. Log lines carry a timestamp
// and a "[tg]" prefix before the marker, and a payload may span several lines.
const payloads = captured
  .map((line) => line.match(/\[tg\] #\d+ (?:SEND|EDIT) ([\s\S]*)$/)?.[1])
  .filter((value): value is string => typeof value === "string");
const balance = (html: string): boolean => {
  const stack: string[] = [];
  for (const match of html.matchAll(/<(\/?)([a-z]+)([^<>]*)>/gi)) {
    if (match[1]) {
      if (stack.pop() !== match[2].toLowerCase()) return false;
    } else if (!match[0].endsWith("/>")) stack.push(match[2].toLowerCase());
  }
  return stack.length === 0;
};
check("todo el HTML emitido esta balanceado", payloads.length > 0 && payloads.every(balance), `${payloads.length} mensajes`);
check("ningun mensaje pasa de 4096", payloads.every((p) => p.length <= 4096));

console.log(`\n${failures === 0 ? "TODO OK" : `${failures} FALLOS`}`);
process.exit(failures === 0 ? 0 : 1);
