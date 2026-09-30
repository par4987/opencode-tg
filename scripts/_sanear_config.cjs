/** Limpia el mojibake del comment de apertura del config.json. */
const fs = require("fs");
const file = "E:\\Projects\\Default Project\\opencode-tg\\config.json";
let c = fs.readFileSync(file, "utf8");
const re = /^\/\/ opencode-tg .*$/m;
if (!re.test(c)) {
  console.log("ANCLA no encontrada");
  process.exit(1);
}
c = c.replace(re, "// opencode-tg \u2014 ajustes del puente.");
fs.writeFileSync(file, c, "utf8");
console.log("config.json: comment saneado");
