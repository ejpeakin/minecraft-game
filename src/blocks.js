// Block registry. Every block gets a numeric id (stored in chunk Uint16Arrays) in
// registration order, so the order of DEFS is part of the save format: append new
// blocks at the end. Hot per-block properties are mirrored into typed arrays for the
// mesher, lighting and physics.

// Face order used everywhere: +x, -x, +y, -y, +z, -z.
export const FACES = [
  [1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1],
];

// Facing values for blocks with a front (furnace, chest, stairs, shelf mushrooms):
// 0 = +z (south), 1 = -x (west), 2 = -z (north), 3 = +x (east). Maps to a face index.
export const FACING_FACE = [4, 1, 5, 0];
export const FACING_DIR = [[0, 1], [-1, 0], [0, -1], [1, 0]];

export const SHAPE = {
  NONE: 0, CUBE: 1, CROSS: 2, TORCH: 3, CACTUS: 4, LIQUID: 5,
  SLAB: 6, STAIRS: 7, CUSHION: 8, BED: 9, FENCE: 10, CAMPFIRE: 11, SHELF: 12,
};
export const PASS = { OPAQUE: 0, CUTOUT: 1, WATER: 2 };

export const COLORS = [
  ['white', 'White'], ['orange', 'Orange'], ['magenta', 'Magenta'], ['light_blue', 'Light Blue'],
  ['yellow', 'Yellow'], ['lime', 'Lime'], ['pink', 'Pink'], ['gray', 'Gray'],
  ['light_gray', 'Light Gray'], ['cyan', 'Cyan'], ['purple', 'Purple'], ['blue', 'Blue'],
  ['brown', 'Brown'], ['green', 'Green'], ['red', 'Red'], ['black', 'Black'],
];

const DEFS = [];
const def = (name, props) => DEFS.push({ name, ...props });

const STONE = { sound: 'stone', tool: 'pickaxe', level: 0 };
const WOOD = { sound: 'wood', tool: 'axe' };
const PLANT = { shape: 'cross', solid: false, opaque: false, pass: 'cutout', hardness: 0, sound: 'grass', plant: true, washable: true };
const PARTIAL = { opaque: false };
const WATER_FLOW = { label: 'Water', shape: 'liquid', solid: false, opaque: false, pass: 'water', filter: 2, hardness: -1, replaceable: true, fluid: 'water', noItem: true };
const LAVA_FLOW = { label: 'Lava', shape: 'liquid', solid: false, opaque: false, pass: 'opaque', emit: 15, hardness: -1, replaceable: true, fluid: 'lava', noItem: true };
const LOG = (wood, label) => ({ label, tex: { top: `${wood}_log_top`, bottom: `${wood}_log_top`, side: `${wood}_log` }, hardness: 2, fuel: 15, ...WOOD, variants: 'axis' });

def('air', { label: 'Air', shape: 'none', solid: false, opaque: false, hardness: 0, replaceable: true, noItem: true });
def('stone', { label: 'Stone', tex: 'stone', hardness: 1.5, drop: 'cobblestone', ...STONE });
def('grass', { label: 'Grass Block', tex: { top: 'grass_top', bottom: 'dirt', side: 'grass_side' }, hardness: 0.6, drop: 'dirt', sound: 'grass', tool: 'shovel' });
def('dirt', { label: 'Dirt', tex: 'dirt', hardness: 0.5, sound: 'gravel', tool: 'shovel' });
def('cobblestone', { label: 'Cobblestone', tex: 'cobblestone', hardness: 2, ...STONE });
def('oak_planks', { label: 'Oak Planks', tex: 'oak_planks', hardness: 2, fuel: 15, ...WOOD });
def('bedrock', { label: 'Bedrock', tex: 'bedrock', hardness: -1, sound: 'stone', blastproof: true });
def('sand', { label: 'Sand', tex: 'sand', hardness: 0.5, sound: 'sand', tool: 'shovel', falls: true });
def('gravel', { label: 'Gravel', tex: 'gravel', hardness: 0.6, sound: 'gravel', tool: 'shovel', falls: true });
def('oak_log', LOG('oak', 'Oak Log'));
def('oak_leaves', { label: 'Oak Leaves', tex: 'oak_leaves', opaque: false, pass: 'cutout', filter: 1, hardness: 0.2, sound: 'grass', leaves: 'oak' });
def('birch_log', LOG('birch', 'Birch Log'));
def('birch_leaves', { label: 'Birch Leaves', tex: 'birch_leaves', opaque: false, pass: 'cutout', filter: 1, hardness: 0.2, sound: 'grass', leaves: 'birch' });
def('spruce_log', LOG('spruce', 'Spruce Log'));
def('spruce_leaves', { label: 'Spruce Leaves', tex: 'spruce_leaves', opaque: false, pass: 'cutout', filter: 1, hardness: 0.2, sound: 'grass', leaves: 'spruce' });
def('glass', { label: 'Glass', tex: 'glass', opaque: false, pass: 'cutout', hardness: 0.3, sound: 'glass', drop: null, cullSelf: true });
def('coal_ore', { label: 'Coal Ore', tex: 'coal_ore', hardness: 3, drop: 'coal', ...STONE });
def('iron_ore', { label: 'Iron Ore', tex: 'iron_ore', hardness: 3, ...STONE, level: 1 });
def('gold_ore', { label: 'Gold Ore', tex: 'gold_ore', hardness: 3, ...STONE, level: 2 });
def('diamond_ore', { label: 'Diamond Ore', tex: 'diamond_ore', hardness: 3, drop: 'diamond', ...STONE, level: 2 });
def('snowy_grass', { label: 'Snowy Grass Block', tex: { top: 'snow', bottom: 'dirt', side: 'grass_snow_side' }, hardness: 0.6, drop: 'dirt', sound: 'snow', tool: 'shovel' });
def('snow_block', { label: 'Snow Block', tex: 'snow', hardness: 0.2, sound: 'snow', tool: 'shovel' });
def('ice', { label: 'Ice', tex: 'ice', opaque: false, pass: 'water', filter: 1, hardness: 0.5, sound: 'glass', drop: null, cullSelf: true, tool: 'pickaxe', slippery: true });
def('cactus', { label: 'Cactus', tex: { top: 'cactus_top', bottom: 'cactus_bottom', side: 'cactus_side' }, shape: 'cactus', opaque: false, pass: 'cutout', hardness: 0.4, sound: 'cloth', hurts: true });
def('crafting_table', { label: 'Crafting Table', tex: { top: 'crafting_table_top', bottom: 'oak_planks', side: 'crafting_table_side', front: 'crafting_table_front' }, hardness: 2.5, fuel: 15, interact: 'crafting', ...WOOD, frontTwo: true });
def('furnace', { label: 'Furnace', tex: { top: 'furnace_top', bottom: 'furnace_top', side: 'furnace_side', front: 'furnace_front' }, hardness: 3.5, interact: 'furnace', ...STONE, variants: 'facing' });
def('furnace_lit', { label: 'Furnace', tex: { top: 'furnace_top', bottom: 'furnace_top', side: 'furnace_side', front: 'furnace_front_on' }, hardness: 3.5, interact: 'furnace', emit: 13, drop: 'furnace', ...STONE, variants: 'facing', noItem: true });
def('chest', { label: 'Chest', tex: { top: 'chest_top', bottom: 'chest_top', side: 'chest_side', front: 'chest_front' }, hardness: 2.5, interact: 'chest', ...WOOD, variants: 'facing' });
def('bricks', { label: 'Bricks', tex: 'bricks', hardness: 2, ...STONE });
def('torch', { label: 'Torch', tex: 'torch', shape: 'torch', solid: false, opaque: false, pass: 'cutout', emit: 14, hardness: 0, sound: 'wood', washable: true });
def('tall_grass', { label: 'Grass', tex: 'tall_grass', ...PLANT, drop: null, replaceable: true });
def('dandelion', { label: 'Dandelion', tex: 'dandelion', ...PLANT });
def('poppy', { label: 'Poppy', tex: 'poppy', ...PLANT });
def('oak_sapling', { label: 'Oak Sapling', tex: 'oak_sapling', ...PLANT, sapling: 'oak' });
def('tnt', { label: 'TNT', tex: { top: 'tnt_top', bottom: 'tnt_bottom', side: 'tnt_side' }, hardness: 0, sound: 'grass', interact: 'tnt' });
def('glowstone', { label: 'Glowstone', tex: 'glowstone', hardness: 0.3, emit: 15, sound: 'glass' });
def('obsidian', { label: 'Obsidian', tex: 'obsidian', hardness: 50, ...STONE, level: 3, blastproof: true });
def('bookshelf', { label: 'Bookshelf', tex: { top: 'oak_planks', bottom: 'oak_planks', side: 'bookshelf' }, hardness: 1.5, fuel: 15, ...WOOD });
def('sandstone', { label: 'Sandstone', tex: { top: 'sandstone_top', bottom: 'sandstone_bottom', side: 'sandstone_side' }, hardness: 0.8, ...STONE });
def('stone_bricks', { label: 'Stone Bricks', tex: 'stone_bricks', hardness: 1.5, ...STONE });
def('dead_bush', { label: 'Dead Bush', tex: 'dead_bush', ...PLANT, replaceable: true });
def('birch_planks', { label: 'Birch Planks', tex: 'birch_planks', hardness: 2, fuel: 15, ...WOOD });
def('spruce_planks', { label: 'Spruce Planks', tex: 'spruce_planks', hardness: 2, fuel: 15, ...WOOD });
def('mossy_cobblestone', { label: 'Mossy Cobblestone', tex: 'mossy_cobblestone', hardness: 2, ...STONE });
def('iron_block', { label: 'Block of Iron', tex: 'iron_block', hardness: 5, ...STONE, level: 1 });
def('gold_block', { label: 'Block of Gold', tex: 'gold_block', hardness: 3, ...STONE, level: 2 });
def('diamond_block', { label: 'Block of Diamond', tex: 'diamond_block', hardness: 5, ...STONE, level: 2 });
def('birch_sapling', { label: 'Birch Sapling', tex: 'birch_sapling', ...PLANT, sapling: 'birch' });
def('spruce_sapling', { label: 'Spruce Sapling', tex: 'spruce_sapling', ...PLANT, sapling: 'spruce' });
def('water', { ...WATER_FLOW, tex: 'water', level: 0, source: true });
for (let l = 1; l <= 7; l++) def(`water_${l}`, { ...WATER_FLOW, tex: 'water', level: l });
def('water_falling', { ...WATER_FLOW, tex: 'water', level: 0, falling: true });
def('lava', { ...LAVA_FLOW, tex: 'lava', level: 0, source: true });
for (let l = 1; l <= 3; l++) def(`lava_${l}`, { ...LAVA_FLOW, tex: 'lava', level: l * 2 });
def('lava_falling', { ...LAVA_FLOW, tex: 'lava', level: 0, falling: true });
def('oak_fence', { label: 'Oak Fence', tex: 'oak_planks', shape: 'fence', ...PARTIAL, hardness: 2, fuel: 15, ...WOOD, fence: true });

// --- Wilderness Bound -------------------------------------------------------------
def('poplar_log', LOG('poplar', 'Poplar Log'));
def('poplar_planks', { label: 'Poplar Planks', tex: 'poplar_planks', hardness: 2, fuel: 15, ...WOOD });
def('red_poplar_leaves', { label: 'Red Poplar Leaves', tex: 'red_poplar_leaves', opaque: false, pass: 'cutout', filter: 1, hardness: 0.2, sound: 'grass', leaves: 'poplar', leafColor: 0xc8402c });
def('orange_poplar_leaves', { label: 'Orange Poplar Leaves', tex: 'orange_poplar_leaves', opaque: false, pass: 'cutout', filter: 1, hardness: 0.2, sound: 'grass', leaves: 'poplar', leafColor: 0xe0822a });
def('yellow_poplar_leaves', { label: 'Yellow Poplar Leaves', tex: 'yellow_poplar_leaves', opaque: false, pass: 'cutout', filter: 1, hardness: 0.2, sound: 'grass', leaves: 'poplar', leafColor: 0xe8c23a });
def('poplar_sapling', { label: 'Poplar Sapling', tex: 'poplar_sapling', ...PLANT, sapling: 'poplar' });
def('poplar_slab', { label: 'Poplar Slab', tex: 'poplar_planks', shape: 'slab', ...PARTIAL, hardness: 2, fuel: 7, ...WOOD });
def('poplar_stairs', { label: 'Poplar Stairs', tex: 'poplar_planks', shape: 'stairs', ...PARTIAL, hardness: 2, fuel: 15, ...WOOD, variants: 'facing' });
def('poplar_fence', { label: 'Poplar Fence', tex: 'poplar_planks', shape: 'fence', ...PARTIAL, hardness: 2, fuel: 15, ...WOOD, fence: true });
def('red_shrub', { label: 'Red Shrub', tex: 'red_shrub', ...PLANT, replaceable: true });
def('shelf_mushroom', { label: 'Shelf Mushroom', tex: { top: 'shelf_mushroom_top', bottom: 'shelf_mushroom_bottom', side: 'shelf_mushroom_side' }, shape: 'shelf', solid: false, ...PARTIAL, pass: 'cutout', hardness: 0.1, sound: 'cloth', variants: 'facing', shelf: 'small', washable: true });
def('large_shelf_mushroom', { label: 'Large Shelf Mushroom', tex: { top: 'shelf_mushroom_top', bottom: 'shelf_mushroom_bottom', side: 'shelf_mushroom_side' }, shape: 'shelf', solid: false, ...PARTIAL, pass: 'cutout', hardness: 0.1, sound: 'cloth', variants: 'facing', shelf: 'large', noItem: true, drop: 'shelf_mushroom', dropCount: 2, washable: true });
def('straw_bed', { label: 'Straw Bed', tex: { top: 'straw_bed_top', bottom: 'poplar_planks', side: 'straw_bed_side' }, shape: 'bed', ...PARTIAL, hardness: 0.3, sound: 'grass', interact: 'bed' });
def('campfire', { label: 'Campfire', tex: { top: 'campfire_log', bottom: 'campfire_log', side: 'campfire_log' }, shape: 'campfire', ...PARTIAL, pass: 'cutout', emit: 15, hardness: 2, ...WOOD, interact: 'campfire', hurts: true, drop: 'charcoal' });
def('barrel', { label: 'Barrel', tex: { top: 'barrel_top', bottom: 'barrel_bottom', side: 'barrel_side' }, hardness: 2.5, fuel: 15, ...WOOD, interact: 'chest' });
for (const [color, label] of COLORS) {
  def(`${color}_wool`, { label: `${label} Wool`, tex: `${color}_wool`, hardness: 0.8, sound: 'cloth', color });
  def(`${color}_concrete`, { label: `${label} Concrete`, tex: `${color}_concrete`, hardness: 1.8, ...STONE, color });
}
for (const [color, label] of COLORS) {
  def(`${color}_wool_slab`, { label: `${label} Wool Slab`, tex: `${color}_wool`, shape: 'slab', ...PARTIAL, hardness: 0.8, sound: 'cloth' });
  def(`${color}_wool_stairs`, { label: `${label} Wool Stairs`, tex: `${color}_wool`, shape: 'stairs', ...PARTIAL, hardness: 0.8, sound: 'cloth', variants: 'facing' });
  def(`${color}_concrete_slab`, { label: `${label} Concrete Slab`, tex: `${color}_concrete`, shape: 'slab', ...PARTIAL, hardness: 1.8, ...STONE });
  def(`${color}_concrete_stairs`, { label: `${label} Concrete Stairs`, tex: `${color}_concrete`, shape: 'stairs', ...PARTIAL, hardness: 1.8, ...STONE, variants: 'facing' });
  def(`${color}_cushion`, { label: `${label} Cushion`, tex: `${color}_wool`, shape: 'cushion', ...PARTIAL, hardness: 0.3, sound: 'cloth', interact: 'sit' });
}
def('oak_slab', { label: 'Oak Slab', tex: 'oak_planks', shape: 'slab', ...PARTIAL, hardness: 2, fuel: 7, ...WOOD });
def('oak_stairs', { label: 'Oak Stairs', tex: 'oak_planks', shape: 'stairs', ...PARTIAL, hardness: 2, fuel: 15, ...WOOD, variants: 'facing' });
def('cobblestone_slab', { label: 'Cobblestone Slab', tex: 'cobblestone', shape: 'slab', ...PARTIAL, hardness: 2, ...STONE });
def('cobblestone_stairs', { label: 'Cobblestone Stairs', tex: 'cobblestone', shape: 'stairs', ...PARTIAL, hardness: 2, ...STONE, variants: 'facing' });

// Expand variant blocks into several ids. 'facing' → 4 ids (base faces +z);
// 'axis' → 3 ids (0 = y, 1 = x, 2 = z).
export const BLOCKS = [];
export const BLOCK_ID = {};
for (const d of DEFS) {
  const count = d.variants === 'facing' ? 4 : d.variants === 'axis' ? 3 : 1;
  for (let v = 0; v < count; v++) {
    const id = BLOCKS.length;
    BLOCKS.push({
      id,
      name: d.name,
      label: d.label,
      tex: typeof d.tex === 'string' ? { top: d.tex, bottom: d.tex, side: d.tex } : d.tex ?? null,
      shape: d.shape ?? 'cube',
      solid: d.solid ?? true,
      opaque: d.opaque ?? true,
      pass: d.pass ?? 'opaque',
      emit: d.emit ?? 0,
      filter: d.filter ?? 0,
      hardness: d.hardness ?? 1,
      tool: d.tool ?? null,
      level: d.level ?? -1,
      drop: 'drop' in d ? d.drop : d.name,
      dropCount: d.dropCount ?? 1,
      sound: d.sound ?? 'stone',
      replaceable: d.replaceable ?? false,
      falls: d.falls ?? false,
      fluid: d.fluid ?? null,
      fluidLevel: d.level ?? 0,
      source: d.source ?? false,
      fallingFluid: d.falling ?? false,
      interact: d.interact ?? null,
      facing: d.variants === 'facing' ? v : -1,
      axis: d.variants === 'axis' ? v : -1,
      variants: d.variants ?? null,
      frontTwo: d.frontTwo ?? false,
      baseId: id - v,
      item: d.noItem ? null : d.name,
      fuel: d.fuel ?? 0,
      leaves: d.leaves ?? null,
      leafColor: d.leafColor ?? 0,
      sapling: d.sapling ?? null,
      shelf: d.shelf ?? null,
      plant: d.plant ?? false,
      washable: d.washable ?? false,
      cullSelf: d.cullSelf ?? false,
      hurts: d.hurts ?? false,
      blastproof: d.blastproof ?? false,
      slippery: d.slippery ?? false,
      fence: d.fence ?? false,
      color: d.color ?? null,
    });
    if (v === 0) BLOCK_ID[d.name] = id;
  }
}

export const B = BLOCK_ID;
export const BLOCK_COUNT = BLOCKS.length;
const N = BLOCK_COUNT;
export const OPAQUE = new Uint8Array(N);
export const SOLID = new Uint8Array(N);
export const EMIT = new Uint8Array(N);
export const FILTER = new Uint8Array(N);
export const SHAPES = new Uint8Array(N);
export const PASSES = new Uint8Array(N);
export const FLUID = new Uint8Array(N); // 0 none, 1 water, 2 lava
export const CULL_SELF = new Uint8Array(N);
// Texture layer and quarter-turn uv rotation per block face, filled in once the atlas
// is built (see setTextureLayers).
export const FACE_TEX = new Uint16Array(N * 6);
export const FACE_ROT = new Uint8Array(N * 6);

for (const b of BLOCKS) {
  OPAQUE[b.id] = b.opaque && b.shape === 'cube' ? 1 : 0;
  SOLID[b.id] = b.solid ? 1 : 0;
  EMIT[b.id] = b.emit;
  FILTER[b.id] = b.filter;
  SHAPES[b.id] = SHAPE[b.shape.toUpperCase()];
  PASSES[b.id] = PASS[b.pass.toUpperCase()];
  FLUID[b.id] = b.fluid === 'water' ? 1 : b.fluid === 'lava' ? 2 : 0;
  CULL_SELF[b.id] = b.cullSelf || b.fluid ? 1 : 0;
}

export function setTextureLayers(layerOf) {
  for (const b of BLOCKS) {
    if (!b.tex) continue;
    for (let f = 0; f < 6; f++) {
      let name = f === 2 ? b.tex.top : f === 3 ? b.tex.bottom : b.tex.side;
      let rot = 0;
      if (b.tex.front) {
        if (b.facing >= 0 && FACING_FACE[b.facing] === f) name = b.tex.front;
        if (b.frontTwo && (f === 4 || f === 0)) name = b.tex.front;
      }
      if (b.axis === 1) {
        // Log lying along x: ends on ±x, bark rotated on the other four faces.
        name = f <= 1 ? b.tex.top : b.tex.side;
        rot = f >= 2 ? 1 : 0;
      } else if (b.axis === 2) {
        name = f >= 4 ? b.tex.top : b.tex.side;
        rot = f <= 1 ? 1 : f <= 3 ? 0 : 0;
      }
      const layer = layerOf(name);
      if (layer === undefined) throw new Error(`Missing texture ${name} for ${b.name}`);
      FACE_TEX[b.id * 6 + f] = layer;
      FACE_ROT[b.id * 6 + f] = rot;
    }
  }
}

export function fluidId(kind, level, falling = false) {
  if (kind === 1) {
    if (falling) return B.water_falling;
    return level === 0 ? B.water : B.water + level;
  }
  if (falling) return B.lava_falling;
  return level === 0 ? B.lava : B.lava + level / 2;
}

// Axis-aligned boxes (in block units, 0..1) that make up a non-cube block. `get(dx, dy,
// dz)` returns the id of a neighbor, used by fences to connect. `collide` widens a few
// shapes the way Minecraft does (fences are 1.5 tall so they can't be jumped).
const H = 1 / 16;
export function shapeBoxes(id, get, collide = false) {
  const b = BLOCKS[id];
  switch (SHAPES[id]) {
    case SHAPE.CUBE:
    case SHAPE.LIQUID:
      return [[0, 0, 0, 1, 1, 1]];
    case SHAPE.CACTUS:
      return [[H, 0, H, 1 - H, 1, 1 - H]];
    case SHAPE.SLAB:
      return [[0, 0, 0, 1, 0.5, 1]];
    case SHAPE.STAIRS: {
      const top = [[0, 0.5, 0.5, 1, 1, 1], [0, 0.5, 0, 0.5, 1, 1], [0, 0.5, 0, 1, 1, 0.5], [0.5, 0.5, 0, 1, 1, 1]][b.facing];
      return [[0, 0, 0, 1, 0.5, 1], top];
    }
    case SHAPE.CUSHION:
      return [[H, 0, H, 1 - H, 3 * H, 1 - H]];
    case SHAPE.BED:
      return [[0, 0, 0, 1, 7 * H, 1]];
    case SHAPE.CAMPFIRE:
      return collide ? [[0, 0, 0, 1, 7 * H, 1]] : [
        [H, 0, 4 * H, 15 * H, 4 * H, 6 * H], [H, 0, 10 * H, 15 * H, 4 * H, 12 * H],
        [4 * H, 3 * H, H, 6 * H, 7 * H, 15 * H], [10 * H, 3 * H, H, 12 * H, 7 * H, 15 * H],
      ];
    case SHAPE.SHELF: {
      const large = b.shelf === 'large';
      const out = large ? 9 * H : 6 * H;
      const w0 = large ? 0 : 3 * H;
      const w1 = large ? 1 : 13 * H;
      const y0 = large ? 5 * H : 6 * H;
      const y1 = y0 + 2 * H;
      // Attached to the face opposite its facing, sticking out toward the facing.
      return [[
        [w0, y0, 0, w1, y1, out],
        [1 - out, y0, w0, 1, y1, w1],
        [w0, y0, 1 - out, w1, y1, 1],
        [0, y0, w0, out, y1, w1],
      ][b.facing]];
    }
    case SHAPE.FENCE: {
      const top = collide ? 1.5 : 1;
      const boxes = [[6 * H, 0, 6 * H, 10 * H, top, 10 * H]];
      const links = [[1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1]];
      for (const [dx, , dz] of links) {
        const n = get(dx, 0, dz);
        if (!(BLOCKS[n]?.fence || OPAQUE[n])) continue;
        const x0 = dx > 0 ? 10 * H : dx < 0 ? 0 : 7 * H;
        const x1 = dx > 0 ? 1 : dx < 0 ? 6 * H : 9 * H;
        const z0 = dz > 0 ? 10 * H : dz < 0 ? 0 : 7 * H;
        const z1 = dz > 0 ? 1 : dz < 0 ? 6 * H : 9 * H;
        if (collide) boxes.push([x0, 0, z0, x1, 1.5, z1]);
        else boxes.push([x0, 6 * H, z0, x1, 9 * H, z1], [x0, 12 * H, z0, x1, 15 * H, z1]);
      }
      return boxes;
    }
    case SHAPE.TORCH:
      return [[7 * H, 0, 7 * H, 9 * H, 10 * H, 9 * H]];
    case SHAPE.CROSS:
      return [[2 * H, 0, 2 * H, 14 * H, 13 * H, 14 * H]];
    default:
      return [];
  }
}

export const isFluid = (id) => FLUID[id] !== 0;
export const blockOf = (id) => BLOCKS[id];
