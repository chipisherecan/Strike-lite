// Renders a brush map the GoldSrc way:
//  1. CSG: every brush face is clipped against the other brushes, so faces hidden inside walls/floors disappear
//     (what qcsg does when a Hammer map is compiled).
//  2. Lightmaps: every visible face gets a grid of light samples ("luxels", 0.5 m apart) with sun shadows,
//     sky light, bounce and point lights (lamps). They are packed into one atlas texture (like qrad + the BSP lighting
//     lump) and cached in the browser so only the first load of a map spends time baking.
//  3. Textures are mapped with world-aligned axes like Hammer's default texture alignment.
//  4. A painted skybox is drawn behind everything.
import * as THREE from 'three';
import { brushPolygons } from '/shared/brush.js';
import { trace } from '/shared/brush.js';
import { floorAt, Z_A, Z_B } from '/shared/maps.js';
import { getNav } from '/shared/nav.js';
import { surfaceTexture, isTextureCached, TEX_SCALE } from './textures.js';

const LUXEL = 0.5;                 // metres between light samples
const ATLAS_W = 1024;
const EPS = 0.002;

// ---------------------------------------------------------------- polygon helpers
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

// Split a polygon by a plane. faceN = the polygon's own normal, used when it lies exactly on the plane:
// a face pointing the same way as the plane is outside (front), a face pointing against it is touching (back).
function splitPoly(poly, n, d, faceN) {
  let onPlane = true;
  for (const a of poly) if (Math.abs(dot(a, n) - d) > EPS) { onPlane = false; break; }
  if (onPlane) return dot(faceN, n) > 0 ? [poly, []] : [[], poly];
  const front = [], back = [];
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length];
    const da = dot(a, n) - d, db = dot(b, n) - d;
    if (da > EPS) front.push(a);
    else if (da < -EPS) back.push(a);
    else { front.push(a); back.push(a); } // on the plane: belongs to both halves
    if ((da > EPS && db < -EPS) || (da < -EPS && db > EPS)) {
      const t = da / (da - db);
      const p = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
      front.push(p); back.push(p);
    }
  }
  return [front, back];
}

// Parts of a convex polygon that lie outside a convex brush.
function subtract(poly, o, faceN) {
  const out = [];
  let rest = poly;
  for (const q of o.planes) {
    const [front, back] = splitPoly(rest, q.n, q.d, faceN);
    if (front.length >= 3 && polyArea(front) > 1e-4) out.push(front);
    rest = back;
    if (rest.length < 3 || polyArea(rest) < 1e-4) return out; // nothing of the polygon is inside this brush
  }
  return out; // whatever is left is inside the brush and gets dropped
}

function polyArea(poly) {
  let x = 0, y = 0, z = 0;
  for (let i = 1; i + 1 < poly.length; i++) {
    const a = poly[0], b = poly[i], c = poly[i + 1];
    const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    x += u[1] * v[2] - u[2] * v[1]; y += u[2] * v[0] - u[0] * v[2]; z += u[0] * v[1] - u[1] * v[0];
  }
  return Math.hypot(x, y, z) / 2;
}

// Texture/lightmap axes like Hammer's world alignment: project onto the plane most facing the normal.
function axesFor(n) {
  const ax = Math.abs(n[0]), ay = Math.abs(n[1]), az = Math.abs(n[2]);
  if (ay >= ax && ay >= az) return { u: [1, 0, 0], v: [0, 0, 1], w: 1 };
  if (ax >= az) return { u: [0, 0, 1], v: [0, -1, 0], w: 0 };
  return { u: [1, 0, 0], v: [0, -1, 0], w: 2 };
}

// ---------------------------------------------------------------- faces (CSG)
export function buildFaces(map) {
  const faces = [];
  const grid = map.grid;
  map.brushes.forEach((b, bi) => {
    if (b.flags.nodraw) return;
    for (const poly of brushPolygons(b)) {
      const p = b.planes[poly.plane];
      if (!p.tex || p.tex === 'nodraw') continue;
      let pieces = [poly.verts];
      // bounding box of the face, slightly grown
      const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
      for (const v of poly.verts) for (let k = 0; k < 3; k++) { mn[k] = Math.min(mn[k], v[k]); mx[k] = Math.max(mx[k], v[k]); }
      const s = ++grid.stamp;
      for (let gx = Math.floor((mn[0] - 0.01) / 4); gx <= Math.floor((mx[0] + 0.01) / 4); gx++)
        for (let gz = Math.floor((mn[2] - 0.01) / 4); gz <= Math.floor((mx[2] + 0.01) / 4); gz++) {
          const list = grid.cells.get(gx * 73856093 ^ gz * 19349663);
          if (!list) continue;
          for (const o of list) {
            if (o.stamp === s || o === b) continue;
            o.stamp = s;
            if (o.flags.clip || o.max[0] < mn[0] - 0.01 || o.min[0] > mx[0] + 0.01 || o.max[1] < mn[1] - 0.01 || o.min[1] > mx[1] + 0.01 || o.max[2] < mn[2] - 0.01 || o.min[2] > mx[2] + 0.01) continue;
            const next = [];
            for (const pc of pieces) next.push(...subtract(pc, o, p.n));
            pieces = next;
            if (!pieces.length) break;
          }
        }
      for (const pc of pieces) if (polyArea(pc) > 1e-3) faces.push({ brush: bi, plane: poly.plane, n: p.n, d: p.d, tex: p.tex, verts: pc });
    }
  });
  return faces;
}

// ---------------------------------------------------------------- lightmaps
function layoutLightmaps(faces) {
  // per face: luxel grid in (s,t) = projections onto its axes, then shelf-pack into the atlas
  let x = 0, y = 0, rowH = 0;
  for (const f of faces) {
    const a = axesFor(f.n);
    f.axes = a;
    let smin = Infinity, smax = -Infinity, tmin = Infinity, tmax = -Infinity;
    f.st = f.verts.map(v => { const s = dot(v, a.u), t = dot(v, a.v); smin = Math.min(smin, s); smax = Math.max(smax, s); tmin = Math.min(tmin, t); tmax = Math.max(tmax, t); return [s, t]; });
    f.smin = Math.floor(smin / LUXEL); f.tmin = Math.floor(tmin / LUXEL);
    f.lw = Math.ceil(smax / LUXEL) - f.smin + 1; f.lh = Math.ceil(tmax / LUXEL) - f.tmin + 1;
    if (x + f.lw > ATLAS_W) { x = 0; y += rowH; rowH = 0; }
    f.ax = x; f.ay = y;
    x += f.lw; rowH = Math.max(rowH, f.lh);
  }
  return y + rowH;
}

// 3D point on the face plane for projected coordinates (s,t)
function pointOnFace(f, s, t) {
  const a = f.axes, n = f.n, p = [0, 0, 0];
  // p = s*u + t*v + w*axisW where the w-coordinate is solved from the plane equation
  for (let k = 0; k < 3; k++) p[k] = s * a.u[k] + t * a.v[k];
  const rest = n[0] * p[0] + n[1] * p[1] + n[2] * p[2];
  p[a.w] = (f.d - rest) / n[a.w];
  return p;
}

// Clamp a 2D point into a convex polygon (so samples near edges don't land inside neighbouring walls)
function clampToPoly(st, poly) {
  let inside = true;
  const area = (() => { let s = 0; for (let i = 0; i < poly.length; i++) { const a = poly[i], b = poly[(i + 1) % poly.length]; s += a[0] * b[1] - b[0] * a[1]; } return s; })();
  const sign = area >= 0 ? 1 : -1;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length];
    if (((b[0] - a[0]) * (st[1] - a[1]) - (b[1] - a[1]) * (st[0] - a[0])) * sign < -1e-6) { inside = false; break; }
  }
  if (inside) return st;
  let best = null, bd = Infinity;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length];
    const ex = b[0] - a[0], ey = b[1] - a[1], l2 = ex * ex + ey * ey || 1;
    const t = Math.max(0, Math.min(1, ((st[0] - a[0]) * ex + (st[1] - a[1]) * ey) / l2));
    const q = [a[0] + ex * t, a[1] + ey * t], d = (q[0] - st[0]) ** 2 + (q[1] - st[1]) ** 2;
    if (d < bd) { bd = d; best = q; }
  }
  // pull slightly inside towards the centroid
  const c = poly.reduce((s, p) => [s[0] + p[0] / poly.length, s[1] + p[1] / poly.length], [0, 0]);
  return [best[0] + (c[0] - best[0]) * 0.02, best[1] + (c[1] - best[1]) * 0.02];
}

function makeLighter(map) {
  const th = map.theme;
  const L = new THREE.Vector3(...th.sun).normalize().toArray();
  const sunC = th.sunColor, amb = th.ambient;
  const ZERO = [0, 0, 0];
  const lights = (map.lights || []).map(l => {
    // hang the light just under the roof (or 2.6 m above the floor when outdoors)
    const fy = floorAt(map, l.x, l.z);
    const up = trace(map, [l.x, (isNaN(fy) ? 0 : fy) + 1, l.z], [l.x, (isNaN(fy) ? 0 : fy) + 6, l.z], ZERO);
    const y = up.fraction < 1 ? up.end[1] - 0.45 : (isNaN(fy) ? 0 : fy) + 2.6;
    return { ...l, y };
  });
  // a fixed spread of sky directions (cosine weighted hemisphere, rotated per normal)
  const SKY = [[0, 1, 0], [0.55, 0.8, 0], [-0.55, 0.8, 0], [0, 0.8, 0.55], [0, 0.8, -0.55]];
  return (p, n) => {
    const o = [p[0] + n[0] * 0.06, p[1] + n[1] * 0.06, p[2] + n[2] * 0.06];
    let r = 0, g = 0, b = 0;
    const ndl = dot(n, L);
    if (ndl > 0) {
      const tr = trace(map, o, [o[0] + L[0] * 90, o[1] + L[1] * 90, o[2] + L[2] * 90], ZERO);
      if (tr.fraction >= 1) { r += sunC[0] * ndl; g += sunC[1] * ndl; b += sunC[2] * ndl; }
    }
    let open = 0, cnt = 0;
    for (const d0 of SKY) {
      // tilt the sky sample towards the surface normal
      const d = [d0[0] + n[0] * 0.8, d0[1] + n[1] * 0.8, d0[2] + n[2] * 0.8];
      const l = Math.hypot(d[0], d[1], d[2]);
      if (d[1] / l < -0.2) continue;
      cnt++;
      const tr = trace(map, o, [o[0] + d[0] / l * 9, o[1] + d[1] / l * 9, o[2] + d[2] / l * 9], ZERO);
      if (tr.fraction >= 1) open += 1; else open += tr.fraction * 0.5;
    }
    const sky = cnt ? open / cnt : 0.3;
    const a = 0.16 + 0.84 * sky;
    r += amb[0] * a + sunC[0] * 0.07 * sky; g += amb[1] * a + sunC[1] * 0.06 * sky; b += amb[2] * a + sunC[2] * 0.04 * sky;
    for (const lt of lights) {
      const dx = lt.x - o[0], dy = lt.y - o[1], dz = lt.z - o[2], dist = Math.hypot(dx, dy, dz);
      if (dist > lt.radius) continue;
      const lambert = (dx * n[0] + dy * n[1] + dz * n[2]) / dist;
      if (lambert <= 0) continue;
      const tr = trace(map, o, [lt.x, lt.y, lt.z], ZERO);
      if (tr.fraction < 0.98) continue;
      const fall = (1 - dist / lt.radius) ** 2 * lt.intensity * lambert;
      r += lt.color[0] * fall; g += lt.color[1] * fall; b += lt.color[2] * fall;
    }
    return [r, g, b];
  };
}

// IndexedDB cache for baked atlases (keyed by map id + version)
function idb() {
  return new Promise((res) => {
    try {
      const rq = indexedDB.open('strikelite-lightmaps', 1);
      rq.onupgradeneeded = () => rq.result.createObjectStore('lm');
      rq.onsuccess = () => res(rq.result);
      rq.onerror = () => res(null);
    } catch { res(null); }
  });
}
async function cacheGet(key) {
  const db = await idb(); if (!db) return null;
  return new Promise((res) => { try { const rq = db.transaction('lm').objectStore('lm').get(key); rq.onsuccess = () => res(rq.result || null); rq.onerror = () => res(null); } catch { res(null); } });
}
async function cachePut(key, val) {
  const db = await idb(); if (!db) return;
  try { db.transaction('lm', 'readwrite').objectStore('lm').put(val, key); } catch { /* ignore */ }
}

// ---------------------------------------------------------------- world build
export async function buildWorld(map, scene, onProgress = () => {}) {
  const faces = buildFaces(map);
  const atlasH = layoutLightmaps(faces);
  const AH = Math.max(4, atlasH);
  const key = `${map.id}:${map.version}:${LUXEL}:v4`;
  let data = await cacheGet(key);
  if (!data || data.length !== ATLAS_W * AH * 4) {
    data = new Uint8Array(ATLAS_W * AH * 4);
    const light = makeLighter(map);
    let done = 0, lastYield = performance.now();
    const total = faces.reduce((s, f) => s + f.lw * f.lh, 0);
    for (const f of faces) {
      for (let j = 0; j < f.lh; j++) for (let i = 0; i < f.lw; i++) {
        const st = clampToPoly([(f.smin + i) * LUXEL, (f.tmin + j) * LUXEL], f.st);
        const c = light(pointOnFace(f, st[0], st[1]), f.n);
        const o = ((f.ay + j) * ATLAS_W + f.ax + i) * 4;
        data[o] = Math.min(255, c[0] * 127); data[o + 1] = Math.min(255, c[1] * 127); data[o + 2] = Math.min(255, c[2] * 127); data[o + 3] = 255;
      }
      done += f.lw * f.lh;
      if (performance.now() - lastYield > 40) { onProgress(done / total); await new Promise(r => setTimeout(r, 0)); lastYield = performance.now(); }
    }
    cachePut(key, data);
  }
  onProgress(1);
  const lmTex = new THREE.DataTexture(data, ATLAS_W, AH, THREE.RGBAFormat);
  lmTex.channel = 1;
  lmTex.magFilter = THREE.LinearFilter; lmTex.minFilter = THREE.LinearFilter;
  lmTex.needsUpdate = true;

  // geometry per texture
  const byTex = new Map();
  for (const f of faces) {
    let g = byTex.get(f.tex);
    if (!g) byTex.set(f.tex, g = { pos: [], uv: [], uv1: [] });
    const scale = TEX_SCALE[f.tex] || 3;
    // make the triangles counter-clockwise when seen from the front (the side the plane normal points to)
    const v0 = f.verts[0], v1 = f.verts[1], v2 = f.verts[2];
    const cr = [(v1[1] - v0[1]) * (v2[2] - v0[2]) - (v1[2] - v0[2]) * (v2[1] - v0[1]), (v1[2] - v0[2]) * (v2[0] - v0[0]) - (v1[0] - v0[0]) * (v2[2] - v0[2]), (v1[0] - v0[0]) * (v2[1] - v0[1]) - (v1[1] - v0[1]) * (v2[0] - v0[0])];
    const flip = dot(cr, f.n) < 0;
    for (let k = 1; k + 1 < f.verts.length; k++) {
      for (const idx of (flip ? [0, k + 1, k] : [0, k, k + 1])) {
        const v = f.verts[idx], st = f.st[idx];
        g.pos.push(v[0], v[1], v[2]);
        g.uv.push(st[0] / scale, -st[1] / scale);
        g.uv1.push((f.ax + st[0] / LUXEL - f.smin + 0.5) / ATLAS_W, (f.ay + st[1] / LUXEL - f.tmin + 0.5) / AH);
      }
    }
  }
  const group = new THREE.Group();
  for (const [tex, g] of byTex) {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(g.pos, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(g.uv, 2));
    geo.setAttribute('uv1', new THREE.Float32BufferAttribute(g.uv1, 2));
    geo.computeBoundingSphere();
    const mat = new THREE.MeshBasicMaterial({ map: surfaceTexture(tex), lightMap: lmTex, lightMapIntensity: 2 * Math.PI });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.matrixAutoUpdate = false;
    group.add(mesh);
  }

  buildDecor(map, group);

  for (const site of ['A', 'B']) {
    const c = map.siteCenter[site];
    const m = new THREE.Mesh(new THREE.PlaneGeometry(5, 5), new THREE.MeshBasicMaterial({ map: letterTexture(site), transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2 }));
    m.rotation.x = -Math.PI / 2;
    m.position.set(c.x, c.y + 0.02, c.z);
    group.add(m);
  }

  scene.add(group);
  scene.background = buildSkybox(map.theme);

  // Model lighting (GoldSrc R_LightPoint): light of the floor under a point, read back from the lightmap
  const faceIndex = new Map();
  for (const f of faces) {
    const k = f.brush * 16 + f.plane;
    if (!faceIndex.has(k)) faceIndex.set(k, []);
    faceIndex.get(k).push(f);
  }
  const lightAt = (x, y, z) => {
    const tr = trace(map, [x, y + 0.4, z], [x, y - 3, z], [0, 0, 0]);
    if (tr.fraction >= 1 || !tr.brush) return null;
    const list = faceIndex.get(tr.brush.index * 16 + tr.plane);
    if (!list) return null;
    for (const f of list) {
      const s = dot(tr.end, f.axes.u), t = dot(tr.end, f.axes.v);
      const i = Math.round(s / LUXEL - f.smin), j = Math.round(t / LUXEL - f.tmin);
      if (i < 0 || j < 0 || i >= f.lw || j >= f.lh) continue;
      const o = ((f.ay + j) * ATLAS_W + f.ax + i) * 4;
      return [data[o] / 127, data[o + 1] / 127, data[o + 2] / 127];
    }
    return null;
  };

  return {
    group, lightAt,
    dispose() {
      scene.remove(group);
      lmTex.dispose();
      if (scene.background && scene.background.dispose) scene.background.dispose();
      group.traverse(o => {
        if (o.geometry) o.geometry.dispose();
        if (o.material) { if (o.material.map && !isTextureCached(o.material.map)) o.material.map.dispose(); o.material.dispose(); }
      });
    },
  };
}

// ---------------------------------------------------------------- skybox
// Six painted faces: gradient sky, sun glow, soft clouds and a band of distant hills at the horizon.
export function buildSkybox(theme) {
  const S = 256;
  const top = new THREE.Color(theme.skyTop), hor = new THREE.Color(theme.skyHorizon);
  const L = new THREE.Vector3(...theme.sun).normalize();
  const hill = new THREE.Color(theme.fog).multiplyScalar(0.78);
  const rnd = (x) => { const s = Math.sin(x * 127.1) * 43758.5453; return s - Math.floor(s); };
  const noise = (x, y) => {
    const xi = Math.floor(x), yi = Math.floor(y), xf = x - xi, yf = y - yi;
    const h = (a, b) => rnd(a * 57 + b * 131);
    const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
    return h(xi, yi) * (1 - u) * (1 - v) + h(xi + 1, yi) * u * (1 - v) + h(xi, yi + 1) * (1 - u) * v + h(xi + 1, yi + 1) * u * v;
  };
  // face order for CubeTexture: +x, -x, +y, -y, +z, -z
  const dirs = [
    (a, b) => [1, -b, -a], (a, b) => [-1, -b, a], (a, b) => [a, 1, b],
    (a, b) => [a, -1, -b], (a, b) => [a, -b, 1], (a, b) => [-a, -b, -1],
  ];
  const canvases = dirs.map((fn) => {
    const c = document.createElement('canvas'); c.width = c.height = S;
    const g = c.getContext('2d'), img = g.createImageData(S, S);
    for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
      const d = new THREE.Vector3(...fn((x + 0.5) / S * 2 - 1, (y + 0.5) / S * 2 - 1)).normalize();
      const el = d.y;
      const col = hor.clone().lerp(top, Math.pow(Math.max(0, el), 0.55));
      const az = Math.atan2(d.z, d.x);
      // distant hills/dunes silhouette
      const ridge = 0.02 + 0.05 * noise(az * 3 + 10, 0.5) + 0.025 * noise(az * 11, 2.5);
      if (el < ridge) col.copy(hill).lerp(hor, Math.max(0, Math.min(1, (el + 0.05) / 0.1)) * 0.35);
      if (el < -0.02) col.copy(hill).multiplyScalar(0.85);
      // clouds
      if (el > ridge) {
        const px = d.x / (el + 0.25) * 2, pz = d.z / (el + 0.25) * 2;
        const cl = Math.max(0, noise(px, pz) * 0.6 + noise(px * 2.3, pz * 2.3) * 0.4 - 0.55) * 2.2 * Math.min(1, el * 4);
        col.lerp(new THREE.Color(1, 1, 1), Math.min(0.7, cl));
      }
      const s = Math.max(0, d.dot(L));
      col.r += Math.pow(s, 400) * 3 + Math.pow(s, 10) * 0.18;
      col.g += Math.pow(s, 400) * 2.8 + Math.pow(s, 10) * 0.15;
      col.b += Math.pow(s, 400) * 2.4 + Math.pow(s, 10) * 0.1;
      const o = (y * S + x) * 4;
      img.data[o] = Math.min(255, col.r * 255); img.data[o + 1] = Math.min(255, col.g * 255); img.data[o + 2] = Math.min(255, col.b * 255); img.data[o + 3] = 255;
    }
    g.putImageData(img, 0, 0);
    return c;
  });
  const cube = new THREE.CubeTexture(canvases);
  cube.colorSpace = THREE.SRGBColorSpace;
  cube.needsUpdate = true;
  return cube;
}

// ---------------------------------------------------------------- decorations
// Doors, lamps, awnings and trees from the map source. No collision; lit by the scene lights; merged per material.
function mergeInto(list) {
  const pos = [], nor = [], uv = [];
  for (const g of list) {
    const ng = g.index ? g.toNonIndexed() : g;
    pos.push(...ng.attributes.position.array); nor.push(...ng.attributes.normal.array); uv.push(...ng.attributes.uv.array);
    if (ng !== g) ng.dispose();
    g.dispose();
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  out.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  out.computeBoundingSphere();
  return out;
}

function buildDecor(map, group) {
  const parts = {};
  const add = (key, geo, m4) => { geo.applyMatrix4(m4); (parts[key] ||= []).push(geo); };
  const M = (x, y, z, rx = 0, ry = 0, rz = 0) =>
    new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), new THREE.Quaternion().setFromEuler(new THREE.Euler(rx, ry, rz)), new THREE.Vector3(1, 1, 1));
  const floor = (x, z) => { const y = floorAt(map, x, z); return isNaN(y) ? null : y; };
  const ceilAbove = (x, y, z) => {
    const tr = trace(map, [x, y + 1, z], [x, y + 8, z], [0, 0, 0]);
    return tr.fraction < 1 ? tr.end[1] : null;
  };
  const nudge = (d) => {
    for (let r = 0; r <= 4; r++)
      for (let dz = -r; dz <= r; dz++) for (let dx = -r; dx <= r; dx++) {
        const x = d.x + dx + 0.5, z = d.z + dz + 0.5;
        const y = floor(x, z);
        if (y === null) continue;
        if ([[1, 0], [-1, 0], [0, 1], [0, -1]].every(([a, b]) => { const yy = floor(x + a, z + b); return yy !== null && Math.abs(yy - y) < 0.5; })) return { ...d, x: d.x + dx, z: d.z + dz };
      }
    return null;
  };
  for (const d0 of map.decor || []) {
    const d = d0.t === 'palm' || d0.t === 'tree' ? nudge(d0) : d0;
    if (!d) continue;
    if (d.t === 'doors') {
      const w = (d.b - d.a) / 2;
      for (const side of [0, 1]) {
        const hinge = side ? d.b - 0.08 : d.a + 0.08;
        const cx = d.axis === 'x' ? hinge : d.at + d.open * w / 2;
        const cz = d.axis === 'x' ? d.at + d.open * w / 2 : hinge;
        const y = floor(cx, cz);
        if (y === null) continue;
        const c = ceilAbove(cx, y, cz), hgt = Math.min(2.8, (c ?? y + 9) - y - 0.05);
        const geo = d.axis === 'x' ? new THREE.BoxGeometry(0.08, hgt, w - 0.1) : new THREE.BoxGeometry(w - 0.1, hgt, 0.08);
        add(d.mat || 'door', geo, M(cx, y + hgt / 2, cz));
      }
    } else if (d.t === 'lamp') {
      const x = d.x + 0.5, z = d.z + 0.5, y = floor(x, z);
      if (y === null) continue;
      const c = ceilAbove(x, y, z);
      if (c === null) continue;
      add('metal', new THREE.BoxGeometry(0.3, 0.06, 0.3), M(x, c - 0.03, z));
      add('metal', new THREE.CylinderGeometry(0.012, 0.012, 0.3, 4), M(x, c - 0.2, z));
      add('bulb', new THREE.SphereGeometry(0.09, 8, 6), M(x, c - 0.38, z));
    } else if (d.t === 'awning') {
      const cx = (d.x1 + d.x2 + 1) / 2, cz = (d.z1 + d.z2 + 1) / 2;
      const fy = floor(cx, cz);
      if (fy === null) continue;
      const y = fy + d.h, wx = d.x2 - d.x1 + 1, wz = d.z2 - d.z1 + 1;
      add(d.mat, new THREE.PlaneGeometry(wx, wz * 1.08), M(cx, y, cz, -Math.PI / 2 + 0.38, 0, 0));
      for (const px of [d.x1 + 0.1, d.x2 + 0.9]) add('wood', new THREE.CylinderGeometry(0.04, 0.04, d.h, 5), M(px, y - d.h / 2, d.z2 + 0.9));
    } else if (d.t === 'palm') {
      const x = d.x + 0.5, z = d.z + 0.5, y = floor(x, z), H = 6.5;
      for (let k = 0; k < 3; k++) add('bark', new THREE.CylinderGeometry(0.15 - k * 0.025, 0.2 - k * 0.025, H / 3, 7), M(x + k * 0.12, y + H / 6 + k * H / 3, z, 0, 0, -0.05));
      for (let k = 0; k < 12; k++) {
        const a = k / 12 * Math.PI * 2 + (k % 2) * 0.2, tilt = k % 2 ? 1.75 : 1.3;
        const geo = new THREE.PlaneGeometry(1.0, 3.4, 1, 3);
        geo.translate(0, 1.7, 0);
        const p = geo.attributes.position;
        for (let v = 0; v < p.count; v++) p.setZ(v, p.getZ(v) - Math.pow(p.getY(v) / 3.4, 2) * 1.1);
        add('leaves', geo, M(x + 0.36, y + H, z, 0, a, 0).multiply(M(0, 0, 0, tilt, 0, 0)));
      }
    } else if (d.t === 'tree') {
      const x = d.x + 0.5, z = d.z + 0.5, y = floor(x, z);
      add('bark', new THREE.CylinderGeometry(0.16, 0.26, 3.6, 7), M(x, y + 1.8, z));
      for (const [ox, oy, oz, s] of [[0, 4.2, 0, 1.9], [0.9, 3.6, 0.4, 1.3], [-0.8, 3.7, -0.5, 1.4], [0.2, 5.1, -0.2, 1.2]])
        add('foliage', new THREE.IcosahedronGeometry(s, 1), M(x + ox, y + oy, z + oz));
    }
  }
  const mats = {
    bulb: () => new THREE.MeshBasicMaterial({ color: 0xffe2a0 }),
    metal: () => new THREE.MeshLambertMaterial({ color: 0x2c2c2c }),
    leaves: () => new THREE.MeshLambertMaterial({ map: surfaceTexture('leaves'), alphaTest: 0.4, side: THREE.DoubleSide }),
    foliage: () => new THREE.MeshLambertMaterial({ map: surfaceTexture('leaves'), color: 0x9ab07a, alphaTest: 0.35, side: THREE.DoubleSide }),
  };
  for (const [key, list] of Object.entries(parts)) {
    const material = mats[key] ? mats[key]() : new THREE.MeshLambertMaterial({ map: surfaceTexture(key), side: key.startsWith('cloth') ? THREE.DoubleSide : THREE.FrontSide });
    const mesh = new THREE.Mesh(mergeInto(list), material);
    mesh.matrixAutoUpdate = false;
    group.add(mesh);
  }
}

function letterTexture(letter) {
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const g = c.getContext('2d');
  g.font = 'bold 200px Impact, Arial Black, Arial';
  g.textAlign = 'center'; g.textBaseline = 'middle';
  g.shadowColor = 'rgba(200,40,20,0.6)'; g.shadowBlur = 14;
  g.fillStyle = 'rgba(205,45,25,0.85)';
  g.fillText(letter, 128, 140);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

// ---------------------------------------------------------------- 2D overview (radar / menu cards)
export function drawMapCanvas(map, px = 2) {
  const c = document.createElement('canvas');
  c.width = map.w * px; c.height = map.h * px;
  const g = c.getContext('2d');
  g.fillStyle = '#16181b'; g.fillRect(0, 0, c.width, c.height);
  const nav = getNav(map);
  for (let cz = 0; cz < map.h; cz++) for (let cx = 0; cx < map.w; cx++) {
    const list = nav.cols[cz * map.w + cx];
    if (!list || !list.length) continue;
    let y = -Infinity;
    for (const j of list) y = Math.max(y, nav.nodes[j].y);
    const l = Math.max(0, Math.min(1, 0.45 + y * 0.07));
    let rgb = [150 * l + 40, 145 * l + 38, 132 * l + 34];
    const zr = map.zoneRects, inR = (r) => r && cx + 0.5 >= r[0] && cx + 0.5 < r[2] && cz + 0.5 >= r[1] && cz + 0.5 < r[3];
    if (inR(zr.A) || inR(zr.B)) rgb = [rgb[0] + 30, rgb[1] - 5, rgb[2] - 15];
    g.fillStyle = `rgb(${rgb[0] | 0},${rgb[1] | 0},${rgb[2] | 0})`;
    g.fillRect(cx * px, cz * px, px, px);
  }
  g.fillStyle = '#ffb070'; g.font = `bold ${px * 9}px Arial`; g.textAlign = 'center'; g.textBaseline = 'middle';
  for (const s of ['A', 'B']) { const ctr = map.siteCenter[s]; g.fillText(s, ctr.x * px, ctr.z * px); }
  void Z_A; void Z_B;
  return c;
}
