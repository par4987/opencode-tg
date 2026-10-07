/**
 * The pure helpers behind the newer API surfaces.
 *
 * What must hold: SSE `data:` lines parse cleanly; the one-shot
 * generation text survives every envelope shape (the endpoint
 * cold-starts past every probe timeout, so the shape is read
 * defensively); and whatever the model produced becomes tappable
 * title options — deduplicated, unnumbered, length-capped.
 */
import { parseSseData, generateTextOf, titleOptionsFrom } from "../src/extra.js";

let failures = 0;
function check(name: string, condition: boolean, detail = ""): void {
  console.log(`${condition ? "  ok  " : "FAIL  "} ${name}${detail ? `  ${detail}` : ""}`);
  if (!condition) failures++;
}

function main(): void {
  // 1. SSE: only data: lines, trimmed, in order.
  const sse = [
    ": keepalive comment",
    'data: {"type":"log.synced","seq":1}',
    "",
    'data: {"type":"log.append","seq":2}',
    "event: x",
    "data:  plain string",
  ].join("\n");
  const parsed = parseSseData(sse);
  check(
    "SSE: solo las lineas data:",
    parsed.length === 3 && parsed[0] === '{"type":"log.synced","seq":1}' && parsed[2] === "plain string",
    JSON.stringify(parsed),
  );
  check("SSE: cuerpo vacio -> []", parseSseData("").length === 0);

  // 2. generateTextOf: every envelope, and the raw fallback.
  check("generate: {data:{text}}", generateTextOf(JSON.stringify({ data: { text: "hola" } })) === "hola");
  check("generate: {text}", generateTextOf(JSON.stringify({ text: "chau" })) === "chau");
  check("generate: {data:{output}}", generateTextOf(JSON.stringify({ data: { output: "uno" } })) === "uno");
  check("generate: {completion}", generateTextOf(JSON.stringify({ completion: "dos" })) === "dos");
  check("generate: texto crudo", generateTextOf("texto sin json") === "texto sin json");
  check("generate: vacio no miente", generateTextOf("") === "");

  // 3. Title options: clean, deduplicate, cap.
  const rawTitles = "1. \"Arreglar el bot de Telegram\"\n* Refactor del poll\n3) arreglar el bot de telegram\n- una de setenta y dos caracteres que se pasa del largo permitido para un boton de topico si es mas larga";
  const options = titleOptionsFrom(rawTitles);
  check("titles: limpia numeracion y comillas", options[0] === "Arreglar el bot de Telegram", JSON.stringify(options));
  check("titles: deduplica case-insensitive", options.length === 2, JSON.stringify(options));
  check("titles: la larga queda afuera", options.every((o) => o.length <= 64), JSON.stringify(options));
  check("titles: elige los primeros 3", titleOptionsFrom("aa\nbb\ncc\ndd").length === 3);
  check("titles: basura no produce opciones", titleOptionsFrom("?\n!\n ").length === 0);

  console.log(failures === 0 ? "\nEXTRA OK" : `\n${failures} FALLOS`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
