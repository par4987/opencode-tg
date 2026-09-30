/** Escribe el .md de verificación e imprime la ruta absoluta para que el plugin la capture. */
const fs = require("fs");
const path = require("path");

const outPath = process.argv[2] || path.join(__dirname, "..", "out", "verificacion-2026-09-29.md");

const content = [
  "# Verificacion del ciclo - 2026-09-29",
  "",
  "## Lo verificado en vivo hoy",
  "",
  "| Feature | Estado |",
  "| --- | --- |",
  "| Reply-context (eco del foro filtrado) | OK |",
  "| Coalescing busy (unifica en la queue) | OK - 5 mensajes a 1 entrada |",
  "| /usagestats (ruta experimental + unwrap) | OK |",
  "| Imagenes salientes (timer de gracia 30s) | OK - pelota recibida |",
  "| Archivos .md inline (menos de 12 KB) | <- esta prueba |",
  "",
  "## Como leer el pipeline",
  "",
  "1. El output de una tool deja una ruta absoluta.",
  "2. noteTurnImage() la acumula y arma el timer de gracia de 30s.",
  "3. flushTurnImages() decide el canal: foto, texto inline o documento.",
  "4. El texto chico se lee del disco y viaja como mensaje legible.",
  "",
  "Si estas leyendo esto dentro del hilo de Telegram, el canal de",
  "texto inline funciona de punta a punta.",
  "",
].join("\n");

fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, content, "utf8");
console.log("MD generado: " + outPath + " (" + Buffer.byteLength(content, "utf8") + " bytes)");
