// Converts layouts exported from your own CS2 install (see README) into files the game loads.
// They are written to your home folder (StrikeLiteMaps), outside the project, so they never get published.
// Usage: node --max-old-space-size=6000 tools/import-cs2.mjs mirage [D:\CS2Extract]
import fs from 'node:fs';
import path from 'node:path';
import { buildMeshIndex, trace } from '../shared/brush.js';
import { realMapsDir } from '../shared/realmaps-fs.js';

const id = process.argv[2] || 'mirage', dir = process.argv[3] || 'D:\\CS2Extract';
const CFG = {
  mirage: {
    name: 'de_mirage', ox: 3300, oy: 1800, oz: 369, size: [136, 123],
    sites: { A: [-658, -382, -2339, -2103], B: [-2192, -1878, 102, 417] },  // x1, x2, y1, y2 in game units
    radar: { file: 'de_mirage_radar_psd.png', pxPerCell: 7.874, x0: -14, y0: -17.4 },
  },
}[id];
if (!CFG) throw new Error('no import settings for ' + id);
const U = 0.0254;
const X = (ux) => (ux + CFG.ox) * U, Z = (uy) => (CFG.oy - uy) * U, Y = (uz) => (uz + CFG.oz) * U + 0.5;
const [W, H] = CFG.size, keep = (x, y, z) => x > -3 && x < W + 3 && z > -3 && z < H + 3 && y > -6 && y < 45;

function readGlb(file) {
  const b = fs.readFileSync(file), jl = b.readUInt32LE(12), j = JSON.parse(b.toString('utf8', 20, 20 + jl)), bin = 20 + jl + 8;
  const acc = (i) => {
    const a = j.accessors[i], v = j.bufferViews[a.bufferView], off = bin + (v.byteOffset || 0) + (a.byteOffset || 0);
    const n = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 }[a.type];
    const ab = b.buffer.slice(b.byteOffset + off, b.byteOffset + off + a.count * n * (a.componentType === 5126 || a.componentType === 5125 ? 4 : 2));
    return a.componentType === 5126 ? new Float32Array(ab) : a.componentType === 5125 ? new Uint32Array(ab) : new Uint16Array(ab);
  };
  return { j, acc };
}
// exported coordinates are metres with gl x = source y, gl y = source z, gl z = source x
const GX = (g) => g[2] + CFG.ox * U, GY = (g) => g[1] + CFG.oz * U + 0.5, GZ = (g) => CFG.oy * U - g[0];
const apply = (m, x, y, z) => [m[0] * x + m[4] * y + m[8] * z + m[12], m[1] * x + m[5] * y + m[9] * z + m[13], m[2] * x + m[6] * y + m[10] * z + m[14]];

// ---------------------------------------------------------------- collision
const SKIP = /grenadeclip|physics_sky|ladder|trigger/, NOSHOOT = /playerclip|passbullets/;
const tris = [], flags = [], names = {};
for (const file of [`${CFG.name.replace('de_', '')}_physics.glb`, `${CFG.name.replace('de_', '')}_world_physics.glb`]) {
  const p = path.join(dir, file);
  if (!fs.existsSync(p)) continue;
  const { j, acc } = readGlb(p);
  for (const n of j.nodes) {
    if (n.mesh === undefined) continue;
    const m = n.matrix || [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1], name = n.name || j.meshes[n.mesh].name;
    names[file + ':' + name] = (names[file + ':' + name] || 0) + 1;
    if (SKIP.test(name)) continue;
    // placed objects: boxes, crates and doors are solid; zones, volumes and retake-mode walls (surface "default") are not
    if (file.includes('_world_') && (!/^(func_brush|prop_physics_multiplayer|prop_dynamic(_override)?)$/.test(name) || n.extras?.SurfaceProperty === 'default')) continue;
    for (const pr of j.meshes[n.mesh].primitives) {
      const pos = acc(pr.attributes.POSITION), idx = pr.indices !== undefined ? acc(pr.indices) : null, cnt = idx ? idx.length : pos.length / 3;
      for (let t = 0; t + 2 < cnt; t += 3) {
        const q = [0, 1, 2].map(k => { const i = idx ? idx[t + k] : t + k, g = apply(m, pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]); return [GX(g), GY(g), GZ(g)]; });
        if (!q.some(v => keep(v[0], v[1], v[2]))) continue;
        const a = q[0], b = q[1], c = q[2], ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2], vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
        if (Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx) < 1e-5) continue;
        tris.push(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2]);
        flags.push(NOSHOOT.test(name) ? 1 : 0);
      }
    }
  }
}
const colTris = new Float32Array(tris), colFlags = new Uint8Array(flags);
console.log('collision triangles', colFlags.length, Object.keys(names).filter(k => k.includes('_world_')).slice(0, 40));
const mesh = buildMeshIndex(colTris, colFlags), world = { grid: { cells: new Map(), stamp: 0 }, mesh };

// ---------------------------------------------------------------- visible world
// First match wins: specific surfaces before broad words like "wall" and short ones like "car".
const WD = (w) => new RegExp('(^|_)(' + w + ')(\\d|_|[a-z]?$)');
const TEX = [
  [/branch|leaf|flower|bush|plant|ivy/, 'leaf'], [/bark|trunk/, 'bark'], [/black_simple/, 'dark'], [/cable|wire|telephone_pole|rope/, 'dark'],
  [/lamp|bulb|sheetmetal|corrugated|metal/, 'metal'], [/blacktop|sand_|_sand/, 'sand'],
  [/woodfloor|wood|plywood|hut|bench|table|chair|furniture|shelving|cabinet|wagon|cart/, 'wood_old'],
  [/ground|tile|floor|marble|_flr|milflr/, 'flagstone'], [/brick/, 'brick_pale'], [/curb|stone|step|cinder|rock|debris/, 'stone'],
  [/plaster_blue/, 'plaster_blue'], [/salmon|pink/, 'plaster_pink'], [/yellow/, 'plaster_ochre'], [/window|stucco/, 'plaster_cream'],
  [/door/, 'door'], [/crate|pallet/, 'crate_hd'], [/cloth|tarp|awning|overhang|couch|sofa|pillow|rug|hazard|ribbon/, 'cloth'], [/claypot|pot\d/, 'clay'],
  [/plaster|wall|arch|_ver\d|trim|tower|chimney|concrete|beam|rooftop/, 'sandstone'],
  [WD('fence|gate|tanks?|artillery|cannon|ammo|pipe\\w*|pi_apc|apc|airconditioner|electrical|streetlight|light\\w*|rail\\w*|railing\\w*|roof_dish|dish|scaffolding|barrel|trash\\w*|bin|boxes|box|ladder\\w*|mkt_container|powerbox|bus|van|car|4carz|hammer|tv|fan|tools?|garbage\\w*|food\\w*|bottle|cup|chiller|grocerystorechiller'), 'metal'],
  [/fence|gate|tank|artillery|cannon|ammo|pipe|apc|airconditioner|electrical|streetlight|railing|scaffold|barrel|trash|ladder|container|powerbox|bus01|van1|4carz|garbage|food|bottle|chiller|ceiling_fan|cash_?register|tv/, 'metal'],
];
const texOf = (name) => { for (const [re, t] of TEX) if (re.test(name)) return t; return 'sandstone'; };
const stem = (s) => s.toLowerCase().replace(/^n\d+_lr\d+_/, '').replace(/^agg_merge_/, '');

const { j, acc } = readGlb(path.join(dir, `${CFG.name.replace('de_', '')}_world.glb`));
const groups = new Map(), CH = 32;
// Not solid surfaces in CS2: light-blocking panels, huge haze cards, see-through fence and puddle sheets, retake-mode markers,
// and decals that only make sense with their real textures. Everything else in the export is real, so it stays.
const HIDDEN = /_s_cb_bl_|_nomerge\d+_(dust_002|metalfence|urban_puddle)|_s_mesh_overlay|retake_/;
const seenTris = new Set(), K = (v) => `${Math.round(v.p[0] * 200)},${Math.round(v.p[1] * 200)},${Math.round(v.p[2] * 200)}`;
let total = 0, skipped = 0, dupes = 0;
for (const n of j.nodes) {
  if (n.mesh === undefined) continue;
  const name = stem(n.name || j.meshes[n.mesh].name);
  if (HIDDEN.test(n.name || j.meshes[n.mesh].name)) { skipped++; continue; }
  if (/toolsblock|nodraw|skybox|_lod[1-9]/.test(name)) { skipped++; continue; }
  const m = n.matrix || [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1], tex = texOf(name);
  const L = Math.hypot(m[0], m[1], m[2]) || 1;
  for (const pr of j.meshes[n.mesh].primitives) {
    const pos = acc(pr.attributes.POSITION), nor = pr.attributes.NORMAL !== undefined ? acc(pr.attributes.NORMAL) : null, idx = pr.indices !== undefined ? acc(pr.indices) : null;
    const cnt = idx ? idx.length : pos.length / 3, world0 = new Map();
    const vert = (i) => {
      let v = world0.get(i);
      if (v) return v;
      const g = apply(m, pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]);
      let nn = [0, 1, 0];
      if (nor) { const a = nor[i * 3], b = nor[i * 3 + 1], c = nor[i * 3 + 2], w = [m[0] * a + m[4] * b + m[8] * c, m[1] * a + m[5] * b + m[9] * c, m[2] * a + m[6] * b + m[10] * c]; nn = [w[2] / L, w[1] / L, -w[0] / L]; }
      v = { p: [GX(g), GY(g), GZ(g)], n: nn, id: {} };
      world0.set(i, v);
      return v;
    };
    for (let t = 0; t + 2 < cnt; t += 3) {
      const a = vert(idx ? idx[t] : t), b = vert(idx ? idx[t + 1] : t + 1), c = vert(idx ? idx[t + 2] : t + 2);
      const cx = (a.p[0] + b.p[0] + c.p[0]) / 3, cy = (a.p[1] + b.p[1] + c.p[1]) / 3, cz = (a.p[2] + b.p[2] + c.p[2]) / 3;
      if (!keep(cx, cy, cz)) continue;
      // the same triangle twice (double-sided surfaces) flickers against itself
      const tk = [K(a), K(b), K(c)].sort().join('|');
      if (seenTris.has(tk)) { dupes++; continue; }
      seenTris.add(tk);
      const key = `${tex}|${Math.floor(cx / CH)}|${Math.floor(cz / CH)}`;
      let g = groups.get(key);
      if (!g) groups.set(key, g = { tex, map: [new Map(), new Map(), new Map()], verts: [], axes: [], idx: [] });
      // one texture direction per face: a corner shared by faces pointing different ways gets one vertex each, or the texture smears
      const ux = b.p[0] - a.p[0], uy = b.p[1] - a.p[1], uz = b.p[2] - a.p[2], wx = c.p[0] - a.p[0], wy = c.p[1] - a.p[1], wz = c.p[2] - a.p[2];
      const fx = Math.abs(uy * wz - uz * wy), fy = Math.abs(uz * wx - ux * wz), fz = Math.abs(ux * wy - uy * wx), ax = fy >= fx && fy >= fz ? 1 : fx >= fz ? 0 : 2;
      for (const v of [a, b, c]) {
        const m = g.map[ax];
        let k = m.get(v);
        if (k === undefined) { k = g.verts.length; m.set(v, k); g.verts.push(v); g.axes.push(ax); }
        g.idx.push(k);
      }
      total++;
    }
  }
}
console.log('visible triangles', total, 'groups', groups.size, 'skipped nodes', skipped, 'duplicates', dupes);

// ---------------------------------------------------------------- ambient occlusion per vertex: short rays against the collision shape
const DIRS = [[0, 1, 0], [0.7, 0.7, 0], [-0.7, 0.7, 0], [0, 0.7, 0.7], [0, 0.7, -0.7], [0.6, 0.2, 0.6], [-0.6, 0.2, 0.6], [0.6, 0.2, -0.6], [-0.6, 0.2, -0.6]];
const ao = (v) => {
  const o = [v.p[0] + v.n[0] * 0.08, v.p[1] + v.n[1] * 0.08, v.p[2] + v.n[2] * 0.08];
  let open = 0, all = 0;
  if (v.ao !== undefined) return v.ao;
  for (const d of DIRS) {
    const w = Math.max(0.1, d[0] * v.n[0] + d[1] * v.n[1] + d[2] * v.n[2]);
    if (d[0] * v.n[0] + d[1] * v.n[1] + d[2] * v.n[2] < -0.1) continue;
    all += w;
    const tr = trace(world, o, [o[0] + d[0] * 6, o[1] + d[1] * 6, o[2] + d[2] * 6], [0, 0, 0]);
    open += w * Math.min(1, tr.fraction * 1.3);
  }
  return (v.ao = all ? open / all : 1);
};
const t0 = Date.now();
let vertsTotal = 0, idxTotal = 0, done = 0;
for (const g of groups.values()) { vertsTotal += g.verts.length; idxTotal += g.idx.length; }
const posOut = new Float32Array(vertsTotal * 3), norOut = new Int8Array(vertsTotal * 4), axOut = new Uint8Array(vertsTotal), idxOut = new Uint32Array(idxTotal);
const meta = [];
let vo = 0, io = 0;
for (const g of groups.values()) {
  const v0 = vo, i0 = io;
  for (let q = 0; q < g.verts.length; q++) {
    const v = g.verts[q];
    axOut[vo] = g.axes[q];
    posOut.set(v.p, vo * 3);
    const o = vo * 4, l = Math.hypot(v.n[0], v.n[1], v.n[2]) || 1;
    norOut[o] = v.n[0] / l * 127; norOut[o + 1] = v.n[1] / l * 127; norOut[o + 2] = v.n[2] / l * 127; norOut[o + 3] = Math.round(ao(v) * 127);
    vo++;
    if (++done % 200000 === 0) console.log('occlusion', done, '/', vertsTotal, Math.round((Date.now() - t0) / 1000) + 's');
  }
  idxOut.set(g.idx, io); io += g.idx.length;
  meta.push({ tex: g.tex, v: v0, vc: g.verts.length, i: i0, ic: g.idx.length });
}

// ---------------------------------------------------------------- spawns and sites
const ents = []; let cur = null;
for (const l of fs.readFileSync(path.join(dir, `${CFG.name.replace('de_', '')}_ents.txt`), 'utf8').split(/\r?\n/)) {
  if (/^====\d+====/.test(l)) { cur = {}; ents.push(cur); continue; }
  const m = l.match(/^(\S+)\s+(.*)$/);
  if (cur && m) cur[m[1]] = m[2].replace(/^"|"$/g, '');
}
const vec = (s) => s.replace(/[\[\]]/g, '').trim().split(/[,\s]+/).map(Number);
const spawnsOf = (cls) => ents.filter(e => e.classname === cls && e.enabled !== 'false').sort((a, b) => (+b.priority || 0) - (+a.priority || 0)).map(e => { const o = vec(e.origin); return { x: X(o[0]), y: Y(o[2]), z: Z(o[1]) }; });
const spawns = { T: spawnsOf('info_player_terrorist'), CT: spawnsOf('info_player_counterterrorist') };
const rectOf = (l) => [Math.min(...l.map(p => p.x)) - 2, Math.min(...l.map(p => p.z)) - 2, Math.max(...l.map(p => p.x)) + 2, Math.max(...l.map(p => p.z)) + 2];
const site = ([x1, x2, y1, y2]) => [X(x1), Z(y2), X(x2), Z(y1)];
const sunE = ents.find(e => e.classname === 'light_environment'), [pitch, yaw] = vec(sunE.angles), rp = pitch * Math.PI / 180, ry = yaw * Math.PI / 180;
const f = [Math.cos(rp) * Math.cos(ry), Math.cos(rp) * Math.sin(ry), -Math.sin(rp)];
const out = path.join(realMapsDir(), id);
fs.mkdirSync(out, { recursive: true });
fs.writeFileSync(path.join(out, 'collision.bin'), Buffer.concat([Buffer.from(colTris.buffer), Buffer.from(colFlags.buffer)]));
fs.writeFileSync(path.join(out, 'visual.bin'), Buffer.concat([Buffer.from(posOut.buffer), Buffer.from(norOut.buffer), Buffer.from(axOut.buffer), Buffer.from(idxOut.buffer)]));
const stamp = Date.now().toString(36);
fs.writeFileSync(path.join(out, 'meta.json'), JSON.stringify({
  id, hash: stamp, size: CFG.size, triCount: colFlags.length, zones: { A: site(CFG.sites.A), B: site(CFG.sites.B), T: rectOf(spawns.T), CT: rectOf(spawns.CT) }, spawns,
  sun: [-f[0] * 100, -f[2] * 100, f[1] * 100], radar: CFG.radar, visual: { verts: vertsTotal, idx: idxTotal, groups: meta },
}));
console.log('wrote', out, 'collision MB', (fs.statSync(path.join(out, 'collision.bin')).size / 1e6).toFixed(1), 'visual MB', (fs.statSync(path.join(out, 'visual.bin')).size / 1e6).toFixed(1));
