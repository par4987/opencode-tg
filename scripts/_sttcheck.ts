/** stt checks: parseo del stdout de whisper-cli, defaults, disponibilidad. */
import { join } from "node:path";
import { parseTranscription, sttAvailable, sttDefaults, transcribeFile } from "../src/stt.js";

let failures = 0;
let total = 0;
function check(name: string, condition: boolean): void {
  total += 1;
  console.log(`${condition ? "  ok  " : "  FAIL"} ${name}`);
  if (!condition) failures += 1;
}

// ── parseTranscription ───────────────────────────────────────────────────────

check("parseTranscription une lineas", parseTranscription("hola\nmundo\n") === "hola mundo");
check("parseTranscription con CRLF", parseTranscription("hola\r\nmundo\r\n") === "hola mundo");
check("parseTranscription vacio", parseTranscription("\n \n\t\n") === "");
check("parseTranscription recorta espacios", parseTranscription("  texto  \n") === "texto");

// ── defaults y disponibilidad ───────────────────────────────────────────────

const d = sttDefaults();
check(
  "sttDefaults apunta a ~/.opencode/tg/stt",
  d.whisper.includes(join("opencode", "tg", "stt")) && d.model.includes("ggml-small.bin"),
);
check(
  "sttAvailable con paths inventados → false",
  sttAvailable({ whisper: "C:\\no\\existe.exe", model: "C:\\no\\modelo.bin" }) === false,
);

// transcribeFile exige los binarios — siempre, sin tocar el disco del usuario.
try {
  await transcribeFile("x", { whisper: "C:\\no\\existe.exe", model: "C:\\no\\modelo.bin" });
  check("transcribeFile sin binarios → lanza", false);
} catch (error) {
  check("transcribeFile sin binarios → lanza", String((error as Error).message).includes("no existe"));
}

// Los binarios reales solo existen donde se instalaron — CI-friendly.
if (sttAvailable({})) {
  check("sttAvailable con defaults → true (binarios presentes)", true);
} else {
  console.log("  -- stt local: no instalado (CI) \u2014 check de presencia skipped");
}

console.log(failures === 0 ? `\nSTTCHECK OK (${total})` : `\nSTTCHECK ${failures} FALLOS de ${total}`);
process.exit(failures === 0 ? 0 : 1);
