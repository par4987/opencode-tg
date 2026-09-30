/** Validacion estructural del PDF: xref offsets, header, trailer, paginas. */
const fs = require("fs");
const path = require("path");
const b = fs.readFileSync(process.argv[2] || path.join(__dirname, "..", "out", "MANUAL.pdf"), "latin1");

const checks = {
  header: b.startsWith("%PDF-1.4"),
  eof: b.trimEnd().endsWith("%%EOF"),
};
const startxref = parseInt(/startxref\n(\d+)/.exec(b)[1], 10);
checks.xrefAtOffset = b.slice(startxref, startxref + 4) === "xref";
checks.pages = parseInt(/\/Count (\d+)/.exec(b)[1], 10);
// Cada entrada del xref debe apuntar exactamente a su "N 0 obj"
const entries = [...b.matchAll(/^(\d{10}) 00000 n /gm)].map((m) => parseInt(m[1], 10));
checks.offsetsOk =
  entries.length > 0 &&
  entries.every((off, i) => {
    const expected = `${i + 1} 0 obj`;
    return b.slice(off, off + expected.length) === expected;
  });
console.log(JSON.stringify(checks, null, 1));
process.exit(checks.header && checks.eof && checks.xrefAtOffset && checks.offsetsOk ? 0 : 1);
