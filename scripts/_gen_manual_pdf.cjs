/**
 * MANUAL.md -> MANUAL.pdf, a mano (sin dependencias): Helvetica estándar,
 * WinAnsiEncoding (latin1), paginado a 48 lineas/pagina con wrap por palabra.
 * Imprime la ruta absoluta al final para que el plugin lo capture y lo envie
 * como documento adjunto al hilo — la prueba del canal "document".
 */
const fs = require("fs");
const path = require("path");

const src = process.argv[2] || path.join(__dirname, "..", "MANUAL.md");
const outPath = process.argv[3] || path.join(__dirname, "..", "out", "MANUAL.pdf");

// ── sanitizar a latin1/WinAnsi ──────────────────────────────────────────────
const REPL = {
  "\u00AB": '"', "\u00BB": '"',
  "\u2014": "--", "\u2013": "-", "\u2026": "...",
  "\u2713": "[OK]", "\u2714": "[OK]", "\u2716": "[X]", "\u274C": "[X]",
  "\u26A0": "[!]", "\uFE0F": "",
  "\u00B7": "-",
  "\u2B06": "[arriba]", "\u2B07": "[abajo]", "\u25B6": "[enviar]",
  "\u270F": "[editar]", "\u23F3": "[reloj]",
  "\u2192": "->", "\u2190": "<-",
  "\u2699": "[config]", "\u{1F4C4}": "[doc]", "\u{1F4DD}": "[nota]",
  "\u{1F4E6}": "[in]", "\u{1F4E4}": "[out]", "\u{1F5C2}": "[dir]",
  "\u{1F4AC}": "[msg]", "\u{1F9E9}": "[steps]", "\u{1FA99}": "[costo]",
  "\u{1F4BE}": "[cache]", "\u{1F525}": "[racha]", "\u{1F510}": "[permiso]",
  "\u{1F4F8}": "[foto]", "\u{1F3AF}": "[target]",
};
function sanitize(text) {
  let out = "";
  for (const ch of text) {
    if (REPL[ch] !== undefined) { out += REPL[ch]; continue; }
    const code = ch.codePointAt(0);
    if (code <= 255) out += ch;
    else out += "?";
  }
  return out;
}

// ── wrap por palabra a ~92 chars ────────────────────────────────────────────
function wrapLines(text, maxChars) {
  const out = [];
  for (const raw of text.split("\n")) {
    if (raw.length <= maxChars) { out.push(raw); continue; }
    let line = "";
    for (const word of raw.split(/(\s+)/)) {
      if ((line + word).length > maxChars && line.trim().length > 0) {
        out.push(line.replace(/\s+$/, ""));
        line = word.replace(/^\s+/, "");
      } else {
        line += word;
      }
    }
    out.push(line);
  }
  return out;
}

function escapePdf(s) {
  return s.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
}

const manual = sanitize(fs.readFileSync(src, "utf8"));
const lines = wrapLines(manual, 92);

// ── paginado: 48 lineas por pagina ──────────────────────────────────────────
const LINES_PER_PAGE = 48;
const pages = [];
for (let i = 0; i < lines.length; i += LINES_PER_PAGE) {
  pages.push(lines.slice(i, i + LINES_PER_PAGE));
}
if (pages.length === 0) pages.push(["(manual vacio)"]);

const pageStreams = pages.map((pageLines) => {
  const body = pageLines.map((l) => `(${escapePdf(l)}) Tj T*`).join("\n");
  return `BT\n/F1 10 Tf\n14 TL\n50 792 Td\n${body}\nET`;
});

// ── armado del PDF con offsets reales ───────────────────────────────────────
const chunks = [];
let total = 0;
const offsets = []; // offsets[i] = byte offset del objeto i+1
function push(str) {
  const buf = Buffer.from(str, "latin1");
  chunks.push(buf);
  total += buf.length;
}

push("%PDF-1.4\n");

// 1: catalog
offsets[0] = total;
push("1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n");

// 2: pages (kids: 4 0 R, 6 0 R, ...)
const kids = pageStreams.map((_, i) => `${4 + i * 2} 0 R`).join(" ");
offsets[1] = total;
push(`2 0 obj\n<< /Type /Pages /Kids [${kids}] /Count ${pages.length} >>\nendobj\n`);

// 3: font
offsets[2] = total;
push("3 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>\nendobj\n");

// paginas: obj (4+2i) page, obj (5+2i) content
pageStreams.forEach((stream, i) => {
  const pageObj = 4 + i * 2;
  const contentObj = 5 + i * 2;
  offsets[pageObj - 1] = total;
  push(
    `${pageObj} 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] ` +
      `/Resources << /Font << /F1 3 0 R >> >> /Contents ${contentObj} 0 R >>\nendobj\n`,
  );
  offsets[contentObj - 1] = total;
  push(`${contentObj} 0 obj\n<< /Length ${stream.length} >>\nstream\n${stream}\nendstream\nendobj\n`);
});

// xref
const objCount = 3 + pageStreams.length * 2;
const xrefOffset = total;
let xref = `xref\n0 ${objCount + 1}\n0000000000 65535 f \n`;
for (let i = 1; i <= objCount; i++) {
  xref += `${String(offsets[i - 1]).padStart(10, "0")} 00000 n \n`;
}
push(xref);
push(`trailer\n<< /Size ${objCount + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`);

fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, Buffer.concat(chunks));
console.log("PDF generado: " + outPath + " (" + total + " bytes, " + pages.length + " paginas)");
