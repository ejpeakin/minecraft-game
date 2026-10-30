// Multiplayer through a free public MQTT broker (HiveMQ, or EMQX as a backup), for
// networks that block game servers but allow these. Like RelaySocket it behaves like
// the WebSocket to server.js (readyState, send, close, on* callbacks, same messages),
// so Net doesn't care which one it has, and the room logic the server would do runs
// here: everyone in a game subscribes to one topic, the host answers a newcomer's
// "hello" with the world, and positions double as "still here" signals.
//
// Anyone can read a public broker's topics, so nothing private goes through it: just
// player names, positions, block edits and chat.

// Public brokers. A game's code says which one it's on (see brokerForCode), so a
// friend always joins the host's broker even if theirs would pick the other.
export const PUBLIC_BROKERS = ['wss://broker.hivemq.com:8884/mqtt', 'wss://broker.emqx.io:8084/mqtt'];
const CODE_LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZ'; // no I or O, like server.js
const TOPIC = 'blockcraft/v1/';
const KEEPALIVE_S = 30;
const CONNECT_TIMEOUT_MS = 10000;
const JOIN_TIMEOUT_MS = 15000;
const HEARTBEAT_MS = 2000; // position resend while standing still or paused
const STALE_MS = 15000; // no word from a player for this long: they've left
const MAX_MESSAGE = 30000; // characters per message before it's split

export const isMqttUrl = (url) => url === 'mqtt' || /^wss?:\/\/[^?#]*\/mqtt$/i.test(url);

const newId = () => Math.random().toString(36).slice(2, 10);

// With the public brokers, the first letter of the code picks the broker: the first
// half of the alphabet for the first broker, the rest for the second.
const half = CODE_LETTERS.length / PUBLIC_BROKERS.length;
function newCode(broker) {
  const pick = (from, n) => CODE_LETTERS[from + Math.floor(Math.random() * n)];
  return pick(broker * half, half) + Array.from({ length: 3 }, () => pick(0, CODE_LETTERS.length)).join('');
}
function brokerForCode(code) {
  const i = CODE_LETTERS.indexOf(code[0]);
  return i < 0 ? 0 : Math.min(PUBLIC_BROKERS.length - 1, Math.floor(i / half));
}

// --- A minimal MQTT 3.1.1 client: connect, subscribe, publish at QoS 0, ping ----------

const enc = new TextEncoder();
const dec = new TextDecoder();

function mqttString(text) {
  const b = enc.encode(text);
  return [b.length >> 8, b.length & 255, ...b];
}

function packet(type, body) {
  const len = [];
  let n = body.length;
  do {
    let byte = n % 128;
    n = Math.floor(n / 128);
    if (n > 0) byte |= 128;
    len.push(byte);
  } while (n > 0);
  const out = new Uint8Array(1 + len.length + body.length);
  out[0] = type;
  out.set(len, 1);
  out.set(body, 1 + len.length);
  return out;
}

class Mqtt {
  // Resolves once the broker accepts the connection.
  constructor(url, { will, onMessage, onClose }) {
    this.onMessage = onMessage;
    this.onClose = onClose;
    this.buf = new Uint8Array(0);
    this.ready = new Promise((resolve, reject) => {
      const ws = new WebSocket(url, ['mqtt']);
      ws.binaryType = 'arraybuffer';
      this.ws = ws;
      const timer = setTimeout(() => { reject(new Error('timed out')); ws.close(); }, CONNECT_TIMEOUT_MS);
      this.connected = (ok) => {
        clearTimeout(timer);
        if (ok) resolve();
        else reject(new Error('refused'));
      };
      ws.onopen = () => {
        // Clean session, with a "last will" the broker sends if we vanish.
        const body = [...mqttString('MQTT'), 4, 0x02 | 0x04, 0, KEEPALIVE_S,
          ...mqttString(`bc${newId()}${newId()}`), ...mqttString(will.topic), ...mqttString(will.text)];
        ws.send(packet(0x10, body));
      };
      ws.onerror = () => this.connected(false);
      ws.onclose = () => {
        this.connected(false);
        clearInterval(this.pinger);
        this.onClose?.();
      };
      ws.onmessage = (e) => this.receive(new Uint8Array(e.data));
    });
    this.pinger = setInterval(() => this.raw(packet(0xc0, [])), (KEEPALIVE_S * 1000) / 2);
  }

  raw(bytes) {
    if (this.ws.readyState === 1) this.ws.send(bytes);
  }

  subscribe(topic) {
    this.raw(packet(0x82, [0, 1, ...mqttString(topic), 0]));
  }

  publish(topic, text) {
    const t = mqttString(topic);
    const p = enc.encode(text);
    const body = new Uint8Array(t.length + p.length);
    body.set(t);
    body.set(p, t.length);
    this.raw(packet(0x30, body));
  }

  close() {
    this.raw(packet(0xe0, []));
    clearInterval(this.pinger);
    this.onClose = null;
    this.ws.close();
  }

  // Packets can arrive split across WebSocket messages or several in one.
  receive(bytes) {
    const buf = new Uint8Array(this.buf.length + bytes.length);
    buf.set(this.buf);
    buf.set(bytes, this.buf.length);
    let at = 0;
    while (at + 2 <= buf.length) {
      let len = 0, mul = 1, i = at + 1, byte;
      do {
        if (i >= buf.length) break;
        byte = buf[i++];
        len += (byte & 127) * mul;
        mul *= 128;
      } while (byte & 128);
      if (byte & 128 || i + len > buf.length) break; // wait for the rest
      this.packet(buf[at], buf.subarray(i, i + len));
      at = i + len;
    }
    this.buf = buf.slice(at);
  }

  packet(type, body) {
    const kind = type >> 4;
    if (kind === 2) this.connected(body[1] === 0); // CONNACK
    else if (kind === 3) { // PUBLISH (QoS 0 only, as subscribed)
      const tl = (body[0] << 8) | body[1];
      const skip = 2 + tl + ((type >> 1) & 3 ? 2 : 0);
      this.onMessage(dec.decode(body.subarray(2, 2 + tl)), dec.decode(body.subarray(skip)));
    }
  }
}

// --- The game room on top of it -------------------------------------------------------

export class MqttSocket {
  constructor(url, net) {
    this.url = url;
    this.net = net;
    this.id = newId();
    this.name = 'Player';
    this.isHost = false;
    this.hostId = null;
    this.room = null;
    this.me = [0, -100, 0, 0, 0, 0];
    this.seen = new Map(); // id → { name, host, at } for everyone else in the game
    this.frags = new Map();
    this.fragId = 0;
    this.held = [];
    this.joining = null;
    this.closed = false;
    // The real connection waits for host or join, which say which broker to use.
    this.readyState = 1;
    setTimeout(() => this.onopen?.(), 0);
  }

  emit(msg) {
    this.onmessage?.({ data: JSON.stringify(msg) });
  }

  fail(text) {
    clearTimeout(this.joining);
    this.joining = null;
    this.emit({ t: 'error', msg: text });
  }

  async start(broker) {
    const topic = TOPIC + this.room;
    const bye = JSON.stringify({ f: this.id, d: { t: 'bye' } });
    this.mqtt = new Mqtt(broker, {
      will: { topic, text: bye },
      onMessage: (_, text) => this.incoming(text),
      onClose: () => this.close(),
    });
    await this.mqtt.ready;
    this.mqtt.subscribe(topic);
    this.heartbeat = setInterval(() => {
      this.sendPos();
      this.checkPlayers();
    }, HEARTBEAT_MS);
  }

  // The broker to use: a custom one from Options, or the public one the code names.
  brokers(code) {
    if (this.url !== 'mqtt') return [this.url];
    if (code) return [PUBLIC_BROKERS[brokerForCode(code)]];
    return PUBLIC_BROKERS;
  }

  post(d, to = null) {
    if (!this.mqtt) return;
    const text = JSON.stringify(d);
    const parts = [];
    if (text.length <= MAX_MESSAGE) parts.push(d);
    else {
      const k = ++this.fragId;
      const n = Math.ceil(text.length / MAX_MESSAGE);
      for (let i = 0; i < n; i++) parts.push({ t: 'frag', k, i, n, part: text.slice(i * MAX_MESSAGE, (i + 1) * MAX_MESSAGE) });
    }
    for (const p of parts) this.mqtt.publish(TOPIC + this.room, JSON.stringify(to ? { f: this.id, to, d: p } : { f: this.id, d: p }));
  }

  sendPos() {
    if (this.joining) return;
    this.post({ t: 'pos', s: this.me, name: this.name, host: this.isHost });
  }

  async send(text) {
    const msg = JSON.parse(text);
    switch (msg.t) {
      case 'host': {
        this.name = msg.name;
        this.isHost = true;
        this.hostId = this.id;
        // Try each broker; the code records which one answered.
        for (const broker of this.brokers()) {
          this.room = this.url === 'mqtt' ? newCode(PUBLIC_BROKERS.indexOf(broker)) : newCode(0);
          try {
            await this.start(broker);
            this.emit({ t: 'hosted', code: this.room, id: this.id });
            return;
          } catch {
            this.mqtt?.close();
            this.mqtt = null;
          }
        }
        this.fail('Couldn’t reach the multiplayer server. Check your internet connection and try again.');
        return;
      }
      case 'join': {
        this.name = msg.name;
        this.room = String(msg.code).toUpperCase().trim();
        try {
          await this.start(this.brokers(this.room)[0]);
        } catch {
          this.mqtt?.close();
          this.mqtt = null;
          this.fail('Couldn’t reach the multiplayer server. Check your internet connection and try again.');
          return;
        }
        this.waitForHost();
        this.post({ t: 'hello', name: this.name });
        this.net.game.ui.setMultiplayerStatus('Connected. Waiting for the host to send their world…');
        return;
      }
      case 'move':
        this.me = msg.s;
        this.sendPos();
        return;
      case 'edit':
        this.post({ t: 'edit', e: msg.e });
        return;
      case 'chat':
        this.post({ t: 'chat', id: this.id, name: this.name, text: String(msg.text).slice(0, 200) });
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
    this.joining = setTimeout(() => this.fail('No game with that code is running right now. Check the code, and make sure the host is in their world.'), JOIN_TIMEOUT_MS);
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.joining);
    clearInterval(this.heartbeat);
    if (this.mqtt) {
      this.post({ t: 'bye' });
      this.mqtt.close();
    }
    this.readyState = 3;
    this.onclose?.();
  }

  incoming(text) {
    let m;
    try {
      m = JSON.parse(text);
    } catch {
      return;
    }
    if (!m || m.f === this.id || (m.to && m.to !== this.id)) return;
    try {
      this.message(String(m.f), m.d);
    } catch (e) {
      console.error('Multiplayer message failed', e);
    }
  }

  message(from, d) {
    if (!d || typeof d !== 'object') return;
    if (d.t === 'frag') {
      const key = `${from}:${d.k}`;
      let parts = this.frags.get(key);
      if (!parts) this.frags.set(key, (parts = new Array(d.n).fill(null)));
      parts[d.i] = d.part;
      if (this.joining) this.waitForHost();
      if (parts.some((p) => p === null)) return;
      this.frags.delete(key);
      try {
        this.message(from, JSON.parse(parts.join('')));
      } catch {}
      return;
    }
    if (d.t === 'hello') {
      if (this.isHost) this.sendSnapshot(from);
      return;
    }
    if (d.t === 'snap') {
      if (this.joining) this.finishJoin(from, d.world);
      return;
    }
    if (this.joining || !this.net.game.world) {
      if (d.t === 'edit') this.held.push(d); // may postdate the snapshot: keep it
      return;
    }
    if (d.t === 'pos') {
      const known = this.seen.get(from);
      this.seen.set(from, { name: String(d.name ?? 'Player').slice(0, 16), host: !!d.host, at: Date.now() });
      if (!known) this.emit({ t: 'join', id: from, name: this.seen.get(from).name });
      if (Array.isArray(d.s) && d.s.length === 6) this.emit({ t: 'move', id: from, s: d.s });
      if (d.host && this.hostId !== from && !this.isHost) this.setHost(from);
      return;
    }
    if (d.t === 'bye') {
      this.drop(from);
      return;
    }
    this.emit(d);
  }

  sendSnapshot(to) {
    const g = this.net.game;
    const world = {
      seed: g.world.seed, gen: g.world.genVersion, mode: g.player.mode, name: g.worldName ?? 'World', time: g.world.time,
      spawn: g.worldSpawn, mods: g.world.serialize().mods,
    };
    this.post({ t: 'snap', world }, to);
  }

  finishJoin(hostId, world) {
    clearTimeout(this.joining);
    this.joining = null;
    this.hostId = hostId;
    this.emit({ t: 'welcome', id: this.id, code: this.room, hostId, world, edits: [], players: [] });
    // Edits made while the world was on its way, once it exists.
    const flush = () => {
      if (this.closed) return;
      if (!this.net.game.world) return setTimeout(flush, 100);
      for (const d of this.held.splice(0)) this.emit(d);
    };
    flush();
  }

  drop(id) {
    const p = this.seen.get(id);
    if (!p) return;
    this.seen.delete(id);
    this.emit({ t: 'leave', id, name: p.name });
    if (id === this.hostId) this.pickHost();
  }

  checkPlayers() {
    const now = Date.now();
    for (const [id, p] of this.seen) if (now - p.at > STALE_MS) this.drop(id);
  }

  // Nobody hosting any more: the lowest id takes over the clock.
  pickHost() {
    const host = [...this.seen].find(([, p]) => p.host)?.[0] ?? [...this.seen.keys(), this.id].sort()[0];
    this.setHost(host);
  }

  setHost(id) {
    this.hostId = id;
    this.isHost = id === this.id;
    this.emit({ t: 'host', id });
  }
}
