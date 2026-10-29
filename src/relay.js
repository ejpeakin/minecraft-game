// Multiplayer through the Google Apps Script relay (relay/Code.gs), for networks
// that block game servers. It behaves like the WebSocket to server.js (same
// readyState, send, close and on* callbacks, same messages in and out), so Net
// doesn't care which one it has. The room logic the server would do runs here:
// the host answers a newcomer's "hello" with a snapshot of the world, positions
// travel in the relay's player list, and everything else is a posted message.
//
// Three ways to reach the script:
// - fetch, when it's deployed for "Anyone";
// - the bridge, when it only lets in people from one school: school Chromebooks don't
//   send the player's Google sign-in to other sites, so a tab of the script's own page
//   (signed in) passes our requests on. The game opens it as a pop-up, or the player
//   opens it and starts the game from its Play button;
// - JSONP (script tags), which carries the sign-in where third-party cookies are
//   allowed. It sends data in the URL, so requests stay small and big messages (the
//   world, large edits) go in fragments.

const POLL_MS = 400; // aim for about 2.5 check-ins a second
const GIVE_UP_MS = 30000; // close after this long without a successful check-in
const JOIN_TIMEOUT_MS = 60000;
const MAX_MESSAGE = { fetch: 60000, bridge: 60000, jsonp: 1000 }; // characters per message before it's split
const MAX_REQUEST = 6000; // URL-encoded characters per JSONP request
const REQUEST_TIMEOUT_MS = 15000;

const newId = () => Math.random().toString(36).slice(2, 10);
const newCode = () => Array.from({ length: 4 }, () => 'ABCDEFGHJKLMNPQRSTUVWXYZ'[Math.floor(Math.random() * 24)]).join('');

const BRIDGE_WAIT_MS = 20000; // time to sign in and load the pop-up

let callbacks = 0;

// The bridge tab, once it has said hello: its window and origin, plus calls in flight.
const bridge = { win: null, origin: '*', popup: null, waiters: [], calls: new Map(), n: 0 };

window.addEventListener('message', (e) => {
  const d = e.data;
  if (!d || typeof d !== 'object' || !d.blockcraft) return;
  // Only the page that opened this one, or the pop-up we opened (the script's page sits
  // in a frame inside it).
  let ours = e.source === window.opener;
  try {
    ours ||= !!bridge.popup && e.source?.top === bridge.popup;
  } catch {}
  if (!ours && e.source !== bridge.win) return;
  if (d.blockcraft === 'bridge') {
    if (bridge.win === e.source) return; // already introduced
    bridge.win = e.source;
    bridge.origin = e.origin;
    e.source.postMessage({ blockcraft: 'hello' }, e.origin); // lets the page show "Connected"
    for (const w of bridge.waiters.splice(0)) w(true);
  } else if (d.blockcraft === 'reply') {
    bridge.calls.get(d.n)?.(d);
  }
});

const bridgeOpen = () => !!bridge.win && !bridge.win.closed;

// Wait up to ms for the bridge to say hello.
function waitForBridge(ms) {
  if (bridgeOpen()) return Promise.resolve(true);
  return new Promise((resolve) => {
    const done = (ok) => {
      clearTimeout(timer);
      bridge.waiters = bridge.waiters.filter((w) => w !== done);
      resolve(ok);
    };
    const timer = setTimeout(() => done(false), ms);
    bridge.waiters.push(done);
  });
}

// One request through the bridge: it calls relay() in the script and sends back the reply.
function bridgeCall(body) {
  return new Promise((resolve, reject) => {
    if (!bridgeOpen()) return reject(new Error('bridge closed'));
    const n = ++bridge.n;
    const finish = (d) => {
      clearTimeout(timer);
      bridge.calls.delete(n);
      if (d.error) reject(new Error(d.error));
      else resolve(JSON.parse(d.body));
    };
    const timer = setTimeout(() => finish({ error: 'timed out' }), REQUEST_TIMEOUT_MS);
    bridge.calls.set(n, finish);
    bridge.win.postMessage({ blockcraft: 'call', n, body }, bridge.origin);
  });
}

// Started by the game from the script's page: ask it to introduce itself.
if (window.opener) {
  try {
    window.opener.postMessage({ blockcraft: 'hello' }, '*');
  } catch {}
}

// One JSONP call: load url?cb=…&q=… as a script and wait for it to call back.
function jsonp(url, query) {
  return new Promise((resolve, reject) => {
    const cb = `__blockcraftRelay${++callbacks}`;
    const tag = document.createElement('script');
    const done = (err, value) => {
      clearTimeout(timer);
      window[cb] = () => {}; // a late answer after a timeout lands here harmlessly
      tag.remove();
      if (err) reject(err);
      else resolve(value);
    };
    const timer = setTimeout(() => done(new Error('timed out')), REQUEST_TIMEOUT_MS);
    window[cb] = (value) => done(null, value);
    tag.onerror = () => done(new Error('failed'));
    tag.src = `${url}${url.includes('?') ? '&' : '?'}cb=${cb}${query ? `&q=${query}` : ''}`;
    document.head.append(tag);
  });
}

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
    this.frags = new Map(); // pieces of split messages, by sender and message
    this.fragId = 0;
    this.mode = null; // 'fetch' or 'jsonp', whichever answered
    this.joining = null;
    this.held = []; // messages that arrive before our world exists
    this.lastOk = Date.now();
    this.closed = false;
    this.handshake();
  }

  // Confirm the relay answers before reporting "open", like a WebSocket handshake.
  async handshake() {
    const isRelay = (j) => j?.app === 'blockcraft-relay';
    const ping = `${this.url}${this.url.includes('?') ? '&' : '?'}ping=1`;
    const tries = {
      fetch: async () => isRelay(await fetch(ping).then((r) => r.json())),
      jsonp: async () => isRelay(await jsonp(this.url)),
      bridge: () => this.openBridge(),
    };
    // A school (/a/macros/…) link needs the sign-in, so it goes through the bridge.
    const order = this.url.includes('/a/macros/') ? ['bridge', 'jsonp'] : ['fetch', 'jsonp'];
    for (const mode of order) {
      try {
        if (await tries[mode]()) {
          this.mode = mode;
          break;
        }
      } catch {}
    }
    if (this.closed) return;
    if (!this.mode) {
      this.failReason = bridge.popup && !bridge.popup.closed
        ? 'Couldn\u2019t connect through the school server window. In that window, click Play Blockcraft and use the game tab it opens.'
        : 'Couldn\u2019t reach the school server. Allow pop-ups for this site and try again, or open the server link in a new tab and click Play Blockcraft there. Be signed in to your school Google account, and make sure the script has the latest relay/Code.gs.';
      this.readyState = 3;
      this.onerror?.();
      return;
    }
    this.readyState = 1;
    this.onopen?.();
  }

  // Use the bridge tab, opening the script's page as a pop-up if there isn't one yet.
  async openBridge() {
    if (await waitForBridge(window.opener ? 1500 : 0)) return true;
    if (!bridge.popup || bridge.popup.closed) {
      bridge.popup = window.open(this.url, 'blockcraft-server', 'popup,width=480,height=420');
      if (!bridge.popup) return false; // pop-up blocked
      this.net.game.ui.setMultiplayerStatus('Opening the school server window\u2026 You can go back to the game once it says Connected.');
    }
    const ok = await waitForBridge(BRIDGE_WAIT_MS);
    if (ok) window.focus();
    return ok;
  }

  emit(msg) {
    this.onmessage?.({ data: JSON.stringify(msg) });
  }

  // Queue a message for the next check-in, split into fragments if it's too big for one.
  post(d, to = null) {
    const text = JSON.stringify(d);
    const max = MAX_MESSAGE[this.mode ?? 'fetch'];
    if (text.length <= max) {
      this.out.push(to ? { to, d } : { d });
      return;
    }
    const k = ++this.fragId;
    const n = Math.ceil(text.length / max);
    for (let i = 0; i < n; i++) {
      const f = { t: 'frag', k, i, n, part: text.slice(i * max, (i + 1) * max) };
      this.out.push(to ? { to, d: f } : { d: f });
    }
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
        this.waitForHost();
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

  // (Re)start the clock on joining; it restarts whenever part of the world arrives.
  waitForHost() {
    clearTimeout(this.joining);
    this.joining = setTimeout(() => {
      this.joining = null;
      this.emit({ t: 'error', msg: 'No game with that code is running right now. Check the code, and make sure the host is in their world.' });
    }, JOIN_TIMEOUT_MS);
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.timer);
    clearTimeout(this.joining);
    if (this.room && this.readyState === 1) {
      const bye = JSON.stringify({ room: this.room, id: this.id, bye: true });
      if (this.mode === 'jsonp') jsonp(this.url, encodeURIComponent(bye)).catch(() => {});
      else if (this.mode === 'bridge') bridgeCall(bye).catch(() => {});
      else fetch(this.url, { method: 'POST', body: bye, headers: { 'Content-Type': 'text/plain' } }).catch(() => {});
    }
    this.readyState = 3;
    this.onclose?.();
  }

  async poll() {
    if (this.closed) return;
    clearTimeout(this.timer);
    const started = Date.now();
    const req = { room: this.room, id: this.id, since: this.since, me: { name: this.name, s: this.me, host: this.isHost }, out: [] };
    let query = '';
    if (this.mode === 'jsonp') {
      // Take as many messages as fit in one URL (always at least one).
      let size = encodeURIComponent(JSON.stringify(req)).length;
      while (this.out.length && req.out.length < 60) {
        const add = encodeURIComponent(JSON.stringify(this.out[0])).length + 3;
        if (req.out.length && size + add > MAX_REQUEST) break;
        req.out.push(this.out.shift());
        size += add;
      }
      query = encodeURIComponent(JSON.stringify(req));
    } else {
      req.out = this.out.splice(0, 60);
    }
    const out = req.out;
    let reply = null;
    try {
      if (this.mode === 'jsonp') {
        reply = await jsonp(this.url, query);
      } else if (this.mode === 'bridge') {
        reply = await bridgeCall(JSON.stringify(req));
      } else {
        const res = await fetch(this.url, {
          method: 'POST',
          // text/plain keeps this a "simple" request, which Apps Script accepts cross-site.
          headers: { 'Content-Type': 'text/plain' },
          body: JSON.stringify(req),
        });
        reply = await res.json();
      }
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
    // More waiting to go out (a world being sent): check in again straight away.
    const wait = reply && this.out.length ? 0 : Math.max(0, POLL_MS - (Date.now() - started));
    if (!this.closed) this.timer = setTimeout(() => this.poll(), wait);
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
    if (d.t === 'frag') {
      const key = `${from}:${d.k}`;
      let parts = this.frags.get(key);
      if (!parts) this.frags.set(key, (parts = new Array(d.n).fill(null)));
      parts[d.i] = d.part;
      if (this.joining) this.waitForHost(); // still arriving: keep waiting
      if (parts.some((p) => p === null)) return;
      this.frags.delete(key);
      let whole;
      try {
        whole = JSON.parse(parts.join(''));
      } catch {
        return;
      }
      this.message(from, whole);
      return;
    }
    if (d.t === 'snap') {
      if (this.joining) this.finishJoin(from, d.world);
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
    this.post({ t: 'snap', world }, to);
  }

  finishJoin(hostId, world) {
    clearTimeout(this.joining);
    this.joining = null;
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
