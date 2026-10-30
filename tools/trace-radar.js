// Converts the official CS2 radar overviews into Strike Lite map grids.
// Usage: node tools/trace-radar.js [mapId]
// Downloads each radar PNG into memory (never saved), traces it at 1 m per cell and writes shared/mapdata/<id>.js
//
// Radar legend: dark lines = walls, transparent = outside the map, light grey squares = boxes,
// orange outlines = bombsites, green outlines = spawns. Floor colour encodes height
// (teal = lowest, grey = middle, olive/brown = highest).
import zlib from 'node:zlib';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const BASE = 'https://raw.githubusercontent.com/MurkyYT/cs2-map-icons/main/images/radars/';
const UNIT = 0.0254; // metres per game unit

const MAPS = {
  dust2: { file: 'de_dust2_radar_psd.png', scale: 4.4, range: 7, A: 'right', T: 'bottom' },
  mirage: { file: 'de_mirage_radar_psd.png', scale: 5.0, range: 6, A: 'bottom', T: 'right' },
  inferno: { file: 'de_inferno_radar_psd.png', scale: 4.9, range: 6, A: 'bottom', T: 'left' },
};

// ---------------------------------------------------------------- minimal PNG decoder (8-bit RGB/RGBA/palette)
function decodePNG(buf) {
  let p = 8, w = 0, h = 0, depth = 0, type = 0, palette = null, trns = null;
  const idat = [];
  while (p < buf.length) {
    const len = buf.readUInt32BE(p), t = buf.toString('ascii', p + 4, p + 8), d = buf.subarray(p + 8, p + 8 + len);
    if (t === 'IHDR') { w = d.readUInt32BE(0); h = d.readUInt32BE(4); depth = d[8]; type = d[9]; if (d[12]) throw new Error('interlaced PNG not supported'); }
    else if (t === 'PLTE') palette = d;
    else if (t === 'tRNS') trns = d;
    else if (t === 'IDAT') idat.push(d);
    else if (t === 'IEND') break;
    p += 12 + len;
  }
  if (depth !== 8) throw new Error('only 8-bit PNGs supported, got ' + depth);
  const ch = { 2: 3, 6: 4, 3: 1, 0: 1, 4: 2 }[type];
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = w * ch, out = Buffer.alloc(w * h * 4);
  let prev = Buffer.alloc(stride), q = 0;
  for (let y = 0; y < h; y++) {
    const f = raw[q++], line = Buffer.from(raw.subarray(q, q + stride)); q += stride;
    for (let x = 0; x < stride; x++) {
      const a = x >= ch ? line[x - ch] : 0, b = prev[x], c = x >= ch ? prev[x - ch] : 0;
      let v = line[x];
      if (f === 1) v += a; else if (f === 2) v += b; else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) { const pp = a + b - c, pa = Math.abs(pp - a), pb = Math.abs(pp - b), pc = Math.abs(pp - c); v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
      line[x] = v & 255;
    }
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4;
      if (type === 6) { out[o] = line[x * 4]; out[o + 1] = line[x * 4 + 1]; out[o + 2] = line[x * 4 + 2]; out[o + 3] = line[x * 4 + 3]; }
      else if (type === 2) { out[o] = line[x * 3]; out[o + 1] = line[x * 3 + 1]; out[o + 2] = line[x * 3 + 2]; out[o + 3] = 255; }
      else if (type === 3) { const i = line[x]; out[o] = palette[i * 3]; out[o + 1] = palette[i * 3 + 1]; out[o + 2] = palette[i * 3 + 2]; out[o + 3] = trns && i < trns.length ? trns[i] : 255; }
      else if (type === 0) { out[o] = out[o + 1] = out[o + 2] = line[x]; out[o + 3] = 255; }
      else { out[o] = out[o + 1] = out[o + 2] = line[x * 2]; out[o + 3] = line[x * 2 + 1]; }
    }
    prev = line;
  }
  return { w, h, data: out };
}

// ---------------------------------------------------------------- pixel classes
const VOID = 0, LINE = 1, FLOOR = 2, CRATE = 3, SITE = 4, SPAWN = 5;
function classify(r, g, b, a) {
  if (a < 128) return VOID;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), lum = 0.3 * r + 0.59 * g + 0.11 * b;
  if (r > 100 && r - b > 64 && r - g > 44) return SITE;
  if (g > 80 && g - r > 35 && g - b > 15) return SPAWN;
  if (lum < 42) return LINE;
  if (mx - mn < 22 && lum > 112) return CRATE;
  return FLOOR;
}

async function trace(id) {
  const cfg = MAPS[id];
  process.stdout.write(`${id}: downloading ${cfg.file}… `);
  const res = await fetch(BASE + cfg.file);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const png = decodePNG(Buffer.from(await res.arrayBuffer()));
  const pxPerCell = 1 / (cfg.scale * UNIT);
  // bounding box of the playable area
  let x0 = png.w, y0 = png.h, x1 = 0, y1 = 0;
  for (let y = 0; y < png.h; y++) for (let x = 0; x < png.w; x++) if (png.data[(y * png.w + x) * 4 + 3] > 128) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
  const pad = 2 * pxPerCell;
  x0 -= pad; y0 -= pad;
  const W = Math.ceil((x1 - x0 + pad) / pxPerCell), H = Math.ceil((y1 - y0 + pad) / pxPerCell);
  const height = new Float32Array(W * H).fill(-1), crate = new Uint8Array(W * H), lineFrac = new Float32Array(W * H);
  const site = new Uint8Array(W * H), spawn = new Uint8Array(W * H);
  for (let cz = 0; cz < H; cz++) for (let cx = 0; cx < W; cx++) {
    const counts = [0, 0, 0, 0, 0, 0], ts = [];
    for (let py = Math.floor(y0 + cz * pxPerCell); py < y0 + (cz + 1) * pxPerCell; py++)
      for (let px = Math.floor(x0 + cx * pxPerCell); px < x0 + (cx + 1) * pxPerCell; px++) {
        if (px < 0 || py < 0 || px >= png.w || py >= png.h) { counts[VOID]++; continue; }
        const o = (py * png.w + px) * 4, r = png.data[o], g = png.data[o + 1], b = png.data[o + 2];
        const c = classify(r, g, b, png.data[o + 3]);
        counts[c]++;
        if (c === FLOOR) ts.push(r - b);
      }
    const total = counts.reduce((s, v) => s + v, 0);
    const i = cz * W + cx;
    lineFrac[i] = counts[LINE] / total;
    if (counts[SITE] > 0) site[i] = 1;
    if (counts[SPAWN] > 0) spawn[i] = 1;
    if ((counts[VOID] + counts[LINE]) / total > 0.5) continue;
    if (counts[CRATE] / total > 0.4) crate[i] = 1;
    if (ts.length) { ts.sort((a, b) => a - b); const t = ts[ts.length >> 1]; height[i] = Math.max(0, Math.min(1, (t + 65) / 125)) * cfg.range; }
    else height[i] = -2; // walkable but no colour sample (crate/marker): filled from neighbours below
  }
  // fill unknown heights from neighbours, then median-smooth to remove colour noise (keeps ledges sharp)
  for (let pass = 0; pass < 6; pass++) for (let i = 0; i < W * H; i++) if (height[i] === -2) {
    const x = i % W, z = (i / W) | 0, nb = [];
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1], [1, -1], [-1, 1]]) { const j = (z + dz) * W + x + dx; if (x + dx >= 0 && x + dx < W && z + dz >= 0 && z + dz < H && height[j] >= 0) nb.push(height[j]); }
    if (nb.length) height[i] = nb.reduce((s, v) => s + v, 0) / nb.length;
  }
  for (let i = 0; i < W * H; i++) if (height[i] === -2) height[i] = 0;
  const smooth = Float32Array.from(height);
  for (let z = 0; z < H; z++) for (let x = 0; x < W; x++) {
    const i = z * W + x;
    if (height[i] < 0) continue;
    const v = [];
    for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) { const j = (z + dz) * W + x + dx; if (x + dx >= 0 && x + dx < W && z + dz >= 0 && z + dz < H && height[j] >= 0 && !crate[j]) v.push(height[j]); }
    if (v.length >= 3) { v.sort((a, b) => a - b); smooth[i] = v[v.length >> 1]; }
  }
  // thin walls: a dark line through a cell that does NOT separate different heights is a wall, not a ledge
  for (let z = 1; z < H - 1; z++) for (let x = 1; x < W - 1; x++) {
    const i = z * W + x;
    if (smooth[i] < 0 || lineFrac[i] < 0.24) continue;
    const hs = [smooth[i - 1], smooth[i + 1], smooth[i - W], smooth[i + W]].filter(v => v >= 0);
    if (hs.length >= 2 && Math.max(...hs) - Math.min(...hs) < 0.6) smooth[i] = -1;
  }

  // zones: clusters of marker cells
  const clusters = (mask) => {
    const seen = new Uint8Array(W * H), out = [];
    for (let i = 0; i < W * H; i++) {
      if (!mask[i] || seen[i]) continue;
      const st = [i]; seen[i] = 1;
      let r = [W, H, 0, 0], n = 0;
      while (st.length) {
        const k = st.pop(), x = k % W, z = (k / W) | 0; n++;
        r = [Math.min(r[0], x), Math.min(r[1], z), Math.max(r[2], x), Math.max(r[3], z)];
        for (let dz = -2; dz <= 2; dz++) for (let dx = -2; dx <= 2; dx++) {
          const nx = x + dx, nz = z + dz, j = nz * W + nx;
          if (nx >= 0 && nz >= 0 && nx < W && nz < H && mask[j] && !seen[j]) { seen[j] = 1; st.push(j); }
        }
      }
      out.push({ r, n });
    }
    return out.sort((a, b) => b.n - a.n).slice(0, 2).map(c => c.r);
  };
  const pickBy = (rs, dir) => {
    const key = { right: r => r[0] + r[2], left: r => -(r[0] + r[2]), bottom: r => r[1] + r[3], top: r => -(r[1] + r[3]) }[dir];
    return [...rs].sort((a, b) => key(b) - key(a));
  };
  const sites = pickBy(clusters(site), cfg.A), spawns = pickBy(clusters(spawn), cfg.T);
  const zones = { A: sites[0], B: sites[1], T: spawns[0], CT: spawns[1] };

  // encode: '#' = wall, otherwise char code 48 + height in 0.1 m steps (crates raised 1.1 m) ; crate mask separately
  const rows = [], crateRows = [];
  for (let z = 0; z < H; z++) {
    let row = '', cr = '';
    for (let x = 0; x < W; x++) {
      const i = z * W + x;
      if (smooth[i] < 0) { row += '#'; cr += '.'; continue; }
      const h = smooth[i] + (crate[i] ? 1.1 : 0);
      row += String.fromCharCode(48 + Math.round(h * 10));
      cr += crate[i] ? 'c' : '.';
    }
    rows.push(row); crateRows.push(cr);
  }
  const outFile = path.join(ROOT, 'shared', 'mapdata', `${id}.js`);
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile,
    `// Traced from the CS2 radar overview by tools/trace-radar.js. Do not edit by hand; re-run the tool.\n` +
    `// rows: '#' = wall, other chars = floor height (charCode - 48) / 10 metres. crates: 'c' = box.\n` +
    `export default ${JSON.stringify({ w: W, h: H, zones, radar: { file: cfg.file, x0: +x0.toFixed(2), y0: +y0.toFixed(2), pxPerCell: +pxPerCell.toFixed(4) }, rows, crates: crateRows })};\n`);
  console.log(`${W}x${H} cells, zones ${JSON.stringify(zones)} -> ${path.relative(ROOT, outFile)}`);
}

const only = process.argv[2];
for (const id of Object.keys(MAPS)) if (!only || only === id) await trace(id);
