// Multiplayer client. Talks to the room server in server.js over a WebSocket:
// sends this player's position, the block edits they make and chat; draws the
// other players as figures with name tags and applies their edits to the world.
import * as THREE from './three.js';
import { buildFigure } from './entities.js';
import { RelaySocket, isRelayUrl } from './relay.js';

const SEND_INTERVAL = 0.1; // seconds between position updates
const TIME_INTERVAL = 5; // seconds between the host's clock broadcasts

// Movement flags packed into one number.
const F_SNEAK = 1, F_SWING = 2, F_FLY = 4;

function nameTag(text) {
  const c = document.createElement('canvas');
  const ctx = c.getContext('2d');
  ctx.font = '28px VT323, monospace';
  const w = Math.ceil(ctx.measureText(text).width) + 16;
  c.width = w;
  c.height = 36;
  ctx.font = '28px VT323, monospace';
  ctx.fillStyle = 'rgba(0, 0, 0, 0.45)';
  ctx.fillRect(0, 0, w, 36);
  ctx.fillStyle = '#fff';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, 8, 19);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthWrite: false }));
  sprite.scale.set((w / 36) * 0.32, 0.32, 1);
  sprite.position.y = 2.15;
  return sprite;
}

// Another player as seen on this screen. Positions arrive ten times a second; the
// figure glides toward the latest one so movement looks smooth.
class RemotePlayer {
  constructor(game, id, name, state) {
    this.game = game;
    this.id = id;
    this.name = name;
    this.w = 0.6;
    this.h = 1.8;
    Object.assign(this, buildFigure('player'));
    this.tag = nameTag(name);
    this.mesh.add(this.tag);
    game.scene.add(this.mesh);
    this.target = state ?? [0, -100, 0, 0, 0, 0];
    [this.x, this.y, this.z, this.yaw, this.pitch] = this.target;
    this.walk = 0;
    this.swing = 0;
  }

  setState(s) {
    this.target = s;
    if (s[5] & F_SWING) this.swing = 1;
  }

  // Called when this player hits them; the server passes it on to their screen.
  damage(dmg, fromX, fromZ) {
    this.game.net.send({ t: 'hit', target: this.id, dmg, x: fromX, z: fromZ });
    this.hurt = 0.35;
    return true;
  }

  update(dt) {
    const [tx, ty, tz, tyaw, tpitch, flags] = this.target;
    const k = Math.min(1, dt * 12);
    const ox = this.x, oz = this.z;
    if (Math.hypot(tx - this.x, ty - this.y, tz - this.z) > 8) {
      this.x = tx; this.y = ty; this.z = tz;
    } else {
      this.x += (tx - this.x) * k;
      this.y += (ty - this.y) * k;
      this.z += (tz - this.z) * k;
    }
    let dyaw = tyaw - this.yaw;
    dyaw = Math.atan2(Math.sin(dyaw), Math.cos(dyaw));
    this.yaw += dyaw * k;
    this.pitch += (tpitch - this.pitch) * k;
    const speed = Math.hypot(this.x - ox, this.z - oz) / Math.max(dt, 1e-3);
    this.walk += speed * dt * 2.2;
    this.swing = Math.max(0, this.swing - dt * 3.5);
    this.hurt = Math.max(0, (this.hurt ?? 0) - dt);
    const legs = Math.sin(this.walk) * Math.min(1, speed / 3) * 0.8;
    const sneak = flags & F_SNEAK;
    for (const { spec, pivot } of this.parts) {
      if (spec.leg !== undefined) pivot.rotation.x = spec.leg ? legs : -legs;
      if (spec.swing !== undefined) pivot.rotation.x = (spec.swing ? -legs : legs) * 0.7 - (spec.swing && this.swing > 0 ? Math.sin(this.swing * Math.PI) * 1.4 : 0);
      if (spec.name === 'head') pivot.rotation.x = -this.pitch;
      if (spec.name === 'body') pivot.rotation.x = sneak ? 0.35 : 0;
    }
    // The model faces +z; this player's yaw faces -z at 0.
    this.mesh.position.set(this.x, this.y - (sneak ? 0.15 : 0), this.z);
    this.mesh.rotation.y = this.yaw + Math.PI;
    this.game.entities.applyLight(this.mesh, this.x, this.y + 1.5, this.z);
    if (this.hurt > 0) this.material.color.setRGB(1, 0.35, 0.35);
    this.tag.material.color.setScalar(1);
  }

  dispose() {
    this.game.scene.remove(this.mesh);
    this.material.dispose();
    this.tag.material.map.dispose();
    this.tag.material.dispose();
  }
}

export class Net {
  constructor(game) {
    this.game = game;
    this.ws = null;
    this.players = new Map();
    this.code = null;
    this.id = null;
    this.hostId = null;
    this.sendTimer = 0;
    this.timeTimer = 0;
    this.pending = null; // resolver waiting for the server's next answer
  }

  get active() {
    return !!this.code && this.ws?.readyState === 1;
  }

  get isHost() {
    return this.active && this.hostId === this.id;
  }

  // Where the room server lives: Options → Server address, or the page's own server.
  serverUrl() {
    let base = String(this.game.settings.serverUrl ?? '').trim();
    if (!base) {
      if (/\.github\.io$|claude\.ai$|claudeusercontent/.test(location.hostname) || location.protocol === 'file:') return null;
      base = location.origin;
    }
    if (!/^[a-z]+:\/\//i.test(base)) base = `https://${base}`;
    if (isRelayUrl(base)) return base; // Google Apps Script relay: plain HTTPS
    const url = new URL(base);
    url.protocol = url.protocol === 'http:' || url.protocol === 'ws:' ? 'ws:' : 'wss:';
    url.pathname = '/ws';
    url.search = '';
    return url.toString();
  }

  connect() {
    const url = this.serverUrl();
    if (!url) {
      return Promise.reject(new Error('Multiplayer needs a server. Paste your Apps Script link (or Render address) into the Server address box.'));
    }
    this.leave();
    return new Promise((resolve, reject) => {
      let settled = false;
      const ws = isRelayUrl(url) ? new RelaySocket(url, this) : new WebSocket(url);
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        ws.close();
        reject(new Error('The server didn’t answer. Check the address, or wait a minute if it was asleep, and try again.'));
      }, 70000);
      ws.onopen = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.ws = ws;
        resolve();
      };
      ws.onerror = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(new Error('Couldn’t reach the server. Check the address and try again.'));
      };
      ws.onmessage = (e) => {
        let msg;
        try {
          msg = JSON.parse(e.data);
        } catch {
          return;
        }
        this.handle(msg);
      };
      ws.onclose = () => {
        if (this.ws !== ws) return;
        const wasActive = !!this.code;
        this.ws = null;
        this.code = null;
        this.clearPlayers();
        this.game.ui.updateRoomBadge();
        if (wasActive) this.game.onDisconnected();
      };
    });
  }

  // Wait for the server's reply to a host or join request.
  request(msg) {
    return new Promise((resolve, reject) => {
      this.pending = { resolve, reject };
      this.send(msg, true);
    });
  }

  send(msg, force = false) {
    if ((force || this.active) && this.ws?.readyState === 1) this.ws.send(JSON.stringify(msg));
  }

  async host(world) {
    const reply = await this.request({ t: 'host', name: this.game.settings.playerName, world });
    this.code = reply.code;
    this.id = reply.id;
    this.hostId = reply.id;
    this.game.ui.updateRoomBadge();
    return reply.code;
  }

  async join(code) {
    const reply = await this.request({ t: 'join', code, name: this.game.settings.playerName });
    this.code = reply.code;
    this.id = reply.id;
    this.hostId = reply.hostId;
    return reply;
  }

  // Bring remote players in once the world exists (joining) or right away (hosting).
  addPlayers(list) {
    for (const p of list) if (p.id !== this.id) this.players.set(p.id, new RemotePlayer(this.game, p.id, p.name, p.s));
    this.game.ui.updateRoomBadge();
  }

  clearPlayers() {
    for (const p of this.players.values()) p.dispose();
    this.players.clear();
  }

  leave() {
    const ws = this.ws;
    this.ws = null;
    this.code = null;
    this.clearPlayers();
    if (ws) ws.close();
    this.game.ui?.updateRoomBadge();
  }

  // Run fn and send any blocks it changed to the other players.
  capture(fn) {
    const world = this.game.world;
    if (!this.active || !world || world.capture) return fn();
    world.capture = [];
    try {
      return fn();
    } finally {
      const edits = world.capture;
      world.capture = null;
      for (let i = 0; i < edits.length; i += 4000) this.send({ t: 'edit', e: edits.slice(i, i + 4000) });
    }
  }

  handle(msg) {
    const game = this.game;
    switch (msg.t) {
      case 'hosted':
      case 'welcome':
        this.pending?.resolve(msg);
        this.pending = null;
        return;
      case 'error':
        this.pending?.reject(new Error(msg.msg));
        this.pending = null;
        return;
      case 'join':
        if (msg.id === this.id || !game.world) return;
        this.players.set(msg.id, new RemotePlayer(game, msg.id, msg.name, null));
        game.ui.chatLine(`${msg.name} joined the game`, 'system');
        game.ui.updateRoomBadge();
        return;
      case 'leave': {
        const p = this.players.get(msg.id);
        if (p) p.dispose();
        this.players.delete(msg.id);
        game.ui.chatLine(`${msg.name} left the game`, 'system');
        game.ui.updateRoomBadge();
        return;
      }
      case 'host':
        this.hostId = msg.id;
        if (this.isHost) game.ui.chatLine('You are now the host: the world’s clock follows you.', 'system');
        game.ui.updateRoomBadge();
        return;
      case 'move':
        this.players.get(msg.id)?.setState(msg.s);
        return;
      case 'edit':
        game.world?.applyRemoteEdits(msg.e);
        return;
      case 'chat':
        game.ui.chatLine(`<${msg.name}> ${msg.text}`);
        return;
      case 'hit':
        game.player.damage(msg.dmg, { x: msg.x, z: msg.z, cause: 'player', by: msg.name });
        return;
      case 'boom':
        game.entities.explode(msg.x, msg.y, msg.z, msg.power, { remote: true });
        return;
      case 'time':
        if (game.world && !this.isHost) game.world.time = msg.time;
        return;
      default:
    }
  }

  chat(text) {
    text = text.trim().slice(0, 200);
    if (!text) return;
    this.send({ t: 'chat', text });
    this.game.ui.chatLine(`<${this.game.settings.playerName}> ${text}`);
  }

  update(dt) {
    if (!this.active) return;
    const p = this.game.player;
    this.sendTimer -= dt;
    if (this.sendTimer <= 0) {
      this.sendTimer = SEND_INTERVAL;
      const flags = (p.sneaking ? F_SNEAK : 0) | (p.swing > 0.5 ? F_SWING : 0) | (p.flying ? F_FLY : 0);
      this.send({ t: 'move', s: [+p.x.toFixed(3), +p.y.toFixed(3), +p.z.toFixed(3), +p.yaw.toFixed(3), +p.pitch.toFixed(3), flags] });
    }
    if (this.isHost) {
      this.timeTimer -= dt;
      if (this.timeTimer <= 0) {
        this.timeTimer = TIME_INTERVAL;
        this.send({ t: 'time', time: this.game.world.time });
      }
    }
    for (const rp of this.players.values()) rp.update(dt);
  }

  // Other players, as things this player can aim at and hit.
  targets() {
    return this.active ? [...this.players.values()] : [];
  }
}
