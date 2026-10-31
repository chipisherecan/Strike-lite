// Bot navigation for brush maps. Samples every 1 m column for standing spots (several levels per column, so
// rooms above tunnels work), links neighbours a bot can walk/step/jump/drop between, and runs A* over that graph.
import { trace, triUp } from './brush.js';
import { boxBlocked, groundHeight } from './physics.js';

const R = 0.3;
const ZERO_H = 0.01;
const RM = 0.36;  // imported maps: a little wider than a player, so paths don't scrape poles and corners
const JITTER = [[0, 0], [-0.27, -0.27], [0.27, -0.27], [-0.27, 0.27], [0.27, 0.27]];

export function getNav(map) {
  if (!map.nav) map.nav = buildNav(map);
  return map.nav;
}

function buildNav(map) {
  const W = map.w, H = map.h;
  const nodes = [], cols = new Array(W * H);
  for (let cz = 0; cz < H; cz++) for (let cx = 0; cx < W; cx++) {
    const x = cx + 0.5, z = cz + 0.5, list = [];
    if (map.mesh) {
      // imported maps: every upward surface thin rays pass through, if a bot fits there. Five rays per metre, so a
      // corridor that misses the middle of the column is still found; one spot per level.
      for (const [ox, oz] of JITTER) {
        const px = x + ox, pz = z + oz;
        let y0 = 44;
        for (let k = 0; k < 24; k++) {
          const tr = trace(map, [px, y0, pz], [px, -5, pz], [0, 0, 0]);
          if (tr.fraction >= 1 || !tr.brush) break;
          const b = tr.brush, y = tr.end[1];
          y0 = (b.tri === undefined ? b.min[1] : y) - 0.03;
          if ((b.tri === undefined ? tr.normal[1] : triUp(map.mesh, b.tri)) < 0.7) continue;
          if (list.some(j => Math.abs(nodes[j].y - y) < 0.35)) continue;
          if (boxBlocked(map, px, y + 0.32, pz, RM, 1.43)) continue;   // lifted: real ground slopes and has small lips
          list.push(nodes.length);
          nodes.push({ x: px, y, z: pz, col: cz * W + cx });
        }
      }
      cols[cz * W + cx] = list;
      continue;
    }
    let startY = 40;
    for (let k = 0; k < 4; k++) {
      const tr = trace(map, [x, startY, z], [x, -5, z], [R, ZERO_H, R]);
      if (tr.fraction >= 1 || tr.startsolid || !tr.brush) break;
      const b = tr.brush;
      if (b.flags.wall) break;
      const y = tr.end[1] - ZERO_H;
      if (!b.flags.roof && tr.normal[1] >= 0.7 && !boxBlocked(map, x, y + 0.05, z, R, 1.75)) {
        list.push(nodes.length);
        nodes.push({ x, y, z, col: cz * W + cx });
      }
      startY = b.min[1] - 0.05;
      if (startY < -1) break;
    }
    cols[cz * W + cx] = list;
  }
  const edges = nodes.map(() => []);
  for (let i = 0; i < nodes.length; i++) {
    const a = nodes[i], cx = Math.floor(a.x), cz = Math.floor(a.z);
    for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
      if (!dx && !dz) continue;
      const nx = cx + dx, nz = cz + dz;
      if (nx < 0 || nz < 0 || nx >= W || nz >= H) continue;
      for (const j of cols[nz * W + nx]) {
        const b = nodes[j], dy = b.y - a.y;
        if (dy > 0.9 || dy < -4) continue;
        // sweep a standing box between the two spots, just above the higher floor
        // (imported maps: lifted by a step, since real floors have lips and curbs that players walk over)
        const lift = map.mesh ? 0.46 : 0.06, half = (1.75 - lift + 0.06) / 2, y = Math.max(a.y, b.y) + lift + half;
        const tr = trace(map, [a.x, y, a.z], [b.x, y, b.z], map.mesh ? [RM, half, RM] : [R, half, R]);
        if (tr.fraction < 1 || tr.startsolid) continue;
        const cost = Math.hypot(b.x - a.x, b.z - a.z) + (dy > 0.45 ? 1.5 : 0) + (dy < -1.2 ? 1 : 0);
        edges[i].push(j, cost);
      }
    }
  }
  return { nodes, cols, edges, W, H };
}

export function nearestNode(nav, x, y, z) {
  const cx = Math.floor(x), cz = Math.floor(z);
  let best = -1, bd = Infinity;
  for (let r = 0; r <= 4 && best < 0; r++) {
    for (let dz = -r; dz <= r; dz++) for (let dx = -r; dx <= r; dx++) {
      if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
      const nx = cx + dx, nz = cz + dz;
      if (nx < 0 || nz < 0 || nx >= nav.W || nz >= nav.H) continue;
      for (const j of nav.cols[nz * nav.W + nx]) {
        const n = nav.nodes[j];
        const d = Math.abs(n.y - y) * 2 + Math.hypot(n.x - x, n.z - z) + (n.y > y + 1 ? 5 : 0);
        if (d < bd) { bd = d; best = j; }
      }
    }
  }
  return best;
}

// A* from a world position to a world position. Returns waypoints [{x,y,z}] or null.
export function findPath(map, from, to) {
  const nav = getNav(map);
  const s = nearestNode(nav, from.x, from.y, from.z), g = nearestNode(nav, to.x, to.y ?? from.y, to.z);
  if (s < 0 || g < 0) return null;
  const N = nav.nodes.length;
  const gs = new Float32Array(N).fill(Infinity), came = new Int32Array(N).fill(-1), closed = new Uint8Array(N);
  const goal = nav.nodes[g];
  const hh = (i) => Math.hypot(nav.nodes[i].x - goal.x, nav.nodes[i].z - goal.z);
  const heap = [];
  const push = (i, f) => { heap.push([f, i]); let k = heap.length - 1; while (k > 0) { const p = (k - 1) >> 1; if (heap[p][0] <= heap[k][0]) break; [heap[p], heap[k]] = [heap[k], heap[p]]; k = p; } };
  const pop = () => { const top = heap[0], last = heap.pop(); if (heap.length) { heap[0] = last; let k = 0; for (;;) { const l = 2 * k + 1, r = l + 1; let m = k; if (l < heap.length && heap[l][0] < heap[m][0]) m = l; if (r < heap.length && heap[r][0] < heap[m][0]) m = r; if (m === k) break; [heap[m], heap[k]] = [heap[k], heap[m]]; k = m; } } return top; };
  gs[s] = 0; push(s, hh(s));
  let found = false, iter = 0;
  while (heap.length && iter++ < 60000) {
    const [, i] = pop();
    if (closed[i]) continue;
    closed[i] = 1;
    if (i === g) { found = true; break; }
    const e = nav.edges[i];
    for (let k = 0; k < e.length; k += 2) {
      const j = e[k], c = gs[i] + e[k + 1];
      if (c < gs[j]) { gs[j] = c; came[j] = i; push(j, c + hh(j)); }
    }
  }
  if (!found) return null;
  const path = [];
  for (let i = g; i !== -1; i = came[i]) path.push({ x: nav.nodes[i].x, y: nav.nodes[i].y, z: nav.nodes[i].z });
  path.reverse();
  if (path.length) path[path.length - 1] = { x: to.x, y: goal.y, z: to.z };
  return path;
}

// Can a bot walk straight from a to b? (no walls, no ledges higher than a step, no big drops)
export function walkClear(map, a, b) {
  const d = Math.hypot(b.x - a.x, b.z - a.z);
  if (d < 0.01) return true;
  // a standing box lifted by one step height must fit all the way (blocks walls and ledges taller than a step)
  const y = a.y + 0.45 + 0.7;
  const tr = trace(map, [a.x, y, a.z], [b.x, y, b.z], [R + 0.05, 0.6, R + 0.05]);
  if (tr.fraction < 1 || tr.startsolid) return false;
  // the ground along the way must be continuous (no big steps or drops) and arrive at b's height
  const n = Math.max(1, Math.ceil(d / 0.5));
  let prev = a.y;
  for (let k = 1; k <= n; k++) {
    const x = a.x + (b.x - a.x) * k / n, z = a.z + (b.z - a.z) * k / n;
    const g = groundHeight(map, x, prev, z, 0.08, 0.45); // thin probe: catches drops right next to the path
    if (g < -10 || g - prev > 0.45 || prev - g > 0.6) return false;
    prev = g;
  }
  return Math.abs(prev - b.y) < 0.45;
}

// Standing spots inside a zone rect [x1,z1,x2,z2].
export function zoneSpots(map, r) {
  const nav = getNav(map);
  if (!nav.zoneCache) nav.zoneCache = new Map();
  const key = r.join(',');
  if (nav.zoneCache.has(key)) return nav.zoneCache.get(key);
  // only ground bots can reach: the top of a big crate also looks like open ground
  if (!nav.reachable) {
    nav.reachable = new Uint8Array(nav.nodes.length);
    const s = map.spawns ? map.spawns.T[0] : null, start = s ? nearestNode(nav, s.x, s.y, s.z) : -1, stack = start >= 0 ? [start] : [];
    if (start >= 0) nav.reachable[start] = 1;
    while (stack.length) {
      const e = nav.edges[stack.pop()];
      for (let k = 0; k < e.length; k += 2) if (!nav.reachable[e[k]]) { nav.reachable[e[k]] = 1; stack.push(e[k]); }
    }
  }
  // edges hold (node, cost) pairs: 12+ entries = 6+ walkable neighbours, i.e. open ground away from walls and boxes
  const out = nav.nodes.filter((n, i) => nav.reachable[i] && n.x >= r[0] && n.x < r[2] && n.z >= r[1] && n.z < r[3] && nav.edges[i].length >= 12);
  nav.zoneCache.set(key, out);
  return out;
}
