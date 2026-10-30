// All sounds are synthesized with WebAudio, so there are no sound files to download.
import { settings } from './settings.js';

let ctx = null, master = null, noise = null;
const listener = { x: 0, y: 0, z: 0, yaw: 0 };

export function initAudio() {
  if (ctx) { if (ctx.state === 'suspended') ctx.resume(); return; }
  ctx = new (window.AudioContext || window.webkitAudioContext)();
  master = ctx.createGain();
  master.connect(ctx.destination);
  noise = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
  const d = noise.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
}

export function setListener(x, y, z, yaw) { listener.x = x; listener.y = y; listener.z = z; listener.yaw = yaw; }

// Returns an output node routed with distance attenuation and stereo pan, or null if inaudible.
function out(pos, vol, range = 60) {
  if (!ctx) return null;
  master.gain.value = settings.volume;
  let gain = vol, pan = 0;
  if (pos) {
    const dx = pos.x - listener.x, dz = pos.z - listener.z;
    const d = Math.hypot(dx, dz, (pos.y || 0) - listener.y);
    gain *= Math.max(0, 1 - d / range) ** 1.6;
    if (gain < 0.005) return null;
    // right vector of the listener = (cos yaw, -sin yaw)
    const rx = Math.cos(listener.yaw), rz = -Math.sin(listener.yaw);
    pan = d > 0.5 ? Math.max(-1, Math.min(1, (dx * rx + dz * rz) / d)) * 0.8 : 0;
  }
  const g = ctx.createGain();
  g.gain.value = gain;
  let p = null;
  if (ctx.createStereoPanner) {
    p = ctx.createStereoPanner();
    p.pan.value = pan;
    g.connect(p); p.connect(master);
  } else g.connect(master);
  // every sound is shorter than 3 s; disconnect afterwards so nodes don't pile up during long matches
  setTimeout(() => { try { g.disconnect(); if (p) p.disconnect(); } catch { /* already gone */ } }, 3500);
  return g;
}

function burst(dest, { dur = 0.15, freq = 2000, q = 0.8, type = 'lowpass', attack = 0.002, vol = 1, t = 0, rate = 1 }) {
  const s = ctx.createBufferSource();
  s.buffer = noise; s.playbackRate.value = rate;
  const f = ctx.createBiquadFilter();
  f.type = type; f.frequency.value = freq; f.Q.value = q;
  const g = ctx.createGain();
  const t0 = ctx.currentTime + t;
  g.gain.setValueAtTime(0, t0);
  g.gain.linearRampToValueAtTime(vol, t0 + attack);
  g.gain.exponentialRampToValueAtTime(0.001, t0 + dur);
  s.connect(f); f.connect(g); g.connect(dest);
  s.start(t0, Math.random() * 0.5); s.stop(t0 + dur + 0.05);
}

function tone(dest, { freq = 440, dur = 0.1, type = 'sine', vol = 0.5, t = 0, slide = 0 }) {
  const o = ctx.createOscillator();
  o.type = type;
  const t0 = ctx.currentTime + t;
  o.frequency.setValueAtTime(freq, t0);
  if (slide) o.frequency.exponentialRampToValueAtTime(Math.max(20, freq * slide), t0 + dur);
  const g = ctx.createGain();
  g.gain.setValueAtTime(vol, t0);
  g.gain.exponentialRampToValueAtTime(0.001, t0 + dur);
  o.connect(g); g.connect(dest);
  o.start(t0); o.stop(t0 + dur + 0.05);
}

const GUN = {
  glock: { freq: 3500, dur: 0.12, thump: 120, vol: 0.55 },
  usp: { freq: 1400, dur: 0.09, thump: 90, vol: 0.3 },
  p250: { freq: 3000, dur: 0.13, thump: 110, vol: 0.6 },
  deagle: { freq: 2200, dur: 0.3, thump: 70, vol: 0.9 },
  mac10: { freq: 3800, dur: 0.09, thump: 130, vol: 0.5 },
  mp9: { freq: 4200, dur: 0.08, thump: 140, vol: 0.5 },
  galil: { freq: 2600, dur: 0.16, thump: 85, vol: 0.7 },
  famas: { freq: 2900, dur: 0.15, thump: 90, vol: 0.7 },
  ak47: { freq: 2200, dur: 0.2, thump: 70, vol: 0.85 },
  m4a4: { freq: 2700, dur: 0.17, thump: 85, vol: 0.75 },
  awp: { freq: 1600, dur: 0.6, thump: 50, vol: 1.0 },
};

export const sfx = {
  shot(w, pos) {
    const g = GUN[w] || GUN.glock;
    const o = out(pos, g.vol, 120);
    if (!o) return;
    burst(o, { dur: g.dur, freq: g.freq, vol: 1, rate: 0.9 + Math.random() * 0.2 });
    tone(o, { freq: g.thump * 2, dur: g.dur * 0.8, type: 'triangle', vol: 0.6, slide: 0.4 });
    if (pos) burst(o, { dur: g.dur * 2.5, freq: 600, vol: 0.25, t: 0.02 }); // distant tail
  },
  knife(pos) { const o = out(pos, 0.35, 15); if (o) burst(o, { dur: 0.18, freq: 5000, type: 'bandpass', q: 1.5, attack: 0.05 }); },
  step(pos, loud = 0.25) { const o = out(pos, loud, 30); if (o) burst(o, { dur: 0.07, freq: 700 + Math.random() * 300, vol: 1 }); },
  land(pos) { const o = out(pos, 0.4, 30); if (o) burst(o, { dur: 0.12, freq: 400, vol: 1 }); },
  reload() { const o = out(null, 0.35); if (!o) return; burst(o, { dur: 0.05, freq: 3000, type: 'bandpass', q: 3 }); burst(o, { dur: 0.06, freq: 2000, type: 'bandpass', q: 3, t: 0.35 }); },
  empty() { const o = out(null, 0.3); if (o) burst(o, { dur: 0.03, freq: 4000, type: 'bandpass', q: 4 }); },
  draw() { const o = out(null, 0.2); if (o) burst(o, { dur: 0.08, freq: 2500, type: 'bandpass', q: 2 }); },
  hit(head) { const o = out(null, head ? 0.5 : 0.3); if (!o) return; if (head) tone(o, { freq: 1800, dur: 0.15, type: 'square', vol: 0.25 }); burst(o, { dur: 0.06, freq: 1200 }); },
  hurt() { const o = out(null, 0.5); if (o) burst(o, { dur: 0.12, freq: 500 }); },
  beep(pos) { const o = out(pos, 0.5, 70); if (o) tone(o, { freq: 2600, dur: 0.12, type: 'sine', vol: 0.6 }); },
  plantBeep(pos) { const o = out(pos, 0.35, 30); if (o) tone(o, { freq: 1900, dur: 0.06, type: 'square', vol: 0.3 }); },
  explosion(pos, big = false) {
    const o = out(pos, big ? 1.4 : 1, big ? 200 : 90);
    if (!o) return;
    burst(o, { dur: big ? 2.5 : 1.2, freq: big ? 500 : 900, vol: 1, attack: 0.005 });
    tone(o, { freq: 90, dur: big ? 1.5 : 0.7, type: 'sine', vol: 0.9, slide: 0.3 });
  },
  flashbang(pos) { const o = out(pos, 0.8, 80); if (o) { burst(o, { dur: 0.4, freq: 3000, vol: 1 }); } },
  ring(amount) { const o = out(null, 0.25 * amount); if (o) tone(o, { freq: 3800, dur: 2.5 * amount, vol: 0.3 }); },
  smoke(pos) { const o = out(pos, 0.5, 50); if (o) burst(o, { dur: 2.0, freq: 1800, type: 'bandpass', q: 0.5, attack: 0.1 }); },
  bounce(pos) { const o = out(pos, 0.25, 25); if (o) burst(o, { dur: 0.04, freq: 2500, type: 'bandpass', q: 2 }); },
  pickup() { const o = out(null, 0.3); if (o) burst(o, { dur: 0.1, freq: 1500, type: 'bandpass', q: 2 }); },
  buy() { const o = out(null, 0.25); if (o) { tone(o, { freq: 900, dur: 0.06, vol: 0.3 }); tone(o, { freq: 1300, dur: 0.08, vol: 0.3, t: 0.06 }); } },
  roundStart() { const o = out(null, 0.3); if (o) { tone(o, { freq: 660, dur: 0.15, type: 'triangle', vol: 0.4 }); tone(o, { freq: 880, dur: 0.25, type: 'triangle', vol: 0.4, t: 0.15 }); } },
  win(good) {
    const o = out(null, 0.35);
    if (!o) return;
    const notes = good ? [523, 659, 784, 1047] : [523, 466, 392, 311];
    notes.forEach((f, i) => tone(o, { freq: f, dur: 0.3, type: 'triangle', vol: 0.35, t: i * 0.14 }));
  },
  defused(pos) { const o = out(pos, 0.6, 80); if (o) { tone(o, { freq: 1200, dur: 0.1, vol: 0.4 }); tone(o, { freq: 600, dur: 0.3, vol: 0.4, t: 0.12 }); } },
};
