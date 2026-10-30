// Models, built the way GoldSrc (CS 1.6) models are built — but generated in code, nothing copied:
//  * Characters: ONE skinned mesh on a bone skeleton; every vertex belongs rigidly to a single bone (like .mdl
//    files), covered by a painted texture "skin". Animation is keyframed bone rotations, with the upper body
//    blended towards the aim pitch.
//  * Lighting: like GoldSrc's R_LightPoint, a model takes its brightness/colour from the lightmap under its feet.
//  * View models: hands + weapon as one rig rendered in its own pass (v_ models). Sequences: draw, idle,
//    shoot (kick, slide/bolt), reload (mag out, new mag in, charge).
import * as THREE from 'three';

const BOX = new THREE.BoxGeometry(1, 1, 1);
const CYL = new THREE.CylinderGeometry(0.5, 0.5, 1, 10);
const SPH = new THREE.SphereGeometry(0.5, 12, 9);
const matCache = {};
export function mat(color, emissive) {
  const k = color + ':' + (emissive || 0);
  return matCache[k] ||= new THREE.MeshLambertMaterial({ color, emissive: emissive || 0 });
}

// Merge a rigid object's meshes into one vertex-coloured mesh (one draw call).
const VC_MAT = new THREE.MeshLambertMaterial({ vertexColors: true });
const _v = new THREE.Vector3(), _n = new THREE.Vector3(), _m3 = new THREE.Matrix3();
export function mergeMeshes(group) {
  const meshes = [];
  group.updateMatrixWorld(true);
  group.traverse(o => { if (o.isMesh && !o.material.transparent && !o.userData.keep) meshes.push(o); });
  if (meshes.length < 2) return;
  const inv = group.matrixWorld.clone().invert();
  const pos = [], nor = [], col = [];
  for (const m of meshes) {
    const mat4 = inv.clone().multiply(m.matrixWorld);
    _m3.getNormalMatrix(mat4);
    const geo = m.geometry.index ? m.geometry.toNonIndexed() : m.geometry;
    const p = geo.attributes.position, n = geo.attributes.normal, c = m.material.color;
    for (let i = 0; i < p.count; i++) {
      _v.fromBufferAttribute(p, i).applyMatrix4(mat4); pos.push(_v.x, _v.y, _v.z);
      _n.fromBufferAttribute(n, i).applyMatrix3(_m3).normalize(); nor.push(_n.x, _n.y, _n.z);
      col.push(c.r, c.g, c.b);
    }
    if (geo !== m.geometry) geo.dispose();
    m.parent.remove(m);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.computeBoundingSphere();
  group.add(new THREE.Mesh(g, VC_MAT));
}

// Free per-model GPU resources (shared shapes, materials and skins are kept).
export function disposeModel(obj) {
  obj.traverse(o => {
    if (o.isMesh && o.material === VC_MAT) o.geometry.dispose();
    if (o.isSkinnedMesh) { o.geometry.dispose(); o.material.dispose(); }
    if (o.isSprite && o.material.map) { o.material.map.dispose(); o.material.dispose(); }
  });
}

function part(parent, geo, color, sx, sy, sz, x, y, z, rx = 0, ry = 0, rz = 0) {
  const m = new THREE.Mesh(geo, mat(color));
  m.scale.set(sx, sy, sz);
  m.position.set(x, y, z);
  m.rotation.set(rx, ry, rz);
  parent.add(m);
  return m;
}
const box = (p, w, h, d, x, y, z, c, rx, ry, rz) => part(p, BOX, c, w, h, d, x, y, z, rx, ry, rz);
const cyl = (p, r, len, x, y, z, c, rx = Math.PI / 2, ry = 0, rz = 0) => part(p, CYL, c, r * 2, len, r * 2, x, y, z, rx, ry, rz);
const sph = (p, r, x, y, z, c, sy = 1) => part(p, SPH, c, r * 2, r * 2 * sy, r * 2, x, y, z);

// ================================================================== weapons
// Built pointing down -z with the grip around the origin. Moving parts live in groups:
// userData.mag (magazine), userData.slide (pistol slide / rifle charging handle / bolt).
const C = { black: 0x1c1d1f, dark: 0x2b2d30, metal: 0x4d5155, steel: 0x8b9095, wood: 0x6b4425, olive: 0x4b5638, awp: 0x3e5a3c };

export function weaponModel(id) {
  const g = new THREE.Group();
  const mag = new THREE.Group(), slide = new THREE.Group();
  g.add(mag, slide);
  g.userData.mag = mag; g.userData.slide = slide;
  switch (id) {
    case 'knife':
      box(g, 0.03, 0.035, 0.11, 0, 0, 0.02, C.black);
      box(g, 0.05, 0.012, 0.015, 0, 0.005, -0.04, C.metal);
      box(g, 0.008, 0.035, 0.17, 0, 0.008, -0.13, 0xc8ccd0);
      box(g, 0.008, 0.018, 0.04, 0, 0.0, -0.225, 0xc8ccd0, 0.45);
      break;
    case 'glock': case 'usp': case 'p250': case 'deagle': {
      const big = id === 'deagle', len = big ? 0.26 : 0.19;
      const top = id === 'deagle' ? 0xa7abaf : id === 'p250' ? C.metal : id === 'usp' ? C.dark : C.black;
      box(slide, 0.032, 0.036, len, 0, 0.047, -len / 2 + 0.035, top);
      box(slide, 0.012, 0.01, 0.02, 0, 0.068, 0.02, C.black);                  // rear sight
      box(g, 0.03, 0.026, len * 0.85, 0, 0.018, -len / 2 + 0.05, big ? 0x8c9094 : C.dark); // frame
      box(g, 0.031, 0.11, 0.05, 0, -0.035, 0.02, C.black, -0.25);               // grip
      box(g, 0.012, 0.02, 0.03, 0, -0.002, -0.01, C.black);                     // trigger guard
      if (id === 'usp') cyl(g, 0.017, 0.16, 0, 0.047, -len - 0.04, C.black);    // silencer
      box(mag, 0.024, 0.1, 0.04, 0, -0.04, 0.025, C.metal, -0.25);              // magazine inside the grip
      box(mag, 0.03, 0.015, 0.052, 0, -0.092, 0.038, C.black, -0.25);          // base plate
      break;
    }
    case 'mac10': case 'mp9':
      box(g, 0.05, 0.08, 0.24, 0, 0.035, -0.07, id === 'mp9' ? C.black : C.dark);
      cyl(g, 0.012, 0.08, 0, 0.05, -0.22, C.metal);
      box(g, 0.035, 0.09, 0.04, 0, -0.03, 0.06, C.black, -0.2);
      box(mag, 0.032, 0.17, 0.04, 0, -0.1, -0.03, C.black);
      box(slide, 0.015, 0.02, 0.03, 0.03, 0.07, 0.0, C.metal);
      break;
    case 'ak47': case 'galil': {
      const wood = id === 'ak47' ? C.wood : C.olive;
      box(g, 0.05, 0.07, 0.3, 0, 0.03, -0.08, C.dark);                 // receiver
      box(g, 0.046, 0.025, 0.28, 0, 0.075, -0.08, C.metal);            // dust cover
      box(g, 0.055, 0.05, 0.2, 0, 0.025, -0.33, wood);                 // lower handguard
      box(g, 0.045, 0.03, 0.17, 0, 0.065, -0.32, wood);                // upper handguard
      cyl(g, 0.011, 0.26, 0, 0.055, -0.5, C.black);                    // barrel
      cyl(g, 0.008, 0.2, 0, 0.09, -0.36, C.metal);                     // gas tube
      box(g, 0.012, 0.04, 0.012, 0, 0.085, -0.6, C.black);             // front sight
      cyl(g, 0.016, 0.05, 0, 0.055, -0.645, C.black);                  // muzzle
      box(g, 0.04, 0.09, 0.05, 0, -0.04, 0.03, wood, -0.35);            // grip
      box(g, 0.045, 0.085, 0.26, 0, 0.0, 0.2, wood, 0.12);              // stock
      for (let k = 0; k < 3; k++) box(mag, 0.032, 0.07, 0.06, 0, -0.055 - k * 0.06, -0.16 - k * 0.022, id === 'ak47' ? 0x3a2a1c : C.black, 0.2 + k * 0.15);
      box(slide, 0.03, 0.018, 0.03, 0.035, 0.06, -0.02, C.steel);      // charging handle
      break;
    }
    case 'm4a4': case 'famas': {
      const body = id === 'famas' ? 0x3d4248 : C.dark;
      box(g, 0.05, 0.08, 0.3, 0, 0.035, -0.08, body);
      box(g, 0.025, 0.02, 0.32, 0, 0.085, -0.12, C.black);
      box(g, 0.058, 0.06, 0.22, 0, 0.04, -0.34, C.black);
      cyl(g, 0.011, 0.2, 0, 0.045, -0.53, C.black);
      cyl(g, 0.017, 0.07, 0, 0.045, -0.66, C.black);
      box(g, 0.015, 0.04, 0.015, 0, 0.1, -0.4, C.black);
      box(g, 0.035, 0.09, 0.045, 0, -0.04, 0.03, C.black, -0.35);
      cyl(g, 0.014, 0.18, 0, 0.04, 0.14, C.metal);
      box(g, 0.045, 0.09, 0.12, 0, 0.0, 0.26, C.black);
      box(mag, 0.035, 0.16, 0.06, 0, -0.085, -0.13, C.black, 0.1);
      box(slide, 0.04, 0.012, 0.02, 0, 0.09, 0.06, C.metal);
      break;
    }
    case 'awp':
      box(g, 0.055, 0.08, 0.5, 0, 0.02, -0.08, C.awp);
      box(g, 0.045, 0.13, 0.25, 0, -0.02, 0.28, C.awp);
      box(g, 0.05, 0.04, 0.08, 0, 0.04, 0.42, C.black);
      cyl(g, 0.016, 0.62, 0, 0.04, -0.62, C.black);
      cyl(g, 0.024, 0.06, 0, 0.04, -0.95, C.black);
      cyl(g, 0.026, 0.3, 0, 0.12, -0.08, C.black);
      cyl(g, 0.038, 0.06, 0, 0.12, -0.25, C.black);
      cyl(g, 0.032, 0.05, 0, 0.12, 0.08, C.black);
      box(g, 0.02, 0.04, 0.02, 0, 0.08, -0.12, C.black); box(g, 0.02, 0.04, 0.02, 0, 0.08, 0.0, C.black);
      box(slide, 0.06, 0.012, 0.012, 0.035, 0.05, 0.03, C.steel);
      sph(slide, 0.012, 0.068, 0.05, 0.03, C.steel);
      box(mag, 0.035, 0.08, 0.06, 0, -0.07, -0.08, C.black);
      break;
    case 'he': cyl(g, 0.035, 0.08, 0, 0, -0.05, 0x3f5a2c, 0); sph(g, 0.036, 0, 0.04, -0.05, 0x3f5a2c); box(g, 0.015, 0.05, 0.02, 0.02, 0.06, -0.05, C.metal); break;
    case 'flash': cyl(g, 0.03, 0.11, 0, 0, -0.05, 0x9ba1a7, 0); box(g, 0.015, 0.05, 0.02, 0.02, 0.07, -0.05, C.metal); break;
    case 'smoke': cyl(g, 0.03, 0.11, 0, 0, -0.05, 0x5f666c, 0); cyl(g, 0.032, 0.02, 0, 0.02, -0.05, 0xd0d0d0, 0); box(g, 0.015, 0.05, 0.02, 0.02, 0.07, -0.05, C.metal); break;
    case 'bomb':
      box(g, 0.24, 0.08, 0.15, 0, 0, -0.08, 0x8a7a58);
      for (let k = 0; k < 4; k++) cyl(g, 0.018, 0.22, -0.09 + k * 0.06, 0.05, -0.08, 0xb7a17a, 0, 0, Math.PI / 2);
      box(g, 0.09, 0.02, 0.07, 0.03, 0.08, -0.08, 0x18221a);
      box(g, 0.06, 0.008, 0.03, 0.03, 0.092, -0.08, 0x40ff60);
      break;
    default: box(g, 0.05, 0.08, 0.3, 0, 0, -0.1, C.dark);
  }
  return g;
}

const LONG = new Set(['ak47', 'galil', 'm4a4', 'famas', 'awp', 'mac10', 'mp9']);
const PISTOL = new Set(['glock', 'usp', 'p250', 'deagle']);
const MUZZLE = { glock: -0.16, usp: -0.32, p250: -0.15, deagle: -0.23, mac10: -0.24, mp9: -0.28, ak47: -0.68, galil: -0.68, m4a4: -0.7, famas: -0.7, awp: -0.98 };

// ================================================================== view models
// Hand with fingers. Local frame: +y runs from the fingers back to the wrist, palm faces -x.
function buildHand(color, cuffColor, sleeveColor) {
  const hand = new THREE.Group();
  box(hand, 0.03, 0.085, 0.075, 0, 0.0, 0, color);                         // palm
  const fingers = [];
  for (let k = 0; k < 4; k++) {
    const f1 = new THREE.Group(); f1.position.set(-0.008, -0.045, -0.028 + k * 0.019); hand.add(f1);
    box(f1, 0.017, 0.035, 0.016, 0, -0.016, 0, color);
    const f2 = new THREE.Group(); f2.position.set(0, -0.033, 0); f1.add(f2);
    box(f2, 0.016, 0.03, 0.015, 0, -0.014, 0, color);
    fingers.push([f1, f2]);
  }
  const thumb = new THREE.Group(); thumb.position.set(-0.012, 0.012, -0.04); thumb.rotation.set(0.5, 0, 0.6); hand.add(thumb);
  box(thumb, 0.018, 0.045, 0.018, 0, -0.02, 0, color);
  // cuff and sleeve start
  part(hand, CYL, cuffColor, 0.075, 0.04, 0.075, 0, 0.06, 0);
  hand.userData = { fingers, thumb };
  return hand;
}

function curl(hand, amt) {
  for (const [f1, f2] of hand.userData.fingers) { f1.rotation.z = -1.2 * amt; f2.rotation.z = -1.4 * amt; }
}

// Orients a hand+forearm: hand at `h`, elbow at `e` (both in rig space), `roll` spins the palm.
const _up = new THREE.Vector3(0, 1, 0);
function placeArm(arm, h, e, roll) {
  const dir = new THREE.Vector3().subVectors(e, h);
  const len = dir.length();
  dir.normalize();
  const q = new THREE.Quaternion().setFromUnitVectors(_up, dir).multiply(new THREE.Quaternion().setFromAxisAngle(_up, roll));
  arm.hand.position.copy(h); arm.hand.quaternion.copy(q);
  arm.sleeve.position.copy(h).addScaledVector(dir, 0.08 + (len - 0.08) / 2);
  arm.sleeve.quaternion.setFromUnitVectors(_up, dir);
  arm.sleeve.scale.set(1, Math.max(0.05, len - 0.08), 1);
}

function makeArm(root, team) {
  const sleeveColor = team === 'T' ? 0x5a5040 : 0x3e4a59;
  const glove = team === 'T' ? 0x5e4a35 : 0x7a6a50, cuff = team === 'T' ? 0x3a3428 : 0x2a323d;
  const hand = buildHand(glove, cuff, sleeveColor);
  root.add(hand);
  const sleeveGeo = new THREE.CylinderGeometry(0.036, 0.042, 1, 9);
  const sleeve = new THREE.Mesh(sleeveGeo, mat(sleeveColor));
  root.add(sleeve);
  return { hand, sleeve };
}

const lerp = (a, b, t) => a + (b - a) * t;
const ease = (t) => t * t * (3 - 2 * t);
// Piecewise-linear keyframe track: keys = [[t, value...], ...] → array of values at time t.
function track(keys, t) {
  if (t <= keys[0][0]) return keys[0].slice(1);
  for (let i = 1; i < keys.length; i++) {
    if (t <= keys[i][0]) {
      const a = keys[i - 1], b = keys[i], f = ease((t - a[0]) / (b[0] - a[0] || 1));
      return a.slice(1).map((v, k) => lerp(v, b[k + 1], f));
    }
  }
  return keys[keys.length - 1].slice(1);
}

export function viewModel(id, team) {
  const root = new THREE.Group();
  const rig = new THREE.Group(); root.add(rig);          // whole-rig motion (reload tilt etc.)
  const gun = weaponModel(id);
  rig.add(gun);
  const right = makeArm(rig, team), left = makeArm(rig, team);
  const long = LONG.has(id), pistol = PISTOL.has(id), nade = ['he', 'flash', 'smoke'].includes(id);
  if (!long) rig.position.set(-0.02, 0.06, -0.06);
  if (id === 'knife') rig.rotation.set(0.35, 0.3, -0.15);
  const fore = { ak47: -0.33, galil: -0.33, m4a4: -0.34, famas: -0.3, awp: -0.3, mp9: -0.16, mac10: -0.13 }[id] ?? 0;
  const V = (x, y, z) => new THREE.Vector3(x, y, z);
  // rest positions (gun space)
  const rHand = V(0.012, -0.045, 0.045), rElbow = V(0.3, -0.24, 0.38);
  const lRest = long ? V(-0.02, -0.035, fore) : pistol ? V(-0.035, -0.06, 0.03) : V(-0.5, -0.6, 0.4);
  const lElbow = long ? V(-0.55, -0.42, fore + 0.42) : V(-0.38, -0.32, 0.32);
  const mag = gun.userData.mag, slide = gun.userData.slide;
  const magHome = mag.position.clone();
  left.hand.visible = left.sleeve.visible = long || pistol || id === 'bomb';
  curl(right.hand, id === 'knife' || nade ? 0.9 : 0.8);
  curl(left.hand, 0.65);

  const state = { shootT: 9, reload: -1, reloadDur: 1 };
  const muzzle = MUZZLE[id] !== undefined ? V(0, 0.05, MUZZLE[id]).add(rig.position) : null;
  root.userData = {
    muzzle,
    shoot() { state.shootT = 0; },
    reload(dur) { state.reload = 0; state.reloadDur = dur; },
    cancelReload() { state.reload = -1; },
    // advance the animation; called every frame
    update(dt) {
      state.shootT += dt;
      // shot: slide/bolt snaps back and returns
      const s = Math.max(0, 1 - state.shootT / 0.09);
      slide.position.z = (pistol ? 0.035 : 0.02) * s;
      // reload sequence (fractions of the reload time)
      let lh = lRest.clone(), magOff = V(0, 0, 0), magVis = true, rot = [0, 0, 0];
      if (state.reload >= 0) {
        state.reload += dt / state.reloadDur;
        const t = Math.min(1, state.reload);
        if (long) {
          // tilt the gun, hand to mag, mag out, new mag in, hand back, charge
          rot = track([[0, 0, 0, 0], [0.12, 0.25, 0.35, -0.25], [0.8, 0.25, 0.35, -0.25], [0.95, 0, 0, 0]], t);
          const magKeys = [[0, 0, 0, 0], [0.2, 0, 0, 0], [0.32, 0, -0.25, 0.08], [0.4, 0, -0.6, 0.2], [0.5, 0, -0.6, 0.2], [0.62, 0, -0.12, 0.03], [0.7, 0, 0, 0]];
          const mo = track(magKeys, t);
          magOff.set(mo[0], mo[1], mo[2]);
          magVis = !(t > 0.38 && t < 0.52);
          const magPos = magHome.clone().add(magOff);
          const handKeys = [
            [0, lRest.x, lRest.y, lRest.z], [0.18, magPos.x - 0.05, magPos.y - 0.12, magPos.z],
            [0.34, magPos.x - 0.05, -0.4, magPos.z + 0.08], [0.48, -0.1, -0.5, magPos.z + 0.1],
            [0.62, magHome.x - 0.05, magHome.y - 0.2, magHome.z], [0.72, magHome.x - 0.05, magHome.y - 0.1, magHome.z],
            [0.82, 0.07, 0.07, 0.0], [0.88, 0.07, 0.07, 0.08], [1, lRest.x, lRest.y, lRest.z],
          ];
          // during the "magazine" part of the reload the hand follows the magazine
          lh = V(...track(handKeys, t));
          if (t > 0.18 && t < 0.4) lh = magHome.clone().add(magOff).add(V(-0.05, -0.12, 0));
          if (t > 0.5 && t < 0.72) lh = magHome.clone().add(magOff).add(V(-0.05, -0.12, 0));
          if (t > 0.82 && t < 0.9) slide.position.z = 0.06 * Math.sin((t - 0.82) / 0.08 * Math.PI);
        } else if (pistol) {
          rot = track([[0, 0, 0, 0], [0.1, 0.35, -0.3, 0.1], [0.85, 0.35, -0.3, 0.1], [1, 0, 0, 0]], t);
          const mo = track([[0, 0, 0, 0], [0.15, 0, 0, 0], [0.3, 0, -0.3, 0], [0.55, 0, -0.3, 0], [0.7, 0, 0, 0]], t);
          magOff.set(mo[0], mo[1], mo[2]);
          magVis = !(t > 0.28 && t < 0.56);
          lh = V(...track([[0, lRest.x, lRest.y, lRest.z], [0.2, -0.08, -0.3, 0.1], [0.45, -0.1, -0.4, 0.15], [0.62, magHome.x - 0.04, magHome.y - 0.14, magHome.z],
            [0.72, lRest.x, lRest.y, lRest.z], [0.8, -0.02, 0.06, -0.02], [0.86, -0.02, 0.06, 0.04], [1, lRest.x, lRest.y, lRest.z]], t));
          if (t > 0.8 && t < 0.88) slide.position.z = 0.035;
        }
        if (state.reload >= 1) state.reload = -1;
      }
      mag.position.copy(magHome).add(magOff);
      mag.visible = magVis;
      rig.rotation.set(rot[0] + (id === 'knife' ? 0.35 : 0), rot[1] + (id === 'knife' ? 0.3 : 0), rot[2] + (id === 'knife' ? -0.15 : 0));
      placeArm(right, rHand, rElbow, -0.2);
      placeArm(left, lh, lElbow, 2.6);
    },
  };
  root.userData.update(0);
  return root;
}

// muzzle flash sprite
let flashTex = null;
export function muzzleFlash() {
  if (!flashTex) {
    const c = document.createElement('canvas'); c.width = c.height = 64;
    const g = c.getContext('2d');
    const grd = g.createRadialGradient(32, 32, 0, 32, 32, 32);
    grd.addColorStop(0, 'rgba(255,255,230,1)'); grd.addColorStop(0.3, 'rgba(255,200,90,0.9)'); grd.addColorStop(1, 'rgba(255,120,0,0)');
    g.fillStyle = grd;
    g.beginPath();
    for (let i = 0; i < 16; i++) { const a = i / 16 * Math.PI * 2, r = i % 2 ? 11 : 32; g.lineTo(32 + Math.cos(a) * r, 32 + Math.sin(a) * r); }
    g.fill();
    flashTex = new THREE.CanvasTexture(c);
  }
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: flashTex, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true }));
  s.scale.set(0.22, 0.22, 0.22);
  s.visible = false;
  return s;
}

// ================================================================== characters
// Texture skin: a 256x256 canvas with regions for each body part (like a GoldSrc .mdl skin).
const SKIN_SIZE = 256;
const REG = {
  torso: [0, 0, 128, 96], pants: [128, 0, 64, 96], sleeve: [192, 0, 64, 96],
  head: [0, 96, 96, 64], boot: [96, 96, 32, 32], glove: [96, 128, 32, 32], vest: [128, 96, 128, 64],
  belt: [0, 160, 128, 16], skin: [128, 160, 32, 32],
};

function paintSkin(team) {
  const c = document.createElement('canvas'); c.width = c.height = SKIN_SIZE;
  const g = c.getContext('2d');
  const r = (() => { let s = team === 'T' ? 7 : 13; return () => { s = (s * 16807) % 2147483647; return s / 2147483647; }; })();
  const fill = (reg, col) => { g.fillStyle = col; g.fillRect(...REG[reg]); };
  const noise = (reg, a) => { const [x, y, w, h] = REG[reg]; for (let i = 0; i < w * h / 6; i++) { g.fillStyle = r() < 0.5 ? `rgba(0,0,0,${a})` : `rgba(255,255,255,${a * 0.6})`; g.fillRect(x + r() * w, y + r() * h, 1 + r() * 2, 1 + r() * 2); } };
  const camo = (reg, cols) => { const [x, y, w, h] = REG[reg]; for (let i = 0; i < 70; i++) { g.fillStyle = cols[i % cols.length]; g.beginPath(); g.ellipse(x + r() * w, y + r() * h, 3 + r() * 9, 2 + r() * 5, r() * 3, 0, 7); g.fill(); } };
  const [tx, ty, tw, th] = REG.torso;
  if (team === 'T') {
    fill('torso', '#5b5440'); noise('torso', 0.12);
    // jacket front (u = 0.5 is the front): zipper, chest pockets, collar
    g.fillStyle = '#2a261c'; g.fillRect(tx + tw * 0.5 - 1, ty, 2, th);
    g.fillStyle = '#4a4433'; g.fillRect(tx + tw * 0.36, ty + 20, 14, 12); g.fillRect(tx + tw * 0.56, ty + 20, 14, 12);
    g.fillStyle = '#3a3528'; g.fillRect(tx, ty, tw, 6);
    fill('pants', '#4f4a3a'); noise('pants', 0.12);
    g.fillStyle = '#3e3a2d'; g.fillRect(REG.pants[0] + 8, 40, 18, 22); g.fillRect(REG.pants[0] + 38, 40, 18, 22); // cargo pockets
    fill('sleeve', '#5b5440'); noise('sleeve', 0.12);
    fill('vest', '#2c2a25'); noise('vest', 0.1);
    for (let k = 0; k < 4; k++) { g.fillStyle = '#3a372f'; g.fillRect(REG.vest[0] + 30 + k * 18, REG.vest[1] + 30, 15, 22); g.fillStyle = '#1e1c18'; g.fillRect(REG.vest[0] + 30 + k * 18, REG.vest[1] + 30, 15, 4); }
    // balaclava with an eye slit (face is at u = 0.75 on a sphere)
    fill('head', '#1d1d1e'); noise('head', 0.08);
    g.fillStyle = '#b98d6c'; g.fillRect(REG.head[0] + REG.head[2] * 0.75 - 13, REG.head[1] + 26, 26, 8);
    g.fillStyle = '#20150e'; g.fillRect(REG.head[0] + REG.head[2] * 0.75 - 9, REG.head[1] + 29, 5, 3); g.fillRect(REG.head[0] + REG.head[2] * 0.75 + 4, REG.head[1] + 29, 5, 3);
    fill('boot', '#3a2f25'); fill('glove', '#2a2a2b');
  } else {
    fill('torso', '#3e4a5a'); camo('torso', ['#33404f', '#4c5868', '#2c3744']); noise('torso', 0.08);
    g.fillStyle = '#2a3340'; g.fillRect(tx, ty, tw, 6);
    fill('pants', '#3e4a5a'); camo('pants', ['#33404f', '#4c5868', '#2c3744']);
    g.fillStyle = '#1f2328'; g.fillRect(REG.pants[0] + 4, 56, 56, 12);                   // knee pads band
    fill('sleeve', '#3e4a5a'); camo('sleeve', ['#33404f', '#4c5868']);
    fill('vest', '#5d6446'); noise('vest', 0.1);
    for (let k = 0; k < 3; k++) { g.fillStyle = '#4c5338'; g.fillRect(REG.vest[0] + 38 + k * 18, REG.vest[1] + 28, 15, 24); g.fillStyle = '#3b4129'; g.fillRect(REG.vest[0] + 38 + k * 18, REG.vest[1] + 28, 15, 5); }
    g.fillStyle = '#2b2f22'; g.fillRect(REG.vest[0] + 20, REG.vest[1] + 8, 88, 6);      // shoulder straps
    // head: mask over the lower face, goggles band
    fill('head', '#b98d6c');
    g.fillStyle = '#25272a'; g.fillRect(REG.head[0], REG.head[1] + 34, REG.head[2], 30);
    g.fillStyle = '#121314'; g.fillRect(REG.head[0], REG.head[1] + 20, REG.head[2], 12);
    g.fillStyle = '#3a5560'; g.fillRect(REG.head[0] + REG.head[2] * 0.75 - 14, REG.head[1] + 21, 28, 9);
    fill('boot', '#1b1c1e'); fill('glove', '#7a6a50');
  }
  fill('belt', '#1f1d1a');
  fill('skin', '#b98d6c');
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
const skinCache = {};
const skinFor = (team) => skinCache[team] ||= paintSkin(team);

// Map a geometry's 0..1 uvs into a skin region.
function remapUV(geo, reg) {
  const [x, y, w, h] = REG[reg], uv = geo.attributes.uv;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, (x + uv.getX(i) * w) / SKIN_SIZE, 1 - (y + (1 - uv.getY(i)) * h) / SKIN_SIZE);
  return geo;
}

// Skeleton (rest pose: standing, arms hanging). [name, parent, x, y, z] positions relative to the parent.
const BONES = [
  ['root', -1, 0, 0, 0], ['pelvis', 0, 0, 0.95, 0], ['spine', 1, 0, 0.12, 0], ['chest', 2, 0, 0.24, 0], ['neck', 3, 0, 0.27, 0], ['head', 4, 0, 0.07, 0],
  ['clavL', 3, -0.1, 0.2, 0], ['armL', 6, -0.12, 0, 0], ['foreL', 7, 0, -0.28, 0], ['handL', 8, 0, -0.25, 0],
  ['clavR', 3, 0.1, 0.2, 0], ['armR', 10, 0.12, 0, 0], ['foreR', 11, 0, -0.28, 0], ['handR', 12, 0, -0.25, 0],
  ['thighL', 1, -0.1, -0.04, 0], ['calfL', 14, 0, -0.44, 0], ['footL', 15, 0, -0.43, 0],
  ['thighR', 1, 0.1, -0.04, 0], ['calfR', 17, 0, -0.44, 0], ['footR', 18, 0, -0.43, 0],
];

function bodyParts(team) {
  // [bone, geometry (built around the bone's origin, rest pose)]
  const P = [];
  const limb = (rT, rB, len, reg, sx = 1, sz = 1) => { const g = remapUV(new THREE.CylinderGeometry(rT, rB, len, 8, 2), reg); g.translate(0, -len / 2, 0); g.scale(sx, 1, sz); return g; };
  const up = (g, y) => { g.translate(0, y, 0); return g; };
  // torso pieces
  P.push(['pelvis', up(limb(0.15, 0.16, 0.2, 'pants', 1.25, 0.8), 0.12)]);
  P.push(['pelvis', up(remapUV(new THREE.CylinderGeometry(0.165, 0.165, 0.05, 8), 'belt').scale(1.25, 1, 0.82), 0.08)]);
  P.push(['spine', up(limb(0.175, 0.16, 0.26, 'torso', 1.3, 0.78), 0.26)]);
  P.push(['chest', up(limb(0.2, 0.18, 0.3, 'torso', 1.32, 0.8), 0.3)]);
  P.push(['chest', up(limb(0.21, 0.21, 0.3, 'vest', 1.3, 0.85), 0.29)]);           // plate carrier / chest rig
  P.push(['neck', up(limb(0.06, 0.065, 0.1, team === 'T' ? 'head' : 'skin'), 0.08)]);
  const head = remapUV(new THREE.SphereGeometry(0.115, 12, 10), 'head'); head.scale(1, 1.12, 1.05); head.translate(0, 0.12, 0);
  P.push(['head', head]);
  if (team === 'CT') {
    const helmet = remapUV(new THREE.SphereGeometry(0.135, 12, 6, 0, Math.PI * 2, 0, Math.PI * 0.55), 'vest'); helmet.translate(0, 0.16, 0.01);
    P.push(['head', helmet]);
  }
  for (const s of ['L', 'R']) {
    const sx = s === 'L' ? -1 : 1;
    P.push([`arm${s}`, limb(0.062, 0.052, 0.3, 'sleeve')]);
    const pad = remapUV(new THREE.BoxGeometry(0.13, 0.1, 0.15), 'vest'); pad.translate(0, -0.02, 0);
    P.push([`arm${s}`, pad]);
    P.push([`fore${s}`, limb(0.05, 0.042, 0.26, 'sleeve')]);
    const hand = remapUV(new THREE.BoxGeometry(0.07, 0.1, 0.05), 'glove'); hand.translate(0, -0.05, 0);
    P.push([`hand${s}`, hand]);
    P.push([`thigh${s}`, limb(0.088, 0.07, 0.45, 'pants')]);
    P.push([`calf${s}`, limb(0.068, 0.055, 0.44, 'pants')]);
    if (team === 'CT') { const kp = remapUV(new THREE.BoxGeometry(0.11, 0.1, 0.05), 'boot'); kp.translate(0, -0.03, -0.065); P.push([`calf${s}`, kp]); }
    const foot = remapUV(new THREE.BoxGeometry(0.1, 0.09, 0.25), 'boot'); foot.translate(0, -0.02, -0.06);
    P.push([`foot${s}`, foot]);
    void sx;
  }
  return P;
}

export function playerModel(team) {
  const root = new THREE.Group();
  const bones = [], restWorld = [];
  for (const [name, parent, x, y, z] of BONES) {
    const b = new THREE.Bone(); b.name = name; b.position.set(x, y, z);
    if (parent >= 0) bones[parent].add(b);
    bones.push(b);
    restWorld.push(new THREE.Vector3(x, y, z).add(parent >= 0 ? restWorld[parent] : new THREE.Vector3()));
  }
  const byName = Object.fromEntries(bones.map((b, i) => [b.name, i]));
  // merge all parts into one skinned geometry (each vertex weighted 100% to its bone)
  const pos = [], nor = [], uv = [], si = [], sw = [];
  for (const [bone, geo0] of bodyParts(team)) {
    const geo = geo0.index ? geo0.toNonIndexed() : geo0;
    const bi = byName[bone], o = restWorld[bi];
    const p = geo.attributes.position, n = geo.attributes.normal, t = geo.attributes.uv;
    for (let i = 0; i < p.count; i++) {
      pos.push(p.getX(i) + o.x, p.getY(i) + o.y, p.getZ(i) + o.z);
      nor.push(n.getX(i), n.getY(i), n.getZ(i));
      uv.push(t.getX(i), t.getY(i));
      si.push(bi, 0, 0, 0); sw.push(1, 0, 0, 0);
    }
    if (geo !== geo0) geo0.dispose();
    geo.dispose();
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(si, 4));
  g.setAttribute('skinWeight', new THREE.Float32BufferAttribute(sw, 4));
  g.computeBoundingSphere();
  g.boundingSphere.radius = 1.4; // animated limbs stay inside this for frustum culling
  const material = new THREE.MeshLambertMaterial({ map: skinFor(team) });
  const mesh = new THREE.SkinnedMesh(g, material);
  mesh.add(bones[0]);
  mesh.bind(new THREE.Skeleton(bones));
  root.add(mesh);
  const B = (n) => bones[byName[n]];
  // the third-person weapon rides on the chest (in front of the hands)
  const gunHolder = new THREE.Group();
  gunHolder.position.set(0.08, 0.18, -0.3);
  B('chest').add(gunHolder);
  const shadow = new THREE.Mesh(new THREE.CircleGeometry(0.42, 16), blobMat());
  shadow.rotation.x = -Math.PI / 2; shadow.position.y = 0.03;
  root.add(shadow);
  root.userData = { mesh, material, B, gunHolder, weapon: null, stance: 'rifle', walk: 0, crouch: 0, kick: 0, light: new THREE.Color(1, 1, 1), shadow };
  animatePlayer(root, 0, false, 0, 0);
  return root;
}

let blob = null;
function blobMat() {
  if (blob) return blob;
  const c = document.createElement('canvas'); c.width = c.height = 64;
  const g = c.getContext('2d');
  const grd = g.createRadialGradient(32, 32, 4, 32, 32, 32);
  grd.addColorStop(0, 'rgba(0,0,0,0.5)'); grd.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = grd; g.fillRect(0, 0, 64, 64);
  blob = new THREE.MeshBasicMaterial({ map: new THREE.CanvasTexture(c), transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -3 });
  return blob;
}

export function setPlayerWeapon(model, id) {
  const u = model.userData;
  if (u.weapon === id) return;
  u.weapon = id;
  disposeModel(u.gunHolder);
  u.gunHolder.clear();
  if (id) { const w = weaponModel(id); mergeMeshes(w); u.gunHolder.add(w); }
  u.stance = LONG.has(id) ? 'rifle' : PISTOL.has(id) ? 'pistol' : 'knife';
  u.gunHolder.position.set(u.stance === 'rifle' ? 0.08 : 0.02, u.stance === 'rifle' ? 0.18 : 0.2, u.stance === 'rifle' ? -0.3 : -0.48);
}

// Third-person shot: quick recoil of the upper body.
export function playerShoot(model) { model.userData.kick = 1; }

// Model lighting from the world (rgb ~0..2 from the lightmap).
export function setPlayerLight(model, rgb, dt) {
  const u = model.userData;
  const k = Math.min(1, dt * 6);
  // lightmap values include the sun; the scene lights add shape, so scale the sample down
  u.light.r += (Math.min(1.6, rgb[0] * 0.75 + 0.2) - u.light.r) * k;
  u.light.g += (Math.min(1.6, rgb[1] * 0.75 + 0.2) - u.light.g) * k;
  u.light.b += (Math.min(1.6, rgb[2] * 0.75 + 0.2) - u.light.b) * k;
  u.material.color.copy(u.light);
}

// Keyframed procedural animation: run/walk cycle, crouch, aim pitch blend, recoil.
export function animatePlayer(model, speed, crouch, pitch, dt, airborne = false) {
  const u = model.userData, B = u.B;
  u.walk += dt * Math.min(speed, 7) * 1.75;
  u.crouch += ((crouch ? 1 : 0) - u.crouch) * Math.min(1, dt * 12);
  u.kick = Math.max(0, u.kick - dt * 8);
  const c = u.crouch;
  const amt = Math.min(1, speed / 4.5) * (1 - c * 0.45);
  const s = Math.sin(u.walk);
  // legs
  for (const [side, ph] of [['L', s], ['R', -s]]) {
    const th = B('thigh' + side), cf = B('calf' + side), ft = B('foot' + side);
    const knee = Math.max(0, Math.sin(u.walk + (side === 'L' ? 0 : Math.PI) - 0.7));
    th.rotation.x = ph * 0.6 * amt + c * 1.35 + (airborne ? 0.6 : 0);
    cf.rotation.x = -(knee * 1.0 * amt + c * 2.2 + (airborne ? 1.0 : 0));
    ft.rotation.x = c * 0.85 + knee * 0.3 * amt;
  }
  // body height, bob and lean
  B('pelvis').position.y = 0.95 - c * 0.42 + Math.abs(Math.cos(u.walk)) * 0.03 * amt;
  B('pelvis').position.z = c * 0.06;
  B('pelvis').rotation.y = s * 0.12 * amt;
  B('spine').rotation.x = c * 0.25 + pitch * 0.25 + u.kick * 0.06;
  B('spine').rotation.y = -s * 0.12 * amt;
  B('chest').rotation.x = pitch * 0.35 + u.kick * 0.06;
  B('head').rotation.x = pitch * 0.35;
  // arms (stance per weapon type; limbs hang down -y, +x rotation swings forward)
  const st = u.stance;
  const A = (n, x, y, z) => B(n).rotation.set(x, y, z);
  if (st === 'rifle') {
    A('armR', 0.55, 0, 0.35); A('foreR', 1.35, 0, -0.2); A('handR', 0, 0, 0);
    A('armL', 1.25, 0, 0.55); A('foreL', 0.4, 0, 0.35); A('handL', 0, 0, 0);
  } else if (st === 'pistol') {
    A('armR', 1.4, 0, -0.15); A('foreR', 0.1, 0, 0); A('handR', 0, 0, 0);
    A('armL', 1.35, 0, 0.5); A('foreL', 0.15, 0, 0); A('handL', 0, 0, 0);
  } else {
    A('armR', 0.5, 0, 0.12); A('foreR', 0.9, 0, 0); A('handR', 0, 0, 0);
    A('armL', s * 0.4 * amt + 0.15, 0, -0.08); A('foreL', 0.4, 0, 0); A('handL', 0, 0, 0);
  }
}

// Text label sprite (teammate names)
export function nameSprite(text, color) {
  const c = document.createElement('canvas'); c.width = 256; c.height = 48;
  const g = c.getContext('2d');
  g.font = 'bold 26px Segoe UI, Arial'; g.textAlign = 'center'; g.textBaseline = 'middle';
  g.lineWidth = 5; g.strokeStyle = 'rgba(0,0,0,0.8)'; g.strokeText(text, 128, 24);
  g.fillStyle = color; g.fillText(text, 128, 24);
  const t = new THREE.CanvasTexture(c);
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: t, depthTest: false, transparent: true }));
  s.scale.set(1.2, 0.225, 1);
  s.renderOrder = 10;
  return s;
}

// Lights for dynamic objects (players, dropped weapons, decorations), matched to the map's sun.
export function addActorLights(scene, theme) {
  const g = new THREE.Group();
  const hemi = new THREE.HemisphereLight(new THREE.Color(...theme.ambient.map(v => Math.min(1, v * 1.6))), 0x8a7458, 2.2);
  const sun = new THREE.DirectionalLight(new THREE.Color(...theme.sunColor.map(v => v / 1.5)), 2.6);
  sun.position.set(...theme.sun);
  g.add(hemi, sun);
  scene.add(g);
  return g;
}
