// DOM heads-up display: health, ammo, timer, killfeed, radar, scoreboard, buy menu.
import { WEAPONS, BUY_MENU, itemInfo } from '/shared/weapons.js';
import { CELL } from '/shared/maps.js';
import { settings } from './settings.js';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export class Hud {
  constructor() {
    this.el = $('hud');
    this.cache = {};
    this.radarCtx = $('radar').getContext('2d');
    this.radarImg = null;
    this.roundTimer = 0;
    this.centerTimer = 0;
    this.applyCrosshair(0);
  }

  set(id, value, prop = 'textContent') {
    const key = id + prop;
    if (this.cache[key] === value) return;
    this.cache[key] = value;
    $(id)[prop] = value;
  }

  show(on) { this.el.classList.toggle('hidden', !on); }

  vitals(hp, armor, helmet, money, hasBomb, kit) {
    this.set('hp', String(hp));
    this.set('armor', String(armor));
    this.set('armor-icon', helmet ? '⛑' : '⛨');
    $('hp').parentElement.classList.toggle('low', hp <= 25);
    this.set('money', '$' + money);
    $('bomb-icon').classList.toggle('hidden', !hasBomb);
    $('kit-icon').classList.toggle('hidden', !kit);
  }

  ammo(weaponId, mag, reserve) {
    const w = WEAPONS[weaponId];
    this.set('weapon-name', w ? w.name : '');
    const showAmmo = w && !w.melee && !w.nade && weaponId !== 'bomb';
    $('ammo').style.visibility = showAmmo ? 'visible' : 'hidden';
    if (showAmmo) {
      this.set('mag', String(mag));
      this.set('reserve', '/ ' + reserve);
      $('ammo').classList.toggle('low', mag <= Math.ceil(w.mag * 0.2));
    }
  }

  slots(list, current) {
    const key = JSON.stringify([list, current]);
    if (this.cache.slots === key) return;
    this.cache.slots = key;
    $('slots').innerHTML = list.map(([n, id]) => `<div class="${id === current ? 'cur' : ''}">${n} ${esc(WEAPONS[id]?.name || id)}</div>`).join('');
  }

  timer(ms, bomb) {
    const el = $('timer');
    el.classList.toggle('bomb', !!bomb);
    if (bomb) return this.set('timer', 'C4');
    if (ms < 0) return this.set('timer', '--:--');
    const s = Math.ceil(ms / 1000);
    this.set('timer', `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`);
  }

  score(t, ct, tAlive, tTotal, ctAlive, ctTotal) {
    this.set('sc-t', String(t)); this.set('sc-ct', String(ct));
    const dots = (a, n) => Array.from({ length: n }, (_, i) => `<i class="${i < a ? '' : 'dead'}"></i>`).join('');
    this.set('alive-t', dots(tAlive, tTotal), 'innerHTML');
    this.set('alive-ct', dots(ctAlive, ctTotal), 'innerHTML');
  }

  killfeed(killer, victim, weapon, hs, mine) {
    const d = document.createElement('div');
    d.className = 'kf' + (mine ? ' mine' : '');
    const name = (p) => p ? `<span class="${p.team === 'T' ? 't' : 'ct'}">${esc(p.name)}</span>` : '';
    const wname = weapon === 'bomb' ? 'C4' : WEAPONS[weapon]?.name || weapon;
    d.innerHTML = `${killer && killer !== victim ? name(killer) : ''}<span class="w">${esc(wname)}${hs ? ' <span class="hs">◉</span>' : ''}</span>${name(victim)}`;
    $('killfeed').appendChild(d);
    setTimeout(() => d.remove(), 6000);
    while ($('killfeed').children.length > 6) $('killfeed').firstChild.remove();
  }

  chat(name, team, text, sys) {
    const d = document.createElement('div');
    if (sys) { d.className = 'sys'; d.textContent = text; }
    else d.innerHTML = `<span class="${team === 'T' ? 't' : team === 'CT' ? 'ct' : ''}">${esc(name)}</span>: ${esc(text)}`;
    $('chat').appendChild(d);
    setTimeout(() => d.remove(), 9000);
    while ($('chat').children.length > 8) $('chat').firstChild.remove();
  }

  center(text, ms = 2500) {
    $('center-msg').innerHTML = text ? `<div>${esc(text)}</div>` : '';
    clearTimeout(this.centerTimer);
    if (text) this.centerTimer = setTimeout(() => { $('center-msg').innerHTML = ''; }, ms);
  }

  roundMsg(text, cls, ms = 4500) {
    const el = $('round-msg');
    el.textContent = text; el.className = cls || '';
    clearTimeout(this.roundTimer);
    if (text) this.roundTimer = setTimeout(() => { el.textContent = ''; }, ms);
  }

  hint(text) { this.set('hint', text || ''); }

  progress(label, frac) {
    const el = $('progress');
    if (label == null) { el.classList.add('hidden'); return; }
    el.classList.remove('hidden');
    el.querySelector('.label').textContent = label;
    el.querySelector('.bar div').style.width = Math.round(Math.min(1, frac) * 100) + '%';
  }

  hitmarker(head) {
    const el = $('hitmarker');
    el.classList.toggle('head', !!head);
    el.classList.add('on');
    clearTimeout(this.hmT);
    this.hmT = setTimeout(() => el.classList.remove('on'), 90);
  }

  damageFrom(angle) {
    const i = document.createElement('i');
    i.style.transform = `rotate(${angle}rad) translateY(-110px)`;
    $('dmg-ind').appendChild(i);
    setTimeout(() => i.remove(), 1200);
  }

  flash(amount) { $('flash').style.opacity = String(Math.max(0, Math.min(1, amount))); }

  scope(on) {
    $('scope').classList.toggle('hidden', !on);
  }

  applyCrosshair(spreadPx, hidden) {
    const el = $('crosshair');
    el.style.display = hidden ? 'none' : '';
    if (hidden) return;
    const len = settings.crossSize, gap = settings.crossGap + spreadPx, th = 2, col = settings.crossColor;
    const key = [len, Math.round(gap), col].join();
    if (this.cache.cross === key) return;
    this.cache.cross = key;
    const [l, r, u, d] = el.children;
    for (const i of [l, r, u, d]) i.style.background = col;
    Object.assign(l.style, { width: len + 'px', height: th + 'px', left: -(gap + len) + 'px', top: -th / 2 + 'px' });
    Object.assign(r.style, { width: len + 'px', height: th + 'px', left: gap + 'px', top: -th / 2 + 'px' });
    Object.assign(u.style, { width: th + 'px', height: len + 'px', top: -(gap + len) + 'px', left: -th / 2 + 'px' });
    Object.assign(d.style, { width: th + 'px', height: len + 'px', top: gap + 'px', left: -th / 2 + 'px' });
  }

  spectate(text) {
    $('spec').classList.toggle('hidden', !text);
    if (text) this.set('spec', `<span>${esc(text)}</span>`, 'innerHTML');
  }

  fps(n) {
    $('fps').classList.toggle('hidden', !settings.showFps);
    if (settings.showFps) this.set('fps', n + ' fps');
  }

  // ------------------------------------------------ radar
  setRadarMap(canvas) { this.radarImg = canvas; }

  radar(map, me, dots, bomb) {
    const g = this.radarCtx, S = 200;
    g.clearRect(0, 0, S, S);
    if (!this.radarImg) return;
    const worldW = map.w * CELL, worldH = map.h * CELL;
    const sc = S / Math.max(worldW, worldH);
    g.globalAlpha = 0.85;
    g.drawImage(this.radarImg, 0, 0, worldW * sc, worldH * sc);
    g.globalAlpha = 1;
    for (const d of dots) {
      g.fillStyle = d.color;
      g.beginPath(); g.arc(d.x * sc, d.z * sc, 3.5, 0, Math.PI * 2); g.fill();
      if (d.bomb) { g.strokeStyle = '#ff4040'; g.lineWidth = 2; g.stroke(); }
    }
    if (bomb) {
      g.fillStyle = bomb.planted ? (Date.now() % 600 < 300 ? '#ff3030' : '#801010') : '#ffb030';
      g.fillRect(bomb.x * sc - 4, bomb.z * sc - 4, 8, 8);
    }
    if (me) {
      g.save();
      g.translate(me.x * sc, me.z * sc);
      g.rotate(-me.yaw);
      g.fillStyle = '#ffffff';
      g.beginPath(); g.moveTo(0, -7); g.lineTo(5, 5); g.lineTo(0, 2); g.lineTo(-5, 5); g.closePath(); g.fill();
      g.restore();
    }
  }

  // ------------------------------------------------ scoreboard
  scoreboard(info, myId, lobbyName) {
    if (!info) return;
    $('sb-title').textContent = lobbyName || '';
    $('sb-score').innerHTML = `<span style="color:var(--ct)">CT ${info.score.CT}</span> : <span style="color:var(--t)">${info.score.T} T</span>`;
    const row = (p) => `<tr class="${p.alive ? '' : 'dead'} ${p.id === myId ? 'me' : ''}"><td class="n">${esc(p.name)}${p.bot ? ' <small>BOT</small>' : ''}${p.id === info.host ? ' ★' : ''}${p.hasBomb ? ' <b style="color:var(--t)">C4</b>' : ''}</td><td>${p.money !== undefined ? '$' + p.money : ''}</td><td>K ${p.k}</td><td>D ${p.d}</td><td>${p.bot ? 'BOT' : p.ping + 'ms'}</td></tr>`;
    const sorted = (team) => info.players.filter(p => p.team === team).sort((a, b) => b.k - a.k);
    $('sb-ct').innerHTML = sorted('CT').map(row).join('');
    $('sb-t').innerHTML = sorted('T').map(row).join('');
    const spec = info.players.filter(p => p.team === 'SPEC').map(p => esc(p.name));
    $('sb-spec').textContent = spec.length ? 'Spectators: ' + spec.join(', ') : '';
  }

  // ------------------------------------------------ buy menu
  buyMenu(team, money, owned, onBuy) {
    $('buy-money').textContent = '$' + money;
    const cats = $('buy-cats');
    cats.innerHTML = '';
    for (const cat of BUY_MENU) {
      const col = document.createElement('div');
      col.className = 'buycat';
      col.innerHTML = `<h4>${cat.cat}</h4>`;
      for (const id of cat.items) {
        const it = itemInfo(id);
        if (it.team && it.team !== team) continue;
        const b = document.createElement('button');
        b.className = 'buyitem' + (money < it.price || owned.includes(id) ? ' no' : '');
        b.innerHTML = `<span>${esc(it.name)}</span><small>$${it.price}</small>`;
        b.onclick = () => onBuy(id);
        col.appendChild(b);
      }
      cats.appendChild(col);
    }
  }
}
