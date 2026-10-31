// Draws maps imported from the host's CS2 install: real geometry with the game's own painted textures, a sun shadow map and baked vertex shading.
import * as THREE from 'three';
import { trace, brushPolygons } from '/shared/brush.js';
import { buildSkybox } from './world.js';
import { surfaceTexture, TEX_SCALE } from './textures.js';

// Materials the brush maps never needed, painted here.
const EXTRA_SCALE = { leaf: 1.2, bark: 1.4, dark: 1.5, metal: 2, clay: 1, cloth: 1.2 };
function paint(name) {
  const S = 512, c = document.createElement('canvas');
  c.width = c.height = S;
  const g = c.getContext('2d'), R = (a, b) => a + Math.random() * (b - a);
  const blotches = (n, r0, r1, colours, alpha) => {
    g.globalAlpha = alpha;
    for (let i = 0; i < n; i++) {
      const x = R(0, S), y = R(0, S), r = R(r0, r1);
      g.fillStyle = colours[i % colours.length];
      for (const [dx, dy] of [[0, 0], [S, 0], [-S, 0], [0, S], [0, -S]]) { g.beginPath(); g.ellipse(x + dx, y + dy, r, r * R(0.5, 1), R(0, 3), 0, 7); g.fill(); }
    }
    g.globalAlpha = 1;
  };
  const lines = (n, vertical, colours, alpha, wid) => {
    g.globalAlpha = alpha;
    for (let i = 0; i < n; i++) { g.fillStyle = colours[i % colours.length]; const p = R(0, S), w = R(wid[0], wid[1]); if (vertical) g.fillRect(p, 0, w, S); else g.fillRect(0, p, S, w); }
    g.globalAlpha = 1;
  };
  const base = { leaf: '#587534', bark: '#57422f', dark: '#2b2c30', metal: '#7d8082', clay: '#b0714a', cloth: '#a98b62' }[name];
  g.fillStyle = base; g.fillRect(0, 0, S, S);
  if (name === 'leaf') { blotches(900, 6, 26, ['#3e5a24', '#6f8f40', '#4c6a2c', '#86a24e', '#2f4a1c'], 0.75); }
  else if (name === 'bark') { lines(160, true, ['#3b2b1e', '#6d5540', '#2f2318'], 0.6, [2, 12]); blotches(120, 4, 16, ['#2c2016', '#7a624a'], 0.35); }
  else if (name === 'dark') { lines(60, false, ['#3a3b40', '#1f2023'], 0.45, [1, 5]); blotches(80, 4, 18, ['#1b1c1f', '#44454a'], 0.25); }
  else if (name === 'metal') { lines(220, false, ['#92959a', '#65686b', '#a3a6aa'], 0.28, [1, 4]); blotches(70, 6, 34, ['#6f4f35', '#54575a', '#8a6242'], 0.3); lines(4, true, ['#4d5052'], 0.5, [3, 5]); }
  else if (name === 'clay') { lines(10, false, ['#8f5736', '#c98a5e'], 0.5, [8, 28]); blotches(260, 2, 9, ['#7d4c30', '#d39a70'], 0.4); }
  else { lines(256, false, ['#8f7450', '#bda178'], 0.28, [1, 2]); lines(256, true, ['#8f7450', '#bda178'], 0.28, [1, 2]); blotches(30, 20, 70, ['#7a6242', '#c2a880'], 0.2); }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping; t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 8;
  return t;
}

const LAYERS = ['sand', 'sandstone', 'stone', 'flagstone', 'brick_pale', 'plaster_cream', 'plaster_ochre', 'plaster_pink', 'plaster_blue', 'wood_old', 'crate_hd', 'door', 'cloth', 'clay', 'metal', 'dark', 'bark', 'leaf'];

export async function loadRealMaps(registerRealMap) {
  const get = async (url) => {
    const r = await fetch(url);
    if (!r.ok) throw new Error(`${url} returned ${r.status}`);
    return r;
  };
  try {
    const list = await (await get('/api/realmaps')).json();
    for (const id of list) {
      const meta = await (await get(`/local-maps/${id}/meta.json`)).json();
      registerRealMap(id, meta, await (await get(`/local-maps/${id}/collision.bin?v=${meta.hash}`)).arrayBuffer());
    }
  } catch (e) {
    console.error('Could not load imported maps:', e);
    const note = document.createElement('div');
    note.style.cssText = 'position:fixed;left:8px;bottom:8px;z-index:99;padding:6px 10px;background:#7a1d16;color:#fff;font:13px Arial';
    note.textContent = 'Real map failed to load: ' + e.message;
    document.body.appendChild(note);
  }
}

export async function buildRealWorld(map, scene, onProgress, renderer) {
  const v = map.real.visual;
  const res = await fetch(`/local-maps/${map.id}/visual.bin?v=${map.real.hash}`);
  const total = +res.headers.get('content-length') || 0, reader = res.body.getReader(), parts = [];
  let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value); got += value.length;
    if (total) onProgress(got / total);
  }
  const all = new Uint8Array(got);
  got = 0;
  for (const p of parts) { all.set(p, got); got += p.length; }
  const pos = new Float32Array(all.buffer, 0, v.verts * 3), nor = new Int8Array(all.buffer, v.verts * 12, v.verts * 4);
  const axes = new Uint8Array(all.buffer, v.verts * 16, v.verts), idxOff = v.verts * 17;
  const idx = new Uint32Array(all.buffer.slice(idxOff, idxOff + v.idx * 4));

  const group = new THREE.Group();
  const mats = new Map(), painted = {};
  // Surfaces of different materials often lie exactly on each other (a trim on a wall). A fixed order per material
  // settles which one shows; the same material looks identical either way, since textures are world-aligned.
  const matFor = (tex) => {
    let m = mats.get(tex);
    if (!m) {
      const k = LAYERS.indexOf(tex) + 1;
      mats.set(tex, m = new THREE.MeshLambertMaterial({ map: EXTRA_SCALE[tex] ? (painted[tex] ||= paint(tex)) : surfaceTexture(tex), vertexColors: true, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -k * 0.5, polygonOffsetUnits: -k * 2 }));
    }
    return m;
  };
  for (const g of v.groups) {
    const P = pos.subarray(g.v * 3, (g.v + g.vc) * 3), N = new Float32Array(g.vc * 3), C = new Float32Array(g.vc * 3), UV = new Float32Array(g.vc * 2);
    const sc = EXTRA_SCALE[g.tex] || TEX_SCALE[g.tex] || 3;
    for (let i = 0; i < g.vc; i++) {
      const o = (g.v + i) * 4, nx = nor[o] / 127, ny = nor[o + 1] / 127, nz = nor[o + 2] / 127, ao = Math.max(0.25, nor[o + 3] / 127);
      N[i * 3] = nx; N[i * 3 + 1] = ny; N[i * 3 + 2] = nz;
      C[i * 3] = C[i * 3 + 1] = C[i * 3 + 2] = ao;
      // world-aligned texture axes, like the brush maps
      const ax = axes[g.v + i], x = P[i * 3], y = P[i * 3 + 1], z = P[i * 3 + 2];
      if (ax === 1) { UV[i * 2] = x / sc; UV[i * 2 + 1] = -z / sc; }
      else if (ax === 0) { UV[i * 2] = z / sc; UV[i * 2 + 1] = y / sc; }
      else { UV[i * 2] = x / sc; UV[i * 2 + 1] = y / sc; }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(P), 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(N, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(C, 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(UV, 2));
    geo.setIndex(new THREE.BufferAttribute(idx.subarray(g.i, g.i + g.ic), 1));
    geo.computeBoundingSphere();
    const mesh = new THREE.Mesh(geo, matFor(g.tex));
    mesh.castShadow = mesh.receiveShadow = true;
    mesh.matrixAutoUpdate = false;
    group.add(mesh);
  }

  // brushes added on top of the imported map in the editor
  const byTex = new Map();
  for (const b of map.brushes) for (const poly of brushPolygons(b)) {
    const p = b.planes[poly.plane];
    if (!p.tex || p.tex === 'nodraw') continue;
    let g = byTex.get(p.tex);
    if (!g) byTex.set(p.tex, g = { pos: [], nor: [], uv: [] });
    const sc = TEX_SCALE[p.tex] || 3, up = Math.abs(p.n[1]) > 0.7, side = Math.abs(p.n[0]) > Math.abs(p.n[2]);
    for (let k = 1; k + 1 < poly.verts.length; k++) for (const q of [poly.verts[0], poly.verts[k], poly.verts[k + 1]]) {
      g.pos.push(...q); g.nor.push(...p.n);
      g.uv.push((up || !side ? q[0] : q[2]) / sc, (up ? -q[2] : q[1]) / sc);
    }
  }
  for (const [tex, g] of byTex) {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(g.pos, 3));
    geo.setAttribute('normal', new THREE.Float32BufferAttribute(g.nor, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(g.uv, 2));
    const mesh = new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ map: surfaceTexture(tex), side: THREE.DoubleSide }));
    mesh.castShadow = mesh.receiveShadow = true;
    group.add(mesh);
  }

  // one sun shadow map, rendered once: the world never moves
  const hemi = new THREE.HemisphereLight(0xcfe0f2, 0x9a8468, 1.5);
  const sun = new THREE.DirectionalLight(0xffe6c8, 2.7);
  const cx = map.w / 2, cz = map.h / 2, S = new THREE.Vector3(...map.theme.sun).normalize();
  sun.position.set(cx + S.x * 160, 10 + S.y * 160, cz + S.z * 160);
  sun.target.position.set(cx, 10, cz);
  sun.castShadow = true;
  sun.shadow.mapSize.set(4096, 4096);
  const R = Math.hypot(map.w, map.h) / 2 + 2;
  Object.assign(sun.shadow.camera, { left: -R, right: R, top: R, bottom: -R, near: 10, far: 340 });
  sun.shadow.bias = -0.0006; sun.shadow.normalBias = 0.03;
  group.add(hemi, sun, sun.target);
  if (renderer) { renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFShadowMap; renderer.shadowMap.autoUpdate = false; renderer.shadowMap.needsUpdate = true; }

  scene.add(group);
  scene.background = buildSkybox(map.theme);

  const sd = [S.x, S.y, S.z];
  const lightAt = (x, y, z) => {
    const o = [x, y + 0.9, z], tr = trace(map, o, [o[0] + sd[0] * 60, o[1] + sd[1] * 60, o[2] + sd[2] * 60], [0, 0, 0]);
    return tr.fraction >= 1 ? [1.15, 1.08, 0.98] : [0.62, 0.66, 0.72];
  };
  return {
    group, lightAt, ownLights: true,
    dispose() {
      scene.remove(group);
      if (scene.background && scene.background.dispose) scene.background.dispose();
      sun.shadow.map?.dispose();
      group.traverse(o => { if (o.geometry) o.geometry.dispose(); });
      for (const m of mats.values()) m.dispose();
      for (const t of Object.values(painted)) t.dispose();
    },
  };
}
