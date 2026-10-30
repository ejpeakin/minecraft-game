// Seeded terrain generator. Everything here is a pure function of (seed, x, z), so a
// chunk regenerates identically after being unloaded; player edits are layered on top
// by World. Features that cross chunk borders (trees, camps) are evaluated for nearby
// origins and clipped to the chunk being built.
import { B, COLORS } from './blocks.js';
import { createNoise2D, createNoise3D, fbm2, ridged2, hash3, mulberry32, smoothstep } from './noise.js';

export const CHUNK = 16;
export const HEIGHT = 128;
export const SEA = 48;

export const BIOME = {
  OCEAN: 0, BEACH: 1, PLAINS: 2, FOREST: 3, DESERT: 4, SNOWY: 5, TAIGA: 6, MOUNTAINS: 7, DAPPLED: 8, FROZEN_OCEAN: 9,
  JAGGED_PEAKS: 10, FROZEN_PEAKS: 11, STONY_PEAKS: 12, SNOWY_SLOPES: 13, GROVE: 14, MEADOW: 15,
};
export const BIOME_NAME = ['Ocean', 'Beach', 'Plains', 'Forest', 'Desert', 'Snowy Plains', 'Taiga', 'Mountains', 'Dappled Forest', 'Frozen Ocean',
  'Jagged Peaks', 'Frozen Peaks', 'Stony Peaks', 'Snowy Slopes', 'Grove', 'Meadow'];
const PEAKS = new Set([BIOME.JAGGED_PEAKS, BIOME.FROZEN_PEAKS, BIOME.STONY_PEAKS, BIOME.SNOWY_SLOPES, BIOME.GROVE, BIOME.MEADOW]);

// World generation versions. 1 is the original; 2 (Caves & Cliffs) adds deepslate, new
// ores and stones, big caves with underground lakes, lush and dripstone caves, amethyst
// geodes, and taller, cliffier mountains. Worlds keep the version they were made with,
// so an old save's terrain never changes under the player's builds.
export const GEN_VERSION = 2;
const DEEPSLATE_TOP = 12; // solid deepslate below this, mixing into stone up to +8
const GEODE_REGION = 48;
const DEEP_ORE = {};
for (const ore of ['coal', 'iron', 'gold', 'diamond', 'copper', 'redstone', 'lapis', 'emerald']) DEEP_ORE[B[`${ore}_ore`]] = B[`deepslate_${ore}_ore`];
const DIRS = [[0, 1], [-1, 0], [0, -1], [1, 0]]; // facing 0-3, as in blocks.js
const CAVE_WALL = new Set([B.stone, B.deepslate, B.dirt, B.gravel, B.tuff, B.granite, B.diorite, B.andesite, B.calcite]);

const CAMP_REGION = 160;
const CAMP_RADIUS = 8;
const POPLAR_LEAVES = [B.red_poplar_leaves, B.orange_poplar_leaves, B.yellow_poplar_leaves];
const TENT_COLORS = ['white', 'brown', 'green', 'light_gray', 'orange', 'red'];

export class WorldGen {
  constructor(seed, version = 1) {
    this.seed = seed | 0;
    this.version = version;
    this.v2 = version >= 2;
    const r = mulberry32(this.seed);
    this.nCont = createNoise2D(r);
    this.nHill = createNoise2D(r);
    this.nMount = createNoise2D(r);
    this.nRidge = createNoise2D(r);
    this.nTemp = createNoise2D(r);
    this.nHum = createNoise2D(r);
    this.nDetail = createNoise2D(r);
    this.nEntrance = createNoise2D(r);
    this.nCaveA = createNoise3D(r);
    this.nCaveB = createNoise3D(r);
    this.nCheese = createNoise3D(r);
    // Version 2 noises come after the original ones so those stay the same.
    this.nJag = createNoise2D(r);
    this.nCliff = createNoise2D(r);
    this.nAquifer = createNoise2D(r);
    this.nLush = createNoise2D(r);
    this.nDrip = createNoise2D(r);
    this.colCache = new Map();
    this.campCache = new Map();
  }

  // --- Columns -----------------------------------------------------------------------

  column(x, z) {
    const key = x * 100003 + z;
    let c = this.colCache.get(key);
    if (c) return c;
    if (this.colCache.size > 60000) this.colCache.clear();
    const cont = fbm2(this.nCont, x * 0.0013, z * 0.0013, 4);
    const land = smoothstep(-0.3, -0.1, cont);
    const hills = fbm2(this.nHill, x * 0.007, z * 0.007, 5);
    const mount = smoothstep(0.08, 0.45, fbm2(this.nMount, x * 0.0022, z * 0.0022, 3)) * land;
    const ridge = ridged2(this.nRidge, x * 0.006, z * 0.006, 4);
    const temp = fbm2(this.nTemp, x * 0.0016, z * 0.0016, 3) + this.nDetail(x * 0.05, z * 0.05) * 0.02;
    const hum = fbm2(this.nHum, x * 0.0019 + 50, z * 0.0019 - 50, 3);
    let height = SEA - 16 + land * 20 + hills * (4 + 9 * land) + mount * ridge * 52;
    if (this.v2 && mount > 0) {
      // Caves & Cliffs mountains: taller, sharper peaks, and stepped cliffs in places.
      const jag = ridged2(this.nJag, x * 0.021, z * 0.021, 3);
      height = SEA - 16 + land * 20 + hills * (4 + 9 * land) + mount * (Math.pow(ridge, 1.5) * 64 + jag * 12 * mount);
      const cliff = smoothstep(0.05, 0.35, this.nCliff(x * 0.005, z * 0.005)) * smoothstep(0.05, 0.3, mount);
      if (cliff > 0) {
        const t = height / 7;
        const stepped = (Math.floor(t) + smoothstep(0.3, 0.7, t - Math.floor(t))) * 7;
        height += (stepped - height) * cliff;
      }
    }
    height = Math.max(4, Math.min(HEIGHT - (this.v2 ? 6 : 8), Math.round(height)));
    let biome;
    if (height < SEA - 1) biome = temp < -0.4 ? BIOME.FROZEN_OCEAN : BIOME.OCEAN;
    else if (this.v2 && mount > 0.3 && height > 74) {
      if (height >= 104) biome = temp < -0.15 ? BIOME.FROZEN_PEAKS : temp > 0.25 ? BIOME.STONY_PEAKS : BIOME.JAGGED_PEAKS;
      else if (height >= 90) biome = temp < 0.12 ? BIOME.SNOWY_SLOPES : BIOME.STONY_PEAKS;
      else biome = temp < -0.1 ? BIOME.GROVE : BIOME.MEADOW;
    } else if (mount > 0.3 && height > 74) biome = BIOME.MOUNTAINS;
    else if (height <= SEA && temp > -0.4) biome = BIOME.BEACH;
    else if (temp < -0.4) biome = BIOME.SNOWY;
    else if (temp < -0.2) biome = BIOME.TAIGA;
    else if (temp < 0.12 && hum > -0.25) biome = BIOME.DAPPLED;
    else if (temp > 0.33 && hum < 0.05) biome = BIOME.DESERT;
    else if (hum > 0.12) biome = BIOME.FOREST;
    else biome = BIOME.PLAINS;
    c = { height, biome, temp, hum, mount, detail: this.nDetail(x * 0.09, z * 0.09) };
    if (this.v2) {
      // Underground lakes fill caves up to this height (-1: none here).
      const aq = this.nAquifer(x * 0.007, z * 0.007);
      c.aquifer = aq > 0.1 ? Math.min(height - 10, 12 + Math.floor((aq - 0.1) * 46)) : -1;
      // Cave biomes under this column.
      c.lush = this.nLush(x * 0.009, z * 0.009) > 0.32 && hum > -0.2;
      c.drip = !c.lush && this.nDrip(x * 0.011, z * 0.011) > 0.38;
    }
    this.colCache.set(key, c);
    return c;
  }

  surfaceBlocks(col) {
    switch (col.biome) {
      case BIOME.OCEAN:
      case BIOME.FROZEN_OCEAN:
        return col.height > SEA - 7 || col.detail > 0.2 ? [B.sand, B.sand, B.sand] : [B.gravel, B.gravel, B.dirt];
      case BIOME.BEACH:
      case BIOME.DESERT:
        return [B.sand, B.sand, B.sand, B.sand, B.sandstone, B.sandstone, B.sandstone];
      case BIOME.SNOWY:
        return [B.snowy_grass, B.dirt, B.dirt, B.dirt];
      case BIOME.MOUNTAINS:
        if (col.height > 100) return [B.snow_block, B.stone];
        if (col.height < 92 && col.detail > 0.1) return [B.grass, B.dirt, B.dirt];
        return [B.stone];
      case BIOME.JAGGED_PEAKS:
        return col.height > 98 ? [B.snow_block, B.snow_block, B.stone] : [B.stone];
      case BIOME.FROZEN_PEAKS:
        return col.detail > 0.15 ? [B.packed_ice, B.packed_ice, B.stone] : [B.snow_block, B.snow_block, B.packed_ice];
      case BIOME.STONY_PEAKS:
        return col.detail > 0.35 ? [B.calcite, B.calcite, B.stone] : [B.stone];
      case BIOME.SNOWY_SLOPES:
        return col.detail > 0.32 ? [B.powder_snow, B.powder_snow, B.snow_block, B.stone] : [B.snow_block, B.snow_block, B.stone];
      case BIOME.GROVE:
        return col.detail > 0.45 ? [B.powder_snow, B.snow_block, B.dirt] : [B.snowy_grass, B.dirt, B.dirt, B.dirt];
      case BIOME.MEADOW:
        return [B.grass, B.dirt, B.dirt, B.dirt];
      default:
        return [B.grass, B.dirt, B.dirt, B.dirt];
    }
  }

  // Interpolated cave noise lattice for one chunk: 5 x 33 x 5 samples, 4 blocks apart.
  caveLattice(cx, cz) {
    const lat = new Float32Array(5 * 33 * 5 * 3);
    let i = 0;
    for (let ly = 0; ly < 33; ly++) {
      const y = ly * 4;
      for (let lz = 0; lz < 5; lz++) {
        const z = cz * CHUNK + lz * 4;
        for (let lx = 0; lx < 5; lx++) {
          const x = cx * CHUNK + lx * 4;
          lat[i++] = this.nCaveA(x * 0.032, y * 0.055, z * 0.032);
          lat[i++] = this.nCaveB(x * 0.032 + 71, y * 0.055, z * 0.032 - 31);
          lat[i++] = this.nCheese(x * 0.018, y * 0.035, z * 0.018);
        }
      }
    }
    return lat;
  }

  // Cave test at local coordinates using a chunk lattice.
  carved(lat, lx, y, lz, col) {
    if (y < 2) return false;
    const surface = col.height;
    if (col.height < SEA && y > surface - 5) return false;
    if (y > surface - 3) {
      if (y > surface) return false;
      if (this.nEntrance(col.x * 0.012, col.z * 0.012) < 0.55) return false;
    }
    const fx = lx / 4, fy = y / 4, fz = lz / 4;
    const x0 = Math.floor(fx), y0 = Math.min(31, Math.floor(fy)), z0 = Math.floor(fz);
    const tx = fx - x0, ty = fy - y0, tz = fz - z0;
    const sample = (k) => {
      const at = (ix, iy, iz) => lat[((iy * 5 + iz) * 5 + ix) * 3 + k];
      const a = at(x0, y0, z0) + (at(x0 + 1, y0, z0) - at(x0, y0, z0)) * tx;
      const b = at(x0, y0, z0 + 1) + (at(x0 + 1, y0, z0 + 1) - at(x0, y0, z0 + 1)) * tx;
      const c = at(x0, y0 + 1, z0) + (at(x0 + 1, y0 + 1, z0) - at(x0, y0 + 1, z0)) * tx;
      const d = at(x0, y0 + 1, z0 + 1) + (at(x0 + 1, y0 + 1, z0 + 1) - at(x0, y0 + 1, z0 + 1)) * tx;
      const e = a + (b - a) * tz;
      const f = c + (d - c) * tz;
      return e + (f - e) * ty;
    };
    const a = sample(0);
    const b = sample(1);
    const width = 0.085 + (y < 30 ? 0.03 : 0) + (this.v2 ? 0.01 : 0);
    if (Math.abs(a) < width && Math.abs(b) < width) return true;
    // Version 2: big open caverns deep down, smaller ones higher up.
    if (this.v2) return y < 56 && sample(2) > 0.6 - smoothstep(44, 12, y) * 0.13;
    return y < 50 && sample(2) > 0.6;
  }

  // --- Chunk ---------------------------------------------------------------------------

  generate(chunk) {
    const { cx, cz, blocks } = chunk;
    const ox = cx * CHUNK;
    const oz = cz * CHUNK;
    const lat = this.caveLattice(cx, cz);
    const rng = mulberry32(this.seed ^ Math.imul(cx, 73856093) ^ Math.imul(cz, 19349663));
    const idx = (x, y, z) => x + z * CHUNK + y * CHUNK * CHUNK;

    for (let lz = 0; lz < CHUNK; lz++) {
      for (let lx = 0; lx < CHUNK; lx++) {
        const x = ox + lx;
        const z = oz + lz;
        const col = this.column(x, z);
        col.x = x;
        col.z = z;
        const h = col.height;
        const surf = this.v2 && this.steep(x, z, col) ? [B.stone] : this.surfaceBlocks(col);
        const bands = col.biome === BIOME.STONY_PEAKS ? Math.floor(col.detail * 4 + 4) : -1;
        for (let y = 0; y <= h; y++) {
          let id;
          if (y === 0 || (y < 4 && hash3(x, y, z, this.seed) < 0.5 - y * 0.12)) id = B.bedrock;
          else {
            const depth = h - y;
            id = depth < surf.length ? surf[depth] : B.stone;
            if (id === B.grass && h < SEA) id = B.dirt;
            if (!this.v2) {
              if (this.carved(lat, lx, y, lz, col)) id = y <= 10 ? B.lava : 0;
            } else {
              if (id === B.stone) {
                // Deepslate at the bottom, blending into stone; calcite bands in stony peaks.
                if (y < DEEPSLATE_TOP || (y < DEEPSLATE_TOP + 8 && hash3(x, y, z, this.seed + 5) < (DEEPSLATE_TOP + 8 - y) / 9)) id = B.deepslate;
                else if (bands >= 0 && depth < 16 && (y + bands) % 11 < 2) id = B.calcite;
              }
              if (this.carved(lat, lx, y, lz, col)) id = y <= 6 ? B.lava : y <= col.aquifer ? B.water : 0;
            }
          }
          blocks[idx(lx, y, lz)] = id;
        }
        for (let y = h + 1; y <= SEA; y++) {
          const frozen = col.temp < -0.4 && y === SEA;
          blocks[idx(lx, y, lz)] = frozen ? B.ice : B.water;
        }
      }
    }

    this.placeOres(blocks, rng, idx);
    if (this.v2) {
      this.placeRocks(blocks, rng, idx);
      this.placeEmeralds(blocks, rng, idx, ox, oz);
      this.decorateCaves(blocks, idx, ox, oz);
      this.placeGeodes(blocks, idx, ox, oz);
    }

    const camps = this.campsNear(ox - CAMP_RADIUS - 2, oz - CAMP_RADIUS - 2, ox + CHUNK + CAMP_RADIUS + 2, oz + CHUNK + CAMP_RADIUS + 2);
    const put = (x, y, z, id, force = false) => {
      const lx = x - ox;
      const lz = z - oz;
      if (lx < 0 || lz < 0 || lx >= CHUNK || lz >= CHUNK || y < 1 || y >= HEIGHT) return;
      const i = idx(lx, y, lz);
      const cur = blocks[i];
      if (force || cur === 0 || cur === B.tall_grass || (isLeafId(cur) && !isLeafId(id))) blocks[i] = id;
    };
    const get = (x, y, z) => {
      const lx = x - ox;
      const lz = z - oz;
      if (lx < 0 || lz < 0 || lx >= CHUNK || lz >= CHUNK || y < 0 || y >= HEIGHT) return -1;
      return blocks[idx(lx, y, lz)];
    };

    // Trees and fallen logs from origins up to 5 blocks outside the chunk.
    for (let z = oz - 5; z < oz + CHUNK + 5; z++) {
      for (let x = ox - 5; x < ox + CHUNK + 5; x++) {
        if (camps.some((c) => Math.abs(c.x - x) <= CAMP_RADIUS + 1 && Math.abs(c.z - z) <= CAMP_RADIUS + 1)) continue;
        this.decorateFeature(x, z, put);
      }
    }

    // Small plants inside the chunk only.
    for (let lz = 0; lz < CHUNK; lz++) {
      for (let lx = 0; lx < CHUNK; lx++) {
        const x = ox + lx;
        const z = oz + lz;
        const col = this.column(x, z);
        const h = col.height;
        if (h < SEA || h + 1 >= HEIGHT) continue;
        const ground = blocks[idx(lx, h, lz)];
        if (blocks[idx(lx, h + 1, lz)] !== 0) continue;
        const r = hash3(x, 7, z, this.seed);
        let plant = 0;
        if (ground === B.grass) {
          if (col.biome === BIOME.PLAINS) plant = r < 0.14 ? B.tall_grass : r < 0.155 ? B.dandelion : r < 0.165 ? B.poppy : 0;
          else if (col.biome === BIOME.FOREST) plant = r < 0.07 ? B.tall_grass : r < 0.08 ? B.poppy : 0;
          else if (col.biome === BIOME.DAPPLED) plant = r < 0.06 ? B.red_shrub : r < 0.14 ? B.tall_grass : r < 0.145 ? B.dandelion : 0;
          else if (col.biome === BIOME.TAIGA) plant = r < 0.05 ? B.tall_grass : 0;
          else if (col.biome === BIOME.MOUNTAINS) plant = r < 0.03 ? B.tall_grass : 0;
          else if (col.biome === BIOME.MEADOW) plant = r < 0.3 ? B.tall_grass : r < 0.36 ? B.dandelion : r < 0.42 ? B.poppy : 0;
        } else if (ground === B.sand && col.biome === BIOME.DESERT) {
          if (r < 0.006) plant = B.dead_bush;
          else if (r < 0.011) {
            const hgt = 1 + Math.floor(hash3(x, 9, z, this.seed) * 3);
            for (let k = 1; k <= hgt; k++) put(x, h + k, z, B.cactus);
          }
        }
        if (plant) blocks[idx(lx, h + 1, lz)] = plant;
      }
    }

    for (const camp of camps) this.buildCamp(camp, put, get);
  }

  placeOres(blocks, rng, idx) {
    // Version 2 spreads ores like Minecraft 1.18 (squeezed into this world's height).
    const veins = this.v2 ? [
      [B.coal_ore, 16, 10, 20, 120],
      [B.copper_ore, 10, 9, 8, 80],
      [B.iron_ore, 12, 7, 2, 72],
      [B.gold_ore, 3, 7, 2, 32],
      [B.redstone_ore, 6, 7, 2, 16],
      [B.lapis_ore, 2, 6, 2, 32],
      [B.diamond_ore, 2, 5, 2, 16],
      [B.gravel, 4, 14, 10, 80],
      [B.dirt, 4, 14, 20, 80],
    ] : [
      [B.coal_ore, 18, 8, 5, 110],
      [B.iron_ore, 10, 6, 5, 64],
      [B.gold_ore, 2, 6, 5, 32],
      [B.diamond_ore, 1, 5, 5, 16],
      [B.gravel, 4, 14, 10, 80],
      [B.dirt, 4, 14, 10, 80],
    ];
    for (const [ore, count, size, minY, maxY] of veins) {
      for (let v = 0; v < count; v++) {
        let x = rng() * CHUNK;
        let y = minY + rng() * (maxY - minY);
        let z = rng() * CHUNK;
        for (let s = 0; s < size; s++) {
          const ix = Math.floor(x), iy = Math.floor(y), iz = Math.floor(z);
          if (ix >= 0 && iz >= 0 && ix < CHUNK && iz < CHUNK && iy > 0 && iy < HEIGHT) {
            const i = idx(ix, iy, iz);
            if (blocks[i] === B.stone) blocks[i] = ore;
            else if (this.v2 && blocks[i] === B.deepslate && DEEP_ORE[ore]) blocks[i] = DEEP_ORE[ore];
          }
          x += rng() * 2 - 1;
          y += rng() * 2 - 1;
          z += rng() * 2 - 1;
        }
      }
    }
  }

  // Version 2 extras, in the chunk's own blocks (no cross-chunk features).

  // Blobs of granite, diorite and andesite in stone, tuff in deepslate.
  placeRocks(blocks, rng, idx) {
    for (const [rock, count, minY, maxY] of [[B.granite, 2, 20, 100], [B.diorite, 2, 20, 100], [B.andesite, 2, 20, 100], [B.tuff, 2, 2, 20]]) {
      for (let n = 0; n < count; n++) {
        const rad = 2 + rng() * 2.2;
        const cx = rad + rng() * (CHUNK - 2 * rad), cz = rad + rng() * (CHUNK - 2 * rad), cy = minY + rng() * (maxY - minY);
        for (let y = Math.floor(cy - rad); y <= cy + rad; y++) {
          if (y < 1 || y >= HEIGHT) continue;
          for (let z = Math.floor(cz - rad); z <= cz + rad; z++) for (let x = Math.floor(cx - rad); x <= cx + rad; x++) {
            const dx = x + 0.5 - cx, dy = (y + 0.5 - cy) * 1.3, dz = z + 0.5 - cz;
            if (dx * dx + dy * dy + dz * dz > rad * rad) continue;
            const i = idx(x, y, z);
            if (blocks[i] === B.stone || blocks[i] === B.deepslate) blocks[i] = rock;
          }
        }
      }
    }
  }

  // Emerald ore, only inside mountains.
  placeEmeralds(blocks, rng, idx, ox, oz) {
    for (let n = 0; n < 4; n++) {
      const x = Math.floor(rng() * CHUNK), z = Math.floor(rng() * CHUNK);
      const col = this.column(ox + x, oz + z);
      const y = 40 + Math.floor(rng() * Math.max(1, col.height - 46));
      if (!PEAKS.has(col.biome)) continue;
      const i = idx(x, y, z);
      if (blocks[i] === B.stone) blocks[i] = B.emerald_ore;
    }
  }

  // Lush caves (moss, azaleas, glowing cave vines, spore blossoms), dripstone caves
  // (dripstone blocks and spikes) and glow lichen on the walls of the rest.
  decorateCaves(blocks, idx, ox, oz) {
    const UP = CHUNK * CHUNK;
    for (let lz = 0; lz < CHUNK; lz++) for (let lx = 0; lx < CHUNK; lx++) {
      const x = ox + lx, z = oz + lz;
      const col = this.column(x, z);
      const top = Math.min(col.height - 3, HEIGHT - 2);
      for (let y = 2; y < top; y++) {
        const i = idx(lx, y, lz);
        if (blocks[i] !== 0) continue;
        const below = blocks[i - UP], above = blocks[i + UP];
        const r = hash3(x, y, z, this.seed + 31);
        const r2 = hash3(x, y, z, this.seed + 32);
        if (col.lush) {
          if (CAVE_WALL.has(below)) {
            blocks[i - UP] = B.moss_block;
            if (r < 0.28) blocks[i] = B.moss_carpet;
            else if (r < 0.32) blocks[i] = B.azalea;
            else if (r < 0.345) blocks[i] = B.flowering_azalea;
            else if (r < 0.45) blocks[i] = B.tall_grass;
          } else if (CAVE_WALL.has(above)) {
            blocks[i + UP] = B.moss_block;
            if (r < 0.11) {
              const len = 1 + Math.floor(r2 * 5);
              for (let k = 0; k < len && y - k > 1 && blocks[i - k * UP] === 0; k++) {
                blocks[i - k * UP] = hash3(x, y - k, z, this.seed + 33) < 0.35 ? B.cave_vines_lit : B.cave_vines;
              }
            } else if (r < 0.122) blocks[i] = B.spore_blossom;
          }
        } else if (col.drip) {
          if (CAVE_WALL.has(below)) {
            if (r2 < 0.7) blocks[i - UP] = B.dripstone_block;
            if (r < 0.1) {
              const len = 1 + Math.floor(r2 * 3);
              for (let k = 0; k < len && y + k < top && blocks[i + k * UP] === 0; k++) blocks[i + k * UP] = B.pointed_dripstone;
            }
          } else if (CAVE_WALL.has(above)) {
            if (r2 < 0.7) blocks[i + UP] = B.dripstone_block;
            if (r < 0.14) {
              const len = 1 + Math.floor(r2 * 3);
              for (let k = 0; k < len && y - k > 1 && blocks[i - k * UP] === 0; k++) blocks[i - k * UP] = B.pointed_dripstone_down;
            }
          }
        }
        if (blocks[i] === 0 && y < 48 && r > 0.982) {
          for (let f = 0; f < 4; f++) {
            const nx = lx + DIRS[f][0], nz = lz + DIRS[f][1];
            if (nx < 0 || nz < 0 || nx >= CHUNK || nz >= CHUNK) continue;
            if (CAVE_WALL.has(blocks[idx(nx, y, nz)])) { blocks[i] = B.glow_lichen + f; break; }
          }
        }
      }
    }
  }

  // Amethyst geodes: smooth basalt, then calcite, then amethyst around a hollow lined
  // with crystals. One region in five has one, deep underground.
  placeGeodes(blocks, idx, ox, oz) {
    const R = 6;
    for (let rz = Math.floor((oz - R) / GEODE_REGION); rz <= Math.floor((oz + CHUNK + R) / GEODE_REGION); rz++) {
      for (let rx = Math.floor((ox - R) / GEODE_REGION); rx <= Math.floor((ox + CHUNK + R) / GEODE_REGION); rx++) {
        if (hash3(rx, 950, rz, this.seed) > 0.2) continue;
        const gx = rx * GEODE_REGION + R + Math.floor(hash3(rx, 951, rz, this.seed) * (GEODE_REGION - 2 * R));
        const gz = rz * GEODE_REGION + R + Math.floor(hash3(rx, 952, rz, this.seed) * (GEODE_REGION - 2 * R));
        const gy = 9 + Math.floor(hash3(rx, 953, rz, this.seed) * 28);
        if (gx + R < ox || gx - R >= ox + CHUNK || gz + R < oz || gz - R >= oz + CHUNK) continue;
        if (this.column(gx, gz).height < gy + 12) continue;
        const dist = (x, y, z) => Math.hypot(x - gx, (y - gy) * 1.1, z - gz) + (hash3(x, y, z, this.seed + 77) - 0.5) * 0.7;
        const x0 = Math.max(ox, gx - R), x1 = Math.min(ox + CHUNK - 1, gx + R);
        const z0 = Math.max(oz, gz - R), z1 = Math.min(oz + CHUNK - 1, gz + R);
        for (let y = gy - R; y <= gy + R; y++) for (let z = z0; z <= z1; z++) for (let x = x0; x <= x1; x++) {
          const d = dist(x, y, z);
          if (d > 5.6 || y < 1) continue;
          const i = idx(x - ox, y, z - oz);
          const cur = blocks[i];
          if (cur === B.bedrock) continue;
          if (d <= 2.9) blocks[i] = 0;
          else if (cur === 0 || cur === B.water || cur === B.lava) continue; // a cave through it stays open
          else if (d <= 3.9) blocks[i] = hash3(x, y, z, this.seed + 78) < 0.12 ? B.budding_amethyst : B.amethyst_block;
          else if (d <= 4.8) blocks[i] = B.calcite;
          else blocks[i] = B.smooth_basalt;
        }
        // Crystals grow on the budding amethyst in the floor.
        for (let y = gy - 3; y <= gy + 3; y++) for (let z = z0; z <= z1; z++) for (let x = x0; x <= x1; x++) {
          const i = idx(x - ox, y, z - oz);
          if (blocks[i] === 0 && dist(x, y, z) <= 2.9 && blocks[i - CHUNK * CHUNK] === B.budding_amethyst) blocks[i] = B.amethyst_cluster;
        }
      }
    }
  }

  // A slope too steep for soil shows bare stone (mountain cliffs).
  steep(x, z, col) {
    if (col.mount < 0.12) return false;
    const dx = this.column(x + 1, z).height - this.column(x - 1, z).height;
    const dz = this.column(x, z + 1).height - this.column(x, z - 1).height;
    return Math.abs(dx) + Math.abs(dz) > 7;
  }

  treeTypeAt(x, z) {
    const col = this.column(x, z);
    if (col.height < SEA + 1 || col.height > HEIGHT - 20) return null;
    const r = hash3(x, 1, z, this.seed);
    // Azalea trees grow over lush caves.
    if (this.v2 && col.lush && r < 0.004 && [BIOME.PLAINS, BIOME.FOREST, BIOME.DAPPLED, BIOME.MEADOW, BIOME.TAIGA].includes(col.biome)) return 'azalea';
    switch (col.biome) {
      case BIOME.GROVE: return r < 0.022 ? 'spruce' : null;
      case BIOME.MEADOW: return r < 0.001 ? 'oak' : r < 0.002 ? 'birch' : null;
      case BIOME.PLAINS: return r < 0.0025 ? 'oak' : null;
      case BIOME.FOREST: return r < 0.03 ? 'oak' : r < 0.045 ? 'birch' : null;
      case BIOME.TAIGA: return r < 0.03 ? 'spruce' : null;
      case BIOME.SNOWY: return r < 0.004 ? 'spruce' : null;
      case BIOME.MOUNTAINS: return col.height < 92 && r < 0.005 ? 'spruce' : null;
      case BIOME.DAPPLED: return r < 0.048 ? 'poplar' : r < 0.051 ? 'oak' : r < 0.055 ? 'fallen_poplar' : null;
      default: return null;
    }
  }

  decorateFeature(x, z, put) {
    const type = this.treeTypeAt(x, z);
    if (!type) return;
    const col = this.column(x, z);
    const ground = this.surfaceBlocks(col)[0];
    if (ground !== B.grass && ground !== B.snowy_grass) return;
    if (this.v2 && this.steep(x, z, col)) return;
    // Skip trees whose root a cave entrance has eaten.
    if (col.height > SEA && this.nEntrance(x * 0.012, z * 0.012) >= 0.55) return;
    if (type === 'azalea') {
      // Roots reach down toward the lush cave below.
      for (let k = 0; k < 3; k++) put(x, col.height - k, z, B.rooted_dirt, true);
    }
    if (type === 'fallen_poplar') this.fallenLog(x, col.height + 1, z, put);
    else growTree(type, x, col.height + 1, z, (k) => hash3(x, 20 + k, z, this.seed), put);
  }

  fallenLog(x, y, z, put) {
    const alongX = hash3(x, 30, z, this.seed) < 0.5;
    const len = 3 + Math.floor(hash3(x, 31, z, this.seed) * 3);
    for (let i = 0; i < len; i++) {
      const px = alongX ? x + i : x;
      const pz = alongX ? z : z + i;
      if (this.column(px, pz).height !== y - 1) return;
    }
    for (let i = 0; i < len; i++) {
      const px = alongX ? x + i : x;
      const pz = alongX ? z : z + i;
      put(px, y, pz, B.poplar_log + (alongX ? 1 : 2), true);
      const m = hash3(px, 32, pz, this.seed);
      if (m < 0.35) {
        // Shelf mushroom on one side, facing outward.
        const side = m < 0.17 ? 1 : -1;
        const mx = alongX ? px : px + side;
        const mz = alongX ? pz + side : pz;
        const facing = alongX ? (side > 0 ? 0 : 2) : (side > 0 ? 3 : 1);
        const large = hash3(px, 33, pz, this.seed) < 0.4;
        put(mx, y, mz, (large ? B.large_shelf_mushroom : B.shelf_mushroom) + facing);
      }
    }
  }

  // --- Abandoned camps -----------------------------------------------------------------

  campInRegion(rx, rz) {
    const key = `${rx},${rz}`;
    if (this.campCache.has(key)) return this.campCache.get(key);
    let camp = null;
    const r = hash3(rx, 900, rz, this.seed);
    if (r < 0.75) {
      const x = rx * CAMP_REGION + 24 + Math.floor(hash3(rx, 901, rz, this.seed) * (CAMP_REGION - 48));
      const z = rz * CAMP_REGION + 24 + Math.floor(hash3(rx, 902, rz, this.seed) * (CAMP_REGION - 48));
      const col = this.column(x, z);
      const ok = [BIOME.DAPPLED, BIOME.FOREST, BIOME.PLAINS, BIOME.TAIGA].includes(col.biome);
      const chance = col.biome === BIOME.DAPPLED ? 1 : 0.5;
      let flat = true;
      for (const [dx, dz] of [[-6, -6], [6, -6], [-6, 6], [6, 6], [0, 7], [7, 0], [-7, 0], [0, -7]]) {
        const c2 = this.column(x + dx, z + dz);
        if (Math.abs(c2.height - col.height) > 4 || c2.height < SEA) flat = false;
      }
      if (ok && flat && col.height > SEA + 1 && hash3(rx, 903, rz, this.seed) < chance) {
        camp = { x, z, y: col.height, rx, rz, biome: col.biome, seed: Math.floor(hash3(rx, 904, rz, this.seed) * 1e9) };
      }
    }
    this.campCache.set(key, camp);
    return camp;
  }

  campsNear(x0, z0, x1, z1) {
    const out = [];
    for (let rz = Math.floor(z0 / CAMP_REGION); rz <= Math.floor(z1 / CAMP_REGION); rz++) {
      for (let rx = Math.floor(x0 / CAMP_REGION); rx <= Math.floor(x1 / CAMP_REGION); rx++) {
        const c = this.campInRegion(rx, rz);
        if (c && c.x + CAMP_RADIUS >= x0 && c.x - CAMP_RADIUS <= x1 && c.z + CAMP_RADIUS >= z0 && c.z - CAMP_RADIUS <= z1) out.push(c);
      }
    }
    return out;
  }

  // Nearest camp to (x, z), skipping `exclude`. Searches a few regions out.
  nearestCamp(x, z, exclude = null, reach = 4) {
    let best = null;
    let bestD = Infinity;
    const rx0 = Math.floor(x / CAMP_REGION);
    const rz0 = Math.floor(z / CAMP_REGION);
    for (let rz = rz0 - reach; rz <= rz0 + reach; rz++) {
      for (let rx = rx0 - reach; rx <= rx0 + reach; rx++) {
        const c = this.campInRegion(rx, rz);
        if (!c || (exclude && c.x === exclude.x && c.z === exclude.z)) continue;
        const d = Math.hypot(c.x - x, c.z - z);
        if (d < bestD) { bestD = d; best = c; }
      }
    }
    return best;
  }

  campLayout(camp) {
    const r = mulberry32(camp.seed);
    const tent = TENT_COLORS[Math.floor(r() * TENT_COLORS.length)];
    const tent2 = TENT_COLORS[Math.floor(r() * TENT_COLORS.length)];
    const cushions = [0, 1, 2].map(() => COLORS[Math.floor(r() * COLORS.length)][0]);
    return {
      tent, tent2, cushions,
      chest: [-3, 1, -3],
      barrels: [[-3, 1, 3], [3, 1, -5]],
      table: [3, 1, 5],
    };
  }

  buildCamp(camp, put, get) {
    const { x: cx, z: cz, y: h } = camp;
    const L = this.campLayout(camp);
    // Level the site.
    for (let dz = -CAMP_RADIUS; dz <= CAMP_RADIUS; dz++) {
      for (let dx = -CAMP_RADIUS; dx <= CAMP_RADIUS; dx++) {
        if (dx * dx + dz * dz > (CAMP_RADIUS + 0.5) ** 2) continue;
        const x = cx + dx;
        const z = cz + dz;
        const colH = this.column(x, z).height;
        for (let y = Math.min(colH, h) - 3; y < h; y++) {
          const cur = get(x, y, z);
          if (cur === 0 || cur === B.water || cur === B.tall_grass) put(x, y, z, B.dirt, true);
        }
        put(x, h, z, B.grass, true);
        for (let y = h + 1; y <= Math.max(colH, h) + 8; y++) put(x, y, z, 0, true);
      }
    }
    const P = (dx, dy, dz, id) => put(cx + dx, h + dy, cz + dz, id, true);
    // Central poplar ringed by fences.
    growTree('poplar', cx, h + 1, cz, (k) => hash3(cx, 40 + k, cz, this.seed), (x, y, z, id) => put(x, y, z, id, true), 9);
    for (let dz = -2; dz <= 2; dz++) {
      for (let dx = -2; dx <= 2; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dz)) !== 2 || (dx === 0) || (dz === 0)) continue;
        P(dx, 1, dz, B.poplar_fence);
      }
    }
    P(2, 1, 0, B.poplar_fence);
    P(-2, 1, 0, B.poplar_fence);
    // Campfire with cushions.
    P(5, 1, 0, B.campfire);
    P(5, 1, 2, B[`${L.cushions[0]}_cushion`]);
    P(5, 1, -2, B[`${L.cushions[1]}_cushion`]);
    P(7, 1, 0, B[`${L.cushions[2]}_cushion`]);
    // Two A-frame tents, ridge along z, open toward the middle of the camp.
    this.tent(P, -5, -5, -2, L.tent, -1);
    this.tent(P, -5, 2, 5, L.tent2, 1);
    P(...L.chest, B.chest + 3);
    for (const b of L.barrels) P(...b, B.barrel);
    P(...L.table, B.crafting_table);
    P(-4, 1, 0, B.torch);
  }

  tent(P, x, z0, z1, color, closedSide) {
    const wool = B[`${color}_wool`];
    const stairs = B[`${color}_wool_stairs`];
    const slab = B[`${color}_wool_slab`];
    for (let z = Math.min(z0, z1); z <= Math.max(z0, z1); z++) {
      P(x - 1, 1, z, stairs + 3);
      P(x + 1, 1, z, stairs + 1);
      P(x, 2, z, slab);
      P(x, 1, z, 0);
    }
    const back = closedSide < 0 ? Math.min(z0, z1) : Math.max(z0, z1);
    P(x, 1, back, wool);
    P(x, 1, back - closedSide, B.straw_bed);
  }

  // World positions of camp containers near (x, z), with loot tables.
  containersNear(x, z) {
    const out = [];
    for (const camp of this.campsNear(x - 1, z - 1, x + 1, z + 1)) {
      const L = this.campLayout(camp);
      const at = ([dx, dy, dz]) => [camp.x + dx, camp.y + dy, camp.z + dz];
      out.push({ pos: at(L.chest), table: 'camp_chest', camp });
      L.barrels.forEach((b, i) => out.push({ pos: at(b), table: 'camp_barrel', camp, index: i }));
    }
    return out;
  }

  // Generate loot for a camp container at (x, y, z), or null if it isn't one.
  lootFor(x, y, z) {
    const c = this.containersNear(x, z).find(({ pos }) => pos[0] === x && pos[1] === y && pos[2] === z);
    if (!c) return null;
    const r = mulberry32(c.camp.seed + 17 * (c.index ?? 9) + 1);
    const slots = new Array(27).fill(null);
    const roll = (table, rolls) => {
      for (let i = 0; i < rolls; i++) {
        const total = table.reduce((s, e) => s + e[1], 0);
        let pick = r() * total;
        for (const [id, weight, min, max] of table) {
          pick -= weight;
          if (pick <= 0) {
            const count = min + Math.floor(r() * (max - min + 1));
            let slot = Math.floor(r() * 27);
            while (slots[slot]) slot = (slot + 1) % 27;
            slots[slot] = { id, count };
            break;
          }
        }
      }
    };
    if (c.table === 'camp_chest') {
      const target = this.nearestCamp(c.camp.x, c.camp.z, c.camp, 6);
      slots[13] = target ? { id: 'explorer_map', count: 1, data: { x: target.x, z: target.z } } : { id: 'map', count: 1 };
      roll([
        ['apple', 10, 1, 3], ['cooked_porkchop', 6, 1, 2], ['torch', 10, 2, 6], ['coal', 8, 2, 5],
        ['iron_ingot', 6, 1, 3], ['flint', 5, 1, 2], ['shelf_mushroom', 8, 1, 3], ['mushroom_stew', 4, 1, 1],
        ['poplar_sapling', 6, 1, 2], ['straw', 6, 2, 5], ['gold_ingot', 2, 1, 2], ['diamond', 1, 1, 1],
        ['stone_axe', 3, 1, 1], ['stone_pickaxe', 3, 1, 1], ['straw_bed', 3, 1, 1], ['map', 2, 1, 1],
      ], 4 + Math.floor(r() * 4));
    } else {
      roll([
        ['straw', 12, 2, 6], ['poplar_log', 8, 2, 5], ['poplar_planks', 8, 3, 8], ['apple', 8, 1, 3],
        ['porkchop', 6, 1, 3], ['mutton', 6, 1, 3], ['coal', 6, 1, 4], ['red_shrub', 5, 1, 3],
        ['stick', 8, 2, 6], ['white_wool', 4, 1, 4], ['bowl', 4, 1, 2], ['shelf_mushroom', 6, 1, 2],
      ], 3 + Math.floor(r() * 4));
    }
    return slots;
  }

  // --- Spawn and map -------------------------------------------------------------------

  // New worlds start in a Dappled Forest when one is within reach, so the autumn
  // poplars are the first thing you see; otherwise on any open land near the origin.
  findSpawn() {
    const search = (maxRadius, ok) => {
      for (let radius = 0; radius < maxRadius; radius += 8) {
        for (let a = 0; a < Math.max(1, radius / 4); a++) {
          const ang = (a / Math.max(1, radius / 4)) * Math.PI * 2;
          const x = Math.round(Math.cos(ang) * radius);
          const z = Math.round(Math.sin(ang) * radius);
          const col = this.column(x, z);
          if (col.height > SEA + 1 && !this.treeTypeAt(x, z) && ok(col)) return { x: x + 0.5, y: col.height + 1, z: z + 0.5 };
        }
      }
      return null;
    };
    return search(1200, (col) => col.biome === BIOME.DAPPLED)
      ?? search(2000, (col) => col.biome !== BIOME.MOUNTAINS && col.biome !== BIOME.DESERT)
      ?? { x: 0.5, y: HEIGHT - 10, z: 0.5 };
  }

  mapColor(x, z) {
    const col = this.column(x, z);
    const shade = 0.85 + ((col.height - SEA) % 4) * 0.04;
    let c;
    switch (col.biome) {
      case BIOME.OCEAN: c = col.height < SEA - 12 ? [36, 58, 150] : [52, 82, 190]; return c;
      case BIOME.FROZEN_OCEAN: return [150, 180, 230];
      case BIOME.BEACH: c = [218, 206, 160]; break;
      case BIOME.DESERT: c = [214, 198, 140]; break;
      case BIOME.SNOWY: c = [235, 240, 245]; break;
      case BIOME.TAIGA: c = [60, 98, 70]; break;
      case BIOME.MOUNTAINS: c = col.height > 100 ? [240, 244, 250] : [130, 130, 130]; break;
      case BIOME.FOREST: c = [62, 120, 44]; break;
      case BIOME.DAPPLED: {
        const t = this.treeTypeAt(x, z) === 'poplar' ? 1 : 0;
        c = t ? [200, 110, 40] : [176, 120, 56];
        break;
      }
      default: c = [110, 168, 70];
    }
    return [c[0] * shade, c[1] * shade, c[2] * shade];
  }
}

function isLeafId(id) {
  return id === B.oak_leaves || id === B.birch_leaves || id === B.spruce_leaves || POPLAR_LEAVES.includes(id);
}

// Grows a tree at (x, y, z) through put(x, y, z, id). rand(k) is a deterministic random
// in [0, 1) for the k-th decision. Also used for saplings at runtime.
export function growTree(type, x, y, z, rand, put, forceHeight = 0) {
  const leafRing = (cy, radius, leaf, cornerChance, k) => {
    for (let dz = -radius; dz <= radius; dz++) {
      for (let dx = -radius; dx <= radius; dx++) {
        const corner = Math.abs(dx) === radius && Math.abs(dz) === radius;
        if (corner && (radius === 0 || rand(k + dx * 7 + dz * 13 + cy) < cornerChance)) continue;
        put(x + dx, cy, z + dz, leaf);
      }
    }
  };
  if (type === 'oak' || type === 'birch') {
    const leaf = type === 'oak' ? B.oak_leaves : B.birch_leaves;
    const log = type === 'oak' ? B.oak_log : B.birch_log;
    const h = forceHeight || (type === 'oak' ? 4 : 5) + Math.floor(rand(0) * 3);
    leafRing(y + h - 3, 2, leaf, 0.5, 100);
    leafRing(y + h - 2, 2, leaf, 0.5, 200);
    leafRing(y + h - 1, 1, leaf, 0.4, 300);
    leafRing(y + h, 1, leaf, 1, 400);
    for (let i = 0; i < h; i++) put(x, y + i, z, log, true);
  } else if (type === 'spruce') {
    const h = forceHeight || 6 + Math.floor(rand(0) * 4);
    const radii = [0, 1, 1, 2, 1, 2, 3, 2, 3];
    put(x, y + h + 1, z, B.spruce_leaves);
    for (let i = 0; i < h - 1 && i < radii.length; i++) leafRing(y + h - i, radii[i], B.spruce_leaves, 0.7, 500 + i * 10);
    for (let i = 0; i < h; i++) put(x, y + i, z, B.spruce_log, true);
  } else if (type === 'poplar') {
    const h = forceHeight || 8 + Math.floor(rand(0) * 4);
    const leaf = POPLAR_LEAVES[Math.floor(rand(1) * 3)];
    // Tall, slender crown: widest a third of the way up, tapering to a point.
    const top = y + h + 1;
    const bottom = y + 3;
    for (let cy = bottom; cy <= top; cy++) {
      const t = (cy - bottom) / (top - bottom);
      const radius = t > 0.85 ? 0 : t > 0.6 || t < 0.12 ? 1 : 2;
      for (let dz = -radius; dz <= radius; dz++) {
        for (let dx = -radius; dx <= radius; dx++) {
          const edge = Math.abs(dx) + Math.abs(dz) > radius;
          if (edge && rand(600 + cy * 31 + dx * 7 + dz) < 0.7) continue;
          put(x + dx, cy, z + dz, leaf);
        }
      }
    }
    for (let i = 0; i < h; i++) put(x, y + i, z, B.poplar_log, true);
    // Shelf mushrooms on the trunk.
    if (rand(2) < 0.45) {
      const facing = Math.floor(rand(3) * 4);
      const [fx, fz] = [[0, 1], [-1, 0], [0, -1], [1, 0]][facing];
      const my = y + 1 + Math.floor(rand(4) * 2);
      put(x + fx, my, z + fz, (rand(5) < 0.4 ? B.large_shelf_mushroom : B.shelf_mushroom) + facing);
    }
  } else if (type === 'azalea') {
    // A short, bent oak trunk under a wide flat crown of azalea leaves, some flowering.
    const h = forceHeight || 3 + Math.floor(rand(0) * 2);
    const leaf = (k) => (rand(k) < 0.3 ? B.flowering_azalea_leaves : B.azalea_leaves);
    for (let cy = y + h - 1; cy <= y + h + 1; cy++) {
      const radius = cy === y + h + 1 ? 1 : 2;
      for (let dz = -radius; dz <= radius; dz++) for (let dx = -radius; dx <= radius; dx++) {
        const corner = Math.abs(dx) === radius && Math.abs(dz) === radius;
        if (corner && rand(700 + cy * 31 + dx * 7 + dz) < 0.6) continue;
        put(x + dx, cy, z + dz, leaf(800 + cy * 17 + dx * 5 + dz * 3));
      }
    }
    const bend = rand(1) < 0.5 ? [1, 0] : [0, 1];
    for (let i = 0; i < h; i++) {
      const off = i >= h - 1 && rand(2) < 0.6 ? 1 : 0;
      put(x + bend[0] * off, y + i, z + bend[1] * off, B.oak_log, true);
    }
  }
}
