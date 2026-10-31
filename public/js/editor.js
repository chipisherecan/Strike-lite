// In-game map editor, Hammer/Worldcraft style: maps are lists of brushes (boxes and ramps) edited in a
// 3D view (editor3d.js) or a top-down 2D view. Saved maps are written by the server into shared/mapdata/edits.js.
import { MAP_INFO, MATS, getMapSource, getOriginalSource, getRadarInfo, getTheme, buildWorldFromSource, isEdited } from '/shared/maps.js';
import { findPath } from '/shared/nav.js';
import { View3D, scaleBrush } from './editor3d.js';

const $ = (id) => document.getElementById(id);
const TEXTURES = [...MATS, 'nodraw'];
const DECOR_TYPES = ['lamp', 'palm', 'tree', 'doors', 'awning'];

const PRESETS = {
  wall: { label: 'Wall', bottom: -0.5, top: 8, tex: 'wall', flags: { wall: true } },
  floor: { label: 'Floor / platform', bottom: -1, top: 0, tex: 'floor', flags: {} },
  crate: { label: 'Crate (on the floor)', bottom: 0, top: 1.1, tex: 'crate', flags: { box: true } },
  roof: { label: 'Roof (above the floor)', bottom: 3.2, top: 4.4, tex: 'roof', flags: { roof: true } },
  custom: { label: 'Custom', bottom: 0, top: 3, tex: 'custom', flags: {} },
};

export class Editor {
  constructor(onExit) {
    this.onExit = onExit;
    this.tool = 'select';
    this.sel = new Set();          // selected brush indices
    this.selDecor = -1;
    this.view = { x: 0, z: 0, s: 6 }; // world point at canvas (0,0), pixels per metre
    this.opts = { snap: 0.5, radar: 0.35, roofs: true, preset: 'wall', bottom: -0.5, top: 8, texTop: 'limestone', texSide: 'limestone',
      rampLow: 0, rampHigh: 2, rampDir: 'E', zone: 'A', decor: 'lamp', decorMat: 'door', lightRadius: 7 };
    this.undoStack = []; this.redoStack = [];
    this.canvas = $('ed-canvas');
    this.g = this.canvas.getContext('2d');
    this.radarImg = null;
    this.bindUI();
  }

  // ------------------------------------------------------------ open / close
  open(mapId) {
    this.id = mapId;
    this.src = structuredClone(getMapSource(mapId));
    this.theme = getTheme(mapId);
    this.sel.clear(); this.selDecor = -1;
    this.undoStack = []; this.redoStack = [];
    this.opts.texTop = this.theme.wall; this.opts.texSide = this.theme.wall;
    $('editor').classList.remove('hidden');
    $('ed-map').value = mapId;
    this.resize();
    const [w, h] = this.src.size;
    this.view.s = Math.min(this.canvas.width / (w + 4), this.canvas.height / (h + 4));
    this.view.x = -2; this.view.z = -2;
    this.loadRadar();
    this.applyPreset(this.opts.preset);
    this.renderProps();
    this.open3D();
    this.status(isEdited(mapId) ? 'Editing your saved version of this map.' : 'Editing the original map. Save to keep your changes.');
    fetch('/api/editor-status').then(r => r.json()).then(j => { this.canSave = j.canSave; if (!j.canSave) this.status('Viewing only: maps can only be saved on the PC that runs the server.', true); }).catch(() => {});
    this.draw();
  }

  close() {
    this.close3D();
    $('editor').classList.add('hidden');
    this.onExit();
  }

  loadRadar() {
    this.radarImg = null;
    const info = getRadarInfo(this.id);
    if (!info) return;
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => { this.radarImg = img; this.radarInfo = info; this.draw(); };
    img.src = 'https://raw.githubusercontent.com/MurkyYT/cs2-map-icons/main/images/radars/' + info.file;
  }

  status(text, bad) { const s = $('ed-status'); s.textContent = text; s.style.color = bad ? '#ff8a7a' : '#9fd39a'; }

  // ------------------------------------------------------------ brush helpers
  bounds(b) {
    if (b.t === 'prism') {
      const xs = b.pts.map(p => p[0]), zs = b.pts.map(p => p[1]);
      return { x0: Math.min(...xs), z0: Math.min(...zs), x1: Math.max(...xs), z1: Math.max(...zs), bottom: b.bottom, top: b.top, low: b.top };
    }
    if (b.t === 'slope') {
      const tops = [[b.x0, b.z0], [b.x1, b.z0], [b.x0, b.z1], [b.x1, b.z1]].map(([x, z]) => b.a + b.sx * x + b.sz * z);
      return { x0: b.x0, z0: b.z0, x1: b.x1, z1: b.z1, bottom: b.bottom, top: Math.max(...tops), low: Math.min(...tops) };
    }
    return { x0: b.min[0], z0: b.min[2], x1: b.max[0], z1: b.max[2], bottom: b.min[1], top: b.max[1], low: b.max[1] };
  }
  move(b, dx, dy, dz) {
    if (b.t === 'prism') {
      for (const p of b.pts) { p[0] += dx; p[1] += dz; }
      b.bottom += dy; b.top += dy;
      if (b.plane) b.plane.a += dy - b.plane.sx * dx - b.plane.sz * dz;
    } else if (b.t === 'slope') { b.x0 += dx; b.x1 += dx; b.z0 += dz; b.z1 += dz; b.bottom += dy; b.a += dy - b.sx * dx - b.sz * dz; }
    else { b.min[0] += dx; b.max[0] += dx; b.min[1] += dy; b.max[1] += dy; b.min[2] += dz; b.max[2] += dz; }
  }
  setFootprint(b, x0, z0, x1, z1) {
    if (x1 - x0 < 0.1 || z1 - z0 < 0.1) return;
    if (b.t === 'prism') {
      const k = this.bounds(b);
      scaleBrush(b, [1, 0], [k.x0, 0, k.z0], (x1 - x0) / (k.x1 - k.x0));
      scaleBrush(b, [0, 1], [k.x0, 0, k.z0], (z1 - z0) / (k.z1 - k.z0));
      this.move(b, x0 - k.x0, 0, z0 - k.z0);
    } else if (b.t === 'slope') { b.x0 = x0; b.z0 = z0; b.x1 = x1; b.z1 = z1; }
    else { b.min[0] = x0; b.min[2] = z0; b.max[0] = x1; b.max[2] = z1; }
  }
  slopeParams(b) {
    const { x0, z0, x1, z1 } = b;
    const h = (x, z) => b.a + b.sx * x + b.sz * z;
    if (Math.abs(b.sx * (x1 - x0)) >= Math.abs(b.sz * (z1 - z0))) {
      const hw = h(x0, (z0 + z1) / 2), he = h(x1, (z0 + z1) / 2);
      return he >= hw ? { dir: 'E', low: hw, high: he } : { dir: 'W', low: he, high: hw };
    }
    const hn = h((x0 + x1) / 2, z0), hs = h((x0 + x1) / 2, z1);
    return hs >= hn ? { dir: 'S', low: hn, high: hs } : { dir: 'N', low: hs, high: hn };
  }
  makeSlope(x0, z0, x1, z1, bottom, low, high, dir, tex) {
    let sx = 0, sz = 0, a;
    if (dir === 'E') { sx = (high - low) / (x1 - x0); a = low - sx * x0; }
    else if (dir === 'W') { sx = -(high - low) / (x1 - x0); a = high - sx * x0; }
    else if (dir === 'S') { sz = (high - low) / (z1 - z0); a = low - sz * z0; }
    else { sz = -(high - low) / (z1 - z0); a = high - sz * z0; }
    return { t: 'slope', x0, z0, x1, z1, bottom, a, sx, sz, tex };
  }
  setSlope(b, low, high, dir) { Object.assign(b, this.makeSlope(b.x0, b.z0, b.x1, b.z1, b.bottom, low, high, dir, b.tex)); }
  texName(kind) { return kind === 'wall' ? this.theme.wall : kind === 'floor' ? this.theme.floor : kind; }

  // ------------------------------------------------------------ undo
  snapshot() {
    this.undoStack.push(structuredClone({ brushes: this.src.brushes, zones: this.src.zones, decor: this.src.decor, lights: this.src.lights }));
    if (this.undoStack.length > 60) this.undoStack.shift();
    this.redoStack = [];
    this.dirty = true;
  }
  restore(from, to) {
    if (!from.length) return;
    to.push(structuredClone({ brushes: this.src.brushes, zones: this.src.zones, decor: this.src.decor, lights: this.src.lights }));
    Object.assign(this.src, from.pop());
    this.sel.clear(); this.selDecor = -1;
    this.changed();
  }
  changed() {
    if (this.view3d) for (const i of this.sel) if (this.src.brushes[i]) this.view3d.invalidate(this.src.brushes[i]);
    this.renderProps(); this.draw();
    if (this.view3d) this.view3d.rebuild();
  }

  // ------------------------------------------------------------ coordinates
  toWorld(px, py) { return { x: this.view.x + px / this.view.s, z: this.view.z + py / this.view.s }; }
  toScreen(x, z) { return { x: (x - this.view.x) * this.view.s, y: (z - this.view.z) * this.view.s }; }
  snap(v) { const s = this.opts.snap; return Math.round(v / s) * s; }

  resize() {
    const r = this.canvas.parentElement.getBoundingClientRect();
    this.canvas.width = Math.max(200, r.width | 0); this.canvas.height = Math.max(200, r.height | 0);
  }

  // ------------------------------------------------------------ picking
  pick(x, z) {
    let best = -1, bestTop = -Infinity, bestArea = Infinity;
    this.src.brushes.forEach((b, i) => {
      if (b.roof && !this.opts.roofs) return;
      const k = this.bounds(b);
      if (x < k.x0 || x > k.x1 || z < k.z0 || z > k.z1) return;
      const area = (k.x1 - k.x0) * (k.z1 - k.z0);
      if (k.top > bestTop + 0.05 || (Math.abs(k.top - bestTop) <= 0.05 && area < bestArea)) { best = i; bestTop = k.top; bestArea = area; }
    });
    return best;
  }
  // Height of the walkable floor at (x, z): the highest non-wall, non-roof brush there.
  floorUnder(x, z) {
    if (this.view3d) return this.view3d.floorAt(x, z);
    let best = -Infinity;
    for (const b of this.src.brushes) {
      if (b.roof || b.wall) continue;
      const k = this.bounds(b);
      if (x < k.x0 || x > k.x1 || z < k.z0 || z > k.z1) continue;
      best = Math.max(best, b.t === 'slope' ? b.a + b.sx * x + b.sz * z : k.top);
    }
    return isFinite(best) ? best : 0;
  }

  // Selects what was clicked, the whole named part unless `single` (Alt) is held.
  pickPart(i, add, single) {
    this.selDecor = -1;
    if (i < 0) { if (!add) this.sel.clear(); this.renderProps(); return; }
    const name = this.src.brushes[i].group, part = [];
    if (name && !single) this.src.brushes.forEach((b, n) => { if (b.group === name) part.push(n); }); else part.push(i);
    if (!add) this.sel.clear();
    const off = add && this.sel.has(i);
    for (const n of part) if (off) this.sel.delete(n); else this.sel.add(n);
    this.renderProps();
  }

  pickDecor(x, z) {
    let best = -1, bd = 0.9;
    (this.src.decor || []).forEach((d, i) => {
      const c = this.decorCenter(d), dist = Math.hypot(c.x - x, c.z - z);
      if (dist < bd) { bd = dist; best = i; }
    });
    return best;
  }
  decorCenter(d) {
    if (d.t === 'doors') return d.axis === 'x' ? { x: (d.a + d.b) / 2, z: d.at } : { x: d.at, z: (d.a + d.b) / 2 };
    if (d.t === 'awning') return { x: (d.x1 + d.x2 + 1) / 2, z: (d.z1 + d.z2 + 1) / 2 };
    return { x: d.x + 0.5, z: d.z + 0.5 };
  }
  handleAt(px, py) {
    if (this.sel.size !== 1) return null;
    const k = this.bounds(this.src.brushes[[...this.sel][0]]);
    const pts = { nw: [k.x0, k.z0], ne: [k.x1, k.z0], sw: [k.x0, k.z1], se: [k.x1, k.z1], n: [(k.x0 + k.x1) / 2, k.z0], s: [(k.x0 + k.x1) / 2, k.z1], w: [k.x0, (k.z0 + k.z1) / 2], e: [k.x1, (k.z0 + k.z1) / 2] };
    for (const [name, [x, z]] of Object.entries(pts)) {
      const s = this.toScreen(x, z);
      if (Math.abs(s.x - px) < 7 && Math.abs(s.y - py) < 7) return name;
    }
    return null;
  }

  // ------------------------------------------------------------ drawing
  heightColor(h) {
    // like the CS radar: teal (low) -> grey -> tan/olive (high)
    const t = Math.max(0, Math.min(1, (h + 1) / 9));
    const stops = [[40, 92, 104], [92, 98, 100], [150, 128, 92], [190, 160, 110]];
    const f = t * (stops.length - 1), i = Math.min(stops.length - 2, Math.floor(f)), u = f - i;
    return stops[i].map((v, k) => Math.round(v + (stops[i + 1][k] - v) * u));
  }

  draw() {
    if (this.view3d) return;
    const g = this.g, W = this.canvas.width, H = this.canvas.height, s = this.view.s;
    g.fillStyle = '#111316'; g.fillRect(0, 0, W, H);
    // radar underlay
    if (this.radarImg && this.opts.radar > 0) {
      const info = this.radarInfo, ppc = info.pxPerCell;
      const o = this.toScreen(-info.x0 / ppc, -info.y0 / ppc);
      g.globalAlpha = this.opts.radar;
      g.imageSmoothingEnabled = true;
      g.drawImage(this.radarImg, o.x, o.y, this.radarImg.width / ppc * s, this.radarImg.height / ppc * s);
      g.globalAlpha = 1;
    }
    // grid
    const step = s * 1 < 4 ? 10 : s < 12 ? 5 : 1;
    const w0 = this.toWorld(0, 0), w1 = this.toWorld(W, H);
    g.lineWidth = 1;
    for (let x = Math.floor(w0.x / step) * step; x <= w1.x; x += step) {
      const p = this.toScreen(x, 0).x;
      g.strokeStyle = x % 10 === 0 ? 'rgba(255,255,255,0.12)' : 'rgba(255,255,255,0.05)';
      g.beginPath(); g.moveTo(p, 0); g.lineTo(p, H); g.stroke();
    }
    for (let z = Math.floor(w0.z / step) * step; z <= w1.z; z += step) {
      const p = this.toScreen(0, z).y;
      g.strokeStyle = z % 10 === 0 ? 'rgba(255,255,255,0.12)' : 'rgba(255,255,255,0.05)';
      g.beginPath(); g.moveTo(0, p); g.lineTo(W, p); g.stroke();
    }
    // brushes, lowest first
    const order = this.src.brushes.map((b, i) => [this.bounds(b), b, i]).sort((a, b) => a[0].top - b[0].top);
    const alpha = this.radarImg && this.opts.radar > 0.5 ? 0.55 : 0.92;
    for (const [k, b, i] of order) {
      const p0 = this.toScreen(k.x0, k.z0), p1 = this.toScreen(k.x1, k.z1);
      if (p1.x < 0 || p1.y < 0 || p0.x > W || p0.y > H) continue;
      if (b.roof) {
        if (!this.opts.roofs) continue;
        g.fillStyle = 'rgba(220,70,60,0.22)';
        g.fillRect(p0.x, p0.y, p1.x - p0.x, p1.y - p0.y);
        g.strokeStyle = 'rgba(255,110,90,0.6)'; g.setLineDash([4, 3]);
        g.strokeRect(p0.x + 0.5, p0.y + 0.5, p1.x - p0.x - 1, p1.y - p0.y - 1);
        g.setLineDash([]);
        continue;
      }
      let col = b.wall || k.top > 6 ? [34, 36, 40] : b.box ? [128, 92, 52] : this.heightColor(k.top);
      g.fillStyle = `rgba(${col[0]},${col[1]},${col[2]},${alpha})`;
      g.fillRect(p0.x, p0.y, p1.x - p0.x, p1.y - p0.y);
      if (b.t === 'slope' && Math.min(p1.x - p0.x, p1.y - p0.y) > 14) {
        // arrow pointing uphill
        const sp = this.slopeParams(b), cx = (p0.x + p1.x) / 2, cy = (p0.y + p1.y) / 2;
        const dir = { E: [1, 0], W: [-1, 0], S: [0, 1], N: [0, -1] }[sp.dir];
        const L = Math.min(p1.x - p0.x, p1.y - p0.y) * 0.35;
        g.strokeStyle = 'rgba(255,255,255,0.7)'; g.beginPath();
        g.moveTo(cx - dir[0] * L, cy - dir[1] * L); g.lineTo(cx + dir[0] * L, cy + dir[1] * L);
        g.lineTo(cx + dir[0] * L * 0.5 - dir[1] * L * 0.4, cy + dir[1] * L * 0.5 + dir[0] * L * 0.4); g.stroke();
      }
      if (s > 5) { g.strokeStyle = 'rgba(0,0,0,0.35)'; g.strokeRect(p0.x + 0.5, p0.y + 0.5, p1.x - p0.x - 1, p1.y - p0.y - 1); }
      void i;
    }
    // zones
    const zc = { A: '#ff8a3a', B: '#ff8a3a', T: '#e3c04b', CT: '#6fa8dc' };
    for (const [name, r] of Object.entries(this.src.zones)) {
      const p0 = this.toScreen(r[0], r[1]), p1 = this.toScreen(r[2], r[3]);
      g.strokeStyle = zc[name]; g.lineWidth = 2; g.strokeRect(p0.x, p0.y, p1.x - p0.x, p1.y - p0.y); g.lineWidth = 1;
      g.fillStyle = zc[name]; g.font = 'bold 13px Arial'; g.fillText(name === 'T' ? 'T spawn' : name === 'CT' ? 'CT spawn' : 'Site ' + name, p0.x + 4, p0.y + 15);
    }
    // decorations and lights
    (this.src.decor || []).forEach((d, i) => {
      const c = this.toScreen(this.decorCenter(d).x, this.decorCenter(d).z);
      g.fillStyle = i === this.selDecor ? '#ffe14d' : { lamp: '#ffd36b', palm: '#6fcf6f', tree: '#4caf50', doors: '#7fb3ff', awning: '#ff7f7f' }[d.t] || '#fff';
      if (d.t === 'doors') {
        const a = d.axis === 'x' ? this.toScreen(d.a, d.at) : this.toScreen(d.at, d.a), b2 = d.axis === 'x' ? this.toScreen(d.b, d.at) : this.toScreen(d.at, d.b);
        g.strokeStyle = g.fillStyle; g.lineWidth = 3; g.beginPath(); g.moveTo(a.x, a.y); g.lineTo(b2.x, b2.y); g.stroke(); g.lineWidth = 1;
      } else if (d.t === 'awning') {
        const p0 = this.toScreen(d.x1, d.z1), p1 = this.toScreen(d.x2 + 1, d.z2 + 1);
        g.globalAlpha = 0.5; g.fillRect(p0.x, p0.y, p1.x - p0.x, p1.y - p0.y); g.globalAlpha = 1;
      } else { g.beginPath(); g.arc(c.x, c.y, Math.max(3, s * 0.35), 0, 7); g.fill(); }
    });
    for (const l of this.src.lights || []) {
      const c = this.toScreen(l.x, l.z);
      g.strokeStyle = 'rgba(255,220,120,0.5)'; g.beginPath(); g.arc(c.x, c.y, l.radius * s, 0, 7); g.stroke();
    }
    // selection
    for (const i of this.sel) {
      const k = this.bounds(this.src.brushes[i]);
      const p0 = this.toScreen(k.x0, k.z0), p1 = this.toScreen(k.x1, k.z1);
      g.strokeStyle = '#ffe14d'; g.lineWidth = 2; g.strokeRect(p0.x, p0.y, p1.x - p0.x, p1.y - p0.y); g.lineWidth = 1;
      if (this.sel.size === 1) {
        g.fillStyle = '#ffe14d';
        for (const [x, z] of [[k.x0, k.z0], [k.x1, k.z0], [k.x0, k.z1], [k.x1, k.z1], [(k.x0 + k.x1) / 2, k.z0], [(k.x0 + k.x1) / 2, k.z1], [k.x0, (k.z0 + k.z1) / 2], [k.x1, (k.z0 + k.z1) / 2]]) {
          const p = this.toScreen(x, z); g.fillRect(p.x - 4, p.y - 4, 8, 8);
        }
      }
    }
    // rubber band for tools that drag a rectangle / line
    if (this.drag && this.drag.rect) {
      const r = this.drag.rect, p0 = this.toScreen(Math.min(r.x0, r.x1), Math.min(r.z0, r.z1)), p1 = this.toScreen(Math.max(r.x0, r.x1), Math.max(r.z0, r.z1));
      g.strokeStyle = '#fff'; g.setLineDash([5, 4]); g.strokeRect(p0.x, p0.y, p1.x - p0.x, p1.y - p0.y); g.setLineDash([]);
      g.fillStyle = '#fff'; g.font = '12px Arial';
      g.fillText(`${Math.abs(r.x1 - r.x0).toFixed(1)} x ${Math.abs(r.z1 - r.z0).toFixed(1)} m`, p1.x + 6, p1.y + 14);
    }
  }

  // ------------------------------------------------------------ mouse
  bindCanvas() {
    const c = this.canvas;
    c.addEventListener('contextmenu', (e) => e.preventDefault());
    c.addEventListener('wheel', (e) => {
      e.preventDefault();
      const r = c.getBoundingClientRect(), px = e.clientX - r.left, py = e.clientY - r.top;
      const before = this.toWorld(px, py);
      this.view.s = Math.max(1.5, Math.min(80, this.view.s * (e.deltaY < 0 ? 1.15 : 1 / 1.15)));
      const after = this.toWorld(px, py);
      this.view.x += before.x - after.x; this.view.z += before.z - after.z;
      this.draw();
    }, { passive: false });
    c.addEventListener('mousedown', (e) => this.onDown(e));
    window.addEventListener('mousemove', (e) => this.onMove(e));
    window.addEventListener('mouseup', (e) => this.onUp(e));
  }

  evPos(e) { const r = this.canvas.getBoundingClientRect(); const px = e.clientX - r.left, py = e.clientY - r.top; return { px, py, ...this.toWorld(px, py) }; }

  onDown(e) {
    if ($('editor').classList.contains('hidden')) return;
    const p = this.evPos(e);
    if (e.button === 1 || e.button === 2) { this.drag = { pan: true, sx: e.clientX, sy: e.clientY, vx: this.view.x, vz: this.view.z }; return; }
    const sx = this.snap(p.x), sz = this.snap(p.z);
    if (this.tool === 'select') {
      const h = this.handleAt(p.px, p.py);
      if (h) { this.snapshot(); const i = [...this.sel][0]; this.drag = { resize: h, i, k: this.bounds(this.src.brushes[i]) }; return; }
      const di = this.pickDecor(p.x, p.z);
      if (di >= 0) { this.selDecor = di; this.sel.clear(); this.snapshot(); this.drag = { decor: di, lx: sx, lz: sz }; this.renderProps(); this.draw(); return; }
      const bi = this.pick(p.x, p.z);
      this.selDecor = -1;
      if (bi >= 0) {
        if (e.shiftKey || !this.sel.has(bi)) this.pickPart(bi, e.shiftKey, e.altKey);
        this.snapshot();
        this.drag = { move: true, lx: sx, lz: sz, moved: false };
      } else {
        if (!e.shiftKey) this.sel.clear();
        this.drag = { marquee: true, rect: { x0: p.x, z0: p.z, x1: p.x, z1: p.z } };
      }
      this.renderProps(); this.draw();
      return;
    }
    if (this.placeAt(p.x, p.z)) return;
    // rectangle tools: box, ramp, zone, doors, awning
    this.drag = { rect: { x0: sx, z0: sz, x1: sx, z1: sz } };
  }

  // Click-to-place tools. Returns false for tools that drag a rectangle instead.
  placeAt(x, z) {
    if (this.tool === 'decor' && this.opts.decor !== 'doors' && this.opts.decor !== 'awning') {
      this.snapshot();
      this.src.decor = this.src.decor || [];
      this.src.decor.push({ t: this.opts.decor, x: Math.floor(x), z: Math.floor(z) });
      this.changed();
      return true;
    }
    if (this.tool === 'light') {
      this.snapshot();
      this.src.lights = this.src.lights || [];
      this.src.lights.push({ x: this.snap(x), z: this.snap(z), color: [1, 0.85, 0.6], radius: this.opts.lightRadius, intensity: 1.4 });
      this.changed();
      return true;
    }
    return false;
  }

  moveDecor(o, dx, dz) {
    if (o.t === 'doors') { if (o.axis === 'x') { o.a += dx; o.b += dx; o.at += dz; } else { o.a += dz; o.b += dz; o.at += dx; } }
    else if (o.t === 'awning') { o.x1 += dx; o.x2 += dx; o.z1 += dz; o.z2 += dz; }
    else { o.x += dx; o.z += dz; }
  }

  onMove(e) {
    if (this.view3d || $('editor').classList.contains('hidden')) return;
    const p = this.evPos(e);
    const info = $('ed-info');
    const bi = this.pick(p.x, p.z);
    let txt = `x ${p.x.toFixed(1)}  z ${p.z.toFixed(1)}`;
    if (bi >= 0) { const k = this.bounds(this.src.brushes[bi]), b = this.src.brushes[bi]; txt += `   |   brush #${bi}: ${b.t}${b.wall ? ' (wall)' : b.roof ? ' (roof)' : b.box ? ' (box)' : ''}  bottom ${k.bottom.toFixed(2)}  top ${k.top.toFixed(2)}  ${typeof b.tex === 'object' ? b.tex.top + ' / ' + b.tex.side : b.tex}`; }
    info.textContent = txt;
    const d = this.drag;
    if (!d) { this.canvas.style.cursor = this.tool === 'select' && this.handleAt(p.px, p.py) ? 'nwse-resize' : this.tool === 'select' ? 'default' : 'crosshair'; return; }
    if (d.pan) { this.view.x = d.vx - (e.clientX - d.sx) / this.view.s; this.view.z = d.vz - (e.clientY - d.sy) / this.view.s; this.draw(); return; }
    const sx = this.snap(p.x), sz = this.snap(p.z);
    if (d.rect) { d.rect.x1 = d.marquee ? p.x : sx; d.rect.z1 = d.marquee ? p.z : sz; this.draw(); return; }
    if (d.move) {
      const dx = sx - d.lx, dz = sz - d.lz;
      if (dx || dz) { for (const i of this.sel) this.move(this.src.brushes[i], dx, 0, dz); d.lx = sx; d.lz = sz; d.moved = true; this.draw(); }
      return;
    }
    if (d.decor !== undefined) {
      const dx = sx - d.lx, dz = sz - d.lz;
      if (dx || dz) {
        this.moveDecor(this.src.decor[d.decor], dx, dz);
        d.lx = sx; d.lz = sz; this.draw();
      }
      return;
    }
    if (d.resize) {
      const k = d.k, b = this.src.brushes[d.i];
      let { x0, z0, x1, z1 } = k;
      if (d.resize.includes('w')) x0 = Math.min(sx, x1 - this.opts.snap);
      if (d.resize.includes('e')) x1 = Math.max(sx, x0 + this.opts.snap);
      if (d.resize.includes('n')) z0 = Math.min(sz, z1 - this.opts.snap);
      if (d.resize.includes('s')) z1 = Math.max(sz, z0 + this.opts.snap);
      this.setFootprint(b, x0, z0, x1, z1);
      this.draw();
    }
  }

  onUp() {
    const d = this.drag;
    this.drag = null;
    if (!d || d.pan) return;
    if (d.move || d.resize || d.decor !== undefined) {
      if (d.move && !d.moved) this.undoStack.pop(); // a plain click selected something: nothing to undo
      this.changed();
      return;
    }
    if (!d.rect) return;
    const r = d.rect, x0 = Math.min(r.x0, r.x1), x1 = Math.max(r.x0, r.x1), z0 = Math.min(r.z0, r.z1), z1 = Math.max(r.z0, r.z1);
    if (d.marquee) {
      this.src.brushes.forEach((b, i) => { const k = this.bounds(b); if (k.x0 >= x0 && k.x1 <= x1 && k.z0 >= z0 && k.z1 <= z1 && (this.opts.roofs || !b.roof)) this.sel.add(i); });
      this.renderProps(); this.draw();
      return;
    }
    this.finishRect(r);
  }

  // Creates what a rectangle tool drew. `base` is the height of the surface it was drawn on in the 3D view.
  finishRect(r, base) {
    const x0 = Math.min(r.x0, r.x1), x1 = Math.max(r.x0, r.x1), z0 = Math.min(r.z0, r.z1), z1 = Math.max(r.z0, r.z1);
    if (this.tool === 'decor') {
      if (Math.max(x1 - x0, z1 - z0) < 0.5) { this.draw(); return; }
      this.snapshot();
      this.src.decor = this.src.decor || [];
      if (this.opts.decor === 'doors') {
        const alongX = x1 - x0 >= z1 - z0;
        this.src.decor.push(alongX ? { t: 'doors', axis: 'x', a: x0, b: x1, at: r.z0, open: 1, mat: this.opts.decorMat } : { t: 'doors', axis: 'z', a: z0, b: z1, at: r.x0, open: 1, mat: this.opts.decorMat });
      } else {
        this.src.decor.push({ t: 'awning', x1: Math.floor(x0), z1: Math.floor(z0), x2: Math.max(Math.floor(x0), Math.ceil(x1) - 1), z2: Math.max(Math.floor(z0), Math.ceil(z1) - 1), h: 2.8, mat: 'cloth_red' });
      }
      this.changed();
      return;
    }
    if (x1 - x0 < 0.1 || z1 - z0 < 0.1) { this.draw(); return; }
    this.snapshot();
    if (this.tool === 'zone') {
      this.src.zones[this.opts.zone] = [x0, z0, x1, z1];
    } else if (this.tool === 'box') {
      const pr = PRESETS[this.opts.preset];
      // crates and roofs are placed relative to the floor under them
      let bottom = this.opts.bottom, top = this.opts.top;
      if (this.opts.preset === 'crate' || this.opts.preset === 'roof') {
        const floor = this.floorUnder((x0 + x1) / 2, (z0 + z1) / 2);
        bottom += floor; top += floor;
      } else if (base !== undefined && this.opts.preset !== 'custom') { bottom += base; top += base; }
      const b = { t: 'box', min: [x0, bottom, z0], max: [x1, top, z1], tex: { top: this.opts.texTop, side: this.opts.texSide, bottom: pr.flags.roof ? this.theme.ceil : 'nodraw' } };
      Object.assign(b, pr.flags);
      this.src.brushes.push(b);
      this.sel.clear(); this.sel.add(this.src.brushes.length - 1);
    } else if (this.tool === 'ramp') {
      const up = base || 0;
      const b = this.makeSlope(x0, z0, x1, z1, Math.min(this.opts.rampLow, this.opts.rampHigh) - 1 + up, this.opts.rampLow + up, this.opts.rampHigh + up, this.opts.rampDir, { top: this.opts.texTop, side: this.opts.texSide, bottom: 'nodraw' });
      this.src.brushes.push(b);
      this.sel.clear(); this.sel.add(this.src.brushes.length - 1);
    }
    this.changed();
  }

  // ------------------------------------------------------------ keyboard
  onKey(e) {
    if ($('editor').classList.contains('hidden') || (this.view3d && this.view3d.flyKey(e))) return;
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
    const k = e.key.toLowerCase();
    if (this.view3d && !e.ctrlKey) {
      if (k === '1') return this.view3d.setMode('move');
      if (k === '2') return this.view3d.setMode('resize');
      if (k === 'f') return this.view3d.focus();
    }
    if ((e.ctrlKey || e.metaKey) && k === 'z') { e.preventDefault(); this.restore(this.undoStack, this.redoStack); return; }
    if ((e.ctrlKey || e.metaKey) && (k === 'y' || (e.shiftKey && k === 'z'))) { e.preventDefault(); this.restore(this.redoStack, this.undoStack); return; }
    if ((e.ctrlKey || e.metaKey) && k === 'd') { e.preventDefault(); this.duplicate(); return; }
    if (k === 'delete' || k === 'backspace') { e.preventDefault(); this.deleteSel(); return; }
    if (k === 'escape') { this.sel.clear(); this.selDecor = -1; this.renderProps(); this.draw(); if (this.view3d) this.view3d.rebuild(); return; }
    const nudge = { arrowleft: [-1, 0, 0], arrowright: [1, 0, 0], arrowup: [0, 0, -1], arrowdown: [0, 0, 1], pageup: [0, 1, 0], pagedown: [0, -1, 0] }[k];
    if (nudge && this.sel.size) {
      e.preventDefault();
      this.snapshot();
      const s = nudge[1] ? 0.25 : this.opts.snap;
      for (const i of this.sel) this.move(this.src.brushes[i], nudge[0] * s, nudge[1] * s, nudge[2] * s);
      this.changed();
      return;
    }
    const tools = { s: 'select', b: 'box', r: 'ramp', z: 'zone', d: 'decor', l: 'light' };
    if (tools[k] && !e.ctrlKey) this.setTool(tools[k]);
  }

  deleteSel() {
    if (this.selDecor >= 0) { this.snapshot(); this.src.decor.splice(this.selDecor, 1); this.selDecor = -1; this.changed(); return; }
    if (!this.sel.size) return;
    this.snapshot();
    this.src.brushes = this.src.brushes.filter((b, i) => !this.sel.has(i));
    this.sel.clear();
    this.changed();
  }

  duplicate() {
    if (!this.sel.size) return;
    this.snapshot();
    const copies = [...this.sel].map(i => structuredClone(this.src.brushes[i])), stamp = Date.now().toString(36);
    this.sel.clear();
    for (const c of copies) { if (c.group) c.group = c.group.split('~')[0] + '~' + stamp; this.move(c, this.opts.snap * 2, 0, this.opts.snap * 2); this.src.brushes.push(c); this.sel.add(this.src.brushes.length - 1); }
    this.changed();
  }

  setTool(t) {
    this.tool = t;
    document.querySelectorAll('[data-edtool]').forEach(b => b.classList.toggle('on', b.dataset.edtool === t));
    this.renderProps();
  }

  applyPreset(name) {
    const pr = PRESETS[name];
    this.opts.preset = name;
    if (name === 'custom') return;
    this.opts.bottom = pr.bottom; this.opts.top = pr.top;
    if (name === 'floor') { this.opts.texTop = this.theme.floor; this.opts.texSide = this.theme.wall; }
    else if (name === 'crate') { this.opts.texTop = 'crate'; this.opts.texSide = 'crate'; }
    else if (name === 'roof') { this.opts.texTop = 'roof'; this.opts.texSide = this.theme.wall; }
    else { this.opts.texTop = this.theme.wall; this.opts.texSide = this.theme.wall; }
  }

  // ------------------------------------------------------------ properties panel
  renderProps() {
    const el = $('ed-props'), o = this.opts;
    const texSel = (id, val) => `<select id="${id}">${TEXTURES.map(t => `<option ${t === val ? 'selected' : ''}>${t}</option>`).join('')}</select>`;
    const num = (id, val, step = 0.25) => `<input id="${id}" type="number" step="${step}" value="${+(+val).toFixed(3)}">`;
    let h = '<h3>View</h3>';
    h += `<label>Grid snap <select id="ep-snap">${[0.25, 0.5, 1, 2].map(v => `<option ${v === o.snap ? 'selected' : ''}>${v}</option>`).join('')}</select></label>`;
    h += `<label>CS2 radar underlay <input id="ep-radar" type="range" min="0" max="1" step="0.05" value="${o.radar}"></label>`;
    h += `<label><input id="ep-roofs" type="checkbox" ${o.roofs ? 'checked' : ''}> Show roofs</label>`;
    h += `<h3>Tool: ${{ select: 'Select / move', box: 'Box brush', ramp: 'Ramp / stairs', zone: 'Zones', decor: 'Decorations', light: 'Lights' }[this.tool]}</h3>`;
    if (this.tool === 'box') {
      h += `<label>Preset <select id="ep-preset">${Object.entries(PRESETS).map(([k, p]) => `<option value="${k}" ${k === o.preset ? 'selected' : ''}>${p.label}</option>`).join('')}</select></label>`;
      h += `<div class="ep-row"><label>Bottom ${num('ep-bottom', o.bottom)}</label><label>Top ${num('ep-top', o.top)}</label></div>`;
      h += `<label>Top texture ${texSel('ep-textop', o.texTop)}</label><label>Side texture ${texSel('ep-texside', o.texSide)}</label>`;
      h += '<p class="hint">Drag a rectangle to create the brush. In 3D it starts on the surface you drag from.</p>';
    } else if (this.tool === 'ramp') {
      h += `<div class="ep-row"><label>Low end ${num('ep-low', o.rampLow)}</label><label>High end ${num('ep-high', o.rampHigh)}</label></div>`;
      h += `<label>Rises towards <select id="ep-dir">${['N', 'E', 'S', 'W'].map(d => `<option ${d === o.rampDir ? 'selected' : ''}>${d}</option>`).join('')}</select></label>`;
      h += `<label>Top texture ${texSel('ep-textop', o.texTop)}</label><label>Side texture ${texSel('ep-texside', o.texSide)}</label>`;
      h += '<p class="hint">Drag a rectangle. N = up on the screen. Slopes up to about 45° can be walked up.</p>';
    } else if (this.tool === 'zone') {
      h += `<label>Zone <select id="ep-zone">${['A', 'B', 'T', 'CT'].map(z => `<option value="${z}" ${z === o.zone ? 'selected' : ''}>${z === 'T' ? 'T spawn' : z === 'CT' ? 'CT spawn' : 'Bombsite ' + z}</option>`).join('')}</select></label>`;
      h += '<p class="hint">Drag a rectangle to set where the zone is. Spawn points are picked inside the spawn zones automatically.</p>';
    } else if (this.tool === 'decor') {
      h += `<label>Type <select id="ep-decor">${DECOR_TYPES.map(d => `<option ${d === o.decor ? 'selected' : ''}>${d}</option>`).join('')}</select></label>`;
      if (o.decor === 'doors') h += `<label>Door texture <select id="ep-decormat">${['door', 'door_blue', 'wood'].map(d => `<option ${d === o.decorMat ? 'selected' : ''}>${d}</option>`).join('')}</select></label>`;
      h += `<p class="hint">${o.decor === 'doors' ? 'Drag across a doorway to add a pair of open doors.' : o.decor === 'awning' ? 'Drag a rectangle for the awning.' : 'Click to place. Lamps only show under a roof.'}</p>`;
    } else if (this.tool === 'light') {
      h += `<label>Radius ${num('ep-lightr', o.lightRadius, 0.5)}</label><p class="hint">Click to add a light (baked into the lightmaps). Select a light by deleting/re-adding for now.</p>`;
    } else {
      h += (this.view3d ? '<p class="hint">Click a part to select it, Shift+click for more, Alt+click for one piece of a part. <b>1</b> Move: drag the arrows. <b>2</b> Resize: drag a yellow square. Hold Shift to ignore the grid. <b>F</b> goes to the selection.</p>' : '<p class="hint">Click a brush to select it. Shift+click adds to the selection, drag on empty space to box-select. Drag to move, drag the square handles to resize.</p>');
    }
    // selection
    if (this.selDecor >= 0) {
      const d = this.src.decor[this.selDecor];
      h += `<h3>Decoration: ${d.t}</h3>`;
      if (d.t === 'doors') h += `<label>Open towards <select id="ep-dopen"><option value="1" ${d.open > 0 ? 'selected' : ''}>+ side</option><option value="-1" ${d.open < 0 ? 'selected' : ''}>- side</option></select></label>`;
      h += '<button id="ep-del">Delete</button>';
    } else if (this.sel.size) {
      const list = [...this.sel].map(i => this.src.brushes[i]);
      h += `<h3>Selected: ${list.length} brush${list.length > 1 ? 'es' : ''}</h3>`;
      if (list.length === 1) {
        const b = list[0], k = this.bounds(b);
        h += `<div class="ep-row"><label>X from ${num('es-x0', k.x0)}</label><label>to ${num('es-x1', k.x1)}</label></div>`;
        h += `<div class="ep-row"><label>Z from ${num('es-z0', k.z0)}</label><label>to ${num('es-z1', k.z1)}</label></div>`;
        if (b.t === 'box' || (b.t === 'prism' && !b.plane)) h += `<div class="ep-row"><label>Bottom ${num('es-bottom', k.bottom)}</label><label>Top ${num('es-top', k.top)}</label></div>`;
        else if (b.t === 'prism') h += `<div class="ep-row"><label>Bottom ${num('es-bottom', k.bottom)}</label></div>`;
        else {
          const sp = this.slopeParams(b);
          h += `<div class="ep-row"><label>Bottom ${num('es-bottom', k.bottom)}</label></div>`;
          h += `<div class="ep-row"><label>Low ${num('es-low', sp.low)}</label><label>High ${num('es-high', sp.high)}</label></div>`;
          h += `<label>Rises towards <select id="es-dir">${['N', 'E', 'S', 'W'].map(d => `<option ${d === sp.dir ? 'selected' : ''}>${d}</option>`).join('')}</select></label>`;
        }
      }
      const t0 = typeof list[0].tex === 'object' ? list[0].tex : { top: list[0].tex, side: list[0].tex, bottom: list[0].tex };
      h += `<label>Top texture ${texSel('es-textop', t0.top)}</label><label>Side texture ${texSel('es-texside', t0.side)}</label><label>Bottom texture ${texSel('es-texbot', t0.bottom || 'nodraw')}</label>`;
      h += `<div class="ep-flags"><label><input type="checkbox" id="es-wall" ${list[0].wall ? 'checked' : ''}> Wall</label><label><input type="checkbox" id="es-roof" ${list[0].roof ? 'checked' : ''}> Roof</label><label><input type="checkbox" id="es-box" ${list[0].box ? 'checked' : ''}> Box</label><label><input type="checkbox" id="es-clip" ${list[0].clip ? 'checked' : ''}> Player clip</label></div>`;
      h += '<div class="ep-row"><button id="es-up">Raise +0.25</button><button id="es-down">Lower -0.25</button></div>';
      h += '<div class="ep-row"><button id="es-dup">Duplicate (Ctrl+D)</button><button id="es-del">Delete (Del)</button></div>';
      if (list.length === 1 && list[0].t === 'box') h += '<button id="es-toramp">Turn into ramp</button>';
    }
    el.innerHTML = h;
    this.bindProps();
  }

  bindProps() {
    const o = this.opts, on = (id, ev, fn) => { const e = $(id); if (e) e.addEventListener(ev, fn); };
    on('ep-snap', 'change', (e) => { o.snap = +e.target.value; });
    on('ep-radar', 'input', (e) => { o.radar = +e.target.value; this.draw(); });
    on('ep-roofs', 'change', (e) => { o.roofs = e.target.checked; this.draw(); if (this.view3d) this.view3d.rebuild(); });
    on('ep-preset', 'change', (e) => { this.applyPreset(e.target.value); this.renderProps(); });
    on('ep-bottom', 'change', (e) => { o.bottom = +e.target.value; o.preset = 'custom'; });
    on('ep-top', 'change', (e) => { o.top = +e.target.value; o.preset = 'custom'; });
    on('ep-textop', 'change', (e) => { o.texTop = e.target.value; });
    on('ep-texside', 'change', (e) => { o.texSide = e.target.value; });
    on('ep-low', 'change', (e) => { o.rampLow = +e.target.value; });
    on('ep-high', 'change', (e) => { o.rampHigh = +e.target.value; });
    on('ep-dir', 'change', (e) => { o.rampDir = e.target.value; });
    on('ep-zone', 'change', (e) => { o.zone = e.target.value; });
    on('ep-decor', 'change', (e) => { o.decor = e.target.value; this.renderProps(); });
    on('ep-decormat', 'change', (e) => { o.decorMat = e.target.value; });
    on('ep-lightr', 'change', (e) => { o.lightRadius = +e.target.value; });
    on('ep-del', 'click', () => this.deleteSel());
    on('ep-dopen', 'change', (e) => { this.snapshot(); this.src.decor[this.selDecor].open = +e.target.value; this.changed(); });
    // selection edits
    const sel = () => [...this.sel].map(i => this.src.brushes[i]);
    const edit = (fn) => { this.snapshot(); for (const b of sel()) fn(b); this.changed(); };
    const val = (id) => +$(id).value;
    const fp = () => edit((b) => this.setFootprint(b, val('es-x0'), val('es-z0'), val('es-x1'), val('es-z1')));
    for (const id of ['es-x0', 'es-x1', 'es-z0', 'es-z1']) on(id, 'change', fp);
    on('es-bottom', 'change', () => edit((b) => { if (b.t === 'box') b.min[1] = Math.min(val('es-bottom'), b.max[1] - 0.05); else b.bottom = val('es-bottom'); }));
    on('es-top', 'change', () => edit((b) => { if (b.t === 'box') b.max[1] = Math.max(val('es-top'), b.min[1] + 0.05); else if (b.t === 'prism') b.top = Math.max(val('es-top'), b.bottom + 0.05); }));
    const slope = () => edit((b) => { if (b.t === 'slope') this.setSlope(b, val('es-low'), val('es-high'), $('es-dir').value); });
    for (const id of ['es-low', 'es-high', 'es-dir']) on(id, 'change', slope);
    const tex = (part) => (e) => edit((b) => { b.tex = typeof b.tex === 'object' ? { ...b.tex } : { top: b.tex, side: b.tex, bottom: b.tex }; b.tex[part] = e.target.value; });
    on('es-textop', 'change', tex('top')); on('es-texside', 'change', tex('side')); on('es-texbot', 'change', tex('bottom'));
    for (const f of ['wall', 'roof', 'box', 'clip']) on('es-' + f, 'change', (e) => edit((b) => { if (e.target.checked) b[f] = true; else delete b[f]; }));
    on('es-up', 'click', () => edit((b) => this.move(b, 0, 0.25, 0)));
    on('es-down', 'click', () => edit((b) => this.move(b, 0, -0.25, 0)));
    on('es-dup', 'click', () => this.duplicate());
    on('es-del', 'click', () => this.deleteSel());
    on('es-toramp', 'click', () => edit((b) => {
      const k = this.bounds(b);
      Object.assign(b, this.makeSlope(k.x0, k.z0, k.x1, k.z1, k.bottom, Math.max(k.bottom + 0.05, k.top - 1), k.top, 'E', b.tex));
      delete b.min; delete b.max;
    }));
  }

  // ------------------------------------------------------------ check / save
  check() {
    try {
      const map = buildWorldFromSource(this.id, this.src);
      const res = [];
      const t = map.spawns.T[0], ct = map.spawns.CT[0];
      if (!t || !ct) { this.status('Spawn zones have no standing room. Draw the T and CT spawn zones over open floor.', true); return false; }
      const ok = (a, b) => !!findPath(map, a, b);
      const checks = { 'T spawn → CT spawn': ok(t, ct), 'T spawn → A': ok(t, map.siteCenter.A), 'T spawn → B': ok(t, map.siteCenter.B), 'CT spawn → A': ok(ct, map.siteCenter.A), 'CT spawn → B': ok(ct, map.siteCenter.B) };
      for (const [k, v] of Object.entries(checks)) res.push(`${v ? '✔' : '✘'} ${k}`);
      res.push(`${map.spawns.T.length} T spawns, ${map.spawns.CT.length} CT spawns, ${map.brushes.length} brushes`);
      const good = Object.values(checks).every(Boolean);
      this.status(res.join('   '), !good);
      return good;
    } catch (e) {
      this.status('Check failed: ' + e.message, true);
      return false;
    }
  }

  async save(reset) {
    if (!this.canSave) { this.status('Maps can only be saved on the PC that runs the server.', true); return; }
    if (!reset) {
      // grow the map size to fit everything that was built
      let mx = 0, mz = 0;
      for (const b of this.src.brushes) { const k = this.bounds(b); mx = Math.max(mx, k.x1); mz = Math.max(mz, k.z1); }
      this.src.size = [Math.max(this.src.size[0], Math.ceil(mx) + 1), Math.max(this.src.size[1], Math.ceil(mz) + 1)];
      if (!this.check() && !confirm('The check found problems (see the bar at the top). Save anyway?')) return;
    } else if (!confirm('Throw away all your edits to this map and go back to the original?')) return;
    this.status('Saving…');
    try {
      const r = await fetch('/api/mapedit/' + this.id, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: this.password, source: reset ? null : this.src }) });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || r.statusText);
      this.dirty = false;
      if (reset) { this.src = structuredClone(getOriginalSource(this.id)); this.sel.clear(); this.changed(); }
      this.status(reset ? 'Map reset to the original. Reload the page (F5) to play it.' : 'Saved! New lobbies use this version. Reload the page (F5) before playing it.');
    } catch (e) {
      this.status('Save failed: ' + e.message, true);
    }
  }

  // ------------------------------------------------------------ 3D view
  open3D() {
    if (this.view3d) { this.close3D(); this.resize(); this.renderProps(); this.draw(); return; }
    this.view3d = new View3D(this);
    $('ed-modes').classList.remove('hidden');
    $('ed-3d').textContent = 'Top-down 2D';
    this.renderProps();
    this.status('Hold the right mouse button to look, with WASD to fly and Q/E down/up. Wheel moves forward and back.');
  }

  close3D() {
    const v = this.view3d;
    if (!v) return;
    this.view3d = null;
    v.dispose();
    $('ed-modes').classList.add('hidden');
    $('ed-3d').textContent = '3D view';
  }

  // ------------------------------------------------------------ toolbar wiring
  bindUI() {
    $('ed-map').innerHTML = MAP_INFO.map(m => `<option value="${m.id}">${m.name}</option>`).join('');
    $('ed-map').onchange = (e) => {
      if (this.dirty && !confirm('Switch maps and lose your unsaved changes?')) { e.target.value = this.id; return; }
      this.dirty = false; this.close3D(); this.open(e.target.value);
    };
    $('ed-undo').onclick = () => this.restore(this.undoStack, this.redoStack);
    $('ed-redo').onclick = () => this.restore(this.redoStack, this.undoStack);
    $('ed-3d').onclick = () => this.open3D();
    $('ed-check').onclick = () => this.check();
    $('ed-save').onclick = () => this.save(false);
    $('ed-reset').onclick = () => this.save(true);
    $('ed-exit').onclick = () => {
      if (this.dirty && !confirm('Leave the editor? Unsaved changes will be lost.')) return;
      this.dirty = false;
      this.close();
    };
    document.querySelectorAll('[data-edmode]').forEach(b => b.onclick = () => this.view3d && this.view3d.setMode(b.dataset.edmode));
    $('ed-help').onclick = () => $('ed-helpbox').classList.toggle('hidden');
    document.querySelectorAll('[data-edtool]').forEach(b => b.onclick = () => this.setTool(b.dataset.edtool));
    window.addEventListener('keydown', (e) => this.onKey(e));
    window.addEventListener('resize', () => { if (!$('editor').classList.contains('hidden')) { this.resize(); this.draw(); if (this.view3d) this.view3d.resize(); } });
    this.bindCanvas();
  }
}
