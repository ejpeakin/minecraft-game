// Blockcraft multiplayer relay for Google Apps Script.
//
// For networks that block game servers (school Chromebooks): Google Apps Script runs
// on Google's own servers, so it's usually reachable when nothing else is. Setup is in
// the README ("Multiplayer at school"): paste this file into a new Apps Script
// project, deploy it as a web app that anyone can access, and paste the /exec link
// into Blockcraft's Multiplayer → Server address box.
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

function doGet(e) {
  var p = (e && e.parameter) || {};
  var reply = p.q ? handle(p.q) : { ok: true, app: 'blockcraft-relay' };
  // With ?cb=name the reply comes back as a script (JSONP). The game uses that when the
  // script only lets in people from your school: a script tag carries the player's
  // Google sign-in, a plain fetch from another site doesn't.
  if (/^[A-Za-z_$][\w$]{0,40}$/.test(String(p.cb || ''))) {
    return ContentService.createTextOutput(p.cb + '(' + JSON.stringify(reply) + ')').setMimeType(ContentService.MimeType.JAVASCRIPT);
  }
  return json(reply);
}

function doPost(e) {
  return json(handle(e && e.postData ? e.postData.contents : ''));
}

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
