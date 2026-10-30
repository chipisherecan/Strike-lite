// Bot navigation for brush maps. Samples every 1 m column for standing spots (several levels per column, so
// rooms above tunnels work), links neighbours a bot can walk/step/jump/drop between, and runs A* over that graph.
import { trace } from './brush.js';
import { boxBlocked, groundHeight } from './physics.js';

const R = 0.3;
const ZERO_H = 0.01;

export function getNav(map) {
  if (!map.nav) map.nav = buildNav(map);
  return map.nav;
}

function buildNav(map) {
  const W = map.w, H = map.h;
  const nodes = [], cols = new Array(W * H);
  for (let cz = 0; cz < H; cz++) for (let cx = 0; cx < W; cx++) {
    const x = cx + 0.5, z = cz + 0.5, list = [];
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
        const y = Math.max(a.y, b.y) + 0.06 + 0.875;
        const tr = trace(map, [a.x, y, a.z], [b.x, y, b.z], [R, 0.875, R]);
        if (tr.fraction < 1 || tr.startsolid) continue;
        const cost = Math.hypot(dx, dz) + (dy > 0.45 ? 1.5 : 0) + (dy < -1.2 ? 1 : 0);
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
  // edges hold (node, cost) pairs: 12+ entries = 6+ walkable neighbours, i.e. open ground away from walls and boxes
  const out = nav.nodes.filter((n, i) => n.x >= r[0] && n.x < r[2] && n.z >= r[1] && n.z < r[3] && nav.edges[i].length >= 12);
  nav.zoneCache.set(key, out);
  return out;
}
