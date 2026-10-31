// Turns hand-drawn floor outlines (see mirage-levels.js) into brushes: floors, generated walls, roofs and stairs.

const area = (p) => { let s = 0; for (let i = 0; i < p.length; i++) { const a = p[i], b = p[(i + 1) % p.length]; s += a[0] * b[1] - b[0] * a[1]; } return s / 2; };

export function pointInPoly(x, z, p) {
  let inside = false;
  for (let i = 0, j = p.length - 1; i < p.length; j = i++) {
    const [ax, az] = p[i], [bx, bz] = p[j];
    if ((az > z) !== (bz > z) && x < (bx - ax) * (z - az) / (bz - az) + ax) inside = !inside;
  }
  return inside;
}

// Ear clipping: any simple outline to triangles.
function triangulate(pts) {
  const p = area(pts) > 0 ? pts.slice() : pts.slice().reverse(), out = [];
  const cross = (a, b, c) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
  let guard = 0;
  while (p.length > 3 && guard++ < 2000) {
    let cut = false;
    for (let i = 0; i < p.length; i++) {
      const a = p[(i + p.length - 1) % p.length], b = p[i], c = p[(i + 1) % p.length];
      if (cross(a, b, c) <= 1e-6) continue;
      const hit = p.some((q) => q !== a && q !== b && q !== c && cross(a, b, q) >= -1e-9 && cross(b, c, q) >= -1e-9 && cross(c, a, q) >= -1e-9);
      if (hit) continue;
      out.push([a, b, c]); p.splice(i, 1); cut = true; break;
    }
    if (!cut) p.splice(0, 1);  // collinear leftovers
  }
  if (p.length === 3) out.push(p);
  return out;
}

export function buildPlan({ FLOORS, STAIRS, TUNNEL, EXTRA, DECOR, ZONES, LOOK, ROOMS, Y, size }) {
  const brushes = [];
  const rect = ([a, b, c, e]) => [[a, b], [c, b], [c, e], [a, e]];
  const stairPolys = STAIRS.map((s) => ({ ...s, pts: rect(s.r), stairs: true, y: Math.max(Y(s.a), Y(s.b)) }));
  // everything a wall must not be built across; thin decks have open air under them
  const solidFloors = [...FLOORS.filter((f) => !f.thin), ...stairPolys];
  const tunnelTop = Y(TUNNEL.u) + TUNNEL.top;

  const paintAt = (x, z) => {
    let hit = LOOK.paint[0];
    for (const r of LOOK.paint) if (x >= r[0] && x < r[2] && z >= r[1] && z < r[3]) hit = r;
    return hit;
  };
  const wallPrism = (a, b, n, bottom, top, tex) => {
    const T = 0.6, pts = [a, b, [b[0] + n[0] * T, b[1] + n[1] * T], [a[0] + n[0] * T, a[1] + n[1] * T]];
    // a wall crossing the underpass stops at its ceiling
    const xs = TUNNEL.pts.map(p => p[0]), zs = TUNNEL.pts.map(p => p[1]);
    const crosses = bottom < tunnelTop && top > tunnelTop && Math.max(...pts.map(p => p[0])) > Math.min(...xs) && Math.min(...pts.map(p => p[0])) < Math.max(...xs) && Math.max(...pts.map(p => p[1])) > Math.min(...zs) && Math.min(...pts.map(p => p[1])) < Math.max(...zs);
    brushes.push({ t: 'prism', pts, bottom: crosses ? tunnelTop : bottom, top, tex: { top: 'flagstone', side: tex, bottom: crosses ? 'ceil_plain' : 'nodraw' }, wall: crosses ? undefined : true });
  };
  // walls along an outline, skipping stretches that touch one of `open`
  const walls = (self, baseY, roofY, open, topLimit) => {
    const pts = area(self.pts) > 0 ? self.pts : self.pts.slice().reverse();
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i], b = pts[(i + 1) % pts.length], dx = b[0] - a[0], dz = b[1] - a[1], len = Math.hypot(dx, dz);
      if (len < 0.01) continue;
      const n = [dz / len, -dx / len];   // outward for a positive-area outline
      const N = Math.max(1, Math.round(len / 0.2));
      let start = null;
      const flush = (k) => {
        if (start === null) return;
        const s0 = start / N, s1 = k / N, p0 = [a[0] + dx * s0, a[1] + dz * s0], p1 = [a[0] + dx * s1, a[1] + dz * s1];
        start = null;
        const mx = (p0[0] + p1[0]) / 2 + n[0] * 0.3, mz = (p0[1] + p1[1]) / 2 + n[1] * 0.3, pr = paintAt(mx, mz);
        const tex = (ROOMS && ROOMS[self.name]) || pr[4];
        const top = topLimit ?? Math.max(pr[5] || 12, baseY + 3.6, (roofY ?? 0) + 0.5);
        wallPrism(p0, p1, n, -1, top, tex);
      };
      for (let k = 0; k < N; k++) {
        const t = (k + 0.5) / N, sx = a[0] + dx * t + n[0] * 0.15, sz = a[1] + dz * t + n[1] * 0.15;
        const touching = open.some((o) => o !== self && pointInPoly(sx, sz, o.pts));
        if (touching) flush(k); else if (start === null) start = k;
      }
      flush(N);
    }
  };

  for (const f of FLOORS) {
    const y = Y(f.u), side = f.side || (f.tex === 'crate_hd' ? 'crate_hd' : 'sandstone');
    const bottom = f.thin ? y - 0.25 : f.over ? tunnelTop : -1;
    const tex = { top: f.tex, side, bottom: f.thin || f.over ? 'ceil_plain' : 'nodraw' };
    let plane = null;
    if (f.slope) {
      const [axis, from, to, ua, ub] = f.slope, g = (Y(ub) - Y(ua)) / (to - from), a = Y(ua) - g * from;
      plane = { a, sx: axis === 'x' ? g : 0, sz: axis === 'z' ? g : 0 };
    }
    for (const tri of triangulate(f.pts)) brushes.push({ t: 'prism', pts: tri, bottom, top: y, plane, tex, group: f.name });
    if (f.roof) for (const tri of triangulate(f.pts)) brushes.push({ t: 'prism', pts: tri, bottom: y + f.roof, top: y + f.roof + 0.3, tex: { top: 'flagstone', side: 'plaster_cream', bottom: f.tex === 'tile_white' ? 'ceil_plain' : 'wood_old' }, roof: true, group: f.name + ' roof' });
    if (!f.noWalls) walls(f, y, f.roof ? y + f.roof : null, solidFloors);
  }

  for (const s of stairPolys) {
    const [x1, z1, x2, z2] = s.r, ya = Y(s.a), yb = Y(s.b), n = Math.max(2, Math.round(Math.abs(yb - ya) / 0.19));
    const start = s.axis === 'x' ? x1 : z1, run = s.axis === 'x' ? x2 - x1 : z2 - z1;
    const tex = { top: 'flagstone', side: 'sandstone', bottom: 'nodraw' };
    for (let k = 0; k < n; k++) {
      const s0 = start + run * k / n, s1 = start + run * (k + 1) / n, y = ya + (yb - ya) * (k + 0.5) / n;
      brushes.push(s.axis === 'x' ? { t: 'box', min: [s0, -1, z1], max: [s1, y, z2], tex, group: s.name } : { t: 'box', min: [x1, -1, s0], max: [x2, y, s1], tex, group: s.name });
    }
    if (!s.noWalls) walls(s, s.y, null, TUNNEL.connects.includes(s.name) ? [...solidFloors, { pts: TUNNEL.pts }] : solidFloors);
  }

  // Underpass: floor and its own low walls, open only at the two staircases. Floors above it are its ceiling; slabs fill the gaps.
  const ty = Y(TUNNEL.u), opens = stairPolys.filter((s) => TUNNEL.connects.includes(s.name)), tun = { name: 'tunnel', pts: TUNNEL.pts };
  for (const tri of triangulate(TUNNEL.pts)) brushes.push({ t: 'prism', pts: tri, bottom: -1, top: ty, tex: { top: 'tile_terra', side: 'brick_pale', bottom: 'nodraw' }, group: 'tunnel floor' });
  for (const [x1, z1, x2, z2] of TUNNEL.slabs) brushes.push({ t: 'box', min: [x1, tunnelTop, z1], max: [x2, tunnelTop + 0.3, z2], tex: { top: 'nodraw', side: 'brick_pale', bottom: 'ceil_plain' }, roof: true });
  const before = brushes.length;
  walls(tun, ty, null, opens, tunnelTop);
  for (let i = before; i < brushes.length; i++) { brushes[i].tex.side = 'brick_pale'; delete brushes[i].wall; }  // navigation looks for floors under these

  for (const b of EXTRA) brushes.push(structuredClone(b));
  const lights = DECOR.filter((o) => o.t === 'lamp').map((o) => ({ x: o.x + 0.5, z: o.z + 0.5, color: [1.0, 0.85, 0.6], radius: 8, intensity: 1.5 }));
  return { version: 1, size, brushes, zones: ZONES, decor: DECOR, lights };
}
