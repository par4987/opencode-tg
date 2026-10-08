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
import { catalogKeys, t } from "../src/locale.js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** Drop one per migrated string; never raise without the user's say-so. */
const LITERAL_BUDGET = 158;

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

  // 3. The literal budget — one-line reply/ack literals still in the code.
  const literals = [...src.matchAll(/(?:^|\n)[ \t]*(?:const \w+ = )?(?:await )?(?:reply|ack)\("(?:[^"\\]|\\.)*"\)/g)];
  check(
    `presupuesto de literales: ${literals.length} <= ${LITERAL_BUDGET}`,
    literals.length <= LITERAL_BUDGET,
    literals.length <= LITERAL_BUDGET ? "en regimen" : "baja migrando o suma al catalogo",
  );

  // 4. Placeholders: a key with {name} must be called with it — spot check
  //    the mechanism itself through the public t().
  check("t() rellena placeholders", t("sh_done", { exit: 0 }).includes("0"));
  check("t() deja el placeholder visible si falta el valor", t("ago_min").includes("{n}"));
}

main();
console.log(`\n${failures === 0 ? "TODO OK" : `${failures} FALLOS`}`);
process.exit(failures === 0 ? 0 : 1);
