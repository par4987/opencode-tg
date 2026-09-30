const fs = require("fs");
const file = "E:\\Projects\\Default Project\\opencode-tg\\index.ts";
let c = fs.readFileSync(file, "utf8");

const flushAt = c.indexOf("let moved = 0;");
if (flushAt < 0) { console.log("ANCLA flush NO ENCONTRADA"); process.exit(1); }
const start = c.indexOf("const r = await forms", flushAt);
const endAnchor = "if (r !== undefined) moved += 1;";
const endIdx = c.indexOf(endAnchor, start);
if (start < 0 || endIdx < 0) { console.log("ANCLA bloque NO ENCONTRADA"); process.exit(1); }
const end = endIdx + endAnchor.length;

const nuevo = [
  "try {",
  "               // Empty 204 is success for this PATCH \u2014 the item leaving the",
  "               // inbox is the point, not the body.",
  "               await forms.request(",
  "                 \"PATCH\",",
  "                 `/session/${encodeURIComponent(session)}/inbox/${encodeURIComponent(id)}`,",
  "                 { delivery: \"steer\" },",
  "               );",
  "               moved += 1;",
  "             } catch {",
  "               // one stuck item does not stop the rest of the flush",
  "             }",
].join("\n");

c = c.substring(0, start) + nuevo + c.substring(end);
fs.writeFileSync(file, c, "utf8");
console.log("flush steer corregido");
