// Walks a simulated player along the bot navigation paths from each spawn to each bombsite (with the same
// step/jump rules bots use) and reports any spot where it gets stuck. Run: node tools/walk-test.js
import { getMap, MAP_IDS } from '../shared/maps.js';
import { findPath, walkClear, zoneSpots } from '../shared/nav.js';
import { moveBody, groundHeight, JUMP_V } from '../shared/physics.js';

let bad = 0;
for (const id of MAP_IDS) {
  const m = getMap(id);
  const site = (s) => { const spots = zoneSpots(m, m.zoneRects[s]); return spots[Math.floor(spots.length / 2)] || m.siteCenter[s]; };
  for (const [label, from, to] of [['T->A', m.spawns.T[0], site('A')], ['T->B', m.spawns.T[0], site('B')], ['CT->A', m.spawns.CT[0], site('A')], ['CT->B', m.spawns.CT[0], site('B')], ['T->CT', m.spawns.T[0], m.spawns.CT[0]]]) {
    const p = findPath(m, from, to);
    if (!p) { console.log(id, label, 'NO PATH'); bad++; continue; }
    const pos = { ...from }, vel = { x: 0, y: 0, z: 0 };
    let wi = 0, stuck = 0, onG = true, t = 0, res = 'ok';
    for (; t < 4000 && wi < p.length; t++) {
      while (wi < p.length - 1 && walkClear(m, pos, p[wi + 1])) wi++;
      const w = p[wi], dx = w.x - pos.x, dz = w.z - pos.z, d = Math.hypot(dx, dz);
      if (d < 0.35) { wi++; continue; }
      vel.x = dx / d * 5; vel.z = dz / d * 5;
      if (onG) { const rise = groundHeight(m, pos.x + dx / d * 0.6, pos.y, pos.z + dz / d * 0.6, 0.2, 1.0) - pos.y; if (rise > 0.42 && rise < 1.0) vel.y = JUMP_V; }
      vel.y -= 20 / 30;
      const before = { ...pos };
      onG = moveBody(m, pos, vel, 1 / 30, 0.35, 1.8);
      if (Math.hypot(pos.x - before.x, pos.z - before.z) < 0.01) {
        if (++stuck === 20) { res = `STUCK at ${pos.x.toFixed(1)},${pos.y.toFixed(1)},${pos.z.toFixed(1)} heading to ${w.x},${w.y.toFixed(1)},${w.z}`; break; }
      } else stuck = 0;
    }
    if (res !== 'ok') bad++;
    console.log(id.padEnd(8), label.padEnd(6), res.padEnd(12), `${(t / 30).toFixed(1)}s`);
  }
}
console.log(bad ? `\n${bad} problem route(s)` : '\nAll routes walkable');
process.exit(bad ? 1 : 0);
