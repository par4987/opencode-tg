/**
 * /ci checks — the parsing and the formatting of GitHub's answer.
 *
 * The endpoint's shape is stable, but anything else can answer it: a rate
 * limit, a 404 for a wrong repo, a proxy page. The command must render a
 * sensible card in every one of those cases, and the glyphs must read at a
 * glance — a red when CI failed is the whole point of the command.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// Pin ES: the cards are built from the catalog, so the operator's /locale
// would otherwise decide the text the assertions read.
process.env.TG_LOCALE_FILE = join(mkdtempSync(join(tmpdir(), "tg-ci-")), "locale.txt");
delete process.env.TG_LOCALE;
import type { CiRun } from "../src/ci.js";
const { parseRuns, formatRuns, stateGlyph, ageText, runsUrl } = await import("../src/ci.js");

let failures = 0;
let total = 0;
function check(name: string, condition: boolean, detail = ""): void {
  total += 1;
  console.log(`${condition ? "  ok  " : "  FAIL"} ${name}${detail ? `  ${detail}` : ""}`);
  if (!condition) failures += 1;
}

const HOUR = 60 * 60_000;
const DAY = 24 * HOUR;
const now = Date.now();

/** One run, in the API's own field names. */
function rawRun(fields: Record<string, unknown>): Record<string, unknown> {
  return {
    name: "CI",
    status: "completed",
    conclusion: "success",
    head_sha: "8a810a7deadbeef",
    head_commit: { message: "chore(ci): move to 23:00" },
    html_url: "https://github.com/par4987/opencode-tg/actions/runs/38025007044",
    created_at: new Date(now - 3 * HOUR).toISOString(),
    ...fields,
  };
}

// ── parseRuns: the real shape, and the hostile ones ───────────────────────

const runs = parseRuns({ workflow_runs: [rawRun({ name: "CI" }), rawRun({ name: "deps-audit", status: "in_progress", conclusion: null, head_commit: { message: "weekly seal\n\nbody line" } })] });
check("parse: dos runs", runs.length === 2);
check("parse: campos basicos", runs[0]?.name === "CI" && runs[0]?.sha === "8a810a7deadbeef" && runs[0]?.url.includes("actions/runs/38025007044"));
check("parse: solo la primera linea del commit", runs[1]?.title === "weekly seal");
check("parse: conclusion null mientras corre", runs[1]?.conclusion === null && runs[1]?.status === "in_progress");
check("parse: timestamp a epoch", runs[0]?.at === Date.parse(new Date(now - 3 * HOUR).toISOString()));

check("parse: 404 del repo → []", parseRuns({ message: "Not Found", documentation_url: "https://docs.github.com" }).length === 0);
check("parse: array ausente → []", parseRuns({}).length === 0);
check("parse: null → []", parseRuns(null).length === 0);
check("parse: run sin campos → defaults, sin caerse", parseRuns({ workflow_runs: [{}] })?.[0]?.name === "(sin nombre)");

// ── stateGlyph: lo que se lee de un vistazo ───────────────────────────────

check("glyph: success", stateGlyph({ status: "completed", conclusion: "success" } as CiRun) === "✅");
check("glyph: failure", stateGlyph({ status: "completed", conclusion: "failure" } as CiRun) === "🔴");
check("glyph: en curso", stateGlyph({ status: "in_progress", conclusion: null } as CiRun) === "🔄");
check("glyph: en cola cuenta como en curso", stateGlyph({ status: "queued", conclusion: null } as CiRun) === "🔄");
check("glyph: timed_out", stateGlyph({ status: "completed", conclusion: "timed_out" } as CiRun) === "⏱");
check("glyph: cancelled", stateGlyph({ status: "completed", conclusion: "cancelled" } as CiRun) === "⚪");
check("glyph: conclusion rara → ❔", stateGlyph({ status: "completed", conclusion: "martian" } as CiRun) === "❔");

// ── ageText: la antiguedad en palabras ─────────────────────────────────────

check("age: minutos", ageText(now - 30 * 60_000) === "hace 30 min");
check("age: horas", ageText(now - 3 * HOUR) === "hace 3 h");
check("age: dias", ageText(now - 2 * DAY) === "hace 2 d");
check("age: sin timestamp → ¿?", ageText(0) === "¿?");

// ── formatRuns: la tarjeta ─────────────────────────────────────────────────

const card = formatRuns(runs, "par4987/opencode-tg");
check("format: header con el repo", card.includes("par4987/opencode-tg"));
check("format: una linea por run", card.split("\n").filter((line) => line.includes("·")).length === 2);
check("format: estado y sha visibles", card.includes("✅") && card.includes("🔄") && card.includes("8a810a7"));
check("format: el sha linkea la run", card.includes('href="https://github.com/par4987/opencode-tg/actions/runs/38025007044"'));
check("format: HTML escapado (un titulo con <script>)", !formatRuns(parseRuns({ workflow_runs: [rawRun({ head_commit: { message: "<script>x</script>" } })] }), "o/r").includes("<script>"));

const empty = formatRuns([], "owner/private-repo");
check("format: vacio → aviso claro", empty.includes("owner/private-repo") && empty.includes("token"));

// ── runsUrl ─────────────────────────────────────────────────────────────────

check("runsUrl: el limite viaja en el query", runsUrl("par4987/opencode-tg", 20) === "https://api.github.com/repos/par4987/opencode-tg/actions/runs?per_page=20");

console.log(failures === 0 ? `\n_CICHECK OK (${total})` : `\n_CICHECK ${failures} FALLOS de ${total}`);
process.exit(failures === 0 ? 0 : 1);
