/** stt checks: parseo del stdout de whisper-cli, defaults, disponibilidad. */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// Pin ES for this suite: transcribeFile throws through the catalog, so the
// operator's /locale choice would otherwise decide the error text the
// assertions read. Dynamic import: a static one is hoisted above this.
process.env.TG_LOCALE_FILE = join(mkdtempSync(join(tmpdir(), "tg-stt-")), "locale.txt");
delete process.env.TG_LOCALE;
const { parseCloudResponse, parseTranscription, sttAvailable, sttDefaults, transcribeFile, whisperFailureMessage, fmtBytes } = await import("../src/stt.js");

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

// ── proveedor cloud (openai-compatible) ─────────────────────────────────────

check("sttAvailable cloud sin baseUrl ni key → false", sttAvailable({ provider: "openai-compatible" }) === false);
check(
  "sttAvailable cloud sin key → false",
  sttAvailable({ provider: "openai-compatible", baseUrl: "https://api.groq.com/openai/v1" }) === false,
);
check(
  "sttAvailable cloud completo → true",
  sttAvailable({ provider: "openai-compatible", baseUrl: "https://api.groq.com/openai/v1", apiKey: "k" }) === true,
);
check("parseCloudResponse extrae text", parseCloudResponse('{"text":"hola mundo"}') === "hola mundo");
check("parseCloudResponse json roto → vacio", parseCloudResponse("no json") === "");
check("parseCloudResponse sin text → vacio", parseCloudResponse('{"otra":1}') === "");

// transcribeFile exige los binarios — siempre, sin tocar el disco del usuario.
try {
  await transcribeFile("x", { whisper: "C:\\no\\existe.exe", model: "C:\\no\\modelo.bin" });
  check("transcribeFile sin binarios → lanza", false);
} catch (error) {
  check("transcribeFile sin binarios → lanza", String((error as Error).message).includes("no existe"));
}

// ── clasificacion de fallos de whisper ───────────────────────────────────────
// El stderr real grabado en una PC con 0.9 GB libres frente a ggml-small.
const allocStderr = [
  "load_backend: loaded BLAS backend from Release/ggml-blas.dll",
  "load_backend: loaded CPU backend from Release/ggml-cpu-cascadelake.dll",
  "whisper_model_load: loading model",
  "ggml_backend_cpu_buffer_type_alloc_buffer: failed to allocate buffer of size 20971520",
  "whisper_model_load: WARN no tensors loaded from model file - assuming empty model for testing",
  "error: failed to initialize whisper context",
].join("\r\n");

// Un modelo "instalado" de juguete: la clasificacion lee su tamanno del disco.
const sttDir = mkdtempSync(join(tmpdir(), "tg-stt-model-"));
const fakeModel = join(sttDir, "ggml-small.bin");
writeFileSync(fakeModel, Buffer.alloc(20 * 1024 * 1024));

const mem = whisperFailureMessage({ stderr: allocStderr, code: 3, modelPath: fakeModel, freeBytes: 10 * 1024 * 1024 });
check("memoria: clasifica la falla de alloc", mem.includes("RAM") && mem.includes("reservar"));
check("memoria: nombra el modelo y los MB", mem.includes("ggml-small.bin") && mem.includes("20 MB") && mem.includes("10 MB"));
check("memoria: incluye la pista del modelo chico", mem.includes("ggml-base.bin"));
check("memoria: no suelta el stderr crudo", !mem.includes("load_backend"));

// Modelo ausente (otra rama): igual clasifica, con tamanno "?", sin caerse.
const noModel = whisperFailureMessage({ stderr: allocStderr, code: 3, modelPath: join(sttDir, "no-hay.bin"), freeBytes: 10 * 1024 * 1024 });
check("modelo ausente: clasifica con tamanno ?", noModel.includes("RAM") && noModel.includes("?"));

// Mismo fallo con RAM de sobra: whisper no obtuvo la allocation igual — la
// tarjeta dice la verdad (no pasa al stderr plano y cricket).
const plenty = whisperFailureMessage({ stderr: allocStderr, code: 3, modelPath: fakeModel, freeBytes: 8 * 1024 * 1024 * 1024 });
check("memoria: RAM amplia igual clasifica la allocation", plenty.includes("RAM") && plenty.includes("ggml-small.bin") && !plenty.startsWith("whisper-cli exit"));

// Una falla sin alloc: error plano, con el codigo y la cola del stderr.
const longStderr = "load_backend: loaded BLAS backend from Release/ggml-blas.dll\r\nload_backend: loaded CPU backend from Release/ggml-cpu-cascadelake.dll\r\n" + "x".repeat(400) + "\r\nerror: bad model magic";
const weird = whisperFailureMessage({ stderr: longStderr, code: 9, modelPath: fakeModel, freeBytes: 900 * 1024 * 1024 });
check("otra falla: plano con su codigo", weird.startsWith("whisper-cli exit 9:") && weird.includes("bad model magic"));
check("otra falla: la cola util, no la cabecera de backends", !weird.includes("load_backend"));

check("fmtBytes: MB y GB", fmtBytes(487005696) === "464 MB" && fmtBytes(75497472) === "72 MB" && fmtBytes(2147483648) === "2.0 GB");
check("fmtBytes: basura → ?", fmtBytes(Number.NaN) === "?" && fmtBytes(-1) === "?");

// Los binarios reales solo existen donde se instalaron — CI-friendly.
if (sttAvailable({})) {
  check("sttAvailable con defaults → true (binarios presentes)", true);
} else {
  console.log("  -- stt local: no instalado (CI) \u2014 check de presencia skipped");
}

console.log(failures === 0 ? `\nSTTCHECK OK (${total})` : `\nSTTCHECK ${failures} FALLOS de ${total}`);
process.exit(failures === 0 ? 0 : 1);
