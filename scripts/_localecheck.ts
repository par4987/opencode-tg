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
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
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

  // 2. Every t() key used by the plugin exists in the catalog.
  const src = readFileSync(fileURLToPath(new URL("../index.ts", import.meta.url)), "utf8");
  const used = new Set<string>();
  for (const m of src.matchAll(/\bt\("(\w+)"(?:\s*,\s*\{[^}]*\})?\)/g)) used.add(m[1]);
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
    /[áéíóúñÁÉÍÓÚÑ¿¡]|Cancelar|Guardar|Deshacer|Aprobar|Rechazar|Siempre|Eliminar|Cerrar|Sesiones|Confirmá|Confirmar|Decime|Escribilo|próxima|tarea|Tarea|Ningun|hilo /i;
  const decode = (s: string): string =>
    s
      .replace(/\\u\{([0-9a-fA-F]+)\}/g, (_, h: string) => String.fromCodePoint(parseInt(h, 16)))
      .replace(/\\u([0-9a-fA-F]{4})/g, (_, h: string) => String.fromCharCode(parseInt(h, 16)));
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
      // hid in a template the first guard could not see. Escapes decoded,
      // ${...} interpolations ignored by the marker test (no Spanish there).
      for (const m of stripped.matchAll(/"((?:[^"\\]|\\.){2,})"/g)) {
        if (ES_MARK.test(decode(m[1]))) cardOffenders.push(`L${i + 1}: ${decode(m[1]).slice(0, 60)}`);
      }
      for (const m of stripped.matchAll(/`((?:[^`\\]|\\.){6,})`/g)) {
        if (ES_MARK.test(decode(m[1]))) cardOffenders.push(`L${i + 1}: ${decode(m[1]).slice(0, 60)}`);
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
