// Tiny WebSocket wrapper with message-type handlers.
export class Net {
  constructor() {
    this.handlers = {};
    this.ws = null;
    this.open = false;
  }

  connect() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    this.ws = new WebSocket(`${proto}://${location.host}/ws`);
    this.ws.onopen = () => { this.open = true; this.emit('open', {}); };
    this.ws.onclose = () => { this.open = false; this.emit('close', {}); };
    this.ws.onmessage = (e) => {
      let m;
      try { m = JSON.parse(e.data); } catch { return; }
      if (m.t === 'ping') return this.send({ t: 'pong', ts: m.ts });
      this.emit(m.t, m);
    };
  }

  on(type, fn) { (this.handlers[type] ||= []).push(fn); }
  emit(type, m) { for (const fn of this.handlers[type] || []) fn(m); }
  send(m) { if (this.open) this.ws.send(JSON.stringify(m)); }
}
