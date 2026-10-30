// Headless smoke test: creates a lobby full of bots as a spectator and logs what happens.
// Usage: node tools/bot-test.js [seconds]  (server must be running)
import WebSocket from 'ws';

const secs = Number(process.argv[2]) || 60;
const ws = new WebSocket('ws://localhost:3000/ws');
const names = {};
let kills = 0, rounds = 0;
ws.on('open', () => {
  ws.send(JSON.stringify({ t: 'hello', name: 'Tester' }));
  ws.send(JSON.stringify({ t: 'create', name: 'test', map: process.argv[3] || 'dust2', bots: 9, maxPlayers: 10, team: 'SPEC', difficulty: 'normal' }));
});
ws.on('message', (d) => {
  const m = JSON.parse(d);
  if (m.t === 'ping') return ws.send(JSON.stringify({ t: 'pong', ts: m.ts }));
  if (m.t === 'info') for (const p of m.players) names[p.id] = `${p.name}(${p.team})`;
  if (m.t === 'kill') { kills++; console.log('KILL', names[m.k] || m.k, '->', names[m.v] || m.v, m.w, m.hs ? 'HS' : ''); }
  if (m.t === 'roundEnd') { rounds++; console.log('ROUND END', m.text, m.score); }
  if (m.t === 'planted') console.log('PLANTED at', m.site);
  if (m.t === 'bomb' && m.state !== 'dropped') console.log('BOMB state ->', m.state);
  if (m.t === 'roundStart') console.log('ROUND START', m.round);
  if (m.t === 'msg') console.log('MSG', m.text);
  if (m.t === 'phase') console.log('PHASE', m.phase);
});
setTimeout(() => { console.log(`\nDone: ${kills} kills, ${rounds} rounds in ${secs}s`); process.exit(0); }, secs * 1000);
