/**
 * _localecheck — the i18n catalog's three guards.
 *
 * 1. Parity: every Spanish key must exist in English and vice versa — a
 *    missing EN key silently falls back to Spanish at a user's phone,
 *    which is how half-translated UIs are born.
 * 2. No unknown keys: every `t("...")` the plugin calls must exist in the
 *    ES catalog — a typo'd key renders as the raw key string.
 * 3. The literal budget: the migration of old Spanish literals to `t()`
 *    ratchets DOWN. The number below is the current count of one-line
 *    `reply("...")` / `ack("...")` literals in index.ts; new user-facing
 *    strings must go through the catalog, so adding one without migrating
 *    another fails here.
 */
// The runtime-locale machinery reads TG_LOCALE_FILE at module load — set
// it BEFORE importing so the suite never touches the real persisted choice.
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const LOCALE_FILE = join(mkdtempSync(join(tmpdir(), "tg-locale-")), "locale.txt");
process.env.TG_LOCALE_FILE = LOCALE_FILE;
delete process.env.TG_LOCALE;
const { catalogKeys, t, setLocale, locale, availableLocales } = await import("../src/locale.js");
const { commandSections } = await import("../src/help.js");
import { fileURLToPath } from "node:url";

/** Drop one per migrated string; never raise without the user's say-so. */
const LITERAL_BUDGET = 0;

let failures = 0;
function check(label: string, ok: boolean, extra?: string): void {
  console.log(`  ${ok ? "ok  " : "FAIL"} ${label}${extra !== undefined ? `  ${extra}` : ""}`);
  if (!ok) failures += 1;
}

function main(): void {
  // 1. Parity — both directions, so neither catalog can drift.
  const { es, en } = catalogKeys();
  const esSet = new Set(es);
  const enSet = new Set(en);
  const missingEN = es.filter((k) => !enSet.has(k));
  const missingES = en.filter((k) => !esSet.has(k));
  check("paridad ES -> EN", missingEN.length === 0, missingEN.join(", ") || "completa");
  check("paridad EN -> ES", missingES.length === 0, missingES.join(", ") || "completa");

  // 2. Every t() key used by the plugin exists in the catalog — index.ts
  //    AND every src module (they call t() since the orphan batch).
  const src = readFileSync(fileURLToPath(new URL("../index.ts", import.meta.url)), "utf8");
  const srcDir = fileURLToPath(new URL("../src", import.meta.url));
  const moduleBodies = readdirSync(srcDir)
    .filter((f) => f.endsWith(".ts") && f !== "locale.ts")
    .map((f) => readFileSync(join(srcDir, f), "utf8"));
  const used = new Set<string>();
  for (const body of [src, ...moduleBodies]) {
    for (const m of body.matchAll(/\bt\("(\w+)"(?:\s*,\s*\{[^}]*\})?\)/g)) used.add(m[1]);
  }
  const unknown = [...used].filter((k) => !esSet.has(k));
  check(
    `las ${used.size} claves t() existen en el catalogo`,
    unknown.length === 0,
    unknown.join(", ") || "todas",
  );

  // 3. The literal budget — the migration ratchets DOWN. Two shapes are
  //    guarded: the original one-line `reply("literal")` form, and any
  //    reply/ack whose call STARTS with a quote (concatenations, inline
  //    ifs). Ternary arms inside a call are the one shape left to human
  //    review.
  const literals = [...src.matchAll(/(?:^|\n)[ \t]*(?:const \w+ = )?(?:await )?(?:reply|ack)\("(?:[^"\\]|\\.)*"\)/g)];
  check(
    `presupuesto de literales: ${literals.length} <= ${LITERAL_BUDGET}`,
    literals.length <= LITERAL_BUDGET,
    literals.length <= LITERAL_BUDGET ? "en regimen" : "baja migrando o suma al catalogo",
  );
  const callStarts = [...src.matchAll(/(?:reply|ack)\(\s*"/g)];
  check(
    `ningun reply/ack arranca con literal: ${callStarts.length}`,
    callStarts.length === 0,
    callStarts.length === 0 ? "en regimen" : "migrado al catalogo",
  );

  // 4. Cards and button labels: no Spanish literal outside t() may reach the
  //    user. The budgets above are blind to multi-line sendMessage(...)
  //    bodies and inline_keyboard labels; this guard walks the message-call
  //    windows with a paren-depth counter and flags every Spanish literal
  //    in them (escapes decoded first — "\u00e1" is á). A false positive
  //    means the string goes through t() or the word leaves the list.
  const ES_MARK =
    /[áéíóúñÁÉÍÓÚÑ¿¡]|\b(No se pudo|No pude|Cancelar|Cancelado|Guardar|Deshacer|deshecho|Aprobar|Aprobado|Rechazar|rechazado|Siempre|Eliminar|Cerrar|Sesiones|Confirmá|Confirmar|Decime|Escribilo|Escribile|próxima|tarea|Tarea|Ningun|hilo|turno|mensaje|mensajes|modelo|agente|permiso|entradas|primeras|proyecto|carpeta|vigilando|reemplazo|forkear|respondido|respondela|todos los|cada|vez|una|uno|pregunta|respuesta|instrucciones|listar|descargar|descargado|correr|anotar|anotado|mover|orden|elegido|enviados|inyectar|ejecutando|ejecutar|salida|existe|inexistente|disponible|conectado|desconectado|comando|documento|sesion|archivo|sin|estaba|sugerencias)\b/i;
  const decode = (s: string): string =>
    s
      .replace(/\\u\{([0-9a-fA-F]+)\}/g, (_, h: string) => String.fromCodePoint(parseInt(h, 16)))
      .replace(/\\u([0-9a-fA-F]{4})/g, (_, h: string) => String.fromCharCode(parseInt(h, 16)));

  /**
   * The text of every string literal on one line, delimiters dropped.
   *
   * A regex like /"(...)"/ is blind to nested templates: on
   * `` `<b>${x || `Pregunta ${n}`}</b>` `` it pairs the OUTER opening
   * backtick with the INNER one, so the Spanish inside never reaches the
   * marker. This walks the line instead, tracking quotes and `${}` depth.
   * Unterminated literals (a template that starts here and continues on the
   * next line) yield everything up to the end of the line.
   */
  const literalSpans = (line: string): string[] => {
    const out: string[] = [];
    let i = 0;
    while (i < line.length) {
      const c = line[i];
      if (c === '"' || c === "`") {
        const quote = c;
        const start = i + 1;
        i++;
        let depth = 0;
        let closed = false;
        while (i < line.length) {
          if (line[i] === "\\") {
            i += 2;
            continue;
          }
          if (quote === "`" && line[i] === "$" && line[i + 1] === "{") {
            depth++;
            i += 2;
            continue;
          }
          if (quote === "`" && line[i] === "}" && depth > 0) {
            depth--;
            i++;
            continue;
          }
          if (line[i] === quote && depth === 0) {
            i++;
            closed = true;
            break;
          }
          i++;
        }
        out.push(line.slice(start, closed ? i - 1 : i));
        continue;
      }
      i++;
    }
    return out.filter((s) => s.length >= 2);
  };

  /** Everything between `t("key"` and its matching `)` — the arguments. */
  const tArgs = (line: string, from: number): string => {
    let depth = 1;
    for (let i = from; i < line.length; i++) {
      if (line[i] === "(") depth++;
      else if (line[i] === ")") {
        depth--;
        if (depth === 0) return line.slice(from, i);
      }
    }
    return line.slice(from);
  };
  const srcLines = src.split("\n");
  let depth = 0;
  let insideGuarded = false;
  let openAt = 0;
  const cardOffenders: Array<string> = [];
  srcLines.forEach((raw, i) => {
    const stripped = raw.replace(/\bt\("(\w+)"(?:\s*,\s*\{[^}]*\})?\)/g, "T()");
    const opens = (stripped.match(/\(/g) ?? []).length;
    const closes = (stripped.match(/\)/g) ?? []).length;
    const opensGuarded = /(?:sendMessage|editMessageText|sendPhoto|sendDocument)\(/.test(stripped) || /\bawait send\(/.test(stripped);
    const labelLine = /\btext:\s*\(?\s*"/.test(stripped);
    if (opensGuarded && !insideGuarded && !labelLine) {
      insideGuarded = true;
      openAt = depth;
    }
    if (insideGuarded || labelLine) {
      // Double-quoted literals AND backtick templates — the /help header
      // hid in a template the first guard could not see, and a nested
      // template (`... ${x || `Pregunta ${n}`} ...`) hides again from any
      // regex that pairs delimiters: use the walking extractor instead.
      // Escapes decoded before the marker test.
      for (const raw2 of literalSpans(stripped)) {
        if (ES_MARK.test(decode(raw2))) cardOffenders.push(`L${i + 1}: ${decode(raw2).slice(0, 60)}`);
      }
    }
    depth += opens - closes;
    if (depth < 0) depth = 0;
    if (insideGuarded && depth <= openAt) insideGuarded = false;
  });
  check(
    `sin literales hispanos en tarjetas y botones: ${cardOffenders.length}`,
    cardOffenders.length === 0,
    cardOffenders.slice(0, 6).join(" | ") || "en regimen",
  );

  // 4b. Orphans: user-facing strings built OUTSIDE the message windows —
  //     cards assembled in consts and joined later (the /context lesson),
  //     reply/ack ternaries, thrown errors that surface in cards, prompt
  //     prefixes, labels. Same marker, now over every source file, skipping
  //     what the pass above already covers (message windows), the log
  //     windows (operator diagnostics stay Spanish by design: the incident
  //     corpus is grepped in Spanish) and comments. t() calls strip first.
  const orphanOffenders: Array<string> = [];
  const sources = [
    { name: "index.ts", body: src },
    ...readdirSync(srcDir)
      .filter((f) => f.endsWith(".ts") && f !== "locale.ts")
      .map((f) => ({ name: `src/${f}`, body: readFileSync(join(srcDir, f), "utf8") })),
  ];
  for (const file of sources) {
    const lines = file.body.split("\n");
    let oDepth = 0;
    let insideMsg = false;
    let insideLog = false;
    let msgAt = 0;
    let logAt = 0;
    lines.forEach((raw, i) => {
      const stripped = raw.replace(/\bt\("(\w+)"(?:\s*,\s*\{[^}]*\})?\)/g, "T()");
      const opens = (stripped.match(/\(/g) ?? []).length;
      const closes = (stripped.match(/\)/g) ?? []).length;
      const opensMsg = /(?:sendMessage|editMessageText|sendPhoto|sendDocument)\(/.test(stripped) || /\bawait send\(/.test(stripped);
      const opensLog = /\blog\.(?:info|warn|error|debug|trace)\(/.test(stripped) || /\bconsole\.(?:log|error|warn|info)\(/.test(stripped) || /\blog\(\s*"/.test(stripped);
      const labelLine = /\btext:\s*\(?\s*"/.test(stripped);
      if (opensMsg && !insideMsg && !labelLine) {
        insideMsg = true;
        msgAt = oDepth;
      }
      if (opensLog && !insideLog) {
        insideLog = true;
        logAt = oDepth;
      }
      const inWindow = insideMsg || labelLine || insideLog;
      oDepth += opens - closes;
      if (oDepth < 0) oDepth = 0;
      if (insideMsg && oDepth <= msgAt) insideMsg = false;
      if (insideLog && oDepth <= logAt) insideLog = false;
      if (inWindow) return;
      const trimmed = stripped.trim();
      if (trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*")) return;
      // Inline comments: strip `// ...` only when it sits outside a literal
      // (balanced quotes before it).
      let line = stripped;
      const cIdx = line.indexOf("//");
      if (cIdx !== -1) {
        const before = line.slice(0, cIdx);
        if ((before.match(/"/g) ?? []).length % 2 === 0 && (before.match(/`/g) ?? []).length % 2 === 0) line = before;
      }
      for (const raw2 of literalSpans(line)) {
        if (ES_MARK.test(decode(raw2))) orphanOffenders.push(`${file.name} L${i + 1}: ${decode(raw2).slice(0, 50)}`);
      }
    });
  }
  check(
    `sin literales hispanos huerfanos: ${orphanOffenders.length}`,
    orphanOffenders.length === 0,
    orphanOffenders.slice(0, 6).join(" | ") || "en regimen",
  );

  // 4c. Spanish riding INSIDE a t() call. The strippers above swallow a whole
  //     `t("key", {...})`, so an untranslated fragment in the argument object
  //     (`err_generic`'s `action: "correr"`) reaches neither pass 4 nor 4b:
  //     the call looks translated while the sentence that lands on the phone
  //     is still Spanish. Scan what follows the key, up to its `)`.
  const argOffenders: Array<string> = [];
  for (const file of sources) {
    file.body.split("\n").forEach((raw, i) => {
      for (const m of raw.matchAll(/\bt\(\s*["'`](\w+)["'`]/g)) {
        const args = tArgs(raw, (m.index ?? 0) + m[0].length);
        for (const lit of literalSpans(args)) {
          if (ES_MARK.test(decode(lit))) argOffenders.push(`${file.name} L${i + 1}: ${decode(lit).slice(0, 50)}`);
        }
      }
    });
  }
  check(
    `sin espanol en argumentos de t(): ${argOffenders.length}`,
    argOffenders.length === 0,
    argOffenders.slice(0, 6).join(" | ") || "en regimen",
  );

  // 5. Placeholders: a key with {name} must be called with it — spot check
  //    the mechanism itself through the public t().
  check("t() rellena placeholders", t("sh_done", { exit: 0 }).includes("0"));
  check("t() deja el placeholder visible si falta el valor", t("ago_min").includes("{n}"));

  // 6. The runtime switch — what /locale does from the phone.
  check(
    `los idiomas disponibles son los del catalogo: ${availableLocales().join(",")}`,
    availableLocales().join(",") === "es,en",
  );
  check("sin archivo ni env arranca en ES", locale() === "es");
  check("t() en ES por defecto", t("api_down").includes("La API local"));
  check("setLocale('en') acepta", setLocale("en") === true);
  check("locale() ahora es en", locale() === "en");
  check("t() cambia de catalogo sin recargar", t("api_down").includes("The local API"));
  check("setLocale rechaza lo que no existe", setLocale("klingon") === false);
  check("y no cambia el locale vigente", locale() === "en");
  check("la eleccion persiste en el archivo", readFileSync(LOCALE_FILE, "utf8").trim() === "en");
  check("setLocale('ES') normaliza mayusculas", setLocale("ES") === true && locale() === "es");
  check("t() vuelve a espanol", t("api_down").includes("La API local"));

  // 7. The /help sections follow the language: the parser picks
  //    COMMANDS.<locale>.md and the brief marker is language-neutral.
  const esBrief = commandSections().find((s) => s.name === "new")?.brief ?? "";
  check("secciones en espanol", esBrief.startsWith("Crea"), esBrief.slice(0, 30));
  setLocale("en");
  const enBrief = commandSections().find((s) => s.name === "new")?.brief ?? "";
  check("secciones en ingles tras el switch", enBrief.startsWith("Creates"), enBrief.slice(0, 30));
  check("la categoria tambien", (commandSections().find((s) => s.name === "new")?.category ?? "") === "Sessions");
  setLocale("es");
  rmSync(dirname(LOCALE_FILE), { recursive: true, force: true });
}

function dirname(p: string): string {
  return p.slice(0, p.lastIndexOf("/") + 1).replace(/\\$/, "");
}

main();
console.log(`\n${failures === 0 ? "TODO OK" : `${failures} FALLOS`}`);
process.exit(failures === 0 ? 0 : 1);
