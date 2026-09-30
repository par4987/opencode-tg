/**
 * The `question` → form bridge.
 *
 * Two halves: the decision logic (which option does a typed "2" pick, what
 * shape does a multiselect answer take) — pure, so a wrong answer here would
 * be silent and wrong in a way the user would only notice by re-reading the
 * agent's reply — and the local API contract, probed without mutating
 * anything: a bad path falls through to the SPA and answers 200 with HTML,
 * while a correct path against a missing form answers 404 with JSON.
 */
import { execFileSync } from "node:child_process";
import { choicesOf, pickOption, answerFor, answerFree, parseFreeCommand, formatAnswer, servicePassword, type FormInfo } from "../src/forms.js";

let failures = 0;
function check(name: string, condition: boolean, detail = ""): void {
  console.log(`${condition ? "  ok  " : "FAIL  "} ${name}${detail ? `  ${detail}` : ""}`);
  if (!condition) failures++;
}

// ── decision logic ───────────────────────────────────────────────────────────
const twoChoices: FormInfo = {
  id: "form_test",
  sessionID: "ses_test",
  title: "Elegir",
  fields: [
    { key: "destino", type: "string", title: "¿A dónde?", options: [
      { value: "madrid", label: "Madrid" },
      { value: "londres", label: "Londres" },
      { value: "oslo", label: "Oslo" },
    ] },
    { key: "comentario", type: "string", title: "Comentario libre" },
  ],
};

check("choicesOf descarta el campo sin opciones", choicesOf(twoChoices).length === 1);
check(
  "choicesOf conserva el fieldIndex original",
  choicesOf(twoChoices)[0].fieldIndex === 0 && choicesOf(twoChoices)[0].fieldKey === "destino",
);
check("choicesOf marca multiselect", choicesOf(twoChoices)[0].multiple === false);

const choice = choicesOf(twoChoices)[0];
check("pickOption por número", pickOption(choice, "2")?.value === "londres");
check("pickOption por número con espacios", pickOption(choice, "  3 ")?.value === "oslo");
check("pickOption por label", pickOption(choice, "madrid")?.value === "madrid");
check("pickOption ignora mayúsculas", pickOption(choice, "MADRID")?.value === "madrid");
check("pickOption número fuera de rango → nada", pickOption(choice, "9") === undefined);
check("pickOption texto que no es label → nada", pickOption(choice, "hola") === undefined);
check("pickOption número 0 → nada", pickOption(choice, "0") === undefined);

check("answerFor simple → valor plano", JSON.stringify(answerFor(choice, choice.options[0])) === '{"destino":"madrid"}');
const multi = { ...choice, multiple: true };
check(
  "answerFor multiselect → array",
  JSON.stringify(answerFor(multi, choice.options[1])) === '{"destino":["londres"]}',
);

check("answerFree simple → texto crudo", JSON.stringify(answerFree(choice, "un crucero por el mediterráneo")) === '{"destino":"un crucero por el mediterráneo"}');
check("answerFree recorta espacios", JSON.stringify(answerFree(choice, "  París  ")) === '{"destino":"París"}');
check(
  "answerFree multiselect separa por comas",
  JSON.stringify(answerFree(multi, "madrid, londres , oslo,")) === '{"destino":["madrid","londres","oslo"]}',
);
check("parseFreeCommand extrae el texto", parseFreeCommand("/txt ni madrid ni londres") === "ni madrid ni londres");
check("parseFreeCommand con nombre de bot", parseFreeCommand("/txt@Pired314_bot quizá Oslo") === "quizá Oslo");
check("parseFreeCommand ignora mayúsculas", parseFreeCommand("/TXT alto") === "alto");
check("parseFreeCommand sin texto → nada", parseFreeCommand("/txt") === undefined);
check("parseFreeCommand solo espacios → nada", parseFreeCommand("/txt    ") === undefined);
check("parseFreeCommand texto común → nada", parseFreeCommand("hola mundo") === undefined);
check("parseFreeCommand conserva el número literal", parseFreeCommand("/txt 2") === "2");

check("formatAnswer une valores", formatAnswer({ a: "x", b: "y" }) === "x \u00b7 y");
check("formatAnswer array se une con coma", formatAnswer({ a: ["p", "q"] }) === "p, q");
check("formatAnswer vacío → cadena vacía", formatAnswer({}) === "");
check("formatAnswer no-objeto → cadena vacía", formatAnswer(undefined) === "");

// ── password ─────────────────────────────────────────────────────────────────
const password = servicePassword();
if (password.length > 0) {
  check("servicePassword lee service.json", true, `(${password.length} chars)`);
} else {
  console.log("  -- sin service.json local (CI) \u2014 checks de API local skipped");
}

// ── local API contract (read-only) ───────────────────────────────────────────
/**
 * The test runs in its own process, so it cannot reuse the plugin's
 * in-process discovery — it scans for a listener that answers our password
 * and reports a pid, which is the same confirmation `connect()` does.
 */
async function findServer(): Promise<string | null> {
  const auth = `Basic ${Buffer.from(`opencode:${password}`, "utf8").toString("base64")}`;
  let ports: number[];
  try {
    const out = execFileSync("netstat", ["-ano"], { encoding: "utf8", timeout: 5000, windowsHide: true });
    const seen = new Set<number>();
    for (const line of out.split(/\r?\n/)) {
      if (!line.includes("LISTENING")) continue;
      const cols = line.trim().split(/\s+/);
      if (cols.length < 5) continue;
      const port = Number(cols[1].split(":").pop());
      // Loopback only: the API is not meant to be reachable from elsewhere.
      if (cols[1].startsWith("127.0.0.1") && Number.isFinite(port)) seen.add(port);
    }
    ports = [...seen];
  } catch {
    return null;
  }
  const hit = await Promise.all(
    ports.map(async (port) => {
      try {
        const response = await fetch(`http://127.0.0.1:${port}/api/info`, {
          headers: { Authorization: auth },
          signal: AbortSignal.timeout(1200),
        });
        if (!response.ok) return null;
        const body = (await response.json()) as { pid?: number; version?: string };
        return typeof body.pid === "number" ? { port, pid: body.pid, version: body.version } : null;
      } catch {
        return null;
      }
    }),
  );
  const found = hit.find(Boolean);
  return found ? `http://127.0.0.1:${found.port}/api` : null;
}

const base = password.length > 0 ? await findServer() : null;
if (password.length > 0) {
  check("se encontró una API local con nuestro password", base !== null, base ?? "");
} else {
  console.log("  -- API local con password: skipped (CI)");
}
if (base) {
  const auth = `Basic ${Buffer.from(`opencode:${password}`, "utf8").toString("base64")}`;
  const call = (path: string, init: RequestInit = {}) =>
    fetch(`${base}${path}`, { ...init, headers: { Authorization: auth, "Content-Type": "application/json", ...(init.headers ?? {}) } });

  // A known session: an empty form list proves path + `{data}` unwrapping.
  const sessions = (await (await call(`/session?limit=1`)).json()) as { data?: Array<{ id: string }> };
  const sid = sessions.data?.[0]?.id ?? "";
  check("GET /session responde con data", sid.length > 0, sid.slice(0, 24));

  const list = await call(`/session/${sid}/form`);
  const listBody = (await list.json()) as { data?: unknown };
  check("GET .../form es 200 y viene envuelto en {data}", list.status === 200 && Array.isArray(listBody.data), `status=${list.status}`);

  // The reply URL itself. The server answers 404 for a path it does not route
  // and 400 for a form handler that ran and found no such form, so 400 is what
  // distinguishes "right URL, missing form" from "URL we made up" — and both
  // are JSON, never the SPA's HTML.
  const fake = "/session/" + sid + "/form/does_not_exist";
  const reply = await call(`${fake}/reply`, {
    method: "POST",
    body: JSON.stringify({ answer: { x: "y" } }),
  });
  check(
    "POST .../reply existe (400 = handler corrió, no 404 de ruta)",
    reply.status === 400 && !(reply.headers.get("content-type") ?? "").includes("text/html"),
    `status=${reply.status}`,
  );

  const cancel = await call(fake, { method: "DELETE" });
  check(
    "DELETE .../form/{id} existe (400 = handler corrió, no 404 de ruta)",
    cancel.status === 400 && !(cancel.headers.get("content-type") ?? "").includes("text/html"),
    `status=${cancel.status}`,
  );

  // Control: a URL we made up must 404, otherwise the two checks above prove
  // nothing — they would pass for any string appended to the path.
  const bogus = await call(`${fake}/replyy`, { method: "POST", body: JSON.stringify({ answer: {} }) });
  check("control: una ruta inventada da 404", bogus.status === 404, `status=${bogus.status}`);

  // 404 here means the session lookup failed, not that the route is missing —
  // so this asserts the handler distinguishes the two, which is what
  // `settleForm` relies on to report a real failure.
  const badSession = await call("/session/ses_does_not_exist/form/abc/reply", {
    method: "POST",
    body: JSON.stringify({ answer: { x: "y" } }),
  });
  check("sesión inexistente → 404 (antes de llegar al form)", badSession.status === 404, `status=${badSession.status}`);
}

console.log(failures === 0 ? `\nFORMSCHECK OK` : `\nFORMSCHECK ${failures} FALLOS`);
process.exit(failures === 0 ? 0 : 1);
