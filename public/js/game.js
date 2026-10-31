// The in-game client: local movement, shooting, other players, effects and HUD wiring.
import * as THREE from 'three';
import { getMap, CELL, zoneAt, Z_A, Z_B } from '/shared/maps.js';
import * as P from '/shared/physics.js';
import { WEAPONS, recoilOffset } from '/shared/weapons.js';
import { buildWorld, drawMapCanvas } from './world.js';
import { viewModel, muzzleFlash, playerModel, setPlayerWeapon, animatePlayer, weaponModel, nameSprite, addActorLights, disposeModel, playerShoot, setPlayerLight } from './models.js';

const ease01 = (t) => t * t * (3 - 2 * t);
import { sfx, setListener } from './audio.js';
import { settings } from './settings.js';
import { Hud } from './hud.js';

const DEG = Math.PI / 180;
const RUN_SPEED = 6.0, ACCEL = 9, AIR_ACCEL = 12, FRICTION = 5.2;
const NADE_TYPES = ['he', 'flash', 'smoke'];
const $ = (id) => document.getElementById(id);

let smokeTex = null, puffTex = null;
function softTex(r, g, b) {
  const c = document.createElement('canvas'); c.width = c.height = 64;
  const x = c.getContext('2d');
  const grd = x.createRadialGradient(32, 32, 0, 32, 32, 32);
  grd.addColorStop(0, `rgba(${r},${g},${b},1)`); grd.addColorStop(0.6, `rgba(${r},${g},${b},0.6)`); grd.addColorStop(1, `rgba(${r},${g},${b},0)`);
  x.fillStyle = grd; x.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(c);
}

export class Game {
  constructor(net, ui) {
    this.net = net;
    this.ui = ui; // callbacks into main.js (pause menu etc.)
    this.hud = new Hud();
    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    this.renderer.autoClear = false;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    $('view').appendChild(this.renderer.domElement);
    // Weak/older GPUs sometimes reset the graphics driver; recover instead of leaving a dead black screen.
    this.renderer.domElement.addEventListener('webglcontextlost', (e) => { e.preventDefault(); this.contextLost = true; this.hud.center('Graphics driver reset, recovering…', 4000); });
    this.renderer.domElement.addEventListener('webglcontextrestored', () => {
      this.contextLost = false;
      if (this.active && this.map) { this.loadMap(this.map.id); this.buildViewModel(); }
    });
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(settings.fov, 1, 0.05, settings.viewDist);
    this.camera.rotation.order = 'YXZ';
    this.vmScene = new THREE.Scene();
    this.vmCamera = new THREE.PerspectiveCamera(68, 1, 0.01, 10); // view models get their own, wider FOV (like 1.6)
    this.vmScene.add(new THREE.HemisphereLight(0xe8eef5, 0x6a5a48, 2.4));
    const vl = new THREE.DirectionalLight(0xfff2dd, 2.6); vl.position.set(1, 2, 1); this.vmScene.add(vl);
    this.vm = null; this.vmFlash = muzzleFlash();
    this.applySettings();
    window.addEventListener('resize', () => this.resize());
    this.resize();

    this.keys = new Set();
    this.mouse = { left: false, right: false };
    this.active = false;
    this.world = null;
    this.map = null;
    this.reset();
    this.bindInput();
    this.bindNet();
    this.last = performance.now();
    this.frames = 0; this.fpsT = 0;
    requestAnimationFrame((t) => this.loop(t));
  }

  reset() {
    this.me = { id: 0, team: 'SPEC', alive: false, hp: 100, armor: 0, helmet: false, kit: false, money: 0, primary: null, secondary: null, nades: [], hasBomb: false };
    this.pos = { x: 0, y: 0, z: 0 }; this.vel = { x: 0, y: 0, z: 0 };
    this.yaw = 0; this.pitch = 0; this.crouchT = 0; this.onGround = true; this.sid = 0;
    this.cur = 'knife'; this.lastWeapon = null; this.ammo = {}; this.nextFire = 0; this.reloadEnd = 0; this.drawEnd = 0;
    this.spray = 0; this.punch = { yaw: 0, pitch: 0 }; this.scope = 0; this.vmKick = 0; this.lastShotT = 0;
    this.remotes = new Map(); this.items = new Map(); this.nadesVis = []; this.smokes = []; this.effects = [];
    this.bomb = { state: 'none' }; this.bombMesh = null; this.nextBeep = 0;
    this.phase = 'warmup'; this.left = -1; this.leftAt = 0; this.info = null; this.names = {};
    this.prog = null; this.flashUntil = 0; this.flashFade = 0; this.stepDist = 0; this.sendT = 0;
    this.spec = { target: 0, free: { x: 0, y: 20, z: 0 } };
    this.deadAt = 0; this.planting = false; this.defusing = false; this.lobby = null; this.hostId = 0;
  }

  applySettings() {
    this.renderer.setPixelRatio(settings.renderScale);
    this.camera.far = settings.viewDist;
    if (this.scene.fog) { this.scene.fog.far = settings.viewDist; this.scene.fog.near = settings.viewDist * 0.5; }
    this.resize();
    this.hud.cache.cross = null;
  }

  resize() {
    const w = window.innerWidth, h = window.innerHeight;
    this.renderer.setSize(w, h);
    this.camera.aspect = this.vmCamera.aspect = w / h;
    this.camera.updateProjectionMatrix(); this.vmCamera.updateProjectionMatrix();
  }

  // ------------------------------------------------------------ lifecycle
  enter(lobby, mapId, myId, hostId, mapVersion) {
    this.leave();
    this.reset();
    this.lobby = lobby; this.me.id = myId; this.hostId = hostId;
    this.loadMap(mapId, mapVersion);
    this.active = true;
    this.hud.show(true);
  }

  leave() {
    this.active = false;
    try { navigator.keyboard?.unlock?.(); if (document.fullscreenElement) document.exitFullscreen().catch(() => {}); } catch { /* ignore */ }
    this.hud.show(false);
    if (this.world) { this.world.dispose(); this.world = null; }
    for (const r of this.remotes.values()) { this.scene.remove(r.model); disposeModel(r.model); }
    for (const m of this.items.values()) this.scene.remove(m);
    for (const s of this.smokes) this.scene.remove(s.group);
    for (const n of this.nadesVis) this.scene.remove(n.mesh);
    for (const e of this.effects) this.scene.remove(e.obj);
    if (this.bombMesh) this.scene.remove(this.bombMesh);
    this.scene.clear();
  }

  async loadMap(id, serverVersion) {
    if (this.world) { this.world.dispose(); this.world = null; }
    for (const s of this.smokes) this.scene.remove(s.group);
    this.smokes = [];
    if (this.actorLights) this.scene.remove(this.actorLights);
    this.map = getMap(id);
    if (serverVersion && serverVersion !== this.map.version) {
      this.hud.center('This map was changed on the server. Press F5 to reload the page and get the new version.', 15000);
    }
    this.clearPools();
    const token = this.loadToken = (this.loadToken || 0) + 1;
    const overlay = document.getElementById('loading'), label = overlay.querySelector('h2');
    overlay.classList.remove('hidden');
    label.textContent = `Loading ${this.map.name}…`;
    const t0 = performance.now();
    const world = await buildWorld(this.map, this.scene, (f) => { label.textContent = `${this.map.mesh ? 'Loading' : 'Baking lighting for'} ${this.map.name}… ${Math.round(f * 100)}%`; }, this.renderer);
    if (token !== this.loadToken) { world.dispose(); return; } // a newer load started meanwhile
    this.world = world;
    overlay.classList.add('hidden');
    console.log(`Built ${this.map.name} in ${Math.round(performance.now() - t0)} ms`);
    this.actorLights = world.ownLights ? null : addActorLights(this.scene, this.map.theme);
    this.scene.fog = new THREE.Fog(this.map.theme.fog, settings.viewDist * 0.5, settings.viewDist);
    // imported maps are detailed and large: a farther near plane gives more depth precision
    this.camera.near = this.map.mesh ? 0.12 : 0.05; this.camera.updateProjectionMatrix();
    this.hud.setRadarMap(drawMapCanvas(this.map, 3));
    const c = this.map.siteCenter.A;
    this.spec.free = { x: this.map.w * CELL / 2, y: 30, z: this.map.h * CELL / 2 };
    this.pos = { x: c.x, y: c.y, z: c.z };
    this.eyeY = undefined;
  }

  lockPointer() {
    if (!this.active) return;
    try { const p = this.renderer.domElement.requestPointerLock?.(); if (p && p.catch) p.catch(() => {}); } catch { /* not allowed here */ }
    this.lockKeyboard();
  }

  // Crouch is Ctrl, and Ctrl+W / Ctrl+S / Ctrl+D are browser shortcuts (close tab, save, bookmark).
  // In fullscreen, Chrome/Edge let a page "lock" the keyboard so those combos reach the game instead.
  async lockKeyboard() {
    if (!settings.fullscreen) return;
    try {
      if (!document.fullscreenElement) await document.documentElement.requestFullscreen({ navigationUI: 'hide' });
      if (navigator.keyboard && navigator.keyboard.lock) await navigator.keyboard.lock();
    } catch { /* fullscreen or keyboard lock not allowed: the beforeunload prompt still protects the tab */ }
  }
  get locked() { return document.pointerLockElement === this.renderer.domElement; }

  // ------------------------------------------------------------ input
  bindInput() {
    const canvas = this.renderer.domElement;
    canvas.addEventListener('click', () => { if (this.active && !this.locked && !this.ui.overlayOpen()) this.lockPointer(); });
    document.addEventListener('pointerlockchange', () => {
      if (!this.locked && this.active && !this.ui.overlayOpen() && !this.chatOpen) this.ui.openPause();
      if (!this.locked) { this.mouse.left = this.mouse.right = false; this.keys.clear(); this.stopUse(); }
    });
    document.addEventListener('mousemove', (e) => {
      if (!this.locked) return;
      const zoom = this.scope ? this.camera.fov / settings.fov : 1;
      const k = 0.0022 * settings.sens * zoom;
      this.yaw -= e.movementX * k;
      this.pitch = Math.max(-1.55, Math.min(1.55, this.pitch - e.movementY * k));
      this.sway = (this.sway || 0) + e.movementX * 0.0004;
      if (!this.me.alive && e.movementX === 0) { /* noop */ }
    });
    document.addEventListener('mousedown', (e) => {
      if (!this.locked) return;
      if (e.button === 0) { this.mouse.left = true; if (!this.me.alive) this.cycleSpectate(); }
      if (e.button === 2) { this.mouse.right = true; this.secondary(); }
    });
    document.addEventListener('mouseup', (e) => {
      if (e.button === 0) { this.mouse.left = false; if (this.cur === 'bomb') this.stopUse(); }
      if (e.button === 2) this.mouse.right = false;
    });
    document.addEventListener('contextmenu', (e) => e.preventDefault());
    document.addEventListener('wheel', (e) => {
      if (!this.locked || !this.me.alive) return;
      const order = this.ownedSlots().map(s => s[1]);
      const i = order.indexOf(this.cur);
      const n = order[(i + (e.deltaY > 0 ? 1 : -1) + order.length) % order.length];
      if (n) this.switchTo(n);
    });
    document.addEventListener('keydown', (e) => {
      if (!this.active) return;
      if (this.chatOpen) {
        if (e.code === 'Enter') { const v = $('chat-input').value.trim(); if (v) this.net.send({ t: 'chat', text: v, team: this.chatTeam }); this.closeChat(); }
        else if (e.code === 'Escape') this.closeChat();
        return;
      }
      // With the keyboard locked Esc reaches the page instead of releasing the mouse, so open the menu ourselves
      if (e.code === 'Escape' && this.locked) { document.exitPointerLock(); return; }
      if (e.ctrlKey || e.metaKey) e.preventDefault(); // stop Ctrl+S / Ctrl+D etc. while crouching
      if (e.code === 'Tab') { e.preventDefault(); $('scoreboard').classList.remove('hidden'); this.hud.scoreboard(this.info, this.me.id, this.lobby?.name); return; }
      if (e.code === 'KeyB' && this.me.alive) { this.ui.toggleBuy(); return; }
      if (e.code === 'KeyM') { this.ui.openTeamSelect(); return; }
      if (!this.locked) return;
      if (e.code === 'KeyY' || e.code === 'KeyU') { e.preventDefault(); this.openChat(e.code === 'KeyU'); return; }
      if (e.ctrlKey && e.code !== 'ControlLeft' && e.code !== 'ControlRight') e.preventDefault();
      this.keys.add(e.code);
      if (!this.me.alive) return;
      switch (e.code) {
        case 'Digit1': if (this.me.primary) this.switchTo(this.me.primary); break;
        case 'Digit2': if (this.me.secondary) this.switchTo(this.me.secondary); break;
        case 'Digit3': this.switchTo('knife'); break;
        case 'Digit4': {
          const owned = NADE_TYPES.filter(n => this.me.nades.includes(n));
          if (owned.length) { const i = owned.indexOf(this.cur); this.switchTo(owned[(i + 1) % owned.length]); }
          break;
        }
        case 'Digit5': if (this.me.hasBomb) this.switchTo('bomb'); break;
        case 'KeyQ': if (this.lastWeapon && this.owns(this.lastWeapon)) this.switchTo(this.lastWeapon); break;
        case 'KeyR': this.reload(); break;
        case 'KeyG': this.dropCurrent(); break;
        case 'KeyE': this.use(); break;
      }
    });
    document.addEventListener('keyup', (e) => {
      this.keys.delete(e.code);
      if (e.code === 'Tab') $('scoreboard').classList.add('hidden');
      if (e.code === 'KeyE') this.stopUse();
    });
    window.addEventListener('blur', () => { this.keys.clear(); this.mouse.left = this.mouse.right = false; });
  }

  openChat(team) {
    this.chatOpen = true; this.chatTeam = team;
    const i = $('chat-input');
    i.classList.remove('hidden'); i.value = ''; i.placeholder = team ? 'Team chat…' : 'Chat to all…';
    this.keys.clear();
    setTimeout(() => i.focus(), 0);
  }
  closeChat() { this.chatOpen = false; const i = $('chat-input'); i.blur(); i.classList.add('hidden'); }

  // ------------------------------------------------------------ inventory
  owns(id) {
    if (!id) return false;
    if (id === 'knife') return true;
    if (id === 'bomb') return this.me.hasBomb;
    if (WEAPONS[id]?.nade) return this.me.nades.includes(id);
    return this.me.primary === id || this.me.secondary === id;
  }

  ownedSlots() {
    const s = [];
    if (this.me.primary) s.push(['1', this.me.primary]);
    if (this.me.secondary) s.push(['2', this.me.secondary]);
    s.push(['3', 'knife']);
    for (const n of NADE_TYPES) if (this.me.nades.includes(n)) s.push(['4', n]);
    if (this.me.hasBomb) s.push(['5', 'bomb']);
    return s;
  }

  bestWeapon() { return this.me.primary || this.me.secondary || 'knife'; }

  switchTo(id, silent) {
    if (!this.owns(id)) return;
    if (id === this.cur && this.vm) return;
    if (this.cur !== id) this.lastWeapon = this.cur;
    this.cur = id;
    this.reloadEnd = 0; this.scope = 0; this.spray = 0;
    this.drawEnd = performance.now() / 1000 + (silent ? 0 : 0.45);
    this.stopUse();
    this.buildViewModel();
    if (!silent) sfx.draw();
  }

  buildViewModel() {
    if (this.vm) this.vmScene.remove(this.vm);
    this.vm = viewModel(this.cur, this.me.team);
    this.vm.position.set(0.2, -0.2, -0.4);
    this.vm.scale.setScalar(0.7);
    if (this.vm.userData.muzzle) { this.vmFlash.position.copy(this.vm.userData.muzzle); this.vm.add(this.vmFlash); }
    this.vmScene.add(this.vm);
  }

  syncAmmo() {
    const owned = [this.me.primary, this.me.secondary].filter(Boolean);
    for (const id of owned) if (!this.ammo[id]) this.ammo[id] = { mag: WEAPONS[id].mag, reserve: WEAPONS[id].reserve };
    for (const id of Object.keys(this.ammo)) if (!owned.includes(id)) delete this.ammo[id];
  }

  reload() {
    const w = WEAPONS[this.cur], a = this.ammo[this.cur];
    if (!w || !a || w.melee || w.nade || this.reloadEnd || a.mag >= w.mag || a.reserve <= 0) return;
    this.reloadEnd = performance.now() / 1000 + w.reload;
    this.scope = 0;
    sfx.reload();
    if (this.vm) this.vm.userData.reload(w.reload);
  }

  dropCurrent() {
    if (this.cur === 'knife' || WEAPONS[this.cur]?.nade) return;
    this.net.send({ t: 'drop', w: this.cur });
  }

  use() {
    if (!this.me.alive) return;
    const b = this.bomb;
    if (this.me.team === 'CT' && b.state === 'planted' && Math.hypot(this.pos.x - b.x, this.pos.z - b.z) < 2.2) {
      this.defusing = true; this.net.send({ t: 'defuse', on: true }); return;
    }
    if (this.me.hasBomb && this.inSite()) { this.switchTo('bomb', true); this.planting = true; this.net.send({ t: 'plant', on: true }); return; }
    const it = this.lookItem();
    if (it) this.net.send({ t: 'pickup', id: it.id });
  }

  stopUse() {
    if (this.planting) { this.planting = false; this.net.send({ t: 'plant', on: false }); }
    if (this.defusing) { this.defusing = false; this.net.send({ t: 'defuse', on: false }); }
  }

  inSite() { const z = zoneAt(this.map, this.pos.x, this.pos.z); return z === Z_A || z === Z_B; }

  lookItem() {
    let best = null, bd = 2.6;
    const fx = -Math.sin(this.yaw), fz = -Math.cos(this.yaw);
    for (const [id, m] of this.items) {
      const dx = m.position.x - this.pos.x, dz = m.position.z - this.pos.z, d = Math.hypot(dx, dz);
      if (d < bd && (d < 1.2 || (dx * fx + dz * fz) / d > 0.6)) { bd = d; best = { id, w: m.userData.w }; }
    }
    return best;
  }

  // ------------------------------------------------------------ shooting
  eye() { return { x: this.pos.x, y: this.pos.y + P.EYE_STAND + (P.EYE_CROUCH - P.EYE_STAND) * this.crouchT, z: this.pos.z }; }

  currentSpread(w) {
    const speed = Math.hypot(this.vel.x, this.vel.z);
    let s = w.spread;
    if (w.scope && !this.scope) s = w.unscoped;
    s += w.moveSpread * Math.max(0, Math.min(1, (speed - 1.4) / 4));
    if (!this.onGround) s += 0.12;
    if (this.crouchT > 0.5) s *= 0.75;
    return s;
  }

  secondary() {
    if (!this.me.alive) return;
    const w = WEAPONS[this.cur];
    if (w?.scope && !this.reloadEnd) { this.scope = (this.scope + 1) % 3; sfx.empty(); }
    else if (w?.melee) this.tryFire(true);
    else if (w?.nade) this.throwNade(true);
  }

  tryFire(heavy = false) {
    const now = performance.now() / 1000;
    if (now < this.nextFire || now < this.drawEnd || this.reloadEnd || this.phase === 'freeze' || this.planting || this.defusing) return;
    const w = WEAPONS[this.cur];
    if (!w) return;
    if (w.nade) return this.throwNade(false);
    if (this.cur === 'bomb') {
      if (this.inSite()) { if (!this.planting) { this.planting = true; this.net.send({ t: 'plant', on: true }); } }
      else { this.hud.center('You must be at a bombsite to plant'); this.nextFire = now + 1; }
      return;
    }
    const eye = this.eye();
    if (w.melee) {
      this.nextFire = now + (heavy ? w.heavyRate : w.rate);
      const dir = this.dirFrom(this.yaw, this.pitch);
      const hit = P.raycastPlayers(this.enemyHitList(), eye.x, eye.y, eye.z, dir.x, dir.y, dir.z, w.range, this.me.id);
      const wall = P.raycastWorld(this.map, eye.x, eye.y, eye.z, dir.x, dir.y, dir.z, w.range);
      const ok = hit && (!wall || hit.dist < wall.dist);
      this.net.send({ t: 'shoot', w: 'knife', heavy, o: [eye.x, eye.y, eye.z], d: [dir.x, dir.y, dir.z], hit: ok ? { id: hit.id, g: hit.group, dist: hit.dist } : null });
      sfx.knife(null);
      this.vmKick = heavy ? 0.25 : 0.15;
      return;
    }
    const a = this.ammo[this.cur];
    if (!a) return;
    if (a.mag <= 0) { sfx.empty(); this.nextFire = now + 0.25; if (a.reserve > 0) this.reload(); return; }
    a.mag--;
    this.nextFire = now + w.rate;
    if (now - this.lastShotT > w.rate * 2.2 + 0.15) this.spray = Math.max(0, this.spray - (now - this.lastShotT) * 10);
    this.lastShotT = now;
    const rec = w.auto ? recoilOffset(w, Math.floor(this.spray)) : [0, Math.min(this.spray, 4) * w.recoil * 0.5];
    this.spray += 1;
    const spread = this.currentSpread(w);
    const ang = Math.random() * Math.PI * 2, rr = Math.sqrt(Math.random()) * spread;
    const yaw = this.yaw + rec[0] * DEG * 0.55 + Math.cos(ang) * rr;
    const pitch = this.pitch + rec[1] * DEG * 0.55 + Math.sin(ang) * rr;
    const dir = this.dirFrom(yaw, pitch);
    const wall = P.raycastWorld(this.map, eye.x, eye.y, eye.z, dir.x, dir.y, dir.z, 200);
    const maxD = wall ? wall.dist : 200;
    const hit = P.raycastPlayers(this.enemyHitList(), eye.x, eye.y, eye.z, dir.x, dir.y, dir.z, maxD, this.me.id);
    this.net.send({ t: 'shoot', w: this.cur, o: [eye.x, eye.y, eye.z], d: [dir.x, dir.y, dir.z], hit: hit ? { id: hit.id, g: hit.group, dist: hit.dist } : null });
    // view punch
    this.punch.pitch += w.recoil * DEG * (w.auto ? 0.45 : 0.9);
    this.punch.yaw += rec[0] * DEG * 0.05;
    this.vmKick = Math.min(0.12, 0.03 + w.recoil * 0.012);
    if (this.vm) this.vm.userData.shoot();
    sfx.shot(this.cur, null);
    // effects
    const endD = hit ? hit.dist : maxD;
    const end = { x: eye.x + dir.x * endD, y: eye.y + dir.y * endD, z: eye.z + dir.z * endD };
    this.showMuzzle();
    const start = this.muzzleWorld(eye);
    this.tracer(start, end);
    if (hit) this.puff(end, 0xaa1111, 0.35);
    else if (wall) this.impact(wall);
    if (w.scope) this.scope = 0;
    if (a.mag === 0 && a.reserve > 0) setTimeout(() => this.reload(), w.rate * 1000);
  }

  dirFrom(yaw, pitch) {
    return { x: -Math.sin(yaw) * Math.cos(pitch), y: Math.sin(pitch), z: -Math.cos(yaw) * Math.cos(pitch) };
  }

  muzzleWorld(eye) {
    const f = this.dirFrom(this.yaw, this.pitch), rx = Math.cos(this.yaw), rz = -Math.sin(this.yaw);
    return { x: eye.x + f.x * 0.6 + rx * 0.12, y: eye.y + f.y * 0.6 - 0.1, z: eye.z + f.z * 0.6 + rz * 0.12 };
  }

  enemyHitList() {
    const out = [];
    for (const r of this.remotes.values()) {
      if (!r.alive || r.team === this.me.team || !r.model.visible) continue;
      out.push({ id: r.id, x: r.model.position.x, y: r.model.position.y, z: r.model.position.z, crouch: r.crouch });
    }
    return out;
  }

  throwNade(lob) {
    const now = performance.now() / 1000;
    if (now < this.nextFire || now < this.drawEnd || this.phase === 'freeze') return;
    const type = this.cur;
    const eye = this.eye();
    const f = this.dirFrom(this.yaw, this.pitch + 0.12);
    const sp = lob ? 8 : 17;
    const p = [eye.x + f.x * 0.4, eye.y + f.y * 0.4 - 0.1, eye.z + f.z * 0.4];
    if (P.boxBlocked(this.map, p[0], p[1] - 0.1, p[2], 0.1, 0.2)) { p[0] = eye.x; p[2] = eye.z; }
    const v = [f.x * sp + this.vel.x * 0.6, f.y * sp + 1.5 + this.vel.y * 0.3, f.z * sp + this.vel.z * 0.6];
    this.net.send({ t: 'throw', type, p, v });
    this.nextFire = now + 0.8;
    const i = this.me.nades.indexOf(type);
    if (i >= 0) this.me.nades.splice(i, 1);
    this.vmKick = 0.2;
    setTimeout(() => { if (this.cur === type && !this.owns(type)) this.switchTo(this.bestWeapon()); }, 300);
  }

  // ------------------------------------------------------------ effects
  showMuzzle() { this.vmFlash.visible = true; this.vmFlash.material.rotation = Math.random() * 6; this.flashOffAt = performance.now() + 45; }

  // Bullet effects come from fixed-size pools that are reused forever, so heavy firefights never allocate
  // new GPU memory (allocating per shot used to pile up and could crash the tab on weak PCs).
  pools() {
    if (!this._pools) {
      if (!puffTex) puffTex = softTex(255, 255, 255);
      const group = new THREE.Group();
      const lineMat = new THREE.LineBasicMaterial({ color: 0xffe9a0, transparent: true, opacity: 0.55 });
      const tracers = Array.from({ length: 24 }, () => {
        const g = new THREE.BufferGeometry();
        g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(6), 3));
        const l = new THREE.Line(g, lineMat);
        l.visible = false; l.frustumCulled = false; l.userData.until = 0;
        group.add(l);
        return l;
      });
      const decalGeo = new THREE.PlaneGeometry(0.1, 0.1);
      const decalMat = new THREE.MeshBasicMaterial({ color: 0x151515, transparent: true, opacity: 0.85, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2 });
      const decals = Array.from({ length: 96 }, () => { const m = new THREE.Mesh(decalGeo, decalMat); m.visible = false; group.add(m); return m; });
      const puffs = Array.from({ length: 48 }, () => {
        const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: puffTex, transparent: true, depthWrite: false }));
        s.visible = false; s.userData = { born: 0, life: 0.3, size: 0.25 };
        group.add(s);
        return s;
      });
      this._pools = { group, tracers, decals, puffs, ti: 0, di: 0, pi: 0 };
    }
    if (this._pools.group.parent !== this.scene) this.scene.add(this._pools.group);
    return this._pools;
  }

  tracer(a, b) {
    const P_ = this.pools(), l = P_.tracers[P_.ti++ % P_.tracers.length];
    const arr = l.geometry.attributes.position.array;
    arr[0] = a.x; arr[1] = a.y; arr[2] = a.z; arr[3] = b.x; arr[4] = b.y; arr[5] = b.z;
    l.geometry.attributes.position.needsUpdate = true;
    l.visible = true; l.userData.until = performance.now() / 1000 + 0.06;
  }

  impact(hit) {
    const P_ = this.pools(), m = P_.decals[P_.di++ % P_.decals.length];
    m.position.set(hit.x + hit.nx * 0.01, hit.y + hit.ny * 0.01, hit.z + hit.nz * 0.01);
    m.lookAt(hit.x + hit.nx, hit.y + hit.ny, hit.z + hit.nz);
    m.visible = true;
    this.puff(hit, 0xb8a888, 0.25);
  }

  puff(p, color, size) {
    const P_ = this.pools(), s = P_.puffs[P_.pi++ % P_.puffs.length];
    s.position.set(p.x, p.y, p.z); s.scale.setScalar(size);
    s.material.color.setHex(color); s.material.opacity = 1;
    s.userData = { born: performance.now() / 1000, life: 0.3, size };
    s.visible = true;
  }

  updatePools(now) {
    if (!this._pools) return;
    for (const l of this._pools.tracers) if (l.visible && now > l.userData.until) l.visible = false;
    for (const s of this._pools.puffs) {
      if (!s.visible) continue;
      const t = (now - s.userData.born) / s.userData.life;
      if (t >= 1) { s.visible = false; continue; }
      s.scale.setScalar(s.userData.size * (1 + t * 4)); s.material.opacity = 1 - t;
    }
  }

  clearPools() {
    if (!this._pools) return;
    for (const o of this._pools.group.children) o.visible = false;
  }

  explosionFx(p, big) {
    if (!puffTex) puffTex = softTex(255, 255, 255);
    const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: puffTex, color: 0xffa040, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }));
    s.position.set(p.x, p.y + 0.5, p.z);
    const R = big ? 14 : 5;
    this.addEffect(s, 0.6, (e, t) => { s.scale.setScalar(R * (0.3 + t)); s.material.opacity = 1 - t; });
    const d = new THREE.Sprite(new THREE.SpriteMaterial({ map: puffTex, color: 0x333333, transparent: true, depthWrite: false }));
    d.position.set(p.x, p.y + 1, p.z);
    this.addEffect(d, 2, (e, t) => { d.scale.setScalar(R * (0.5 + t)); d.position.y = p.y + 1 + t * 2; d.material.opacity = 0.7 * (1 - t); });
    const dist = Math.hypot(p.x - this.pos.x, p.z - this.pos.z);
    if (dist < (big ? 40 : 15)) this.shake = Math.max(this.shake || 0, (big ? 1 : 0.5) * (1 - dist / (big ? 40 : 15)));
  }

  addEffect(obj, life, update) {
    this.scene.add(obj);
    this.effects.push({ obj, born: performance.now() / 1000, life, update });
  }

  updateEffects(now) {
    this.effects = this.effects.filter(e => {
      const t = (now - e.born) / e.life;
      if (t >= 1) { this.scene.remove(e.obj); e.obj.geometry?.dispose(); e.obj.material?.dispose(); return false; }
      if (e.update) e.update(e, t);
      return true;
    });
    while (this.effects.length > 60) { const e = this.effects.shift(); this.scene.remove(e.obj); e.obj.geometry?.dispose(); e.obj.material?.dispose(); }
    this.updatePools(now);
  }

  smokeCloud(x, y, z, leftMs) {
    if (!smokeTex) smokeTex = softTex(200, 200, 200);
    const group = new THREE.Group();
    const parts = [];
    for (let i = 0; i < 16; i++) {
      const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: smokeTex, color: 0xb9bcbf, transparent: true, depthWrite: false, opacity: 0.95 }));
      const a = Math.random() * Math.PI * 2, r = Math.random() * 2.3;
      s.userData = { tx: Math.cos(a) * r, ty: 0.6 + Math.random() * 2.4, tz: Math.sin(a) * r, size: 3 + Math.random() * 1.8 };
      s.scale.setScalar(0.5);
      group.add(s); parts.push(s);
    }
    group.position.set(x, y, z);
    this.scene.add(group);
    const now = performance.now() / 1000;
    this.smokes.push({ group, parts, born: leftMs < 17000 ? now - 2 : now, until: now + leftMs / 1000, x, y, z });
    sfx.smoke({ x, y, z });
  }

  updateSmokes(now) {
    this.smokes = this.smokes.filter(s => {
      if (now > s.until) { this.scene.remove(s.group); return false; }
      const grow = Math.min(1, (now - s.born) / 1.2), fade = Math.min(1, (s.until - now) / 2);
      for (const p of s.parts) {
        const u = p.userData;
        p.position.set(u.tx * grow, u.ty * Math.max(0.3, grow), u.tz * grow);
        p.scale.setScalar(u.size * (0.3 + 0.7 * grow));
        p.material.opacity = 0.95 * fade;
      }
      return true;
    });
  }

  // ------------------------------------------------------------ networking
  bindNet() {
    const n = this.net;
    n.on('spawn', (m) => {
      this.pos = { x: m.x, y: m.y, z: m.z }; this.vel = { x: 0, y: 0, z: 0 };
      this.yaw = m.yaw; this.pitch = 0; this.sid = m.sid; this.crouchT = 0;
      this.flashUntil = 0; this.hud.flash(0); this.scope = 0; this.punch = { yaw: 0, pitch: 0 };
      this.me.alive = true;
      this.ammo = {};
      this.pendingSpawnSelect = true;
      this.hud.spectate(null);
    });
    n.on('self', (m) => {
      const wasAlive = this.me.alive;
      const prevTeam = this.me.team;
      Object.assign(this.me, m);
      this.syncAmmo();
      if (prevTeam !== m.team && this.vm) this.buildViewModel();
      if (wasAlive && !m.alive) { this.deadAt = performance.now(); this.stopUse(); this.scope = 0; }
      if (m.alive && (this.pendingSpawnSelect || !this.owns(this.cur))) {
        this.pendingSpawnSelect = false;
        this.cur = null;
        this.switchTo(this.bestWeapon(), true);
      }
      this.hud.vitals(m.hp, m.armor, m.helmet, m.money, m.hasBomb, m.kit);
    });
    n.on('pos', (m) => { this.pos.x = m.x; this.pos.y = m.y; this.pos.z = m.z; this.vel = { x: 0, y: 0, z: 0 }; });
    n.on('snap', (m) => this.onSnap(m));
    n.on('info', (m) => {
      this.info = m; this.hostId = m.host;
      for (const p of m.players) this.names[p.id] = p;
      if (m.map !== this.map?.id) { /* map message handles it */ }
      if (!$('scoreboard').classList.contains('hidden')) this.hud.scoreboard(m, this.me.id, this.lobby?.name);
      this.ui.onInfo(m);
    });
    n.on('shot', (m) => {
      if (m.id === this.me.id) return;
      const o = { x: m.o[0], y: m.o[1], z: m.o[2] }, e = { x: m.e[0], y: m.e[1], z: m.e[2] };
      sfx.shot(m.w, o);
      const r = this.remotes.get(m.id);
      if (r) { r.flashT = performance.now() + 50; playerShoot(r.model); }
      this.tracer({ x: o.x, y: o.y - 0.15, z: o.z }, e);
      const d = Math.hypot(e.x - o.x, e.y - o.y, e.z - o.z) || 1;
      const hit = P.raycastWorld(this.map, o.x, o.y, o.z, (e.x - o.x) / d, (e.y - o.y) / d, (e.z - o.z) / d, d + 0.05);
      if (hit && hit.dist > d - 0.1) this.impact(hit);
    });
    n.on('slash', (m) => { if (m.id !== this.me.id) { const r = this.remotes.get(m.id); sfx.knife(r ? r.model.position : null); } });
    n.on('hurt', (m) => {
      sfx.hurt();
      const ang = Math.atan2(-(m.x - this.pos.x), -(m.z - this.pos.z)) - this.yaw;
      if (m.from) this.hud.damageFrom(-ang);
      this.vel.x *= 0.45; this.vel.z *= 0.45; // tagging
      this.punch.pitch += 0.02;
      this.me.hp = m.hp;
      this.hud.vitals(this.me.hp, this.me.armor, this.me.helmet, this.me.money, this.me.hasBomb, this.me.kit);
    });
    n.on('hitmark', (m) => { this.hud.hitmarker(m.head); sfx.hit(m.head); });
    n.on('kill', (m) => {
      const k = this.names[m.k], v = this.names[m.v];
      this.hud.killfeed(k, v, m.w, m.hs, m.k === this.me.id || m.v === this.me.id);
      const r = this.remotes.get(m.v);
      if (r) { r.alive = false; r.deadT = performance.now(); }
      if (m.v === this.me.id) {
        this.me.alive = false; this.deadAt = performance.now();
        this.hud.center(k && m.k !== m.v ? `Killed by ${k.name}` : 'You died', 3000);
        if (m.k) this.spec.target = m.k;
      }
    });
    n.on('items', (m) => this.onItems(m.items));
    n.on('bomb', (m) => this.onBomb(m));
    n.on('planting', (m) => { if (m.id === this.me.id) this.prog = { label: 'Planting the bomb…', start: performance.now(), dur: m.time }; });
    n.on('plantCancel', (m) => { if (m.id === this.me.id) { this.prog = null; this.planting = false; } });
    n.on('defusing', (m) => { if (m.id === this.me.id) this.prog = { label: 'Defusing…', start: performance.now(), dur: m.time }; });
    n.on('defuseCancel', (m) => { if (m.id === this.me.id) { this.prog = null; this.defusing = false; } });
    n.on('planted', (m) => {
      this.hud.roundMsg('The bomb has been planted', 't', 3000);
      if (this.planting) { this.planting = false; this.prog = null; }
      if (this.cur === 'bomb') this.switchTo(this.bestWeapon());
      void m;
    });
    n.on('nade', (m) => {
      const sim = P.simulateGrenade(this.map, { x: m.p[0], y: m.p[1], z: m.p[2] }, { x: m.v[0], y: m.v[1], z: m.v[2] }, m.type);
      const mesh = weaponModel(m.type);
      mesh.scale.setScalar(1.6);
      this.scene.add(mesh);
      this.nadesVis.push({ id: m.id, mesh, path: sim.path, t0: performance.now() / 1000, lastVy: 0 });
      if (m.owner === this.me.id) sfx.knife(null);
    });
    n.on('det', (m) => {
      const v = this.nadesVis.find(x => x.id === m.id);
      if (v) { this.scene.remove(v.mesh); this.nadesVis = this.nadesVis.filter(x => x !== v); }
      const p = { x: m.x, y: m.y, z: m.z };
      if (m.type === 'he') { sfx.explosion(p); this.explosionFx(p, false); }
      if (m.type === 'flash') this.flashbang(p);
      if (m.type === 'smoke') this.smokeCloud(m.x, m.y, m.z, m.left || 18000);
    });
    n.on('roundStart', (m) => {
      this.hud.roundMsg(`Round ${m.round}`, '', 2000);
      sfx.roundStart();
      for (const s of this.smokes) this.scene.remove(s.group);
      this.smokes = [];
      for (const v of this.nadesVis) this.scene.remove(v.mesh);
      this.nadesVis = [];
      this.prog = null; this.planting = false; this.defusing = false;
      this.onBomb({ state: 'carried' });
      if (this.me.team !== 'SPEC') this.hud.center('Buy time: press B to open the buy menu', 4000);
    });
    n.on('phase', (m) => {
      if (m.phase === 'live') this.hud.center(this.me.team === 'T' ? 'Plant the bomb or eliminate the enemy' : this.me.team === 'CT' ? 'Defend the bombsites' : '', 3000);
      this.ui.closeBuy();
    });
    n.on('roundEnd', (m) => {
      this.hud.roundMsg(m.text, m.winner === 'T' ? 't' : 'ct', 4500);
      if (this.me.team !== 'SPEC') sfx.win(m.winner === this.me.team);
      this.prog = null;
    });
    n.on('msg', (m) => this.hud.chat('', '', m.text, true));
    n.on('chat', (m) => this.hud.chat((m.dead ? '*DEAD* ' : '') + (m.teamOnly ? '(Team) ' : '') + m.name, m.team, m.text));
    n.on('picked', () => sfx.pickup());
    n.on('bought', (m) => {
      sfx.buy();
      const w = WEAPONS[m.item];
      if (w && (w.slot === 1 || w.slot === 2) && this.me.alive) setTimeout(() => this.switchTo(m.item), 50);
    });
    n.on('map', (m) => { this.loadMap(m.map, m.version); this.onItems([]); this.onBomb({ state: 'none' }); });
    n.on('host', (m) => { this.hostId = m.id; });
  }

  onSnap(m) {
    const now = performance.now();
    this.phase = m.ph; this.left = m.left; this.leftAt = now;
    if (m.prog && m.prog.id === this.me.id && this.prog) this.prog.remain = m.prog.end;
    const seen = new Set();
    for (const [id, x, y, z, yaw, pitch, c, w, alive, team] of m.pl) {
      if (id === this.me.id) {
        if (!this.me.alive && alive && this.sid) { /* wait for spawn message */ }
        continue;
      }
      seen.add(id);
      let r = this.remotes.get(id);
      const tm = team === 0 ? 'T' : 'CT';
      if (!r || r.team !== tm) {
        if (r) { this.scene.remove(r.model); disposeModel(r.model); }
        const model = playerModel(tm);
        r = { id, team: tm, model, buf: [], alive: !!alive, crouch: false, step: 0, lastPos: null, label: null };
        this.scene.add(model);
        this.remotes.set(id, r);
      }
      if (alive && !r.alive) { r.buf = []; r.model.rotation.x = 0; r.model.position.y = y; }
      r.alive = !!alive;
      r.buf.push({ t: now, x, y, z, yaw, pitch, c: !!c, w });
      if (r.buf.length > 30) r.buf.shift();
    }
    for (const [id, r] of this.remotes) if (!seen.has(id)) { this.scene.remove(r.model); disposeModel(r.model); this.remotes.delete(id); }
  }

  onItems(list) {
    const ids = new Set(list.map(i => i.id));
    for (const [id, m] of this.items) if (!ids.has(id)) { this.scene.remove(m); this.items.delete(id); }
    for (const it of list) {
      if (this.items.has(it.id)) continue;
      const m = weaponModel(it.w);
      m.scale.setScalar(1.4);
      m.position.set(it.x, it.y + 0.05, it.z);
      m.rotation.set(0, (it.id * 1.7) % 6.28, Math.PI / 2);
      m.userData.w = it.w;
      this.scene.add(m);
      this.items.set(it.id, m);
    }
  }

  onBomb(m) {
    const prev = this.bomb.state;
    this.bomb = { ...m, at: performance.now(), explodeAt: m.left ? performance.now() + m.left : 0 };
    if (this.bombMesh) { this.scene.remove(this.bombMesh); this.bombMesh = null; }
    if (m.state === 'dropped' || m.state === 'planted' || m.state === 'defused') {
      const g = weaponModel('bomb');
      g.scale.setScalar(1.6);
      g.position.set(m.x, m.y + 0.08, m.z);
      const light = new THREE.Mesh(new THREE.SphereGeometry(0.025, 6, 4), new THREE.MeshBasicMaterial({ color: 0xff2020 }));
      light.position.set(-0.06, 0.06, -0.1);
      g.add(light);
      g.userData.light = light;
      this.bombMesh = g;
      this.scene.add(g);
    }
    if (m.state === 'exploded' && prev !== 'exploded') { sfx.explosion(m, true); this.explosionFx(m, true); }
    if (m.state === 'defused' && prev === 'planted') { sfx.defused(m); this.prog = null; this.defusing = false; }
    if (m.state === 'planted' && prev !== 'planted') this.nextBeep = 0;
  }

  flashbang(p) {
    sfx.flashbang(p);
    this.puff({ x: p.x, y: p.y, z: p.z }, 0xffffff, 1.5);
    if (!this.me.alive) return;
    const eye = this.eye();
    const d = Math.hypot(p.x - eye.x, p.y - eye.y, p.z - eye.z);
    if (d > 40 || !P.lineOfSight(this.map, { x: p.x, y: p.y + 0.15, z: p.z }, eye)) return;
    const f = this.dirFrom(this.yaw, this.pitch);
    const dot = ((p.x - eye.x) * f.x + (p.y - eye.y) * f.y + (p.z - eye.z) * f.z) / (d || 1);
    let amount = dot > 0.6 ? 1 : dot > 0.2 ? 0.75 : dot > -0.3 ? 0.4 : 0.15;
    amount *= Math.max(0.2, 1 - d / 42);
    const now = performance.now() / 1000;
    this.flashUntil = Math.max(this.flashUntil, now + amount * 3.2);
    this.flashFade = 1.6 * amount + 0.3;
    if (amount > 0.3) sfx.ring(amount);
  }

  // ------------------------------------------------------------ per-frame
  loop(t) {
    requestAnimationFrame((tt) => this.loop(tt));
    const dt = Math.min(0.05, (t - this.last) / 1000);
    this.last = t;
    this.frames++; this.fpsT += dt;
    if (this.fpsT >= 0.5) { this.hud.fps(Math.round(this.frames / this.fpsT)); this.frames = 0; this.fpsT = 0; }
    if (!this.active || !this.map || this.contextLost) return;
    const now = t / 1000;

    if (this.me.alive) {
      this.updateMovement(dt, now);
      this.updateWeapon(dt, now);
    } else if (this.me.team === 'SPEC' || !this.specTarget()) {
      this.updateFreeCam(dt);
    }
    if (this.flashOffAt && performance.now() > this.flashOffAt) { this.vmFlash.visible = false; this.flashOffAt = 0; }

    // send state
    this.sendT += dt;
    if (this.sendT >= 1 / 30 && this.me.alive) {
      this.sendT = 0;
      this.net.send({ t: 'st', sid: this.sid, x: +this.pos.x.toFixed(3), y: +this.pos.y.toFixed(3), z: +this.pos.z.toFixed(3), yaw: +this.yaw.toFixed(4), pitch: +this.pitch.toFixed(4), c: this.crouchT > 0.5 ? 1 : 0, w: this.cur });
    }

    this.updateRemotes(dt);
    this.updateNades(now);
    this.updateSmokes(now);
    this.updateEffects(now);
    this.updateBombFx(now);
    this.updateCamera(dt, now);
    this.updateHud(now);

    this.renderer.clear();
    this.renderer.render(this.scene, this.camera); // the skybox is the scene background
    if (this.me.alive && this.vm && settings.viewmodel && !this.scope) {
      this.renderer.clearDepth();
      this.renderer.render(this.vmScene, this.vmCamera);
    }
  }

  updateMovement(dt, now) {
    const k = this.keys;
    const frozen = this.phase === 'freeze' || this.planting || this.defusing || this.chatOpen;
    let fx = 0, fz = 0;
    if (!frozen) {
      if (k.has('KeyW')) fz -= 1;
      if (k.has('KeyS')) fz += 1;
      if (k.has('KeyA')) fx -= 1;
      if (k.has('KeyD')) fx += 1;
    }
    let crouching = !frozen && (k.has('ControlLeft') || k.has('KeyC'));
    // stay crouched while there is no room to stand up (under a low roof or a ledge)
    if (!crouching && this.crouchT > 0.3 && P.boxBlocked(this.map, this.pos.x, this.pos.y + 0.02, this.pos.z, P.PLAYER_R, P.STAND_H)) crouching = true;
    this.crouchT += ((crouching ? 1 : 0) - this.crouchT) * Math.min(1, dt * 10);
    const walking = k.has('ShiftLeft') || k.has('ShiftRight');
    const sin = Math.sin(this.yaw), cos = Math.cos(this.yaw);
    // forward = (-sin, -cos), right = (cos, -sin)
    let wx = -sin * -fz + cos * fx, wz = -cos * -fz - sin * fx;
    const wl = Math.hypot(wx, wz);
    if (wl > 0) { wx /= wl; wz /= wl; }
    const w = WEAPONS[this.cur] || WEAPONS.knife;
    let maxSpeed = RUN_SPEED * (w.speed || 1);
    if (this.scope && w.scoped) maxSpeed = RUN_SPEED * w.scoped;
    if (walking) maxSpeed *= 0.52;
    if (this.crouchT > 0.5) maxSpeed *= 0.34;
    const v = this.vel;
    if (this.onGround) {
      const sp = Math.hypot(v.x, v.z);
      if (sp > 0) {
        const drop = Math.max(sp, 1.6) * FRICTION * dt;
        const ns = Math.max(0, sp - drop) / sp;
        v.x *= ns; v.z *= ns;
      }
      if (wl > 0) {
        const cur = v.x * wx + v.z * wz, add = maxSpeed - cur;
        if (add > 0) { const acc = Math.min(ACCEL * dt * maxSpeed, add); v.x += acc * wx; v.z += acc * wz; }
      }
      if (k.has('Space') && !frozen) { v.y = P.JUMP_V; this.onGround = false; }
    } else if (wl > 0) {
      const wish = Math.min(maxSpeed, 0.8);
      const cur = v.x * wx + v.z * wz, add = wish - cur;
      if (add > 0) { const acc = Math.min(AIR_ACCEL * dt * maxSpeed, add); v.x += acc * wx; v.z += acc * wz; }
    }
    v.y -= P.GRAVITY * dt;
    const wasGround = this.onGround;
    const fallSpeed = v.y;
    const before = { x: this.pos.x, z: this.pos.z };
    this.onGround = P.moveBody(this.map, this.pos, v, dt, P.PLAYER_R, this.crouchT > 0.5 ? P.CROUCH_H : P.STAND_H);
    if (this.onGround && !wasGround && fallSpeed < -4) sfx.land(null);
    // footsteps
    const moved = Math.hypot(this.pos.x - before.x, this.pos.z - before.z);
    const speed = Math.hypot(v.x, v.z);
    if (this.onGround && speed > 3.4) {
      this.stepDist += moved;
      if (this.stepDist > 2.1) { this.stepDist = 0; sfx.step(null, 0.18); }
    }
    this.bob = (this.bob || 0) + (this.onGround ? speed * dt : 0);
    void now;
  }

  updateWeapon(dt, now) {
    const w = WEAPONS[this.cur];
    if (this.reloadEnd && now >= this.reloadEnd) {
      this.reloadEnd = 0;
      const a = this.ammo[this.cur];
      if (a && w) { const take = Math.min(w.mag - a.mag, a.reserve); a.mag += take; a.reserve -= take; }
    }
    if (this.mouse.left && w) {
      if (w.auto) this.tryFire();
      else if (!this.firedThisClick) { this.tryFire(); this.firedThisClick = true; }
      if (this.cur === 'bomb' && !this.planting) this.tryFire();
    } else {
      this.firedThisClick = false;
    }
    // recoil recovery
    if (now - this.lastShotT > (w?.rate || 0.1) * 1.5) this.spray = Math.max(0, this.spray - dt * 14);
    const rec = Math.min(1, dt * 9);
    this.punch.pitch -= this.punch.pitch * rec;
    this.punch.yaw -= this.punch.yaw * rec;
  }

  updateFreeCam(dt) {
    const k = this.keys, f = this.spec.free;
    const sp = (k.has('ShiftLeft') ? 30 : 14) * dt;
    const d = this.dirFrom(this.yaw, this.pitch);
    const rx = Math.cos(this.yaw), rz = -Math.sin(this.yaw);
    if (k.has('KeyW')) { f.x += d.x * sp; f.y += d.y * sp; f.z += d.z * sp; }
    if (k.has('KeyS')) { f.x -= d.x * sp; f.y -= d.y * sp; f.z -= d.z * sp; }
    if (k.has('KeyA')) { f.x -= rx * sp; f.z -= rz * sp; }
    if (k.has('KeyD')) { f.x += rx * sp; f.z += rz * sp; }
    if (k.has('Space')) f.y += sp;
    if (k.has('ControlLeft')) f.y -= sp;
    f.y = Math.max(0.5, Math.min(60, f.y));
  }

  specCandidates() {
    const all = [...this.remotes.values()].filter(r => r.alive);
    const mates = all.filter(r => r.team === this.me.team);
    return this.me.team === 'SPEC' ? all : mates.length ? mates : all;
  }

  specTarget() {
    if (this.me.team === 'SPEC') return null;
    if (performance.now() - this.deadAt < 2500) return null;
    const c = this.specCandidates();
    if (!c.length) return null;
    let t = c.find(r => r.id === this.spec.target);
    if (!t) { t = c[0]; this.spec.target = t.id; }
    return t;
  }

  cycleSpectate() {
    const c = this.specCandidates();
    if (!c.length) return;
    const i = c.findIndex(r => r.id === this.spec.target);
    this.spec.target = c[(i + 1) % c.length].id;
  }

  updateRemotes(dt) {
    const rt = performance.now() - 100;
    for (const r of this.remotes.values()) {
      const b = r.buf;
      if (!b.length) continue;
      let s = b[b.length - 1];
      let px = s.x, py = s.y, pz = s.z, yaw = s.yaw, pitch = s.pitch;
      for (let i = b.length - 1; i > 0; i--) {
        if (b[i - 1].t <= rt) {
          const a = b[i - 1], c = b[i];
          const f = Math.max(0, Math.min(1, (rt - a.t) / ((c.t - a.t) || 1)));
          px = a.x + (c.x - a.x) * f; py = a.y + (c.y - a.y) * f; pz = a.z + (c.z - a.z) * f;
          let dy = c.yaw - a.yaw; dy = ((dy + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
          yaw = a.yaw + dy * f; pitch = a.pitch + (c.pitch - a.pitch) * f;
          s = c;
          break;
        }
      }
      const m = r.model;
      const prev = r.lastPos || { x: px, z: pz };
      const speed = Math.hypot(px - prev.x, pz - prev.z) / Math.max(dt, 0.001);
      const vy = r.lastY === undefined ? 0 : (py - r.lastY) / Math.max(dt, 0.001);
      r.lastPos = { x: px, z: pz }; r.lastY = py;
      r.crouch = s.c;
      if (r.alive) {
        m.visible = true;
        m.position.set(px, py, pz);
        m.rotation.set(0, yaw, 0);
        animatePlayer(m, speed, s.c, pitch, dt, Math.abs(vy) > 1.5);
        // GoldSrc-style model lighting: take the colour of the lightmap under the player's feet
        r.lightT = (r.lightT || 0) - dt;
        if (r.lightT <= 0 && this.world) { r.lightT = 0.15; r.lightSample = this.world.lightAt(px, py, pz) || r.lightSample; }
        if (r.lightSample) setPlayerLight(m, r.lightSample, dt);
        setPlayerWeapon(m, s.w);
        r.eye = { x: px, y: py + (s.c ? P.EYE_CROUCH : P.EYE_STAND), z: pz, yaw, pitch };
        if (speed > 3.4) {
          r.step += speed * dt;
          if (r.step > 2.1) { r.step = 0; sfx.step(m.position, 0.5); }
        }
      } else {
        // fall over
        m.rotation.x = Math.max(-Math.PI / 2, m.rotation.x - dt * 5);
        if (performance.now() - (r.deadT || 0) > 15000) m.visible = false;
      }
      // name labels for teammates
      const showLabel = r.alive && r.team === this.me.team;
      if (showLabel && !r.label) { r.label = nameSprite(this.names[r.id]?.name || '?', r.team === 'T' ? '#e3b04b' : '#6fa8dc'); r.label.position.y = 2.15; m.add(r.label); }
      if (r.label) r.label.visible = showLabel;
    }
  }

  updateNades(now) {
    for (const n of this.nadesVis) {
      const f = (now - n.t0) / P.NADE_DT;
      const i = Math.min(n.path.length - 1, Math.floor(f));
      const a = n.path[i], b = n.path[Math.min(n.path.length - 1, i + 1)], u = f - i;
      n.mesh.position.set(a.x + (b.x - a.x) * u, a.y + (b.y - a.y) * u, a.z + (b.z - a.z) * u);
      n.mesh.rotation.x += 0.2;
      const vy = b.y - a.y;
      if (n.lastVy < -0.01 && vy >= 0 && i < n.path.length - 2) sfx.bounce(n.mesh.position);
      n.lastVy = vy;
    }
  }

  updateBombFx(now) {
    const b = this.bomb;
    if (b.state !== 'planted' || !this.bombMesh) return;
    const remain = (b.explodeAt - performance.now()) / 1000;
    const interval = Math.max(0.12, Math.min(1, remain / 40));
    if (now > this.nextBeep) {
      this.nextBeep = now + interval;
      sfx.beep(b);
      this.bombMesh.userData.light.visible = true;
      setTimeout(() => { if (this.bombMesh) this.bombMesh.userData.light.visible = false; }, 80);
    }
  }

  updateCamera(dt, now) {
    const cam = this.camera;
    let fov = settings.fov;
    if (this.me.alive) {
      const e = this.eye();
      // smooth out stair steps
      if (this.eyeY === undefined || Math.abs(e.y - this.eyeY) > 2) this.eyeY = e.y;
      else this.eyeY += (e.y - this.eyeY) * Math.min(1, dt * 20);
      e.y = this.eyeY;
      cam.position.set(e.x, e.y, e.z);
      cam.rotation.set(this.pitch + this.punch.pitch, this.yaw + this.punch.yaw, 0);
      if (this.scope === 1) fov = 40; else if (this.scope === 2) fov = 15;
      setListener(e.x, e.y, e.z, this.yaw);
      this.hud.spectate(null);
    } else {
      const t = this.specTarget();
      if (t && t.eye) {
        const e = t.eye;
        const back = this.dirFrom(e.yaw, e.pitch);
        let dist = 2.6;
        const hit = P.raycastWorld(this.map, e.x, e.y + 0.3, e.z, -back.x, -back.y, -back.z, dist);
        if (hit) dist = Math.max(0.3, hit.dist - 0.2);
        cam.position.set(e.x - back.x * dist, e.y + 0.3 - back.y * dist, e.z - back.z * dist);
        cam.rotation.set(e.pitch, e.yaw, 0);
        this.hud.spectate(`Spectating ${this.names[t.id]?.name || ''}  ·  click to switch`);
        setListener(e.x, e.y, e.z, e.yaw);
      } else {
        const f = this.spec.free;
        cam.position.set(f.x, f.y, f.z);
        cam.rotation.set(this.pitch, this.yaw, 0);
        this.hud.spectate(this.me.team === 'SPEC' ? 'Free camera · WASD to fly · M to join a team' : (performance.now() - this.deadAt < 2500 ? null : 'Free camera'));
        setListener(f.x, f.y, f.z, this.yaw);
      }
    }
    if (this.shake > 0) {
      cam.rotation.x += (Math.random() - 0.5) * this.shake * 0.05;
      cam.rotation.y += (Math.random() - 0.5) * this.shake * 0.05;
      this.shake = Math.max(0, this.shake - dt * 1.5);
    }
    if (cam.fov !== fov) { cam.fov = fov; cam.updateProjectionMatrix(); }

    // viewmodel animation
    if (this.vm) {
      const sp = Math.hypot(this.vel.x, this.vel.z);
      const bobAmt = Math.min(1, sp / 6) * (this.onGround ? 1 : 0.2);
      const b = this.bob || 0;
      this.sway = (this.sway || 0) * Math.max(0, 1 - dt * 8);
      // draw sequence: the rig swings up from below the screen
      const draw = ease01(Math.max(0, this.drawEnd - now) / 0.45);
      const breathe = Math.sin(now * 1.6) * 0.004;                       // idle sequence
      this.vmKick *= Math.max(0, 1 - dt * 14);
      this.vm.position.set(0.17 + Math.sin(b * 1.6) * 0.01 * bobAmt - this.sway * 0.5,
        -0.18 - draw * 0.3 + breathe + Math.abs(Math.cos(b * 1.6)) * 0.008 * bobAmt - this.crouchT * 0.02,
        -0.45 + this.vmKick * 0.6);
      this.vm.rotation.set(-draw * 0.9 + this.vmKick * 0.6, 0.05 + this.sway, draw * 0.3);
      this.vm.userData.update(dt);                                         // shoot / reload sequences
    }
  }

  updateHud(now) {
    const hud = this.hud;
    // timer
    if (this.bomb.state === 'planted') hud.timer(0, true);
    else hud.timer(this.left < 0 ? -1 : Math.max(0, this.left - (performance.now() - this.leftAt)), false);
    // scores / alive counters
    if (this.info) {
      const ps = this.info.players;
      const t = ps.filter(p => p.team === 'T'), ct = ps.filter(p => p.team === 'CT');
      const aliveOf = (team) => [...this.remotes.values()].filter(r => r.team === team && r.alive).length + (this.me.team === team && this.me.alive ? 1 : 0);
      hud.score(this.info.score.T, this.info.score.CT, aliveOf('T'), t.length, aliveOf('CT'), ct.length);
    }
    // ammo / weapons
    const a = this.ammo[this.cur];
    hud.ammo(this.cur, a ? a.mag : 0, a ? a.reserve : 0);
    hud.slots(this.me.alive ? this.ownedSlots() : [], this.cur);
    // crosshair
    const w = WEAPONS[this.cur];
    let spreadPx = 0, hideCross = !this.me.alive || !!this.scope || (w && w.scope);
    if (w && !w.melee && !w.nade && this.me.alive) spreadPx = Math.min(40, this.currentSpread(w) * 400 + this.spray * (w.auto ? 1.2 : 3));
    hud.applyCrosshair(spreadPx, hideCross);
    hud.scope(this.me.alive && this.scope > 0);
    // flash
    if (this.flashUntil) {
      const n = performance.now() / 1000;
      if (n < this.flashUntil) hud.flash(1);
      else { const f = 1 - (n - this.flashUntil) / this.flashFade; hud.flash(f); if (f <= 0) this.flashUntil = 0; }
    }
    // progress bar
    if (this.prog) {
      const frac = (performance.now() - this.prog.start) / this.prog.dur;
      hud.progress(this.prog.label, frac);
      if (frac > 1.3) this.prog = null;
    } else hud.progress(null);
    // context hints
    let hint = '';
    if (this.me.alive && !this.prog) {
      const b = this.bomb;
      if (this.me.team === 'CT' && b.state === 'planted' && Math.hypot(this.pos.x - b.x, this.pos.z - b.z) < 2.2) hint = `Hold E to defuse${this.me.kit ? '' : ' (no kit: 10s)'}`;
      else if (this.me.hasBomb && this.inSite() && this.phase === 'live') hint = 'Hold E to plant the bomb';
      else { const it = this.lookItem(); if (it) hint = `Press E to pick up ${WEAPONS[it.w]?.name || it.w}`; }
    }
    if (this.phase === 'warmup' && this.left < 0) hint = hint || 'Warmup — waiting for players on both teams';
    hud.hint(hint);
    // radar (10 fps)
    if (now - (this.radarT || 0) > 0.1) {
      this.radarT = now;
      const dots = [];
      for (const r of this.remotes.values()) {
        if (!r.alive || !r.eye) continue;
        if (r.team !== this.me.team && this.me.team !== 'SPEC') continue;
        dots.push({ x: r.eye.x, z: r.eye.z, color: r.team === 'T' ? '#e3b04b' : '#6fa8dc', bomb: this.names[r.id]?.hasBomb });
      }
      let bomb = null;
      if (this.bomb.state === 'planted') bomb = { x: this.bomb.x, z: this.bomb.z, planted: true };
      else if (this.bomb.state === 'dropped' && this.me.team !== 'CT') bomb = { x: this.bomb.x, z: this.bomb.z };
      const me = this.me.alive ? { x: this.pos.x, z: this.pos.z, yaw: this.yaw } : null;
      hud.radar(this.map, me, dots, bomb);
    }
    const alive = this.me.alive;
    if (this.hudAlive !== alive || this.hudTeam !== this.me.team) {
      this.hudAlive = alive; this.hudTeam = this.me.team;
      $('bottom-left').style.display = alive ? '' : 'none';
      $('bottom-right').style.display = alive ? '' : 'none';
      $('money').style.display = this.me.team === 'SPEC' ? 'none' : '';
    }
    document.body.classList.toggle('hurt', alive && this.me.hp <= 20);
  }
}
