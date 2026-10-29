// Blockcraft server: serves the game files and runs multiplayer rooms over a
// WebSocket at /ws. `npm install` once (for the ws package), then `npm start`.
// Without ws installed it still serves the game, just without multiplayer.
//
// Rooms work like Minecraft's "Open to LAN": a player hosts one of their worlds,
// gets a four-letter code, and friends join with it. The server keeps the world's
// seed, the host's saved edits and every edit made since, and relays movement,
// block edits, chat, hits and explosions between the players in the room.
import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)));
const PORT = Number(process.env.PORT) || 8080;
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

const MAX_ROOMS = 100;
const MAX_PLAYERS = 8;
const MAX_EDITS_PER_MESSAGE = 4096;
const MAX_ROOM_EDITS = 400000;
const EMPTY_ROOM_TTL = 10 * 60 * 1000;
const CODE_LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZ'; // no I or O

const rooms = new Map();
let nextPlayerId = 1;

// --- Static files -------------------------------------------------------------------

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/health') {
      res.writeHead(200, { 'Content-Type': 'text/plain' }).end('ok');
      return;
    }
    const rel = decodeURIComponent(url.pathname);
    // Never serve dotfiles (.git) or installed packages.
    if (rel.split('/').some((part) => part.startsWith('.') || part === 'node_modules')) {
      res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found');
      return;
    }
    let path = normalize(join(ROOT, rel));
    if (path !== ROOT && !path.startsWith(ROOT + sep)) {
      res.writeHead(403).end('Forbidden');
      return;
    }
    if ((await stat(path).catch(() => null))?.isDirectory()) path = join(path, 'index.html');
    const body = await readFile(path);
    res.writeHead(200, { 'Content-Type': TYPES[extname(path)] ?? 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(body);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found');
  }
});

// --- Multiplayer ----------------------------------------------------------------------

const cleanName = (name) => String(name ?? '').replace(/[^\p{L}\p{N} _.-]/gu, '').trim().slice(0, 16) || 'Player';
const num = (v, lo, hi) => (Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : 0);
const int = (v, lo, hi) => (Number.isInteger(v) && v >= lo && v <= hi ? v : null);

function newCode() {
  for (let tries = 0; tries < 1000; tries++) {
    let code = '';
    for (let i = 0; i < 4; i++) code += CODE_LETTERS[Math.floor(Math.random() * CODE_LETTERS.length)];
    if (!rooms.has(code)) return code;
  }
  return null;
}

function send(ws, msg) {
  if (ws.readyState === 1) ws.send(JSON.stringify(msg));
}

function broadcast(room, msg, except = null) {
  const text = JSON.stringify(msg);
  for (const p of room.players.values()) if (p !== except && p.ws.readyState === 1) p.ws.send(text);
}

function playerList(room) {
  return [...room.players.values()].map((p) => ({ id: p.id, name: p.name, s: p.state }));
}

// The host's saved world: seed, mode, time, spawn and per-chunk edits (base64).
function cleanWorld(w) {
  if (!w || typeof w !== 'object') return null;
  const mods = {};
  for (const [key, text] of Object.entries(w.mods ?? {})) {
    if (/^-?\d+,-?\d+$/.test(key) && typeof text === 'string' && /^[A-Za-z0-9+/=]*$/.test(text)) mods[key] = text;
  }
  const spawn = w.spawn && { x: num(w.spawn.x, -3e7, 3e7), y: num(w.spawn.y, -64, 512), z: num(w.spawn.z, -3e7, 3e7) };
  return {
    seed: Number.isInteger(w.seed) ? w.seed : 0,
    mode: w.mode === 'creative' ? 'creative' : 'survival',
    name: String(w.name ?? 'World').slice(0, 32),
    time: num(w.time, 0, 24000),
    spawn,
    mods,
  };
}

function leave(player) {
  const room = player.room;
  if (!room) return;
  room.players.delete(player.id);
  player.room = null;
  broadcast(room, { t: 'leave', id: player.id, name: player.name });
  if (room.hostId === player.id && room.players.size) {
    room.hostId = room.players.keys().next().value;
    broadcast(room, { t: 'host', id: room.hostId });
  }
  if (!room.players.size) room.emptySince = Date.now();
}

function handle(player, msg) {
  const room = player.room;
  switch (msg.t) {
    case 'host': {
      if (room) return;
      const world = cleanWorld(msg.world);
      if (!world) return send(player.ws, { t: 'error', msg: 'That world could not be shared.' });
      if (rooms.size >= MAX_ROOMS) return send(player.ws, { t: 'error', msg: 'The server is full right now. Try again later.' });
      const code = newCode();
      const r = { code, world, edits: new Map(), players: new Map(), hostId: player.id, emptySince: 0 };
      rooms.set(code, r);
      player.name = cleanName(msg.name);
      player.room = r;
      r.players.set(player.id, player);
      send(player.ws, { t: 'hosted', code, id: player.id });
      return;
    }
    case 'join': {
      if (room) return;
      const r = rooms.get(String(msg.code ?? '').toUpperCase().trim());
      if (!r) return send(player.ws, { t: 'error', msg: 'No game with that code. Check the code with your friend.' });
      if (r.players.size >= MAX_PLAYERS) return send(player.ws, { t: 'error', msg: `That game is full (${MAX_PLAYERS} players).` });
      player.name = cleanName(msg.name);
      player.room = r;
      send(player.ws, {
        t: 'welcome', id: player.id, code: r.code, hostId: r.hostId, world: r.world,
        edits: [...r.edits].map(([k, id]) => [...k.split(',').map(Number), id]),
        players: playerList(r),
      });
      r.players.set(player.id, player);
      r.emptySince = 0;
      broadcast(r, { t: 'join', id: player.id, name: player.name }, player);
      return;
    }
    case 'move': {
      if (!room || !Array.isArray(msg.s) || msg.s.length !== 6) return;
      const [x, y, z, yaw, pitch, flags] = msg.s;
      player.state = [num(x, -3e7, 3e7), num(y, -256, 1024), num(z, -3e7, 3e7), num(yaw, -1e4, 1e4), num(pitch, -2, 2), int(flags, 0, 255) ?? 0];
      broadcast(room, { t: 'move', id: player.id, s: player.state }, player);
      return;
    }
    case 'edit': {
      if (!room || !Array.isArray(msg.e) || msg.e.length > MAX_EDITS_PER_MESSAGE) return;
      const edits = [];
      for (const e of msg.e) {
        if (!Array.isArray(e) || e.length !== 4) continue;
        const [x, y, z, id] = [int(e[0], -3e7, 3e7), int(e[1], 0, 127), int(e[2], -3e7, 3e7), int(e[3], 0, 65535)];
        if (x === null || y === null || z === null || id === null) continue;
        if (room.edits.size < MAX_ROOM_EDITS || room.edits.has(`${x},${y},${z}`)) room.edits.set(`${x},${y},${z}`, id);
        edits.push([x, y, z, id]);
      }
      if (edits.length) broadcast(room, { t: 'edit', e: edits }, player);
      return;
    }
    case 'chat': {
      const text = String(msg.text ?? '').trim().slice(0, 200);
      if (room && text) broadcast(room, { t: 'chat', id: player.id, name: player.name, text }, player);
      return;
    }
    case 'hit': {
      const target = room?.players.get(msg.target);
      if (target && target !== player) send(target.ws, { t: 'hit', from: player.id, name: player.name, dmg: num(msg.dmg, 0, 20), x: num(msg.x, -3e7, 3e7), z: num(msg.z, -3e7, 3e7) });
      return;
    }
    case 'boom': {
      if (room) broadcast(room, { t: 'boom', x: num(msg.x, -3e7, 3e7), y: num(msg.y, -64, 512), z: num(msg.z, -3e7, 3e7), power: num(msg.power, 0, 6) }, player);
      return;
    }
    case 'time': {
      if (room && room.hostId === player.id) {
        room.world.time = num(msg.time, 0, 24000);
        broadcast(room, { t: 'time', time: room.world.time }, player);
      }
      return;
    }
    default:
  }
}

async function startMultiplayer() {
  let WebSocketServer;
  try {
    ({ WebSocketServer } = await import('ws'));
  } catch {
    console.log('Multiplayer is off: run `npm install` to add the ws package.');
    return;
  }
  const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 16 * 1024 * 1024 });
  wss.on('connection', (ws) => {
    const player = { id: nextPlayerId++, ws, name: 'Player', room: null, state: [0, 0, 0, 0, 0, 0] };
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });
    ws.on('message', (data) => {
      let msg;
      try {
        msg = JSON.parse(data);
      } catch {
        return;
      }
      if (msg && typeof msg === 'object') handle(player, msg);
    });
    ws.on('close', () => leave(player));
    send(ws, { t: 'hello', maxPlayers: MAX_PLAYERS });
  });
  // Drop dead connections and rooms that have been empty for a while.
  setInterval(() => {
    for (const ws of wss.clients) {
      if (!ws.isAlive) {
        ws.terminate();
        continue;
      }
      ws.isAlive = false;
      ws.ping();
    }
    for (const [code, r] of rooms) if (!r.players.size && Date.now() - r.emptySince > EMPTY_ROOM_TTL) rooms.delete(code);
  }, 30000);
  console.log('Multiplayer rooms are on at /ws');
}

await startMultiplayer();
server.listen(PORT, () => {
  console.log(`Blockcraft running at http://localhost:${PORT}`);
});
