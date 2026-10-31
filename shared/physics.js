// Player movement, traces, hitboxes and grenades on top of the brush world (shared by server and client).
import { trace, slideMove, stepSlideMove, groundTrace } from './brush.js';

export const PLAYER_R = 0.35;
export const STAND_H = 1.8, CROUCH_H = 1.25;
export const EYE_STAND = 1.62, EYE_CROUCH = 1.1;
export const GRAVITY = 20;
export const JUMP_V = 7.4;           // 54 units (1.37 m) high, the same as a Counter-Strike standing jump
export const STEP = 0.45;            // GoldSrc stepsize is 18 units
const WALKABLE = 0.7;                // floors steeper than ~45 degrees are walls

const ZERO = [0, 0, 0];

// Is a player-sized box (feet at y) intersecting the world?
export function boxBlocked(map, x, y, z, r, hgt) {
  const c = [x, y + hgt / 2, z];
  return trace(map, c, c, [r, hgt / 2, r]).startsolid;
}

// Feet height of the ground below (x, y+step, z) for a box of radius r. Returns -50 if there is none.
export function groundHeight(map, x, y, z, r, step = STEP) {
  const top = y + step + 0.02;
  const tr = trace(map, [x, top, z], [x, top - 60, z], [r, 0.01, r]);
  return tr.fraction < 1 ? tr.end[1] - 0.01 : -50;
}

// Move a player-sized body. pos (feet) / vel {x,y,z} are mutated. Callers apply gravity themselves.
// Returns true when standing on walkable ground after the move.
export function moveBody(map, pos, vel, dt, r, hgt) {
  const ext = [r, hgt / 2, r];
  const p = [pos.x, pos.y + hgt / 2, pos.z];
  const v = [vel.x, vel.y, vel.z];
  // unstick if we start inside something (spawned in a brush, stood up under a ledge, ...)
  if (trace(map, p, p, ext).startsolid) {
    for (let k = 1; k <= 10; k++) {
      const q = [p[0], p[1] + k * 0.06, p[2]];
      if (!trace(map, q, q, ext).startsolid) { p[1] = q[1]; break; }
    }
  }
  const g0 = groundTrace(map, p, ext);
  const onGround0 = g0.fraction < 1 && g0.normal[1] >= WALKABLE && v[1] <= 0.5;
  if (onGround0) {
    if (v[1] < 0) v[1] = 0;
    stepSlideMove(map, p, v, dt, ext, STEP);
    // stick to the ground when walking down stairs and slopes
    if (v[1] <= 0) {
      const d = trace(map, p, [p[0], p[1] - STEP - 0.05, p[2]], ext);
      if (d.fraction < 1 && d.normal[1] >= WALKABLE && !d.allsolid) p[1] = d.end[1];
    }
  } else {
    slideMove(map, p, v, dt, ext);
  }
  const g1 = groundTrace(map, p, ext);
  const onGround = g1.fraction < 1 && g1.normal[1] >= WALKABLE && v[1] <= 0.5;
  if (onGround && v[1] < 0) v[1] = 0;
  pos.x = p[0]; pos.y = p[1] - hgt / 2; pos.z = p[2];
  vel.x = v[0]; vel.y = v[1]; vel.z = v[2];
  return onGround;
}

// Ray vs world. dir must be normalized. Returns {dist, x,y,z, nx,ny,nz, brush, plane} or null.
export function raycastWorld(map, ox, oy, oz, dx, dy, dz, maxDist = 200) {
  const tr = trace(map, [ox, oy, oz], [ox + dx * maxDist, oy + dy * maxDist, oz + dz * maxDist], ZERO);
  if (tr.fraction >= 1) return null;
  const dist = tr.fraction * maxDist;
  const n = tr.normal || [0, 1, 0];
  return { dist, x: ox + dx * dist, y: oy + dy * dist, z: oz + dz * dist, nx: n[0], ny: n[1], nz: n[2], brush: tr.brush, plane: tr.plane };
}

export function lineOfSight(map, a, b) {
  const tr = trace(map, [a.x, a.y, a.z], [b.x, b.y, b.z], ZERO);
  return tr.fraction >= 0.999;
}

// Hitboxes for a player standing with feet at (x,y,z).
export function hitboxes(x, y, z, crouch) {
  const s = crouch ? 0.69 : 1;
  return [
    { group: 'head', min: [x - 0.14, y + 1.5 * s, z - 0.14], max: [x + 0.14, y + 1.8 * s, z + 0.14] },
    { group: 'chest', min: [x - 0.26, y + 1.08 * s, z - 0.18], max: [x + 0.26, y + 1.5 * s, z + 0.18] },
    { group: 'stomach', min: [x - 0.24, y + 0.84 * s, z - 0.16], max: [x + 0.24, y + 1.08 * s, z + 0.16] },
    { group: 'legs', min: [x - 0.24, y, z - 0.15], max: [x + 0.24, y + 0.84 * s, z + 0.15] },
  ];
}

export function rayAABB(ox, oy, oz, dx, dy, dz, min, max) {
  let tmin = 0, tmax = Infinity;
  const o = [ox, oy, oz], d = [dx, dy, dz];
  for (let i = 0; i < 3; i++) {
    if (Math.abs(d[i]) < 1e-9) { if (o[i] < min[i] || o[i] > max[i]) return -1; continue; }
    let t1 = (min[i] - o[i]) / d[i], t2 = (max[i] - o[i]) / d[i];
    if (t1 > t2) { const tmp = t1; t1 = t2; t2 = tmp; }
    if (t1 > tmin) tmin = t1;
    if (t2 < tmax) tmax = t2;
    if (tmin > tmax) return -1;
  }
  return tmin;
}

// Ray vs players [{id, x,y,z, crouch}]. Returns nearest {id, group, dist} or null.
export function raycastPlayers(players, ox, oy, oz, dx, dy, dz, maxDist, ignoreId) {
  let best = null;
  for (const p of players) {
    if (p.id === ignoreId) continue;
    const along = (p.x - ox) * dx + (p.z - oz) * dz;
    if (along < -1 || along > maxDist + 1) continue;
    for (const hb of hitboxes(p.x, p.y, p.z, p.crouch)) {
      const t = rayAABB(ox, oy, oz, dx, dy, dz, hb.min, hb.max);
      if (t >= 0 && t <= maxDist && (!best || t < best.dist)) best = { id: p.id, group: hb.group, dist: t };
    }
  }
  return best;
}

// Does the segment a-b pass through a smoke cloud?
export function smokeBlocks(smokes, a, b) {
  const dx = b.x - a.x, dy = b.y - a.y, dz = b.z - a.z;
  const len2 = dx * dx + dy * dy + dz * dz;
  for (const s of smokes) {
    const r = 3.2;
    let t = ((s.x - a.x) * dx + (s.y + 1.2 - a.y) * dy + (s.z - a.z) * dz) / (len2 || 1);
    t = Math.max(0, Math.min(1, t));
    const qx = a.x + dx * t - s.x, qy = a.y + dy * t - (s.y + 1.2), qz = a.z + dz * t - s.z;
    if (qx * qx + qy * qy + qz * qz < r * r) return true;
  }
  return false;
}

// Deterministic grenade flight (bounces off brush planes), sampled at 30 Hz.
export const NADE_DT = 1 / 30;
export function simulateGrenade(map, pos, vel, type) {
  const p = [pos.x, pos.y, pos.z], v = [vel.x, vel.y, vel.z];
  const path = [{ x: p[0], y: p[1], z: p[2] }];
  const fuse = type === 'smoke' ? 3.0 : 1.6;
  const ext = [0.06, 0.06, 0.06], sub = 4, sdt = NADE_DT / sub;
  let t = 0, still = 0;
  while (t < fuse) {
    for (let s = 0; s < sub; s++) {
      v[1] -= GRAVITY * 0.75 * sdt;
      let left = sdt;
      for (let bump = 0; bump < 3 && left > 0; bump++) {
        const end = [p[0] + v[0] * left, p[1] + v[1] * left, p[2] + v[2] * left];
        const tr = trace(map, p, end, ext);
        if (tr.allsolid) { v[0] = v[1] = v[2] = 0; break; }
        p[0] = tr.end[0]; p[1] = tr.end[1]; p[2] = tr.end[2];
        if (tr.fraction >= 1) break;
        left -= left * tr.fraction;
        const n = tr.normal, vn = v[0] * n[0] + v[1] * n[1] + v[2] * n[2];
        // reflect with energy loss, extra friction when hitting the floor
        v[0] -= 1.45 * vn * n[0]; v[1] -= 1.45 * vn * n[1]; v[2] -= 1.45 * vn * n[2];
        const f = n[1] > 0.7 ? 0.7 : 0.85;
        v[0] *= f; v[2] *= f;
        if (n[1] > 0.7 && Math.abs(v[1]) < 1.2) v[1] = 0;
      }
    }
    t += NADE_DT;
    path.push({ x: p[0], y: p[1], z: p[2] });
    if (Math.hypot(v[0], v[1], v[2]) < 0.3) still += NADE_DT; else still = 0;
    if (type === 'smoke' && still > 0.4) break;
  }
  return { path, time: t, end: path[path.length - 1] };
}
