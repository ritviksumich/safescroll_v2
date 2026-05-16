import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const outDir = join(scriptDir, '..', 'icons');
mkdirSync(outDir, { recursive: true });

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const t = Buffer.from(type);
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([t, data])));
  return Buffer.concat([len, t, data, crc]);
}

function writePng(path, w, h, rgba) {
  const rows = [];
  for (let y = 0; y < h; y++) {
    rows.push(Buffer.from([0]));
    rows.push(Buffer.from(rgba.subarray(y * w * 4, (y + 1) * w * 4)));
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(Buffer.concat(rows))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
  writeFileSync(path, png);
}

function pointInPoly(x, y, points) {
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const xi = points[i][0], yi = points[i][1];
    const xj = points[j][0], yj = points[j][1];
    const intersect = ((yi > y) !== (yj > y)) &&
      (x < ((xj - xi) * (y - yi)) / (yj - yi) + xi);
    if (intersect) inside = !inside;
  }
  return inside;
}

function distToSegment(px, py, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  const t = len2 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2)) : 0;
  const x = ax + t * dx;
  const y = ay + t * dy;
  return Math.hypot(px - x, py - y);
}

function drawIcon(size) {
  const scale = size / 128;
  const rgba = new Uint8Array(size * size * 4);
  const set = (x, y, color) => {
    if (x < 0 || y < 0 || x >= size || y >= size) return;
    const i = (y * size + x) * 4;
    rgba[i] = color[0]; rgba[i + 1] = color[1]; rgba[i + 2] = color[2]; rgba[i + 3] = color[3];
  };
  const S = (v) => v * scale;
  const shieldOuter = [[64, 6], [111, 24], [111, 60], [102, 86], [64, 118], [26, 86], [17, 60], [17, 24]]
    .map(([x, y]) => [S(x), S(y)]);
  const shieldInner = [[64, 23], [94, 34], [94, 60], [86, 78], [64, 96], [42, 78], [34, 60], [34, 34]]
    .map(([x, y]) => [S(x), S(y)]);
  const colors = {
    outline: [35, 31, 32, 255],
    neon: [172, 255, 0, 255],
    green: [91, 179, 30, 255],
    greenDark: [72, 152, 23, 255],
  };

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const cx = x + 0.5, cy = y + 0.5;
      if (pointInPoly(cx, cy, shieldOuter)) set(x, y, colors.outline);
    }
  }
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const cx = x + 0.5, cy = y + 0.5;
      if (pointInPoly(cx, cy, shieldOuter) && !pointInPoly(cx, cy, shieldInner)) set(x, y, colors.neon);
      if (pointInPoly(cx, cy, shieldInner)) set(x, y, cx > S(64) ? colors.greenDark : colors.green);
    }
  }
  const check = [[48, 60], [60, 73], [82, 48]].map(([x, y]) => [S(x), S(y)]);
  const lw = S(7);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const cx = x + 0.5, cy = y + 0.5;
      if (distToSegment(cx, cy, ...check[0], ...check[1]) < lw ||
          distToSegment(cx, cy, ...check[1], ...check[2]) < lw) set(x, y, colors.outline);
    }
  }
  return rgba;
}

for (const size of [16, 32, 48, 128]) {
  writePng(join(outDir, `icon-${size}.png`), size, size, drawIcon(size));
}
