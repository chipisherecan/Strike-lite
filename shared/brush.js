// Brush world, GoldSrc/Quake style.
// The level is a list of convex "brushes" (boxes, sloped boxes, wedges). Each brush is the intersection of planes
// (n·p <= d is inside). Collision sweeps an axis-aligned box through the brushes the way Quake/GoldSrc "hulls" do:
// every plane is pushed out by the box's extents (Minkowski sum), so a box trace becomes a ray trace.
// Units are metres. +y is up.

export const DIST_EPS = 0.0008;   // ~1/32 of a Quake unit
const SURF_EPS = 0.003;

// ---------------------------------------------------------------- brush construction
// tex: { top, bottom, side } texture names. flags: { nodraw, clip, ... }
export function boxBrush(min, max, tex, flags = {}) {
  const t = normTex(tex);
  return makeBrush([
    { n: [1, 0, 0], d: max[0], tex: t.side },
    { n: [-1, 0, 0], d: -min[0], tex: t.side },
    { n: [0, 1, 0], d: max[1], tex: t.top },
    { n: [0, -1, 0], d: -min[1], tex: t.bottom },
    { n: [0, 0, 1], d: max[2], tex: t.side },
    { n: [0, 0, -1], d: -min[2], tex: t.side },
  ], flags);
}

// Box from (x0,z0)-(x1,z1) with a flat bottom and a tilted top surface y = a + sx*x + sz*z.
export function slopeBrush(x0, z0, x1, z1, bottom, a, sx, sz, tex, flags = {}) {
  const t = normTex(tex);
  const len = Math.hypot(sx, 1, sz);
  const n = [-sx / len, 1 / len, -sz / len];
  const top = { n, d: a / len, tex: t.top };   // n·p = (-sx x + y - sz z)/len <= a/len  <=>  y <= a + sx x + sz z
  return makeBrush([
    { n: [1, 0, 0], d: x1, tex: t.side },
    { n: [-1, 0, 0], d: -x0, tex: t.side },
    top,
    { n: [0, -1, 0], d: -bottom, tex: t.bottom },
    { n: [0, 0, 1], d: z1, tex: t.side },
    { n: [0, 0, -1], d: -z0, tex: t.side },
  ], flags);
}

// Convex outline [[x,z],...] extruded from bottom to top; `plane` {a,sx,sz} tilts the top to y = a + sx*x + sz*z.
export function prismBrush(pts, bottom, top, plane, tex, flags = {}) {
  const t = normTex(tex);
  let s = 0;
  for (let i = 0; i < pts.length; i++) { const a = pts[i], b = pts[(i + 1) % pts.length]; s += a[0] * b[1] - b[0] * a[1]; }
  const p = s > 0 ? pts : pts.slice().reverse(), planes = [];
  for (let i = 0; i < p.length; i++) {
    const a = p[i], b = p[(i + 1) % p.length], dx = b[0] - a[0], dz = b[1] - a[1], l = Math.hypot(dx, dz);
    if (l < 1e-6) continue;
    const n = [dz / l, 0, -dx / l];
    planes.push({ n, d: n[0] * a[0] + n[2] * a[1], tex: t.side });
  }
  if (plane) {
    const len = Math.hypot(plane.sx, 1, plane.sz);
    planes.push({ n: [-plane.sx / len, 1 / len, -plane.sz / len], d: plane.a / len, tex: t.top });
  } else planes.push({ n: [0, 1, 0], d: top, tex: t.top });
  planes.push({ n: [0, -1, 0], d: -bottom, tex: t.bottom });
  return makeBrush(planes, flags);
}

function normTex(tex) {
  if (!tex) return { top: 'stone', bottom: 'stone', side: 'stone' };
  if (typeof tex === 'string') return { top: tex, bottom: tex, side: tex };
  return { top: tex.top || tex.side, bottom: tex.bottom || tex.side, side: tex.side || tex.top };
}

export function makeBrush(planes, flags = {}) {
  const b = { planes, flags, min: [0, 0, 0], max: [0, 0, 0], stamp: 0 };
  const polys = brushPolygons(b);
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (const p of polys) for (const v of p.verts) for (let k = 0; k < 3; k++) { min[k] = Math.min(min[k], v[k]); max[k] = Math.max(max[k], v[k]); }
  b.min = min; b.max = max;
  return b;
}

// ---------------------------------------------------------------- polygons (for rendering and bounds)
// Each face polygon = a huge quad on the plane clipped by every other plane of the brush.
export function brushPolygons(b) {
  const out = [];
  for (let i = 0; i < b.planes.length; i++) {
    const p = b.planes[i];
    let poly = baseWinding(p.n, p.d);
    for (let j = 0; j < b.planes.length && poly.length; j++) {
      if (j === i) continue;
      poly = clipWinding(poly, b.planes[j].n, b.planes[j].d);
    }
    if (poly.length >= 3) out.push({ plane: i, verts: poly });
  }
  return out;
}

function baseWinding(n, d) {
  // pick the major axis to build two in-plane vectors
  const ax = Math.abs(n[0]), ay = Math.abs(n[1]), az = Math.abs(n[2]);
  const up = ay >= ax && ay >= az ? [0, 0, 1] : [0, 1, 0];
  let u = cross(up, n); u = norm(u);
  const v = cross(n, u);
  const org = [n[0] * d, n[1] * d, n[2] * d];
  const S = 4096;
  return [
    add(org, add(scale(u, -S), scale(v, S))),
    add(org, add(scale(u, S), scale(v, S))),
    add(org, add(scale(u, S), scale(v, -S))),
    add(org, add(scale(u, -S), scale(v, -S))),
  ];
}

// keep the part of the polygon behind the plane (n·p <= d)
function clipWinding(poly, n, d) {
  const out = [];
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length];
    const da = dot(a, n) - d, db = dot(b, n) - d;
    if (da <= 1e-6) out.push(a);
    if ((da > 1e-6 && db < -1e-6) || (da < -1e-6 && db > 1e-6)) {
      const t = da / (da - db);
      out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]);
    }
  }
  return out;
}

// ---------------------------------------------------------------- spatial grid (broad phase)
export const GRID = 4;
export function buildGrid(brushes) {
  const cells = new Map();
  brushes.forEach((b, idx) => {
    b.index = idx;
    if (b.flags.nocollide) return;
    for (let gx = Math.floor(b.min[0] / GRID); gx <= Math.floor(b.max[0] / GRID); gx++)
      for (let gz = Math.floor(b.min[2] / GRID); gz <= Math.floor(b.max[2] / GRID); gz++) {
        const k = gx * 73856093 ^ gz * 19349663;
        let list = cells.get(k);
        if (!list) cells.set(k, list = []);
        list.push(b);
      }
  });
  return { cells, stamp: 0 };
}

function query(grid, minx, minz, maxx, maxz, fn) {
  const s = ++grid.stamp;
  for (let gx = Math.floor(minx / GRID); gx <= Math.floor(maxx / GRID); gx++)
    for (let gz = Math.floor(minz / GRID); gz <= Math.floor(maxz / GRID); gz++) {
      const list = grid.cells.get(gx * 73856093 ^ gz * 19349663);
      if (!list) continue;
      for (const b of list) { if (b.stamp === s) continue; b.stamp = s; fn(b); }
    }
}

// ---------------------------------------------------------------- traces
// Sweep a box (half extents ext) from start to end (both box centres). Returns
// { fraction, end:[x,y,z], normal, startsolid, allsolid, brush, plane }.
export function trace(world, start, end, ext) {
  const tw = { fraction: 1, normal: null, startsolid: false, allsolid: false, brush: null, plane: -1 };
  const minx = Math.min(start[0], end[0]) - ext[0] - 0.01, maxx = Math.max(start[0], end[0]) + ext[0] + 0.01;
  const miny = Math.min(start[1], end[1]) - ext[1] - 0.01, maxy = Math.max(start[1], end[1]) + ext[1] + 0.01;
  const minz = Math.min(start[2], end[2]) - ext[2] - 0.01, maxz = Math.max(start[2], end[2]) + ext[2] + 0.01;
  query(world.grid, minx, minz, maxx, maxz, (b) => {
    if (b.max[0] < minx || b.min[0] > maxx || b.max[1] < miny || b.min[1] > maxy || b.max[2] < minz || b.min[2] > maxz) return;
    if (b.flags.noshoot && ext[0] === 0 && ext[1] === 0) return; // clip brushes block players, not bullets
    clipToBrush(b, start, end, ext, tw);
  });
  if (world.mesh) clipMesh(world.mesh, start, end, ext, tw, minx, miny, minz, maxx, maxy, maxz);
  const f = tw.fraction;
  tw.end = [start[0] + (end[0] - start[0]) * f, start[1] + (end[1] - start[1]) * f, start[2] + (end[2] - start[2]) * f];
  return tw;
}

function clipToBrush(b, start, end, ext, tw) {
  let enterFrac = -1, leaveFrac = 1, clip = -1, getout = false, startout = false;
  for (let i = 0; i < b.planes.length; i++) {
    const p = b.planes[i], n = p.n;
    const dist = p.d + Math.abs(n[0]) * ext[0] + Math.abs(n[1]) * ext[1] + Math.abs(n[2]) * ext[2];
    const d1 = start[0] * n[0] + start[1] * n[1] + start[2] * n[2] - dist;
    const d2 = end[0] * n[0] + end[1] * n[1] + end[2] * n[2] - dist;
    if (d2 > 0) getout = true;
    if (d1 > 0) startout = true;
    if (d1 > 0 && (d2 >= SURF_EPS || d2 >= d1)) return;   // completely in front of this plane
    if (d1 <= 0 && d2 <= 0) continue;                      // completely behind
    if (d1 > d2) {                                         // entering
      const f = Math.max(0, (d1 - DIST_EPS) / (d1 - d2));
      if (f > enterFrac) { enterFrac = f; clip = i; }
    } else {                                               // leaving
      const f = Math.min(1, (d1 + DIST_EPS) / (d1 - d2));
      if (f < leaveFrac) leaveFrac = f;
    }
  }
  if (!startout) {
    tw.startsolid = true;
    if (!getout) { tw.allsolid = true; tw.fraction = 0; tw.brush = b; tw.normal = tw.normal || [0, 1, 0]; }
    return;
  }
  if (enterFrac < leaveFrac && enterFrac > -1 && enterFrac < tw.fraction) {
    tw.fraction = Math.max(0, enterFrac);
    tw.normal = b.planes[clip].n;
    tw.brush = b; tw.plane = clip;
  }
}

// ---------------------------------------------------------------- triangle collision (maps imported from CS2)
// tris holds 9 floats per triangle; flags bit 0 means it blocks players but not bullets.
export function buildMeshIndex(tris, flags) {
  const n = flags.length, lists = new Map();
  for (let i = 0; i < n; i++) {
    const o = i * 9;
    const x0 = Math.min(tris[o], tris[o + 3], tris[o + 6]), x1 = Math.max(tris[o], tris[o + 3], tris[o + 6]);
    const z0 = Math.min(tris[o + 2], tris[o + 5], tris[o + 8]), z1 = Math.max(tris[o + 2], tris[o + 5], tris[o + 8]);
    for (let gx = Math.floor(x0 / GRID); gx <= Math.floor(x1 / GRID); gx++)
      for (let gz = Math.floor(z0 / GRID); gz <= Math.floor(z1 / GRID); gz++) {
        const k = gx * 73856093 ^ gz * 19349663;
        let l = lists.get(k);
        if (!l) lists.set(k, l = []);
        l.push(i);
      }
  }
  const cells = new Map();
  for (const [k, l] of lists) cells.set(k, Int32Array.from(l));
  return { tris, flags, cells, stamps: new Uint32Array(n), stamp: 0 };
}

// Upward part of a triangle's own facing, ignoring which side a trace hit it from.
export function triUp(mesh, i) {
  const T = mesh.tris, o = i * 9, ux = T[o + 3] - T[o], uy = T[o + 4] - T[o + 1], uz = T[o + 5] - T[o + 2], vx = T[o + 6] - T[o], vy = T[o + 7] - T[o + 1], vz = T[o + 8] - T[o + 2];
  const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
  return ny / (Math.hypot(nx, ny, nz) || 1);
}

function clipMesh(m, start, end, ext, tw, minx, miny, minz, maxx, maxy, maxz) {
  const s = ++m.stamp, T = m.tris, ray = ext[0] === 0 && ext[1] === 0;
  // only cells near the segment: a long diagonal shot should not visit its whole bounding box
  const dx = end[0] - start[0], dz = end[2] - start[2], len = Math.hypot(dx, dz), reach = GRID * 0.7072 + Math.max(ext[0], ext[2]) + 0.02;
  for (let gx = Math.floor(minx / GRID); gx <= Math.floor(maxx / GRID); gx++)
    for (let gz = Math.floor(minz / GRID); gz <= Math.floor(maxz / GRID); gz++) {
      if (len > GRID && Math.abs((gx * GRID + GRID / 2 - start[0]) * dz - (gz * GRID + GRID / 2 - start[2]) * dx) / len > reach) continue;
      const list = m.cells.get(gx * 73856093 ^ gz * 19349663);
      if (!list) continue;
      for (let c = 0; c < list.length; c++) {
        const i = list[c];
        if (m.stamps[i] === s) continue;
        m.stamps[i] = s;
        if (ray && (m.flags[i] & 1)) continue;
        const o = i * 9;
        if (Math.max(T[o], T[o + 3], T[o + 6]) < minx || Math.min(T[o], T[o + 3], T[o + 6]) > maxx) continue;
        if (Math.max(T[o + 1], T[o + 4], T[o + 7]) < miny || Math.min(T[o + 1], T[o + 4], T[o + 7]) > maxy) continue;
        if (Math.max(T[o + 2], T[o + 5], T[o + 8]) < minz || Math.min(T[o + 2], T[o + 5], T[o + 8]) > maxz) continue;
        clipTri(m, i, start, end, ext, tw);
      }
    }
}

// A box against a triangle: the same plane clipping as clipToBrush, over the 13 axes that can separate them.
let cEnter, cLeave, cStartOut, cGetOut, cNx, cNy, cNz;
function plane(nx, ny, nz, d1, d2) {
  if (d2 > 0) cGetOut = true;
  if (d1 > 0) cStartOut = true;
  if (d1 > 0 && (d2 >= SURF_EPS || d2 >= d1)) return false;
  if (d1 <= 0 && d2 <= 0) return true;
  if (d1 > d2) {
    const f = Math.max(0, (d1 - DIST_EPS) / (d1 - d2));
    if (f > cEnter) { cEnter = f; cNx = nx; cNy = ny; cNz = nz; }
  } else {
    const f = Math.min(1, (d1 + DIST_EPS) / (d1 - d2));
    if (f < cLeave) cLeave = f;
  }
  return true;
}
function axis(T, o, nx, ny, nz, start, end, ext) {
  const l = Math.hypot(nx, ny, nz);
  if (l < 1e-7) return true;
  nx /= l; ny /= l; nz /= l;
  const p0 = T[o] * nx + T[o + 1] * ny + T[o + 2] * nz, p1 = T[o + 3] * nx + T[o + 4] * ny + T[o + 5] * nz, p2 = T[o + 6] * nx + T[o + 7] * ny + T[o + 8] * nz;
  const lo = Math.min(p0, p1, p2), hi = Math.max(p0, p1, p2), r = Math.abs(nx) * ext[0] + Math.abs(ny) * ext[1] + Math.abs(nz) * ext[2];
  const a = start[0] * nx + start[1] * ny + start[2] * nz, b = end[0] * nx + end[1] * ny + end[2] * nz;
  return plane(nx, ny, nz, a - hi - r, b - hi - r) && plane(-nx, -ny, -nz, lo - r - a, lo - r - b);
}
function clipTri(m, i, start, end, ext, tw) {
  const T = m.tris, o = i * 9;
  const ax = T[o + 3] - T[o], ay = T[o + 4] - T[o + 1], az = T[o + 5] - T[o + 2], bx = T[o + 6] - T[o + 3], by = T[o + 7] - T[o + 4], bz = T[o + 8] - T[o + 5], cx = T[o] - T[o + 6], cy = T[o + 1] - T[o + 7], cz = T[o + 2] - T[o + 8];
  cEnter = -1; cLeave = 1; cStartOut = false; cGetOut = false;
  if (!axis(T, o, ay * bz - az * by, az * bx - ax * bz, ax * by - ay * bx, start, end, ext)) return;
  if (!axis(T, o, 1, 0, 0, start, end, ext) || !axis(T, o, 0, 1, 0, start, end, ext) || !axis(T, o, 0, 0, 1, start, end, ext)) return;
  if (ext[0] || ext[1] || ext[2]) {
    if (!axis(T, o, 0, -az, ay, start, end, ext) || !axis(T, o, az, 0, -ax, start, end, ext) || !axis(T, o, -ay, ax, 0, start, end, ext)) return;
    if (!axis(T, o, 0, -bz, by, start, end, ext) || !axis(T, o, bz, 0, -bx, start, end, ext) || !axis(T, o, -by, bx, 0, start, end, ext)) return;
    if (!axis(T, o, 0, -cz, cy, start, end, ext) || !axis(T, o, cz, 0, -cx, start, end, ext) || !axis(T, o, -cy, cx, 0, start, end, ext)) return;
  } else {
    // a ray must also cross inside the triangle's three edges
    const nx = ay * bz - az * by, ny = az * bx - ax * bz, nz = ax * by - ay * bx;
    if (!axis(T, o, ny * az - nz * ay, nz * ax - nx * az, nx * ay - ny * ax, start, end, ext)) return;
    if (!axis(T, o, ny * bz - nz * by, nz * bx - nx * bz, nx * by - ny * bx, start, end, ext)) return;
    if (!axis(T, o, ny * cz - nz * cy, nz * cx - nx * cz, nx * cy - ny * cx, start, end, ext)) return;
  }
  const lowest = Math.min(T[o + 1], T[o + 4], T[o + 7]);
  if (!cStartOut) {
    tw.startsolid = true;
    if (!cGetOut) { tw.allsolid = true; tw.fraction = 0; tw.brush = { flags: {}, min: [0, lowest, 0], index: -1, tri: i }; tw.normal = tw.normal || [0, 1, 0]; }
    return;
  }
  if (cEnter <= cLeave + 1e-9 && cEnter > -1 && cEnter < tw.fraction) {   // a ray enters and leaves a flat triangle at the same moment
    tw.fraction = Math.max(0, cEnter);
    tw.normal = [cNx, cNy, cNz];
    tw.brush = { flags: {}, min: [0, lowest, 0], index: -1, tri: i };
    tw.plane = -1;
  }
}

// ---------------------------------------------------------------- player movement (Quake 3 / GoldSrc style)
const OVERCLIP = 1.001;
function clipVelocity(v, n, overbounce = OVERCLIP) {
  let back = v[0] * n[0] + v[1] * n[1] + v[2] * n[2];
  back = back < 0 ? back * overbounce : back / overbounce;
  return [v[0] - n[0] * back, v[1] - n[1] * back, v[2] - n[2] * back];
}

// Slide a box along walls. pos (centre) and vel are arrays and are updated. Returns true if anything was hit.
export function slideMove(world, pos, vel, dt, ext) {
  const planes = [];
  let timeLeft = dt, hit = false;
  for (let bump = 0; bump < 4; bump++) {
    const end = [pos[0] + vel[0] * timeLeft, pos[1] + vel[1] * timeLeft, pos[2] + vel[2] * timeLeft];
    const tr = trace(world, pos, end, ext);
    if (tr.allsolid) { vel[1] = 0; return true; }
    if (tr.fraction > 0) { pos[0] = tr.end[0]; pos[1] = tr.end[1]; pos[2] = tr.end[2]; }
    if (tr.fraction === 1) break;
    hit = true;
    timeLeft -= timeLeft * tr.fraction;
    if (planes.length >= 5) { vel[0] = vel[1] = vel[2] = 0; return true; }
    planes.push(tr.normal);
    let solved = false;
    for (let i = 0; i < planes.length && !solved; i++) {
      if (dot(vel, planes[i]) >= 0.1) continue;
      let cv = clipVelocity(vel, planes[i]);
      let ok = true;
      for (let j = 0; j < planes.length; j++) {
        if (j === i || dot(cv, planes[j]) >= 0.1) continue;
        cv = clipVelocity(cv, planes[j]);
        if (dot(cv, planes[i]) >= 0) continue;
        // slide along the crease of the two planes
        const dir = norm(cross(planes[i], planes[j]));
        const d = dot(dir, vel);
        cv = scale(dir, d);
        for (let k = 0; k < planes.length; k++) {
          if (k === i || k === j || dot(cv, planes[k]) >= 0.1) continue;
          vel[0] = vel[1] = vel[2] = 0; return true;   // stuck in a corner
        }
      }
      if (ok) { vel[0] = cv[0]; vel[1] = cv[1]; vel[2] = cv[2]; solved = true; }
    }
  }
  return hit;
}

// Walk with stair stepping: try the plain slide, then try "step up, slide, step down" and keep whichever got further.
export function stepSlideMove(world, pos, vel, dt, ext, stepSize) {
  const startO = pos.slice(), startV = vel.slice();
  if (!slideMove(world, pos, vel, dt, ext)) return;
  const up = trace(world, startO, [startO[0], startO[1] + stepSize, startO[2]], ext);
  if (up.allsolid) return;
  const stepUp = up.end[1] - startO[1];
  const sp = up.end.slice(), sv = startV.slice();
  slideMove(world, sp, sv, dt, ext);
  const down = trace(world, sp, [sp[0], sp[1] - stepUp - 0.01, sp[2]], ext);
  if (down.allsolid) return;
  // only accept the step if we land on walkable ground
  if (down.fraction < 1 && down.normal[1] < 0.7) return;
  const stepped = down.end;
  const d0 = (pos[0] - startO[0]) ** 2 + (pos[2] - startO[2]) ** 2;
  const d1 = (stepped[0] - startO[0]) ** 2 + (stepped[2] - startO[2]) ** 2;
  if (d1 > d0 + 1e-6) {
    pos[0] = stepped[0]; pos[1] = stepped[1]; pos[2] = stepped[2];
    vel[0] = sv[0]; vel[2] = sv[2];
    if (down.fraction < 1) { const c = clipVelocity(vel, down.normal); vel[1] = Math.min(vel[1], c[1]); }
  }
}

// Ground under a box centre: returns the trace (fraction < 1 means ground within `dist`).
export function groundTrace(world, pos, ext, dist = 0.06) {
  return trace(world, pos, [pos[0], pos[1] - dist, pos[2]], ext);
}

// ---------------------------------------------------------------- vector helpers
function dot(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
function cross(a, b) { return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]; }
function norm(a) { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; }
function scale(a, s) { return [a[0] * s, a[1] * s, a[2] * s]; }
function add(a, b) { return [a[0] + b[0], a[1] + b[1], a[2] + b[2]]; }
export const vec = { dot, cross, norm, scale, add };
