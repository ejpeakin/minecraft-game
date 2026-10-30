// DOM user interface: HUD, container screens (inventory, crafting table, furnace,
// chest, creative palette) with Minecraft click semantics, the map, and menus.
import { ITEMS, itemLabel, findRecipe, maxStack, fuelValue, SMELTING } from './items.js';
import { BLOCKS, FACE_TEX, FLUID, COLORS } from './blocks.js';
import { clickSlot, addToSlots, canMerge, cloneStack } from './inventory.js';
import { hudIcon, stoneDataUrl } from './textures.js';
import { buildLogo } from './logo.js';
import { BIOME_NAME, CHUNK, HEIGHT } from './worldgen.js';
import { chunkKey } from './world.js';
import { DEFAULT_SERVER } from './net.js';
import * as THREE from './three.js';
import { buildFigure } from './entities.js';

const $ = (id) => document.getElementById(id);
const el = (tag, cls, parent) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  parent?.appendChild(e);
  return e;
};

// Order of the creative palette: building blocks, nature, Wilderness Bound, color
// blocks, then tools and items.
function creativeOrder() {
  const names = Object.keys(ITEMS);
  const rank = (n) => {
    const it = ITEMS[n];
    if (it.block !== undefined) {
      const b = BLOCKS[it.block];
      if (b.color || n.includes('wool') || n.includes('concrete') || n.includes('cushion')) return 3;
      if (n.includes('poplar') || ['red_shrub', 'shelf_mushroom', 'straw_bed', 'campfire', 'barrel'].includes(n)) return 2;
      if (b.plant || b.leaves || n.endsWith('_log') || ['grass', 'dirt', 'sand', 'gravel', 'snow_block', 'snowy_grass', 'ice', 'cactus'].includes(n)) return 1;
      return 0;
    }
    if (it.tool) return 5;
    return 4;
  };
  const colorIndex = (n) => COLORS.findIndex(([c]) => n.startsWith(`${c}_`));
  return names.sort((a, b) => rank(a) - rank(b) || (rank(a) === 3 ? (a.split('_').pop().localeCompare(b.split('_').pop()) || colorIndex(a) - colorIndex(b)) : 0));
}

// The yellow splash on the title screen; one is picked at random each visit.
const SPLASHES = [
  'Wilderness Bound!', 'Now with poplars!', 'Don\u2019t dig straight down!', 'Shelf mushrooms!', 'Also try Rustbound!',
  'Made in a browser!', 'Autumn is here!', 'Sit on a cushion!', '16 colors of wool!', 'Find the abandoned camps!',
  'Press T to chat!', 'Punch a tree!', '100% procedural!', 'Waving leaves!', 'Creepers hate this!', 'Bring a torch!',
  'Explorer maps inside!', 'Straw beds, one use only!', 'Now multiplayer!', 'Look up at the sunset!',
  'Caves & Cliffs!', 'Beware of goats!', 'Axolotls in lush caves!', 'Glow berries!', 'Mind the powder snow!',
];

// Minecraft's button face: mid gray with faint pixel noise (each texture pixel is
// 2x2 screen pixels).
function buttonTexture() {
  const c = document.createElement('canvas');
  c.width = 64;
  c.height = 32;
  const ctx = c.getContext('2d');
  const img = ctx.createImageData(64, 32);
  let seed = 7;
  const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let i = 0; i < 64 * 32; i++) {
    const v = 111 + Math.round((rand() - 0.5) * 12);
    img.data.set([v, v, v, 255], i * 4);
  }
  ctx.putImageData(img, 0, 0);
  return c.toDataURL();
}

export class UI {
  constructor(game) {
    this.game = game;
    this.bank = game.bank;
    this.bindings = new Map();
    this.cursor = null;
    this.screen = null;
    this.container = null;
    this.toastTimer = 0;
    this.itemNameTimer = 0;
    this.lastHeld = null;
    this.mapZoom = 1;
    this.mapTiles = new Map();
    this.creativeTab = 'items';
    this.creativeSearch = '';
    this.palette = creativeOrder();
    this.icons = { heart: hudIcon('heart'), food: hudIcon('food'), air: hudIcon('air'), armor: hudIcon('armor') };
    this.buildHud();
    this.bindMenus();
    this.bindInventoryEvents();
    this.bindMap();
    document.getElementById('version').textContent = `Version ${window.BLOCKCRAFT_VERSION ?? 'dev'}`;
    const root = document.documentElement.style;
    root.setProperty('--dirt', `url(${stoneDataUrl(this.bank, 'dirt', 4)})`);
    root.setProperty('--planks', `url(${stoneDataUrl(this.bank, 'spruce_planks', 2)})`);
    root.setProperty('--btn-tex', `url(${buttonTexture()})`);
    this.buildTitle();
  }

  // --- HUD -----------------------------------------------------------------------------

  buildHud() {
    this.hotbar = [];
    for (let i = 0; i < 9; i++) this.hotbar.push(el('div', 'hslot', $('hotbar')));
    const mk = (id, n) => Array.from({ length: n }, () => el('img', '', $(id)));
    this.heartImgs = mk('hearts', 10);
    this.armorImgs = mk('armor', 10);
    this.foodImgs = mk('food', 10);
    this.airImgs = mk('air', 10);
    for (const img of [...this.heartImgs, ...this.foodImgs, ...this.airImgs, ...this.armorImgs]) img.alt = '';
  }

  renderItem(container, stack) {
    const key = stack ? `${stack.id}|${stack.count}|${stack.dmg ?? 0}` : '';
    if (container.dataset.key === key) return;
    container.dataset.key = key;
    container.innerHTML = '';
    if (!stack) return;
    const wrap = el('div', 'item', container);
    const img = el('img', '', wrap);
    img.src = this.bank.iconUrl(stack.id);
    img.alt = itemLabel(stack.id);
    img.draggable = false;
    if (stack.count > 1) el('span', 'count', wrap).textContent = stack.count;
    const max = ITEMS[stack.id]?.durability;
    if (max && stack.dmg) {
      const f = 1 - stack.dmg / max;
      const bar = el('div', 'dur', wrap);
      const s = el('span', '', bar);
      s.style.width = `${Math.max(0, f) * 100}%`;
      s.style.background = `hsl(${f * 120}, 100%, 45%)`;
    }
  }

  icon(img, set, value, full, half) {
    const v = value >= full ? 'full' : value >= half ? 'half' : 'empty';
    if (img.dataset.v !== v) {
      img.dataset.v = v;
      img.src = set[v];
    }
  }

  toast(text, seconds = 2.5) {
    $('toast').textContent = text;
    $('toast').classList.add('on');
    this.toastTimer = seconds;
  }

  flashHotbar() {
    const h = $('hotbar');
    h.classList.remove('flash');
    void h.offsetWidth;
    h.classList.add('flash');
  }

  updateHud(dt) {
    const p = this.game.player;
    const inv = p.inventory;
    for (let i = 0; i < 9; i++) {
      this.renderItem(this.hotbar[i], inv.slots[i]);
      this.hotbar[i].classList.toggle('sel', i === inv.selected);
    }
    const survival = p.mode === 'survival';
    $('bars').style.visibility = survival ? 'visible' : 'hidden';
    if (survival) {
      for (let i = 0; i < 10; i++) {
        this.icon(this.heartImgs[i], this.icons.heart, p.health - i * 2, 2, 1);
        this.icon(this.foodImgs[i], this.icons.food, p.food - i * 2, 2, 1);
      }
      const armor = p.armorPoints;
      $('armor').style.visibility = armor > 0 ? 'visible' : 'hidden';
      if (armor > 0) for (let i = 0; i < 10; i++) this.icon(this.armorImgs[i], this.icons.armor, armor - i * 2, 2, 1);
      const showAir = p.headInWater || p.air < 15;
      $('air').style.visibility = showAir ? 'visible' : 'hidden';
      if (showAir) for (let i = 0; i < 10; i++) this.icon(this.airImgs[i], this.icons.air, p.air - i * 1.5, 1.5, 0.75);
      $('hearts').classList.toggle('shake', p.health <= 4 && Math.floor(performance.now() / 120) % 2 === 0);
    }
    const heldKey = inv.held ? `${inv.held.id}:${inv.selected}` : `none:${inv.selected}`;
    if (heldKey !== this.lastHeld) {
      this.lastHeld = heldKey;
      $('item-name').textContent = inv.held ? itemLabel(inv.held.id) : '';
      this.itemNameTimer = 2;
    }
    this.itemNameTimer -= dt;
    $('item-name').style.opacity = this.itemNameTimer > 0 ? 1 : 0;
    this.toastTimer -= dt;
    if (this.toastTimer <= 0) $('toast').classList.remove('on');

    $('underwater').style.opacity = p.headInWater ? 1 : 0;
    $('inlava').style.opacity = p.headInLava ? 1 : 0;
    $('frost').style.opacity = p.headInPowder ? 1 : Math.min(1, (p.freeze ?? 0) / 7);
    $('spyglass').style.opacity = p.scoping ? 1 : 0;
    $('crosshair').style.visibility = p.scoping ? 'hidden' : '';
    $('hurt').style.opacity = p.hurtFlash;
    const eatBar = $('eat-bar');
    eatBar.hidden = !(p.eating > 0);
    if (p.eating > 0) eatBar.firstElementChild.style.width = `${Math.min(1, p.eating / 1.6) * 100}%`;
    if (!$('debug').hidden) this.updateDebug();
    if (this.screen === 'inventory' && this.container?.kind === 'furnace') this.refresh();
    if (this.screen === 'inventory') this.drawPlayerModel();
  }

  updateDebug() {
    const g = this.game;
    const p = g.player;
    const world = g.world;
    const bx = Math.floor(p.x), by = Math.floor(p.y), bz = Math.floor(p.z);
    const col = world.gen.column(bx, bz);
    const light = world.getLight(bx, Math.floor(p.y + 0.5), bz);
    const facing = ['south (+Z)', 'west (-X)', 'north (-Z)', 'east (+X)'][((Math.round((-p.yaw) / (Math.PI / 2)) % 4) + 6) % 4];
    const t = this.game.player.target;
    const time = Math.floor(world.time);
    $('debug').textContent = [
      `Blockcraft  ${g.fps.toFixed(0)} fps  chunk builds ${g.chunkRenderer.buildMs.toFixed(1)} ms`,
      `XYZ: ${p.x.toFixed(2)} / ${p.y.toFixed(2)} / ${p.z.toFixed(2)}`,
      `Block: ${bx} ${by} ${bz}   Chunk: ${Math.floor(bx / CHUNK)} ${Math.floor(bz / CHUNK)}`,
      `Facing: ${facing}`,
      `Biome: ${BIOME_NAME[col.biome]}`,
      `Light: sky ${light.sky}, block ${light.block}`,
      `Day ${world.day + 1}, time ${time}`,
      `Chunks: ${world.chunks.size} loaded, ${g.chunkRenderer.meshes.size} meshed`,
      `Entities: ${g.entities.list.length}`,
      t ? `Looking at: ${t.block.label} (${t.x}, ${t.y}, ${t.z})` : '',
      `Seed: ${world.seed}`,
      `GPU: ${g.gpu}`,
      `Graphics: ${g.safe ? 'Safe (WebGL 1)' : 'Standard (WebGL 2)'}`,
      `Drawn: ${g.renderer.info.render.calls} calls, ${g.renderer.info.render.triangles} triangles`,
    ].join('\n');
  }

  // --- Screens (menus) -------------------------------------------------------------------

  show(name) {
    for (const s of ['title', 'worlds', 'multiplayer', 'settings', 'help', 'pause', 'death', 'loading']) $(`${s}-screen`).hidden = s !== name;
    this.menu = name;
    if (name === 'worlds') this.renderWorlds();
    if (name === 'title') this.updateContinue();
    if (name === 'multiplayer') this.renderMultiplayer();
    if (name === 'pause') $('btn-quit').textContent = this.game.worldId ? 'Save and Quit to Title' : 'Leave Game';
    if (name === 'settings') this.loadSettingsForm();
  }

  hideMenus() {
    this.show(null);
  }

  bindMenus() {
    // Every button clicks, like Minecraft's. (A click on a toggle's label also reaches
    // its hidden checkbox; that second click stays quiet.)
    document.body.addEventListener('click', (e) => {
      if (e.target.matches('input') || !e.target.closest('.mc-btn, .toggle, .mode-pick label')) return;
      this.game.audio.resume();
      this.game.audio.click();
    });
    document.body.addEventListener('click', (e) => {
      const go = e.target.closest('[data-go]')?.dataset.go;
      if (!go) return;
      if (go === 'back') this.show(this.returnTo ?? 'title');
      else {
        if (go === 'settings' || go === 'help') this.returnTo = this.menu;
        this.show(go);
      }
    });
    $('settings-done').addEventListener('click', () => this.show(this.returnTo ?? 'title'));
    // Options with a note explain themselves while the pointer is on them.
    for (const opt of document.querySelectorAll('#settings-screen [data-note]')) {
      opt.addEventListener('pointerenter', () => { $('settings-note').textContent = opt.dataset.note; });
      opt.addEventListener('pointerleave', () => { $('settings-note').textContent = ''; });
    }
    $('new-world').addEventListener('submit', (e) => {
      e.preventDefault();
      const mode = new FormData(e.target).get('mode');
      this.game.createWorld($('nw-name').value.trim() || 'New World', $('nw-seed').value.trim(), mode);
    });
    $('btn-resume').addEventListener('click', () => this.game.resume());
    $('btn-quit').addEventListener('click', () => this.game.quitToTitle());
    $('btn-respawn').addEventListener('click', () => this.game.respawn());
    $('btn-death-quit').addEventListener('click', () => this.game.quitToTitle());
    $('click-to-play').addEventListener('click', () => this.game.resume());

    const s = this.game.settings;
    const ranges = [
      ['s-rd', 'o-rd', 'renderDistance', (v) => `${v} chunks`],
      ['s-fov', 'o-fov', 'fov', (v) => (v === 70 ? 'Normal' : v >= 110 ? 'Quake Pro' : `${v}`)],
      ['s-sens', 'o-sens', 'sensitivity', (v) => `${Math.round(v * 100)}%`],
      ['s-bright', 'o-bright', 'brightness', (v) => (v <= 0.05 ? 'Moody' : v >= 0.95 ? 'Bright' : `${Math.round(v * 100)}%`)],
      ['s-vol', 'o-vol', 'volume', (v) => `${Math.round(v * 100)}%`],
      ['s-mus', 'o-mus', 'music', (v) => `${Math.round(v * 100)}%`],
    ];
    for (const [id, out, key, fmt] of ranges) {
      $(id).addEventListener('input', () => {
        s[key] = Number($(id).value);
        $(out).textContent = fmt(s[key]);
        this.game.applySettings();
      });
    }
    this.rangeFormat = ranges;
    const checks = [['s-fancy', 'fancyGraphics'], ['s-shadows', 'shadows'], ['s-safe', 'safeGraphics'], ['s-invert', 'invertY'], ['s-clouds', 'clouds'], ['s-bob', 'bobbing'], ['s-peaceful', 'peaceful'], ['s-keep', 'keepInventory']];
    for (const [id, key] of checks) {
      $(id).addEventListener('change', () => {
        s[key] = $(id).checked;
        this.game.applySettings();
      });
    }
    this.checkFormat = checks;
  }

  loadSettingsForm() {
    const s = this.game.settings;
    for (const [id, out, key, fmt] of this.rangeFormat) {
      $(id).value = s[key];
      $(out).textContent = fmt(s[key]);
    }
    for (const [id, key] of this.checkFormat) $(id).checked = !!s[key];
  }

  renderWorlds() {
    const list = $('world-list');
    list.innerHTML = '';
    const worlds = this.game.saves.list();
    if (!worlds.length) {
      el('li', 'empty', list).textContent = 'No worlds yet. Create one below.';
      return;
    }
    for (const w of worlds) {
      const li = el('li', '', list);
      const meta = el('div', 'meta', li);
      el('b', '', meta).textContent = w.name;
      const played = new Date(w.lastPlayed).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
      el('span', '', meta).textContent = `${w.mode === 'creative' ? 'Creative' : 'Survival'} Mode · ${played}`;
      li.title = `Seed: ${w.seed}`;
      const play = el('button', 'mc-btn small', li);
      play.type = 'button';
      play.textContent = 'Play';
      play.addEventListener('click', () => this.game.openWorld(w.id));
      const del = el('button', 'mc-btn small', li);
      del.type = 'button';
      del.textContent = 'Delete';
      // Two clicks to delete: the first arms the button, the second deletes.
      del.addEventListener('click', () => {
        if (del.dataset.armed) {
          this.game.saves.remove(w.id);
          this.renderWorlds();
          return;
        }
        del.dataset.armed = '1';
        del.textContent = 'Click again to delete';
        setTimeout(() => {
          if (!del.isConnected) return;
          delete del.dataset.armed;
          del.textContent = 'Delete';
        }, 3000);
      });
    }
  }

  // --- Title screen -------------------------------------------------------------------------

  buildTitle() {
    buildLogo($('logo'), $('logo').textContent.trim(), this.bank.tileCanvases.get('stone'));
    $('splash').textContent = SPLASHES[Math.floor(Math.random() * SPLASHES.length)];
    $('btn-continue').addEventListener('click', () => {
      const last = this.game.saves.list()[0];
      if (last) this.game.openWorld(last.id);
    });
  }

  updateContinue() {
    const last = this.game.saves.list()[0];
    $('btn-continue').hidden = !last;
    if (last) $('continue-name').textContent = last.name;
  }

  // --- Multiplayer ------------------------------------------------------------------------

  renderMultiplayer() {
    const g = this.game;
    $('mp-name').value = g.settings.playerName;
    $('mp-server').value = g.settings.serverUrl;
    this.mpHint = () => {
      const builtIn = !g.settings.serverUrl && g.net.serverUrl();
      $('mp-server-hint').textContent = builtIn === DEFAULT_SERVER
        ? 'Using free public multiplayer servers (works at school). Friends open this same page to join.'
        : builtIn
        ? 'Using this page’s server. Friends open the same link to join.'
        : 'Paste your game\u2019s server address: the Google Apps Script link (works at school) or a Render link. See the README for setup.';
    };
    this.mpHint();
    if (!this.mpBound) {
      this.mpBound = true;
      const saveFields = () => {
        g.settings.playerName = $('mp-name').value.trim().slice(0, 16) || g.settings.playerName;
        g.settings.serverUrl = $('mp-server').value.trim();
        g.applySettings();
      };
      $('mp-name').addEventListener('change', saveFields);
      // Only refresh the hint: rebuilding the world list here would swallow a click on Host.
      $('mp-server').addEventListener('change', () => {
        saveFields();
        this.mpHint();
      });
      $('mp-form').addEventListener('submit', async (e) => {
        e.preventDefault();
        saveFields();
        const code = $('mp-code').value.trim().toUpperCase();
        if (!/^[A-Z]{4}$/.test(code)) {
          this.setMultiplayerStatus('Enter the four-letter code your friend sees.');
          return;
        }
        await this.runMultiplayer(() => g.joinGame(code), 'Connecting…');
      });
    }
    const list = $('mp-worlds');
    list.innerHTML = '';
    const worlds = g.saves.list();
    if (!worlds.length) el('li', 'empty', list).textContent = 'Make a world in Singleplayer first, then host it here.';
    for (const w of worlds) {
      const li = el('li', '', list);
      const meta = el('div', 'meta', li);
      el('b', '', meta).textContent = w.name;
      el('span', '', meta).textContent = `${w.mode === 'creative' ? 'Creative' : 'Survival'} · seed ${w.seed}`;
      const host = el('button', 'mc-btn small', li);
      host.type = 'button';
      host.textContent = 'Host';
      host.addEventListener('click', () => {
        g.settings.playerName = $('mp-name').value.trim().slice(0, 16) || g.settings.playerName;
        g.settings.serverUrl = $('mp-server').value.trim();
        g.applySettings();
        this.runMultiplayer(() => g.hostWorld(w.id), 'Starting your game…');
      });
    }
    this.setMultiplayerStatus('');
  }

  async runMultiplayer(action, note) {
    this.setMultiplayerStatus(`${note} (a sleeping server can take up to a minute to wake up)`);
    try {
      await action();
    } catch (e) {
      this.game.net.leave();
      if (this.game.world) this.game.quitToTitle();
      this.show('multiplayer');
      this.setMultiplayerStatus(e.message);
    }
  }

  setMultiplayerStatus(text) {
    $('mp-status').textContent = text;
  }

  updateRoomBadge() {
    const net = this.game.net;
    const badge = $('room-badge');
    if (!net?.active) {
      badge.hidden = true;
      return;
    }
    badge.hidden = false;
    const n = net.players.size + 1;
    badge.textContent = `Game ${net.code} · ${n} ${n === 1 ? 'player' : 'players'}${net.isHost ? ' · you host' : ''}`;
  }

  chatLine(text, kind = '') {
    const log = $('chat-log');
    const line = el('div', `line ${kind}`, log);
    line.textContent = text;
    while (log.children.length > 12) log.firstChild.remove();
    setTimeout(() => line.classList.add('old'), 10000);
  }

  openChat() {
    if (!this.chatBound) {
      this.chatBound = true;
      $('chat-form').addEventListener('submit', (e) => {
        e.preventDefault();
        this.game.net.chat($('chat-input').value);
        this.closeChat();
      });
      $('chat-input').addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
          e.preventDefault();
          this.closeChat();
        }
        e.stopPropagation();
      });
    }
    this.chatOpen = true;
    $('chat-form').hidden = false;
    $('chat-log').classList.add('open');
    $('chat-input').value = '';
    this.game.input.unlock();
    setTimeout(() => $('chat-input').focus(), 0);
  }

  closeChat() {
    this.chatOpen = false;
    $('chat-form').hidden = true;
    $('chat-log').classList.remove('open');
    $('chat-input').blur();
    this.game.resume();
  }

  setLoading(fraction, note = '') {
    $('loading-bar').style.width = `${Math.round(fraction * 100)}%`;
    $('loading-note').textContent = note;
  }

  // --- Containers ------------------------------------------------------------------------

  get isOpen() {
    return this.screen !== null || !!this.chatOpen;
  }

  open(kind = 'inventory', tile = null, pos = null) {
    const p = this.game.player;
    this.container = { kind, tile, pos };
    if (kind === 'inventory') this.craft = { grid: new Array(4).fill(null), w: 2 };
    else if (kind === 'crafting') this.craft = { grid: new Array(9).fill(null), w: 3 };
    else this.craft = null;
    this.screen = 'inventory';
    this.cursor = null;
    $('inventory').hidden = false;
    this.game.input.unlock();
    this.build(p.mode === 'creative' && kind === 'inventory');
    this.refresh();
  }

  close() {
    if (!this.screen) return;
    const p = this.game.player;
    if (this.screen === 'inventory') {
      const leftovers = [];
      if (this.craft) for (const s of this.craft.grid) if (s) leftovers.push(s);
      if (this.cursor) leftovers.push(this.cursor);
      for (const s of leftovers) {
        const left = p.inventory.add(s);
        if (left) this.game.entities.dropItem(p.x, p.y + 1.2, p.z, left);
      }
      this.cursor = null;
      this.craft = null;
      $('inventory').hidden = true;
      $('tooltip').style.display = 'none';
      this.renderCursor();
    } else if (this.screen === 'map') {
      $('map').hidden = true;
    }
    this.screen = null;
    this.container = null;
    this.game.resume();
  }

  bind(elm, binding) {
    this.bindings.set(elm, binding);
    return elm;
  }

  slot(parent, slots, index, opts = {}) {
    const e = el('div', `slot${opts.big ? ' big' : ''}${opts.trash ? ' trash' : ''}`, parent);
    return this.bind(e, { slots, index, ...opts });
  }

  build(creative) {
    const panel = $('inv-panel');
    panel.innerHTML = '';
    this.bindings.clear();
    const p = this.game.player;
    const inv = p.inventory.slots;
    const kind = this.container.kind;

    if (creative) {
      const tabs = el('div', 'tabs', panel);
      for (const [key, label] of [['items', 'Creative Items'], ['survival', 'Inventory']]) {
        const t = el('button', `tab${this.creativeTab === key ? ' on' : ''}`, tabs);
        t.type = 'button';
        t.textContent = label;
        t.addEventListener('click', () => {
          this.creativeTab = key;
          this.build(true);
          this.refresh();
        });
      }
    }

    if (creative && this.creativeTab === 'items') {
      const search = el('input', 'creative-search', panel);
      search.type = 'search';
      search.placeholder = 'Search items…';
      search.value = this.creativeSearch;
      search.addEventListener('input', () => {
        this.creativeSearch = search.value;
        this.fillPalette();
      });
      this.paletteGrid = el('div', 'grid creative-grid', panel);
      this.fillPalette();
      const hot = el('div', 'grid hot-grid', panel);
      for (let i = 0; i < 9; i++) this.slot(hot, inv, i, { player: true });
      const trashRow = el('div', 'grid', panel);
      trashRow.style.marginTop = '6px';
      trashRow.style.justifyContent = 'end';
      this.slot(trashRow, null, 0, { trash: true });
      setTimeout(() => search.focus(), 0);
      return;
    }

    const top = el('div', `inv-top${kind === 'inventory' ? ' survival' : ''}`, panel);
    if (kind === 'inventory' || kind === 'crafting') {
      if (kind === 'inventory') {
        const armor = el('div', 'grid armor-grid', top);
        for (let i = 0; i < 4; i++) {
          const a = this.slot(armor, p.inventory.armor, i, { armor: i });
          a.style.setProperty('--piece', `url(${this.bank.iconUrl(`iron_${['helmet', 'chestplate', 'leggings', 'boots'][i]}`)})`);
        }
        const prev = el('div', 'player-preview', top);
        prev.appendChild(this.playerModel() ?? this.playerPortrait());
      }
      const craft = el('div', 'craft', top);
      const wrap = el('div', '', craft);
      el('h3', '', wrap).textContent = 'Crafting';
      const grid = el('div', 'grid', wrap);
      grid.style.gridTemplateColumns = `repeat(${this.craft.w}, 36px)`;
      for (let i = 0; i < this.craft.grid.length; i++) this.slot(grid, this.craft.grid, i, { craft: true });
      el('div', 'arrow', craft);
      this.outputSlot = this.slot(craft, null, 0, { output: true, big: true });
    } else if (kind === 'furnace') {
      top.style.flexDirection = 'column';
      el('h3', '', top).textContent = 'Furnace';
      const f = el('div', 'furnace', top);
      const tile = this.container.tile;
      this.slot(f, tile.slots, 0, { furnace: 'input' });
      const arrowCell = el('div', '', f);
      arrowCell.style.gridRow = '2';
      arrowCell.style.gridColumn = '2';
      this.furnaceArrow = el('div', 'arrow', arrowCell);
      this.furnaceArrowFill = el('div', 'fill', this.furnaceArrow);
      const out = this.slot(f, tile.slots, 2, { output: 'furnace', big: true });
      out.style.gridRow = '2';
      out.style.gridColumn = '3';
      const flame = el('div', 'flame', f);
      flame.style.gridRow = '2';
      flame.style.gridColumn = '1';
      this.furnaceFlame = el('span', '', flame);
      const fuel = this.slot(f, tile.slots, 1, { furnace: 'fuel' });
      fuel.style.gridRow = '3';
      fuel.style.gridColumn = '1';
    } else if (kind === 'chest') {
      top.style.flexDirection = 'column';
      top.style.alignItems = 'flex-start';
      el('h3', '', top).textContent = BLOCKS[this.game.world.getBlock(...this.container.pos)]?.label ?? 'Chest';
      const grid = el('div', 'grid main-grid', top);
      for (let i = 0; i < 27; i++) this.slot(grid, this.container.tile.slots, i, { chest: true });
    }
    el('h3', '', panel).textContent = 'Inventory';
    const main = el('div', 'grid main-grid', panel);
    for (let i = 9; i < 36; i++) this.slot(main, inv, i, { player: true });
    const hot = el('div', 'grid hot-grid', panel);
    for (let i = 0; i < 9; i++) this.slot(hot, inv, i, { player: true });
  }

  // The 3D player in the inventory screen, turning to look at the mouse like Minecraft's.
  // A small renderer of its own, made the first time the inventory opens; null if WebGL
  // isn't available there (then the flat portrait is shown).
  playerModel() {
    if (this.preview === undefined) {
      this.preview = null;
      try {
        const canvas = document.createElement('canvas');
        canvas.className = 'player-model';
        const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, alpha: true, powerPreference: 'low-power' });
        renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
        renderer.setSize(100, 144, false);
        renderer.setClearColor(0x000000, 0);
        const scene = new THREE.Scene();
        const figure = buildFigure('player');
        figure.material.color.setRGB(1, 1, 1);
        scene.add(figure.mesh);
        const camera = new THREE.OrthographicCamera(-0.74, 0.74, 1.07, -1.07, 0.1, 20);
        camera.position.set(0, 1.0, 6);
        camera.lookAt(0, 1.0, 0);
        this.preview = { canvas, renderer, scene, figure, camera };
      } catch {
        this.preview = null;
      }
    }
    return this.preview?.canvas ?? null;
  }

  drawPlayerModel() {
    const pv = this.preview;
    if (!pv || !pv.canvas.isConnected) return;
    const r = pv.canvas.getBoundingClientRect();
    const cx = r.left + r.width / 2, cy = r.top + r.height * 0.22;
    // Minecraft's amounts: the body turns up to ~30 degrees, the head as far again.
    const turn = Math.atan(((this.mouseX ?? cx) - cx) / 80) * 0.35;
    const nod = Math.atan(((this.mouseY ?? cy) - cy) / 80) * 0.35;
    pv.figure.mesh.rotation.y = turn;
    for (const { spec, pivot } of pv.figure.parts) {
      if (spec.name === 'head') {
        pivot.rotation.y = turn;
        pivot.rotation.x = nod;
      }
      if (spec.swing !== undefined) pivot.rotation.z = (spec.swing ? -1 : 1) * 0.05;
    }
    pv.renderer.render(pv.scene, pv.camera);
  }

  // Small pixel-art figure for the inventory screen.
  playerPortrait() {
    if (!this.portraitUrl) {
      const c = document.createElement('canvas');
      c.width = 16;
      c.height = 32;
      const ctx = c.getContext('2d');
      const box = (x, y, w, h, col) => { ctx.fillStyle = col; ctx.fillRect(x, y, w, h); };
      box(4, 0, 8, 8, '#b4845c'); box(4, 0, 8, 2, '#3b2412'); box(4, 2, 1, 2, '#3b2412'); box(11, 2, 1, 2, '#3b2412');
      box(5, 4, 2, 1, '#fff'); box(6, 4, 1, 1, '#4a3a8c'); box(9, 4, 2, 1, '#fff'); box(9, 4, 1, 1, '#4a3a8c');
      box(6, 6, 4, 1, '#7a4a30');
      box(4, 8, 8, 12, '#2fa8b0'); box(0, 8, 4, 12, '#2fa8b0'); box(12, 8, 4, 12, '#2fa8b0');
      box(0, 17, 4, 3, '#b4845c'); box(12, 17, 4, 3, '#b4845c');
      box(4, 20, 8, 10, '#3a3f9c'); box(4, 30, 8, 2, '#555'); box(7, 20, 1, 10, '#2c3080');
      this.portraitUrl = c.toDataURL();
    }
    const img = document.createElement('img');
    img.src = this.portraitUrl;
    img.alt = 'Your character';
    return img;
  }

  fillPalette() {
    const grid = this.paletteGrid;
    grid.innerHTML = '';
    for (const e of [...this.bindings.keys()]) if (this.bindings.get(e).palette) this.bindings.delete(e);
    const q = this.creativeSearch.trim().toLowerCase();
    for (const name of this.palette) {
      if (q && !itemLabel(name).toLowerCase().includes(q) && !name.includes(q)) continue;
      const e = el('div', 'slot', grid);
      this.bind(e, { palette: name });
      this.renderItem(e, { id: name, count: 1 });
    }
  }

  refresh() {
    if (this.craft && this.outputSlot) {
      const r = findRecipe(this.craft.grid, this.craft.w, this.craft.w);
      this.craftResult = r ? { id: r.id, count: r.count } : null;
    }
    for (const [e, b] of this.bindings) {
      if (b.palette) continue;
      if (b.trash) continue;
      if (b.output === true) this.renderItem(e, this.craftResult);
      else this.renderItem(e, b.slots[b.index]);
    }
    if (this.container?.kind === 'furnace' && this.furnaceArrowFill) {
      const t = this.container.tile;
      this.furnaceArrowFill.style.width = `${Math.min(1, t.cook / 10) * 28}px`;
      this.furnaceFlame.style.height = `${t.burnMax ? (t.burn / t.burnMax) * 100 : 0}%`;
    }
    this.renderCursor();
  }

  renderCursor() {
    const c = $('cursor-stack');
    this.renderItem(c, this.cursor);
  }

  bindInventoryEvents() {
    const overlay = $('inventory');
    overlay.addEventListener('contextmenu', (e) => e.preventDefault());
    overlay.addEventListener('mousedown', (e) => {
      const slotEl = e.target.closest('.slot');
      const b = slotEl ? this.bindings.get(slotEl) : null;
      if (!b) {
        if (!e.target.closest('.panel') && this.cursor) {
          // Clicked outside: throw the cursor stack.
          const p = this.game.player;
          const n = e.button === 2 ? 1 : this.cursor.count;
          const [dx, dy, dz] = p.lookDir();
          this.game.entities.dropItem(p.x, p.y + 1.3, p.z, { ...this.cursor, count: n }, [dx * 5, dy * 5 + 1.5, dz * 5]).pickupDelay = 1.5;
          this.cursor.count -= n;
          if (this.cursor.count <= 0) this.cursor = null;
          this.refresh();
        }
        return;
      }
      e.preventDefault();
      this.game.audio.click();
      this.clickBinding(b, e.button, e.shiftKey);
      this.refresh();
      this.showTooltip(slotEl, e);
    });
    window.addEventListener('mousemove', (e) => {
      this.mouseX = e.clientX;
      this.mouseY = e.clientY;
      const c = $('cursor-stack');
      c.style.left = `${e.clientX}px`;
      c.style.top = `${e.clientY}px`;
      if (this.screen !== 'inventory') return;
      const slotEl = e.target.closest?.('.slot');
      this.showTooltip(slotEl, e);
    });
  }

  showTooltip(slotEl, e) {
    const tip = $('tooltip');
    const b = slotEl ? this.bindings.get(slotEl) : null;
    let stack = null;
    if (b?.palette) stack = { id: b.palette, count: 1 };
    else if (b?.output === true) stack = this.craftResult;
    else if (b?.slots) stack = b.slots[b.index];
    if (!stack || this.cursor) {
      tip.style.display = 'none';
      return;
    }
    const def = ITEMS[stack.id];
    let extra = '';
    if (def?.durability) extra = `Durability ${def.durability - (stack.dmg ?? 0)} / ${def.durability}`;
    if (def?.food) extra = `Restores ${def.food.hunger / 2} hunger`;
    if (stack.id === 'explorer_map' && stack.data) extra = 'Marks an abandoned camp';
    if (BLOCKS[def?.block]?.interact === 'sit') extra = 'Right-click to sit';
    if (stack.id === 'straw_bed') extra = 'Sleep once, then it crumbles';
    tip.innerHTML = '';
    tip.append(itemLabel(stack.id));
    if (extra) el('small', '', tip).textContent = extra;
    tip.style.display = 'block';
    tip.style.left = `${e.clientX + 16}px`;
    tip.style.top = `${e.clientY - 30}px`;
  }

  clickBinding(b, button, shift) {
    const p = this.game.player;
    const inv = p.inventory.slots;
    if (b.trash) {
      this.cursor = null;
      return;
    }
    if (b.palette) {
      if (this.cursor) {
        this.cursor = null;
        return;
      }
      const stack = { id: b.palette, count: button === 2 ? 1 : maxStack(b.palette) };
      if (shift) addToSlots(inv, { id: b.palette, count: maxStack(b.palette) });
      else this.cursor = stack;
      return;
    }
    if (b.output === true) {
      this.takeCraft(shift);
      return;
    }
    if (b.output === 'furnace') {
      const s = b.slots[b.index];
      if (!s) return;
      if (shift) {
        b.slots[b.index] = addToSlots(inv, s);
      } else if (!this.cursor) {
        this.cursor = s;
        b.slots[b.index] = null;
      } else if (canMerge(this.cursor, s) && this.cursor.count + s.count <= maxStack(s.id)) {
        this.cursor.count += s.count;
        b.slots[b.index] = null;
      }
      return;
    }
    if (shift) {
      this.quickMove(b);
      return;
    }
    if (this.game.player.mode === 'creative' && button === 1 && b.slots[b.index]) {
      this.cursor = { ...cloneStack(b.slots[b.index]), count: maxStack(b.slots[b.index].id) };
      return;
    }
    const accepts = b.armor !== undefined ? (c) => ITEMS[c.id]?.armor?.slot === b.armor : undefined;
    this.cursor = clickSlot(b.slots, b.index, this.cursor, button, accepts);
  }

  quickMove(b) {
    const s = b.slots[b.index];
    if (!s) return;
    const p = this.game.player;
    const inv = p.inventory.slots;
    const kind = this.container.kind;
    const range = (a, z) => Array.from({ length: z - a }, (_, i) => a + i);
    let left = s;
    const piece = ITEMS[s.id]?.armor;
    if (b.player && piece && kind === 'inventory' && !p.inventory.armor[piece.slot]) {
      p.inventory.armor[piece.slot] = s;
      left = null;
    } else if (b.armor !== undefined) {
      left = addToSlots(inv, s, [...range(9, 36), ...range(0, 9)]);
    } else if (b.player) {
      if (kind === 'chest') left = addToSlots(this.container.tile.slots, s);
      else if (kind === 'furnace') {
        const t = this.container.tile.slots;
        if (SMELTING[s.id]) left = addToSlots(t, s, [0]);
        else if (fuelValue(s.id) > 0) left = addToSlots(t, s, [1]);
        else left = addToSlots(inv, s, b.index < 9 ? range(9, 36) : range(0, 9));
      } else {
        left = addToSlots(inv, s, b.index < 9 ? range(9, 36) : range(0, 9));
      }
    } else {
      left = addToSlots(inv, s, [...range(9, 36), ...range(0, 9)].reverse());
    }
    b.slots[b.index] = left;
  }

  takeCraft(shift) {
    const p = this.game.player;
    let n = 0;
    while (this.craftResult && n < 64) {
      const r = this.craftResult;
      if (shift) {
        if (!p.inventory.canFit(r)) break;
        p.inventory.add(r);
      } else if (!this.cursor) {
        this.cursor = { ...r };
      } else if (canMerge(this.cursor, r) && this.cursor.count + r.count <= maxStack(r.id)) {
        this.cursor.count += r.count;
      } else {
        break;
      }
      for (let i = 0; i < this.craft.grid.length; i++) {
        const g = this.craft.grid[i];
        if (!g) continue;
        g.count--;
        if (g.count <= 0) this.craft.grid[i] = null;
      }
      n++;
      const next = findRecipe(this.craft.grid, this.craft.w, this.craft.w);
      this.craftResult = next ? { id: next.id, count: next.count } : null;
      if (!shift) break;
    }
  }

  // --- Map --------------------------------------------------------------------------------

  bindMap() {
    $('map-close').addEventListener('click', () => this.close());
    for (const b of document.querySelectorAll('[data-zoom]')) {
      b.addEventListener('click', () => {
        this.mapZoom = Math.max(0, Math.min(3, this.mapZoom + Number(b.dataset.zoom)));
        this.drawMap();
      });
    }
    const canvas = $('map-canvas');
    canvas.addEventListener('mousemove', (e) => {
      const r = canvas.getBoundingClientRect();
      const bpp = this.blocksPerPixel();
      const x = Math.floor(this.mapCenter.x + ((e.clientX - r.left) / r.width - 0.5) * 512 * bpp);
      const z = Math.floor(this.mapCenter.z + ((e.clientY - r.top) / r.height - 0.5) * 512 * bpp);
      $('map-coords').textContent = `X ${x}  Z ${z}`;
    });
    canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      this.mapZoom = Math.max(0, Math.min(3, this.mapZoom - Math.sign(e.deltaY)));
      this.drawMap();
    }, { passive: false });
  }

  blocksPerPixel() {
    return [4, 2, 1, 0.5][this.mapZoom];
  }

  openMap(stack = null) {
    const g = this.game;
    const p = g.player;
    if (stack?.id === 'explorer_map' && stack.data) {
      const key = `${stack.data.x},${stack.data.z}`;
      if (!g.world.markers) g.world.markers = [];
      if (!g.world.markers.some((m) => `${m.x},${m.z}` === key)) g.world.markers.push({ x: stack.data.x, z: stack.data.z, kind: 'camp' });
      const d = Math.round(Math.hypot(stack.data.x - p.x, stack.data.z - p.z));
      const ang = Math.atan2(stack.data.z - p.z, stack.data.x - p.x);
      const dir = ['east', 'south-east', 'south', 'south-west', 'west', 'north-west', 'north', 'north-east'][((Math.round(ang / (Math.PI / 4)) % 8) + 8) % 8];
      $('map-title').textContent = 'Explorer Map';
      $('map-note').textContent = `An abandoned camp lies about ${d} blocks to the ${dir}.`;
      this.mapZoom = d > 400 ? 0 : 1;
    } else {
      $('map-title').textContent = 'Map';
      $('map-note').textContent = 'Shows the land you have explored. Use the wheel or +/− to zoom.';
    }
    this.mapCenter = { x: p.x, z: p.z };
    this.screen = 'map';
    $('map').hidden = false;
    g.input.unlock();
    this.drawMap();
  }

  // 16x16 RGBA tile for a chunk: real blocks if loaded, generator colors otherwise.
  mapTile(cx, cz) {
    const key = chunkKey(cx, cz);
    const world = this.game.world;
    const chunk = world.chunks.get(key);
    const cached = this.mapTiles.get(key);
    if (cached && (!chunk || cached.fromChunk)) {
      if (!chunk || cached.version === chunk.version) return cached.data;
    }
    const data = new Uint8ClampedArray(16 * 16 * 4);
    const heights = new Int16Array(16 * 16);
    for (let lz = 0; lz < 16; lz++) {
      for (let lx = 0; lx < 16; lx++) {
        const x = cx * 16 + lx, z = cz * 16 + lz;
        let c, h;
        if (chunk) {
          let y = HEIGHT - 1;
          let id = 0;
          for (; y > 0; y--) {
            id = chunk.blocks[lx + lz * 16 + y * 256];
            if (id && BLOCKS[id].shape !== 'cross' && id !== 0 && BLOCKS[id].shape !== 'torch') break;
          }
          h = y;
          if (FLUID[id] === 1) {
            let depth = 0;
            while (y - depth > 0 && FLUID[chunk.blocks[lx + lz * 16 + (y - depth) * 256]] === 1) depth++;
            const f = Math.max(0.55, 1 - depth * 0.04);
            c = [52 * f, 82 * f, 196 * f];
          } else {
            const avg = this.bank.avg[FACE_TEX[id * 6 + 2]] ?? [0.5, 0.5, 0.5];
            c = [avg[0] * 255, avg[1] * 255, avg[2] * 255];
          }
        } else {
          c = world.gen.mapColor(x, z);
          h = world.gen.column(x, z).height;
        }
        heights[lx + lz * 16] = h;
        const north = lz > 0 ? heights[lx + (lz - 1) * 16] : h;
        const shade = h > north ? 1.12 : h < north ? 0.84 : 1;
        const i = (lx + lz * 16) * 4;
        data[i] = c[0] * shade;
        data[i + 1] = c[1] * shade;
        data[i + 2] = c[2] * shade;
        data[i + 3] = 255;
      }
    }
    this.mapTiles.set(key, { data, fromChunk: !!chunk, version: chunk?.version });
    return data;
  }

  drawMap() {
    if (this.screen !== 'map') return;
    const g = this.game;
    const world = g.world;
    const canvas = $('map-canvas');
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingEnabled = false;
    ctx.fillStyle = '#d8c690';
    ctx.fillRect(0, 0, 512, 512);
    const bpp = this.blocksPerPixel();
    const span = 512 * bpp;
    const x0 = this.mapCenter.x - span / 2;
    const z0 = this.mapCenter.z - span / 2;
    const tileCanvas = this.tileCanvas ??= Object.assign(document.createElement('canvas'), { width: 16, height: 16 });
    const tctx = tileCanvas.getContext('2d');
    const img = tctx.createImageData(16, 16);
    let budget = 220;
    let pending = false;
    for (let cz = Math.floor(z0 / 16); cz <= Math.floor((z0 + span) / 16); cz++) {
      for (let cx = Math.floor(x0 / 16); cx <= Math.floor((x0 + span) / 16); cx++) {
        const key = chunkKey(cx, cz);
        if (!world.explored.has(key)) continue;
        if (!this.mapTiles.has(key) && !world.chunks.has(key)) {
          if (budget-- <= 0) { pending = true; continue; }
        }
        img.data.set(this.mapTile(cx, cz));
        tctx.putImageData(img, 0, 0);
        const sx = (cx * 16 - x0) / bpp;
        const sz = (cz * 16 - z0) / bpp;
        ctx.drawImage(tileCanvas, sx, sz, 16 / bpp + 0.5, 16 / bpp + 0.5);
      }
    }
    const toMap = (x, z) => [(x - x0) / bpp, (z - z0) / bpp];
    // Camps in explored land.
    for (const camp of world.gen.campsNear(x0, z0, x0 + span, z0 + span)) {
      if (!world.explored.has(chunkKey(Math.floor(camp.x / 16), Math.floor(camp.z / 16)))) continue;
      const [mx, mz] = toMap(camp.x, camp.z);
      this.drawTent(ctx, mx, mz);
    }
    for (const m of world.markers ?? []) {
      const [mx, mz] = toMap(m.x, m.z);
      const cx = Math.max(8, Math.min(504, mx)), cz = Math.max(8, Math.min(504, mz));
      ctx.strokeStyle = '#b01010';
      ctx.lineWidth = 4;
      ctx.beginPath();
      ctx.moveTo(cx - 7, cz - 7); ctx.lineTo(cx + 7, cz + 7);
      ctx.moveTo(cx + 7, cz - 7); ctx.lineTo(cx - 7, cz + 7);
      ctx.stroke();
    }
    const spawn = g.player.spawn ?? g.worldSpawn;
    if (spawn) {
      const [sx, sz] = toMap(spawn.x, spawn.z);
      ctx.fillStyle = '#4fa0ff';
      ctx.strokeStyle = '#102040';
      ctx.lineWidth = 2;
      ctx.fillRect(sx - 5, sz - 5, 10, 10);
      ctx.strokeRect(sx - 5, sz - 5, 10, 10);
    }
    const p = g.player;
    const [px, pz] = toMap(p.x, p.z);
    ctx.save();
    ctx.translate(px, pz);
    ctx.rotate(-p.yaw);
    ctx.fillStyle = '#fff';
    ctx.strokeStyle = '#000';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(0, -10); ctx.lineTo(7, 8); ctx.lineTo(0, 4); ctx.lineTo(-7, 8); ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.restore();
    $('map-zoom').textContent = bpp >= 1 ? `1:${bpp}` : `${1 / bpp}:1`;
    if (pending) requestAnimationFrame(() => this.drawMap());
  }

  drawTent(ctx, x, y) {
    ctx.fillStyle = '#e0822a';
    ctx.strokeStyle = '#4a2a0a';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(x, y - 8); ctx.lineTo(x + 9, y + 6); ctx.lineTo(x - 9, y + 6); ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = '#4a2a0a';
    ctx.fillRect(x - 2, y, 4, 6);
  }
}
