// Blockcraft multiplayer relay for Google Apps Script.
//
// For networks that block game servers (school Chromebooks): Google Apps Script runs
// on Google's own servers, so it's usually reachable when nothing else is. Setup is in
// the README ("Multiplayer at school"): paste this file into a new Apps Script
// project, deploy it as a web app, and paste the /exec link into Blockcraft's
// Multiplayer → Server address box.
//
// It's a small message board per game code. Every player calls it about twice a
// second with their position and any messages to send (block edits, chat, hits),
// and gets back everyone else's positions plus the messages posted since last time.
// Nothing is kept for long: messages expire after 10 minutes, games after 6 hours.

var MESSAGE_TTL = 600; // seconds
var ROOM_TTL = 21600; // seconds (the cache maximum)
var STALE_PLAYER_MS = 20000;
var MAX_OUT = 60;
var MAX_BACKLOG = 200;

// Where the game lives. The script's own page (open the /exec link) has a Play button
// that opens it.
var GAME_URL = 'https://ejpeakin.github.io/minecraft-game/';

function doGet(e) {
  var p = (e && e.parameter) || {};
  if (!p.q && !p.cb && !p.ping) {
    return HtmlService.createHtmlOutput(PAGE.join('\n').replace('%GAME_URL%', JSON.stringify(GAME_URL)))
      .setTitle('Blockcraft school server')
      .addMetaTag('viewport', 'width=device-width, initial-scale=1');
  }
  var reply = p.q ? handle(p.q) : { ok: true, app: 'blockcraft-relay' };
  // With ?cb=name the reply comes back as a script (JSONP), which carries the player's
  // Google sign-in where the browser allows third-party cookies.
  if (/^[A-Za-z_$][\w$]{0,40}$/.test(String(p.cb || ''))) {
    return ContentService.createTextOutput(p.cb + '(' + JSON.stringify(reply) + ')').setMimeType(ContentService.MimeType.JAVASCRIPT);
  }
  return json(reply);
}

function doPost(e) {
  return json(handle(e && e.postData ? e.postData.contents : ''));
}

// Called from the page below through google.script.run.
function relay(text) {
  return JSON.stringify(handle(text));
}

// The script's own page. A script shared only within a school needs the player's
// Google sign-in, and school Chromebooks don't send it to other sites. This page is
// signed in, so it acts as a bridge: the game talks to it with postMessage and it
// calls relay() for the game. It works whichever opened the other: the game opens it
// as a pop-up, or its Play button opens the game.
var PAGE = [
  '<!doctype html>',
  '<meta charset="utf-8">',
  '<style>',
  'body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #2b2118; color: #eee; font: 18px/1.4 system-ui, sans-serif; text-align: center; }',
  'main { padding: 24px; max-width: 420px; }',
  'h1 { font-size: 22px; margin: 0 0 8px; }',
  'button { font: inherit; font-weight: 600; padding: 10px 28px; border: 2px solid #000; background: #6c9b3c; color: #fff; cursor: pointer; }',
  'p { color: #cfc6b8; }',
  '</style>',
  '<main>',
  '<h1>Blockcraft school server</h1>',
  '<p id="status">Click Play to open the game. Keep this tab open while you play: multiplayer goes through it.</p>',
  '<button id="play">Play Blockcraft</button>',
  '</main>',
  '<script>',
  'var GAME_URL = %GAME_URL%;',
  'var peers = [];',
  'var note = document.getElementById("status");',
  'var play = document.getElementById("play");',
  'function connected() {',
  '  note.textContent = "Connected to the game. Go back to the game’s tab and keep this one open while you play.";',
  '  play.hidden = true;',
  '}',
  'function findOpener() { try { return window.top.opener; } catch (err) { return null; } }',
  'window.addEventListener("message", function (e) {',
  '  var d = e.data;',
  '  if (!d || typeof d !== "object" || !d.blockcraft || peers.indexOf(e.source) < 0) return;',
  '  if (d.blockcraft === "hello") {',
  '    e.source.postMessage({ blockcraft: "bridge" }, e.origin);',
  '    connected();',
  '  } else if (d.blockcraft === "call") {',
  '    google.script.run',
  '      .withSuccessHandler(function (body) { e.source.postMessage({ blockcraft: "reply", n: d.n, body: body }, e.origin); })',
  '      .withFailureHandler(function (err) { e.source.postMessage({ blockcraft: "reply", n: d.n, error: String((err && err.message) || err) }, e.origin); })',
  '      .relay(String(d.body));',
  '  }',
  '});',
  '// Opened by the game as a pop-up: say hello.',
  'var op = findOpener();',
  'if (op) {',
  '  peers.push(op);',
  '  op.postMessage({ blockcraft: "bridge" }, "*");',
  '  note.textContent = "Connecting to the game…";',
  '}',
  'play.onclick = function () {',
  '  var w = window.open(GAME_URL, "_blank");',
  '  if (w) peers.push(w);',
  '  note.textContent = "The game opened in a new tab. Keep this tab open while you play.";',
  '};',
  '</script>',
];

function handle(text) {
  var req;
  try {
    req = JSON.parse(text);
  } catch (err) {
    return { error: 'bad request' };
  }
  var room = String(req.room || '').replace(/[^A-Z]/g, '').slice(0, 8);
  var id = String(req.id || '').replace(/[^0-9a-z]/gi, '').slice(0, 16);
  if (!room || !id) return { error: 'missing room or id' };

  var cache = CacheService.getScriptCache();
  var R = 'r:' + room + ':';
  var lock = LockService.getScriptLock();
  var seq, players;
  lock.waitLock(10000);
  try {
    seq = Number(cache.get(R + 'seq') || 0);
    var messages = {};
    var out = Array.isArray(req.out) ? req.out.slice(0, MAX_OUT) : [];
    for (var i = 0; i < out.length; i++) {
      seq++;
      messages[R + 'm' + seq] = JSON.stringify({ s: seq, from: id, to: out[i].to ? String(out[i].to) : null, d: out[i].d });
    }
    if (out.length) cache.putAll(messages, MESSAGE_TTL);

    players = JSON.parse(cache.get(R + 'p') || '{}');
    var now = Date.now();
    if (req.bye) delete players[id];
    else if (req.me) {
      players[id] = {
        name: String(req.me.name || 'Player').slice(0, 16),
        s: Array.isArray(req.me.s) ? req.me.s.slice(0, 6) : [0, 0, 0, 0, 0, 0],
        host: !!req.me.host,
        t: now,
      };
    }
    for (var k in players) if (now - players[k].t > STALE_PLAYER_MS) delete players[k];
    cache.put(R + 'seq', String(seq), ROOM_TTL);
    cache.put(R + 'p', JSON.stringify(players), ROOM_TTL);
  } finally {
    lock.releaseLock();
  }

  // Messages after `since` (a negative since means "just tell me where we are").
  var since = Number(req.since);
  if (!(since >= 0)) since = seq;
  since = Math.max(since, seq - MAX_BACKLOG);
  var keys = [];
  for (var n = since + 1; n <= seq; n++) keys.push(R + 'm' + n);
  var got = keys.length ? cache.getAll(keys) : {};
  var msgs = [];
  for (var j = 0; j < keys.length; j++) {
    if (!got[keys[j]]) continue;
    var m = JSON.parse(got[keys[j]]);
    if (m.from !== id && (!m.to || m.to === id)) msgs.push(m);
  }
  return { seq: seq, msgs: msgs, players: players };
}

function json(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
