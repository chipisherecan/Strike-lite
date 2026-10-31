// Menus, lobby browser and overlays. Creates the Game once and hands it the network.
import { Net } from './net.js';
import { Game } from './game.js';
import { Editor } from './editor.js';
import { initAudio } from './audio.js';
import { settings, buildSettingsUI } from './settings.js';
import { drawMapCanvas } from './world.js';
import { getMap, MAP_INFO, registerRealMap, isRealMap } from '/shared/maps.js';
import { loadRealMaps } from './realworld.js';

await loadRealMaps(registerRealMap);

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const show = (id, on) => $(id).classList.toggle('hidden', !on);
const isOpen = (id) => !$(id).classList.contains('hidden');

const net = new Net();
let creating = false;
let lobby = null;
let selectedMap = (MAP_INFO.find(m => isRealMap(m.id)) || MAP_INFO[0]).id;
let listTimer = 0;

const ui = {
  overlayOpen: () => ['buymenu', 'teamselect', 'pause', 'matchend'].some(isOpen) || !$('menu').classList.contains('hidden'),
  openPause() {
    if (!game.active) return;
    show('pause', true);
    show('pause-settings', false);
    $('lobby-code').textContent = lobby ? `${lobby.name} · code ${lobby.id}` : '';
    refreshHostTools();
  },
  toggleBuy() {
    if (isOpen('buymenu')) return ui.closeBuy(true);
    if (!game.me.alive || game.me.team === 'SPEC') return;
    renderBuy();
    show('buymenu', true);
    document.exitPointerLock?.();
  },
  closeBuy(relock) {
    if (!isOpen('buymenu')) return;
    show('buymenu', false);
    if (relock) game.lockPointer();
  },
  openTeamSelect() {
    show('teamselect', true);
    document.exitPointerLock?.();
    updateTeamCounts();
  },
  onInfo() {
    updateTeamCounts();
    if (isOpen('pause')) refreshHostTools();
  },
};

const game = new Game(net, ui);

// Map editor (opened from the main menu)
const editor = new Editor(() => { show('menu', true); });
$('open-editor').onclick = () => {
  initAudio();
  $('editor-pass').value = '';
  $('editor-lock-msg').textContent = '';
  show('editor-lock', true);
  $('editor-pass').focus();
};
$('editor-lock-cancel').onclick = () => show('editor-lock', false);
$('editor-lock-form').onsubmit = async (e) => {
  e.preventDefault();
  const password = $('editor-pass').value;
  try {
    const r = await fetch('/api/editor-unlock', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password }) });
    const j = await r.json();
    if (!r.ok) { $('editor-lock-msg').textContent = j.error || 'Wrong password'; $('editor-pass').select(); return; }
    editor.password = password; // the server checks it again on every save
    show('editor-lock', false);
    show('menu', false);
    editor.open(selectedMap);
  } catch {
    $('editor-lock-msg').textContent = 'Could not reach the server.';
  }
};

// ---------------------------------------------------------------- menu panels
function showPanel(name) {
  document.querySelectorAll('.panel').forEach(p => p.classList.toggle('show', p.id === 'p-' + name));
  clearInterval(listTimer);
  if (name === 'browser') { net.send({ t: 'list' }); listTimer = setInterval(() => net.send({ t: 'list' }), 3000); }
}
document.querySelectorAll('[data-panel]').forEach(b => b.onclick = () => { initAudio(); showPanel(b.dataset.panel); });

$('name').value = localStorage.getItem('strikelite.name') || '';
$('name').onchange = () => {
  localStorage.setItem('strikelite.name', $('name').value.trim());
  net.send({ t: 'hello', name: myName() });
};
const myName = () => $('name').value.trim() || 'Player' + Math.floor(Math.random() * 900 + 100);

// map cards
const mapsEl = $('c-maps');
for (const m of MAP_INFO) {
  const card = document.createElement('div');
  card.className = 'mapcard' + (m.id === selectedMap ? ' sel' : '');
  card.appendChild(drawMapCanvas(getMap(m.id), 2));
  card.insertAdjacentHTML('beforeend', `<b>${esc(m.name)}${isRealMap(m.id) ? ' <span style="color:#7fe08a">(real CS2 layout)</span>' : ''}</b><small>${esc(m.desc)}</small>`);
  card.onclick = () => { selectedMap = m.id; mapsEl.querySelectorAll('.mapcard').forEach(c => c.classList.remove('sel')); card.classList.add('sel'); };
  mapsEl.appendChild(card);
}

$('create-btn').onclick = () => {
  initAudio();
  creating = true;
  net.send({ t: 'hello', name: myName() });
  net.send({
    t: 'create', name: $('c-name').value.trim() || `${myName()}'s lobby`, map: selectedMap,
    maxPlayers: +$('c-max').value, bots: +$('c-bots').value, difficulty: $('c-diff').value,
    rounds: +$('c-rounds').value, team: $('c-team').value, password: $('c-pass').value,
  });
};

function join(id, locked) {
  initAudio();
  let password = '';
  if (locked) { password = prompt('Lobby password:') || ''; }
  creating = false;
  net.send({ t: 'hello', name: myName() });
  net.send({ t: 'join', id, password });
}
$('refresh').onclick = () => net.send({ t: 'list' });
$('join-code-btn').onclick = () => { const c = $('join-code').value.trim(); if (c) join(c, false); };

buildSettingsUI($('settings-body'), () => game.applySettings());

// ---------------------------------------------------------------- network
net.on('open', () => {
  $('conn').textContent = `Connected to ${location.host}`;
  net.send({ t: 'hello', name: myName() });
});
net.on('close', () => {
  $('conn').textContent = 'Disconnected from server. Reconnecting…';
  if (game.active) backToMenu('Lost connection to the server');
  setTimeout(() => net.connect(), 2000);
});
net.on('welcome', () => showPanel(document.querySelector('.panel.show')?.id.slice(2) || 'browser'));
net.on('lobbies', (m) => {
  const rows = $('lobby-rows');
  rows.innerHTML = m.list.map(l => `<tr><td>${l.locked ? '🔒 ' : ''}${esc(l.name)} <small style="color:var(--muted)">${l.id}</small></td><td>${esc(l.mapName)}</td><td>${l.humans}/${l.max}${l.bots ? ` <small>(+${l.bots} bots)</small>` : ''}</td><td>${l.score.CT} : ${l.score.T}</td><td><button data-join="${l.id}" data-locked="${l.locked ? 1 : 0}">Join</button></td></tr>`).join('');
  rows.querySelectorAll('[data-join]').forEach(b => b.onclick = () => join(b.dataset.join, b.dataset.locked === '1'));
  show('no-lobbies', m.list.length === 0);
});
net.on('error', (m) => { $('conn').textContent = m.text; alert(m.text); });
net.on('joined', (m) => {
  lobby = m.lobby;
  clearInterval(listTimer);
  show('menu', false);
  game.enter(lobby, m.map, m.you, m.host, m.mapVersion);
  if (!creating) ui.openTeamSelect();
  else game.lockPointer();
  creating = false;
});
net.on('left', () => backToMenu());
net.on('self', () => { if (isOpen('buymenu')) renderBuy(); });
net.on('matchEnd', (m) => {
  $('me-title').textContent = m.winner === 'DRAW' ? 'Draw!' : m.winner === game.me.team ? 'Victory!' : game.me.team === 'SPEC' ? (m.winner === 'T' ? 'Terrorists win the match' : 'Counter-Terrorists win the match') : 'Defeat';
  $('me-score').innerHTML = `<span style="color:var(--ct)">${m.score.CT}</span> : <span style="color:var(--t)">${m.score.T}</span>`;
  show('matchend', true);
  setTimeout(() => show('matchend', false), 8000);
});
net.on('settings', () => refreshHostTools());

function backToMenu(reason) {
  game.leave();
  lobby = null;
  ['buymenu', 'teamselect', 'pause', 'matchend', 'scoreboard'].forEach(id => show(id, false));
  show('menu', true);
  document.exitPointerLock?.();
  showPanel('browser');
  if (reason) $('conn').textContent = reason;
}

// ---------------------------------------------------------------- overlays
function renderBuy() {
  const me = game.me;
  const owned = [me.primary, me.secondary, ...(me.kit ? ['kit'] : []), ...(me.armor >= 100 && me.helmet ? ['vesthelm', 'vest'] : me.armor >= 100 ? ['vest'] : [])].filter(Boolean);
  game.hud.buyMenu(me.team, me.money, owned, (id) => net.send({ t: 'buy', item: id }));
}

function updateTeamCounts() {
  const info = game.info;
  if (!info) return;
  const c = (t) => info.players.filter(p => p.team === t);
  $('ts-t').textContent = `${c('T').length} players (${c('T').filter(p => p.bot).length} bots)`;
  $('ts-ct').textContent = `${c('CT').length} players (${c('CT').filter(p => p.bot).length} bots)`;
}

document.querySelectorAll('[data-team]').forEach(b => b.onclick = () => {
  initAudio();
  net.send({ t: 'team', team: b.dataset.team });
  show('teamselect', false);
  show('pause', false);
  game.lockPointer();
});

$('resume').onclick = () => { show('pause', false); game.lockPointer(); };
$('p-team').onclick = () => { show('pause', false); ui.openTeamSelect(); };
$('p-settings-btn').onclick = () => {
  const el = $('pause-settings');
  if (el.classList.contains('hidden')) buildSettingsUI(el, () => game.applySettings());
  show('pause-settings', el.classList.contains('hidden'));
};
$('leave').onclick = () => { net.send({ t: 'leave' }); backToMenu(); };

// host tools
$('h-map').innerHTML = MAP_INFO.map(m => `<option value="${m.id}">${esc(m.name)}</option>`).join('');
$('h-bots').innerHTML = Array.from({ length: 10 }, (_, i) => `<option>${i}</option>`).join('');
$('h-map-btn').onclick = () => net.send({ t: 'host', cmd: 'map', map: $('h-map').value });
$('h-restart').onclick = () => net.send({ t: 'host', cmd: 'restart' });
$('h-bots').onchange = () => net.send({ t: 'host', cmd: 'bots', n: +$('h-bots').value });
$('h-diff').onchange = () => net.send({ t: 'host', cmd: 'difficulty', d: $('h-diff').value });
let hostSynced = false;
function refreshHostTools() {
  const isHost = game.info && game.info.host === game.me.id;
  show('host-tools', !!isHost);
  if (isHost && game.map && !hostSynced) {
    $('h-map').value = game.map.id;
    const bots = game.info.players.filter(p => p.bot).length;
    $('h-bots').value = String(bots);
    hostSynced = true;
  }
  if (!isOpen('pause')) hostSynced = false;
}
net.on('joined', (m) => { $('h-diff').value = m.difficulty || 'normal'; $('h-bots').value = String(m.botQuota ?? 0); });
net.on('settings', (m) => { $('h-diff').value = m.difficulty; $('h-bots').value = String(m.botQuota); });

document.addEventListener('keydown', (e) => {
  if (e.code === 'Escape' && isOpen('buymenu')) ui.closeBuy(true);
});

// Safety net: if the tab is about to close mid-match (e.g. Ctrl+W while crouching), ask first.
window.addEventListener('beforeunload', (e) => {
  if (game.active) { e.preventDefault(); e.returnValue = ''; }
});

net.connect();
window.__game = game; // handy for debugging in the console
window.__editor = editor;
void settings;
