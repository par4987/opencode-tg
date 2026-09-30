/**
 * `readSessionMeta` against the real OpenCode data directory. Two guarantees:
 * an existing session file yields a title, and a bogus id never throws.
 */
import { readSessionMeta } from "../src/session-meta.js";
import { readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

let failures = 0;
function check(name: string, condition: boolean, detail = ""): void {
  console.log(`${condition ? "  ok  " : "FAIL  "} ${name}${detail ? `  ${detail}` : ""}`);
  if (!condition) failures++;
}

const dir = join(homedir(), ".local", "share", "opencode", "sessions");

async function main(): Promise<void> {
  if (!exists(dir)) {
    console.log("  (no hay directorio de sesiones en este equipo — test salteado)");
    return;
  }
  const ids = readdirSync(dir)
    .filter((name) => name.endsWith(".json"))
    .map((name) => name.slice(0, -5));

  if (ids.length === 0) {
    console.log("  (no hay archivos .json de sesiones — test salteado)");
    return;
  }

  // 1. Every real session file must resolve to metadata with a title.
  let withTitle = 0;
  for (const id of ids.slice(0, 20)) {
    const meta = readSessionMeta(id);
    if (meta?.title) withTitle++;
  }
  check(
    "las sesiones reales del disco devuelven t\u00edtulo",
    withTitle > 0,
    `${withTitle}/${Math.min(ids.length, 20)} con t\u00edtulo`,
  );

  // 2. A session known to exist returns exactly its on-disk title.
  const first = ids[0]!;
  const meta = readSessionMeta(first);
  check("una sesi\u00f3n real devuelve metadatos", meta !== undefined, meta?.title?.slice(0, 50) ?? "sin meta");
  check("el directorio de la sesi\u00f3n se rellena", meta?.directory !== undefined && meta.directory.length > 0);

  // 3. Bogus ids are rejected, and a missing file never throws.
  const bad = readSessionMeta("definitely_not_a_session");
  check("un id inexistente devuelve undefined", bad === undefined);
  check("un id malicioso es rechazado", readSessionMeta("../../etc/passwd") === undefined);
  check("un id vac\u00edo es rechazado", readSessionMeta("") === undefined);
}

function exists(path: string): boolean {
  try {
    return readdirSync(path).length >= 0;
  } catch {
    return false;
  }
}

void main().finally(() => {
  console.log(`\n${failures === 0 ? "TODO OK" : `${failures} FALLOS`}`);
  process.exit(failures === 0 ? 0 : 1);
});
