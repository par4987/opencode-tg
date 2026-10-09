#!/usr/bin/env node
/**
 * Runner de la suite completa: las 21 suites en secuencia, con el veredicto
 * al final y exit 1 si alguna falla. `node --import tsx` ejecuta los .ts con
 * el tsx instalado como devDependency del propio proyecto.
 */
const { spawnSync } = require("node:child_process");
const path = require("node:path");

const suites = [
  "_setupcheck",
  "_acpcheck",
  "_metacheck",
  "_topicscheck",
  "_rendercheck",
  "_historycheck",
  "_formscheck",
  "_configcheck",
  "_taskcheck",
  "_ingestcheck",
  "_mediaoutcheck",
  "_sttcheck",
  "_leadercheck",
  "_seatcheck",
  "_revivecheck",
  "_localecheck",
  "_botcheck",
  "_cardscheck",
  "_dangercheck",
  "_offsetcheck",
  "_extracheck",
];

let failed = 0;
for (const suite of suites) {
  console.log(`\n=== ${suite} ===`);
  const result = spawnSync(process.execPath, ["--import", "tsx", path.join(__dirname, suite + ".ts")], {
    stdio: "inherit",
  });
  if (result.status !== 0) {
    failed += 1;
    console.log(`>> SUITE ${suite} FALLO (exit ${result.status})`);
  }
}

console.log(
  failed === 0
    ? `\nTODAS LAS SUITES OK (${suites.length})`
    : `\n${failed} DE ${suites.length} SUITES CON FALLOS`,
);
process.exit(failed === 0 ? 0 : 1);
