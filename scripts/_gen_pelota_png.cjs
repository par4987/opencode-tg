/**
 * Pelota de fútbol (pentágonos negros sobre blanco) sobre franjas de césped,
 * con sombra para que se apoye. Render a 1024 + downsample a 512 = AA gratis.
 * Sin dependencias: PNG a mano con zlib. Imprime la ruta absoluta al final
 * para que el plugin la capture y la envíe como foto al hilo.
 */
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const outPath = process.argv[2] || path.join(__dirname, "..", "out", "pelota-futbol.png");

const S = 2; // supersample
const FW = 512;
const W = FW * S;
const H = W;
const BX = 256 * S;
const BY = 244 * S;
const R = 146 * S;

const stripeA = [40, 145, 62];
const stripeB = [33, 126, 52];
const SHADOW = 0.42; // la sombra oscurece la franja debajo
const WHITE = [247, 247, 249];
const BLACK = [26, 26, 28];
const EDGE = [212, 212, 216];

function pentagon(cx, cy, r, startAngle) {
  const v = [];
  for (let k = 0; k < 5; k++) {
    const a = startAngle + (k * 2 * Math.PI) / 5;
    v.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
  }
  return v;
}

function pointInPolygon(px, py, vertices) {
  let inside = false;
  for (let i = 0, j = vertices.length - 1; i < vertices.length; j = i++) {
    const xi = vertices[i][0];
    const yi = vertices[i][1];
    const xj = vertices[j][0];
    const yj = vertices[j][1];
    if ((yi > py) !== (yj > py) && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

// Pentágonos negros: uno central + cinco alrededor, recortados por el círculo.
const polys = [pentagon(BX, BY, R * 0.32, -Math.PI / 2)];
for (let k = 0; k < 5; k++) {
  const phi = -Math.PI / 2 + (k * 2 * Math.PI) / 5;
  const d = R * 0.78;
  polys.push(
    pentagon(BX + d * Math.cos(phi), BY + d * Math.sin(phi), R * 0.34, phi + Math.PI),
  );
}

const raw = Buffer.alloc(H * (1 + W * 3));
let off = 0;
for (let y = 0; y < H; y++) {
  raw[off++] = 0; // filter: none
  for (let x = 0; x < W; x++) {
    const stripe = Math.floor(x / (32 * S)) % 2 === 0 ? stripeA : stripeB;
    let c = stripe;
    // Sombra elíptica bajo la pelota (antes del círculo, para que la pelota la pise)
    const sx = (x - BX) / (R * 1.02);
    const sy = (y - (BY + R * 0.82)) / (R * 0.25);
    if (sx * sx + sy * sy <= 1) {
      c = [
        Math.round(stripe[0] * SHADOW),
        Math.round(stripe[1] * SHADOW),
        Math.round(stripe[2] * SHADOW),
      ];
    }
    const dx = x - BX;
    const dy = y - BY;
    const dist2 = dx * dx + dy * dy;
    if (dist2 <= R * R) {
      c = WHITE;
      for (const poly of polys) {
        if (pointInPolygon(x, y, poly)) {
          c = BLACK;
          break;
        }
      }
      if (dist2 > (R * 0.96) * (R * 0.96)) c = EDGE; // borde interior del balón
    }
    raw[off++] = c[0];
    raw[off++] = c[1];
    raw[off++] = c[2];
  }
}

// Downsample S×S por promedio → 512×512 con antialiasing.
const FH = FW;
const final = Buffer.alloc(FH * (1 + FW * 3));
let fo = 0;
const stride = 1 + W * 3;
for (let y = 0; y < FH; y++) {
  final[fo++] = 0;
  for (let x = 0; x < FW; x++) {
    let r = 0;
    let g = 0;
    let b = 0;
    for (let sy2 = 0; sy2 < S; sy2++) {
      for (let sx2 = 0; sx2 < S; sx2++) {
        const idx = (y * S + sy2) * stride + 1 + (x * S + sx2) * 3;
        r += raw[idx];
        g += raw[idx + 1];
        b += raw[idx + 2];
      }
    }
    const n = S * S;
    final[fo++] = Math.round(r / n);
    final[fo++] = Math.round(g / n);
    final[fo++] = Math.round(b / n);
  }
}

const idat = zlib.deflateSync(final, { level: 9 });

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(FW, 0);
ihdr.writeUInt32BE(FH, 4);
ihdr[8] = 8;
ihdr[9] = 2;

const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk("IHDR", ihdr),
  chunk("IDAT", idat),
  chunk("IEND", Buffer.alloc(0)),
]);

fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, png);
console.log("PNG generado: " + outPath + " (" + png.length + " bytes)");
