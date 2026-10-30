// Strike Lite game server: serves the game files and runs lobbies over WebSockets.
// Start with: node server.js   (or double-click start.bat)
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { getMap, MAP_INFO, MAP_IDS, CELL, Z_A, Z_B, zoneAt, setMapEdit, getAllEdits } from './shared/maps.js';
import { findPath as navFindPath, walkClear, zoneSpots, getNav, nearestNode } from './shared/nav.js';
import * as P from './shared/physics.js';
import { WEAPONS, EQUIPMENT, computeDamage } from './shared/weapons.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 3000;

// ---------------------------------------------------------------- static files
const STATIC = [
  ['/three/', path.join(ROOT, 'node_modules', 'three', 'build')],
  ['/shared/', path.join(ROOT, 'shared')],
  ['/', path.join(ROOT, 'public')],
];
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.json': 'application/json', '.ico': 'image/x-icon' };

// The map editor may only save from the PC running the server (not from friends on the LAN).
const isLocal = (req) => ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress);
const EDITS_FILE = path.join(ROOT, 'shared', 'mapdata', 'edits.js');

// Map editor password. Only a salted hash is stored, because this file is public.
const EDITOR_SALT = 'ea258a96f6416329fa54ad3a3cbe9fe8';
const EDITOR_HASH = Buffer.from('3fe56737227503766b8c724edc1bc17e16ddc4edaa16d2cd28793a84e7c292e1', 'hex');
const editorFails = new Map(); // ip -> { count, until }: slows down password guessing

// Returns null when the password is right, otherwise an [http status, message] pair.
function checkEditorPassword(req, password) {
  const ip = req.socket.remoteAddress, f = editorFails.get(ip) || { count: 0, until: 0 };
  if (Date.now() < f.until) return [429, 'Too many wrong tries. Wait a minute and try again.'];
  const hash = crypto.scryptSync(String(password ?? ''), EDITOR_SALT, 32);
  if (crypto.timingSafeEqual(hash, EDITOR_HASH)) { editorFails.delete(ip); return null; }
  f.count++;
  if (f.count >= 5) { f.count = 0; f.until = Date.now() + 60000; }
  editorFails.set(ip, f);
  return [403, 'Wrong password.'];
}

function handleApi(req, res, url) {
  const json = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
  if (url === '/api/editor-status') return json(200, { canSave: isLocal(req) });
  const m = url.match(/^\/api\/mapedit\/([a-z0-9_]+)$/);
  const unlock = url === '/api/editor-unlock';
  if ((!m && !unlock) || req.method !== 'POST') return json(404, { error: 'not found' });
  if (m && !isLocal(req)) return json(403, { error: 'Maps can only be saved on the PC that runs the server.' });
  let body = '', size = 0;
  req.on('data', (c) => { size += c.length; if (size > 30e6) { req.destroy(); return; } body += c; });
  req.on('end', () => {
    try {
      const { source, password } = JSON.parse(body);
      const denied = checkEditorPassword(req, password);
      if (denied) return json(denied[0], { error: denied[1] });
      if (unlock) return json(200, { ok: true });
      setMapEdit(m[1], source || null);
      fs.writeFileSync(EDITS_FILE, '// Maps saved from the in-game map editor (written by the server). Do not edit by hand.\nexport default ' + JSON.stringify(getAllEdits()) + ';\n');
      // lobbies on this map switch to the new version and their players are told to refresh
      for (const l of lobbies.values()) if (l.mapId === m[1]) l.reloadMap();
      json(200, { ok: true, version: getMap(m[1]).version });
    } catch (e) {
      logError('map save', e);
      json(400, { error: String(e.message || e) });
    }
  });
}

const server = http.createServer((req, res) => {
  let url;
  try { url = decodeURIComponent(req.url.split('?')[0]); } catch { res.writeHead(400); return res.end(); }
  if (url.startsWith('/api/')) return handleApi(req, res, url);
  if (url === '/') url = '/index.html';
  for (const [prefix, dir] of STATIC) {
    if (!url.startsWith(prefix)) continue;
    const file = path.normalize(path.join(dir, url.slice(prefix.length)));
    if (!file.startsWith(dir)) { res.writeHead(403); return res.end(); }
    return fs.readFile(file, (err, data) => {
      if (err) { res.writeHead(404); return res.end('Not found'); }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
      res.end(data);
    });
  }
  res.writeHead(404); res.end();
});

// ---------------------------------------------------------------- constants
const TICK = 1000 / 30;
const FREEZE = 10000, ROUND = 115000, POST = 5000, BUY_TIME = 20000, OVER = 10000;
const BOMB_TIME = 40000, PLANT_TIME = 3200, DEFUSE_TIME = 10000, KIT_TIME = 5000;
const MAX_MONEY = 16000;
const BOT_NAMES = ['Viper', 'Rook', 'Kestrel', 'Bishop', 'Nomad', 'Havoc', 'Wraith', 'Talon', 'Cipher', 'Ember', 'Frost', 'Jackal', 'Onyx', 'Raptor', 'Sable', 'Tundra', 'Vandal', 'Zephyr'];
const DIFF = {
  easy: { react: 650, err: 0.055, turn: 3.5, head: 0.1 },
  normal: { react: 420, err: 0.028, turn: 6, head: 0.25 },
  hard: { react: 240, err: 0.013, turn: 10, head: 0.45 },
};

let nextPlayerId = 1;
const lobbies = new Map();
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const rand = (a, b) => a + Math.random() * (b - a);
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
const dist2d = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);
const eyeY = (p) => p.y + (p.crouch ? P.EYE_CROUCH : P.EYE_STAND);
const cleanText = (s, n) => String(s ?? '').replace(/[<>]/g, '').trim().slice(0, n);

function newPlayer(name, isBot) {
  return {
    id: nextPlayerId++, name, isBot, ws: null, team: 'SPEC', alive: false, hp: 100, armor: 0, helmet: false, kit: false,
    money: 800, primary: null, secondary: null, nades: [], hasBomb: false, x: 0, y: 0, z: 0, yaw: 0, pitch: 0, crouch: false,
    weapon: 'knife', kills: 0, deaths: 0, ping: 0, sid: 0, lastShot: 0, respawnAt: 0, bot: null,
  };
}

function send(p, msg) {
  if (p.ws && p.ws.readyState === 1) p.ws.send(JSON.stringify(msg));
}

// ---------------------------------------------------------------- lobby
class Lobby {
  constructor(opts, host) {
    this.id = Math.random().toString(36).slice(2, 7).toUpperCase();
    this.name = cleanText(opts.name, 32) || `${host.name}'s lobby`;
    this.setMap(opts.map);
    this.maxPlayers = clamp(opts.maxPlayers | 0 || 10, 2, 10);
    this.botQuota = clamp(opts.bots | 0, 0, 9);
    this.difficulty = DIFF[opts.difficulty] ? opts.difficulty : 'normal';
    this.maxRounds = [8, 16, 24].includes(opts.rounds | 0) ? opts.rounds | 0 : 16;
    this.password = cleanText(opts.password, 32);
    this.hostId = host.id;
    this.players = new Map();
    this.phase = 'warmup'; this.phaseEnd = 0; this.warmupEnd = 0; this.buyEnd = 0;
    this.score = { T: 0, CT: 0 }; this.lossStreak = { T: 0, CT: 0 };
    this.bomb = { state: 'none' }; this.items = []; this.nades = []; this.smokes = []; this.noises = [];
    this.itemId = 1; this.nadeId = 1; this.lastSnap = 0; this.lastInfo = 0; this.tPlan = 'A';
    this.created = Date.now();
  }

  setMap(id) {
    this.mapId = MAP_IDS.includes(id) ? id : MAP_IDS[0];
    this.map = getMap(this.mapId);
  }

  // The map was saved from the editor: switch to the new version and restart.
  reloadMap() {
    this.setMap(this.mapId);
    for (const q of this.players.values()) q.alive = false;
    this.items = []; this.smokes = []; this.nades = [];
    this.broadcast({ t: 'map', map: this.mapId, version: this.map.version });
    this.msg('The host updated this map. Press F5 if you see a message about a newer version.');
    if (this.teamOf('T').length && this.teamOf('CT').length) this.startMatch(); else this.toWarmup();
  }

  humans() { return [...this.players.values()].filter(p => !p.isBot); }
  bots() { return [...this.players.values()].filter(p => p.isBot); }
  teamOf(team) { return [...this.players.values()].filter(p => p.team === team); }
  broadcast(msg) { const s = JSON.stringify(msg); for (const p of this.players.values()) if (p.ws && p.ws.readyState === 1) p.ws.send(s); }
  msg(text) { this.broadcast({ t: 'msg', text }); }

  summary() {
    return {
      id: this.id, name: this.name, map: this.mapId, mapName: this.map.name, humans: this.humans().length, bots: this.bots().length,
      max: this.maxPlayers, phase: this.phase, score: this.score, locked: !!this.password,
    };
  }

  // ------------------------------------------------ joining / teams
  addHuman(p) {
    this.players.set(p.id, p);
    p.lobby = this;
    p.team = 'SPEC'; p.alive = false; p.kills = 0; p.deaths = 0; p.money = 800;
    send(p, { t: 'joined', lobby: this.summary(), map: this.mapId, mapVersion: this.map.version, you: p.id, host: this.hostId, maxRounds: this.maxRounds, difficulty: this.difficulty, botQuota: this.botQuota });
    send(p, { t: 'items', items: this.items });
    for (const s of this.smokes) send(p, { t: 'det', type: 'smoke', x: s.x, y: s.y, z: s.z, left: s.until - Date.now() });
    this.msg(`${p.name} joined the lobby`);
    this.sendInfo();
  }

  remove(p) {
    if (!this.players.has(p.id)) return;
    this.dropBomb(p);
    this.players.delete(p.id);
    p.lobby = null;
    if (!p.isBot) this.msg(`${p.name} left`);
    if (this.humans().length === 0) { lobbies.delete(this.id); return; }
    if (this.hostId === p.id) { this.hostId = this.humans()[0].id; this.broadcast({ t: 'host', id: this.hostId }); }
    this.balanceBots();
    this.checkRoundEnd();
    this.sendInfo();
  }

  setTeam(p, team) {
    if (team === 'auto') team = this.teamOf('T').length <= this.teamOf('CT').length ? 'T' : 'CT';
    if (!['T', 'CT', 'SPEC'].includes(team) || p.team === team) return;
    const humansOn = this.teamOf(team).filter(x => !x.isBot).length;
    if (team !== 'SPEC' && humansOn >= Math.ceil(this.maxPlayers / 2)) return send(p, { t: 'msg', text: 'That team is full' });
    if (p.alive) { p.alive = false; this.dropBomb(p); }
    p.team = team; p.primary = null; p.secondary = null; p.nades = []; p.armor = 0; p.helmet = false; p.kit = false;
    this.msg(`${p.name} joined ${team === 'SPEC' ? 'Spectators' : team === 'T' ? 'Terrorists' : 'Counter-Terrorists'}`);
    this.balanceBots();
    if (team !== 'SPEC' && (this.phase === 'warmup' || this.phase === 'freeze')) this.spawnPlayer(p, this.teamOf(team).indexOf(p));
    this.sendSelf(p);
    this.checkRoundEnd();
    this.sendInfo();
  }

  balanceBots() {
    const humans = this.humans().filter(p => p.team !== 'SPEC').length;
    const playing = () => this.teamOf('T').length + this.teamOf('CT').length;
    // remove extra bots
    while (this.bots().length > 0 && (this.bots().length > this.botQuota || playing() > this.maxPlayers)) {
      const big = this.teamOf('T').length >= this.teamOf('CT').length ? 'T' : 'CT';
      const bot = this.teamOf(big).find(b => b.isBot) || this.bots()[0];
      this.dropBomb(bot); this.players.delete(bot.id);
    }
    // add bots up to quota
    while (this.bots().length < this.botQuota && humans + this.bots().length < this.maxPlayers) {
      const used = new Set(this.bots().map(b => b.name));
      const name = BOT_NAMES.find(n => !used.has(n)) || 'Bot' + nextPlayerId;
      const b = newPlayer(name, true);
      b.bot = {};
      b.lobby = this;
      b.team = this.teamOf('T').length <= this.teamOf('CT').length ? 'T' : 'CT';
      this.players.set(b.id, b);
      if (this.phase === 'warmup' || this.phase === 'freeze') this.spawnPlayer(b, this.teamOf(b.team).length - 1);
    }
    // even out teams by moving bots
    for (let i = 0; i < 10; i++) {
      const t = this.teamOf('T').length, ct = this.teamOf('CT').length;
      if (Math.abs(t - ct) < 2) break;
      const big = t > ct ? 'T' : 'CT';
      const bot = this.teamOf(big).find(b => b.isBot);
      if (!bot) break;
      this.dropBomb(bot);
      bot.team = big === 'T' ? 'CT' : 'T'; bot.alive = false; bot.primary = null; bot.secondary = null;
      if (this.phase === 'warmup' || this.phase === 'freeze') this.spawnPlayer(bot, this.teamOf(bot.team).length - 1);
    }
  }

  // ------------------------------------------------ rounds
  spawnPlayer(p, idx) {
    const pts = this.map.spawns[p.team];
    if (!pts) return;
    const s = pts[Math.max(0, idx) % pts.length];
    p.x = s.x; p.y = s.y; p.z = s.z; p.crouch = false;
    const mid = { x: this.map.w * CELL / 2, z: this.map.h * CELL / 2 };
    p.yaw = Math.atan2(-(mid.x - p.x), -(mid.z - p.z)); p.pitch = 0;
    p.alive = true; p.hp = 100; p.sid++;
    if (!p.secondary) p.secondary = p.team === 'T' ? 'glock' : 'usp';
    p.weapon = p.primary || p.secondary;
    if (p.isBot) this.resetBot(p);
    send(p, { t: 'spawn', x: p.x, y: p.y, z: p.z, yaw: p.yaw, sid: p.sid });
    this.sendSelf(p);
  }

  toWarmup() {
    this.phase = 'warmup'; this.warmupEnd = 0; this.bomb = { state: 'none' };
    for (const p of this.players.values()) { p.money = MAX_MONEY; if (p.team !== 'SPEC' && !p.alive) this.spawnPlayer(p, this.teamOf(p.team).indexOf(p)); }
    this.broadcast({ t: 'phase', phase: 'warmup' });
    this.broadcastBomb();
    this.msg('Warmup - waiting for players on both teams');
  }

  startMatch() {
    this.score = { T: 0, CT: 0 }; this.lossStreak = { T: 0, CT: 0 };
    for (const p of this.players.values()) {
      p.money = 800; p.kills = 0; p.deaths = 0; p.alive = false;
      p.primary = null; p.secondary = null; p.nades = []; p.armor = 0; p.helmet = false; p.kit = false;
    }
    this.msg('Match started! Good luck, have fun.');
    this.startRound();
  }

  startRound() {
    const now = Date.now();
    this.phase = 'freeze'; this.phaseEnd = now + FREEZE;
    this.items = []; this.smokes = []; this.nades = []; this.noises = [];
    this.bomb = { state: 'carried', carrier: null, x: 0, y: 0, z: 0 };
    this.tPlan = Math.random() < 0.5 ? 'A' : 'B';
    for (const team of ['T', 'CT']) {
      this.teamOf(team).forEach((p, i) => {
        if (!p.alive) { p.primary = null; p.secondary = null; p.nades = []; p.armor = 0; p.helmet = false; p.kit = false; }
        p.hasBomb = false;
        this.spawnPlayer(p, i);
      });
    }
    const ts = this.teamOf('T');
    if (ts.length) { const c = pick(ts); c.hasBomb = true; this.bomb.carrier = c.id; this.sendSelf(c); }
    for (const b of this.bots()) this.botBuy(b);
    this.broadcast({ t: 'roundStart', round: this.score.T + this.score.CT + 1, freeze: FREEZE });
    this.broadcast({ t: 'items', items: this.items });
    this.broadcastBomb(); // clears last round's planted/defused bomb on every client
    this.sendInfo();
  }

  endRound(winner, reason) {
    if (this.phase !== 'live' && this.phase !== 'freeze') return;
    const loser = winner === 'T' ? 'CT' : 'T';
    this.phase = 'post'; this.phaseEnd = Date.now() + POST;
    this.score[winner]++;
    const winMoney = reason === 'bomb' || reason === 'defuse' ? 3500 : 3250;
    const lossMoney = 1400 + 500 * Math.min(this.lossStreak[loser], 4);
    this.lossStreak[loser]++;
    this.lossStreak[winner] = Math.max(0, this.lossStreak[winner] - 1);
    for (const p of this.teamOf(winner)) p.money = Math.min(MAX_MONEY, p.money + winMoney);
    for (const p of this.teamOf(loser)) p.money = Math.min(MAX_MONEY, p.money + lossMoney + (loser === 'T' && this.bomb.state === 'defused' ? 800 : 0));
    if (this.bomb.defuser) this.bomb.defuser = null;
    const text = { elim: winner === 'T' ? 'Terrorists Win' : 'Counter-Terrorists Win', time: 'Counter-Terrorists Win', bomb: 'Target Bombed - Terrorists Win', defuse: 'Bomb Defused - Counter-Terrorists Win' }[reason];
    this.broadcast({ t: 'roundEnd', winner, reason, text, score: this.score });
    for (const p of this.players.values()) this.sendSelf(p);
    this.sendInfo();
  }

  afterRound() {
    const half = this.maxRounds / 2, total = this.score.T + this.score.CT;
    if (this.score.T > half || this.score.CT > half || total >= this.maxRounds) {
      const w = this.score.T > this.score.CT ? 'T' : this.score.CT > this.score.T ? 'CT' : 'DRAW';
      this.phase = 'over'; this.phaseEnd = Date.now() + OVER;
      this.broadcast({ t: 'matchEnd', winner: w, score: this.score });
      return;
    }
    if (total === half) {
      for (const p of this.players.values()) {
        if (p.team === 'T') p.team = 'CT'; else if (p.team === 'CT') p.team = 'T';
        p.money = 800; p.alive = false; p.primary = null; p.secondary = null; p.nades = []; p.armor = 0; p.helmet = false; p.kit = false;
      }
      this.score = { T: this.score.CT, CT: this.score.T };
      this.lossStreak = { T: 0, CT: 0 };
      this.msg('Halftime - switching sides');
    }
    this.startRound();
  }

  checkRoundEnd() {
    if (this.phase !== 'live') return;
    const tAlive = this.teamOf('T').filter(p => p.alive).length;
    const ctAlive = this.teamOf('CT').filter(p => p.alive).length;
    if (ctAlive === 0) this.endRound('T', 'elim');
    else if (tAlive === 0 && this.bomb.state !== 'planted') this.endRound('CT', 'elim');
  }

  // ------------------------------------------------ economy
  inBuyZone(p) {
    const pts = this.map.spawns[p.team];
    if (!pts) return false;
    const cx = pts.reduce((s, q) => s + q.x, 0) / pts.length, cz = pts.reduce((s, q) => s + q.z, 0) / pts.length;
    return Math.hypot(p.x - cx, p.z - cz) < 14;
  }

  canBuy(p) {
    if (!p.alive || p.team === 'SPEC') return false;
    const now = Date.now();
    const timeOk = this.phase === 'warmup' || this.phase === 'freeze' || (this.phase === 'live' && now < this.buyEnd);
    return timeOk && this.inBuyZone(p);
  }

  buy(p, id) {
    if (!this.canBuy(p)) return send(p, { t: 'msg', text: 'You can\'t buy right now' });
    const w = WEAPONS[id], e = EQUIPMENT[id];
    const item = w || e;
    if (!item || id === 'knife' || id === 'bomb') return;
    if (item.team && item.team !== p.team) return;
    let price = item.price;
    if (id === 'vesthelm' && p.armor >= 100 && !p.helmet) price = 350;
    if (this.phase !== 'warmup' && p.money < price) return send(p, { t: 'msg', text: 'Not enough money' });
    if (w && w.nade) {
      const count = p.nades.filter(n => n === id).length;
      if (p.nades.length >= 4 || count >= (w.max || 1)) return send(p, { t: 'msg', text: 'You can\'t carry any more' });
      p.nades.push(id);
    } else if (w) {
      const slot = w.slot === 1 ? 'primary' : 'secondary';
      if (p[slot] === id) return;
      if (p[slot]) this.dropItem(p[slot], p);
      p[slot] = id;
      p.weapon = id;
      if (p.isBot) p.bot.ammo = { [id]: w.mag };
    } else if (id === 'vest') {
      if (p.armor >= 100) return;
      p.armor = 100;
    } else if (id === 'vesthelm') {
      if (p.armor >= 100 && p.helmet) return;
      p.armor = 100; p.helmet = true;
    } else if (id === 'kit') {
      if (p.kit) return;
      p.kit = true;
    }
    if (this.phase !== 'warmup') p.money -= price;
    this.sendSelf(p);
    send(p, { t: 'bought', item: id });
  }

  // ------------------------------------------------ items / bomb
  dropItem(weapon, p, vel) {
    const it = { id: this.itemId++, w: weapon, x: p.x + (vel ? Math.sin(-p.yaw) * 1.2 : 0), y: p.y, z: p.z + (vel ? -Math.cos(p.yaw) * 1.2 : 0) };
    if (P.boxBlocked(this.map, it.x, p.y + 0.1, it.z, 0.2, 0.3)) { it.x = p.x; it.z = p.z; }
    it.y = P.groundHeight(this.map, it.x, p.y + 0.1, it.z, 0.2);
    this.items.push(it);
    if (this.items.length > 40) this.items.shift();
    this.broadcast({ t: 'items', items: this.items });
  }

  dropBomb(p, thrown) {
    if (!p.hasBomb) return;
    p.hasBomb = false;
    const ahead = thrown ? 1.2 : 0;
    let x = p.x + Math.sin(-p.yaw) * ahead, z = p.z - Math.cos(p.yaw) * ahead;
    if (P.boxBlocked(this.map, x, p.y + 0.1, z, 0.2, 0.3)) { x = p.x; z = p.z; }
    this.bomb = { state: 'dropped', x, y: P.groundHeight(this.map, x, p.y + 0.1, z, 0.2), z };
    this.cancelPlant();
    this.sendSelf(p);
    this.broadcastBomb();
  }

  broadcastBomb() {
    const b = this.bomb;
    this.broadcast({ t: 'bomb', state: b.state, x: b.x, y: b.y, z: b.z, left: b.explodeAt ? b.explodeAt - Date.now() : 0 });
  }

  tryPickups(p) {
    if (!p.alive) return;
    if (p.team === 'T' && this.bomb.state === 'dropped' && Math.hypot(p.x - this.bomb.x, p.z - this.bomb.z) < 1.2 && Math.abs(p.y - this.bomb.y) < 1.5) {
      p.hasBomb = true; this.bomb = { state: 'carried', carrier: p.id };
      this.sendSelf(p); this.broadcastBomb();
      if (!p.isBot) send(p, { t: 'msg', text: 'You picked up the bomb' });
    }
    for (let i = 0; i < this.items.length; i++) {
      const it = this.items[i];
      if (Math.hypot(p.x - it.x, p.z - it.z) > 1.1 || Math.abs(p.y - it.y) > 1.5) continue;
      const w = WEAPONS[it.w];
      const slot = w.slot === 1 ? 'primary' : 'secondary';
      if (p[slot]) continue;
      if (w.team && w.team !== p.team && p.isBot) continue;
      p[slot] = it.w;
      if (p.isBot) { p.bot.ammo = p.bot.ammo || {}; p.bot.ammo[it.w] = w.mag; p.weapon = p.primary || p.secondary; }
      this.items.splice(i, 1);
      this.broadcast({ t: 'items', items: this.items });
      this.sendSelf(p);
      send(p, { t: 'picked', w: it.w });
      return;
    }
  }

  manualPickup(p, itemId) {
    const it = this.items.find(i => i.id === itemId);
    if (!it || !p.alive || Math.hypot(p.x - it.x, p.z - it.z) > 2.6) return;
    const w = WEAPONS[it.w];
    const slot = w.slot === 1 ? 'primary' : 'secondary';
    const old = p[slot];
    this.items = this.items.filter(i => i !== it);
    if (old) this.dropItem(old, p, true);
    p[slot] = it.w;
    this.broadcast({ t: 'items', items: this.items });
    this.sendSelf(p);
    send(p, { t: 'picked', w: it.w });
  }

  drop(p, what) {
    if (!p.alive) return;
    if (what === 'bomb') return this.dropBomb(p, true);
    for (const slot of ['primary', 'secondary']) {
      if (p[slot] === what) { p[slot] = null; this.dropItem(what, p, true); this.sendSelf(p); return; }
    }
  }

  startPlant(p) {
    if (this.phase !== 'live' || !p.alive || !p.hasBomb || this.bomb.planter) return;
    const z = zoneAt(this.map, p.x, p.z);
    if (z !== Z_A && z !== Z_B) return send(p, { t: 'msg', text: 'You must be at a bombsite to plant' });
    this.bomb.planter = p.id; this.bomb.plantEnd = Date.now() + PLANT_TIME; this.bomb.px = p.x; this.bomb.pz = p.z;
    this.broadcast({ t: 'planting', id: p.id, time: PLANT_TIME });
  }

  cancelPlant() {
    if (this.bomb.planter) { this.broadcast({ t: 'plantCancel', id: this.bomb.planter }); this.bomb.planter = null; }
  }

  startDefuse(p) {
    const b = this.bomb;
    if (b.state !== 'planted' || !p.alive || p.team !== 'CT' || b.defuser) return;
    if (Math.hypot(p.x - b.x, p.z - b.z) > 2.2) return;
    b.defuser = p.id; b.defuseEnd = Date.now() + (p.kit ? KIT_TIME : DEFUSE_TIME);
    this.broadcast({ t: 'defusing', id: p.id, time: b.defuseEnd - Date.now() });
  }

  cancelDefuse() {
    if (this.bomb.defuser) { this.broadcast({ t: 'defuseCancel', id: this.bomb.defuser }); this.bomb.defuser = null; }
  }

  // ------------------------------------------------ combat
  damage(victim, attacker, weapon, group, dist, heavy) {
    if (!victim.alive || this.phase === 'freeze') return;
    const r = computeDamage(weapon, group, dist, victim, heavy);
    victim.hp -= r.hp; victim.armor = Math.max(0, victim.armor - r.armor);
    if (victim.armor === 0) victim.helmet = false;
    send(victim, { t: 'hurt', from: attacker ? attacker.id : 0, dmg: r.hp, hp: Math.max(0, victim.hp), x: attacker ? attacker.x : victim.x, z: attacker ? attacker.z : victim.z });
    if (attacker) send(attacker, { t: 'hitmark', head: group === 'head', kill: victim.hp <= 0 });
    if (victim.isBot && attacker) { victim.bot.hurtBy = attacker.id; victim.bot.hurtAt = Date.now(); }
    if (victim.hp <= 0) this.kill(victim, attacker, weapon, group === 'head');
    else this.sendSelf(victim);
  }

  kill(victim, attacker, weapon, hs) {
    victim.alive = false; victim.hp = 0; victim.deaths++;
    if (this.bomb.planter === victim.id) this.cancelPlant();
    if (this.bomb.defuser === victim.id) this.cancelDefuse();
    if (attacker && attacker !== victim) {
      if (attacker.team !== victim.team) {
        attacker.kills++;
        attacker.money = Math.min(MAX_MONEY, attacker.money + (WEAPONS[weapon]?.reward ?? 300));
      } else { attacker.kills--; attacker.money = Math.max(0, attacker.money - 300); }
      this.sendSelf(attacker);
    }
    const drop = victim.primary || (victim.secondary && !['glock', 'usp'].includes(victim.secondary) ? victim.secondary : null);
    if (drop) this.dropItem(drop, victim);
    this.dropBomb(victim);
    victim.primary = null; victim.secondary = null; victim.nades = []; victim.armor = 0; victim.helmet = false; victim.kit = false;
    victim.respawnAt = Date.now() + 2500;
    this.broadcast({ t: 'kill', k: attacker ? attacker.id : 0, v: victim.id, w: weapon, hs });
    this.sendSelf(victim);
    this.checkRoundEnd();
  }

  handleShoot(p, m) {
    if (!p.alive || this.phase === 'freeze' || this.phase === 'over') return;
    const w = WEAPONS[m.w];
    if (!w || w.nade || (m.w !== 'knife' && m.w !== p.primary && m.w !== p.secondary)) return;
    const now = Date.now();
    const rate = (m.heavy ? w.heavyRate : w.rate) || 0.1;
    if (now - p.lastShot < rate * 1000 * 0.75) return;
    p.lastShot = now;
    const o = m.o, d = m.d;
    if (!Array.isArray(o) || !Array.isArray(d) || o.length !== 3 || d.length !== 3 || [...o, ...d].some(v => typeof v !== 'number' || !isFinite(v))) return;
    if (Math.hypot(o[0] - p.x, o[1] - eyeY(p), o[2] - p.z) > 2) return;
    const dl = Math.hypot(d[0], d[1], d[2]) || 1;
    const dx = d[0] / dl, dy = d[1] / dl, dz = d[2] / dl;
    const wall = P.raycastWorld(this.map, o[0], o[1], o[2], dx, dy, dz, w.melee ? w.range : 200);
    let endDist = wall ? wall.dist : (w.melee ? w.range : 200);
    const h = m.hit;
    if (h && typeof h.id === 'number') {
      const v = this.players.get(h.id);
      const hd = Number(h.dist);
      if (v && v.alive && v !== p && v.team !== p.team && isFinite(hd) && hd <= endDist + 0.3) {
        const hp = { x: o[0] + dx * hd, y: o[1] + dy * hd, z: o[2] + dz * hd };
        const near = Math.hypot(hp.x - v.x, hp.z - v.z) < 2.5 && hp.y > v.y - 0.5 && hp.y < v.y + 2.3;
        if (near && ['head', 'chest', 'stomach', 'legs'].includes(h.g)) {
          endDist = hd;
          this.damage(v, p, m.w, h.g, hd, !!m.heavy);
        }
      }
    }
    if (!w.melee) {
      const e = [o[0] + dx * endDist, o[1] + dy * endDist, o[2] + dz * endDist];
      this.broadcast({ t: 'shot', id: p.id, w: m.w, o, e });
      this.noises.push({ x: p.x, z: p.z, at: now, team: p.team });
    } else this.broadcast({ t: 'slash', id: p.id });
  }

  throwNade(p, m) {
    if (!p.alive || this.phase === 'freeze') return;
    const i = p.nades.indexOf(m.type);
    if (i < 0) return;
    const pos = m.p, vel = m.v;
    if (!Array.isArray(pos) || !Array.isArray(vel) || [...pos, ...vel].some(v => typeof v !== 'number' || !isFinite(v))) return;
    if (Math.hypot(pos[0] - p.x, pos[2] - p.z) > 2 || Math.hypot(...vel) > 30) return;
    p.nades.splice(i, 1);
    this.sendSelf(p);
    this.spawnNade(p, m.type, { x: pos[0], y: pos[1], z: pos[2] }, { x: vel[0], y: vel[1], z: vel[2] });
  }

  spawnNade(p, type, pos, vel) {
    const sim = P.simulateGrenade(this.map, pos, vel, type);
    const n = { id: this.nadeId++, type, owner: p.id, detAt: Date.now() + sim.time * 1000, end: sim.end };
    this.nades.push(n);
    this.broadcast({ t: 'nade', id: n.id, type, owner: p.id, p: [pos.x, pos.y, pos.z], v: [vel.x, vel.y, vel.z] });
  }

  detonate(n) {
    const { x, y, z } = n.end;
    this.broadcast({ t: 'det', id: n.id, type: n.type, x, y, z, owner: n.owner });
    if (n.type === 'smoke') this.smokes.push({ x, y, z, until: Date.now() + 18000 });
    if (n.type === 'he') {
      const owner = this.players.get(n.owner);
      for (const v of this.players.values()) {
        if (!v.alive) continue;
        const d = Math.hypot(v.x - x, v.y + 1 - y, v.z - z);
        if (d > 9) continue;
        if (!P.lineOfSight(this.map, { x, y: y + 0.3, z }, { x: v.x, y: v.y + 1.1, z: v.z })) continue;
        if (owner && owner.team === v.team && owner !== v) continue;
        let dmg = 98 * Math.pow(1 - d / 9, 1.3);
        if (v.armor > 0) { v.armor = Math.max(0, v.armor - Math.round(dmg * 0.25)); dmg *= 0.57; }
        dmg = Math.round(dmg);
        if (dmg < 1) continue;
        v.hp -= dmg;
        send(v, { t: 'hurt', from: n.owner, dmg, hp: Math.max(0, v.hp), x, z });
        if (owner && owner !== v) send(owner, { t: 'hitmark', head: false, kill: v.hp <= 0 });
        if (v.hp <= 0) this.kill(v, owner && owner.lobby === this ? owner : null, 'he', false);
        else this.sendSelf(v);
      }
    }
  }

  explodeBomb() {
    const b = this.bomb;
    b.state = 'exploded';
    this.broadcastBomb();
    for (const v of this.players.values()) {
      if (!v.alive) continue;
      const d = Math.hypot(v.x - b.x, v.z - b.z);
      const dmg = Math.round(Math.max(0, 500 * Math.exp(-(d * d) / (2 * 7.5 * 7.5))));
      if (dmg <= 0) continue;
      v.hp -= dmg;
      send(v, { t: 'hurt', from: 0, dmg, hp: Math.max(0, v.hp), x: b.x, z: b.z });
      if (v.hp <= 0) { v.alive = false; v.hp = 0; v.deaths++; this.broadcast({ t: 'kill', k: 0, v: v.id, w: 'bomb', hs: false }); this.sendSelf(v); }
      else this.sendSelf(v);
    }
  }

  // ------------------------------------------------ messages from a client
  handle(p, m) {
    switch (m.t) {
      case 'st': {
        if (!p.alive || m.sid !== p.sid) return;
        const vals = [m.x, m.y, m.z, m.yaw, m.pitch];
        if (vals.some(v => typeof v !== 'number' || !isFinite(v))) return;
        if (this.phase === 'freeze' && Math.hypot(m.x - p.x, m.z - p.z) > 0.3) { send(p, { t: 'pos', x: p.x, y: p.y, z: p.z }); return; }
        if (Math.hypot(m.x - p.x, m.z - p.z) > 4 || P.boxBlocked(this.map, m.x, m.y + 0.05, m.z, 0.2, 1.0)) { send(p, { t: 'pos', x: p.x, y: p.y, z: p.z }); return; }
        p.x = m.x; p.y = clamp(m.y, 0, 10); p.z = m.z; p.yaw = m.yaw; p.pitch = clamp(m.pitch, -1.6, 1.6); p.crouch = !!m.c;
        if (typeof m.w === 'string' && WEAPONS[m.w]) p.weapon = m.w;
        if (this.bomb.planter === p.id && Math.hypot(p.x - this.bomb.px, p.z - this.bomb.pz) > 0.6) this.cancelPlant();
        if (this.bomb.defuser === p.id && Math.hypot(p.x - this.bomb.x, p.z - this.bomb.z) > 2.4) this.cancelDefuse();
        this.tryPickups(p);
        break;
      }
      case 'shoot': this.handleShoot(p, m); break;
      case 'throw': this.throwNade(p, m); break;
      case 'buy': this.buy(p, String(m.item)); break;
      case 'drop': this.drop(p, String(m.w)); break;
      case 'pickup': this.manualPickup(p, m.id | 0); break;
      case 'plant': if (m.on) this.startPlant(p); else if (this.bomb.planter === p.id) this.cancelPlant(); break;
      case 'defuse': if (m.on) this.startDefuse(p); else if (this.bomb.defuser === p.id) this.cancelDefuse(); break;
      case 'team': this.setTeam(p, String(m.team)); break;
      case 'chat': {
        const text = cleanText(m.text, 120);
        if (!text) return;
        const msg = { t: 'chat', id: p.id, name: p.name, team: p.team, text, teamOnly: !!m.team, dead: !p.alive };
        for (const q of this.players.values()) if (!m.team || q.team === p.team) send(q, msg);
        break;
      }
      case 'host': {
        if (p.id !== this.hostId) return;
        if (m.cmd === 'map' && MAP_IDS.includes(m.map)) {
          this.setMap(m.map);
          this.broadcast({ t: 'map', map: this.mapId, version: this.map.version });
          for (const q of this.players.values()) q.alive = false;
          this.items = []; this.smokes = []; this.nades = [];
          if (this.teamOf('T').length && this.teamOf('CT').length) this.startMatch(); else this.toWarmup();
        } else if (m.cmd === 'restart') {
          for (const q of this.players.values()) q.alive = false;
          if (this.teamOf('T').length && this.teamOf('CT').length) this.startMatch();
        } else if (m.cmd === 'bots') {
          this.botQuota = clamp(m.n | 0, 0, 9); this.balanceBots(); this.checkRoundEnd();
        } else if (m.cmd === 'difficulty' && DIFF[m.d]) {
          this.difficulty = m.d; this.msg(`Bot difficulty: ${m.d}`);
        }
        this.broadcast({ t: 'settings', botQuota: this.botQuota, difficulty: this.difficulty, map: this.mapId });
        this.sendInfo();
        break;
      }
    }
  }

  sendSelf(p) {
    send(p, {
      t: 'self', alive: p.alive, hp: Math.max(0, p.hp), armor: p.armor, helmet: p.helmet, kit: p.kit, money: p.money, team: p.team,
      primary: p.primary, secondary: p.secondary, nades: p.nades, hasBomb: p.hasBomb, canBuy: this.canBuy(p),
    });
  }

  sendInfo() {
    const plist = [...this.players.values()].map(p => ({ id: p.id, name: p.name, team: p.team, k: p.kills, d: p.deaths, alive: p.alive, bot: p.isBot, ping: p.ping, money: p.money, hasBomb: p.hasBomb }));
    for (const q of this.players.values()) {
      if (!q.ws) continue;
      send(q, {
        t: 'info', phase: this.phase, score: this.score, host: this.hostId, maxRounds: this.maxRounds, map: this.mapId,
        players: plist.map(x => (x.team === q.team || q.team === 'SPEC') ? x : { ...x, money: undefined, hasBomb: undefined }),
      });
    }
  }

  // ------------------------------------------------ main loop
  tick(dt) {
    const now = Date.now();
    const tN = this.teamOf('T').length, ctN = this.teamOf('CT').length;
    if (this.phase !== 'warmup' && (tN === 0 || ctN === 0)) this.toWarmup();

    switch (this.phase) {
      case 'warmup':
        for (const p of this.players.values()) {
          if (p.team !== 'SPEC' && !p.alive && p.respawnAt && now > p.respawnAt) { p.money = MAX_MONEY; this.spawnPlayer(p, Math.floor(Math.random() * 10)); }
        }
        if (tN && ctN) {
          if (!this.warmupEnd) { this.warmupEnd = now + 5000; this.msg('Match starting in 5 seconds'); }
          else if (now > this.warmupEnd) this.startMatch();
        }
        break;
      case 'freeze':
        if (now > this.phaseEnd) {
          this.phase = 'live'; this.phaseEnd = now + ROUND; this.buyEnd = now + BUY_TIME;
          this.broadcast({ t: 'phase', phase: 'live', time: ROUND });
          this.planBots();
        }
        break;
      case 'live': {
        const b = this.bomb;
        if (b.planter && now >= b.plantEnd) {
          const p = this.players.get(b.planter);
          if (p && p.alive && p.hasBomb) {
            p.hasBomb = false; p.money += 300;
            this.bomb = { state: 'planted', x: p.x, y: p.y, z: p.z, explodeAt: now + BOMB_TIME, site: zoneAt(this.map, p.x, p.z) === Z_A ? 'A' : 'B' };
            this.broadcastBomb();
            this.broadcast({ t: 'planted', site: this.bomb.site, by: p.id });
            this.sendSelf(p);
            for (const q of this.players.values()) if (q.isBot) q.bot.path = null;
          } else b.planter = null;
        }
        if (this.bomb.state === 'planted') {
          if (this.bomb.defuser && now >= this.bomb.defuseEnd) {
            const d = this.players.get(this.bomb.defuser);
            if (d) d.money = Math.min(MAX_MONEY, d.money + 300);
            this.bomb.state = 'defused'; this.bomb.defuser = null;
            this.broadcastBomb();
            this.endRound('CT', 'defuse');
          } else if (now >= this.bomb.explodeAt) {
            this.explodeBomb();
            this.endRound('T', 'bomb');
          }
        } else if (now > this.phaseEnd) this.endRound('CT', 'time');
        break;
      }
      case 'post': if (now > this.phaseEnd) this.afterRound(); break;
      case 'over': if (now > this.phaseEnd) this.startMatch(); break;
    }

    for (const n of this.nades) if (now >= n.detAt) { this.detonate(n); n.done = true; }
    this.nades = this.nades.filter(n => !n.done);
    this.smokes = this.smokes.filter(s => s.until > now);
    this.noises = this.noises.filter(s => now - s.at < 1500);

    for (const p of this.players.values()) if (p.isBot) this.updateBot(p, dt, now);
    if (process.env.BOTDEBUG && now - (this.lastBotLog || 0) > 5000) {
      this.lastBotLog = now;
      for (const p of this.bots()) {
        const b = p.bot || {};
        console.log(`[bot] ${p.name} ${p.team} alive=${p.alive} pos=${p.x.toFixed(1)},${p.y.toFixed(1)},${p.z.toFixed(1)} goal=${b.goal ? `${b.goal.x.toFixed(1)},${(b.goal.y ?? NaN).toFixed?.(1)},${b.goal.z.toFixed(1)}` : '-'} path=${b.path ? b.path.length : 'null'} target=${b.target || '-'} startAt=${b.startAt ? Math.round((b.startAt - now) / 1000) : '-'}`);
      }
    }

    if (now - this.lastSnap >= 50) {
      this.lastSnap = now;
      const pl = [];
      for (const p of this.players.values()) {
        if (p.team === 'SPEC') continue;
        pl.push([p.id, +p.x.toFixed(2), +p.y.toFixed(2), +p.z.toFixed(2), +p.yaw.toFixed(3), +p.pitch.toFixed(3), p.crouch ? 1 : 0, p.weapon, p.alive ? 1 : 0, p.team === 'T' ? 0 : 1]);
      }
      const left = this.phase === 'live' && this.bomb.state === 'planted' ? -1 : Math.max(0, this.phaseEnd - now);
      const b = this.bomb;
      const prog = b.planter ? { k: 'plant', id: b.planter, end: b.plantEnd - now } : b.defuser ? { k: 'defuse', id: b.defuser, end: b.defuseEnd - now } : null;
      this.broadcast({ t: 'snap', pl, ph: this.phase, left: this.phase === 'warmup' ? (this.warmupEnd ? this.warmupEnd - now : -1) : left, prog });
    }
    if (now - this.lastInfo >= 1000) { this.lastInfo = now; this.sendInfo(); }
  }

  // ------------------------------------------------ bots
  resetBot(p) {
    const b = p.bot || (p.bot = {});
    b.path = null; b.target = null; b.reactAt = 0; b.goal = null; b.vel = { x: 0, y: 0, z: 0 }; b.nextFire = 0; b.spray = 0;
    b.reloadUntil = 0; b.stuckT = 0; b.lastPos = { x: p.x, z: p.z }; b.idleYaw = p.yaw; b.burst = 0; b.pause = 0;
    b.ammo = {}; for (const w of [p.primary, p.secondary]) if (w) b.ammo[w] = WEAPONS[w].mag;
    b.aimErr = { y: 0, p: 0, until: 0 }; b.hurtBy = 0; b.hurtAt = 0; b.strafe = 1; b.strafeT = 0;
    b.watchSet = false; b.startAt = 0; b.site = null; b.lastSeen = null;
  }

  botBuy(p) {
    if (this.phase !== 'freeze' && this.phase !== 'warmup') return;
    const team = p.team;
    const want = (id) => { const before = p.money; this.buy(p, id); return p.money < before || this.phase === 'warmup'; };
    if (!p.primary) {
      const rifle = team === 'T' ? 'ak47' : 'm4a4';
      if (p.money >= 4750 + 1000 && Math.random() < 0.12) want('awp');
      else if (p.money >= WEAPONS[rifle].price + 650) want(rifle);
      else if (p.money >= 2050 + 650 && Math.random() < 0.6) want(team === 'T' ? 'galil' : 'famas');
      else if (p.money >= 1250 + 650 && this.score.T + this.score.CT > 0 && Math.random() < 0.4) want(team === 'T' ? 'mac10' : 'mp9');
    }
    if (p.armor < 100 || !p.helmet) { if (p.money >= 1000) want('vesthelm'); else if (p.money >= 650 && p.armor < 100) want('vest'); }
    if (!p.primary && p.money >= 700 && Math.random() < 0.5) want('deagle');
    if (team === 'CT' && !p.kit && p.money >= 400 && Math.random() < 0.5) want('kit');
    if (p.money >= 300 && Math.random() < 0.5) want(pick(['he', 'smoke', 'flash']));
    p.weapon = p.primary || p.secondary;
    p.bot.ammo = {}; for (const w of [p.primary, p.secondary]) if (w) p.bot.ammo[w] = WEAPONS[w].mag;
  }

  planBots() {
    let i = 0;
    for (const p of this.bots()) {
      if (!p.alive) continue;
      const site = p.team === 'T' ? (Math.random() < 0.8 ? this.tPlan : (this.tPlan === 'A' ? 'B' : 'A')) : (i++ % 2 === 0 ? 'A' : 'B');
      p.bot.site = site;
      p.bot.goal = this.randomSiteCell(site);
      p.bot.path = null;
      p.bot.holdDelay = p.team === 'T' ? rand(0, 6000) : 0;
      p.bot.startAt = Date.now() + p.bot.holdDelay;
    }
  }

  // Random standing spot on a bombsite (from the navigation graph).
  randomSiteCell(site) {
    const spots = zoneSpots(this.map, this.map.zoneRects[site]);
    if (!spots.length) return { ...this.map.siteCenter[site] };
    const s = pick(spots);
    return { x: s.x, y: s.y, z: s.z };
  }

  findPath(p, goal) {
    return navFindPath(this.map, { x: p.x, y: p.y, z: p.z }, goal);
  }

  clearLine(a, b) {
    return walkClear(this.map, a, b);
  }

  updateBot(p, dt, now) {
    const b = p.bot;
    if (!p.alive || !b) return;
    const diff = DIFF[this.difficulty];
    const canMove = this.phase === 'live' || this.phase === 'warmup' || this.phase === 'post';
    const eye = { x: p.x, y: eyeY(p), z: p.z };
    const fwdYaw = p.yaw;

    // ---- perception
    let target = null, tDist = Infinity;
    for (const e of this.players.values()) {
      if (!e.alive || e.team === p.team || e.team === 'SPEC') continue;
      const d = Math.hypot(e.x - p.x, e.z - p.z);
      if (d > 85 || d > tDist) continue;
      const ang = Math.atan2(-(e.x - p.x), -(e.z - p.z));
      let da = Math.abs(((ang - fwdYaw + Math.PI * 3) % (Math.PI * 2)) - Math.PI);
      const aware = da < 1.3 || d < 5 || b.target === e.id || (b.hurtBy === e.id && now - b.hurtAt < 2000);
      if (!aware) continue;
      const head = { x: e.x, y: e.y + (e.crouch ? 1.05 : 1.55), z: e.z }, chest = { x: e.x, y: e.y + (e.crouch ? 0.85 : 1.25), z: e.z };
      const vis = (pt) => P.lineOfSight(this.map, eye, pt) && !P.smokeBlocks(this.smokes, eye, pt);
      if (vis(chest) || vis(head)) { target = e; tDist = d; }
    }
    if (target) {
      if (b.target !== target.id) { b.target = target.id; b.reactAt = now + diff.react * rand(0.8, 1.3) + tDist * 4; b.aimHead = Math.random() < diff.head; }
      b.lastSeen = { x: target.x, y: target.y, z: target.z }; b.lastSeenAt = now;
    } else if (b.target) { b.target = null; }

    // ---- aiming
    let wantYaw = p.yaw, wantPitch = 0;
    if (target) {
      const ty = target.y + (b.aimHead ? (target.crouch ? 1.12 : 1.62) : (target.crouch ? 0.85 : 1.2));
      wantYaw = Math.atan2(-(target.x - p.x), -(target.z - p.z));
      wantPitch = Math.atan2(ty - eye.y, tDist);
      if (now > b.aimErr.until) b.aimErr = { y: rand(-1, 1) * diff.err * 1.4, p: rand(-1, 1) * diff.err, until: now + 400 };
      wantYaw += b.aimErr.y; wantPitch += b.aimErr.p;
    } else if (b.hurtBy && now - b.hurtAt < 1500) {
      const a = this.players.get(b.hurtBy);
      if (a) wantYaw = Math.atan2(-(a.x - p.x), -(a.z - p.z));
    } else if (b.lastSeen && now - b.lastSeenAt < 2500) {
      wantYaw = Math.atan2(-(b.lastSeen.x - p.x), -(b.lastSeen.z - p.z));
    } else {
      const noise = this.noises.find(n => n.team !== p.team && Math.hypot(n.x - p.x, n.z - p.z) < 30);
      if (noise) wantYaw = Math.atan2(-(noise.x - p.x), -(noise.z - p.z));
      else if (b.moveYaw !== undefined && b.moving) wantYaw = b.moveYaw;
      else wantYaw = b.idleYaw;
    }
    const turn = diff.turn * dt * (target ? 1 : 0.6);
    let dy = ((wantYaw - p.yaw + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
    p.yaw += clamp(dy, -turn, turn);
    p.pitch += clamp(wantPitch - p.pitch, -turn, turn);

    // ---- weapon
    const wid = p.primary || p.secondary || 'knife';
    p.weapon = wid;
    const w = WEAPONS[wid];
    if (b.reloadUntil && now >= b.reloadUntil) { b.reloadUntil = 0; b.ammo[wid] = w.mag; }
    if (!w.melee && b.ammo[wid] === undefined) b.ammo[wid] = w.mag;
    if (!target && !w.melee && b.ammo[wid] < w.mag * 0.4 && !b.reloadUntil) b.reloadUntil = now + w.reload * 1000;
    if (!target && now > b.nextFire + 400) b.spray = 0;

    let shooting = false;
    if (target && now >= b.reactAt && this.phase !== 'freeze') {
      const err = Math.abs(((wantYaw - p.yaw + Math.PI * 3) % (Math.PI * 2)) - Math.PI);
      shooting = true;
      if (w.melee) {
        // knife: run at them
      } else if (!b.reloadUntil && b.ammo[wid] <= 0) {
        b.reloadUntil = now + w.reload * 1000;
      } else if (!b.reloadUntil && now >= b.nextFire && now >= b.pause && err < 0.08 + 0.6 / Math.max(tDist, 1)) {
        this.botFire(p, w, wid, now, tDist);
      }
    }
    if (w.melee && target && tDist < 2 && now >= b.nextFire) {
      b.nextFire = now + w.rate * 1000;
      this.damage(target, p, 'knife', 'chest', tDist, false);
      this.broadcast({ t: 'slash', id: p.id });
    }

    // ---- bomb objectives
    const bomb = this.bomb;
    if (this.phase === 'live' && !target) {
      if (p.hasBomb && (zoneAt(this.map, p.x, p.z) === Z_A || zoneAt(this.map, p.x, p.z) === Z_B) && !bomb.planter) this.startPlant(p);
      if (p.team === 'CT' && bomb.state === 'planted' && Math.hypot(p.x - bomb.x, p.z - bomb.z) < 1.6 && !bomb.defuser) this.startDefuse(p);
    }
    if (target && bomb.planter === p.id && tDist < 25) this.cancelPlant();
    if (target && bomb.defuser === p.id && tDist < 12 && !(p.kit && bomb.defuseEnd - now < 1500)) this.cancelDefuse();
    const busy = bomb.planter === p.id || bomb.defuser === p.id;

    // ---- movement
    let mx = 0, mz = 0;
    if (canMove && !busy) {
      if (target && !w.melee) {
        // strafe a little while fighting, stand still to shoot accurately at range
        if (now > b.strafeT) { b.strafe = Math.random() < 0.5 ? -1 : (Math.random() < 0.5 ? 1 : 0); b.strafeT = now + rand(300, 800); }
        if (!shooting || tDist < 8) { mx = Math.cos(p.yaw) * b.strafe * 0.6; mz = -Math.sin(p.yaw) * b.strafe * 0.6; }
      } else if (target && w.melee) {
        b.goal = { x: target.x, z: target.z }; b.path = null;
      }
      if (!target || w.melee) {
        this.botChooseGoal(p, now);
        if (b.goal && (!b.startAt || now >= b.startAt || this.phase !== 'live')) {
          if (!b.path || now > (b.repathAt || 0)) {
            const path = this.findPath(p, b.goal);
            // unreachable goal (e.g. on top of a tall box): forget it and pick another next tick
            if (!path) { b.goal = null; b.path = null; b.repathAt = 0; } else { b.path = path; b.repathAt = now + (w.melee && target ? 500 : 8000); }
          }
          while (b.path && b.path.length > 1 && this.clearLine(p, b.path[1])) b.path.shift();
          const wp = b.path && b.path[0];
          if (wp) {
            const ddx = wp.x - p.x, ddz = wp.z - p.z, dd = Math.hypot(ddx, ddz);
            if (dd < 0.35) b.path.shift();
            else { mx = ddx / dd; mz = ddz / dd; }
          }
        }
      }
    }
    const moveLen = Math.hypot(mx, mz);
    b.moving = moveLen > 0.1;
    if (b.moving) b.moveYaw = Math.atan2(-mx, -mz);
    const speed = 6.0 * (w.speed || 1) * (shooting && !w.melee ? 0.5 : 1);
    b.vel.x = mx * speed; b.vel.z = mz * speed;
    // hop up small ledges on the path, like a player would
    if (b.moving && b.onGround) {
      const ax = p.x + mx / moveLen * 0.6, az = p.z + mz / moveLen * 0.6;
      const rise = P.groundHeight(this.map, ax, p.y, az, 0.2, 1.0) - p.y;
      if (rise > 0.42 && rise < 1.0) b.vel.y = P.JUMP_V;
    }
    b.vel.y -= P.GRAVITY * dt;
    const pos = { x: p.x, y: p.y, z: p.z };
    b.onGround = P.moveBody(this.map, pos, b.vel, dt, P.PLAYER_R, P.STAND_H);
    p.x = pos.x; p.y = pos.y; p.z = pos.z;

    // stuck detection
    if (b.moving) {
      b.stuckT += dt;
      if (b.stuckT > 1) {
        if (Math.hypot(p.x - b.lastPos.x, p.z - b.lastPos.z) < 0.4) { b.path = null; if (Math.random() < 0.5) b.goal = null; }
        b.stuckT = 0; b.lastPos = { x: p.x, z: p.z };
      }
    }
    this.tryPickups(p);
  }

  botChooseGoal(p, now) {
    const b = p.bot, bomb = this.bomb;
    if (this.phase === 'warmup') {
      if (!b.goal || (!b.path?.length && Math.random() < 0.02)) {
        b.goal = this.randomSiteCell(Math.random() < 0.5 ? 'A' : 'B'); b.path = null;
      }
      return;
    }
    if (this.phase !== 'live') return;
    const atGoal = b.goal && Math.hypot(p.x - b.goal.x, p.z - b.goal.z) < 1;
    if (p.team === 'T') {
      if (bomb.state === 'dropped') {
        const ts = this.teamOf('T').filter(q => q.alive);
        const nearest = ts.sort((a, c) => dist2d(a, bomb) - dist2d(c, bomb))[0];
        if (nearest === p) { if (!b.goal || dist2d(b.goal, bomb) > 0.5) { b.goal = { x: bomb.x, y: bomb.y, z: bomb.z }; b.path = null; } return; }
      }
      if (bomb.state === 'planted') {
        if (!b.goal || dist2d(b.goal, bomb) > 9) {
          const a = Math.random() * Math.PI * 2, r = rand(3, 7);
          const g = { x: bomb.x + Math.cos(a) * r, z: bomb.z + Math.sin(a) * r };
          b.goal = this.walkable(g) ? g : { x: bomb.x, z: bomb.z }; b.path = null;
        }
        if (atGoal) b.idleYaw = Math.atan2(-(bomb.x - p.x), -(bomb.z - p.z)) + Math.PI;
        return;
      }
      if (!b.goal) { b.goal = this.randomSiteCell(b.site || this.tPlan); b.path = null; }
      if (atGoal && !p.hasBomb && Math.random() < 0.005) { b.goal = this.randomSiteCell(b.site || this.tPlan); b.path = null; }
    } else {
      if (bomb.state === 'planted') {
        if (!b.goal || dist2d(b.goal, bomb) > 0.5) { b.goal = { x: bomb.x, y: bomb.y, z: bomb.z }; b.path = null; }
        return;
      }
      if (!b.goal) { b.goal = this.randomSiteCell(b.site || 'A'); b.path = null; }
      if (atGoal) {
        const ts = this.map.spawns.T[0];
        if (!b.watchSet) { b.idleYaw = Math.atan2(-(ts.x - p.x), -(ts.z - p.z)) + rand(-0.8, 0.8); b.watchSet = true; }
        if (Math.random() < 0.003) { b.goal = this.randomSiteCell(b.site || 'A'); b.path = null; b.watchSet = false; }
      }
    }
  }

  // Is there a standing spot at g on roughly the bomb's level?
  walkable(g) {
    const nav = getNav(this.map), j = nearestNode(nav, g.x, this.bomb.y, g.z);
    if (j < 0) return false;
    const n = nav.nodes[j];
    return Math.hypot(n.x - g.x, n.z - g.z) < 1 && Math.abs(n.y - this.bomb.y) < 1;
  }

  botFire(p, w, wid, now, tDist) {
    const b = p.bot;
    b.nextFire = now + w.rate * 1000;
    b.ammo[wid]--;
    b.spray++;
    // burst control at range
    if (w.auto && tDist > 14) { b.burst++; if (b.burst >= (tDist > 30 ? 3 : 5)) { b.burst = 0; b.pause = now + rand(250, 450); b.spray = 0; } }
    const moving = Math.hypot(b.vel.x, b.vel.z) > 1;
    const sprayPen = w.auto ? Math.min(b.spray, 12) * w.recoil * 0.0035 : 0;
    const spread = (w.scope ? w.spread : w.spread) + (moving ? w.moveSpread * 0.5 : 0) + sprayPen;
    const yaw = p.yaw + rand(-1, 1) * spread, pitch = p.pitch + rand(-1, 1) * spread + sprayPen * 0.5;
    const dx = -Math.sin(yaw) * Math.cos(pitch), dy = Math.sin(pitch), dz = -Math.cos(yaw) * Math.cos(pitch);
    const ox = p.x, oy = eyeY(p), oz = p.z;
    const wall = P.raycastWorld(this.map, ox, oy, oz, dx, dy, dz, 200);
    let end = wall ? wall.dist : 200;
    const enemies = [...this.players.values()].filter(e => e.alive && e.team !== p.team && e.team !== 'SPEC');
    const hit = P.raycastPlayers(enemies, ox, oy, oz, dx, dy, dz, end, p.id);
    let smoked = false;
    if (hit) smoked = P.smokeBlocks(this.smokes, { x: ox, y: oy, z: oz }, { x: ox + dx * hit.dist, y: oy + dy * hit.dist, z: oz + dz * hit.dist });
    if (hit && !smoked) end = hit.dist;
    this.broadcast({ t: 'shot', id: p.id, w: wid, o: [ox, oy, oz], e: [ox + dx * end, oy + dy * end, oz + dz * end] });
    this.noises.push({ x: p.x, z: p.z, at: now, team: p.team });
    if (hit && !smoked) this.damage(this.players.get(hit.id), p, wid, hit.group, hit.dist, false);
  }
}

// ---------------------------------------------------------------- error log
// Errors never stop the server; they are printed and saved to server-errors.log so problems can be reported.
const ERROR_LOG = path.join(ROOT, 'server-errors.log');
function logError(where, e) {
  const line = `[${new Date().toISOString()}] ${where}: ${e && e.stack ? e.stack : e}\n`;
  console.error(line);
  try { fs.appendFileSync(ERROR_LOG, line); } catch { /* ignore */ }
}
process.on('uncaughtException', (e) => {
  if (e && e.code === 'EADDRINUSE') {
    console.error(`Port ${PORT} is already in use - the game server is probably already running in another window.`);
    process.exit(1);
  }
  logError('uncaught', e);
});
process.on('unhandledRejection', (e) => logError('unhandled promise', e));

// ---------------------------------------------------------------- networking
const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 16 * 1024 });

function lobbyList() { return [...lobbies.values()].map(l => l.summary()); }

wss.on('connection', (ws) => {
  const p = newPlayer('Player', false);
  p.ws = ws;
  p.lobby = null;
  ws.on('message', (data) => {
    let m;
    try { m = JSON.parse(data); } catch { return; }
    if (!m || typeof m.t !== 'string') return;
    try { handleMessage(m); } catch (e) { logError(`message "${m.t}" from ${p.name}`, e); }
  });
  function handleMessage(m) {
    switch (m.t) {
      case 'hello':
        p.name = cleanText(m.name, 16) || 'Player';
        send(p, { t: 'welcome', id: p.id, maps: MAP_INFO });
        break;
      case 'list': send(p, { t: 'lobbies', list: lobbyList() }); break;
      case 'create': {
        if (p.lobby) p.lobby.remove(p);
        if (lobbies.size >= 20) return send(p, { t: 'error', text: 'Too many lobbies on this server' });
        const l = new Lobby(m, p);
        lobbies.set(l.id, l);
        l.addHuman(p);
        l.setTeam(p, m.team || 'auto');
        l.balanceBots();
        break;
      }
      case 'join': {
        const l = lobbies.get(String(m.id || '').toUpperCase());
        if (!l) return send(p, { t: 'error', text: 'Lobby not found' });
        if (l.password && l.password !== String(m.password || '')) return send(p, { t: 'error', text: 'Wrong password' });
        if (l.humans().length >= l.maxPlayers) return send(p, { t: 'error', text: 'Lobby is full' });
        if (p.lobby) p.lobby.remove(p);
        l.addHuman(p);
        break;
      }
      case 'leave': if (p.lobby) p.lobby.remove(p); send(p, { t: 'left' }); break;
      case 'pong': if (typeof m.ts === 'number') p.ping = clamp(Date.now() - m.ts, 0, 999); break;
      default: if (p.lobby) p.lobby.handle(p, m);
    }
  }
  ws.on('close', () => { try { if (p.lobby) p.lobby.remove(p); } catch (e) { logError('disconnect', e); } });
  ws.on('error', () => {});
});

// ---------------------------------------------------------------- loops
let last = Date.now();
setInterval(() => {
  const now = Date.now();
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  for (const l of lobbies.values()) {
    try { l.tick(dt); } catch (e) { logError(`lobby ${l.id} tick`, e); }
  }
}, TICK);

setInterval(() => {
  const now = Date.now();
  for (const l of lobbies.values()) for (const p of l.players.values()) send(p, { t: 'ping', ts: now });
}, 2000);

server.listen(PORT, '0.0.0.0', () => {
  console.log('\n  STRIKE LITE server running!\n');
  console.log(`  Play on this PC:      http://localhost:${PORT}`);
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const n of nets[name] || []) {
      if (n.family === 'IPv4' && !n.internal) console.log(`  Friends connect to:   http://${n.address}:${PORT}   (${name})`);
    }
  }
  console.log('\n  Keep this window open while playing. Press Ctrl+C to stop.\n');
});
server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') console.error(`Port ${PORT} is already in use. Is the server already running?`);
  else console.error(e);
  process.exit(1);
});
