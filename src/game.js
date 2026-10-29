// Game orchestration: renderer and scene, the main loop, chunk streaming around the
// player, saving and loading worlds, and the glue between player, world, entities,
// sky, audio and UI.
import * as THREE from './three.js';
import { TextureBank } from './textures.js';
import { World } from './world.js';
import { CHUNK, SEA } from './worldgen.js';
import { ChunkRenderer, SelectionBox, CrackOverlay, Particles } from './renderer.js';
import { Sky } from './sky.js';
import { Player } from './player.js';
import { EntityManager, FallingBlock, setEntityBrightness } from './entities.js';
import { ViewModel } from './viewmodel.js';
import { Input } from './input.js';
import { Audio } from './audio.js';
import { UI } from './ui.js';
import { Net } from './net.js';
import { BLOCKS, SOLID, B } from './blocks.js';
import { SMELTING, fuelValue, maxStack } from './items.js';
import { seedFromString } from './noise.js';

const SETTINGS_KEY = 'blockcraft.settings';
const INDEX_KEY = 'blockcraft.worlds';
const WORLD_KEY = (id) => `blockcraft.world.${id}`;

// Devices that report 4 GB or less (most school Chromebooks) start with a lighter load.
const LOW_MEMORY = (navigator.deviceMemory ?? 8) <= 4;

const DEFAULT_SETTINGS = {
  playerName: `Player${Math.floor(100 + Math.random() * 900)}`, serverUrl: '',
  renderDistance: LOW_MEMORY ? 4 : 6, safeGraphics: false, fancyGraphics: true, fov: 70, sensitivity: 1, brightness: 0.5, volume: 0.7, music: 0.4,
  invertY: false, clouds: true, bobbing: true, peaceful: false, keepInventory: false,
};

function storageGet(key) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function storageSet(key, value) {
  try {
    localStorage.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}

class Saves {
  list() {
    try {
      return (JSON.parse(storageGet(INDEX_KEY) ?? '[]') ?? []).sort((a, b) => b.lastPlayed - a.lastPlayed);
    } catch {
      return [];
    }
  }
  writeIndex(list) {
    storageSet(INDEX_KEY, JSON.stringify(list));
  }
  meta(id) {
    return this.list().find((w) => w.id === id) ?? null;
  }
  create(meta) {
    const list = this.list();
    list.push(meta);
    this.writeIndex(list);
  }
  touch(id, patch = {}) {
    const list = this.list();
    const w = list.find((x) => x.id === id);
    if (w) Object.assign(w, { lastPlayed: Date.now() }, patch);
    this.writeIndex(list);
  }
  load(id) {
    try {
      return JSON.parse(storageGet(WORLD_KEY(id)) ?? 'null');
    } catch {
      return null;
    }
  }
  save(id, data) {
    return storageSet(WORLD_KEY(id), JSON.stringify(data));
  }
  remove(id) {
    try {
      localStorage.removeItem(WORLD_KEY(id));
    } catch { /* storage unavailable */ }
    this.writeIndex(this.list().filter((w) => w.id !== id));
  }
}

function hasWebGL2() {
  try {
    return !!document.createElement('canvas').getContext('webgl2');
  } catch {
    return false;
  }
}

export class Game {
  constructor() {
    this.canvas = document.getElementById('game');
    this.settings = this.loadSettings();
    // Safe graphics: WebGL 1 and a plain texture atlas, for devices where the normal
    // renderer shows a black picture. On from the settings, from #safe in the address,
    // or when WebGL 2 is missing.
    if (location.hash === '#safe') this.settings.safeGraphics = true;
    this.safe = !!this.settings.safeGraphics || !hasWebGL2();
    this.safeSetting = !!this.settings.safeGraphics;
    const options = { canvas: this.canvas, antialias: false, powerPreference: this.safe ? 'default' : 'high-performance' };
    if (this.safe) {
      const context = this.canvas.getContext('webgl', { antialias: false, alpha: false, depth: true, stencil: false, powerPreference: 'default' });
      if (context) options.context = context;
    }
    this.renderer = new THREE.WebGLRenderer(options);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, LOW_MEMORY ? 1 : 1.5));
    this.renderer.autoClear = true;
    this.renderer.info.autoReset = false;
    this.watchGraphics();
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(70, 1, 0.08, 1200);
    this.camera.rotation.order = 'YXZ';
    this.bank = new TextureBank(this.safe);
    this.chunkRenderer = new ChunkRenderer(this.scene, this.bank);
    this.sky = new Sky(this.scene);
    this.selection = new SelectionBox(this.scene);
    this.crack = new CrackOverlay(this.scene, this.bank.destroy);
    this.particles = new Particles(this.scene);
    this.input = new Input(this.canvas);
    this.audio = new Audio();
    this.saves = new Saves();
    this.player = new Player(this);
    this.entities = new EntityManager(this);
    this.viewModel = new ViewModel(this);
    this.ui = new UI(this);
    this.net = new Net(this);
    this.world = null;
    this.state = 'menu';
    this.fps = 60;
    this.hudHidden = false;
    this.saveTimer = 0;
    this.leafTimer = 0;
    this.clearColor = new THREE.Color();
    this.applySettings();
    this.bindKeys();
    this.resize();
    window.addEventListener('resize', () => this.resize());
    if (window.ResizeObserver) new ResizeObserver(() => this.resize()).observe(this.canvas);
    window.addEventListener('beforeunload', () => this.save());
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) this.save();
    });
    this.ui.show('title');
    this.last = performance.now();
    requestAnimationFrame((t) => this.loop(t));
  }

  // --- Settings -------------------------------------------------------------------------

  loadSettings() {
    try {
      return { ...DEFAULT_SETTINGS, ...(JSON.parse(storageGet(SETTINGS_KEY) ?? '{}') ?? {}) };
    } catch {
      return { ...DEFAULT_SETTINGS };
    }
  }

  applySettings() {
    const stored = storageSet(SETTINGS_KEY, JSON.stringify(this.settings));
    if (!!this.settings.safeGraphics !== this.safeSetting && this.chunkRenderer) {
      // The graphics mode is chosen at startup, so switching it needs a reload.
      this.safeSetting = !!this.settings.safeGraphics;
      this.save();
      if (!stored || location.hash === '#safe') location.hash = this.settings.safeGraphics ? 'safe' : '';
      location.reload();
      return;
    }
    this.audio.setVolume(this.settings.volume);
    this.audio.setMusicVolume(this.settings.music);
    this.chunkRenderer.shared.uBrightness.value = this.settings.brightness;
    const fancy = this.settings.fancyGraphics ? 1 : 0;
    this.chunkRenderer.shared.uFancy.value = fancy;
    this.chunkRenderer.shared.uWave.value = fancy;
    document.getElementById('vignette').style.opacity = fancy;
    setEntityBrightness(this.settings.brightness);
  }

  // Size the drawing buffer to the canvas as laid out. Some browsers report a zero or
  // stale window size at startup, which leaves the 3D view blank, so this also runs
  // from a ResizeObserver and a periodic check in the loop.
  resize() {
    if (!this.canvas.clientWidth || !this.canvas.clientHeight) this.forceCanvasLayout();
    const w = Math.max(1, this.canvas.clientWidth || window.innerWidth || document.documentElement.clientWidth);
    const h = Math.max(1, this.canvas.clientHeight || window.innerHeight || document.documentElement.clientHeight);
    this.viewSize = [w, h];
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.particles.setViewport(h * this.renderer.getPixelRatio(), this.camera.fov);
  }

  // --- Worlds ---------------------------------------------------------------------------

  createWorld(name, seedText, mode) {
    const seed = seedText ? seedFromString(seedText) : Math.floor(Math.random() * 2 ** 31);
    const id = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
    this.saves.create({ id, name, seed, mode, created: Date.now(), lastPlayed: Date.now() });
    this.openWorld(id);
  }

  async openWorld(id) {
    const meta = this.saves.meta(id);
    if (!meta) return;
    await this.startWorld({ id, name: meta.name, seed: meta.seed, mode: meta.mode, save: this.saves.load(id) });
  }

  // Load and enter a world. id is null for a friend's multiplayer world, which isn't
  // saved here (the host's computer keeps it); edits are the room's changes so far.
  async startWorld({ id, name, seed, mode, save = null, edits = [], players = [] }) {
    const meta = { name, seed, mode };
    this.audio.resume();
    this.cancelSleep();
    this.worldId = id;
    this.worldName = name;
    this.state = 'loading';
    this.ui.show('loading');
    this.ui.setLoading(0, 'Building terrain');
    await new Promise((r) => setTimeout(r, 30));

    this.world = new World(meta.seed, save?.world ?? null);
    this.world.markers = save?.world?.markers ?? [];
    this.world.addEdits(edits);
    this.world.onFall = (x, y, z, blockId) => this.entities.add(new FallingBlock(this, x, y, z, blockId));
    this.world.onDrop = (x, y, z, blockId, stack) => {
      if (this.world.applyingRemote) return; // the player who broke it gets the drops
      if (stack) this.entities.dropItem(x + 0.5, y + 0.5, z + 0.5, stack);
      else this.entities.dropBlockItems(x, y, z, blockId, { type: BLOCKS[blockId].tool, level: 3, speed: 1 });
    };
    this.worldSpawn = save?.spawn ?? this.world.gen.findSpawn();
    this.player.reset();
    this.player.mode = meta.mode;
    this.player.inventory.clear();
    if (save?.player) this.player.load(save.player);
    else {
      Object.assign(this.player, this.worldSpawn);
      if (meta.mode === 'survival') this.player.inventory.add({ id: 'torch', count: 4 });
    }

    // Generate and mesh the area around the player before handing over control.
    const r = Math.min(this.settings.renderDistance, 4);
    const pcx = Math.floor(this.player.x / CHUNK);
    const pcz = Math.floor(this.player.z / CHUNK);
    const need = [];
    for (let dz = -r - 1; dz <= r + 1; dz++) for (let dx = -r - 1; dx <= r + 1; dx++) need.push([pcx + dx, pcz + dz]);
    let done = 0;
    for (const [cx, cz] of need) {
      if (!this.world.getChunk(cx, cz)) this.world.generateChunk(cx, cz);
      if (++done % 6 === 0) {
        this.ui.setLoading((done / need.length) * 0.6, 'Building terrain');
        await new Promise((res) => requestAnimationFrame(res));
      }
    }
    let meshed = 0;
    const total = (2 * r + 1) ** 2;
    while (true) {
      const built = this.chunkRenderer.update(this.world, this.player.x, this.player.z, r + 0.5, 30);
      meshed += built;
      this.ui.setLoading(0.6 + Math.min(1, meshed / total) * 0.4, 'Lighting the world');
      if (!built) break;
      await new Promise((res) => requestAnimationFrame(res));
    }
    // New worlds: stand on open ground, not on a tree canopy.
    if (!save?.player) {
      this.worldSpawn = this.groundNear(Math.floor(this.player.x), Math.floor(this.player.z));
      Object.assign(this.player, this.worldSpawn);
    }
    if (id) this.saves.touch(id);
    this.net.addPlayers(players);
    const failure = this.selfTest();
    this.selfTestResult = failure ? 'failed' : 'passed';
    this.state = 'playing';
    this.ui.hideMenus();
    document.getElementById('hud').hidden = false;
    this.ui.toast(meta.mode === 'creative' ? 'Creative mode: double-tap Space to fly' : 'Punch a tree to get started. Press E for your inventory.', 4);
    if (failure) {
      this.reportProblem(`Graphics self-test failed: ${failure}.`);
      if (!this.safe) return; // reloading into Safe graphics
    }
    this.resume();
  }

  // Nearest column (spiralling out) whose top block is ground rather than leaves, logs
  // or water. Returns feet position on top of it.
  groundNear(x0, z0) {
    const world = this.world;
    for (let r = 0; r <= 24; r++) {
      for (let dz = -r; dz <= r; dz++) {
        for (let dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
          const x = x0 + dx, z = z0 + dz;
          if (!world.isLoaded(x, z)) continue;
          const y = world.surfaceY(x, z);
          const top = BLOCKS[world.getBlock(x, y, z)];
          if (top.leaves || top.name.endsWith('_log') || top.fluid || top.hurts) continue;
          if (world.getBlock(x, y + 1, z) && SOLID[world.getBlock(x, y + 1, z)]) continue;
          return { x: x + 0.5, y: y + 1, z: z + 0.5 };
        }
      }
    }
    return { x: x0 + 0.5, y: world.surfaceY(x0, z0) + 1, z: z0 + 0.5 };
  }

  serialize() {
    if (!this.world) return null;
    return {
      v: 1,
      seed: this.world.seed,
      world: { ...this.world.serialize(), markers: this.world.markers ?? [] },
      player: this.player.serialize(),
      spawn: this.worldSpawn,
    };
  }

  save() {
    if (!this.world || !this.worldId || this.state === 'loading') return;
    const ok = this.saves.save(this.worldId, this.serialize());
    this.saves.touch(this.worldId);
    if (!ok) this.ui.toast('Could not save: browser storage is full or blocked.');
  }

  // Clears a sleep fade in progress so the screen can't stay black.
  cancelSleep() {
    clearTimeout(this.sleepTimer);
    this.sleepTimer = null;
    this.sleeping = false;
    document.getElementById('sleep-fade').style.opacity = 0;
  }

  // --- Multiplayer ------------------------------------------------------------------------

  // Open one of this browser's worlds and share it: returns the room code.
  async hostWorld(id) {
    const meta = this.saves.meta(id);
    if (!meta) return null;
    await this.net.connect();
    await this.openWorld(id);
    const data = this.world.serialize();
    const code = await this.net.host({ seed: meta.seed, mode: meta.mode, name: meta.name, time: this.world.time, spawn: this.worldSpawn, mods: data.mods });
    this.ui.chatLine(`Hosting "${meta.name}". Friends can join with code ${code}.`, 'system');
    this.ui.toast(`Your game code is ${code}. Press T to chat.`, 8);
    return code;
  }

  async joinGame(code) {
    await this.net.connect();
    const welcome = await this.net.join(code);
    const w = welcome.world;
    await this.startWorld({
      id: null, name: `${w.name} (${welcome.code})`, seed: w.seed, mode: w.mode,
      save: { world: { mods: w.mods, time: w.time }, spawn: w.spawn ?? null },
      edits: welcome.edits, players: welcome.players,
    });
    this.ui.chatLine(`Joined ${w.name}. Press T to chat.`, 'system');
  }

  onDisconnected() {
    if (!this.world) return;
    if (this.worldId) {
      this.ui.chatLine('Lost the connection to the server. You’re playing on your own now; your world is still saved.', 'system');
      return;
    }
    this.quitToTitle();
    this.ui.show('multiplayer');
    this.ui.setMultiplayerStatus('Lost the connection to the game. Try joining again.');
  }

  quitToTitle() {
    this.cancelSleep();
    this.net.leave();
    this.save();
    this.ui.close();
    this.entities.clear();
    this.chunkRenderer.clear();
    this.world = null;
    this.worldId = null;
    this.state = 'menu';
    this.selection.hide();
    this.crack.hide();
    this.particles.items = [];
    document.getElementById('hud').hidden = true;
    document.getElementById('click-to-play').hidden = true;
    this.input.unlock();
    this.ui.show('title');
  }

  // --- State ------------------------------------------------------------------------------

  resume() {
    if (!this.world) return;
    this.audio.resume();
    if (this.player.dead) return;
    this.state = 'playing';
    this.ui.hideMenus();
    document.getElementById('click-to-play').hidden = true;
    this.input.lock();
  }

  pause() {
    if (this.state !== 'playing') return;
    this.state = 'paused';
    this.save();
    this.input.unlock();
    this.ui.show('pause');
    const meta = this.saves.meta(this.worldId);
    const info = document.getElementById('pause-info');
    info.style.whiteSpace = 'pre-line';
    info.textContent = `${meta ? `${meta.name} · seed ${meta.seed} · saved` : ''}\nVersion ${window.BLOCKCRAFT_VERSION ?? 'dev'}\n${this.diagnostics()}`;
  }

  // The game view has been seen laid out at 0×0 (drawing fine, but invisible). Pin it
  // to the full window with inline !important styles, the way a full-page game would.
  forceCanvasLayout() {
    const s = this.canvas.style;
    const props = { display: 'block', position: 'fixed', left: '0', top: '0', width: '100vw', height: '100vh', visibility: 'visible', opacity: '1' };
    for (const [k, v] of Object.entries(props)) s.setProperty(k, v, 'important');
    this.layoutForced = true;
  }

  // One line of graphics facts for the pause menu (and bug reports).
  diagnostics() {
    const gl = this.renderer.getContext();
    const p = this.player;
    const head = this.world ? this.world.getLight(Math.floor(p.x), Math.floor(p.y + p.eyeHeight), Math.floor(p.z)) : { sky: '-', block: '-' };
    const r = this.renderer.info.render;
    return [
      `${this.safe ? 'Safe' : 'Standard'} graphics (WebGL ${this.renderer.capabilities.isWebGL2 ? 2 : 1}) · ${this.gpu}`,
      `View ${this.canvas.clientWidth}×${this.canvas.clientHeight}, buffer ${gl.drawingBufferWidth}×${gl.drawingBufferHeight} · drawn ${r.calls} calls`,
      this.canvasLayout(),
      `Y ${p.y.toFixed(1)} · light sky ${head.sky}, block ${head.block} · ${this.sky.daylight > 0.5 ? 'day' : 'night'}${this.selfTestResult ? ` · self-test ${this.selfTestResult}` : ''}`,
    ].join('\n');
  }

  onPlayerDeath(cause) {
    const msgs = {
      player: `were slain by ${this.player.lastAttacker ?? 'another player'}`,
      fall: 'fell from a high place', lava: 'tried to swim in lava', drown: 'drowned', zombie: 'was slain by a Zombie',
      explosion: 'blew up', cactus: 'was pricked to death', starve: 'starved to death', void: 'fell out of the world',
    };
    document.getElementById('death-cause').textContent = `You ${msgs[cause] ?? 'died'}.`;
    this.state = 'dead';
    this.ui.close();
    this.input.unlock();
    this.ui.show('death');
  }

  respawn() {
    this.player.respawn();
    this.ui.hideMenus();
    this.state = 'playing';
    this.resume();
  }

  trySleep(x, y, z) {
    const world = this.world;
    const t = world.time;
    this.player.spawn = { x: x + 0.5, y: y + 1, z: z + 0.5 };
    if (t < 12540 || t > 23460) {
      this.ui.toast('Respawn point set. You can only sleep at night.');
      return;
    }
    if (this.entities.mobs.some((m) => m.hostile && m.distTo(this.player) < 8)) {
      this.ui.toast('You may not rest now; there are monsters nearby.');
      return;
    }
    if (this.net.active && !this.net.isHost) {
      this.ui.toast('Respawn point set. In multiplayer only the host can sleep through the night.');
      return;
    }
    const fade = document.getElementById('sleep-fade');
    fade.style.opacity = 1;
    this.sleeping = true;
    this.audio.sleep();
    this.sleepTimer = setTimeout(() => {
      this.sleepTimer = null;
      if (this.world !== world) return;
      world.time = 0;
      world.day += 1;
      this.net.send({ t: 'time', time: 0 });
      this.net.capture(() => world.setBlock(x, y, z, 0));
      this.particles.burst(x, y, z, [0.86, 0.74, 0.36], 20);
      fade.style.opacity = 0;
      this.sleeping = false;
      this.ui.toast('You slept through the night. The straw bed crumbled. Respawn point set.', 4);
    }, 1400);
  }

  // --- Input --------------------------------------------------------------------------------

  bindKeys() {
    this.input.onLockChange = (locked) => {
      if (!locked && this.state === 'playing' && !this.ui.isOpen && !this.player.dead) this.pause();
    };
    this.input.onLockError = () => {
      if (this.state === 'playing' && !this.ui.isOpen) document.getElementById('click-to-play').hidden = false;
    };
    this.input.onKey = (code, e) => {
      if (!this.world) return false;
      if (this.state === 'paused' && code === 'Escape') {
        this.resume();
        return true;
      }
      if (this.state !== 'playing') return false;
      if (this.ui.isOpen) {
        if (code === 'Escape' || (code === 'KeyE' && !(e.target instanceof HTMLInputElement)) || (code === 'KeyM' && this.ui.screen === 'map')) {
          this.ui.close();
          return true;
        }
        return false;
      }
      if (code === 'KeyE') {
        this.ui.open('inventory');
        return true;
      }
      if (code === 'KeyT' && this.net.active) {
        this.ui.openChat();
        return true;
      }
      if (code === 'KeyM') {
        this.ui.openMap();
        return true;
      }
      if (code === 'F3') {
        const d = document.getElementById('debug');
        d.hidden = !d.hidden;
        return true;
      }
      if (code === 'F1') {
        this.hudHidden = !this.hudHidden;
        document.getElementById('hud').style.visibility = this.hudHidden ? 'hidden' : 'visible';
        return true;
      }
      return false;
    };
  }

  // --- Loop -------------------------------------------------------------------------------------

  loop(now) {
    requestAnimationFrame((t) => this.loop(t));
    const dt = Math.min(0.05, (now - this.last) / 1000);
    this.last = now;
    this.fps += (1 / Math.max(dt, 1e-3) - this.fps) * 0.05;
    try {
      if (this.viewSize && (this.canvas.clientWidth !== this.viewSize[0] || this.canvas.clientHeight !== this.viewSize[1]) && this.canvas.clientWidth > 0) this.resize();
      if (this.world && this.state !== 'loading') {
        this.update(dt);
        this.render();
        this.checkBlackFrame(now);
      } else if (!this.world) {
        this.renderer.setClearColor(0x000000);
        this.renderer.clear();
      }
    } catch (e) {
      console.error(e);
      if (!this.reportedError) {
        this.reportedError = true;
        this.reportProblem(`Something went wrong while drawing the game: ${e.message}`);
      }
    }
    this.input.endFrame();
  }

  // --- Graphics diagnostics -------------------------------------------------------------
  // A black screen with the HUD still showing means the 3D view failed on this device;
  // these turn the usual causes into a message on screen.

  watchGraphics() {
    const gl = this.renderer.getContext();
    const info = gl.getExtension('WEBGL_debug_renderer_info');
    this.gpu = String(info ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER));
    this.canvas.addEventListener('webglcontextlost', (e) => {
      e.preventDefault();
      this.reportProblem('The graphics card stopped drawing the game, usually because it ran out of memory. Open Options, lower Render distance, then reload the page.');
    });
    this.canvas.addEventListener('webglcontextrestored', () => this.hideProblem());
    this.renderer.debug.onShaderError = (g, program, vs, fs) => {
      const log = [g.getProgramInfoLog(program), g.getShaderInfoLog(vs), g.getShaderInfoLog(fs)].filter(Boolean).join(' ').trim();
      this.reportProblem(`A graphics shader would not compile on this device: ${log.slice(0, 300) || 'no details'}`);
    };
  }

  reportProblem(text) {
    if (this.input) this.input.unlock();
    if (!this.safe) {
      // First line of defence: retry in safe graphics mode.
      window.showBootError?.(`${text}\n\nSwitching to Safe graphics and reloading…`);
      this.save();
      this.settings.safeGraphics = true;
      if (!storageSet(SETTINGS_KEY, JSON.stringify(this.settings))) location.hash = 'safe';
      setTimeout(() => location.reload(), 2500);
      return;
    }
    window.showBootError?.(`${text}\n\nSafe graphics is already on. Graphics: ${this.gpu}. Click to dismiss.`);
  }

  hideProblem() {
    const box = document.getElementById('boot-error');
    if (box) box.hidden = true;
  }

  // Every two seconds in daylight under open sky, sample the top of the picture: it
  // should be sky. Three black samples in a row means nothing is reaching the screen.
  // How the browser laid out the game view, for the pause menu.
  canvasLayout() {
    const cs = getComputedStyle(this.canvas);
    const box = this.canvas.getBoundingClientRect();
    return `Canvas ${cs.display}, ${cs.visibility}, ${cs.position}, ${Math.round(box.width)}×${Math.round(box.height)} at ${Math.round(box.left)},${Math.round(box.top)}${this.layoutForced ? ', forced' : ''}${this.canvas.isConnected ? '' : ', detached'}`;
  }

  // Draw a known picture and read it back: a cleared background, a plain colored square
  // and a stone block through the world shader. Returns null if all three show up.
  selfTest() {
    const gl = this.renderer.getContext();
    if (gl.isContextLost()) return 'the graphics context is lost';
    this.resize();
    const W = gl.drawingBufferWidth, H = gl.drawingBufferHeight;
    if (W < 4 || H < 4) return `the 3D view has no size (${W}×${H})`;
    const scene = new THREE.Scene();
    const cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 10);
    cam.position.z = 5;
    const plain = new THREE.Mesh(new THREE.PlaneGeometry(0.8, 0.8), new THREE.MeshBasicMaterial({ color: 0xff0000 }));
    plain.position.x = -0.5;
    const blockMat = this.chunkRenderer.entityMaterial();
    blockMat.uniforms.uEntityLight.value.set(1, 0);
    const block = new THREE.Mesh(this.chunkRenderer.blockGeometry(B.stone), blockMat);
    block.scale.set(1.2, 1.2, 0.1);
    block.position.set(0.5, -0.6, 0);
    scene.add(plain, block);
    const savedDaylight = this.chunkRenderer.shared.uDaylight.value;
    const savedFar = this.chunkRenderer.shared.uFogFar.value;
    const savedNear = this.chunkRenderer.shared.uFogNear.value;
    this.chunkRenderer.shared.uDaylight.value = 1;
    this.chunkRenderer.shared.uFogNear.value = 100;
    this.chunkRenderer.shared.uFogFar.value = 200;
    this.renderer.setClearColor(new THREE.Color().setRGB(0.2, 0.6, 0.4, THREE.SRGBColorSpace));
    this.renderer.render(scene, cam);
    const read = (fx, fy) => {
      const px = new Uint8Array(4);
      gl.readPixels(Math.floor(W * fx), Math.floor(H * fy), 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
      return [px[0], px[1], px[2]];
    };
    const bg = read(0.02, 0.98), red = read(0.25, 0.5), stone = read(0.75, 0.5);
    this.chunkRenderer.shared.uDaylight.value = savedDaylight;
    this.chunkRenderer.shared.uFogNear.value = savedNear;
    this.chunkRenderer.shared.uFogFar.value = savedFar;
    plain.geometry.dispose();
    plain.material.dispose();
    blockMat.dispose();
    const fmt = (c) => c.join(',');
    if (Math.abs(bg[1] - 153) > 40) return `nothing reaches the screen (background ${fmt(bg)})`;
    if (red[0] < 150 || red[1] > 80) return `plain shapes don't draw (got ${fmt(red)})`;
    if (stone[0] + stone[1] + stone[2] < 60) return `blocks draw black (got ${fmt(stone)})`;
    return null;
  }

  checkBlackFrame(now) {
    if (this.blackReported || now - (this.lastBlackCheck ?? 0) < 2000 || this.state !== 'playing') return;
    this.lastBlackCheck = now;
    const p = this.player;
    const head = this.world.getLight(Math.floor(p.x), Math.floor(p.y + p.eyeHeight), Math.floor(p.z));
    if (this.sky.daylight < 0.6 || head.sky < 12 || p.pitch < -0.6 || p.headInWater || p.headInLava) {
      this.blackCount = 0;
      return;
    }
    const gl = this.renderer.getContext();
    const px = new Uint8Array(4);
    gl.readPixels(Math.floor(gl.drawingBufferWidth / 2), Math.floor(gl.drawingBufferHeight * 0.95), 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
    this.blackCount = px[0] + px[1] + px[2] < 6 ? (this.blackCount ?? 0) + 1 : 0;
    if (this.blackCount >= 3) {
      this.blackReported = true;
      const r = this.renderer.info.render;
      this.reportProblem(`The game is running, but the 3D picture is coming out black on this device (${r.calls} draw calls, ${r.triangles} triangles). Make sure hardware acceleration is on in your browser settings, or try another browser.`);
    }
  }

  manageChunks() {
    const world = this.world;
    const rd = this.settings.renderDistance;
    const pcx = Math.floor(this.player.x / CHUNK);
    const pcz = Math.floor(this.player.z / CHUNK);
    const missing = [];
    const gr = rd + 1;
    for (let dz = -gr; dz <= gr; dz++) {
      for (let dx = -gr; dx <= gr; dx++) {
        if (dx * dx + dz * dz > (gr + 0.5) ** 2) continue;
        if (!world.getChunk(pcx + dx, pcz + dz)) missing.push([pcx + dx, pcz + dz, dx * dx + dz * dz]);
      }
    }
    missing.sort((a, b) => a[2] - b[2]);
    const start = performance.now();
    for (const [cx, cz] of missing) {
      world.generateChunk(cx, cz);
      if (performance.now() - start > 5) break;
    }
    for (const chunk of [...world.chunks.values()]) {
      const dx = chunk.cx - pcx;
      const dz = chunk.cz - pcz;
      if (dx * dx + dz * dz > (rd + 3) ** 2) {
        this.chunkRenderer.remove(chunk);
        world.unloadChunk(chunk);
      }
    }
    this.chunkRenderer.update(world, this.player.x, this.player.z, rd + 0.5, 7);
  }

  update(dt) {
    const world = this.world;
    const p = this.player;
    const playing = this.state === 'playing';
    const active = playing && !this.ui.isOpen && this.input.locked && !this.sleeping;
    if (this.state !== 'paused') {
      world.time += dt * 20;
      if (world.time >= 24000) {
        world.time -= 24000;
        world.day++;
      }
      world.clock += dt;
      world.processTicks();
      world.processGrowth();
      world.updateTiles(dt, { recipeFor: (id) => SMELTING[id] ?? null, fuelFor: fuelValue, maxStack });
      p.update(dt, this.input, active);
      this.net.update(dt);
      this.entities.update(dt);
      this.spawnLeaves(dt);
      this.spawnSmoke(dt);
    }
    this.manageChunks();
    this.particles.update(dt, (x, y, z) => SOLID[world.getBlock(x, y, z)] && BLOCKS[world.getBlock(x, y, z)].shape === 'cube');
    this.updateCamera(dt);
    this.sky.update(world.time, this.camera, dt, this.settings.clouds, this.settings.fancyGraphics);
    const shared = this.chunkRenderer.shared;
    shared.uSunDir.value.copy(this.sky.sunDir);
    shared.uSkyColor.value.set(...this.sky.fogColor);
    const ft = shared.uTime.value;
    shared.uFlicker.value = 0.96 + 0.025 * Math.sin(ft * 9.1) + 0.015 * Math.sin(ft * 23.7);
    this.updateFog();
    this.chunkRenderer.shared.uDaylight.value = this.sky.daylight;
    this.chunkRenderer.shared.uTime.value += dt;

    // Selection and crack overlay.
    const t = p.target;
    if (t && active) {
      this.selection.show(t.x, t.y, t.z, t.boxes);
      if (p.mining && p.mode === 'survival' && p.mining.progress > 0) this.crack.show(t.x, t.y, t.z, p.mining.progress, t.boxes[0]);
      else this.crack.hide();
    } else {
      this.selection.hide();
      this.crack.hide();
    }
    const head = world.getLight(Math.floor(p.x), Math.floor(p.y + p.eyeHeight), Math.floor(p.z));
    const curve = (l) => Math.pow(0.8, 15 - l);
    this.viewModel.update(dt, p, {
      sky: head.sky / 15, block: head.block / 15,
      brightness: Math.max(curve(head.sky) * this.sky.daylight, curve(head.block), 0.08) * (1 + this.settings.brightness * 0.4),
    });
    this.ui.updateHud(dt);
    if (this.ui.screen === 'map' && Math.floor(world.clock * 2) !== Math.floor((world.clock - dt) * 2)) this.ui.drawMap();
    this.audio.updateMusic(dt);
    this.saveTimer += dt;
    if (this.saveTimer > 30 && playing) {
      this.saveTimer = 0;
      this.save();
    }
  }

  updateCamera(dt) {
    const p = this.player;
    const cam = this.camera;
    let bob = 0;
    let roll = 0;
    if (this.settings.bobbing && p.onGround && !p.flying) {
      const amt = Math.min(1, Math.hypot(p.vx, p.vz) / 4.3);
      bob = Math.abs(Math.sin(p.walkDist * 2.2)) * 0.07 * amt;
      roll = Math.sin(p.walkDist * 2.2) * 0.008 * amt;
    }
    const shake = p.shake > 0 ? (Math.random() - 0.5) * p.shake * 0.15 : 0;
    cam.position.set(p.x, p.y + p.eyeHeight + bob + shake, p.z);
    cam.rotation.set(p.pitch, p.yaw, roll + (p.hurtFlash > 0.5 ? (p.hurtFlash - 0.5) * 0.1 : 0) + shake * 0.3);
    let fov = this.settings.fov;
    if (p.sprinting) fov *= 1.12;
    if (p.flying && p.sprinting) fov *= 1.05;
    if (p.headInWater) fov *= 0.92;
    cam.fov += (fov - cam.fov) * Math.min(1, dt * 10);
    cam.updateProjectionMatrix();
  }

  updateFog() {
    const p = this.player;
    const far = this.settings.renderDistance * CHUNK;
    let fog;
    if (p.headInLava) {
      fog = [0.9, 0.3, 0.05];
      this.chunkRenderer.setFog(fog, 0, 2);
    } else if (p.headInWater) {
      const d = this.sky.daylight;
      fog = [0.04 * d, 0.12 * d, 0.38 * d];
      this.chunkRenderer.setFog(fog, 1, 22);
    } else {
      const f = this.sky.fogColor;
      // Darker fog underground, where the sky can't be seen.
      const head = this.world.getLight(Math.floor(p.x), Math.floor(p.y + 1.6), Math.floor(p.z));
      const k = p.y < SEA - 10 ? 0.25 + 0.75 * (head.sky / 15) : 1;
      fog = [f[0] * k, f[1] * k, f[2] * k];
      this.chunkRenderer.setFog(fog, far * 0.55, far - 4);
    }
    // The chunk shader writes display (sRGB) values directly; tag the clear color the
    // same way so three.js hands it to the GPU unchanged.
    this.clearColor.setRGB(fog[0], fog[1], fog[2], THREE.SRGBColorSpace);
    this.renderer.setClearColor(this.clearColor);
    this.sky.group.visible = !p.headInWater && !p.headInLava;
  }

  // Smoke columns over nearby campfires.
  spawnSmoke(dt) {
    this.smokeTimer = (this.smokeTimer ?? 0) - dt;
    if (this.smokeTimer > 0) return;
    this.smokeTimer = 0.12;
    const p = this.player;
    const pcx = Math.floor(p.x / CHUNK), pcz = Math.floor(p.z / CHUNK);
    for (let dz = -2; dz <= 2; dz++) {
      for (let dx = -2; dx <= 2; dx++) {
        const chunk = this.world.getChunk(pcx + dx, pcz + dz);
        for (const [x, y, z] of chunk?.campfires ?? []) {
          const g = 0.55 + Math.random() * 0.2;
          this.particles.spawn({
            x: x + 0.3 + Math.random() * 0.4, y: y + 0.6, z: z + 0.3 + Math.random() * 0.4,
            vx: (Math.random() - 0.5) * 0.2, vy: 1.4 + Math.random() * 0.6, vz: (Math.random() - 0.5) * 0.2,
            gravity: -0.15, drag: 0.99, color: [g, g, g], size: 0.22 + Math.random() * 0.15, life: 4 + Math.random() * 2,
          });
        }
      }
    }
  }

  spawnLeaves(dt) {
    this.leafTimer -= dt;
    if (this.leafTimer > 0) return;
    this.leafTimer = 0.05;
    const world = this.world;
    const p = this.player;
    for (let i = 0; i < 6; i++) {
      const x = Math.floor(p.x + (Math.random() - 0.5) * 28);
      const z = Math.floor(p.z + (Math.random() - 0.5) * 28);
      const y = Math.floor(p.y + Math.random() * 16 - 2);
      const id = world.getBlock(x, y, z);
      const b = BLOCKS[id];
      if (b.leaves !== 'poplar' || world.getBlock(x, y - 1, z) !== 0) continue;
      const c = b.leafColor;
      const light = Math.max(0.25, this.sky.daylight);
      const tint = 0.85 + Math.random() * 0.25;
      this.particles.spawn({
        x: x + Math.random(), y: y - 0.05, z: z + Math.random(), vx: 0, vy: -0.5, vz: 0,
        gravity: 0.6, drag: 0.96, sway: 1.8, fall: 0.6 + Math.random() * 0.5, phase: Math.random() * 6,
        color: [((c >> 16) & 255) / 255 * tint * light, ((c >> 8) & 255) / 255 * tint * light, (c & 255) / 255 * tint * light],
        size: 0.09, life: 7 + Math.random() * 4,
      });
    }
  }

  render() {
    this.renderer.info.reset();
    this.renderer.render(this.scene, this.camera);
    if (!this.hudHidden && !this.player.dead) this.viewModel.render(this.renderer, this.camera.aspect);
  }
}

