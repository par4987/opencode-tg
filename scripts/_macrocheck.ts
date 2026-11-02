/** /macro checks: save, run (find), list, del, corrupt → empty. */
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Macro } from "../src/macros.js";
const { readMacros, saveMacro, deleteMacro, findMacro, macrosFile } = await import("../src/macros.js");

let failures = 0;
let total = 0;
function check(name: string, condition: boolean): void {
  total += 1;
  console.log(`${condition ? "  ok  " : "  FAIL"} ${name}`);
  if (!condition) failures += 1;
}

const DIR = mkdtempSync(join(tmpdir(), "tg-macro-"));
const FILE = join(DIR, "macros.json");

// ── empty / missing file ─────────────────────────────────────────────────────
check("missing file → empty", JSON.stringify(readMacros(FILE)) === JSON.stringify([]));

// ── save + find roundtrip ────────────────────────────────────────────────────
const saved = saveMacro("deploy", "despliega a produccion", FILE);
check("save returns macro", saved !== undefined && saved.name === "deploy" && saved.text === "despliega a produccion");
check("save has timestamp", typeof saved?.at === "number" && saved?.at > 0);

const found = findMacro("deploy", FILE);
check("find by name", found !== undefined && found.text === "despliega a produccion");

// ── overwrite same name ──────────────────────────────────────────────────────
saveMacro("deploy", "despliega a staging", FILE);
const afterOverwrite = readMacros(FILE);
check("overwrite keeps one entry", afterOverwrite.length === 1);
check("overwrite new text", afterOverwrite[0].text === "despliega a staging");

// ── multiple macros, sorted newest first ─────────────────────────────────────
saveMacro("test", "corre los tests", FILE);
saveMacro("lint", "corre el linter", FILE);
const all = readMacros(FILE);
check("three macros", all.length === 3);
check("newest first: lint", all[0].name === "lint");

// ── list output ──────────────────────────────────────────────────────────────
check("readMacros returns names", all.map((m) => m.name).includes("deploy") && all.map((m) => m.name).includes("test"));

// ── del ──────────────────────────────────────────────────────────────────────
check("del existing", deleteMacro("test", FILE) === true);
const afterDel = readMacros(FILE);
check("del removes entry", afterDel.length === 2 && !afterDel.some((m) => m.name === "test"));
check("del missing", deleteMacro("nope", FILE) === false);

// ── empty name or text → no save ─────────────────────────────────────────────
check("empty name → undefined", saveMacro("  ", "texto", FILE) === undefined);
check("empty text → undefined", saveMacro("nombre", "   ", FILE) === undefined);

// ── corrupt file → empty ─────────────────────────────────────────────────────
writeFileSync(FILE, "{not valid json{{}", "utf8");
check("corrupt → empty", JSON.stringify(readMacros(FILE)) === JSON.stringify([]));

// ── valid JSON but not an object → empty ─────────────────────────────────────
writeFileSync(FILE, JSON.stringify([1, 2, 3]), "utf8");
check("array → empty", JSON.stringify(readMacros(FILE)) === JSON.stringify([]));

// ── default file path ────────────────────────────────────────────────────────
const mf = macrosFile();
check("macrosFile is under ~/.opencode/tg/data", mf.includes(".opencode") && mf.includes("tg") && mf.includes("data") && mf.includes("macros.json"));

console.log(`\n_macrocheck: ${total - failures}/${total} ok`);
process.exit(failures === 0 ? 0 : 1);
