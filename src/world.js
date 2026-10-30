// Chunk storage and every rule that runs on blocks: edits (recorded as a diff against
// the seed so saves stay small), flowing water and lava, falling sand and gravel,
// plant support, sapling and mushroom growth, and tile entities (furnaces, chests).
import { BLOCKS, B, FLUID, SOLID, OPAQUE, fluidId, FACING_DIR } from './blocks.js';
import { WorldGen, CHUNK, HEIGHT, growTree } from './worldgen.js';
import { hash3 } from './noise.js';

export { CHUNK, HEIGHT };
const AREA = CHUNK * CHUNK;
const VOLUME = AREA * HEIGHT;

export const chunkKey = (cx, cz) => `${cx},${cz}`;
export const posKey = (x, y, z) => `${x},${y},${z}`;
const index = (lx, y, lz) => lx + lz * CHUNK + y * AREA;

export class Chunk {
  constructor(cx, cz) {
    this.cx = cx;
    this.cz = cz;
    this.key = chunkKey(cx, cz);
    this.blocks = new Uint16Array(VOLUME);
    this.light = null; // Uint8Array, sky << 4 | block, written by the mesher
    this.dirty = true; // needs a remesh
    this.urgent = false; // remesh before anything else (player edit)
    this.meshed = false;
    this.version = 0; // bumped on every edit (map tiles cache on it)
  }
}

function encodeMods(map) {
  const bytes = new Uint8Array(map.size * 4);
  let o = 0;
  for (const [i, id] of map) {
    bytes[o++] = i & 255;
    bytes[o++] = (i >> 8) & 255;
    bytes[o++] = id & 255;
    bytes[o++] = id >> 8;
  }
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

function decodeMods(text) {
  const s = atob(text);
  const map = new Map();
  for (let o = 0; o + 3 < s.length; o += 4) {
    map.set(s.charCodeAt(o) | (s.charCodeAt(o + 1) << 8), s.charCodeAt(o + 2) | (s.charCodeAt(o + 3) << 8));
  }
  return map;
}

export class World {
  // genVersion: which terrain generator made this world (see GEN_VERSION in worldgen.js).
  constructor(seed, save = null, genVersion = 1) {
    this.seed = seed | 0;
    this.genVersion = genVersion;
    this.gen = new WorldGen(this.seed, genVersion);
    this.chunks = new Map();
    this.mods = new Map();
    this.tiles = new Map();
    this.growth = new Map();
    this.ticks = new Map();
    this.explored = new Set();
    this.lootedCamps = new Set();
    this.time = 1000; // ticks; 24000 per day, 0 = sunrise
    this.day = 0;
    this.clock = 0; // seconds of game time, drives scheduled ticks
    // Hooks the game wires up.
    this.onFall = null;
    this.onDrop = null;
    this.onChunkDirty = null;
    // Multiplayer: while `capture` is an array, setBlock records [x, y, z, id] there
    // so the game can send the player's own edits. `applyingRemote` is set while
    // another player's edits are applied, so they aren't sent back or drop items.
    this.capture = null;
    this.applyingRemote = false;
    if (save) this.load(save);
  }

  // Record edits for chunks that aren't generated yet (a joining player's world).
  addEdits(list) {
    for (const [x, y, z, id] of list) {
      const cx = Math.floor(x / CHUNK);
      const cz = Math.floor(z / CHUNK);
      const key = chunkKey(cx, cz);
      let mods = this.mods.get(key);
      if (!mods) {
        mods = new Map();
        this.mods.set(key, mods);
      }
      mods.set(index(x - cx * CHUNK, y, z - cz * CHUNK), id);
    }
  }

  // Apply another player's edits: live where the chunk is loaded, recorded otherwise.
  applyRemoteEdits(list) {
    this.applyingRemote = true;
    try {
      for (const [x, y, z, id] of list) {
        if (this.isLoaded(x, z)) this.setBlock(x, y, z, id);
        else this.addEdits([[x, y, z, id]]);
      }
    } finally {
      this.applyingRemote = false;
    }
  }

  load(save) {
    for (const [key, text] of Object.entries(save.mods ?? {})) this.mods.set(key, decodeMods(text));
    for (const [key, tile] of save.tiles ?? []) this.tiles.set(key, tile);
    for (const [key, g] of save.growth ?? []) this.growth.set(key, g);
    for (const key of save.explored ?? []) this.explored.add(key);
    this.time = save.time ?? 1000;
    this.day = save.day ?? 0;
    this.clock = save.clock ?? 0;
  }

  serialize() {
    const mods = {};
    for (const [key, map] of this.mods) if (map.size) mods[key] = encodeMods(map);
    return {
      mods,
      tiles: [...this.tiles],
      growth: [...this.growth],
      explored: [...this.explored],
      time: this.time,
      day: this.day,
      clock: this.clock,
    };
  }

  // --- Chunks -----------------------------------------------------------------------

  getChunk(cx, cz) {
    return this.chunks.get(chunkKey(cx, cz));
  }

  generateChunk(cx, cz) {
    const chunk = new Chunk(cx, cz);
    this.gen.generate(chunk);
    const mods = this.mods.get(chunk.key);
    if (mods) for (const [i, id] of mods) chunk.blocks[i] = id;
    this.chunks.set(chunk.key, chunk);
    this.explored.add(chunk.key);
    return chunk;
  }

  unloadChunk(chunk) {
    this.chunks.delete(chunk.key);
  }

  isLoaded(x, z) {
    return this.chunks.has(chunkKey(Math.floor(x / CHUNK), Math.floor(z / CHUNK)));
  }

  getBlock(x, y, z) {
    if (y < 0) return B.bedrock;
    if (y >= HEIGHT) return 0;
    const cx = Math.floor(x / CHUNK);
    const cz = Math.floor(z / CHUNK);
    const chunk = this.chunks.get(chunkKey(cx, cz));
    if (!chunk) return 0;
    return chunk.blocks[index(x - cx * CHUNK, y, z - cz * CHUNK)];
  }

  // Light at a cell: { sky, block } in 0..15. Unmeshed chunks count as fully sky-lit.
  getLight(x, y, z) {
    if (y >= HEIGHT) return { sky: 15, block: 0 };
    if (y < 0) return { sky: 0, block: 0 };
    const cx = Math.floor(x / CHUNK);
    const cz = Math.floor(z / CHUNK);
    const chunk = this.chunks.get(chunkKey(cx, cz));
    if (!chunk?.light) return { sky: 15, block: 0 };
    const v = chunk.light[index(x - cx * CHUNK, y, z - cz * CHUNK)];
    return { sky: v >> 4, block: v & 15 };
  }

  markDirty(x, y, z, lightChanged) {
    const cx = Math.floor(x / CHUNK);
    const cz = Math.floor(z / CHUNK);
    const lx = x - cx * CHUNK;
    const lz = z - cz * CHUNK;
    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        const chunk = this.chunks.get(chunkKey(cx + dx, cz + dz));
        if (!chunk) continue;
        // Neighbors touching the edited block need their faces updated now; the rest only
        // see the light change, which can follow a moment later.
        const touches = (dx === 0 || (dx < 0 ? lx === 0 : lx === CHUNK - 1)) && (dz === 0 || (dz < 0 ? lz === 0 : lz === CHUNK - 1));
        if (touches) {
          chunk.dirty = true;
          chunk.urgent = true;
        } else if (lightChanged) {
          chunk.dirty = true;
        }
      }
    }
    this.onChunkDirty?.();
  }

  // Set a block, record the edit, and run the update rules around it.
  setBlock(x, y, z, id, { silent = false } = {}) {
    if (y < 0 || y >= HEIGHT) return false;
    const cx = Math.floor(x / CHUNK);
    const cz = Math.floor(z / CHUNK);
    const chunk = this.chunks.get(chunkKey(cx, cz));
    if (!chunk) return false;
    const i = index(x - cx * CHUNK, y, z - cz * CHUNK);
    const old = chunk.blocks[i];
    if (old === id) return false;
    chunk.blocks[i] = id;
    chunk.version++;
    let mods = this.mods.get(chunk.key);
    if (!mods) {
      mods = new Map();
      this.mods.set(chunk.key, mods);
    }
    mods.set(i, id);
    if (this.capture && !this.applyingRemote) this.capture.push([x, y, z, id]);
    const lightChanged = OPAQUE[old] !== OPAQUE[id] || BLOCKS[old].emit !== BLOCKS[id].emit || BLOCKS[old].filter !== BLOCKS[id].filter;
    this.markDirty(x, y, z, lightChanged);

    const key = posKey(x, y, z);
    const tile = this.tiles.get(key);
    if (tile && tileTypeOf(id) !== tile.type) {
      this.tiles.delete(key);
      if (!silent) this.dropTileContents(x, y, z, tile);
    }
    this.growth.delete(key);
    const nb = BLOCKS[id];
    if (nb.sapling) this.growth.set(key, { at: this.clock + 60 + Math.random() * 120, kind: 'sapling' });
    if (nb.shelf === 'small') this.growth.set(key, { at: this.clock + 120 + Math.random() * 240, kind: 'shelf' });
    if (nb.oxidizes) this.growth.set(key, { at: this.clock + 900 + Math.random() * 900, kind: 'oxidize' });
    if (nb.crop >= 0 && nb.crop < 7) {
      // Each stage takes 20-40 s on wet farmland, twice that on dry.
      const wet = BLOCKS[this.getBlock(x, y - 1, z)].wet;
      this.growth.set(key, { at: this.clock + (20 + Math.random() * 20) * (wet ? 1 : 2), kind: 'crop' });
    }
    if (!silent) this.neighborsChanged(x, y, z, old, id);
    return true;
  }

  neighborsChanged(x, y, z, old, id) {
    // Fluids: re-evaluate this cell and its six neighbors.
    let fluidNear = FLUID[old] || FLUID[id];
    if (!fluidNear) {
      for (const [dx, dy, dz] of N6) if (FLUID[this.getBlock(x + dx, y + dy, z + dz)]) { fluidNear = true; break; }
    }
    if (fluidNear) {
      this.scheduleTick(x, y, z);
      for (const [dx, dy, dz] of N6) this.scheduleTick(x + dx, y + dy, z + dz);
    }
    // Gravity blocks.
    this.checkFall(x, y, z);
    this.checkFall(x, y + 1, z);
    // Things that need support.
    this.checkSupport(x, y + 1, z);
    this.checkSupport(x, y - 1, z);
    for (const [dx, , dz] of N4) this.checkSupport(x + dx, y, z + dz);
  }

  checkFall(x, y, z) {
    const id = this.getBlock(x, y, z);
    if (!BLOCKS[id].falls) return;
    const below = this.getBlock(x, y - 1, z);
    if (below === 0 || FLUID[below] || BLOCKS[below].washable || BLOCKS[below].replaceable) {
      this.setBlock(x, y, z, 0);
      this.onFall?.(x, y, z, id);
    }
  }

  checkSupport(x, y, z) {
    const id = this.getBlock(x, y, z);
    const b = BLOCKS[id];
    if (!id) return;
    let ok = true;
    const below = this.getBlock(x, y - 1, z);
    if (b.plant) {
      ok = canPlantOn(id, below);
    } else if (id === B.torch) {
      ok = !!SOLID[below] || N4.some(([dx, , dz]) => OPAQUE[this.getBlock(x + dx, y, z + dz)]);
    } else if (b.shelf) {
      const [fx, fz] = FACING_DIR[b.facing];
      const behind = BLOCKS[this.getBlock(x - fx, y, z - fz)];
      ok = !!behind.name.endsWith('_log');
    } else if (id === B.cactus) {
      ok = below === B.sand || below === B.cactus;
    } else if (b.door) {
      // The two halves of a door go together; the bottom half stands on solid ground.
      const other = BLOCKS[this.getBlock(x, y + (b.door === 'lower' ? 1 : -1), z)];
      ok = other.baseId === b.partnerBase && (b.door === 'upper' || !!SOLID[below]);
    } else if (b.carpet) {
      ok = below !== 0 && !FLUID[below];
    } else if (b.crop >= 0) {
      ok = BLOCKS[below].farmland;
    } else if (b.farmland) {
      // A solid block on farmland packs it back down to dirt.
      if (SOLID[this.getBlock(x, y + 1, z)]) this.setBlock(x, y, z, B.dirt);
      return;
    } else if (b.bed) {
      const [fx, fz] = FACING_DIR[b.facing];
      const s = b.bed === 'foot' ? 1 : -1;
      ok = BLOCKS[this.getBlock(x + fx * s, y, z + fz * s)].baseId === b.partnerBase;
    } else if (b.hangs) {
      // Vines, roots, spore blossoms and dripstone hang from a solid block (or from more
      // of themselves).
      const above = this.getBlock(x, y + 1, z);
      ok = !!SOLID[above] || BLOCKS[above].hangs === b.hangs;
    } else if (b.stands) {
      ok = !!SOLID[below] || BLOCKS[below].stands === b.stands;
    } else if (b.candle) {
      ok = !!SOLID[below];
    } else if (b.climbable || b.wallPlant) {
      const [fx, fz] = FACING_DIR[b.facing];
      ok = !!OPAQUE[this.getBlock(x + fx, y, z + fz)];
    } else {
      return;
    }
    if (!ok) this.breakBlock(x, y, z, true);
  }

  // --- Farmland ---------------------------------------------------------------------------

  // Water within 4 blocks sideways, at the same height or one above.
  hasWaterNear(x, y, z) {
    for (let dy = 0; dy <= 1; dy++) for (let dz = -4; dz <= 4; dz++) for (let dx = -4; dx <= 4; dx++) {
      if (FLUID[this.getBlock(x + dx, y + dy, z + dz)] === 1) return true;
    }
    return false;
  }

  // Wet or dry a farmland block to match the water around it.
  hydrate(x, y, z) {
    const b = BLOCKS[this.getBlock(x, y, z)];
    if (!b.farmland) return;
    const want = this.hasWaterNear(x, y, z) ? B.wet_farmland : B.farmland;
    if (want !== b.id) this.setBlock(x, y, z, want);
  }

  hydrateAround(x, y, z) {
    for (let dy = -1; dy <= 0; dy++) for (let dz = -4; dz <= 4; dz++) for (let dx = -4; dx <= 4; dx++) this.hydrate(x + dx, y + dy, z + dz);
  }

  // Remove a block and drop what it would drop when broken by hand.
  breakBlock(x, y, z, drops = true) {
    const id = this.getBlock(x, y, z);
    this.setBlock(x, y, z, 0);
    if (drops) this.onDrop?.(x, y, z, id);
  }

  dropTileContents(x, y, z, tile) {
    for (const s of tile.slots ?? []) if (s) this.onDrop?.(x, y, z, null, s);
  }

  // --- Scheduled ticks (fluids) ---------------------------------------------------------

  scheduleTick(x, y, z, delay = 0.25) {
    if (y < 0 || y >= HEIGHT) return;
    const key = posKey(x, y, z);
    const due = this.clock + delay;
    const cur = this.ticks.get(key);
    if (!cur || cur.at > due) this.ticks.set(key, { x, y, z, at: due, lava: cur?.lava ?? false });
  }

  processTicks(limit = 400) {
    let n = 0;
    for (const [key, t] of this.ticks) {
      if (t.at > this.clock) continue;
      this.ticks.delete(key);
      if (!this.isLoaded(t.x, t.z)) continue;
      this.tickFluid(t);
      if (++n >= limit) break;
    }
  }

  tickFluid(t) {
    const { x, y, z } = t;
    const id = this.getBlock(x, y, z);
    const b = BLOCKS[id];
    const kind = FLUID[id];
    if (kind && b.source) {
      if (kind === 2 && this.touchesFluid(x, y, z, 1)) this.setBlock(x, y, z, B.obsidian);
      return;
    }
    if (!(id === 0 || kind || b.washable)) return;
    let want = this.desiredFluid(x, y, z, 1) || this.desiredFluid(x, y, z, 2);
    if (!want && !kind) return;
    if (want && FLUID[want] === 2 && this.touchesFluid(x, y, z, 1)) want = B.cobblestone;
    if (want === id) return;
    // Lava creeps: wait a little longer before it actually moves.
    const lavaMove = (want && FLUID[want] === 2) || (!want && kind === 2);
    if (lavaMove && !t.lava) {
      const key = posKey(x, y, z);
      this.ticks.set(key, { x, y, z, at: this.clock + 1.25, lava: true });
      return;
    }
    if (b.washable && want) this.onDrop?.(x, y, z, id);
    this.setBlock(x, y, z, want);
  }

  touchesFluid(x, y, z, kind) {
    for (const [dx, dy, dz] of N6) if (FLUID[this.getBlock(x + dx, y + dy, z + dz)] === kind) return true;
    return false;
  }

  desiredFluid(x, y, z, kind) {
    const above = this.getBlock(x, y + 1, z);
    if (FLUID[above] === kind) return fluidId(kind, 0, true);
    const step = kind === 1 ? 1 : 2;
    const max = kind === 1 ? 7 : 6;
    let best = 99;
    let sources = 0;
    for (const [dx, , dz] of N4) {
      const n = this.getBlock(x + dx, y, z + dz);
      if (FLUID[n] !== kind) continue;
      const nb = BLOCKS[n];
      if (nb.source) sources++;
      const below = this.getBlock(x + dx, y - 1, z + dz);
      const canFall = below === 0 || BLOCKS[below].washable || FLUID[below] === kind;
      if (canFall) continue;
      const level = nb.source || nb.fallingFluid ? 0 : nb.fluidLevel;
      best = Math.min(best, level + step);
    }
    if (kind === 1 && sources >= 2) {
      const below = this.getBlock(x, y - 1, z);
      if (SOLID[below] || below === B.water) return B.water;
    }
    return best <= max ? fluidId(kind, best) : 0;
  }

  // --- Growth ---------------------------------------------------------------------------

  processGrowth() {
    for (const [key, g] of this.growth) {
      if (g.at > this.clock) continue;
      const [x, y, z] = key.split(',').map(Number);
      if (!this.isLoaded(x, z)) continue;
      const id = this.getBlock(x, y, z);
      const b = BLOCKS[id];
      if (g.kind === 'sapling' && b.sapling) {
        if (!this.growSapling(x, y, z, b.sapling)) g.at = this.clock + 30 + Math.random() * 60;
        else this.growth.delete(key);
      } else if (g.kind === 'shelf' && b.shelf === 'small') {
        this.growth.delete(key);
        this.setBlock(x, y, z, B.large_shelf_mushroom + b.facing);
      } else if (g.kind === 'oxidize' && b.oxidizes) {
        this.growth.delete(key);
        this.setBlock(x, y, z, B[b.oxidizes]);
      } else if (g.kind === 'crop' && b.crop >= 0 && b.crop < 7) {
        this.growth.delete(key);
        this.hydrate(x, y - 1, z);
        this.setBlock(x, y, z, B[`wheat_${b.crop + 1}`]);
      } else {
        this.growth.delete(key);
      }
      break; // one per frame is plenty
    }
  }

  growSapling(x, y, z, type) {
    const tall = type === 'poplar' ? 12 : type === 'spruce' ? 10 : type === 'azalea' ? 6 : 7;
    for (let k = 1; k <= tall; k++) {
      const id = this.getBlock(x, y + k, z);
      if (id !== 0 && !BLOCKS[id].leaves) return false;
    }
    const seed = Math.floor(Math.random() * 1e9);
    this.setBlock(x, y, z, 0, { silent: true });
    growTree(type, x, y, z, (k) => hash3(x, k, z, seed), (px, py, pz, id, force) => {
      const cur = this.getBlock(px, py, pz);
      if (force || cur === 0 || BLOCKS[cur].replaceable || BLOCKS[cur].plant) this.setBlock(px, py, pz, id, { silent: true });
    });
    return true;
  }

  // --- Tile entities ----------------------------------------------------------------------

  getTile(x, y, z, create = true) {
    const key = posKey(x, y, z);
    let tile = this.tiles.get(key);
    if (tile || !create) return tile ?? null;
    const id = this.getBlock(x, y, z);
    const type = tileTypeOf(id);
    if (!type) return null;
    if (type === 'furnace') tile = { type, slots: [null, null, null], burn: 0, burnMax: 0, cook: 0 };
    else if (type === 'chest') tile = { type, slots: this.gen.lootFor(x, y, z) ?? new Array(27).fill(null) };
    else if (type === 'campfire') tile = { type, slots: [null, null, null, null], cook: [0, 0, 0, 0] };
    this.tiles.set(key, tile);
    return tile;
  }

  // Containers broken before being opened still spill their camp loot.
  ensureLoot(x, y, z) {
    const id = this.getBlock(x, y, z);
    if (tileTypeOf(id) === 'chest') this.getTile(x, y, z, true);
  }

  updateTiles(dt, smelt) {
    for (const [key, tile] of this.tiles) {
      if (tile.type === 'furnace') this.updateFurnace(key, tile, dt, smelt);
      else if (tile.type === 'campfire') this.updateCampfire(key, tile, dt, smelt);
    }
  }

  updateFurnace(key, tile, dt, { recipeFor, fuelFor, maxStack }) {
    const [input, fuel, output] = tile.slots;
    const result = input ? recipeFor(input.id) : null;
    const canOutput = result && (!output || (output.id === result && output.count < maxStack(result)));
    if (tile.burn <= 0 && canOutput && fuel && fuelFor(fuel.id) > 0) {
      tile.burn = tile.burnMax = fuelFor(fuel.id);
      fuel.count--;
      if (fuel.count <= 0) tile.slots[1] = null;
    }
    const wasLit = tile.lit;
    if (tile.burn > 0) {
      tile.burn -= dt;
      if (canOutput) {
        tile.cook += dt;
        if (tile.cook >= 10) {
          tile.cook = 0;
          input.count--;
          if (input.count <= 0) tile.slots[0] = null;
          if (output) output.count++;
          else tile.slots[2] = { id: result, count: 1 };
        }
      } else {
        tile.cook = 0;
      }
    } else {
      tile.burn = 0;
      tile.cook = Math.max(0, tile.cook - dt * 2);
    }
    tile.lit = tile.burn > 0;
    if (tile.lit !== wasLit) {
      const [x, y, z] = key.split(',').map(Number);
      const id = this.getBlock(x, y, z);
      const b = BLOCKS[id];
      if (b.interact === 'furnace') {
        const base = tile.lit ? B.furnace_lit : B.furnace;
        this.setBlock(x, y, z, base + Math.max(0, b.facing), { silent: true });
      }
    }
  }

  updateCampfire(key, tile, dt, { recipeFor }) {
    for (let i = 0; i < 4; i++) {
      const s = tile.slots[i];
      if (!s) continue;
      tile.cook[i] += dt;
      if (tile.cook[i] >= 12) {
        const [x, y, z] = key.split(',').map(Number);
        const out = recipeFor(s.id) ?? s.id;
        tile.slots[i] = null;
        tile.cook[i] = 0;
        this.onDrop?.(x, y + 0.5, z, null, { id: out, count: 1 });
      }
    }
  }

  // --- Misc -----------------------------------------------------------------------------

  // Topmost non-air block at a column (for spawning and map).
  surfaceY(x, z) {
    for (let y = HEIGHT - 1; y > 0; y--) {
      const id = this.getBlock(x, y, z);
      if (id && SOLID[id]) return y;
    }
    return 0;
  }
}

const N6 = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
const N4 = [[1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1]];

export function tileTypeOf(id) {
  const i = BLOCKS[id]?.interact;
  if (i === 'furnace') return 'furnace';
  if (i === 'chest') return 'chest';
  if (i === 'campfire') return 'campfire';
  return null;
}

export function canPlantOn(id, below) {
  const b = BLOCKS[id];
  if (id === B.dead_bush) return below === B.sand;
  if (b.crop >= 0) return BLOCKS[below].farmland;
  if (b.plant) return below === B.grass || below === B.dirt || below === B.snowy_grass || below === B.moss_block || below === B.rooted_dirt;
  return true;
}
