/** media-out checks: path extraction, image qualification, reply context. */
import { mkdtempSync, writeFileSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  describeReplyTarget,
  extractFilePaths,
  isForumEcho,
  MAX_IMAGES,
  qualifyingImage,
  selectImages,
  withReplyContext,
} from "../src/media-out.js";

let failures = 0;
let total = 0;
function check(name: string, condition: boolean): void {
  total += 1;
  console.log(`${condition ? "  ok  " : "  FAIL"} ${name}`);
  if (!condition) failures += 1;
}

// ── extractFilePaths ───────────────────────────────────────────────────────

const paths1 = extractFilePaths('I saved it to C:\\Users\\user\\Desktop\\chart.png and E:\\tmp\\out.jpg');
check("extrae 2 rutas windows", paths1.length === 2);
check("incluye chart.png", paths1.some((p) => p.includes("chart.png")));
check("incluye out.jpg", paths1.some((p) => p.includes("out.jpg")));
const paths2 = extractFilePaths("no file paths here");
check("sin rutas → vacio", paths2.length === 0);
const paths3 = extractFilePaths("generated at E:\\\\Projects\\\\test\\\\output.png");
check("dobles backslashes extrae", paths3.some((p) => p.includes("output.png")));
const paths4 = extractFilePaths("read /tmp/results.png and /home/user/report.pdf");
check("posix: 2 rutas", paths4.length === 2);
check("extrae rutas .md", extractFilePaths("MD generado: E:\\work\\demo\\out\\verificacion.md (778 bytes)").length === 1);
check("extrae rutas .txt", extractFilePaths("log en C:\\tmp\\salida.txt").length === 1);
check("posix: extrae .md", extractFilePaths("ver /home/user/notas/guia.md aca").length === 1);
check("ignora ext no soportada (.ts)", extractFilePaths("C:\\\\script.ts").length === 0);

// ── qualifyingImage ────────────────────────────────────────────────────────

const dir = mkdtempSync(join(tmpdir(), "mediaout-"));
const oldFile = join(dir, "old.png");
const newFile = join(dir, "new.png");
const bigFile = join(dir, "big.png");
writeFileSync(oldFile, Buffer.alloc(10));
writeFileSync(newFile, Buffer.alloc(10));
// Set old file's mtime to 1 hour ago
const past = new Date(Date.now() - 3600_000);
utimesSync(oldFile, past, past);
// Big file: 11 MB (over PHOTO_LIMIT)
writeFileSync(bigFile, Buffer.alloc(11 * 1024 * 1024));

const now = Date.now();
check("archivo nuevo califica", qualifyingImage(newFile, now)?.as === "photo");
check("archivo viejo no califica", qualifyingImage(oldFile, now) === undefined);
check("archivo demasiado grande no califica", qualifyingImage(bigFile, now) === undefined);
check("ruta inexistente → undefined", qualifyingImage(join(dir, "no.png"), now) === undefined);

// ── selectImages ───────────────────────────────────────────────────────────

const pngs = ["a.png", "b.png", "c.png"].map((n) => join(dir, n));
for (const p of pngs) writeFileSync(p, Buffer.alloc(5));
const selected = selectImages([...pngs, ...pngs, oldFile], now);
check("3 unicos, dedup", selected.length === 3);
check("excluye el viejo", !selected.some((s) => s.path.includes("old.png")));
check("cap MAX_IMAGES", selectImages(Array.from({ length: 20 }, (_, i) => join(dir, `f${i}.png`)).map((p) => (writeFileSync(p, Buffer.alloc(5)), p)), now).length <= MAX_IMAGES);

// ── texto: md/txt inline, documento si es grande ─────────────────────────────

const mdSmall = join(dir, "guia.md");
writeFileSync(mdSmall, "# Guía\n\n- punto uno\n- punto dos\n");
const mdBig = join(dir, "gran-informe.md");
writeFileSync(mdBig, Buffer.alloc(13 * 1024));
check("md chico va inline", qualifyingImage(mdSmall, now)?.as === "text");
check("md grande va como documento", qualifyingImage(mdBig, now)?.as === "document");
check("md chico en selectImages viaja inline", selectImages([mdSmall], now)[0]?.as === "text");

rmSync(dir, { recursive: true, force: true });

// ── describeReplyTarget ────────────────────────────────────────────────────

check("texto plano", describeReplyTarget({ text: "hola mundo" }) === "hola mundo");
check("caption de foto", describeReplyTarget({ caption: "mi foto" }) === "mi foto");
check("foto sin caption", describeReplyTarget({ photo: [{}] }) === "(una foto)");
check("documento", describeReplyTarget({ document: { file_name: "x.pdf" } }) === "(el archivo x.pdf)");
check("sticker", describeReplyTarget({ sticker: { emoji: "\u{1F44D}" } })?.includes("(un sticker"));
check("voz", describeReplyTarget({ voice: { duration: 42 } }) === "(un audio de 42s)");
check("undefined → undefined", describeReplyTarget(undefined) === undefined);
check("texto largo trunca", describeReplyTarget({ text: "x".repeat(5000) })?.length === 4000);
check("animacion/GIF", describeReplyTarget({ animation: {} }) === "(una animación/GIF)");
check("pista de audio", describeReplyTarget({ audio: { duration: 180 } }) === "(una pista de audio de 180s)");
check("videomensaje circular", describeReplyTarget({ video_note: { duration: 15 } }) === "(un videomensaje de 15s)");
check("encuesta", describeReplyTarget({ poll: { question: "¿Seguimos?" } }) === "(una encuesta: ¿Seguimos?)");
check("dado", describeReplyTarget({ dice: { emoji: "\u{1F3B2}" } }) === "(un dado \u{1F3B2})");
check("ubicacion", describeReplyTarget({ location: { latitude: -34.6 } }) === "(una ubicación)");
check("contacto", describeReplyTarget({ contact: { first_name: "Ana" } }) === "(el contacto Ana)");
check(
  "mensaje de apertura del hilo",
  describeReplyTarget({ forum_topic_created: { name: "sesión X" } }) === "(el mensaje de apertura del hilo «sesión X»)",
);
check("fallback sin texto", describeReplyTarget({}) === "(un mensaje sin texto)");

// ── withReplyContext ────────────────────────────────────────────────────────

check("sin quote → prompt igual", withReplyContext("hola", undefined) === "hola");
const withQuote = withReplyContext("miralo", "este es el mensaje original");
check("con quote: incluye el quote", withQuote.includes("este es el mensaje original"));
check("con quote: incluye el prompt", withQuote.includes("miralo"));
check("con quote: formato <<< >>>", withQuote.includes("<<<") && withQuote.includes(">>>"));

// ── isForumEcho ─────────────────────────────────────────────────────────────

check("eco del foro: reply apunta al opener del hilo", isForumEcho({ message_thread_id: 100, reply_to_message: { message_id: 100 } }) === true);
check(
  "eco del foro: opener con forum_topic_created aunque el id no coincida",
  isForumEcho({ message_thread_id: 100, reply_to_message: { message_id: 999, forum_topic_created: { name: "sesión X" } } }) === true,
);
check("reply real a otro mensaje del hilo", isForumEcho({ message_thread_id: 100, reply_to_message: { message_id: 250 } }) === false);
check("sin reply_to_message", isForumEcho({ message_thread_id: 100 }) === false);
check("sin thread (raiz del chat)", isForumEcho({ reply_to_message: { message_id: 250 } }) === false);
check("mensaje undefined", isForumEcho(undefined) === false);

console.log(failures === 0 ? `\nMEDIAOUTCHECK OK (${total})` : `\nMEDIAOUTCHECK ${failures} FALLOS de ${total}`);
process.exit(failures === 0 ? 0 : 1);
