// Items, tools, food, crafting recipes and smelting. Block items share the block's
// name; everything else is a plain item with an icon painted in textures.js.
import { BLOCKS, B, COLORS, WOODS } from './blocks.js';

export const ITEMS = {};

function item(name, props) {
  ITEMS[name] = { name, label: name, maxStack: 64, ...props };
}

for (const b of BLOCKS) {
  if (b.item && b.id === b.baseId && !ITEMS[b.name]) {
    item(b.name, { label: b.label, block: b.id, fuel: b.fuel });
  }
}

item('stick', { label: 'Stick', fuel: 5 });
item('coal', { label: 'Coal', fuel: 80 });
item('charcoal', { label: 'Charcoal', fuel: 80 });
item('iron_ingot', { label: 'Iron Ingot' });
item('gold_ingot', { label: 'Gold Ingot' });
item('diamond', { label: 'Diamond' });
item('flint', { label: 'Flint' });
item('gunpowder', { label: 'Gunpowder' });
item('straw', { label: 'Straw', fuel: 3 });
item('bowl', { label: 'Bowl', fuel: 5 });
item('apple', { label: 'Apple', food: { hunger: 4, saturation: 2.4 } });
item('porkchop', { label: 'Raw Porkchop', food: { hunger: 3, saturation: 1.8 } });
item('cooked_porkchop', { label: 'Cooked Porkchop', food: { hunger: 8, saturation: 12.8 } });
item('mutton', { label: 'Raw Mutton', food: { hunger: 2, saturation: 1.2 } });
item('cooked_mutton', { label: 'Cooked Mutton', food: { hunger: 6, saturation: 9.6 } });
item('rotten_flesh', { label: 'Rotten Flesh', food: { hunger: 4, saturation: 0.8 } });
item('mushroom_stew', { label: 'Mushroom Stew', maxStack: 1, food: { hunger: 6, saturation: 7.2, leaves: 'bowl' } });
item('flint_and_steel', { label: 'Flint and Steel', maxStack: 1, durability: 64, igniter: true });
item('map', { label: 'Map', maxStack: 1, map: true });
item('explorer_map', { label: 'Explorer Map', maxStack: 1, map: true });
for (const c of ['red', 'yellow', 'orange', 'green', 'lime', 'brown', 'black']) {
  item(`${c}_dye`, { label: `${COLORS.find(([k]) => k === c)[1]} Dye`, dye: c });
}

export const TIERS = {
  wooden: { label: 'Wooden', level: 0, speed: 2, durability: 59, damage: 0, material: 'planks' },
  stone: { label: 'Stone', level: 1, speed: 4, durability: 131, damage: 1, material: 'cobblestone' },
  iron: { label: 'Iron', level: 2, speed: 6, durability: 250, damage: 2, material: 'iron_ingot' },
  golden: { label: 'Golden', level: 0, speed: 12, durability: 32, damage: 0, material: 'gold_ingot' },
  diamond: { label: 'Diamond', level: 3, speed: 8, durability: 1561, damage: 3, material: 'diamond' },
};
const TOOL_BASE = { pickaxe: 2, axe: 3, shovel: 1.5, sword: 4 };
const TOOL_LABEL = { pickaxe: 'Pickaxe', axe: 'Axe', shovel: 'Shovel', sword: 'Sword' };

for (const [tier, t] of Object.entries(TIERS)) {
  for (const type of Object.keys(TOOL_BASE)) {
    item(`${tier}_${type}`, {
      label: `${t.label} ${TOOL_LABEL[type]}`,
      maxStack: 1,
      durability: t.durability,
      tool: { type, tier, level: t.level, speed: t.speed, damage: TOOL_BASE[type] + t.damage },
      fuel: tier === 'wooden' ? 10 : 0,
    });
  }
}

export function itemLabel(name) {
  return ITEMS[name]?.label ?? name;
}

export function maxStack(name) {
  return ITEMS[name]?.maxStack ?? 64;
}

// Seconds of burn time an item gives in a furnace.
export function fuelValue(name) {
  return ITEMS[name]?.fuel ?? 0;
}

// --- Crafting ----------------------------------------------------------------------

const PLANKS = ['oak_planks', 'birch_planks', 'spruce_planks', 'poplar_planks'];
const LOGS = ['oak_log', 'birch_log', 'spruce_log', 'poplar_log'];
const SLABS = ['oak_slab', 'birch_slab', 'spruce_slab', 'poplar_slab'];
const COALS = ['coal', 'charcoal'];

// Shaped recipes: rows of characters, '.' is empty, keys map to an item name or a list
// of accepted names. Patterns are matched after trimming and may be mirrored.
// Shapeless recipes list their ingredients and match in any position.
export const RECIPES = [];
function shaped(rows, keys, result, count = 1) {
  RECIPES.push({ rows, keys, result, count });
}
function shapeless(ingredients, result, count = 1) {
  RECIPES.push({ ingredients, result, count });
}

for (const wood of ['oak', 'birch', 'spruce', 'poplar']) shaped(['L'], { L: `${wood}_log` }, `${wood}_planks`, 4);
shaped(['P', 'P'], { P: PLANKS }, 'stick', 4);
shaped(['PP', 'PP'], { P: PLANKS }, 'crafting_table');
shaped(['CCC', 'C.C', 'CCC'], { C: 'cobblestone' }, 'furnace');
shaped(['PPP', 'P.P', 'PPP'], { P: PLANKS }, 'chest');
shaped(['PSP', 'P.P', 'PSP'], { P: PLANKS, S: SLABS }, 'barrel');
shaped(['C', 'S'], { C: COALS, S: 'stick' }, 'torch', 4);
shaped(['SS', 'SS'], { S: 'sand' }, 'sandstone');
shaped(['SS', 'SS'], { S: 'stone' }, 'stone_bricks', 4);
shaped(['GSG', 'SGS', 'GSG'], { G: 'gunpowder', S: 'sand' }, 'tnt');
shaped(['I.', '.F'], { I: 'iron_ingot', F: 'flint' }, 'flint_and_steel');
shaped(['P.P', '.P.'], { P: PLANKS }, 'bowl', 4);
shaped(['.S.', 'SCS', 'LLL'], { S: 'stick', C: COALS, L: LOGS }, 'campfire');
shaped(['SSS', 'PPP'], { S: 'straw', P: PLANKS }, 'straw_bed');
shaped(['SSS', 'SCS', 'SSS'], { S: 'straw', C: COALS }, 'map');
shapeless(['bowl', 'shelf_mushroom', 'shelf_mushroom'], 'mushroom_stew');
shapeless(['poppy'], 'red_dye');
shapeless(['red_shrub'], 'red_dye');
shapeless(['dandelion'], 'yellow_dye');
shapeless(['shelf_mushroom'], 'brown_dye');
shapeless([COALS], 'black_dye');
shapeless(['red_dye', 'yellow_dye'], 'orange_dye', 2);
shapeless(['green_dye', 'yellow_dye'], 'lime_dye', 2);
shaped(['SG', 'GS'], { S: 'sand', G: 'gravel' }, 'white_concrete', 4);
for (const [ingot, block] of [['iron_ingot', 'iron_block'], ['gold_ingot', 'gold_block'], ['diamond', 'diamond_block']]) {
  shaped(['III', 'III', 'III'], { I: ingot }, block);
  shaped(['B'], { B: block }, ingot, 9);
}
function slabsAndStairs(material, base) {
  shaped(['MMM'], { M: material }, `${base}_slab`, 6);
  shaped(['M..', 'MM.', 'MMM'], { M: material }, `${base}_stairs`, 4);
}
for (const [wood] of WOODS) {
  const P = `${wood}_planks`;
  slabsAndStairs(P, wood);
  shaped(['PSP', 'PSP'], { P, S: 'stick' }, `${wood}_fence`, 3);
  shaped(['SPS', 'SPS'], { P, S: 'stick' }, `${wood}_fence_gate`);
  shaped(['PP', 'PP', 'PP'], { P }, `${wood}_door`, 3);
  shaped(['PPP', 'PPP'], { P }, `${wood}_trapdoor`, 2);
}
slabsAndStairs('cobblestone', 'cobblestone');
slabsAndStairs('stone', 'stone');
slabsAndStairs('stone_bricks', 'stone_brick');
slabsAndStairs('bricks', 'brick');
slabsAndStairs('sandstone', 'sandstone');
shaped(['S.S', 'SSS', 'S.S'], { S: 'stick' }, 'ladder', 3);
shaped(['GGG', 'GGG'], { G: 'glass' }, 'glass_pane', 16);
shaped(['III', 'III'], { I: 'iron_ingot' }, 'iron_bars', 16);
for (const [color] of COLORS) {
  slabsAndStairs(`${color}_wool`, `${color}_wool`);
  slabsAndStairs(`${color}_concrete`, `${color}_concrete`);
  shaped(['W', 'W'], { W: `${color}_wool` }, `${color}_cushion`, 2);
  shaped(['WW'], { W: `${color}_wool` }, `${color}_carpet`, 3);
  if (ITEMS[`${color}_dye`]) {
    shaped(['WWW', 'WDW', 'WWW'], { W: 'white_wool', D: `${color}_dye` }, `${color}_wool`, 8);
    shaped(['WWW', 'WDW', 'WWW'], { W: 'white_concrete', D: `${color}_dye` }, `${color}_concrete`, 8);
  }
}
for (const [tier, t] of Object.entries(TIERS)) {
  const M = t.material === 'planks' ? PLANKS : t.material;
  shaped(['MMM', '.S.', '.S.'], { M, S: 'stick' }, `${tier}_pickaxe`);
  shaped(['MM', 'MS', '.S'], { M, S: 'stick' }, `${tier}_axe`);
  shaped(['M', 'S', 'S'], { M, S: 'stick' }, `${tier}_shovel`);
  shaped(['M', 'M', 'S'], { M, S: 'stick' }, `${tier}_sword`);
}

const accepts = (key, name) => (Array.isArray(key) ? key.includes(name) : key === name);

function trimGrid(names, w, h) {
  let minX = w, minY = h, maxX = -1, maxY = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (names[y * w + x]) {
        minX = Math.min(minX, x); maxX = Math.max(maxX, x);
        minY = Math.min(minY, y); maxY = Math.max(maxY, y);
      }
    }
  }
  if (maxX < 0) return null;
  const rows = [];
  for (let y = minY; y <= maxY; y++) {
    const row = [];
    for (let x = minX; x <= maxX; x++) row.push(names[y * w + x]);
    rows.push(row);
  }
  return rows;
}

function matchesShaped(recipe, rows, mirror) {
  if (recipe.rows.length !== rows.length) return false;
  const width = recipe.rows[0].length;
  if (rows[0].length !== width) return false;
  for (let y = 0; y < rows.length; y++) {
    for (let x = 0; x < width; x++) {
      const ch = recipe.rows[y][mirror ? width - 1 - x : x];
      const name = rows[y][x];
      if (ch === '.') {
        if (name) return false;
      } else if (!name || !accepts(recipe.keys[ch], name)) {
        return false;
      }
    }
  }
  return true;
}

function matchesShapeless(recipe, names) {
  const present = names.filter(Boolean);
  if (present.length !== recipe.ingredients.length) return false;
  const left = [...recipe.ingredients];
  for (const name of present) {
    const i = left.findIndex((key) => accepts(key, name));
    if (i < 0) return false;
    left.splice(i, 1);
  }
  return true;
}

// grid: array of stacks (or null), w x h. Returns { id, count } or null.
export function findRecipe(grid, w, h) {
  const names = grid.map((s) => s?.id ?? null);
  const rows = trimGrid(names, w, h);
  if (!rows) return null;
  for (const r of RECIPES) {
    if (r.ingredients ? matchesShapeless(r, names) : matchesShaped(r, rows, false) || matchesShaped(r, rows, true)) {
      return { id: r.result, count: r.count };
    }
  }
  return null;
}

// --- Smelting ----------------------------------------------------------------------

export const SMELTING = {
  iron_ore: 'iron_ingot',
  gold_ore: 'gold_ingot',
  diamond_ore: 'diamond',
  coal_ore: 'coal',
  sand: 'glass',
  cobblestone: 'stone',
  porkchop: 'cooked_porkchop',
  mutton: 'cooked_mutton',
  cactus: 'green_dye',
  oak_log: 'charcoal',
  birch_log: 'charcoal',
  spruce_log: 'charcoal',
  poplar_log: 'charcoal',
};

// --- Mining ------------------------------------------------------------------------

export function toolOf(stack) {
  return stack ? ITEMS[stack.id]?.tool ?? null : null;
}

export function canHarvest(block, tool) {
  if (block.level < 0) return true;
  return !!tool && tool.type === block.tool && tool.level >= block.level;
}

// Seconds to break a block with the given tool (Infinity for unbreakable blocks).
export function breakTime(block, tool) {
  if (block.hardness < 0) return Infinity;
  if (block.hardness === 0) return 0.05;
  let speed = 1;
  if (tool && tool.type === block.tool) speed = tool.speed;
  if (tool?.type === 'sword' && (block.leaves || block.name === 'cactus')) speed = 1.5;
  const factor = canHarvest(block, tool) ? 1.5 : 5;
  return (block.hardness * factor) / speed;
}

export function attackDamage(stack) {
  return toolOf(stack)?.damage ?? 1;
}

// Items a broken block drops. rng() in [0, 1).
export function blockDrops(block, tool, rng) {
  if (!canHarvest(block, tool)) return [];
  if (block.leaves) {
    const out = [];
    if (rng() < 0.06) out.push({ id: `${block.leaves}_sapling`, count: 1 });
    if (block.leaves === 'oak' && rng() < 0.02) out.push({ id: 'apple', count: 1 });
    return out;
  }
  if (block.id === B.gravel) return [{ id: rng() < 0.12 ? 'flint' : 'gravel', count: 1 }];
  if (block.id === B.dead_bush) return rng() < 0.6 ? [{ id: 'stick', count: 1 + Math.floor(rng() * 2) }] : [];
  if (block.id === B.tall_grass) return rng() < 0.3 ? [{ id: 'straw', count: 1 }] : [];
  if (!block.drop) return [];
  return [{ id: block.drop, count: block.dropCount }];
}
