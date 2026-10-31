// Procedural surface textures painted on canvases (no image files). Each returns a 256px tileable texture.
import * as THREE from 'three';
import { HD, DETAIL, HD_SIZE } from './textures-hd.js';

const S = 256;

function rng(seed) {
  return () => { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
}

// Smooth value noise for organic variation.
function valueNoise(r, cells) {
  const grid = Array.from({ length: cells * cells }, () => r());
  const at = (x, y) => grid[((y % cells + cells) % cells) * cells + ((x % cells + cells) % cells)];
  return (u, v) => {
    const x = u * cells, y = v * cells, x0 = Math.floor(x), y0 = Math.floor(y), fx = x - x0, fy = y - y0;
    const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
    const a = at(x0, y0), b = at(x0 + 1, y0), c = at(x0, y0 + 1), d = at(x0 + 1, y0 + 1);
    return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy;
  };
}

// Fill with a base colour modulated by multi-octave noise and grain.
function base(g, r, rgb, amt = 0.18, grain = 0.08) {
  const img = g.createImageData(S, S), d = img.data;
  const n1 = valueNoise(r, 4), n2 = valueNoise(r, 16), n3 = valueNoise(r, 64);
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    const u = x / S, v = y / S;
    const n = (n1(u, v) * 0.5 + n2(u, v) * 0.3 + n3(u, v) * 0.2 - 0.5) * amt * 2 + (r() - 0.5) * grain;
    const k = (y * S + x) * 4;
    d[k] = Math.max(0, Math.min(255, rgb[0] * (1 + n)));
    d[k + 1] = Math.max(0, Math.min(255, rgb[1] * (1 + n)));
    d[k + 2] = Math.max(0, Math.min(255, rgb[2] * (1 + n)));
    d[k + 3] = 255;
  }
  g.putImageData(img, 0, 0);
}

function blocks(g, r, rows, cols, mortar, jitter, opts = {}) {
  const bh = S / rows, bw = S / cols;
  for (let row = 0; row < rows; row++) {
    const off = row % 2 ? bw / 2 : 0;
    for (let c = -1; c <= cols; c++) {
      const x = c * bw + off, y = row * bh;
      const t = (r() - 0.5) * jitter;
      g.fillStyle = t > 0 ? `rgba(255,248,230,${t})` : `rgba(60,40,20,${-t})`;
      g.fillRect(x + 1, y + 1, bw - 2, bh - 2);
      if (opts.chips) for (let k = 0; k < 3; k++) { g.fillStyle = 'rgba(70,50,30,0.18)'; g.fillRect(x + r() * bw, y + r() * bh, 2 + r() * 6, 1 + r() * 3); }
      g.fillStyle = mortar;
      g.fillRect(x, y, bw, opts.mw || 2); g.fillRect(x, y, opts.mw || 2, bh);
      g.fillStyle = 'rgba(255,255,255,0.08)';
      g.fillRect(x + 2, y + 2, bw - 4, 1);
    }
  }
}

function grime(g, r, from, alpha) {
  // darker towards the bottom (ground dirt) and a few streaks
  const grd = g.createLinearGradient(0, S * from, 0, S);
  grd.addColorStop(0, 'rgba(70,50,30,0)'); grd.addColorStop(1, `rgba(70,50,30,${alpha})`);
  g.fillStyle = grd; g.fillRect(0, 0, S, S);
  for (let i = 0; i < 6; i++) {
    const x = r() * S, w = 2 + r() * 8;
    const s = g.createLinearGradient(0, 0, 0, S * (0.3 + r() * 0.6));
    s.addColorStop(0, 'rgba(60,45,30,0.12)'); s.addColorStop(1, 'rgba(60,45,30,0)');
    g.fillStyle = s; g.fillRect(x, 0, w, S);
  }
}

function planks(g, r, n, dir, gap = '#3a2716') {
  for (let i = 0; i < n; i++) {
    const t = (r() - 0.5) * 0.25;
    g.fillStyle = t > 0 ? `rgba(255,230,190,${t})` : `rgba(40,20,5,${-t})`;
    if (dir === 'v') g.fillRect(i * S / n, 0, S / n, S); else g.fillRect(0, i * S / n, S, S / n);
    g.fillStyle = gap;
    if (dir === 'v') g.fillRect(i * S / n, 0, 2, S); else g.fillRect(0, i * S / n, S, 2);
    for (let k = 0; k < 8; k++) {
      g.fillStyle = 'rgba(50,30,10,0.15)';
      if (dir === 'v') g.fillRect(i * S / n + r() * S / n, r() * S, 1, 10 + r() * 50);
      else g.fillRect(r() * S, i * S / n + r() * S / n, 10 + r() * 50, 1);
    }
  }
}

const P = {
  limestone(g, r) { base(g, r, [205, 178, 136], 0.12); blocks(g, r, 6, 3, 'rgba(110,85,55,0.55)', 0.22, { chips: true, mw: 3 }); grime(g, r, 0.55, 0.35); },
  plaster_tan(g, r) {
    base(g, r, [214, 186, 140], 0.14);
    for (let i = 0; i < 3; i++) { // irregular patches of exposed brick where the plaster has fallen off
      const x = r() * S, y = r() * S * 0.8, w = 24 + r() * 50, h = 16 + r() * 30;
      g.save(); g.beginPath();
      for (let k = 0; k < 14; k++) { const a = k / 14 * Math.PI * 2, f = 0.55 + r() * 0.45; g.lineTo(x + Math.cos(a) * w / 2 * f, y + Math.sin(a) * h / 2 * f); }
      g.closePath(); g.clip();
      g.fillStyle = '#b08a5e'; g.fillRect(x - w, y - h, w * 2, h * 2);
      g.translate(x - w, y - h); blocks(g, r, 16, 8, 'rgba(90,65,40,0.6)', 0.2); g.restore();
    }
    grime(g, r, 0.6, 0.4);
  },
  plaster_cream(g, r) { base(g, r, [228, 214, 186], 0.08); grime(g, r, 0.7, 0.3); g.fillStyle = 'rgba(160,130,95,0.35)'; g.fillRect(0, S * 0.9, S, S * 0.1); },
  plaster_white(g, r) { base(g, r, [232, 228, 218], 0.07); grime(g, r, 0.65, 0.3); },
  plaster_orange(g, r) {
    base(g, r, [204, 152, 104], 0.2);
    for (let i = 0; i < 60; i++) { g.fillStyle = r() < 0.5 ? 'rgba(240,210,170,0.18)' : 'rgba(150,95,55,0.15)'; g.fillRect(r() * S, r() * S, 4 + r() * 30, 2 + r() * 14); }
    for (let i = 0; i < 2; i++) { // exposed stone
      const x = r() * S, y = r() * S;
      g.save(); g.beginPath(); for (let k = 0; k < 12; k++) { const a = k / 12 * 6.28, f = 0.5 + r() * 0.5; g.lineTo(x + Math.cos(a) * 30 * f, y + Math.sin(a) * 20 * f); } g.clip();
      g.fillStyle = '#9b8f80'; g.fillRect(x - 40, y - 30, 80, 60); g.translate(x - 40, y - 30); blocks(g, r, 6, 3, 'rgba(70,60,50,0.6)', 0.25); g.restore();
    }
    grime(g, r, 0.5, 0.4);
  },
  trim_blue(g, r) { base(g, r, [62, 128, 150], 0.12); grime(g, r, 0.6, 0.3); for (let i = 0; i < 30; i++) { g.fillStyle = 'rgba(220,210,190,0.35)'; g.fillRect(r() * S, r() * S, 3 + r() * 14, 2 + r() * 6); } },
  brick(g, r) { base(g, r, [168, 92, 64], 0.12); blocks(g, r, 16, 6, 'rgba(210,190,160,0.8)', 0.25, { mw: 3 }); grime(g, r, 0.6, 0.35); },
  stone(g, r) { base(g, r, [150, 145, 135], 0.15); blocks(g, r, 5, 3, 'rgba(60,60,55,0.6)', 0.25, { chips: true, mw: 3 }); grime(g, r, 0.6, 0.3); },
  sand(g, r) {
    base(g, r, [214, 186, 136], 0.16, 0.12);
    for (let i = 0; i < 1500; i++) { g.fillStyle = r() < 0.5 ? 'rgba(120,95,60,0.25)' : 'rgba(255,240,210,0.25)'; g.fillRect(r() * S, r() * S, 1 + r() * 2, 1 + r() * 2); }
  },
  dirt(g, r) { base(g, r, [156, 126, 92], 0.18, 0.16); for (let i = 0; i < 500; i++) { g.fillStyle = r() < 0.5 ? 'rgba(90,70,50,0.3)' : 'rgba(200,175,140,0.3)'; g.fillRect(r() * S, r() * S, 1 + r() * 2, 1 + r() * 2); } },
  pavers(g, r) {
    // worn sandstone slabs of mixed sizes, half covered in drifting sand
    base(g, r, [206, 182, 142], 0.12);
    const rows = 4;
    for (let y = 0; y < rows; y++) {
      let x = 0;
      while (x < S) {
        const w = S / 4 * (0.6 + r() * 0.8), h = S / rows;
        const t = (r() - 0.5) * 0.22;
        g.fillStyle = t > 0 ? `rgba(255,240,215,${t})` : `rgba(90,65,40,${-t})`;
        g.fillRect(x + 2, y * h + 2, w - 3, h - 3);
        g.fillStyle = 'rgba(110,85,55,0.35)';
        g.fillRect(x, y * h, w, 2); g.fillRect(x, y * h, 2, h);
        x += w;
      }
    }
    const n2 = valueNoise(r, 5);
    const img = g.getImageData(0, 0, S, S), d = img.data;
    for (let k = 0; k < S * S; k++) {
      const s2 = Math.max(0, n2((k % S) / S, Math.floor(k / S) / S) - 0.45) * 1.6;
      d[k * 4] += (214 - d[k * 4]) * s2; d[k * 4 + 1] += (188 - d[k * 4 + 1]) * s2; d[k * 4 + 2] += (138 - d[k * 4 + 2]) * s2;
    }
    g.putImageData(img, 0, 0);
  },
  tiles(g, r) {
    base(g, r, [206, 170, 122], 0.08);
    const n = 8, s = S / n;
    for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
      const warm = (x + y) % 2;
      g.fillStyle = warm ? 'rgba(190,120,70,0.14)' : 'rgba(250,235,205,0.12)';
      g.fillRect(x * s + 1, y * s + 1, s - 2, s - 2);
      g.fillStyle = `rgba(80,55,30,${r() * 0.15})`; g.fillRect(x * s + 1, y * s + 1, s - 2, s - 2);
    }
    g.fillStyle = 'rgba(110,90,70,0.6)';
    for (let i = 0; i <= n; i++) { g.fillRect(i * s - 1, 0, 2, S); g.fillRect(0, i * s - 1, S, 2); }
  },
  cobble(g, r) {
    // packed rounded setts in rows, dark sandy joints
    base(g, r, [104, 94, 82], 0.08);
    const rows = 14, h = S / rows;
    for (let y = 0; y < rows; y++) {
      let x = (y % 2) * h * 0.5 - h;
      while (x < S + h) {
        const w = h * (0.85 + r() * 0.5), t = r();
        g.fillStyle = `rgb(${150 + t * 35 | 0},${136 + t * 30 | 0},${116 + t * 26 | 0})`;
        g.beginPath(); g.roundRect ? g.roundRect(x + 1.5, y * h + 1.5, w - 3, h - 3, 4) : g.rect(x + 1.5, y * h + 1.5, w - 3, h - 3); g.fill();
        g.fillStyle = 'rgba(255,250,235,0.10)'; g.fillRect(x + 3, y * h + 3, w - 8, 3);
        x += w;
      }
    }
  },
  door(g, r) {
    base(g, r, [108, 72, 40], 0.1);
    planks(g, r, 6, 'v');
    g.fillStyle = '#2b2522';
    g.fillRect(0, S * 0.18, S, 10); g.fillRect(0, S * 0.78, S, 10);
    for (let i = 0; i < 6; i++) { g.fillStyle = '#555'; g.beginPath(); g.arc(i * S / 6 + 20, S * 0.18 + 5, 3, 0, 7); g.arc(i * S / 6 + 20, S * 0.78 + 5, 3, 0, 7); g.fill(); }
  },
  door_blue(g, r) {
    base(g, r, [52, 104, 140], 0.12);
    planks(g, r, 6, 'v', '#1d3a50');
    for (let i = 0; i < 50; i++) { g.fillStyle = 'rgba(200,180,140,0.35)'; g.fillRect(r() * S, r() * S, 2 + r() * 12, 1 + r() * 5); } // chipped paint
    g.fillStyle = '#2b2522';
    g.fillRect(0, S * 0.18, S, 10); g.fillRect(0, S * 0.78, S, 10);
  },
  cloth_red(g, r) { base(g, r, [160, 52, 40], 0.1); for (let x = 0; x < S; x += 32) { g.fillStyle = 'rgba(240,210,160,0.5)'; g.fillRect(x, 0, 10, S); } grime(g, r, 0.4, 0.3); },
  cloth_blue(g, r) { base(g, r, [44, 84, 140], 0.1); for (let x = 0; x < S; x += 32) { g.fillStyle = 'rgba(235,230,215,0.55)'; g.fillRect(x, 0, 12, S); } grime(g, r, 0.4, 0.3); },
  cloth_green(g, r) { base(g, r, [96, 170, 92], 0.12); for (let i = 0; i < 12; i++) { g.fillStyle = 'rgba(30,70,30,0.25)'; g.fillRect(0, r() * S, S, 2 + r() * 6); } grime(g, r, 0.5, 0.25); },
  cloth_cream(g, r) { base(g, r, [214, 196, 160], 0.1); for (let x = 0; x < S; x += 40) { g.fillStyle = 'rgba(150,80,40,0.35)'; g.fillRect(x, 0, 6, S); } grime(g, r, 0.4, 0.3); },
  leaves(g, r) {
    g.clearRect(0, 0, S, S);
    for (let i = 0; i < 900; i++) {
      const t = r();
      g.fillStyle = `rgba(${50 + t * 50 | 0},${90 + t * 60 | 0},${30 + t * 30 | 0},0.95)`;
      g.beginPath(); g.ellipse(r() * S, r() * S, 4 + r() * 6, 2 + r() * 3, r() * 3, 0, 7); g.fill();
    }
  },
  bark(g, r) { base(g, r, [100, 78, 56], 0.2); for (let x = 0; x < S; x += 6) { g.fillStyle = `rgba(40,25,15,${0.2 + r() * 0.3})`; g.fillRect(x, 0, 2, S); } },
  wood(g, r) { base(g, r, [126, 90, 56], 0.1); planks(g, r, 5, 'h'); },
  crate(g, r) {
    base(g, r, [168, 128, 78], 0.1);
    planks(g, r, 5, 'h', '#6b4a26');
    g.strokeStyle = '#6a4724'; g.lineWidth = 20; g.strokeRect(10, 10, S - 20, S - 20);
    g.lineWidth = 16; g.beginPath(); g.moveTo(20, 20); g.lineTo(S - 20, S - 20); g.stroke();
    g.strokeStyle = 'rgba(255,230,180,0.25)'; g.lineWidth = 2; g.strokeRect(2, 2, S - 4, S - 4);
  },
  container(g, r) {
    base(g, r, [52, 96, 128], 0.08);
    for (let x = 0; x < S; x += 16) { g.fillStyle = 'rgba(0,0,0,0.25)'; g.fillRect(x, 0, 4, S); g.fillStyle = 'rgba(255,255,255,0.12)'; g.fillRect(x + 8, 0, 3, S); }
    for (let i = 0; i < 30; i++) { g.fillStyle = 'rgba(140,80,40,0.35)'; g.fillRect(r() * S, r() * S, 2 + r() * 10, 2 + r() * 20); }
  },
  van(g, r) { base(g, r, [220, 222, 220], 0.05); g.fillStyle = '#333'; g.fillRect(0, S * 0.15, S, S * 0.25); g.fillStyle = 'rgba(80,80,80,0.5)'; g.fillRect(0, S * 0.85, S, S * 0.15); },
  car(g, r) { base(g, r, [176, 90, 64], 0.1); g.fillStyle = '#2a2f33'; g.fillRect(0, S * 0.1, S, S * 0.3); for (let i = 0; i < 40; i++) { g.fillStyle = 'rgba(120,70,40,0.4)'; g.fillRect(r() * S, r() * S, 2 + r() * 12, 2 + r() * 6); } },
  sandbag(g, r) {
    base(g, r, [176, 158, 112], 0.1);
    for (let y = 0; y < 4; y++) for (let x = -1; x < 3; x++) {
      const cx = x * S / 2 + (y % 2) * S / 4 + S / 4, cy = y * S / 4 + S / 8;
      g.fillStyle = 'rgba(80,65,40,0.45)'; g.beginPath(); g.ellipse(cx, cy + 4, S / 4.2, S / 9, 0, 0, 7); g.fill();
      g.fillStyle = 'rgba(200,185,140,1)'; g.beginPath(); g.ellipse(cx, cy, S / 4.4, S / 10, 0, 0, 7); g.fill();
    }
  },
  roof(g, r) { base(g, r, [150, 92, 64], 0.1); for (let y = 0; y < S; y += 16) { g.fillStyle = 'rgba(60,30,15,0.4)'; g.fillRect(0, y, S, 3); } },
};

const cache = {};
export function surfaceTexture(kind) {
  if (cache[kind]) return cache[kind];
  const hd = HD[kind] || DETAIL[kind];
  const c = document.createElement('canvas');
  c.width = c.height = hd ? HD_SIZE : S;
  const g = c.getContext('2d', { willReadFrequently: true });
  let seed = 0; for (const ch of kind) seed = seed * 31 + ch.charCodeAt(0);
  (hd || P[kind] || P.stone)(g, rng(seed));
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 16;
  cache[kind] = t;
  return t;
}

export function isTextureCached(t) { return Object.values(cache).includes(t); }

// Metres per texture repeat.
export const TEX_SCALE = { plaster_ochre: 6, plaster_red: 6, plaster_blue: 6, plaster_pink: 6, plaster_green: 6, sandstone: 3.6, brick_pale: 3.2, flagstone: 4, cobble_warm: 3, tile_cream: 3.2, tile_terra: 3, tile_white: 3, wood_old: 2.4, crate_hd: 1.2, carton: 0.9, ceil_plain: 5, limestone: 3.6, plaster_tan: 4, plaster_cream: 6, plaster_white: 4, plaster_orange: 4, trim_blue: 3, brick: 2.4, stone: 3, sand: 4, dirt: 4, pavers: 3, tiles: 2.4, cobble: 2.5, door: 2.5, wood: 2, crate: 1, container: 2.5, van: 2, car: 2, sandbag: 1.5, roof: 3, door_blue: 2.5, cloth_red: 2, cloth_blue: 2, cloth_cream: 2, leaves: 1, bark: 1 };
