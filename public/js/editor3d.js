// The map editor's 3D view: fly around, click parts, move them with a gizmo and resize them by dragging face handles.
// Tools that draw a rectangle (box, ramp, zones...) work here too, on the surface where the drag starts.
import * as THREE from 'three';
import { makeBrushFromSource, realMesh } from '/shared/maps.js';
import { brushPolygons, trace } from '/shared/brush.js';
import { surfaceTexture, TEX_SCALE } from './textures.js';
import { TransformControls } from './vendor/TransformControls.js';

const $ = (id) => document.getElementById(id);
const HANDLE_PX = 12;

// Stretch a brush by s along a horizontal unit axis u (or along y when u is null), keeping `p` fixed. Sloped tops stay planes.
export function scaleBrush(b, u, p, s) {
  if (!u) {
    const Y = (y) => p[1] + (y - p[1]) * s;
    if (b.t === 'box') { b.min[1] = Y(b.min[1]); b.max[1] = Y(b.max[1]); }
    else {
      b.bottom = Y(b.bottom);
      const tilt = b.t === 'slope' ? b : b.plane;
      if (tilt) { tilt.a = Y(tilt.a); tilt.sx *= s; tilt.sz *= s; }
      if (b.t === 'prism') b.top = Y(b.top);
    }
    return b;
  }
  const X = (x, z) => { const d = (x - p[0]) * u[0] + (z - p[2]) * u[1]; return [x + (s - 1) * d * u[0], z + (s - 1) * d * u[1]]; };
  const tilted = (t) => {
    const h = t.a + t.sx * p[0] + t.sz * p[2], gu = t.sx * u[0] + t.sz * u[1], k = (1 / s - 1) * gu;
    t.sx += k * u[0]; t.sz += k * u[1]; t.a = h - t.sx * p[0] - t.sz * p[2];
  };
  if (b.t === 'prism') {
    b.pts = b.pts.map(q => X(q[0], q[1]));
    if (b.plane) tilted(b.plane);
  } else if (b.t === 'slope') {
    [b.x0, b.z0] = X(b.x0, b.z0); [b.x1, b.z1] = X(b.x1, b.z1);
    tilted(b);
  } else {
    [b.min[0], b.min[2]] = X(b.min[0], b.min[2]); [b.max[0], b.max[2]] = X(b.max[0], b.max[2]);
  }
  return b;
}

export class View3D {
  constructor(ed) {
    this.ed = ed;
    this.mode = 'move';
    this.cache = new WeakMap();    // source brush -> compiled brush and face arrays
    this.hidden = new Set();       // brushes being dragged are drawn from `live` instead of the static meshes
    this.keys = new Set();
    this.host = $('ed-3dview');
    this.host.classList.remove('hidden');
    const r = this.host.getBoundingClientRect();
    const renderer = this.renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(Math.min(1, window.devicePixelRatio));
    renderer.setSize(r.width, r.height);
    this.host.appendChild(renderer.domElement);
    const el = this.el = renderer.domElement;
    const scene = this.scene = new THREE.Scene();
    scene.background = new THREE.Color(ed.theme.skyHorizon);
    scene.add(new THREE.HemisphereLight(0xdfe8f0, 0x6b5a45, 2.2));
    const sun = new THREE.DirectionalLight(0xfff0d8, 2.4); sun.position.set(...ed.theme.sun); scene.add(sun);
    const cam = this.cam = new THREE.PerspectiveCamera(70, r.width / r.height, 0.1, 600);
    cam.rotation.order = 'YXZ';
    const [w, h] = ed.src.size;
    this.yaw = 0; this.pitch = -0.85;
    cam.position.set(w / 2, Math.max(w, h) * 0.55, h / 2 + Math.max(w, h) * 0.5);

    this.proxy = new THREE.Object3D(); scene.add(this.proxy);
    const tc = this.tc = new TransformControls(cam, el);
    tc.setMode('translate'); tc.setSize(0.9);
    tc.addEventListener('mouseDown', () => this.startMove());
    tc.addEventListener('objectChange', () => this.onGizmo());
    tc.addEventListener('mouseUp', () => this.endMove());
    scene.add(tc);

    this.outline = new THREE.LineSegments(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color: 0xffe14d, depthTest: false, transparent: true, opacity: 0.85 }));
    this.outline.renderOrder = 8; this.outline.frustumCulled = false; scene.add(this.outline);
    this.handles = [];
    const hm = new THREE.MeshBasicMaterial({ color: 0xffe14d, depthTest: false });
    for (let i = 0; i < 6; i++) { const m = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), hm); m.renderOrder = 9; m.visible = false; scene.add(m); this.handles.push(m); }
    this.band = new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints([0, 1, 2, 3].map(() => new THREE.Vector3())), new THREE.LineBasicMaterial({ color: 0xffffff, depthTest: false }));
    this.band.visible = false; this.band.frustumCulled = false; scene.add(this.band);

    this.onDown = (e) => this.pointerDown(e);
    this.onMove = (e) => this.pointerMove(e);
    this.onUp = (e) => this.pointerUp(e);
    this.onWheel = (e) => { e.preventDefault(); cam.position.addScaledVector(this.forward(), e.deltaY < 0 ? 4 : -4); };
    this.onKeyUp = (e) => { this.keys.delete(e.code); this.shift = e.shiftKey; };
    this.onKeyDown = (e) => { this.shift = e.shiftKey; };
    el.addEventListener('pointerdown', this.onDown);   // after TransformControls' own listener, so tc.dragging is already set
    el.addEventListener('wheel', this.onWheel, { passive: false });
    el.addEventListener('contextmenu', (e) => e.preventDefault());
    window.addEventListener('pointermove', this.onMove);
    window.addEventListener('pointerup', this.onUp);
    window.addEventListener('keyup', this.onKeyUp);
    window.addEventListener('keydown', this.onKeyDown);

    this.backdrop = realMesh(ed.id);
    if (this.backdrop) {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(this.backdrop.tris, 3));
      geo.computeVertexNormals();
      this.backMesh = new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ color: 0xb8a98c, side: THREE.DoubleSide }));
      scene.add(this.backMesh);
    }
    this.rebuild();
    this.setMode('move');
    let last = performance.now();
    const loop = (t) => {
      if (this.ed.view3d !== this) return;
      this.step(Math.min(0.05, (t - last) / 1000)); last = t;
      renderer.render(scene, cam);
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  }

  dispose() {
    const el = this.el;
    el.removeEventListener('pointerdown', this.onDown);
    window.removeEventListener('pointermove', this.onMove);
    window.removeEventListener('pointerup', this.onUp);
    window.removeEventListener('keyup', this.onKeyUp);
    window.removeEventListener('keydown', this.onKeyDown);
    if (document.pointerLockElement) document.exitPointerLock();
    this.tc.detach(); this.tc.dispose();
    this.clearGroup('statics'); this.clearGroup('live');
    if (this.backMesh) { this.backMesh.geometry.dispose(); this.backMesh.material.dispose(); }
    this.renderer.dispose(); this.renderer.forceContextLoss();
    this.host.innerHTML = '';
    this.host.classList.add('hidden');
  }

  resize() {
    const r = this.host.getBoundingClientRect();
    this.renderer.setSize(r.width, r.height);
    this.cam.aspect = r.width / r.height; this.cam.updateProjectionMatrix();
  }

  forward() { return new THREE.Vector3(-Math.sin(this.yaw) * Math.cos(this.pitch), Math.sin(this.pitch), -Math.cos(this.yaw) * Math.cos(this.pitch)); }

  step(dt) {
    const cam = this.cam, sp = (this.keys.has('ShiftLeft') ? 45 : 14) * dt, f = this.forward(), rgt = new THREE.Vector3(Math.cos(this.yaw), 0, -Math.sin(this.yaw));
    if (this.fly) {
      if (this.keys.has('KeyW')) cam.position.addScaledVector(f, sp);
      if (this.keys.has('KeyS')) cam.position.addScaledVector(f, -sp);
      if (this.keys.has('KeyA')) cam.position.addScaledVector(rgt, -sp);
      if (this.keys.has('KeyD')) cam.position.addScaledVector(rgt, sp);
      if (this.keys.has('Space') || this.keys.has('KeyE')) cam.position.y += sp;
      if (this.keys.has('KeyC') || this.keys.has('KeyQ')) cam.position.y -= sp;
    }
    cam.rotation.set(this.pitch, this.yaw, 0);
    cam.updateMatrixWorld();
    for (const m of this.handles) if (m.visible) m.scale.setScalar(Math.max(0.05, m.position.distanceTo(cam.position) * 0.024));
  }

  // ------------------------------------------------------------ meshes
  entry(src) {
    let e = this.cache.get(src);
    if (e) return e;
    const brush = makeBrushFromSource(src), polys = brushPolygons(brush), faces = new Map();
    for (const poly of polys) {
      const p = brush.planes[poly.plane];
      if (!p.tex || p.tex === 'nodraw') continue;
      let g = faces.get(p.tex);
      if (!g) faces.set(p.tex, g = { pos: [], nor: [], uv: [] });
      const n = p.n, ax = Math.abs(n[0]), ay = Math.abs(n[1]), az = Math.abs(n[2]);
      const u = ay >= ax && ay >= az ? [1, 0, 0] : ax >= az ? [0, 0, 1] : [1, 0, 0];
      const vv = ay >= ax && ay >= az ? [0, 0, 1] : [0, -1, 0];
      const sc = TEX_SCALE[p.tex] || 3, V = poly.verts;
      // wind the fan so it faces along the plane normal
      const cr = new THREE.Vector3().crossVectors(new THREE.Vector3(...V[1]).sub(new THREE.Vector3(...V[0])), new THREE.Vector3(...V[2]).sub(new THREE.Vector3(...V[0])));
      const flip = cr.dot(new THREE.Vector3(...n)) < 0;
      for (let k = 1; k + 1 < V.length; k++) for (const idx of flip ? [0, k + 1, k] : [0, k, k + 1]) {
        const q = V[idx];
        g.pos.push(...q); g.nor.push(...n);
        g.uv.push((q[0] * u[0] + q[1] * u[1] + q[2] * u[2]) / sc, -(q[0] * vv[0] + q[1] * vv[1] + q[2] * vv[2]) / sc);
      }
    }
    e = { brush, polys, faces };
    this.cache.set(src, e);
    return e;
  }
  invalidate(src) { this.cache.delete(src); }

  meshes(list) {
    const merged = new Map();
    for (const src of list) {
      let e;
      try { e = this.entry(src); } catch { continue; }
      for (const [tex, f] of e.faces) {
        let g = merged.get(tex);
        if (!g) merged.set(tex, g = []);
        g.push(f);
      }
    }
    const group = new THREE.Group();
    for (const [tex, parts] of merged) {
      const n = parts.reduce((s, f) => s + f.pos.length, 0), pos = new Float32Array(n), nor = new Float32Array(n), uv = new Float32Array(n / 3 * 2);
      let a = 0, b = 0;
      for (const f of parts) { pos.set(f.pos, a); nor.set(f.nor, a); uv.set(f.uv, b); a += f.pos.length; b += f.uv.length; }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      geo.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
      geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
      group.add(new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ map: surfaceTexture(tex) })));
    }
    return group;
  }
  clearGroup(name) {
    const g = this[name];
    if (!g) return;
    this.scene.remove(g);
    g.traverse(o => { if (o.geometry) o.geometry.dispose(); if (o.material) o.material.dispose(); });
    this[name] = null;
  }

  rebuild() {
    const ed = this.ed;
    this.clearGroup('statics');
    this.statics = this.meshes(ed.src.brushes.filter(b => !this.hidden.has(b) && (ed.opts.roofs || !b.roof)));
    this.scene.add(this.statics);
    this.rebuildMarks();
    this.syncSelection();
  }

  rebuildMarks() {
    const ed = this.ed;
    this.clearGroup('marks');
    const g = this.marks = new THREE.Group();
    const zc = { A: 0xff8a3a, B: 0xff8a3a, T: 0xe3c04b, CT: 0x6fa8dc };
    for (const [name, r] of Object.entries(ed.src.zones)) {
      const y = this.floorAt((r[0] + r[2]) / 2, (r[1] + r[3]) / 2);
      const geo = new THREE.EdgesGeometry(new THREE.BoxGeometry(r[2] - r[0], 3, r[3] - r[1]));
      const box = new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ color: zc[name] }));
      box.position.set((r[0] + r[2]) / 2, y + 1.5, (r[1] + r[3]) / 2);
      g.add(box);
    }
    this.decorPts = [];
    const pos = [], col = [], tint = new THREE.Color();
    (ed.src.decor || []).forEach((d, i) => {
      const c = ed.decorCenter(d);
      if (!isFinite(c.x) || !isFinite(c.z)) return;
      const y = this.floorAt(c.x, c.z) + 1;
      this.decorPts.push({ i, p: new THREE.Vector3(c.x, y, c.z) });
      tint.set(i === ed.selDecor ? 0xffe14d : 0x6fcf6f);
      pos.push(c.x, y, c.z); col.push(tint.r, tint.g, tint.b);
    });
    for (const l of ed.src.lights || []) { tint.set(0xffc060); pos.push(l.x, this.floorAt(l.x, l.z) + 2, l.z); col.push(tint.r, tint.g, tint.b); }
    if (pos.length) {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
      g.add(new THREE.Points(geo, new THREE.PointsMaterial({ size: 9, sizeAttenuation: false, vertexColors: true, depthTest: false, transparent: true })));
    }
    this.scene.add(g);
  }

  // ------------------------------------------------------------ rays
  // Nearest brush the ray enters. Each brush is convex, so this clips the ray by its planes.
  rayHit(o, d, skip) {
    let best = null;
    this.ed.src.brushes.forEach((src, i) => {
      if (skip && skip(src)) return;
      let e;
      try { e = this.entry(src); } catch { return; }
      let t0 = 0, t1 = 1e6;
      for (const p of e.brush.planes) {
        const nd = p.n[0] * d.x + p.n[1] * d.y + p.n[2] * d.z, dist = p.d - (p.n[0] * o.x + p.n[1] * o.y + p.n[2] * o.z);
        if (Math.abs(nd) < 1e-9) { if (dist < 0) return; continue; }
        const t = dist / nd;
        if (nd < 0) t0 = Math.max(t0, t); else t1 = Math.min(t1, t);
        if (t0 > t1) return;
      }
      if (!best || t0 < best.t) best = { i, t: t0 };
    });
    if (this.backdrop) {
      const L = 600, tr = trace({ grid: { cells: new Map(), stamp: 0 }, mesh: this.backdrop }, [o.x, o.y, o.z], [o.x + d.x * L, o.y + d.y * L, o.z + d.z * L], [0, 0, 0]);
      if (tr.fraction < 1 && (!best || tr.fraction * L < best.t)) best = { i: -1, t: tr.fraction * L };
    }
    return best;
  }
  floorAt(x, z) {
    const hit = this.rayHit({ x, y: 200, z }, { x: 0, y: -1, z: 0 }, (b) => b.roof || b.wall);
    return hit ? 200 - hit.t : 0;
  }
  mouseRay(e) {
    const r = this.el.getBoundingClientRect(), rc = new THREE.Raycaster();
    this.cam.updateMatrixWorld();
    rc.setFromCamera(new THREE.Vector2((e.clientX - r.left) / r.width * 2 - 1, -(e.clientY - r.top) / r.height * 2 + 1), this.cam);
    return rc.ray;
  }
  scenePick(e) {
    const ray = this.mouseRay(e), roofs = this.ed.opts.roofs;
    return this.rayHit(ray.origin, ray.direction, roofs ? null : (b) => b.roof);
  }
  screen(p) {
    const r = this.el.getBoundingClientRect(), v = p.clone().project(this.cam);
    return v.z > 1 ? null : { x: r.left + (v.x + 1) / 2 * r.width, y: r.top + (1 - v.y) / 2 * r.height };
  }
  nearScreen(p, e, px) { const s = this.screen(p); return s && Math.hypot(s.x - e.clientX, s.y - e.clientY) < px; }

  // ------------------------------------------------------------ selection box
  // A lone angled prism (a diagonal wall) gets a box along its longest edge; everything else lines up with the world.
  frame() {
    const list = this.selected();
    if (list.length === 1 && list[0].t === 'prism') {
      const pts = list[0].pts;
      let best = 0, u = [1, 0];
      pts.forEach((a, i) => { const b = pts[(i + 1) % pts.length], dx = b[0] - a[0], dz = b[1] - a[1], l = Math.hypot(dx, dz); if (l > best) { best = l; u = [dx / l, dz / l]; } });
      if (pts.length === 4 && Math.min(Math.abs(u[0]), Math.abs(u[1])) > 0.001) return { u, v: [-u[1], u[0]] };
    }
    return { u: [1, 0], v: [0, 1] };
  }
  selected() { return [...this.ed.sel].map(i => this.ed.src.brushes[i]).filter(Boolean); }

  selectionBox() {
    const list = this.selected();
    if (!list.length) return null;
    const { u, v } = this.frame();
    let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (const src of list) {
      let e;
      try { e = this.entry(src); } catch { continue; }
      for (const poly of e.polys) for (const q of poly.verts) {
        const a = q[0] * u[0] + q[2] * u[1], b = q[0] * v[0] + q[2] * v[1];
        u0 = Math.min(u0, a); u1 = Math.max(u1, a); v0 = Math.min(v0, b); v1 = Math.max(v1, b); y0 = Math.min(y0, q[1]); y1 = Math.max(y1, q[1]);
      }
    }
    if (!isFinite(u0)) return null;
    const uc = (u0 + u1) / 2, vc = (v0 + v1) / 2;
    return { u, v, u0, u1, v0, v1, y0, y1, c: new THREE.Vector3(uc * u[0] + vc * v[0], (y0 + y1) / 2, uc * u[1] + vc * v[1]) };
  }

  faces(k) {
    const P = (a, y, b) => new THREE.Vector3(a * k.u[0] + b * k.v[0], y, a * k.u[1] + b * k.v[1]);
    const um = (k.u0 + k.u1) / 2, vm = (k.v0 + k.v1) / 2, ym = (k.y0 + k.y1) / 2;
    const U = new THREE.Vector3(k.u[0], 0, k.u[1]), V = new THREE.Vector3(k.v[0], 0, k.v[1]), Y = new THREE.Vector3(0, 1, 0);
    return [
      { p: P(k.u1, ym, vm), o: P(k.u0, ym, vm), dir: U, axis: k.u, size: k.u1 - k.u0 },
      { p: P(k.u0, ym, vm), o: P(k.u1, ym, vm), dir: U.clone().negate(), axis: k.u, size: k.u1 - k.u0 },
      { p: P(um, ym, k.v1), o: P(um, ym, k.v0), dir: V, axis: k.v, size: k.v1 - k.v0 },
      { p: P(um, ym, k.v0), o: P(um, ym, k.v1), dir: V.clone().negate(), axis: k.v, size: k.v1 - k.v0 },
      { p: P(um, k.y1, vm), o: P(um, k.y0, vm), dir: Y, axis: null, size: k.y1 - k.y0 },
      { p: P(um, k.y0, vm), o: P(um, k.y1, vm), dir: Y.clone().negate(), axis: null, size: k.y1 - k.y0 },
    ];
  }

  updateOutline() {
    const pos = [];
    for (const src of this.selected()) {
      let e;
      try { e = this.entry(src); } catch { continue; }
      for (const poly of e.polys) for (let i = 0; i < poly.verts.length; i++) pos.push(...poly.verts[i], ...poly.verts[(i + 1) % poly.verts.length]);
    }
    this.outline.geometry.dispose();
    this.outline.geometry = new THREE.BufferGeometry();
    this.outline.geometry.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  }

  // Puts the outline, the gizmo and the handles on whatever is selected now.
  syncSelection() {
    const ed = this.ed, k = this.selectionBox();
    this.updateOutline();
    this.box = k;
    this.handleFaces = k && this.mode === 'resize' ? this.faces(k) : null;
    this.handles.forEach((m, i) => { m.visible = !!this.handleFaces; if (this.handleFaces) m.position.copy(this.handleFaces[i].p); });
    const decor = ed.selDecor >= 0 ? this.decorPts?.find(q => q.i === ed.selDecor) : null;
    if (this.mode === 'move' && (k || decor)) {
      this.proxy.position.copy(k ? k.c : decor.p);
      this.tc.showY = !decor;
      this.tc.attach(this.proxy);
    } else this.tc.detach();
    this.tc.visible = !!this.tc.object;
  }

  setMode(m) {
    this.mode = m;
    document.querySelectorAll('[data-edmode]').forEach(b => b.classList.toggle('on', b.dataset.edmode === m));
    this.syncSelection();
  }

  focus() {
    const k = this.box;
    if (!k) return;
    const r = Math.max(k.u1 - k.u0, k.v1 - k.v0, k.y1 - k.y0);
    this.cam.position.copy(k.c).addScaledVector(this.forward(), -Math.max(5, r * 1.6));
  }

  // ------------------------------------------------------------ dragging
  startDrag() {
    this.hidden = new Set(this.selected());
    this.clearGroup('statics');
    this.statics = this.meshes(this.ed.src.brushes.filter(b => !this.hidden.has(b) && (this.ed.opts.roofs || !b.roof)));
    this.scene.add(this.statics);
    this.updateLive();
  }
  updateLive() {
    this.clearGroup('live');
    this.live = this.meshes(this.selected());
    this.scene.add(this.live);
    this.updateOutline();
  }
  endDrag() {
    this.hidden = new Set();
    this.clearGroup('live');
    this.ed.changed();
  }

  startMove() {
    const ed = this.ed;
    ed.snapshot();
    this.moving = { start: this.proxy.position.clone(), done: new THREE.Vector3() };
    if (ed.selDecor < 0) this.startDrag();
  }
  onGizmo() {
    const ed = this.ed, mv = this.moving;
    if (!mv) return;
    const decor = ed.selDecor >= 0;
    const s = decor ? 1 : this.shift ? 0.01 : ed.opts.snap, R = (v) => Math.round(v / s) * s;
    const d = this.proxy.position.clone().sub(mv.start);
    d.set(R(d.x), R(d.y), R(d.z));
    this.proxy.position.copy(mv.start).add(d);
    const step = d.clone().sub(mv.done);
    if (!step.lengthSq()) return;
    mv.done.copy(d);
    if (decor) { ed.moveDecor(ed.src.decor[ed.selDecor], step.x, step.z); }
    else {
      for (const b of this.selected()) { ed.move(b, step.x, step.y, step.z); this.invalidate(b); }
      this.updateLive();
    }
    $('ed-info').textContent = `moved ${d.x.toFixed(2)}, ${d.y.toFixed(2)}, ${d.z.toFixed(2)} m`;
  }
  endMove() {
    const ed = this.ed, mv = this.moving;
    if (!mv) return;
    this.moving = null;
    if (!mv.done.lengthSq()) ed.undoStack.pop();
    if (ed.selDecor >= 0) ed.changed(); else this.endDrag();
  }

  startResize(face) {
    const ed = this.ed;
    ed.snapshot();
    const sel = [...ed.sel];
    this.resizing = { face, sel, orig: sel.map(i => structuredClone(ed.src.brushes[i])), changed: false };
    this.startDrag();
  }
  dragResize(e) {
    const ed = this.ed, rz = this.resizing, f = rz.face, ray = this.mouseRay(e);
    // closest point on the handle's axis to the mouse ray
    const w = f.p.clone().sub(ray.origin), b = f.dir.dot(ray.direction), den = 1 - b * b;
    if (den < 1e-4) return;
    let t = (b * ray.direction.dot(w) - f.dir.dot(w)) / den;
    if (!this.shift) {
      const sn = ed.opts.snap, world = f.axis ? (f.axis[0] === 1 || f.axis[1] === 1) : true;
      if (world) { const at = f.p.dot(f.dir) + t; t = Math.round(at / sn) * sn - f.p.dot(f.dir); }
      else t = Math.round(t / sn) * sn;
    }
    const size = Math.max(0.1, f.size + t), s = size / f.size;
    rz.sel.forEach((i, n) => { ed.src.brushes[i] = scaleBrush(structuredClone(rz.orig[n]), f.axis, [f.o.x, f.o.y, f.o.z], s); });
    rz.changed = true;
    this.updateLive();
    const k = this.selectionBox();
    if (k) this.faces(k).forEach((q, i) => this.handles[i].position.copy(q.p));
    $('ed-info').textContent = `size ${size.toFixed(2)} m`;
  }
  endResize() {
    const rz = this.resizing;
    this.resizing = null;
    if (!rz.changed) this.ed.undoStack.pop();
    this.endDrag();
  }

  // ------------------------------------------------------------ mouse
  pointerDown(e) {
    const ed = this.ed;
    this.shift = e.shiftKey;
    if (e.button === 2) { this.fly = true; this.el.requestPointerLock?.(); return; }
    if (e.button === 1) { e.preventDefault(); this.pan = true; return; }
    if (e.button !== 0 || this.tc.dragging || this.tc.axis) return;
    if (ed.tool === 'select') {
      if (this.handleFaces) {
        const n = this.handleFaces.findIndex(f => this.nearScreen(f.p, e, HANDLE_PX));
        if (n >= 0) { this.startResize(this.handleFaces[n]); return; }
      }
      const dp = (this.decorPts || []).find(q => this.nearScreen(q.p, e, 9));
      if (dp) { ed.selDecor = dp.i; ed.sel.clear(); this.rebuildMarks(); ed.renderProps(); this.syncSelection(); return; }
      const hit = this.scenePick(e);
      ed.pickPart(hit ? hit.i : -1, e.shiftKey, e.altKey);
      this.rebuildMarks();
      this.syncSelection();
      return;
    }
    const hit = this.scenePick(e), ray = this.mouseRay(e);
    const y = hit ? ray.origin.y + ray.direction.y * hit.t : 0;
    const p = ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 1, 0), -y), new THREE.Vector3());
    if (!p) return;
    if (ed.placeAt(p.x, p.z)) return;
    const x = ed.snap(p.x), z = ed.snap(p.z);
    this.rect = { y, r: { x0: x, z0: z, x1: x, z1: z } };
    this.drawBand();
  }
  drawBand() {
    const { r, y } = this.rect, a = this.band.geometry.attributes.position;
    [[r.x0, r.z0], [r.x1, r.z0], [r.x1, r.z1], [r.x0, r.z1]].forEach(([x, z], i) => a.setXYZ(i, x, y + 0.03, z));
    a.needsUpdate = true;
    this.band.visible = true;
  }
  pointerMove(e) {
    if ($('editor').classList.contains('hidden')) return;
    this.shift = e.shiftKey;
    if (this.fly) {
      this.yaw -= e.movementX * 0.0025;
      this.pitch = Math.max(-1.55, Math.min(1.55, this.pitch - e.movementY * 0.0025));
      return;
    }
    if (this.pan) {
      const rgt = new THREE.Vector3(Math.cos(this.yaw), 0, -Math.sin(this.yaw));
      this.cam.position.addScaledVector(rgt, -e.movementX * 0.05);
      this.cam.position.y += e.movementY * 0.05;
      return;
    }
    if (this.resizing) { this.dragResize(e); return; }
    if (this.rect) {
      const p = this.mouseRay(e).intersectPlane(new THREE.Plane(new THREE.Vector3(0, 1, 0), -this.rect.y), new THREE.Vector3());
      if (p) { this.rect.r.x1 = this.ed.snap(p.x); this.rect.r.z1 = this.ed.snap(p.z); this.drawBand(); $('ed-info').textContent = `${Math.abs(this.rect.r.x1 - this.rect.r.x0).toFixed(1)} x ${Math.abs(this.rect.r.z1 - this.rect.r.z0).toFixed(1)} m`; }
      return;
    }
    if (this.tc.dragging || e.target !== this.el) return;
    const hit = this.scenePick(e);
    if (hit && hit.i >= 0) {
      const b = this.ed.src.brushes[hit.i], k = this.ed.bounds(b);
      $('ed-info').textContent = `${b.group ? b.group + ' / ' : ''}brush #${hit.i}: ${b.t}${b.wall ? ' (wall)' : b.roof ? ' (roof)' : b.box ? ' (box)' : ''}  bottom ${k.bottom.toFixed(2)}  top ${k.top.toFixed(2)}`;
    } else $('ed-info').textContent = '';
  }
  pointerUp(e) {
    if (e.button === 2 && this.fly) { this.fly = false; this.keys.clear(); if (document.pointerLockElement) document.exitPointerLock(); return; }
    if (e.button === 1) { this.pan = false; return; }
    if (this.resizing) { this.endResize(); return; }
    if (this.rect) {
      const { r, y } = this.rect;
      this.rect = null; this.band.visible = false;
      this.ed.finishRect(r, y);
    }
  }
  flyKey(e) { if (!this.fly) return false; this.keys.add(e.code); e.preventDefault(); return true; }
}
