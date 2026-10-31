// Maps: Dust II, Mirage and Inferno, built from brushes like a GoldSrc/Hammer map.
//
// Where the layouts come from: tools/trace-radar.js traces the official CS2 radar overviews into a 1 m height
// grid (walls, floor heights, boxes, bombsites, spawns). That grid plus the overrides below is converted into
// brushes (merged boxes, sloped boxes for ramps, roof slabs). If the map has been saved from the in-game map
// editor, the saved brushes in mapdata/edits.js are used instead. Geometry, textures and models are generated.
//
// Grid overrides are [x1, z1, x2, z2] inclusive, in cells (metres). +x = east, +z = south (top of radar = north).
//   ceilings: [x1,z1,x2,z2, clearance]   add a roof `clearance` metres above the floor (tunnels, rooms)
//   paint:    [x1,z1,x2,z2, mat, top?]   wall material / wall top height for walls in the rect
//   floors:   [x1,z1,x2,z2, mat]         floor material for open cells in the rect
//   boxes:    [x1,z1,x2,z2, mat]         material for the boxes in the rect (container, car, van, ...)
import dust2Trace from './mapdata/dust2.js';
import mirageTrace from './mapdata/mirage.js';
import infernoTrace from './mapdata/inferno.js';
import * as MIRAGE_PLAN from './mapdata/mirage-levels.js';
import { buildPlan } from './mapdata/plan.js';
import EDITS from './mapdata/edits.js';
import { boxBrush, slopeBrush, prismBrush, buildGrid, buildMeshIndex, trace } from './brush.js';
import { boxBlocked } from './physics.js';

export const CELL = 1;
export const STEP = 0.55;     // max step-up height
export const NO_CEIL = 99;

export const Z_NONE = 0, Z_A = 1, Z_B = 2, Z_TSPAWN = 3, Z_CTSPAWN = 4;

export const MATS = ['sand', 'pavers', 'limestone', 'plaster_tan', 'door', 'crate', 'container', 'tiles', 'plaster_cream',
  'brick', 'cobble', 'plaster_orange', 'stone', 'van', 'car', 'sandbag', 'wood', 'roof', 'trim_blue', 'dirt', 'plaster_white', 'door_blue',
  'plaster_ochre', 'plaster_red', 'plaster_blue', 'plaster_pink', 'plaster_green', 'sandstone', 'brick_pale', 'flagstone', 'cobble_warm',
  'tile_cream', 'tile_terra', 'tile_white', 'wood_old', 'crate_hd', 'carton', 'ceil_plain'];
const MI = Object.fromEntries(MATS.map((m, i) => [m, i]));

const DEFS = {
  dust2: {
    name: 'Dust II',
    desc: 'Long A, catwalk, mid doors and B tunnels.',
    trace: dust2Trace, top: 8,
    theme: { floor: 'sand', wall: 'limestone', ceil: 'wood', skyTop: 0x5d8fc9, skyHorizon: 0xe9dcc2, fog: 0xe3d3b4, sun: [0.55, 0.75, 0.38], sunColor: [1.5, 1.32, 1.04], ambient: [0.36, 0.4, 0.5] },
    // Positions read off the radar overlay (public/dev/overlay.html) and matched to the official callouts.
    ceilings: [
      [7, 36, 10, 44, 3.2],    // tunnel exit into B
      [3, 45, 32, 55, 3.2],    // upper tunnels
      [27, 41, 43, 47, 3.0],   // lower tunnels
      [13, 55, 19, 63, 3.2],   // tunnels entrance from outside tunnels
      [71, 62, 78, 75, 3.4],   // long doors passage
      [44, 39, 52, 41, 3.4],   // mid doors
      [23, 23, 27, 29, 3.3],   // B doors
    ],
    paint: [[0, 34, 26, 64, 'stone'], [26, 40, 43, 48, 'stone'], [68, 58, 81, 78, 'plaster_tan'], [40, 36, 56, 44, 'plaster_tan']],
    floors: [[3, 36, 43, 63, 'pavers'], [71, 61, 78, 76, 'pavers'], [44, 38, 52, 42, 'pavers'], [80, 2, 100, 24, 'pavers']],
    boxes: [[72, 79, 79, 88, 'container'], [99, 25, 104, 34, 'car'], [14, 32, 22, 38, 'car']],
    extra: [
      // stairs from outside tunnels (2.45 m) up to the upper tunnels entrance (3.8 m)
      { t: 'slope', x0: 14, z0: 69, x1: 25, z1: 72, bottom: -1, sx: 0, sz: -0.45, a: 3.8 + 0.45 * 69, tex: { top: 'pavers', side: 'stone', bottom: 'nodraw' } },
    ],
    decor: [
      { t: 'doors', axis: 'x', a: 72, b: 78, at: 63, open: 1, mat: 'door_blue' },   // long doors (long side)
      { t: 'doors', axis: 'x', a: 72, b: 78, at: 75.9, open: -1, mat: 'door_blue' },// long doors (outside long side)
      { t: 'doors', axis: 'x', a: 46, b: 51, at: 41.9, open: -1, mat: 'door' },     // mid doors
      { t: 'doors', axis: 'z', a: 24, b: 29, at: 25.5, open: 1, mat: 'door' },      // B doors
      ...[[8, 40], [10, 50], [20, 50], [28, 52], [31, 44], [38, 44], [16, 59], [74, 68]].map(([x, z]) => ({ t: 'lamp', x, z })),
      { t: 'awning', x1: 60, z1: 38, x2: 63, z2: 40, h: 2.7, mat: 'cloth_red' },
      { t: 'awning', x1: 30, z1: 98, x2: 34, z2: 100, h: 2.8, mat: 'cloth_cream' },
    ],
  },
  mirage: {
    name: 'Mirage',
    desc: 'Palace, A ramp, connector, window, B apartments.',
    trace: mirageTrace,   // only used for the radar underlay in the editor
    plan: MIRAGE_PLAN,
    ...MIRAGE_PLAN.LOOK,
  },
  inferno: {
    name: 'Inferno',
    desc: 'Banana, apartments, pit and library.',
    trace: infernoTrace, top: 9,
    theme: { floor: 'cobble', wall: 'plaster_orange', ceil: 'wood', skyTop: 0x6a95c8, skyHorizon: 0xeadfcf, fog: 0xdccdb5, sun: [0.35, 0.7, -0.55], sunColor: [1.5, 1.3, 1.0], ambient: [0.37, 0.39, 0.48] },
    ceilings: [
      [31, 82, 52, 92, 3.2],   // T apartments: upstairs / kitchen
      [50, 74, 57, 88, 3.0],   // underpass (under the bridge)
      [70, 90, 79, 107, 3.2],  // apartments
      [74, 98, 90, 102, 3.2],  // apartments corridor to balcony
      [90, 52, 95, 60, 3.4],   // arch
      [104, 51, 113, 61, 3.4], // library
    ],
    paint: [[40, 2, 80, 32, 'stone'], [28, 78, 56, 110, 'brick'], [68, 86, 98, 110, 'plaster_white'], [100, 48, 116, 64, 'brick']],
    floors: [[31, 82, 52, 92, 'wood'], [70, 90, 90, 107, 'wood'], [104, 51, 113, 61, 'wood'], [44, 6, 66, 30, 'pavers']],
    boxes: [],
    decor: [
      { t: 'tree', x: 63, z: 24 }, { t: 'tree', x: 47, z: 12 }, { t: 'tree', x: 97, z: 32 }, { t: 'tree', x: 106, z: 96 },
      { t: 'tree', x: 40, z: 66 }, { t: 'tree', x: 85, z: 74 },
      { t: 'awning', x1: 60, z1: 64, x2: 64, z2: 66, h: 2.8, mat: 'cloth_red' },
      { t: 'awning', x1: 80, z1: 66, x2: 84, z2: 68, h: 2.8, mat: 'cloth_blue' },
      ...[[40, 86], [48, 86], [74, 95], [84, 100], [107, 56], [92, 56], [53, 80]].map(([x, z]) => ({ t: 'lamp', x, z })),
    ],
  },
};

export const MAP_IDS = Object.keys(DEFS);
export const MAP_INFO = MAP_IDS.map(id => ({ id, name: DEFS[id].name, desc: DEFS[id].desc }));

const gridCache = {};
const worldCache = {};

// ---------------------------------------------------------------- height grid (from the radar trace + overrides)
function buildGridMap(id) {
  if (gridCache[id]) return gridCache[id];
  const d = DEFS[id], tr = d.trace;
  const w = tr.w, h = tr.h, N = w * h;
  const solid = new Uint8Array(N).fill(1);
  const fh = new Float32Array(N), gx = new Float32Array(N), gz = new Float32Array(N);
  const ceil = new Float32Array(N).fill(NO_CEIL);
  const top = new Float32Array(N).fill(d.top);
  const fmat = new Uint8Array(N).fill(MI[d.theme.floor]);
  const wmat = new Uint8Array(N).fill(MI[d.theme.wall]);
  const box = new Uint8Array(N);
  const each = (r, fn) => {
    for (let z = Math.max(0, r[1]); z <= Math.min(h - 1, r[3]); z++)
      for (let x = Math.max(0, r[0]); x <= Math.min(w - 1, r[2]); x++) fn(z * w + x, x, z);
  };
  for (let z = 0; z < h; z++) for (let x = 0; x < w; x++) {
    const ch = tr.rows[z][x], i = z * w + x;
    if (ch === '#') continue;
    solid[i] = 0;
    fh[i] = (ch.charCodeAt(0) - 48) / 10;
    if (tr.crates[z][x] === 'c') { fmat[i] = MI.crate; box[i] = 1; }
  }
  const stair = new Uint8Array(N), under = new Float32Array(N).fill(-1);
  if (d.levels) {
    for (const r of d.levels.notBoxes) each(r, (i) => { box[i] = 0; fmat[i] = MI[d.theme.floor]; });
    applyLevels(d, { w, h, solid, fh, box, each });
  }
  // smooth ground: corners average the neighbours on the same level; ledges stay sharp
  const flatCell = (j) => !solid[j] && !box[j];
  for (let z = 0; z < h; z++) for (let x = 0; x < w; x++) {
    const i = z * w + x;
    if (solid[i]) continue;
    const c = [0, 0, 0, 0];
    for (let v = 0; v < 2; v++) for (let u = 0; u < 2; u++) {
      let sum = fh[i], n = 1;
      if (flatCell(i)) {
        for (let dz = v - 1; dz <= v; dz++) for (let dx = u - 1; dx <= u; dx++) {
          if (!dx && !dz) continue;
          const nx = x + dx, nz = z + dz;
          if (nx < 0 || nz < 0 || nx >= w || nz >= h) continue;
          const j = nz * w + nx;
          // neighbours up to 0.9 m apart blend into a slope: the radar can't show stairs, so small
          // height jumps between cells are really stairs/ramps. Taller ledges and boxes stay sharp.
          if (flatCell(j) && Math.abs(fh[j] - fh[i]) <= 0.9) { sum += fh[j]; n++; }
        }
      }
      c[v * 2 + u] = sum / n;
    }
    fh[i] = (c[0] + c[1] + c[2] + c[3]) / 4;
    gx[i] = ((c[1] + c[3]) - (c[0] + c[2])) / 2;
    gz[i] = ((c[2] + c[3]) - (c[0] + c[1])) / 2;
    if (Math.abs(gx[i]) < 0.04) gx[i] = 0;
    if (Math.abs(gz[i]) < 0.04) gz[i] = 0;
  }
  if (d.levels) {
    // staircases are drawn step by step in gridToSource, tunnels get their floor and roof there too
    for (const [x1, z1, x2, z2, axis, a, b] of d.levels.stairs) each([x1, z1, x2, z2], (i, x, z) => {
      solid[i] = 0; stair[i] = 1; box[i] = 0; gx[i] = gz[i] = 0;
      const t = axis === 'x' ? (x + 0.5 - x1) / (x2 + 1 - x1) : (z + 0.5 - z1) / (z2 + 1 - z1);
      fh[i] = d.levelY(a + (b - a) * t);
    });
    for (const [x1, z1, x2, z2, u, clear] of d.levels.tunnels) each([x1, z1, x2, z2], (i) => { under[i] = d.levelY(u) + clear; });
  }
  for (const [x1, z1, x2, z2, clear] of d.ceilings) {
    let hi = -Infinity;
    each([x1, z1, x2, z2], (i) => { if (!solid[i] && !box[i]) hi = Math.max(hi, fh[i] + Math.abs(gx[i]) + Math.abs(gz[i])); });
    each([x1, z1, x2, z2], (i) => { if (!solid[i]) ceil[i] = Math.max(hi + clear * 0.75, fh[i] + clear); });
  }
  for (const [x1, z1, x2, z2, mat, t] of d.paint) each([x1, z1, x2, z2], (i) => { if (solid[i]) { wmat[i] = MI[mat]; if (t) top[i] = t; } });
  for (const [x1, z1, x2, z2, mat] of d.floors) each([x1, z1, x2, z2], (i) => { if (!solid[i] && !box[i]) fmat[i] = MI[mat]; });
  for (const [x1, z1, x2, z2, mat] of d.boxes || []) each([x1, z1, x2, z2], (i) => { if (box[i]) fmat[i] = MI[mat]; });
  for (let z = 0; z < h; z++) for (let x = 0; x < w; x++) {
    const i = z * w + x;
    if (!solid[i]) continue;
    let mx = 0;
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = x + dx, nz = z + dz;
      if (nx < 0 || nz < 0 || nx >= w || nz >= h) continue;
      const j = nz * w + nx;
      if (!solid[j]) mx = Math.max(mx, ceil[j] < NO_CEIL ? ceil[j] + 0.6 : fh[j] + 3.5);
    }
    top[i] = Math.max(top[i], mx);
  }
  const zr = { ...tr.zones, ...(d.zones || {}) };
  const g = { w, h, solid, fh, gx, gz, ceil, top, fmat, wmat, box, stair, under, zoneRects: zr };
  gridCache[id] = g;
  return g;
}

// Replace the radar's height guesses with the measured tables of a map that has them (see mapdata/mirage-levels.js).
function applyLevels(d, { w, solid, fh, box, each }) {
  const L = d.levels, Y = d.levelY, N = fh.length;
  const raw = Float32Array.from(fh), crate = Uint8Array.from(box);
  for (let i = 0; i < N; i++) if (!solid[i]) fh[i] = Y(d.calibrate(raw[i]));
  for (const r of L.notBoxes) each(r, (i) => { raw[i] = 0; });   // props there are placed by hand instead
  for (const r of L.flats) {
    // the area's usual radar height: anything well above it is a box or ledge standing on this floor
    const counts = new Map();
    each(r, (i) => { if (!solid[i] && !crate[i] && raw[i] > 0) { const k = Math.round(raw[i] * 10); counts.set(k, (counts.get(k) || 0) + 1); } });
    let ref = Infinity, best = 0;
    for (const [k, c] of counts) if (c > best) { best = c; ref = k / 10; }
    each(r, (i) => {
      if (solid[i]) return;
      const rise = raw[i] - ref;
      if (rise > 0.3) { fh[i] = Y(r[4]) + rise; box[i] = 1; } else if (!crate[i]) { fh[i] = Y(r[4]); box[i] = 0; }
    });
  }
  for (const [x1, z1, x2, z2, axis, a, b] of L.ramps) each([x1, z1, x2, z2], (i, x, z) => {
    if (solid[i]) return;
    const t = axis === 'x' ? (x + 0.5 - x1) / (x2 + 1 - x1) : (z + 0.5 - z1) / (z2 + 1 - z1);
    fh[i] = Y(a + (b - a) * t); box[i] = 0;
  });
  // crates keep their height above the floor beside them
  for (let i = 0; i < N; i++) {
    if (solid[i] || !crate[i]) continue;
    for (const j of [i - 1, i + 1, i - w, i + w, i - 2, i + 2, i - 2 * w, i + 2 * w]) {
      if (j < 0 || j >= N || solid[j] || box[j]) continue;
      if (fh[i] < fh[j] + 0.3) fh[i] = fh[j] + Math.max(0.5, Math.min(1.4, raw[i] - raw[j]));
      break;
    }
  }
  for (const r of L.fill) each(r, (i) => { solid[i] = 1; });
}

// Greedy rectangle merge over cells that share a key (classic "greedy meshing").
function greedyRects(w, h, keyOf) {
  const used = new Uint8Array(w * h), rects = [];
  for (let z = 0; z < h; z++) for (let x = 0; x < w; x++) {
    const i = z * w + x;
    if (used[i]) continue;
    const k = keyOf(i);
    if (k === null) continue;
    let x2 = x;
    while (x2 + 1 < w && !used[z * w + x2 + 1] && keyOf(z * w + x2 + 1) === k) x2++;
    let z2 = z;
    outer: while (z2 + 1 < h) {
      for (let xx = x; xx <= x2; xx++) { const j = (z2 + 1) * w + xx; if (used[j] || keyOf(j) !== k) break outer; }
      z2++;
    }
    for (let zz = z; zz <= z2; zz++) for (let xx = x; xx <= x2; xx++) used[zz * w + xx] = 1;
    rects.push({ x, z, x2, z2, i, k });
  }
  return rects;
}

// Convert the height grid into brushes (serializable map source).
function gridToSource(id) {
  const d = DEFS[id];
  if (d.plan) return buildPlan({ ...d.plan, size: [d.trace.w, d.trace.h] });
  const g = buildGridMap(id), th = d.theme;
  const { w, h } = g;
  const brushes = [];
  const q = (v, s = 0.05) => Math.round(v / s) * s;
  // walls: tall boxes, bottom just below the lowest neighbouring floor
  for (const r of greedyRects(w, h, (i) => (g.solid[i] && !g.stair[i] ? `${q(g.top[i], 0.1)}|${g.wmat[i]}|${g.under[i]}` : null))) {
    let lo = Infinity;
    for (let z = r.z - 1; z <= r.z2 + 1; z++) for (let x = r.x - 1; x <= r.x2 + 1; x++) {
      if (x < 0 || z < 0 || x >= w || z >= h) continue;
      const j = z * w + x;
      if (!g.solid[j]) lo = Math.min(lo, g.fh[j] - Math.abs(g.gx[j]) - Math.abs(g.gz[j]));
    }
    // a map with lower levels needs its walls to reach all the way down
    const bottom = d.levels ? (g.under[r.i] >= 0 ? g.under[r.i] : -1) : (lo === Infinity ? 0 : lo) - 0.3;
    const m = MATS[g.wmat[r.i]], overTunnel = g.under[r.i] >= 0;
    // walls above a tunnel can't be flagged as walls: navigation stops looking for floors below a wall
    brushes.push({ t: 'box', min: [r.x, bottom, r.z], max: [r.x2 + 1, q(g.top[r.i], 0.1), r.z2 + 1], tex: { top: d.levels ? 'flagstone' : m, side: m, bottom: overTunnel ? 'ceil_plain' : 'nodraw' }, wall: overTunnel ? undefined : true });
  }
  // floors: flat slabs (merged) and sloped cells (merged when they share a plane)
  const keyFloor = (i) => {
    if (g.solid[i] || g.stair[i]) return null;
    const m = g.fmat[i];
    if (!g.gx[i] && !g.gz[i]) return `f|${q(g.fh[i])}|${m}|${g.box[i]}|${g.under[i]}`;
    const cx = i % w + 0.5, cz = Math.floor(i / w) + 0.5;
    const a = g.fh[i] - g.gx[i] * cx - g.gz[i] * cz;
    return `s|${q(g.gx[i], 0.02)}|${q(g.gz[i], 0.02)}|${q(a, 0.1)}|${m}|${g.under[i]}`;
  };
  for (const r of greedyRects(w, h, keyFloor)) {
    const i = r.i, m = MATS[g.fmat[i]];
    const isBox = !!g.box[i];
    const side = isBox ? m : (m === 'stone' ? 'stone' : th.wall);
    const floorBottom = g.under[i] >= 0 ? g.under[i] : -1;
    const tex = { top: m, side, bottom: g.under[i] >= 0 ? 'ceil_plain' : 'nodraw' };
    if (r.k.startsWith('f')) {
      brushes.push({ t: 'box', min: [r.x, floorBottom, r.z], max: [r.x2 + 1, q(g.fh[i]), r.z2 + 1], tex, box: isBox || undefined });
    } else {
      // plane through the first cell, shared by the merged cells
      const cx = i % w + 0.5, cz = Math.floor(i / w) + 0.5;
      const sx = g.gx[i], sz = g.gz[i], a = g.fh[i] - sx * cx - sz * cz;
      brushes.push({ t: 'slope', x0: r.x, z0: r.z, x1: r.x2 + 1, z1: r.z2 + 1, bottom: floorBottom, a, sx, sz, tex });
    }
  }
  if (d.levels) {
    // staircases: individual steps of about 19 cm (players step up to 45 cm)
    const stepTex = { top: 'flagstone', side: 'sandstone', bottom: 'nodraw' };
    for (const [x1, z1, x2, z2, axis, a, b] of d.levels.stairs) {
      const ya = d.levelY(a), yb = d.levelY(b), n = Math.max(2, Math.round(Math.abs(yb - ya) / 0.19));
      const start = axis === 'x' ? x1 : z1, run = (axis === 'x' ? x2 - x1 : z2 - z1) + 1;
      for (let k = 0; k < n; k++) {
        const s0 = start + run * k / n, s1 = start + run * (k + 1) / n, y = q(ya + (yb - ya) * (k + 0.5) / n, 0.01);
        brushes.push(axis === 'x'
          ? { t: 'box', min: [s0, -1, z1], max: [s1, y, z2 + 1], tex: stepTex }
          : { t: 'box', min: [x1, -1, s0], max: [x2 + 1, y, s1], tex: stepTex });
      }
    }
    // tunnels: the floor (the floors and walls above already end at the tunnel's ceiling height)
    for (const [x1, z1, x2, z2, u] of d.levels.tunnels)
      brushes.push({ t: 'box', min: [x1, -1, z1], max: [x2 + 1, d.levelY(u), z2 + 1], tex: { top: 'tile_terra', side: 'brick_pale', bottom: 'nodraw' } });
  }
  // roofs: slabs over covered cells
  for (const r of greedyRects(w, h, (i) => (!g.solid[i] && g.ceil[i] < NO_CEIL ? `${q(g.ceil[i], 0.1)}|${q(Math.max(g.top[i], g.ceil[i] + 1.2), 0.1)}` : null))) {
    const c = q(g.ceil[r.i], 0.1), t = q(Math.max(g.top[r.i], g.ceil[r.i] + 1.2), 0.1);
    brushes.push({ t: 'box', min: [r.x, c, r.z], max: [r.x2 + 1, t, r.z2 + 1], tex: { top: 'roof', side: th.wall, bottom: th.ceil }, roof: true });
  }
  // hand-placed fix-up brushes (stairs the radar can't show, etc.)
  for (const b of d.extra || []) brushes.push(structuredClone(b));
  const zones = {};
  for (const [k, r] of Object.entries(g.zoneRects)) zones[k] = [r[0], r[1], r[2] + 1, r[3] + 1];
  // lights: hang one under every lamp decoration (point lights are baked into the lightmaps)
  const lights = (d.decor || []).filter(o => o.t === 'lamp').map(o => ({ x: o.x + 0.5, z: o.z + 0.5, color: [1.0, 0.85, 0.6], radius: 7, intensity: 1.4 }));
  return { version: 1, size: [w, h], brushes, zones, decor: d.decor || [], lights };
}

// ---------------------------------------------------------------- the world object used by the game
// Map source = { size:[w,h], brushes:[...], zones:{A,B,T,CT:[x1,z1,x2,z2]}, decor:[...], lights:[...] }
export function getMapSource(id) {
  if (!DEFS[id]) id = MAP_IDS[0];
  // a save of the hand-built map uses other coordinates: it stays on file but doesn't apply to an imported map
  if (REAL[id]) return EDITS[id] && EDITS[id].real ? EDITS[id] : getOriginalSource(id);
  return EDITS[id] && !EDITS[id].real ? EDITS[id] : getOriginalSource(id);
}

// Maps imported from the host's own CS2 install (tools/import-cs2.mjs). Not part of the project; they replace the hand-built version.
const REAL = {};
export function registerRealMap(id, meta, collision) {
  if (!DEFS[id]) return;
  const n = meta.triCount;
  REAL[id] = { meta, mesh: buildMeshIndex(new Float32Array(collision, 0, n * 9), new Uint8Array(collision, n * 36, n)) };
  delete worldCache[id];
}
export function isRealMap(id) { return !!REAL[id]; }
export function realMesh(id) { return REAL[id] ? REAL[id].mesh : null; }

export function getMap(id) {
  if (!DEFS[id]) id = MAP_IDS[0];
  if (worldCache[id]) return worldCache[id];
  const map = buildWorldFromSource(id, getMapSource(id));
  worldCache[id] = map;
  return map;
}

// Replace (or with null, remove) the saved editor version of a map.
export function setMapEdit(id, src) {
  if (!DEFS[id]) throw new Error('unknown map');
  if (src) validateSource(src);
  if (src) EDITS[id] = src; else delete EDITS[id];
  delete worldCache[id];
}
export function getAllEdits() { return EDITS; }
export function isEdited(id) { return !!EDITS[id] && !!EDITS[id].real === !!REAL[id]; }
export function getRadarInfo(id) { return REAL[id] ? REAL[id].meta.radar : DEFS[id] && DEFS[id].trace ? DEFS[id].trace.radar : null; }
export function getTheme(id) { return (DEFS[id] || DEFS[MAP_IDS[0]]).theme; }
// The original (traced) version of a map, ignoring any editor save.
export function getOriginalSource(id) {
  if (REAL[id]) { const m = REAL[id].meta; return { version: 1, real: true, size: m.size, brushes: [], zones: m.zones, decor: [], lights: [] }; }
  return gridToSource(id);
}

export function validateSource(src) {
  if (!src || !Array.isArray(src.brushes) || !src.zones || !Array.isArray(src.size)) throw new Error('bad map data');
  if (src.brushes.length > 20000) throw new Error('too many brushes');
  for (const k of ['A', 'B', 'T', 'CT']) if (!Array.isArray(src.zones[k]) || src.zones[k].length !== 4) throw new Error('missing zone ' + k);
  for (const b of src.brushes) {
    const nums = b.t === 'box' ? [...b.min, ...b.max] : b.t === 'slope' ? [b.x0, b.z0, b.x1, b.z1, b.bottom, b.a, b.sx, b.sz] : b.t === 'prism' ? [...b.pts.flat(), b.bottom, b.top] : null;
    if (!nums || nums.some(v => typeof v !== 'number' || !isFinite(v))) throw new Error('bad brush');
  }
}

export function makeBrushFromSource(b) {
  const flags = { box: !!b.box, clip: !!b.clip, noshoot: !!b.clip, roof: !!b.roof, wall: !!b.wall };
  if (b.t === 'prism') return prismBrush(b.pts, b.bottom, b.top, b.plane, b.tex, flags);
  if (b.t === 'slope') return slopeBrush(b.x0, b.z0, b.x1, b.z1, b.bottom, b.a, b.sx, b.sz, b.tex, flags);
  return boxBrush(b.min, b.max, b.tex, flags);
}

export function buildWorldFromSource(id, src) {
  const d = DEFS[id] || DEFS[MAP_IDS[0]];
  const brushes = src.brushes.map(makeBrushFromSource);
  const [w, h] = src.size;
  const map = {
    id, name: d.name, theme: d.theme, w, h, source: src, brushes, grid: buildGrid(brushes),
    zoneRects: src.zones, decor: src.decor || [], lights: src.lights || [], version: hashSource(src),
  };
  map.bounds = { min: [0, -2, 0], max: [w, 40, h] };
  if (REAL[id]) {
    map.mesh = REAL[id].mesh; map.real = REAL[id].meta;
    map.theme = { ...d.theme, sun: map.real.sun };
    map.version += map.real.hash;
  }
  map.siteCenter = { A: rectCenter(map, src.zones.A), B: rectCenter(map, src.zones.B) };
  map.spawns = map.real ? map.real.spawns : { T: spawnPoints(map, src.zones.T), CT: spawnPoints(map, src.zones.CT) };
  return map;
}

function hashSource(src) {
  const s = JSON.stringify(src);
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0).toString(36) + s.length.toString(36);
}

function rectCenter(map, r) {
  const x = (r[0] + r[2]) / 2, z = (r[1] + r[3]) / 2;
  const y = floorAt(map, x, z);
  return { x, z, y: isNaN(y) ? 0 : y };
}

// Up to 10 spread-out standing spots inside a zone rect.
function spawnPoints(map, r) {
  const pts = [];
  const cand = [];
  for (let z = r[1] + 0.5; z < r[3]; z += 1.5) for (let x = r[0] + 0.5; x < r[2]; x += 1.5) cand.push([x, z]);
  for (const [x, z] of cand) {
    const y = floorAt(map, x, z);
    if (y < -1 || isNaN(y)) continue;
    if (boxBlocked(map, x, y + 0.02, z, 0.4, 1.8)) continue;
    pts.push({ x, y, z });
  }
  if (pts.length <= 10) return pts.length ? pts : [{ x: (r[0] + r[2]) / 2, y: floorAt(map, (r[0] + r[2]) / 2, (r[1] + r[3]) / 2), z: (r[1] + r[3]) / 2 }];
  const out = [], step = pts.length / 10;
  for (let k = 0; k < 10; k++) out.push(pts[Math.floor(k * step)]);
  return out;
}

// Highest floor at (x, z) seen from the sky (ignores roofs above standing height is not attempted).
export function floorAt(map, x, z, fromY = 40) {
  // a thin ray on imported maps: it passes through the invisible player-clip ceiling
  const tr = trace(map, [x, fromY, z], [x, -5, z], map.mesh ? [0, 0, 0] : [0.05, 0.01, 0.05]);
  // skip roofs: if we land on a roof slab, look below it
  if (tr.fraction < 1 && tr.brush) {
    const b = tr.brush;
    if (b.flags.roof) return floorAt(map, x, z, b.min[1] - 0.05);
    if (b.flags.wall) return NaN;            // inside a wall column: no floor here
    return tr.end[1] - 0.01;
  }
  return -5;
}

export function zoneAt(map, x, z) {
  const zr = map.zoneRects;
  const inR = (r) => r && x >= r[0] && x < r[2] && z >= r[1] && z < r[3];
  if (inR(zr.A)) return Z_A;
  if (inR(zr.B)) return Z_B;
  if (inR(zr.T)) return Z_TSPAWN;
  if (inR(zr.CT)) return Z_CTSPAWN;
  return Z_NONE;
}
