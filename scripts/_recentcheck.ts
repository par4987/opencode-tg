/** /recent checks: persistence roundtrip, limit, corrupt → empty. */
import { mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RecentPrompt } from "../src/recent.js";
const { readRecent, addRecent, clearRecent, recentFile } = await import("../src/recent.js");

let failures = 0;
let total = 0;
function check(name: string, condition: boolean): void {
  total += 1;
  console.log(`${condition ? "  ok  " : "  FAIL"} ${name}`);
  if (!condition) failures += 1;
}

const DIR = mkdtempSync(join(tmpdir(), "tg-recent-"));
const FILE = join(DIR, "recent.json");
process.env.TG_TOKEN_STATE_DIR = DIR;

// ── empty / missing file ─────────────────────────────────────────────────────
check("missing file → empty", JSON.stringify(readRecent(FILE)) === JSON.stringify([]));

// ── add + read roundtrip ─────────────────────────────────────────────────────
addRecent("ses_a", "hola agente", FILE);
addRecent("ses_b", "qué tal", FILE);
const recent = readRecent(FILE);
check("two entries", recent.length === 2);
check("first session", recent[0].sessionID === "ses_a");
check("first text", recent[0].text === "hola agente");
check("second session", recent[1].sessionID === "ses_b");
check("second text", recent[1].text === "qué tal");
check("has timestamps", typeof recent[0].at === "number" && recent[0].at > 0);

// ── limit: max 200 entries ───────────────────────────────────────────────────
for (let i = 0; i < 250; i++) addRecent("ses_x", `prompt ${i}`, FILE);
const capped = readRecent(FILE, 300);
check("capped at 200", capped.length === 200);
check("last is prompt 249", capped[199].text === "prompt 249");

// ── corrupt file → empty ─────────────────────────────────────────────────────
writeFileSync(FILE, "{not valid json{{}", "utf8");
check("corrupt → empty", JSON.stringify(readRecent(FILE)) === JSON.stringify([]));

// ── valid JSON but not an array → empty ──────────────────────────────────────
writeFileSync(FILE, JSON.stringify({ foo: "bar" }), "utf8");
check("object → empty", JSON.stringify(readRecent(FILE)) === JSON.stringify([]));

// ── default file path exists ─────────────────────────────────────────────────
const rf = recentFile();
check("recentFile is under ~/.opencode/tg/data", rf.includes(".opencode") && rf.includes("tg") && rf.includes("data") && rf.includes("recent.json"));

// ── clear ────────────────────────────────────────────────────────────────────
addRecent("ses_z", "último", FILE);
check("has entry before clear", readRecent(FILE).length > 0);
clearRecent(FILE);
check("empty after clear", readRecent(FILE).length === 0);

console.log(`\n_recentcheck: ${total - failures}/${total} ok`);
process.exit(failures === 0 ? 0 : 1);
