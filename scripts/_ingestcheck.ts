/** ingest checks: text sniffing, decoding, binary storage. */
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decodeText, DOC_MAX_CHARS, isTextLike, saveBinary } from "../src/ingest.js";

let failures = 0;
let total = 0;
function check(name: string, condition: boolean): void {
  total += 1;
  console.log(`${condition ? "  ok  " : "  FAIL"} ${name}`);
  if (!condition) failures += 1;
}

// ── isTextLike ────────────────────────────────────────────────────────────────

check("mime text/plain", isTextLike("a.txt", "text/plain", Buffer.from("hola")));
check("mime application/json", isTextLike("a.json", "application/json", Buffer.from("{}")));
check("extension .ts sin mime", isTextLike("a.ts", "", Buffer.from("const x = 1;")));
check("extension .cds", isTextLike("a.cds", "", Buffer.from("entity Foo {}")));
check("extension .md sin mime", isTextLike("README.md", "", Buffer.from("# hola")));
check("zip es binario", !isTextLike("a.zip", "application/zip", Buffer.from([0x50, 0x4b, 0x03])));
check("pdf es binario", !isTextLike("a.pdf", "application/pdf", Buffer.from("%PDF-1.7")));
check("video es binario", !isTextLike("a.mp4", "video/mp4", Buffer.from([0, 0, 0])));
check("byte NUL en el medio → binario", !isTextLike("sin-tipo", "", Buffer.from("hola\0mundo")));
check("texto con acentos es texto", isTextLike("x", "text/plain", Buffer.from("ca\u00f1\u00f3n", "utf8")));
check("utf16 sin BOM → binario (NUL bytes)", !isTextLike("x", "", Buffer.from("hola", "utf16le")));
check("binario ruidoso → no texto", !isTextLike("x", "", Buffer.from(Array.from({ length: 1024 }, () => 0x01))));
check("archivo vacio → texto", isTextLike("x", "", Buffer.alloc(0)));

// ── decodeText ───────────────────────────────────────────────────────────────

check("decode utf8 plano", decodeText(Buffer.from("ca\u00f1\u00f3n", "utf8")) === "ca\u00f1\u00f3n");
check("decode utf16le con BOM", decodeText(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("hola", "utf16le")])) === "hola");
check("decode utf8 con BOM", decodeText(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("hola", "utf8")])) === "hola");

// ── saveBinary ───────────────────────────────────────────────────────────────

const dir = mkdtempSync(join(tmpdir(), "ingest-"));
const path = saveBinary("reporte final#1.pdf", Buffer.from("%PDF"), dir);
check("guarda en el dir indicado", path.startsWith(dir));
check("el archivo existe", existsSync(path));
const base = path.slice(Math.max(path.lastIndexOf("\\"), path.lastIndexOf("/")) + 1);
check("nombre sanitizado", !base.includes("#") && !/\s/.test(base) && base.length > 10);
check("contenido intacto", readFileSync(path).toString() === "%PDF");
const path2 = saveBinary("x/y\\z.bin", Buffer.from([1, 2]), dir);
const base2 = path2.slice(Math.max(path2.lastIndexOf("\\"), path2.lastIndexOf("/")) + 1);
check("separadores sanitizados", !base2.includes("/") && !base2.includes("\\") && !base2.includes(":"));
rmSync(dir, { recursive: true, force: true });

// ── DOC_MAX_CHARS ────────────────────────────────────────────────────────────

check("limite de inline razonable", DOC_MAX_CHARS === 100_000);

console.log(failures === 0 ? `\nINGESTCHECK OK (${total})` : `\nINGESTCHECK ${failures} FALLOS de ${total}`);
process.exit(failures === 0 ? 0 : 1);
