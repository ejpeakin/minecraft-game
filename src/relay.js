// Multiplayer through the Google Apps Script relay (relay/Code.gs), for networks
// that block game servers. It behaves like the WebSocket to server.js (same
// readyState, send, close and on* callbacks, same messages in and out), so Net
// doesn't care which one it has. The room logic the server would do runs here:
// the host answers a newcomer's "hello" with a snapshot of the world, positions
// travel in the relay's player list, and everything else is a posted message.

const POLL_MS = 400; // aim for about 2.5 check-ins a second
const GIVE_UP_MS = 30000; // close after this long without a successful check-in
const JOIN_TIMEOUT_MS = 60000;
const SNAPSHOT_PIECE = 60000; // characters per snapshot message (relay keeps 100 KB per message)

const newId = () => Math.random().toString(36).slice(2, 10);
const newCode = () => Array.from({ length: 4 }, () => 'ABCDEFGHJKLMNPQRSTUVWXYZ'[Math.floor(Math.random() * 24)]).join('');

export const isRelayUrl = (url) => /script\.google(usercontent)?\.com|\/exec\/?$/.test(url);

export class RelaySocket {
  constructor(url, net) {
    this.url = url;
    this.net = net;
    this.readyState = 0;
    this.id = newId();
    this.room = null;
    this.name = 'Player';
    this.isHost = false;
    this.hostId = null;
    this.since = -1;
    this.out = [];
    this.me = null;
    this.known = new Map(); // id → last seen state, for join/leave/move
    this.pieces = null; // snapshot pieces while joining
    this.joining = null;
    this.held = []; // messages that arrive before our world exists
    this.lastOk = Date.now();
    this.closed = false;
    // Confirm the relay answers before reporting "open", like a WebSocket handshake.
    fetch(this.url, { method: 'GET' })
      .then((r) => r.json())
      .then((j) => {
        if (this.closed) return;
        if (j?.app !== 'blockcraft-relay') throw new Error('not a relay');
        this.readyState = 1;
        this.onopen?.();
      })
      .catch(() => {
        if (this.closed) return;
        this.readyState = 3;
        this.onerror?.();
      });
  }

  emit(msg) {
    this.onmessage?.({ data: JSON.stringify(msg) });
  }

  post(d, to = null) {
    this.out.push(to ? { to, d } : { d });
  }

  send(text) {
    const msg = JSON.parse(text);
    switch (msg.t) {
      case 'host':
        this.name = msg.name;
        this.room = newCode();
        this.isHost = true;
        this.hostId = this.id;
        this.world = msg.world;
        this.me = [0, 0, 0, 0, 0, 0];
        this.poll().then(() => this.emit({ t: 'hosted', code: this.room, id: this.id }));
        return;
      case 'join':
        this.name = msg.name;
        this.room = String(msg.code).toUpperCase();
        this.me = [0, -100, 0, 0, 0, 0];
        this.post({ t: 'hello', name: this.name });
        this.net.game.ui.setMultiplayerStatus('Connected. Waiting for the host to send their world\u2026');
        this.joining = setTimeout(() => {
          this.joining = null;
          this.emit({ t: 'error', msg: 'No game with that code is running right now. Check the code, and make sure the host is in their world.' });
        }, JOIN_TIMEOUT_MS);
        this.poll();
        return;
      case 'move':
        this.me = msg.s;
        return;
      case 'edit':
        this.post({ t: 'edit', e: msg.e });
        return;
      case 'chat':
        this.post({ t: 'chat', id: this.id, name: this.name, text: msg.text });
        return;
      case 'hit':
        this.post({ t: 'hit', from: this.id, name: this.name, dmg: msg.dmg, x: msg.x, z: msg.z }, msg.target);
        return;
      case 'boom':
        this.post({ t: 'boom', x: msg.x, y: msg.y, z: msg.z, power: msg.power });
        return;
      case 'time':
        if (this.isHost) this.post({ t: 'time', time: msg.time });
        return;
      default:
    }
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.timer);
    clearTimeout(this.joining);
    if (this.room && this.readyState === 1) {
      fetch(this.url, { method: 'POST', body: JSON.stringify({ room: this.room, id: this.id, bye: true }), headers: { 'Content-Type': 'text/plain' } }).catch(() => {});
    }
    this.readyState = 3;
    this.onclose?.();
  }

  async poll() {
    if (this.closed) return;
    clearTimeout(this.timer);
    const started = Date.now();
    const out = this.out.splice(0, 60);
    let reply = null;
    try {
      const res = await fetch(this.url, {
        method: 'POST',
        // text/plain keeps this a "simple" request, which Apps Script accepts cross-site.
        headers: { 'Content-Type': 'text/plain' },
        body: JSON.stringify({ room: this.room, id: this.id, since: this.since, me: { name: this.name, s: this.me, host: this.isHost }, out }),
      });
      reply = await res.json();
      if (reply.error) throw new Error(reply.error);
    } catch {
      reply = null;
      this.out.unshift(...out);
      if (Date.now() - this.lastOk > GIVE_UP_MS) {
        this.close();
        return;
      }
    }
    if (reply) {
      this.lastOk = Date.now();
      this.since = reply.seq;
      // A message the game can't handle shouldn't look like a lost connection.
      try {
        this.receive(reply);
      } catch (e) {
        console.error('Multiplayer message failed', e);
      }
    }
    if (!this.closed) this.timer = setTimeout(() => this.poll(), Math.max(0, POLL_MS - (Date.now() - started)));
  }

  receive({ msgs, players }) {
    for (const m of msgs) this.message(m.from, m.d);
    if (this.joining || !this.net.game.world) return; // not in the world yet
    for (const d of this.held.splice(0)) this.emit(d);
    this.syncPlayers(players);
  }

  message(from, d) {
    if (!d || typeof d !== 'object') return;
    if (d.t === 'hello') {
      // A newcomer: the host sends them the world as it is now.
      if (this.isHost) this.sendSnapshot(from);
      return;
    }
    if (d.t === 'snap') {
      if (!this.joining) return;
      this.pieces ??= new Array(d.n).fill(null);
      this.pieces[d.i] = d.part;
      if (this.pieces.every((p) => p !== null)) this.finishJoin(from);
      return;
    }
    // Edits made while we were still joining may postdate the snapshot: keep them.
    if (this.joining || !this.net.game.world) {
      if (d.t === 'edit') this.held.push(d);
      return;
    }
    this.emit(d);
  }

  sendSnapshot(to) {
    const g = this.net.game;
    const world = {
      seed: g.world.seed, mode: g.player.mode, name: g.worldName ?? 'World', time: g.world.time,
      spawn: g.worldSpawn, mods: g.world.serialize().mods,
    };
    const text = JSON.stringify(world);
    const n = Math.max(1, Math.ceil(text.length / SNAPSHOT_PIECE));
    for (let i = 0; i < n; i++) this.post({ t: 'snap', i, n, part: text.slice(i * SNAPSHOT_PIECE, (i + 1) * SNAPSHOT_PIECE) }, to);
  }

  finishJoin(hostId) {
    clearTimeout(this.joining);
    this.joining = null;
    let world;
    try {
      world = JSON.parse(this.pieces.join(''));
    } catch {
      this.emit({ t: 'error', msg: 'The host’s world didn’t arrive in one piece. Try joining again.' });
      return;
    }
    this.pieces = null;
    this.hostId = hostId;
    this.emit({ t: 'welcome', id: this.id, code: this.room, hostId, world, edits: [], players: [] });
  }

  // Turn the relay's player list into join, move, leave and host-change messages.
  syncPlayers(players) {
    const present = new Set();
    for (const [id, p] of Object.entries(players ?? {})) {
      if (id === this.id) continue;
      present.add(id);
      if (!this.known.has(id)) this.emit({ t: 'join', id, name: p.name });
      const prev = this.known.get(id);
      if (!prev || prev.join() !== p.s.join()) this.emit({ t: 'move', id, s: p.s });
      this.known.set(id, p.s);
    }
    for (const id of [...this.known.keys()]) {
      if (present.has(id)) continue;
      const name = this.net.players.get(id)?.name ?? 'A player';
      this.known.delete(id);
      this.emit({ t: 'leave', id, name });
    }
    // If nobody is hosting any more, the lowest id takes over the clock.
    const hosts = Object.entries(players ?? {}).filter(([, p]) => p.host).map(([id]) => id);
    let host = hosts[0];
    if (!host) host = [...present, this.id].sort()[0];
    if (host !== this.hostId) {
      this.hostId = host;
      this.isHost = host === this.id;
      this.emit({ t: 'host', id: host });
    }
  }
}
