// Procedural 16x16 pixel art. Block tiles are packed into a DataArrayTexture (one
// layer per tile, so mipmaps never bleed between tiles); items get flat icons; every
// item gets a 64x64 icon canvas for the UI (blocks drawn isometrically).
import * as THREE from './three.js';
import { BLOCKS, COLORS, SHAPES, SHAPE, setTextureLayers, shapeBoxes, B } from './blocks.js';
import { ITEMS } from './items.js';
import { mulberry32 } from './noise.js';

const S = 16;

class Tile {
  constructor() {
    this.d = new Uint8ClampedArray(S * S * 4);
  }
  set(x, y, c, a = 255) {
    if (x < 0 || y < 0 || x >= S || y >= S) return;
    const i = ((y | 0) * S + (x | 0)) * 4;
    this.d[i] = c[0];
    this.d[i + 1] = c[1];
    this.d[i + 2] = c[2];
    this.d[i + 3] = a;
  }
  get(x, y) {
    const i = (((y + S) % S) * S + ((x + S) % S)) * 4;
    return [this.d[i], this.d[i + 1], this.d[i + 2], this.d[i + 3]];
  }
  alpha(x, y) {
    if (x < 0 || y < 0 || x >= S || y >= S) return 0;
    return this.d[(y * S + x) * 4 + 3];
  }
  clear(x, y) {
    this.d[(y * S + x) * 4 + 3] = 0;
  }
  copy() {
    const t = new Tile();
    t.d.set(this.d);
    return t;
  }
}

const mul = (c, f) => [c[0] * f, c[1] * f, c[2] * f];
const mix = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const hex = (h) => [(h >> 16) & 255, (h >> 8) & 255, h & 255];

function noiseFill(t, rnd, base, amt = 0.15) {
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) t.set(x, y, mul(base, 1 + (rnd() - 0.5) * 2 * amt));
}

function speckle(t, rnd, color, count, amt = 0.1) {
  for (let i = 0; i < count; i++) t.set(Math.floor(rnd() * S), Math.floor(rnd() * S), mul(color, 1 + (rnd() - 0.5) * 2 * amt));
}

function blobs(t, rnd, color, count, minSize, maxSize, amt = 0.12) {
  for (let i = 0; i < count; i++) {
    let x = Math.floor(rnd() * S);
    let y = Math.floor(rnd() * S);
    const n = minSize + Math.floor(rnd() * (maxSize - minSize + 1));
    for (let k = 0; k < n; k++) {
      t.set((x + S) % S, (y + S) % S, mul(color, 1 + (rnd() - 0.5) * 2 * amt));
      if (rnd() < 0.5) x += rnd() < 0.5 ? 1 : -1;
      else y += rnd() < 0.5 ? 1 : -1;
    }
  }
}

// Voronoi cells that tile seamlessly: returns [cellIndex, edge] per pixel.
function cells(rnd, n) {
  const pts = [];
  for (let i = 0; i < n; i++) pts.push([rnd() * S, rnd() * S]);
  const out = [];
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      let best = 1e9, second = 1e9, bi = 0;
      for (let i = 0; i < n; i++) {
        let dx = Math.abs(x + 0.5 - pts[i][0]);
        let dy = Math.abs(y + 0.5 - pts[i][1]);
        dx = Math.min(dx, S - dx);
        dy = Math.min(dy, S - dy);
        const d = Math.sqrt(dx * dx + dy * dy);
        if (d < best) { second = best; best = d; bi = i; } else if (d < second) second = d;
      }
      out.push([bi, second - best < 1.1]);
    }
  }
  return out;
}

function ore(t, rnd, color, dark) {
  for (let i = 0; i < 5; i++) {
    const cx = 2 + Math.floor(rnd() * 12);
    const cy = 2 + Math.floor(rnd() * 12);
    const n = 2 + Math.floor(rnd() * 3);
    for (let k = 0; k < n; k++) {
      const x = cx + Math.floor(rnd() * 3) - 1;
      const y = cy + Math.floor(rnd() * 3) - 1;
      t.set(x, y, mul(color, 0.9 + rnd() * 0.25));
      t.set(x + 1, y + 1, dark);
    }
  }
}

function planks(t, rnd, base) {
  for (let y = 0; y < S; y++) {
    const row = y % 4;
    const plank = Math.floor(y / 4);
    const seam = (plank * 7 + 3) % S;
    for (let x = 0; x < S; x++) {
      let c = mul(base, 1 + (rnd() - 0.5) * 0.12 + (Math.sin((x + plank * 5) * 1.3) * 0.04));
      if (row === 3) c = mul(base, 0.62);
      else if (x === seam) c = mul(base, 0.72);
      else if (row === 0) c = mul(c, 1.06);
      t.set(x, y, c);
    }
  }
}

function logSide(t, rnd, base, stripe) {
  for (let x = 0; x < S; x++) {
    const f = 1 + (rnd() - 0.5) * 0.2;
    for (let y = 0; y < S; y++) {
      let c = mul(base, f + (rnd() - 0.5) * 0.12);
      if ((x + Math.floor(y / 5)) % 4 === 0) c = mul(stripe, 1 + (rnd() - 0.5) * 0.1);
      t.set(x, y, c);
    }
  }
}

function logTop(t, rnd, bark, inner, ring) {
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const d = Math.max(Math.abs(x - 7.5), Math.abs(y - 7.5));
      let c;
      if (d > 6.5) c = mul(bark, 0.9 + rnd() * 0.2);
      else c = Math.floor(d) % 2 === 0 ? mul(inner, 0.95 + rnd() * 0.1) : mul(ring, 0.95 + rnd() * 0.1);
      t.set(x, y, c);
    }
  }
}

function leaves(t, rnd, base, holes = 0.22) {
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const r = rnd();
      if (r < holes) continue;
      let c = mul(base, 0.75 + rnd() * 0.45);
      if (r > 0.92) c = mul(base, 1.3);
      t.set(x, y, c);
    }
  }
}

// Marks every opaque pixel as taking the biome color (alpha 254; see the chunk shader).
function markTint(t) {
  for (let i = 3; i < t.d.length; i += 4) if (t.d[i] === 255) t.d[i] = 254;
}

function bricksPattern(t, rnd, brick, mortar, bw = 8, bh = 4) {
  for (let y = 0; y < S; y++) {
    const row = Math.floor(y / bh);
    const off = row % 2 === 0 ? 0 : bw / 2;
    for (let x = 0; x < S; x++) {
      const isMortar = y % bh === bh - 1 || (x + off) % bw === bw - 1;
      t.set(x, y, isMortar ? mul(mortar, 0.95 + rnd() * 0.1) : mul(brick, 0.88 + rnd() * 0.24));
    }
  }
}

function bordered(t, rnd, base, edge) {
  noiseFill(t, rnd, base, 0.06);
  for (let i = 0; i < S; i++) {
    t.set(i, 0, edge); t.set(i, 15, edge); t.set(0, i, edge); t.set(15, i, edge);
  }
}

const STONE = [125, 125, 125];
const DIRT = [134, 96, 67];
const GRASS = [96, 152, 56];
const OAK = [162, 131, 79];
const BIRCH = [196, 178, 123];
const SPRUCE = [114, 84, 48];
const POPLAR = [206, 184, 150];

const WOOL = {
  white: 0xe9ecec, orange: 0xf07613, magenta: 0xbd44b3, light_blue: 0x3aafd9, yellow: 0xf8c527,
  lime: 0x70b919, pink: 0xed8dac, gray: 0x3e4447, light_gray: 0x8e8e86, cyan: 0x158991,
  purple: 0x792aac, blue: 0x35399d, brown: 0x724728, green: 0x546d1b, red: 0xa02722, black: 0x141519,
};
const CONCRETE = {
  white: 0xcfd5d6, orange: 0xe06100, magenta: 0xa9309f, light_blue: 0x2389c6, yellow: 0xf0af15,
  lime: 0x5ea818, pink: 0xd5658e, gray: 0x36393d, light_gray: 0x7d7d73, cyan: 0x157788,
  purple: 0x641f9c, blue: 0x2c2e8f, brown: 0x603b1f, green: 0x495b24, red: 0x8e2020, black: 0x080a0f,
};
export const DYE_COLORS = WOOL;

const GEN = {
  stone(t, r) { noiseFill(t, r, STONE, 0.08); blobs(t, r, mul(STONE, 0.82), 6, 3, 6, 0.05); blobs(t, r, mul(STONE, 1.12), 4, 2, 4, 0.04); },
  dirt(t, r) { noiseFill(t, r, DIRT, 0.12); speckle(t, r, mul(DIRT, 0.7), 18); speckle(t, r, mul(DIRT, 1.25), 10); },
  grass_top(t, r) { noiseFill(t, r, GRASS, 0.16); speckle(t, r, mul(GRASS, 0.75), 30); speckle(t, r, mul(GRASS, 1.2), 14); markTint(t); },
  grass_side(t, r) {
    GEN.dirt(t, r);
    for (let x = 0; x < S; x++) {
      const depth = 3 + (r() < 0.5 ? 1 : 0) + (r() < 0.25 ? 1 : 0);
      for (let y = 0; y < depth; y++) t.set(x, y, mul(GRASS, 0.85 + r() * 0.3), 254); // the green fringe takes the biome color
    }
  },
  grass_snow_side(t, r) {
    GEN.dirt(t, r);
    for (let x = 0; x < S; x++) {
      const depth = 3 + (r() < 0.5 ? 1 : 0) + (r() < 0.3 ? 1 : 0);
      for (let y = 0; y < depth; y++) t.set(x, y, mul([240, 250, 255], 0.92 + r() * 0.08));
    }
  },
  snow(t, r) { noiseFill(t, r, [240, 250, 255], 0.04); speckle(t, r, [215, 230, 245], 14, 0.03); },
  cobblestone(t, r) {
    const c = cells(r, 9);
    const shades = Array.from({ length: 9 }, () => 0.75 + r() * 0.45);
    for (let i = 0; i < S * S; i++) {
      const [ci, edge] = c[i];
      t.set(i % S, Math.floor(i / S), edge ? mul(STONE, 0.45) : mul(STONE, shades[ci] * (0.92 + r() * 0.16)));
    }
  },
  mossy_cobblestone(t, r) { GEN.cobblestone(t, r); blobs(t, r, [80, 120, 50], 7, 3, 7, 0.15); },
  bedrock(t, r) { for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) t.set(x, y, mul([85, 85, 85], 0.35 + r() * 1.1)); },
  sand(t, r) { noiseFill(t, r, [219, 207, 163], 0.06); speckle(t, r, [196, 180, 136], 20, 0.05); },
  gravel(t, r) {
    noiseFill(t, r, [130, 124, 122], 0.15);
    for (let i = 0; i < 14; i++) blobs(t, r, mul([140, 132, 128], 0.6 + r() * 0.7), 1, 2, 4, 0.05);
  },
  sandstone_top(t, r) { noiseFill(t, r, [216, 202, 155], 0.05); },
  sandstone_bottom(t, r) { noiseFill(t, r, [206, 192, 145], 0.07); speckle(t, r, [180, 165, 120], 12); },
  sandstone_side(t, r) {
    for (let y = 0; y < S; y++) {
      const band = y < 3 ? 1.04 : y < 4 ? 0.82 : y > 12 ? 0.9 : 1;
      for (let x = 0; x < S; x++) t.set(x, y, mul([216, 202, 155], band * (0.95 + r() * 0.08)));
    }
  },
  oak_log(t, r) { logSide(t, r, [109, 85, 50], [76, 60, 34]); },
  oak_log_top(t, r) { logTop(t, r, [109, 85, 50], [182, 147, 90], [150, 118, 70]); },
  oak_planks(t, r) { planks(t, r, OAK); },
  oak_leaves(t, r) { leaves(t, r, [58, 128, 34]); markTint(t); },
  birch_log(t, r) {
    noiseFill(t, r, [216, 215, 210], 0.05);
    for (let i = 0; i < 9; i++) {
      const y = Math.floor(r() * S);
      const x = Math.floor(r() * 13);
      const w = 2 + Math.floor(r() * 3);
      for (let k = 0; k < w; k++) t.set(x + k, y, [45, 45, 40]);
    }
  },
  birch_log_top(t, r) { logTop(t, r, [216, 215, 210], [210, 190, 135], [180, 160, 110]); },
  birch_planks(t, r) { planks(t, r, BIRCH); },
  birch_leaves(t, r) { leaves(t, r, [100, 150, 60]); },
  spruce_log(t, r) { logSide(t, r, [58, 38, 18], [40, 26, 12]); },
  spruce_log_top(t, r) { logTop(t, r, [58, 38, 18], [120, 88, 52], [95, 68, 38]); },
  spruce_planks(t, r) { planks(t, r, SPRUCE); },
  spruce_leaves(t, r) { leaves(t, r, [44, 82, 50], 0.16); },
  glass(t) {
    for (let i = 0; i < S; i++) {
      const c = [205, 228, 235];
      t.set(i, 0, c); t.set(i, 15, c); t.set(0, i, c); t.set(15, i, c);
    }
    for (let i = 0; i < 4; i++) t.set(3 + i, 6 - i, [240, 250, 255], 220);
    t.set(11, 11, [240, 250, 255], 200); t.set(12, 10, [240, 250, 255], 200);
  },
  coal_ore(t, r) { GEN.stone(t, r); ore(t, r, [40, 40, 40], [25, 25, 25]); },
  iron_ore(t, r) { GEN.stone(t, r); ore(t, r, [216, 175, 147], [140, 105, 85]); },
  gold_ore(t, r) { GEN.stone(t, r); ore(t, r, [252, 238, 75], [180, 140, 30]); },
  diamond_ore(t, r) { GEN.stone(t, r); ore(t, r, [93, 236, 245], [30, 150, 160]); },
  ice(t, r) {
    noiseFill(t, r, [140, 180, 250], 0.06);
    for (let i = 0; i < 4; i++) {
      const x0 = Math.floor(r() * S);
      for (let k = 0; k < 5; k++) t.set(x0 + k, 3 + i * 3 + k, [200, 225, 255]);
    }
  },
  cactus_side(t, r) {
    for (let y = 0; y < S; y++) {
      for (let x = 0; x < S; x++) {
        if (x === 0 || x === 15) continue;
        let c = mul([16, 124, 34], 0.9 + r() * 0.15);
        if (x % 4 === 1) c = mul([60, 160, 60], 0.95 + r() * 0.1);
        t.set(x, y, c);
      }
    }
    for (let i = 0; i < 8; i++) t.set(1 + Math.floor(r() * 14), Math.floor(r() * S), [20, 30, 20]);
  },
  cactus_top(t, r) {
    for (let y = 1; y < 15; y++) for (let x = 1; x < 15; x++) {
      const d = Math.max(Math.abs(x - 7.5), Math.abs(y - 7.5));
      t.set(x, y, mul(d > 5.5 ? [16, 124, 34] : [90, 170, 70], 0.9 + r() * 0.15));
    }
  },
  cactus_bottom(t, r) { GEN.cactus_top(t, r); },
  crafting_table_top(t, r) {
    planks(t, r, OAK);
    for (let i = 0; i < S; i++) {
      t.set(i, 0, [80, 55, 30]); t.set(i, 15, [80, 55, 30]); t.set(0, i, [80, 55, 30]); t.set(15, i, [80, 55, 30]);
      if (i > 1 && i < 14) { t.set(i, 5, [110, 80, 45]); t.set(i, 10, [110, 80, 45]); t.set(5, i, [110, 80, 45]); t.set(10, i, [110, 80, 45]); }
    }
  },
  crafting_table_side(t, r) {
    planks(t, r, OAK);
    for (let x = 0; x < S; x++) for (let y = 0; y < 3; y++) t.set(x, y, mul([120, 85, 50], 0.9 + r() * 0.15));
    // saw
    for (let x = 3; x < 12; x++) t.set(x, 6, [170, 170, 170]);
    for (let x = 3; x < 12; x += 2) t.set(x, 7, [130, 130, 130]);
    t.set(12, 6, [90, 60, 30]); t.set(13, 6, [90, 60, 30]); t.set(13, 7, [90, 60, 30]);
  },
  crafting_table_front(t, r) {
    GEN.crafting_table_side(t, r);
    for (let y = 9; y < 14; y++) t.set(4, y, [90, 60, 30]);
    for (let x = 2; x < 7; x++) t.set(x, 9, [160, 160, 160]);
    for (let y = 9; y < 14; y++) t.set(11, y, [90, 60, 30]);
    t.set(10, 9, [150, 150, 150]); t.set(12, 9, [150, 150, 150]); t.set(11, 8, [150, 150, 150]);
  },
  furnace_side(t, r) {
    noiseFill(t, r, [110, 110, 110], 0.08);
    for (let i = 0; i < S; i++) { t.set(i, 0, [80, 80, 80]); t.set(i, 15, [70, 70, 70]); t.set(0, i, [85, 85, 85]); t.set(15, i, [75, 75, 75]); }
  },
  furnace_top(t, r) { noiseFill(t, r, [120, 120, 120], 0.06); for (let i = 0; i < S; i++) { t.set(i, 0, [85, 85, 85]); t.set(i, 15, [85, 85, 85]); t.set(0, i, [85, 85, 85]); t.set(15, i, [85, 85, 85]); } },
  furnace_front(t, r) {
    GEN.furnace_side(t, r);
    for (let y = 8; y < 13; y++) for (let x = 4; x < 12; x++) t.set(x, y, [30, 30, 30]);
    for (let x = 4; x < 12; x++) t.set(x, 7, [60, 60, 60]);
    for (let x = 3; x < 13; x++) t.set(x, 4, [70, 70, 70]);
  },
  furnace_front_on(t, r) {
    GEN.furnace_front(t, r);
    for (let x = 4; x < 12; x++) {
      const h = 2 + Math.floor(r() * 3);
      for (let k = 0; k < h; k++) t.set(x, 12 - k, k === 0 ? [255, 220, 90] : k === 1 ? [255, 150, 40] : [220, 70, 20]);
    }
  },
  chest_side(t, r) {
    planks(t, r, [160, 110, 50]);
    for (let i = 0; i < S; i++) { t.set(i, 0, [70, 45, 20]); t.set(i, 15, [70, 45, 20]); t.set(0, i, [70, 45, 20]); t.set(15, i, [70, 45, 20]); t.set(i, 5, [70, 45, 20]); }
  },
  chest_top(t, r) { planks(t, r, [160, 110, 50]); for (let i = 0; i < S; i++) { t.set(i, 0, [70, 45, 20]); t.set(i, 15, [70, 45, 20]); t.set(0, i, [70, 45, 20]); t.set(15, i, [70, 45, 20]); } },
  chest_front(t, r) {
    GEN.chest_side(t, r);
    for (let y = 3; y < 8; y++) for (let x = 7; x < 9; x++) t.set(x, y, [200, 200, 200]);
    t.set(7, 7, [120, 120, 120]); t.set(8, 7, [120, 120, 120]);
  },
  bricks(t, r) { bricksPattern(t, r, [150, 74, 58], [175, 170, 160], 8, 4); },
  stone_bricks(t, r) {
    bricksPattern(t, r, [122, 122, 122], [80, 80, 80], 8, 8);
    for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) if (r() < 0.06) t.set(x, y, [100, 100, 100]);
  },
  torch(t) {
    for (let y = 6; y < 16; y++) { t.set(7, y, [120, 85, 45]); t.set(8, y, [95, 65, 35]); }
    t.set(7, 6, [255, 240, 150]); t.set(8, 6, [255, 210, 90]);
    t.set(7, 7, [255, 180, 60]); t.set(8, 7, [240, 140, 40]);
    t.set(7, 5, [255, 250, 200], 200); t.set(8, 5, [255, 230, 120], 160);
  },
  tall_grass(t, r) {
    for (let i = 0; i < 9; i++) {
      const x = 1 + Math.floor(r() * 14);
      const h = 5 + Math.floor(r() * 9);
      for (let k = 0; k < h; k++) t.set(x + (k > h * 0.6 && r() < 0.4 ? (i % 2 ? 1 : -1) : 0), 15 - k, mul(GRASS, 0.7 + r() * 0.4));
    }
    markTint(t);
  },
  dandelion(t, r) {
    for (let y = 9; y < 16; y++) t.set(8, y, [60, 130, 40]);
    t.set(7, 12, [60, 130, 40]); t.set(9, 13, [60, 130, 40]);
    for (const [x, y] of [[7, 7], [8, 7], [9, 7], [7, 8], [8, 8], [9, 8], [8, 6], [6, 8], [10, 7]]) t.set(x, y, mul([250, 220, 40], 0.9 + r() * 0.15));
  },
  poppy(t, r) {
    for (let y = 9; y < 16; y++) t.set(8, y, [50, 120, 35]);
    t.set(9, 12, [50, 120, 35]); t.set(10, 11, [50, 120, 35]);
    for (const [x, y] of [[7, 6], [8, 6], [9, 6], [6, 7], [7, 7], [9, 7], [10, 7], [7, 8], [8, 8], [9, 8], [8, 5]]) t.set(x, y, mul([210, 30, 30], 0.9 + r() * 0.2));
    t.set(8, 7, [30, 20, 10]);
  },
  oak_sapling(t, r) { sapling(t, r, [90, 60, 30], [60, 140, 40]); },
  birch_sapling(t, r) { sapling(t, r, [220, 220, 210], [110, 160, 70]); },
  spruce_sapling(t, r) { sapling(t, r, [70, 45, 20], [44, 90, 50]); },
  poplar_sapling(t, r) { sapling(t, r, [200, 190, 170], [225, 130, 40]); },
  dead_bush(t, r) {
    const c = [120, 85, 40];
    for (let y = 8; y < 16; y++) t.set(8, y, c);
    for (let k = 0; k < 5; k++) { t.set(8 - k, 10 - k, c); t.set(8 + k, 11 - k, c); t.set(7 + k, 8 - Math.floor(k / 2), c); }
    for (let i = 0; i < 4; i++) t.set(3 + Math.floor(r() * 10), 4 + Math.floor(r() * 6), mul(c, 0.8));
  },
  tnt_side(t, r) {
    for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
      const band = y >= 5 && y <= 10;
      t.set(x, y, band ? mul([230, 230, 230], 0.95 + r() * 0.05) : mul([200, 50, 30], 0.85 + r() * 0.2 - (x % 4 === 0 ? 0.15 : 0)));
    }
    const glyph = { T: ['TTT', '.T.', '.T.', '.T.'], N: ['N.N', 'NNN', 'NNN', 'N.N'] };
    let ox = 2;
    for (const ch of 'TNT') {
      const g = glyph[ch];
      for (let gy = 0; gy < 4; gy++) for (let gx = 0; gx < 3; gx++) if (g[gy][gx] !== '.') t.set(ox + gx, 6 + gy, [30, 30, 30]);
      ox += 4;
    }
  },
  tnt_top(t, r) { noiseFill(t, r, [190, 50, 30], 0.1); for (const [x, y] of [[7, 7], [8, 7], [7, 8], [8, 8]]) t.set(x, y, [60, 60, 60]); },
  tnt_bottom(t, r) { noiseFill(t, r, [170, 45, 28], 0.1); },
  glowstone(t, r) {
    noiseFill(t, r, [170, 130, 70], 0.15);
    blobs(t, r, [255, 230, 140], 9, 2, 5, 0.08);
    speckle(t, r, [255, 255, 210], 8, 0.02);
  },
  obsidian(t, r) { noiseFill(t, r, [22, 18, 32], 0.25); blobs(t, r, [60, 40, 90], 5, 2, 4, 0.15); },
  bookshelf(t, r) {
    planks(t, r, OAK);
    const colors = [[150, 40, 40], [40, 80, 150], [50, 120, 60], [170, 140, 60], [100, 60, 120]];
    for (const y0 of [1, 9]) {
      for (let x = 1; x < 15; x++) {
        const c = colors[Math.floor(r() * colors.length)];
        const h = 5 + Math.floor(r() * 2);
        for (let k = 0; k < h; k++) t.set(x, y0 + 6 - k, mul(c, 0.85 + r() * 0.2));
      }
      for (let x = 0; x < S; x++) t.set(x, y0 + 6, [90, 65, 35]);
    }
  },
  iron_block(t, r) { bordered(t, r, [220, 220, 220], [170, 170, 170]); },
  gold_block(t, r) { bordered(t, r, [250, 215, 60], [200, 160, 30]); },
  diamond_block(t, r) { bordered(t, r, [100, 230, 225], [50, 170, 170]); },
  water(t, r) {
    for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
      const w = Math.sin((x + y * 0.5) * (Math.PI / 4)) * 0.5 + Math.sin((y - x * 0.25) * (Math.PI / 8)) * 0.5;
      t.set(x, y, mul([48, 92, 214], 0.88 + w * 0.1 + r() * 0.05));
    }
  },
  lava(t, r) {
    for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
      const w = Math.sin(x * (Math.PI / 4) + Math.sin(y * (Math.PI / 8)) * 2) * 0.5 + 0.5;
      t.set(x, y, mix([200, 60, 10], [255, 180, 40], w * 0.8 + r() * 0.2));
    }
  },
  // Wilderness Bound
  poplar_log(t, r) {
    // Pale grey-green bark with dark diamond-shaped lenticels.
    noiseFill(t, r, [184, 186, 166], 0.06);
    for (let y = 0; y < S; y++) if (r() < 0.5) t.set(Math.floor(r() * S), y, [160, 162, 140]);
    for (let i = 0; i < 5; i++) {
      const x = 1 + Math.floor(r() * 13);
      const y = 1 + Math.floor(r() * 14);
      t.set(x, y, [92, 90, 76]); t.set(x + 1, y, [78, 76, 64]); t.set(x + 2, y, [92, 90, 76]);
      t.set(x + 1, y - 1, [120, 118, 100]); t.set(x + 1, y + 1, [120, 118, 100]);
    }
  },
  poplar_log_top(t, r) { logTop(t, r, [184, 186, 166], [226, 206, 168], [196, 172, 132]); },
  poplar_planks(t, r) { planks(t, r, POPLAR); },
  red_poplar_leaves(t, r) { leaves(t, r, [196, 56, 38]); },
  orange_poplar_leaves(t, r) { leaves(t, r, [222, 124, 40]); },
  yellow_poplar_leaves(t, r) { leaves(t, r, [228, 188, 52]); },
  red_shrub(t, r) {
    for (let i = 0; i < 26; i++) {
      const x = 2 + Math.floor(r() * 12);
      const y = 5 + Math.floor(r() * 10);
      t.set(x, y, mul([176, 36, 40], 0.75 + r() * 0.45));
    }
    for (let y = 11; y < 16; y++) { t.set(7, y, [90, 50, 30]); t.set(9, y - 1, [90, 50, 30]); }
  },
  shelf_mushroom_top(t, r) {
    for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
      const ring = Math.floor(Math.hypot(x - 7.5, y + 2) / 3) % 2;
      t.set(x, y, mul(ring ? [168, 112, 62] : [196, 142, 82], 0.92 + r() * 0.14));
    }
  },
  shelf_mushroom_bottom(t, r) { noiseFill(t, r, [226, 206, 170], 0.06); speckle(t, r, [190, 170, 140], 20); },
  shelf_mushroom_side(t, r) {
    for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) t.set(x, y, y % 4 < 2 ? mul([150, 96, 52], 0.95 + r() * 0.1) : mul([226, 206, 170], 0.95 + r() * 0.1));
  },
  straw_bed_top(t, r) {
    for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
      const pillow = y < 5 && x > 1 && x < 14;
      const weave = (x + y) % 3 === 0;
      t.set(x, y, pillow ? mul([236, 230, 214], 0.94 + r() * 0.08) : mul(weave ? [196, 160, 70] : [222, 190, 92], 0.9 + r() * 0.18));
    }
  },
  straw_bed_side(t, r) {
    for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
      if (y < 9) { t.set(x, y, [0, 0, 0], 0); continue; }
      const frame = y >= 13;
      t.set(x, y, frame ? mul(POPLAR, 0.8 + r() * 0.1) : mul((x % 3 === 0) ? [196, 160, 70] : [222, 190, 92], 0.9 + r() * 0.18));
    }
  },
  campfire_log(t, r) { logSide(t, r, [96, 72, 44], [60, 44, 26]); for (let x = 0; x < S; x++) if (r() < 0.4) t.set(x, Math.floor(r() * S), [40, 30, 20]); },
  campfire_fire(t, r) {
    for (let x = 1; x < 15; x++) {
      const h = 6 + Math.floor((1 - Math.abs(x - 7.5) / 7.5) * 8 * (0.6 + r() * 0.5));
      for (let k = 0; k < h; k++) {
        const f = k / h;
        t.set(x, 15 - k, f < 0.35 ? [255, 236, 140] : f < 0.7 ? [255, 160, 40] : [226, 80, 20], f > 0.85 ? 160 : 255);
      }
    }
  },
  barrel_side(t, r) {
    for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
      let c = mul([132, 92, 54], 0.9 + r() * 0.15);
      if (x % 4 === 3) c = [92, 62, 36];
      if (y === 2 || y === 13) c = [70, 70, 74];
      t.set(x, y, c);
    }
  },
  barrel_top(t, r) {
    planks(t, r, [140, 98, 58]);
    for (let i = 0; i < S; i++) { t.set(i, 0, [70, 70, 74]); t.set(i, 15, [70, 70, 74]); t.set(0, i, [70, 70, 74]); t.set(15, i, [70, 70, 74]); }
    for (let y = 6; y < 10; y++) for (let x = 6; x < 10; x++) t.set(x, y, [60, 40, 22]);
  },
  barrel_bottom(t, r) { GEN.barrel_top(t, r); },
};

// Wooden door halves: framed vertical boards; the top half of lighter woods has two
// little windows (cut out, so you can see through them).
const WOOD_COLOR = { oak: OAK, birch: BIRCH, spruce: SPRUCE, poplar: POPLAR };
const DOOR_WINDOWS = { oak: true, birch: true, spruce: false, poplar: true };
function doorHalf(t, r, wood, upper) {
  const base = WOOD_COLOR[wood];
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    let c = mul(base, 0.96 + r() * 0.1 + Math.sin((x >> 2) * 2.1 + y * 0.15) * 0.03);
    if (x % 4 === 3) c = mul(base, 0.8);
    const frame = x === 0 || x === S - 1 || (upper ? y === 0 : y === S - 1);
    const rail = upper ? y === 9 : y === 6 || y === 7;
    if (frame) c = mul(base, 0.66);
    else if (rail) c = mul(base, 0.72);
    t.set(x, y, c);
  }
  if (upper && DOOR_WINDOWS[wood]) {
    for (let y = 2; y < 8; y++) for (let x = 2; x < 14; x++) {
      if (x === 7 || x === 8 || y === 4) t.set(x, y, mul(base, 0.7));
      else t.clear(x, y);
    }
  }
  if (!upper) {
    // Handle.
    t.set(12, 1, [70, 70, 76]); t.set(12, 2, [110, 110, 118]); t.set(13, 2, [50, 50, 56]);
  }
}

function trapdoor(t, r, wood) {
  const base = WOOD_COLOR[wood];
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    const edge = x < 2 || y < 2 || x > 13 || y > 13 || x === 7 || x === 8 || y === 7 || y === 8;
    if (!edge && DOOR_WINDOWS[wood]) { t.clear(x, y); continue; }
    let c = mul(base, 0.95 + r() * 0.1);
    if (edge && (x === 0 || y === 0 || x === 15 || y === 15)) c = mul(base, 0.66);
    else if (!edge && x % 3 === 0) c = mul(base, 0.8);
    t.set(x, y, c);
  }
  t.set(3, 3, [70, 70, 76]); t.set(12, 3, [70, 70, 76]); t.set(3, 12, [70, 70, 76]); t.set(12, 12, [70, 70, 76]);
}

function sapling(t, r, stem, leaf) {
  for (let y = 9; y < 16; y++) t.set(8, y, stem);
  for (let i = 0; i < 26; i++) {
    const a = r() * Math.PI * 2;
    const d = r() * 4.5;
    t.set(Math.round(8 + Math.cos(a) * d), Math.round(6 + Math.sin(a) * d * 0.9), mul(leaf, 0.75 + r() * 0.45));
  }
}

for (const wood of Object.keys(WOOD_COLOR)) {
  GEN[`${wood}_door_bottom`] = (t, r) => doorHalf(t, r, wood, false);
  GEN[`${wood}_door_top`] = (t, r) => doorHalf(t, r, wood, true);
  GEN[`${wood}_trapdoor`] = (t, r) => trapdoor(t, r, wood);
}
// Farmland: tilled furrows, darker when wet.
const farmland = (wet) => (t, r) => {
  const base = wet ? [82, 54, 34] : [124, 86, 56];
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    const furrow = y % 4 === 3 || (y % 4 === 0 && (x + y) % 5 === 0);
    t.set(x, y, mul(base, (furrow ? 0.72 : 1) * (0.9 + r() * 0.2)));
  }
};
GEN.farmland = farmland(false);
GEN.farmland_wet = farmland(true);
// Wheat: stalks that grow taller and turn from green to gold, with ears when ripe.
for (let stage = 0; stage < 8; stage++) {
  GEN[`wheat_stage_${stage}`] = (t, r) => {
    const f = stage / 7;
    const height = 2 + Math.round(stage * 1.75);
    const green = [70, 150, 40], gold = [214, 180, 70];
    for (const x of [1, 3, 5, 7, 9, 11, 13, 15]) {
      const h = Math.max(1, height - Math.floor(r() * 3));
      const lean = r() < 0.5 ? 0 : x < 8 ? -1 : 1;
      for (let k = 0; k < h; k++) {
        const px = x + (k > h * 0.6 ? lean : 0);
        t.set(px, 15 - k, mul(mix(green, gold, Math.min(1, f * 1.2 + (k / h) * 0.2)), 0.8 + r() * 0.3));
      }
      if (stage >= 5) {
        for (let k = 0; k < 3; k++) t.set(x + lean, 15 - h - k + 1, mul(stage === 7 ? [190, 150, 50] : [160, 160, 60], 0.85 + r() * 0.25));
      }
    }
  };
}
GEN.hay_bale_side = (t, r) => {
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    let c = mul((x + y * 3) % 5 === 0 ? [180, 140, 40] : [214, 176, 60], 0.88 + r() * 0.2);
    if (y === 3 || y === 12) c = [120, 76, 30];
    t.set(x, y, c);
  }
};
GEN.hay_bale_top = (t, r) => {
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    const ring = Math.floor(Math.hypot(x - 7.5, y - 7.5)) % 3 === 0;
    t.set(x, y, mul(ring ? [176, 136, 44] : [212, 174, 62], 0.88 + r() * 0.2));
  }
};
// Beds in every wool color: top textures have the pillow at the top edge (the head
// end); the mesher turns them to match the bed's direction. Sides fill the lower 9
// pixels.
const bedColor = (color) => (color === 'red' ? [176, 38, 38] : hex(WOOL[color]));
const bedSide = (color, head) => (t, r) => {
  const cover = bedColor(color);
  for (let y = 7; y < S; y++) for (let x = 0; x < S; x++) {
    let c;
    if (y < 10) c = head && x < 6 ? [232, 230, 224] : cover;
    else if (y < 13) c = mul(cover, 0.78);
    else c = (x < 3 || x > 12) ? mul(OAK, 0.8) : null;
    if (c) t.set(x, y, mul(c, 0.92 + r() * 0.12));
  }
};
for (const [color] of COLORS) {
  const cover = bedColor(color);
  // Light covers get a darker trim so the edge still shows.
  const trim = mul(cover, color === 'white' || color === 'light_gray' ? 0.82 : 0.75);
  GEN[`${color}_bed_head_top`] = (t, r) => {
    for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
      const pillow = y >= 2 && y < 7 && x >= 2 && x < 14;
      const edge = x === 0 || x === 15;
      t.set(x, y, pillow ? mul([238, 238, 232], 0.94 + r() * 0.08) : edge ? trim : y < 9 ? mul([226, 222, 214], 0.92 + r() * 0.08) : mul(cover, 0.9 + r() * 0.15));
    }
  };
  GEN[`${color}_bed_foot_top`] = (t, r) => {
    for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
      const edge = x === 0 || x === 15 || y === 15;
      t.set(x, y, edge ? trim : mul(cover, (y % 5 === 2 ? 0.85 : 1) * (0.9 + r() * 0.15)));
    }
  };
  GEN[`${color}_bed_head_side`] = bedSide(color, true);
  GEN[`${color}_bed_foot_side`] = bedSide(color, false);
}

GEN.ladder = (t, r) => {
  for (let y = 0; y < S; y++) {
    for (const x of [2, 3, 12, 13]) t.set(x, y, mul(x === 2 || x === 12 ? [128, 98, 56] : [100, 76, 42], 0.92 + r() * 0.14));
    if (y % 4 === 1 || y % 4 === 2) for (let x = 4; x < 12; x++) t.set(x, y, mul(y % 4 === 1 ? [150, 118, 70] : [112, 86, 48], 0.92 + r() * 0.14));
  }
};
GEN.iron_bars = (t) => {
  for (let y = 0; y < S; y++) {
    for (const x of [1, 5, 9, 13]) { t.set(x, y, [158, 158, 164]); t.set(x + 1, y, [96, 96, 104]); }
  }
  for (const y of [0, 15]) for (let x = 0; x < S; x++) t.set(x, y, [140, 140, 148]);
};

for (const [color] of COLORS) {
  GEN[`${color}_wool`] = (t, r) => {
    const base = hex(WOOL[color]);
    for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
      const curl = Math.sin(x * 1.7 + y * 0.9) * 0.05 + Math.sin(y * 2.3 - x * 0.7) * 0.04;
      t.set(x, y, mul(base, 0.92 + curl + r() * 0.1));
    }
  };
  GEN[`${color}_concrete`] = (t, r) => noiseFill(t, r, hex(CONCRETE[color]), 0.025);
}

// --- Caves & Cliffs ------------------------------------------------------------------

const DEEP = [80, 80, 88];
// Deepslate: dark and layered, with short darker streaks running sideways.
function deepslateBase(t, r) {
  noiseFill(t, r, DEEP, 0.07);
  for (let i = 0; i < 14; i++) {
    const y = Math.floor(r() * S), x = Math.floor(r() * S), len = 3 + Math.floor(r() * 5);
    const c = r() < 0.6 ? mul(DEEP, 0.72) : mul(DEEP, 1.18);
    for (let k = 0; k < len; k++) t.set((x + k) % S, y, mul(c, 0.95 + r() * 0.1));
  }
}
GEN.deepslate = deepslateBase;
GEN.deepslate_top = (t, r) => {
  noiseFill(t, r, DEEP, 0.06);
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    const d = Math.abs(x - 7.5) + Math.abs(y - 7.5);
    if (Math.floor(d) % 4 === 0) t.set(x, y, mul(DEEP, 0.78 + r() * 0.08));
  }
};
GEN.cobbled_deepslate = (t, r) => {
  const c = cells(r, 11);
  const shades = Array.from({ length: 11 }, () => 0.75 + r() * 0.4);
  for (let i = 0; i < S * S; i++) {
    const [ci, edge] = c[i];
    t.set(i % S, Math.floor(i / S), edge ? mul(DEEP, 0.45) : mul(DEEP, shades[ci] * (0.92 + r() * 0.16)));
  }
};
GEN.polished_deepslate = (t, r) => {
  noiseFill(t, r, mul(DEEP, 0.95), 0.04);
  for (let i = 0; i < S; i++) {
    t.set(i, 0, mul(DEEP, 1.15)); t.set(0, i, mul(DEEP, 1.1));
    t.set(i, 15, mul(DEEP, 0.6)); t.set(15, i, mul(DEEP, 0.65));
  }
};
GEN.deepslate_bricks = (t, r) => bricksPattern(t, r, DEEP, mul(DEEP, 0.5), 8, 4);
GEN.deepslate_tiles = (t, r) => {
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    const seam = x % 4 === 3 || y % 4 === 3;
    t.set(x, y, seam ? mul(DEEP, 0.45) : mul(DEEP, (x % 4 === 0 || y % 4 === 0 ? 1.08 : 0.94) * (0.94 + r() * 0.1)));
  }
};
GEN.tuff = (t, r) => { noiseFill(t, r, [108, 109, 102], 0.07); speckle(t, r, [78, 80, 74], 34); speckle(t, r, [142, 142, 134], 16); blobs(t, r, [96, 98, 90], 4, 2, 5, 0.05); };
GEN.calcite = (t, r) => { noiseFill(t, r, [224, 226, 222], 0.03); blobs(t, r, [198, 200, 198], 6, 3, 7, 0.03); speckle(t, r, [240, 242, 240], 10, 0.02); };
GEN.smooth_basalt = (t, r) => { noiseFill(t, r, [72, 72, 78], 0.05); speckle(t, r, [54, 54, 60], 24); blobs(t, r, [84, 84, 90], 3, 3, 6, 0.04); };
const ROCK = { granite: [[151, 104, 86], [184, 134, 114], [112, 74, 60]], diorite: [[190, 190, 190], [228, 228, 228], [122, 122, 124]], andesite: [[136, 136, 137], [160, 160, 162], [104, 104, 106]] };
for (const [rock, [base, light, dark]] of Object.entries(ROCK)) {
  GEN[rock] = (t, r) => { noiseFill(t, r, base, 0.07); speckle(t, r, light, 26); speckle(t, r, dark, 26); blobs(t, r, mix(base, dark, 0.4), 4, 2, 5, 0.05); };
  GEN[`polished_${rock}`] = (t, r) => {
    noiseFill(t, r, base, 0.035);
    speckle(t, r, mix(base, light, 0.5), 10, 0.03);
    for (let i = 0; i < S; i++) { t.set(i, 0, mix(base, light, 0.6)); t.set(0, i, mix(base, light, 0.5)); t.set(i, 15, mix(base, dark, 0.6)); t.set(15, i, mix(base, dark, 0.5)); }
  };
}
const ORE_COLORS = {
  coal: [[40, 40, 40], [25, 25, 25]],
  iron: [[216, 175, 147], [140, 105, 85]],
  gold: [[252, 238, 75], [180, 140, 30]],
  diamond: [[93, 236, 245], [30, 150, 160]],
  copper: [[226, 124, 82], [124, 170, 140]],
  redstone: [[255, 36, 28], [140, 0, 0]],
  lapis: [[48, 88, 214], [22, 44, 128]],
  emerald: [[64, 226, 110], [18, 124, 52]],
};
for (const [kind, [c, dark]] of Object.entries(ORE_COLORS)) {
  if (!GEN[`${kind}_ore`]) GEN[`${kind}_ore`] = (t, r) => { GEN.stone(t, r); ore(t, r, c, dark); };
  GEN[`deepslate_${kind}_ore`] = (t, r) => { deepslateBase(t, r); ore(t, r, c, dark); };
}
GEN.lapis_block = (t, r) => { noiseFill(t, r, [31, 67, 140], 0.08); speckle(t, r, [60, 110, 210], 18); speckle(t, r, [210, 180, 60], 4, 0.05); };
GEN.redstone_block = (t, r) => {
  noiseFill(t, r, [170, 24, 6], 0.06);
  for (let y = 1; y < S; y += 3) for (let x = (y % 2) + 1; x < S; x += 3) t.set(x, y, [230, 60, 30]);
};
GEN.emerald_block = (t, r) => {
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    const facet = ((x + y) >> 2) % 2 === 0;
    t.set(x, y, mul(facet ? [62, 214, 104] : [36, 170, 76], 0.94 + r() * 0.1));
  }
  for (let i = 0; i < S; i++) { t.set(i, 0, [120, 240, 160]); t.set(0, i, [110, 236, 150]); t.set(i, 15, [20, 110, 50]); t.set(15, i, [22, 118, 52]); }
};
GEN.raw_copper_block = (t, r) => { noiseFill(t, r, [154, 105, 79], 0.1); blobs(t, r, [196, 120, 84], 6, 3, 6, 0.08); blobs(t, r, [110, 72, 52], 5, 2, 4, 0.06); };
const COPPER_STAGES = { '': [194, 108, 80], exposed_: [161, 126, 104], weathered_: [108, 153, 110], oxidized_: [82, 162, 132] };
for (const [stage, c] of Object.entries(COPPER_STAGES)) {
  GEN[`${stage}copper`] = (t, r) => {
    noiseFill(t, r, c, 0.05);
    for (let i = 0; i < 5; i++) {
      const y = 2 + Math.floor(r() * 12), x = Math.floor(r() * 10);
      for (let k = 0; k < 5; k++) t.set(x + k, y + (k > 2 ? 1 : 0), mul(c, 1.16));
    }
    speckle(t, r, mul(c, 0.82), 14, 0.04);
  };
  GEN[`${stage}cut_copper`] = (t, r) => {
    for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
      const seam = x % 8 === 7 || y % 8 === 7;
      const hi = x % 8 === 0 || y % 8 === 0;
      t.set(x, y, seam ? mul(c, 0.68) : mul(c, (hi ? 1.14 : 1) * (0.95 + r() * 0.08)));
    }
  };
}
GEN.lightning_rod = (t, r) => {
  const c = COPPER_STAGES[''];
  for (let y = 0; y < S; y++) for (let x = 6; x < 10; x++) {
    if (y >= 4 && (x === 6 || x === 9)) continue;
    t.set(x, y, mul(c, (x === 6 || x === 7 ? 1.12 : 0.86) * (0.95 + r() * 0.08)));
  }
};
const AMETHYST = [154, 112, 214];
GEN.amethyst_block = (t, r) => {
  // Crystal facets: light edges between mid-purple cells.
  const c = cells(r, 8);
  const shades = Array.from({ length: 8 }, () => 0.92 + r() * 0.24);
  for (let i = 0; i < S * S; i++) {
    const [ci, edge] = c[i];
    t.set(i % S, Math.floor(i / S), edge ? [206, 170, 246] : mul(AMETHYST, shades[ci] * (0.95 + r() * 0.08)));
  }
};
GEN.budding_amethyst = (t, r) => {
  GEN.amethyst_block(t, r);
  for (let i = 0; i < 5; i++) {
    const x = 2 + Math.floor(r() * 12), y = 2 + Math.floor(r() * 12);
    t.set(x, y, [62, 36, 96]); t.set(x + 1, y, [80, 50, 120]); t.set(x, y + 1, [80, 50, 120]); t.set(x - 1, y - 1, [226, 190, 255]);
  }
};
GEN.amethyst_cluster = (t, r) => {
  // Crystals pointing up from the bottom edge.
  for (const [cx, h, w] of [[4, 9, 2], [8, 13, 3], [11, 8, 2], [6, 6, 1], [13, 5, 1]]) {
    for (let y = 0; y < h; y++) {
      const half = Math.max(0, Math.round(w * (1 - y / h)));
      for (let x = cx - half; x <= cx + half; x++) t.set(x, 15 - y, mul(x < cx ? [222, 180, 255] : x === cx ? [176, 128, 232] : [118, 78, 170], 0.94 + r() * 0.1));
    }
  }
};
GEN.tinted_glass = (t, r) => {
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    const edge = x === 0 || y === 0 || x === 15 || y === 15;
    if (edge) t.set(x, y, [62, 50, 72]);
    else if ((x + y) % 2 === 0 || r() < 0.25) t.set(x, y, mul([46, 38, 56], 0.9 + r() * 0.2));
  }
};
GEN.dripstone_block = (t, r) => {
  // Rough tan stone in thin wavy layers.
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    const layer = Math.sin((y + Math.sin(x * 0.8) * 1.2) * 1.6) * 0.06;
    t.set(x, y, mul([140, 112, 96], 0.94 + layer + (r() - 0.5) * 0.16));
  }
  speckle(t, r, [104, 82, 70], 26);
  speckle(t, r, [176, 146, 128], 14);
};
GEN.pointed_dripstone_up = (t, r) => {
  // Wide at the bottom, a sharp tip near the top.
  for (let y = 2; y < S; y++) {
    const half = Math.floor(((y - 2) / 13) * 3.4);
    for (let x = 7 - half; x <= 8 + half; x++) t.set(x, y, mul(x < 8 ? [162, 132, 114] : [118, 92, 78], 0.92 + r() * 0.12));
  }
};
GEN.pointed_dripstone_down = (t, r) => {
  for (let y = 0; y < 14; y++) {
    const half = Math.floor(((13 - y) / 13) * 3.4);
    for (let x = 7 - half; x <= 8 + half; x++) t.set(x, y, mul(x < 8 ? [162, 132, 114] : [118, 92, 78], 0.92 + r() * 0.12));
  }
};
const MOSS = [89, 110, 45];
GEN.moss_block = (t, r) => { noiseFill(t, r, MOSS, 0.1); speckle(t, r, [112, 138, 58], 30); speckle(t, r, [66, 84, 32], 22); };
GEN.rooted_dirt = (t, r) => {
  GEN.dirt(t, r);
  for (let i = 0; i < 5; i++) {
    let x = Math.floor(r() * S), y = Math.floor(r() * S);
    for (let k = 0; k < 6; k++) { t.set(x, y, [168, 126, 84]); x += r() < 0.5 ? 1 : 0; y += 1; }
  }
};
GEN.hanging_roots = (t, r) => {
  for (const x0 of [3, 6, 9, 12]) {
    let x = x0;
    const len = 8 + Math.floor(r() * 7);
    for (let y = 0; y < len; y++) { t.set(x, y, mul([156, 116, 80], 0.9 + r() * 0.2)); if (r() < 0.25) x += r() < 0.5 ? 1 : -1; }
  }
};
const AZALEA = [96, 126, 46];
const azaleaLeaves = (t, r, flowers, holes) => {
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    if (holes && r() < 0.14) continue;
    t.set(x, y, mul(AZALEA, 0.72 + r() * 0.45));
  }
  if (flowers) for (let i = 0; i < 9; i++) {
    const x = Math.floor(r() * 15), y = Math.floor(r() * 15);
    t.set(x, y, [214, 96, 196]); t.set(x + 1, y, [190, 70, 172]); t.set(x, y + 1, [190, 70, 172]); t.set(x + 1, y + 1, [240, 150, 226]);
  }
};
const azaleaSide = (flowers) => (t, r) => {
  // Leafy top half; the stem shows through the middle of the bottom half.
  for (let y = 0; y < 8; y++) for (let x = 0; x < S; x++) t.set(x, y, mul(AZALEA, 0.72 + r() * 0.42));
  for (let x = 0; x < S; x++) if (r() < 0.5) t.set(x, 7, mul(AZALEA, 0.6));
  for (let y = 8; y < S; y++) for (let x = 6; x < 10; x++) t.set(x, y, mul(x < 8 ? [120, 96, 60] : [92, 72, 44], 0.92 + r() * 0.12));
  if (flowers) for (let i = 0; i < 4; i++) { const x = 1 + Math.floor(r() * 13), y = Math.floor(r() * 6); t.set(x, y, [214, 96, 196]); t.set(x + 1, y + 1, [240, 150, 226]); }
};
GEN.azalea_top = (t, r) => azaleaLeaves(t, r, false, false);
GEN.flowering_azalea_top = (t, r) => azaleaLeaves(t, r, true, false);
GEN.azalea_bottom = (t, r) => { azaleaLeaves(t, r, false, false); for (let i = 0; i < t.d.length; i += 4) { t.d[i] *= 0.75; t.d[i + 1] *= 0.75; t.d[i + 2] *= 0.75; } };
GEN.azalea_side = azaleaSide(false);
GEN.flowering_azalea_side = azaleaSide(true);
GEN.azalea_leaves = (t, r) => azaleaLeaves(t, r, false, true);
GEN.flowering_azalea_leaves = (t, r) => azaleaLeaves(t, r, true, true);
const vines = (berries) => (t, r) => {
  for (let y = 0; y < S; y++) {
    const x = 7 + Math.round(Math.sin(y * 0.7) * 1.2);
    t.set(x, y, mul([70, 104, 34], 0.9 + r() * 0.2));
    if (y % 3 === 0) { t.set(x - 1, y, [88, 128, 44]); t.set(x - 2, y + 1, [74, 110, 36]); }
    if (y % 3 === 1) { t.set(x + 1, y, [88, 128, 44]); t.set(x + 2, y + 1, [74, 110, 36]); }
  }
  if (berries) for (const [x, y] of [[4, 4], [10, 9], [5, 12]]) {
    t.set(x, y, [255, 196, 64]); t.set(x + 1, y, [244, 150, 30]); t.set(x, y + 1, [244, 150, 30]); t.set(x + 1, y + 1, [255, 226, 120]);
  }
};
GEN.cave_vines = vines(false);
GEN.cave_vines_lit = vines(true);
GEN.spore_blossom = (t, r) => {
  // Hangs from the ceiling: a green cap at the top, pink petals spreading down and out.
  for (let x = 5; x < 11; x++) { t.set(x, 0, [70, 110, 40]); t.set(x, 1, [90, 130, 50]); }
  for (let y = 2; y < 9; y++) {
    const half = 2 + Math.floor((y - 2) * 0.9);
    for (let x = 8 - half; x < 8 + half; x++) if (r() < 0.85) t.set(x, y, mul(y % 2 ? [230, 120, 200] : [200, 84, 172], 0.92 + r() * 0.12));
  }
};
GEN.glow_lichen = (t, r) => {
  for (let i = 0; i < 9; i++) {
    let x = Math.floor(r() * S), y = Math.floor(r() * S);
    for (let k = 0; k < 7; k++) {
      t.set(x, y, r() < 0.3 ? [200, 236, 200] : mul([120, 176, 150], 0.9 + r() * 0.2));
      if (r() < 0.5) x = (x + (r() < 0.5 ? 1 : -1) + S) % S; else y = (y + (r() < 0.5 ? 1 : -1) + S) % S;
    }
  }
};
GEN.powder_snow = (t, r) => { noiseFill(t, r, [246, 250, 254], 0.025); speckle(t, r, [222, 232, 246], 22, 0.02); };
GEN.packed_ice = (t, r) => {
  noiseFill(t, r, [140, 178, 246], 0.04);
  for (let i = 0; i < 5; i++) {
    let x = Math.floor(r() * S), y = Math.floor(r() * S);
    for (let k = 0; k < 6; k++) { t.set(x, y, [176, 206, 255]); x = (x + 1) % S; if (r() < 0.5) y = (y + 1) % S; }
  }
};
// Candles: a short wax stick in the middle of the tile (the torch shape shows the
// middle two columns), with a flame on the lit ones.
const CANDLE_WAX = { '': [230, 210, 160], ...Object.fromEntries(Object.entries(WOOL).map(([k, v]) => [`${k}_`, hex(v)])) };
for (const [color, wax] of Object.entries(CANDLE_WAX)) {
  const draw = (lit) => (t, r) => {
    for (let y = 10; y < S; y++) { t.set(7, y, mul(wax, 1.08 * (0.95 + r() * 0.08))); t.set(8, y, mul(wax, 0.86 * (0.95 + r() * 0.08))); }
    t.set(7, 9, [52, 40, 30]);
    if (lit) { t.set(7, 8, [255, 176, 48]); t.set(8, 8, [255, 210, 90]); t.set(7, 7, [255, 240, 170]); t.set(8, 7, [255, 200, 80]); }
  };
  GEN[`${color}candle`] = draw(false);
  GEN[`${color}candle_lit`] = draw(true);
}

// --- Item icons ----------------------------------------------------------------------

function line(t, x0, y0, x1, y1, c) {
  const dx = Math.abs(x1 - x0), dy = -Math.abs(y1 - y0);
  const sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
  let err = dx + dy;
  for (;;) {
    t.set(x0, y0, typeof c === 'function' ? c(x0, y0) : c);
    if (x0 === x1 && y0 === y1) break;
    const e2 = 2 * err;
    if (e2 >= dy) { err += dy; x0 += sx; }
    if (e2 <= dx) { err += dx; y0 += sy; }
  }
}

function fillPoly(t, pts, c) {
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    let inside = false;
    const px = x + 0.5, py = y + 0.5;
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
      const [xi, yi] = pts[i], [xj, yj] = pts[j];
      if ((yi > py) !== (yj > py) && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) inside = !inside;
    }
    if (inside) t.set(x, y, typeof c === 'function' ? c(x, y) : c);
  }
}

function disc(t, cx, cy, rad, c) {
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) if (Math.hypot(x + 0.5 - cx, y + 0.5 - cy) <= rad) t.set(x, y, typeof c === 'function' ? c(x, y) : c);
}

function outline(t, color = [30, 24, 20]) {
  const src = t.copy();
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    if (src.alpha(x, y)) continue;
    if (src.alpha(x + 1, y) || src.alpha(x - 1, y) || src.alpha(x, y + 1) || src.alpha(x, y - 1)) t.set(x, y, color);
  }
}

const TIER_COLOR = {
  wooden: [150, 116, 66], stone: [130, 130, 130], iron: [216, 216, 216], golden: [250, 220, 70], diamond: [80, 230, 220],
};
const HANDLE = (x, y) => ((x + y) % 2 ? [120, 86, 44] : [96, 68, 34]);

function tool(t, type, mat) {
  const light = mul(mat, 1.18);
  const dark = mul(mat, 0.7);
  if (type === 'sword') {
    line(t, 4, 11, 13, 2, light);
    line(t, 5, 11, 13, 3, mat);
    line(t, 4, 10, 12, 2, dark);
    line(t, 2, 9, 6, 13, [90, 64, 34]);
    line(t, 2, 13, 3, 12, HANDLE);
    t.set(1, 14, [70, 50, 25]);
    outline(t);
    return;
  }
  line(t, 2, 13, 10, 5, HANDLE);
  line(t, 3, 13, 10, 6, (x, y) => mul(HANDLE(x, y), 0.8));
  if (type === 'pickaxe') {
    for (let k = 0; k <= 20; k++) {
      const s = k / 20;
      const x = (1 - s) * (1 - s) * 3 + 2 * (1 - s) * s * 13 + s * s * 13;
      const y = (1 - s) * (1 - s) * 2 + 2 * (1 - s) * s * 2 + s * s * 12;
      t.set(Math.round(x), Math.round(y), light);
      t.set(Math.round(x) - 1, Math.round(y) + 1, dark);
    }
  } else if (type === 'axe') {
    fillPoly(t, [[7, 2], [10, 0.5], [13.5, 3], [12, 7], [9, 6]], (x, y) => (x + y < 11 ? light : mat));
    line(t, 9, 6, 12, 7, dark);
  } else if (type === 'hoe') {
    line(t, 6, 3, 11, 3, light);
    line(t, 6, 4, 9, 4, mat);
    t.set(11, 4, dark); t.set(10, 4, dark);
  } else if (type === 'shovel') {
    fillPoly(t, [[11.5, 0.5], [14.5, 3.5], [12, 7.5], [8, 7], [8.5, 3.5]], (x, y) => (x - y > 6 ? light : mat));
    line(t, 8, 7, 12, 7, dark);
  }
  outline(t);
}

const ITEM_GEN = {
  stick(t) { line(t, 3, 13, 12, 4, HANDLE); outline(t); },
  coal(t, r) { disc(t, 8, 8.5, 4.6, () => mul([45, 45, 48], 0.7 + r() * 0.6)); outline(t, [10, 10, 10]); },
  charcoal(t, r) { disc(t, 8, 8.5, 4.6, () => mul([60, 48, 36], 0.7 + r() * 0.6)); outline(t, [20, 14, 8]); },
  iron_ingot(t) { ingot(t, [216, 216, 216]); },
  gold_ingot(t) { ingot(t, [250, 220, 70]); },
  diamond(t) {
    fillPoly(t, [[4, 5], [6, 3], [10, 3], [12, 5], [8, 13]], (x, y) => (y < 6 ? [200, 255, 250] : x < 8 ? [90, 230, 225] : [40, 180, 180]));
    outline(t, [20, 70, 80]);
  },
  flint(t) { fillPoly(t, [[5, 4], [10, 3], [12, 9], [8, 13], [4, 9]], (x, y) => (x + y < 13 ? [90, 90, 96] : [55, 55, 60])); outline(t, [20, 20, 22]); },
  gunpowder(t, r) { for (let i = 0; i < 40; i++) { const a = r() * Math.PI * 2, d = Math.sqrt(r()) * 5; t.set(Math.round(8 + Math.cos(a) * d), Math.round(10 + Math.sin(a) * d * 0.6), mul([90, 90, 90], 0.6 + r() * 0.8)); } outline(t, [30, 30, 30]); },
  straw(t, r) { for (let i = 0; i < 7; i++) line(t, 3 + i, 13, 7 + i, 2 + (i % 3), mul([222, 190, 92], 0.8 + r() * 0.3)); line(t, 4, 9, 12, 9, [160, 120, 50]); outline(t, [90, 70, 30]); },
  bowl(t) { fillPoly(t, [[2, 7], [14, 7], [12, 12], [4, 12]], (x, y) => (y === 7 ? [70, 46, 24] : [140, 96, 52])); outline(t); },
  mushroom_stew(t) {
    fillPoly(t, [[2, 7], [14, 7], [12, 12], [4, 12]], [140, 96, 52]);
    for (let x = 3; x < 14; x++) t.set(x, 7, x % 3 ? [196, 142, 82] : [168, 112, 62]);
    for (let x = 4; x < 13; x++) t.set(x, 6, [176, 126, 70]);
    outline(t);
  },
  apple(t) {
    disc(t, 8, 9, 5, (x, y) => (x + y < 13 ? [235, 60, 50] : [190, 30, 30]));
    t.set(8, 3, [90, 60, 30]); t.set(8, 4, [90, 60, 30]); t.set(9, 3, [60, 140, 40]); t.set(10, 2, [60, 140, 40]);
    t.set(6, 7, [255, 160, 150]);
    outline(t, [70, 20, 20]);
  },
  porkchop(t) { meat(t, [240, 150, 150], [200, 100, 110]); },
  cooked_porkchop(t) { meat(t, [190, 120, 70], [140, 80, 40]); },
  mutton(t) { meat(t, [220, 90, 90], [170, 60, 60]); },
  cooked_mutton(t) { meat(t, [170, 100, 60], [120, 66, 36]); },
  rotten_flesh(t, r) { meat(t, [140, 130, 70], [100, 90, 40]); speckle(t, r, [80, 100, 40], 6); },
  flint_and_steel(t) {
    for (let a = 0; a < 20; a++) { const ang = (a / 20) * Math.PI * 1.6 + 0.8; t.set(Math.round(6 + Math.cos(ang) * 3.5), Math.round(6 + Math.sin(ang) * 3.5), [190, 190, 196]); }
    fillPoly(t, [[9, 9], [13, 8], [14, 12], [10, 14]], [70, 70, 76]);
    outline(t);
  },
  map(t) { mapIcon(t, false); },
  wheat_seeds(t, r) {
    for (const [x, y] of [[5, 6], [8, 4], [10, 7], [6, 10], [9, 10], [12, 11], [4, 12]]) {
      t.set(x, y, mul([110, 170, 60], 0.8 + r() * 0.4)); t.set(x + 1, y + 1, mul([70, 120, 40], 0.9 + r() * 0.2));
    }
  },
  wheat(t, r) {
    for (let i = 0; i < 4; i++) line(t, 3 + i, 14, 9 + i, 2 + i, (x, y) => mul(y < 7 ? [200, 160, 60] : [170, 140, 60], 0.85 + r() * 0.3));
    line(t, 5, 10, 10, 10, [130, 90, 40]);
    outline(t, [90, 66, 26]);
  },
  bread(t, r) {
    fillPoly(t, [[2, 9], [4, 6], [12, 5], [14, 8], [12, 11], [4, 12]], (x, y) => mul(y < 8 ? [200, 140, 70] : [170, 110, 50], 0.9 + r() * 0.15));
    for (const x of [6, 9, 12]) line(t, x - 1, 6, x, 9, [130, 80, 36]);
    outline(t, [90, 56, 24]);
  },
  bucket(t) { bucketIcon(t, null); },
  bow(t) {
    for (let k = 0; k <= 16; k++) {
      const s = k / 16;
      const x = Math.round(3 + s * 10 + Math.sin(s * Math.PI) * 2.2);
      const y = Math.round(13 - s * 10 + Math.sin(s * Math.PI) * 2.2);
      t.set(x, y, s > 0.4 && s < 0.6 ? [70, 46, 22] : [132, 92, 48]);
      t.set(x + 1, y, [96, 66, 32]);
    }
    line(t, 3, 12, 12, 3, [226, 226, 220]);
    outline(t, [40, 26, 12]);
  },
  arrow(t) {
    line(t, 3, 12, 11, 4, [120, 86, 44]);
    fillPoly(t, [[10, 2.5], [13.5, 2.5], [13.5, 6], [12, 5], [11, 4]], [120, 120, 126]);
    t.set(12, 3, [200, 200, 206]);
    for (const [x, y] of [[2, 11], [3, 13], [1, 12], [4, 14], [2, 13]]) t.set(x, y, [236, 236, 230]);
    outline(t, [30, 24, 20]);
  },
  string(t) {
    for (let x = 2; x < 14; x++) t.set(x, Math.round(8 + Math.sin(x * 0.9) * 2.5), [236, 236, 236]);
    outline(t, [90, 90, 90]);
  },
  bone(t) {
    line(t, 4, 11, 11, 4, [238, 234, 222]); line(t, 5, 11, 11, 5, [214, 208, 192]);
    for (const [x, y] of [[3, 11], [4, 12], [3, 12], [12, 4], [11, 3], [12, 3]]) t.set(x, y, [238, 234, 222]);
    outline(t, [90, 86, 76]);
  },
  bone_meal(t, r) {
    disc(t, 8, 9, 4.5, () => mul([238, 236, 228], 0.85 + r() * 0.2));
    outline(t, [110, 108, 100]);
  },
  milk_bucket(t) { bucketIcon(t, [246, 246, 240]); },
  leather(t, r) {
    fillPoly(t, [[3, 3], [12, 2], [14, 7], [12, 13], [5, 14], [2, 9]], (x, y) => mul((x + y) % 4 === 0 ? [140, 82, 46] : [166, 100, 56], 0.9 + r() * 0.15));
    outline(t, [70, 40, 20]);
  },
  beef(t) { meat(t, [214, 70, 66], [160, 40, 40]); },
  cooked_beef(t) { meat(t, [132, 78, 46], [96, 52, 30]); },
  chicken(t) {
    fillPoly(t, [[4, 4], [11, 3], [13, 8], [10, 12], [5, 11]], (x, y) => (x + y > 15 ? [226, 170, 150] : [244, 196, 176]));
    line(t, 10, 11, 13, 14, [236, 230, 214]); t.set(13, 14, [250, 250, 240]); t.set(14, 13, [250, 250, 240]);
    outline(t, [120, 70, 60]);
  },
  cooked_chicken(t) {
    fillPoly(t, [[4, 4], [11, 3], [13, 8], [10, 12], [5, 11]], (x, y) => (x + y > 15 ? [170, 104, 52] : [204, 138, 72]));
    line(t, 10, 11, 13, 14, [236, 230, 214]); t.set(13, 14, [250, 250, 240]); t.set(14, 13, [250, 250, 240]);
    outline(t, [90, 52, 24]);
  },
  feather(t) {
    line(t, 3, 13, 12, 3, [210, 210, 204]);
    for (let k = 0; k < 7; k++) { t.set(5 + k, 9 - k, [240, 240, 236]); t.set(6 + k, 10 - k, [246, 246, 242]); t.set(4 + k, 9 - k, [226, 226, 220]); }
    outline(t, [110, 110, 106]);
  },
  egg(t) {
    for (let y = 3; y < 14; y++) for (let x = 3; x < 13; x++) {
      const dx = (x + 0.5 - 8) / 4.6, dy = (y + 0.5 - 8.6) / (y < 8 ? 5.4 : 4.8);
      if (dx * dx + dy * dy <= 1) t.set(x, y, x + y < 12 ? [250, 242, 222] : [228, 212, 180]);
    }
    outline(t, [120, 100, 70]);
  },
  shears(t) {
    line(t, 4, 3, 10, 9, [216, 216, 220]); line(t, 5, 3, 11, 9, [170, 170, 176]);
    line(t, 11, 3, 5, 9, [216, 216, 220]); line(t, 12, 3, 6, 9, [170, 170, 176]);
    disc(t, 4.5, 11.5, 2, [60, 60, 66]); disc(t, 11.5, 11.5, 2, [60, 60, 66]);
    t.set(4, 11, [0, 0, 0], 0); t.set(11, 11, [0, 0, 0], 0);
    outline(t, [30, 30, 34]);
  },
  water_bucket(t) { bucketIcon(t, [52, 92, 224]); },
  lava_bucket(t) { bucketIcon(t, [230, 110, 30]); },
  explorer_map(t) { mapIcon(t, true); },
  raw_copper(t, r) { disc(t, 8, 9, 4.6, () => mul([192, 112, 80], 0.75 + r() * 0.5)); speckle(t, r, [124, 170, 140], 3); outline(t, [70, 36, 22]); },
  copper_ingot(t) { ingot(t, [214, 120, 84]); },
  redstone(t, r) { for (let i = 0; i < 46; i++) { const a = r() * Math.PI * 2, d = Math.sqrt(r()) * 5; t.set(Math.round(8 + Math.cos(a) * d), Math.round(10 + Math.sin(a) * d * 0.6), mul([220, 20, 10], 0.6 + r() * 0.6)); } outline(t, [70, 0, 0]); },
  lapis_lazuli(t, r) { fillPoly(t, [[4, 6], [9, 3], [13, 6], [11, 12], [5, 12]], () => mul([40, 80, 200], 0.8 + r() * 0.4)); speckle(t, r, [220, 190, 70], 2); outline(t, [14, 26, 80]); },
  emerald(t) {
    fillPoly(t, [[8, 1.5], [12.5, 6], [12.5, 10], [8, 14.5], [3.5, 10], [3.5, 6]], (x, y) => (x < 7 && y < 8 ? [150, 255, 180] : x < 8 ? [60, 220, 110] : [24, 160, 70]));
    outline(t, [8, 70, 30]);
  },
  amethyst_shard(t) {
    fillPoly(t, [[3, 13], [6, 6], [10, 2], [12, 4], [9, 9], [5, 14]], (x, y) => (x + y < 14 ? [226, 186, 255] : [150, 100, 210]));
    outline(t, [70, 40, 110]);
  },
  glow_berries(t) {
    line(t, 8, 1, 8, 5, [70, 110, 40]); line(t, 8, 3, 11, 2, [90, 130, 50]);
    disc(t, 6, 9, 3, (x, y) => (x + y < 13 ? [255, 220, 110] : [240, 150, 30]));
    disc(t, 10.5, 11, 2.6, (x, y) => (x + y < 19 ? [255, 210, 100] : [236, 140, 28]));
    outline(t, [110, 60, 10]);
  },
  ink_sac(t) { disc(t, 8, 9, 4.5, (x, y) => (x + y < 14 ? [70, 66, 90] : [34, 30, 48])); t.set(8, 3, [40, 36, 54]); t.set(8, 4, [40, 36, 54]); outline(t, [12, 10, 18]); },
  glow_ink_sac(t) { disc(t, 8, 9, 4.5, (x, y) => (x + y < 14 ? [120, 250, 220] : [40, 170, 150])); t.set(8, 3, [40, 140, 120]); t.set(8, 4, [40, 140, 120]); outline(t, [10, 60, 50]); },
  spyglass(t) {
    line(t, 3, 13, 9, 7, [194, 108, 80]); line(t, 4, 13, 10, 7, [150, 80, 56]);
    line(t, 9, 6, 12, 3, [214, 124, 90]); line(t, 10, 6, 13, 3, [160, 86, 60]);
    t.set(13, 2, [200, 170, 255]); t.set(12, 2, [170, 130, 230]); t.set(13, 3, [170, 130, 230]);
    outline(t, [60, 30, 18]);
  },
  lightning_rod(t) {
    for (let y = 4; y < 15; y++) { t.set(7, y, [214, 124, 90]); t.set(8, y, [160, 86, 60]); }
    for (let y = 1; y < 4; y++) for (let x = 6; x < 10; x++) t.set(x, y, x < 8 ? [226, 140, 104] : [176, 96, 66]);
    outline(t, [60, 30, 18]);
  },
};

// Armor icons from pixel maps: X outline, l light, m middle, d dark.
const ARMOR_MAPS = {
  helmet: [
    '................', '................', '................', '................',
    '....XXXXXXXX....', '...XllllllmmX...', '..XllmmmmmmmdX..', '..XlmXXXXXXmdX..',
    '..XmdX....XmdX..', '..XmdX....XmdX..', '..XXXX....XXXX..',
  ],
  chestplate: [
    '................', '..XXX......XXX..', '.XlmmX....XmmdX.', '.XlmmXXXXXXmmdX.',
    '.XlmmmmmmmmmmdX.', '.XXXlmmmmmmmXXX.', '...XlmmmmmmdX...', '...XlmmmmmmdX...',
    '...XlmmmmmmdX...', '...XlmmmmmmdX...', '...XmmmmmmmdX...', '...XXXXXXXXXX...',
  ],
  leggings: [
    '................', '................', '...XXXXXXXXXX...', '...XllllmmmmX...',
    '...XlmmmmmmdX...', '...XlmdXXlmdX...', '...XlmdXXlmdX...', '...XlmdXXlmdX...',
    '...XlmdXXlmdX...', '...XlmdXXlmdX...', '...XlmdXXlmdX...', '...XXXXXXXXXX...',
  ],
  boots: [
    '................', '................', '................', '................',
    '................', '..XXXX....XXXX..', '..XlmX....XlmX..', '..XlmX....XlmX..',
    '.XlmmX...XlmmX..', 'XlmmdX..XlmmdX..', 'XXXXXX..XXXXXX..',
  ],
};
const ARMOR_COLOR = { leather: [160, 100, 56], golden: [250, 214, 64], iron: [216, 216, 222], diamond: [86, 222, 212] };
function armorIcon(t, piece, base) {
  const pal = { X: mul(base, 0.32), l: mul(base, 1.22), m: base, d: mul(base, 0.72) };
  ARMOR_MAPS[piece].forEach((row, y) => [...row].forEach((ch, x) => { if (pal[ch]) t.set(x, y + 2, pal[ch]); }));
}

function bucketIcon(t, fill) {
  fillPoly(t, [[3, 5], [13, 5], [11.5, 14], [4.5, 14]], (x, y) => (x < 7 ? [216, 216, 220] : x > 10 ? [150, 150, 158] : [190, 190, 196]));
  for (let x = 4; x < 13; x++) t.set(x, 5, fill ?? [60, 60, 66]);
  if (fill) for (let x = 5; x < 12; x++) t.set(x, 6, mul(fill, 0.8));
  line(t, 3, 4, 6, 1, [130, 130, 136]); line(t, 6, 1, 10, 1, [130, 130, 136]); line(t, 10, 1, 13, 4, [130, 130, 136]);
  outline(t, [40, 40, 46]);
}

function ingot(t, c) {
  fillPoly(t, [[4, 6], [12, 6], [14, 11], [2, 11]], (x, y) => (y < 8 ? mul(c, 1.15) : y > 9 ? mul(c, 0.75) : c));
  outline(t, mul(c, 0.35));
}

function meat(t, c, dark) {
  fillPoly(t, [[3, 5], [9, 3], [13, 6], [12, 11], [6, 13], [3, 10]], (x, y) => (x + y > 17 ? dark : c));
  disc(t, 4, 12, 1.6, [235, 225, 205]);
  outline(t, mul(dark, 0.5));
}

function mapIcon(t, explorer) {
  for (let y = 2; y < 14; y++) for (let x = 2; x < 14; x++) t.set(x, y, (x + y) % 5 === 0 ? [200, 180, 130] : [226, 208, 158]);
  for (let x = 3; x < 13; x++) t.set(x, 6 + Math.round(Math.sin(x) * 1.2), [100, 150, 80]);
  if (explorer) {
    t.set(10, 9, [200, 30, 30]); t.set(11, 10, [200, 30, 30]); t.set(11, 9, [200, 30, 30]); t.set(10, 10, [200, 30, 30]);
    t.set(9, 8, [200, 30, 30]); t.set(12, 11, [200, 30, 30]); t.set(12, 8, [200, 30, 30]); t.set(9, 11, [200, 30, 30]);
  } else {
    t.set(6, 10, [60, 80, 160]); t.set(7, 10, [60, 80, 160]); t.set(7, 11, [60, 80, 160]);
  }
  outline(t, [110, 90, 60]);
}

for (const [tier, mat] of Object.entries(TIER_COLOR)) {
  for (const type of ['pickaxe', 'axe', 'shovel', 'sword', 'hoe']) ITEM_GEN[`${tier}_${type}`] = (t) => tool(t, type, mat);
}
for (const [mat, color] of Object.entries(ARMOR_COLOR)) {
  for (const piece of Object.keys(ARMOR_MAPS)) ITEM_GEN[`${mat}_${piece}`] = (t) => armorIcon(t, piece, color);
}
// A door item is the whole door, squeezed into the middle of the icon.
for (const wood of Object.keys(WOOD_COLOR)) {
  ITEM_GEN[`${wood}_door`] = (t) => {
    const top = paint(GEN[`${wood}_door_top`], `${wood}_door_top`);
    const bottom = paint(GEN[`${wood}_door_bottom`], `${wood}_door_bottom`);
    for (let y = 0; y < S; y++) for (let x = 0; x < 8; x++) {
      const src = y < 8 ? top : bottom;
      const [cr, cg, cb, ca] = src.get(x * 2, (y % 8) * 2);
      if (ca) t.set(x + 4, y, [cr, cg, cb]);
    }
  };
}
for (const [color] of COLORS) {
  ITEM_GEN[`${color}_bed`] = (t) => {
    const cover = mul(bedColor(color), 1.1);
    fillPoly(t, [[1, 7], [15, 7], [15, 11], [1, 11]], (x, y) => (x < 5 && y < 9 ? [236, 236, 230] : y < 9 ? cover : mul(cover, 0.77)));
    for (const x of [1, 2, 13, 14]) for (let y = 11; y < 14; y++) t.set(x, y, mul(OAK, 0.8));
    outline(t, mul(cover, 0.25));
  };
}
for (const name of Object.keys(ITEMS)) {
  const dye = ITEMS[name].dye;
  if (!dye) continue;
  ITEM_GEN[name] = (t, r) => {
    const c = hex(WOOL[dye]);
    disc(t, 8, 9, 4.5, () => mul(c, 0.85 + r() * 0.3));
    t.set(6, 7, mul(c, 1.3));
    outline(t, mul(c, 0.4));
  };
}

// --- Atlas ---------------------------------------------------------------------------

function seedOf(name) {
  let h = 2166136261;
  for (let i = 0; i < name.length; i++) h = Math.imul(h ^ name.charCodeAt(i), 16777619);
  return h >>> 0;
}

function paint(gen, name) {
  const t = new Tile();
  gen(t, mulberry32(seedOf(name)));
  return t;
}

function tileCanvas(tile) {
  const c = document.createElement('canvas');
  c.width = S;
  c.height = S;
  c.getContext('2d').putImageData(new ImageData(tile.d, S, S), 0, 0);
  return c;
}

export class TextureBank {
  // safe: build a plain 2D atlas (works on WebGL 1) instead of a texture array.
  constructor(safe = false) {
    this.safe = safe;
    this.tiles = new Map();
    this.layers = new Map();
    this.avg = [];
    for (const [name, gen] of Object.entries(GEN)) {
      this.layers.set(name, this.tiles.size);
      this.tiles.set(name, paint(gen, name));
    }
    setTextureLayers((name) => this.layers.get(name));
    this.waterLayer = this.layers.get('water');
    this.lavaLayer = this.layers.get('lava');
    this.fireLayer = this.layers.get('campfire_fire');
    this.atlas = this.buildAtlas();
    this.tileCanvases = new Map();
    for (const [name, tile] of this.tiles) this.tileCanvases.set(name, tileCanvas(tile));
    if (safe) this.atlas = this.buildAtlas2D();
    this.itemTiles = new Map();
    for (const [name, gen] of Object.entries(ITEM_GEN)) this.itemTiles.set(name, tileCanvas(paint(gen, name)));
    this.icons = new Map();
    this.iconUrls = new Map();
    this.destroy = this.buildDestroyStages();
  }

  buildAtlas() {
    const count = this.tiles.size;
    const data = new Uint8Array(S * S * 4 * count);
    let layer = 0;
    for (const tile of this.tiles.values()) {
      let r = 0, g = 0, b = 0, n = 0;
      for (let y = 0; y < S; y++) {
        // Flip rows: v = 1 is the top of a tile.
        const src = y * S * 4;
        const dst = layer * S * S * 4 + (S - 1 - y) * S * 4;
        data.set(tile.d.subarray(src, src + S * 4), dst);
        for (let x = 0; x < S; x++) {
          const i = src + x * 4;
          if (tile.d[i + 3] > 0) { r += tile.d[i]; g += tile.d[i + 1]; b += tile.d[i + 2]; n++; }
        }
      }
      this.avg.push(n ? [r / n / 255, g / n / 255, b / n / 255] : [1, 1, 1]);
      layer++;
    }
    const tex = new THREE.DataArrayTexture(data, S, S, count);
    tex.format = THREE.RGBAFormat;
    tex.type = THREE.UnsignedByteType;
    tex.magFilter = THREE.NearestFilter;
    tex.minFilter = THREE.NearestMipmapLinearFilter;
    tex.wrapS = THREE.RepeatWrapping;
    tex.wrapT = THREE.RepeatWrapping;
    tex.generateMipmaps = true;
    // Raw values: the chunk shader lights the texels as display colors and writes them
    // straight out, so the GPU must not sRGB-decode them (that darkened everything).
    tex.colorSpace = THREE.NoColorSpace;
    tex.needsUpdate = true;
    return tex;
  }

  // Tiles laid out 16 per row on one canvas; the safe shader picks a tile by layer index.
  buildAtlas2D() {
    const cols = 16;
    let rows = 1;
    while (rows * cols < this.tiles.size) rows *= 2;
    const c = document.createElement('canvas');
    c.width = cols * S;
    c.height = rows * S;
    const ctx = c.getContext('2d');
    let i = 0;
    for (const tile of this.tiles.values()) {
      ctx.putImageData(new ImageData(tile.d, S, S), (i % cols) * S, Math.floor(i / cols) * S);
      i++;
    }
    const tex = new THREE.CanvasTexture(c);
    tex.magFilter = THREE.NearestFilter;
    tex.minFilter = THREE.NearestFilter;
    tex.generateMipmaps = false;
    tex.colorSpace = THREE.NoColorSpace;
    this.atlasGrid = [cols, rows];
    return tex;
  }

  buildDestroyStages() {
    const rnd = mulberry32(99);
    const cracks = [];
    for (let i = 0; i < 10; i++) {
      let x = 8 + Math.floor((rnd() - 0.5) * 6);
      let y = 8 + Math.floor((rnd() - 0.5) * 6);
      const pts = [];
      for (let k = 0; k < 7; k++) {
        pts.push([x, y]);
        x += Math.round((rnd() - 0.5) * 3);
        y += Math.round((rnd() - 0.5) * 3);
      }
      cracks.push(pts);
    }
    const out = [];
    for (let stage = 0; stage < 10; stage++) {
      const t = new Tile();
      for (let c = 0; c <= stage; c++) {
        const pts = cracks[c];
        for (let k = 0; k < pts.length - 1; k++) line(t, pts[k][0], pts[k][1], pts[k + 1][0], pts[k + 1][1], [20, 20, 20]);
      }
      const tex = new THREE.CanvasTexture(tileCanvas(t));
      tex.magFilter = THREE.NearestFilter;
      tex.minFilter = THREE.NearestFilter;
      tex.colorSpace = THREE.SRGBColorSpace;
      out.push(tex);
    }
    return out;
  }

  // 64x64 canvas icon for any item name.
  icon(name) {
    let c = this.icons.get(name);
    if (c) return c;
    c = document.createElement('canvas');
    c.width = 64;
    c.height = 64;
    const ctx = c.getContext('2d');
    ctx.imageSmoothingEnabled = false;
    const def = ITEMS[name];
    const block = def?.block !== undefined ? BLOCKS[def.block] : null;
    const flat = this.itemTiles.get(name);
    if (flat) {
      ctx.drawImage(flat, 0, 0, 64, 64);
    } else if (block) {
      const shape = SHAPES[block.id];
      if (shape === SHAPE.CROSS || shape === SHAPE.TORCH || shape === SHAPE.LADDER || shape === SHAPE.PANE) {
        ctx.drawImage(this.tileCanvases.get(block.tex.side), 0, 0, 64, 64);
      } else {
        this.drawIso(ctx, block);
      }
    }
    this.icons.set(name, c);
    return c;
  }

  // The 16x16 picture of an item that's drawn flat (tools, food, plants, torches,
  // doors...), or null for items drawn as blocks.
  flatTile(name) {
    const flat = this.itemTiles.get(name);
    if (flat) return flat;
    const def = ITEMS[name];
    const block = def?.block !== undefined ? BLOCKS[def.block] : null;
    if (!block) return null;
    const shape = SHAPES[block.id];
    return shape === SHAPE.CROSS || shape === SHAPE.TORCH || shape === SHAPE.LADDER || shape === SHAPE.PANE ? this.tileCanvases.get(block.tex.side) : null;
  }

  iconUrl(name) {
    let u = this.iconUrls.get(name);
    if (!u) {
      u = this.icon(name).toDataURL();
      this.iconUrls.set(name, u);
    }
    return u;
  }

  drawIso(ctx, block) {
    let id = block.id;
    if (block.variants === 'facing') id = block.baseId + (block.shape === 'stairs' ? 3 : block.shape === 'shelf' ? 0 : 1);
    const b = BLOCKS[id];
    const fenceId = B.oak_fence;
    let boxes = shapeBoxes(id, (dx, dy, dz) => (dz !== 0 && b.fence ? fenceId : 0));
    if (b.shape === 'fence') boxes = [[0.1, 0, 0.375, 0.35, 1, 0.625], [0.65, 0, 0.375, 0.9, 1, 0.625], [0.35, 0.4, 0.44, 0.65, 0.55, 0.56], [0.35, 0.75, 0.44, 0.65, 0.9, 0.56]];
    const P = (x, y, z) => [4 + 28 * x + 28 * z, 16 - 14 * x + 14 * z + 32 * (1 - y)];
    const texFor = (f) => {
      const name = f === 2 ? b.tex.top : b.tex.side;
      if (b.tex.front && b.facing >= 0 && ((b.facing === 1 && f === 1) || (b.facing === 0 && f === 4))) return this.tileCanvases.get(b.tex.front);
      if (b.frontTwo && f === 4) return this.tileCanvases.get(b.tex.front);
      return this.tileCanvases.get(name);
    };
    // Each face is drawn and shaded on a scratch canvas so source-atop only darkens it.
    const scratch = document.createElement('canvas');
    scratch.width = 64;
    scratch.height = 64;
    const order = [...boxes].sort((a, b2) => (a[1] - b2[1]) || ((b2[0] - b2[2]) - (a[0] - a[2])));
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    for (const [x0, y0, z0, x1, y1, z1] of order) {
      drawFaceTo(ctx, scratch, texFor(2), x0 * 16, z0 * 16, (x1 - x0) * 16, (z1 - z0) * 16, P(x0, y1, z0), P(x1, y1, z0), P(x0, y1, z1), 1);
      drawFaceTo(ctx, scratch, texFor(1), z0 * 16, (1 - y1) * 16, (z1 - z0) * 16, (y1 - y0) * 16, P(x0, y1, z0), P(x0, y1, z1), P(x0, y0, z0), 0.62);
      drawFaceTo(ctx, scratch, texFor(4), x0 * 16, (1 - y1) * 16, (x1 - x0) * 16, (y1 - y0) * 16, P(x0, y1, z1), P(x1, y1, z1), P(x0, y0, z1), 0.8);
    }
  }
}

function drawFaceTo(ctx, scratch, img, sx, sy, sw, sh, p0, pu, pv, shade) {
  if (sw <= 0 || sh <= 0 || !img) return;
  const s = scratch.getContext('2d');
  s.setTransform(1, 0, 0, 1, 0, 0);
  s.clearRect(0, 0, 64, 64);
  s.imageSmoothingEnabled = false;
  s.setTransform((pu[0] - p0[0]) / sw, (pu[1] - p0[1]) / sw, (pv[0] - p0[0]) / sh, (pv[1] - p0[1]) / sh, p0[0], p0[1]);
  s.drawImage(img, sx, sy, sw, sh, 0, 0, sw + 0.03, sh + 0.03);
  if (shade < 1) {
    s.setTransform(1, 0, 0, 1, 0, 0);
    s.globalCompositeOperation = 'source-atop';
    s.fillStyle = `rgba(0,0,0,${1 - shade})`;
    s.fillRect(0, 0, 64, 64);
    s.globalCompositeOperation = 'source-over';
  }
  ctx.drawImage(scratch, 0, 0);
}

// Pixel-art HUD icons (hearts, hunger, air) as data URLs.
export function hudIcon(kind) {
  const maps = {
    heart: ['..XX.XX..', '.XrrXrrX.', 'XrwrrrrrX', 'XrrrrrrrX', 'XrrrrrrrX', '.XrrrrrX.', '..XrrrX..', '...XrX...', '....X....'],
    food: ['....XXX..', '...XmmmX.', '..XmlmmmX', '..XmmmmmX', '..XmmmmX.', '.XXXXXX..', 'XbX......', 'XbbX.....', '.XX......'],
    air: ['..XXXX...', '.XwwbbX..', 'XwbbbbbX.', 'XbbbbbbX.', 'XbbbbbbX.', 'XbbbbbbX.', '.XbbbbX..', '..XXXX...', '.........'],
    armor: ['.XX...XX.', 'XllX.XmdX', 'XlmmXmmdX', 'XlmmmmmdX', '.XlmmmmX.', '.XlmmmdX.', '.XlmmmdX.', '.XmmmmdX.', '..XXXXX..'],
  };
  const pal = {
    heart: { X: [40, 10, 10], r: [220, 30, 30], w: [255, 200, 200] },
    food: { X: [50, 30, 10], m: [180, 110, 50], l: [220, 160, 90], b: [235, 225, 205] },
    air: { X: [20, 40, 90], w: [255, 255, 255], b: [80, 150, 240] },
    armor: { X: [30, 30, 34], l: [236, 236, 240], m: [196, 196, 204], d: [136, 136, 146] },
  };
  const make = (variant) => {
    const c = document.createElement('canvas');
    c.width = 9;
    c.height = 9;
    const ctx = c.getContext('2d');
    const map = maps[kind];
    for (let y = 0; y < 9; y++) for (let x = 0; x < 9; x++) {
      const ch = map[y][x];
      if (ch === '.') continue;
      let col = pal[kind][ch];
      const empty = variant === 'empty' || (variant === 'half' && x > 4);
      if (empty && ch !== 'X') col = [40, 30, 30];
      ctx.fillStyle = `rgb(${col.join(',')})`;
      ctx.fillRect(x, y, 1, 1);
    }
    return c.toDataURL();
  };
  return { full: make('full'), half: make('half'), empty: make('empty') };
}

// Stone-textured fill for the title logo.
export function stoneDataUrl(bank, name = 'stone', scale = 4) {
  const c = document.createElement('canvas');
  c.width = 16 * scale;
  c.height = 16 * scale;
  const ctx = c.getContext('2d');
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(bank.tileCanvases.get(name), 0, 0, c.width, c.height);
  return c.toDataURL();
}
