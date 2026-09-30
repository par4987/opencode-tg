/**
 * Genera un PNG a mano (sin dependencias): circulo rojo sobre fondo verde.
 * Imprime la ruta absoluta al final para que el plugin la detecte en el
 * output de la tool y la envie como foto al hilo de Telegram.
 */
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const outPath = process.argv[2] || path.join(__dirname, "..", "out", "circulo-rojo.png");

const W = 512;
const H = 512;
const CX = W / 2;
const CY = H / 2;
const R = 180;
const GREEN = [16, 190, 70];
const RED = [232, 32, 32];

// Scanlines crudos: cada fila lleva un byte de filtro (0 = none) + RGB.
const raw = Buffer.alloc(H * (1 + W * 3));
let off = 0;
for (let y = 0; y < H; y++) {
  raw[off++] = 0;
  for (let x = 0; x < W; x++) {
    const dx = x - CX;
    const dy = y - CY;
    const c = dx * dx + dy * dy <= R * R ? RED : GREEN;
    raw[off++] = c[0];
    raw[off++] = c[1];
    raw[off++] = c[2];
  }
}

const idat = zlib.deflateSync(raw, { level: 9 });

// CRC32 estandar (tabla 0xEDB88320) para los chunks.
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const typed = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typed));
  return Buffer.concat([len, typed, crc]);
}

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(W, 0);
ihdr.writeUInt32BE(H, 4);
ihdr[8] = 8; // bit depth
ihdr[9] = 2; // color type: truecolor RGB

const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk("IHDR", ihdr),
  chunk("IDAT", idat),
  chunk("IEND", Buffer.alloc(0)),
]);

fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, png);
console.log("PNG generado: " + outPath + " (" + png.length + " bytes)");
