'use strict';

/**
 * Genera assets/icon.ico sin depender de ninguna libreria de imagen:
 * pintamos los pixeles a mano, los codificamos en PNG con zlib y metemos los
 * PNG resultantes dentro de un contenedor ICO.
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const SIZES = [16, 32, 48, 64, 128, 256];

/* ─────────────────────────────── Dibujo ──────────────────────────────── */

function draw(size) {
  const px = Buffer.alloc(size * size * 4); // RGBA
  const s = (v) => Math.round((v / 256) * size); // escala desde el diseno de 256

  const set = (x, y, r, g, b, a) => {
    if (x < 0 || y < 0 || x >= size || y >= size) return;
    const i = (y * size + x) * 4;
    px[i] = r; px[i + 1] = g; px[i + 2] = b; px[i + 3] = a;
  };

  const radius = s(46);
  const inCard = (x, y) => {
    // Rectangulo con esquinas redondeadas
    const cx = Math.min(Math.max(x, radius), size - 1 - radius);
    const cy = Math.min(Math.max(y, radius), size - 1 - radius);
    const dx = x - cx;
    const dy = y - cy;
    return dx * dx + dy * dy <= radius * radius;
  };

  // Fondo con degradado vertical azul muy oscuro
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (!inCard(x, y)) continue;
      const t = y / size;
      set(x, y, Math.round(12 + 4 * t), Math.round(17 + 6 * t), Math.round(28 + 10 * t), 255);
    }
  }

  // Marco cian tenue
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (!inCard(x, y)) continue;
      const edge = !inCard(x - 1, y) || !inCard(x + 1, y) || !inCard(x, y - 1) || !inCard(x, y + 1);
      if (edge) set(x, y, 34, 211, 238, 120);
    }
  }

  const rect = (x0, y0, w, h, r, g, b, a) => {
    for (let y = y0; y < y0 + h; y++) {
      for (let x = x0; x < x0 + w; x++) set(x, y, r, g, b, a === undefined ? 255 : a);
    }
  };

  // Chevron ">" cian, dibujado como dos trazos diagonales gruesos
  const thick = Math.max(2, s(26));
  const startX = s(62);
  const midX = s(122);
  const topY = s(74);
  const midY = s(128);

  for (let i = 0; i <= midX - startX; i++) {
    const x = startX + i;
    const yUp = topY + Math.round((i * (midY - topY)) / (midX - startX));
    const yDn = size - 1 - yUp;
    for (let t = 0; t < thick; t++) {
      set(x, yUp + t, 34, 211, 238, 255);
      set(x, yDn - t, 34, 211, 238, 255);
    }
  }

  // Cursor magenta (el "_" del prompt)
  rect(s(142), s(150), s(58), Math.max(2, s(20)), 244, 114, 182, 255);

  return px;
}

/* ─────────────────────────────── PNG ─────────────────────────────────── */

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);

  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body) >>> 0, 0);

  return Buffer.concat([len, body, crc]);
}

let CRC_TABLE = null;
function crc32(buf) {
  if (!CRC_TABLE) {
    CRC_TABLE = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      CRC_TABLE[n] = c;
    }
  }
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return c ^ -1;
}

function toPNG(px, size) {
  // Cada fila de un PNG lleva delante un byte de tipo de filtro (0 = ninguno)
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    px.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;  // bits por canal
  ihdr[9] = 6;  // RGBA
  ihdr[10] = 0; // deflate
  ihdr[11] = 0; // filtro adaptativo
  ihdr[12] = 0; // sin entrelazado

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

/* ─────────────────────────────── ICO ─────────────────────────────────── */

function toICO(images) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2); // 1 = icono
  header.writeUInt16LE(images.length, 4);

  const entries = [];
  let offset = 6 + images.length * 16;

  for (const img of images) {
    const e = Buffer.alloc(16);
    e[0] = img.size >= 256 ? 0 : img.size; // 0 significa 256
    e[1] = img.size >= 256 ? 0 : img.size;
    e[2] = 0; // paleta
    e[3] = 0; // reservado
    e.writeUInt16LE(1, 4);  // planos
    e.writeUInt16LE(32, 6); // bits por pixel
    e.writeUInt32BE(0, 8);
    e.writeUInt32LE(img.png.length, 8);
    e.writeUInt32LE(offset, 12);
    entries.push(e);
    offset += img.png.length;
  }

  return Buffer.concat([header, ...entries, ...images.map((i) => i.png)]);
}

/* ─────────────────────────────── Main ────────────────────────────────── */

const images = SIZES.map((size) => ({ size, png: toPNG(draw(size), size) }));
const out = path.join(__dirname, '..', 'assets', 'icon.ico');

fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, toICO(images));

// electron-builder tambien quiere un PNG grande para algunos targets
fs.writeFileSync(path.join(__dirname, '..', 'assets', 'icon.png'), images[images.length - 1].png);

console.log('icon.ico generado (' + SIZES.join(', ') + ') ->', out);
