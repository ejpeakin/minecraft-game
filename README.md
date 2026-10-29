# Blockcraft

A Minecraft-style voxel sandbox that runs in the browser, including the content of the
**Wilderness Bound** game drop (Minecraft 26.3): Dappled Forests, poplar trees, shelf
mushrooms, abandoned camps, explorer maps, straw beds, cushions, and 16-color wool and
concrete with slabs and stairs.

Plain JavaScript modules and [three.js](https://threejs.org) (r160, bundled in
`src/lib` so no CDN is needed). No build step and no asset files: every texture, icon,
model and sound is generated in code.
It is a fan project and isn't affiliated with Mojang or Microsoft.

## Running it

ES modules must be served over HTTP, so opening `index.html` from disk will not work:

```bash
npm start        # then open http://localhost:8080
# or: PORT=3000 npm start
# or any static server, e.g. python3 -m http.server 8080
```

The pixel fonts come
from Google Fonts (it falls back to a monospace font offline). You need a keyboard and
mouse, and a browser with WebGL 2.

## Controls

| Key | Action |
| --- | --- |
| W A S D | Move (double-tap W, or hold R or Ctrl, to sprint) |
| Space | Jump, swim up; creative: double-tap to fly |
| Shift | Sneak (won't walk off edges), fly down, stand up from a cushion |
| Left mouse | Mine, attack |
| Right mouse | Place, use, eat (hold), sit on cushions, sleep in straw beds |
| Middle mouse | Pick block (creative) |
| 1–9 / wheel | Hotbar |
| E | Inventory |
| Q / Shift+Q | Drop one / drop stack |
| M | Map |
| F3 | Debug info |
| F1 | Hide HUD |
| Esc | Pause, close screens |

Inventory screens work like Minecraft's: click to pick up or drop a stack, right-click
to split or place one, Shift-click to move between sections or craft everything you
can, and click outside the window to throw the held stack.

## What's in it

- **World**: infinite seeded terrain in 16×128×16 chunks streamed around you; oceans,
  beaches, plains, forests, deserts, taiga, snowy plains, frozen oceans and mountains;
  spaghetti and cheese caves with lava below y 10; coal, iron, gold and diamond ores;
  oak, birch and spruce trees, cacti, flowers and grass.
- **Rendering**: per-chunk meshes with face culling, smooth lighting and ambient
  occlusion; flood-filled sky and block light (torches, glowstone, lava, campfires and
  lit furnaces glow); a day/night cycle with a sky gradient, sunsets, sun, moon, stars
  and drifting clouds; animated water and lava; distance and underwater fog.
- **Blocks with rules**: water and lava flow and level out, water sources refill between
  two sources, lava and water make obsidian or cobblestone, sand and gravel fall, plants
  and torches need support, saplings grow into trees.
- **Survival**: health, hunger with saturation, air underwater, fall damage, lava,
  cactus, drowning and starvation; tools with tiers, speeds and durability; 100+ crafting
  recipes on a 2×2 or 3×3 grid; furnace smelting with fuel; chests; TNT.
- **Mobs**: pigs and sheep by day; zombies (burn in sunlight) and creepers (they swell,
  hiss and explode) wherever it's dark.
- **Creative**: flying, instant breaking and a searchable palette of every item.
- **Saving**: worlds are stored in `localStorage` as edits on top of the seed. Several
  worlds can be kept; the game autosaves every 30 seconds, on pause and when you leave.

### Wilderness Bound

- **Dappled Forest**: an autumn biome that generates between the cold biomes and the
  temperate ones. Tall, slender **poplar trees** in red, orange and yellow drop leaves
  that drift down around you, and fallen poplar logs lie on the ground.
- **Poplar wood set**: logs (they can be placed sideways), planks, slabs, stairs, fences
  and saplings that grow into any of the three colors.
- **Shelf mushrooms** grow on living and fallen poplar trunks in a small and a large size
  (large ones drop two). Small ones you place on a log side grow large over time. Use
  them with a bowl for mushroom stew, or as brown dye.
- **Red shrubs** dot the forest floor (and make red dye).
- **Abandoned camps**: a poplar ringed by fences, two A-frame tents with straw beds, a
  campfire circled by cushions, barrels of supplies and a chest that always holds an
  **explorer map** pointing to the next camp. Camps are most common in Dappled Forests.
- **Straw beds** let you sleep through the night once and set your respawn point, then
  crumble. Craft them from straw (from tall grass) and planks.
- **Cushions** in 16 colors: right-click to sit, Shift to get up.
- **Campfires** give light and smoke, and cook raw meat you put on them.
- **16-color wool and concrete**, each with slabs and stairs. Dyes come from flowers,
  red shrubs, shelf mushrooms, smelted cactus and coal; eight white wool or concrete
  around a dye colors them.
- **Map screen** (M or use a map): the land you've explored, drawn from the real blocks
  once loaded, with zoom, coordinates, your position and heading, spawn, camps you've
  found and explorer-map targets.

Stairs are bottom-half only (no upside-down placement), and colors without a natural dye
source in this game are available in creative mode.

## If the screen is black

The hearts and hotbar show but the world doesn't: the 3D view isn't reaching your
screen. Try these in order.

1. **Make sure you have the newest version.** The title screen shows a version under
   the buttons. If it doesn't match the latest one, open the game in a new Incognito
   window (Ctrl+Shift+N) so the browser can't use an old saved copy.
2. **Let the self-test run.** When a world loads, the game draws a test picture first.
   If it doesn't come out right, a red message explains why and the game reloads in
   Safe graphics.
3. **Turn on Safe graphics yourself:** Esc → Options → Safe graphics, or add `#safe` to
   the end of the address. It draws with the older WebGL 1 and a simpler texture
   setup that school Chromebooks and older laptops handle better.
4. **Check the pause menu.** Esc shows the version, graphics mode, graphics chip, view
   size, light level and self-test result. "light sky 0" means you're underground
   or it's night, so it's just dark: raise Options → Brightness or place a torch.
5. **Check the browser.** In Chrome, Settings → System → "Use graphics acceleration
   when available" should be on. On a managed school device an administrator may have
   turned it off; then try another device.

If it's still black, a screenshot of the pause menu says what's going wrong.

## Code layout

```
index.html, style.css     Page shell, HUD and menus
server.js                 Zero-dependency static dev server
src/
  main.js                 Entry point (exposes window.game)
  game.js                 Loop, chunk streaming, saving, sleeping, glue
  blocks.js               Block registry, shapes and per-block lookup tables
  items.js                Items, tools, food, recipes, smelting, mining rules
  textures.js             Procedural pixel art, texture array, item and block icons
  worldgen.js             Terrain, biomes, caves, ores, trees, abandoned camps, loot
  world.js                Chunks, edits, fluids, gravity, growth, furnaces and chests
  mesher.js               Lighting flood fill and chunk geometry
  renderer.js             Chunk shader and meshes, selection, cracks, particles
  sky.js                  Day/night sky, sun, moon, stars, clouds
  physics.js              Swept AABB collision, step-up, raycasting
  player.js               Movement, vitals, mining, placing, using
  entities.js             Items, falling blocks, TNT, mobs, spawning, explosions
  viewmodel.js            First-person hand and held item
  inventory.js            Stacks and Minecraft click rules
  ui.js                   HUD, container screens, map, menus
  input.js, audio.js      Keyboard/mouse with pointer lock; procedural sound
```

After changing anything in `src/` or `style.css`, run `npm run stamp` before committing.
It gives each file a versioned URL so browsers (and GitHub Pages' cache) always load a
matching set of files, and updates the version shown on the title screen.

`window.game` is available in the console, for example
`game.player.inventory.add({ id: 'diamond', count: 64 })` or `game.world.time = 13000`
(night). Blocks are appended to `DEFS` in `blocks.js` in order because their numeric ids
are part of the save format.
