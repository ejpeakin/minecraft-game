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
| W A S D | Move (double-tap W to sprint) |
| Space | Jump, swim up; creative: double-tap to fly |
| Shift | Sprint (creative: fly faster) |
| C | Sneak (won't walk off edges), fly down, stand up from a cushion |
| Left mouse | Mine, attack |
| Right mouse | Place, use, eat (hold), sit on cushions, sleep in straw beds |
| Middle mouse | Pick block (creative) |
| 1–9 / wheel | Hotbar |
| E | Inventory |
| Q / Shift+Q | Drop one / drop stack |
| M | Map |
| T | Chat (multiplayer) |
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
- **Fancy graphics** (Options, on by default): leaves, grass and flowers sway in the
  wind; water reflects the sky at low angles, ripples and catches sun glints; a glowing
  sun with sunsets that spread across the sky; two-layer clouds; flickering torch and
  campfire light; slightly richer color and a soft vignette.
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
  temperate ones, covering about a quarter of the land. New worlds start in one. Tall, slender **poplar trees** in red, orange and yellow drop leaves
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
- **Cushions** in 16 colors: right-click to sit, C to get up.
- **Campfires** give light and smoke, and cook raw meat you put on them.
- **16-color wool and concrete**, each with slabs and stairs. Dyes come from flowers,
  red shrubs, shelf mushrooms, smelted cactus and coal; eight white wool or concrete
  around a dye colors them.
- **Map screen** (M or use a map): the land you've explored, drawn from the real blocks
  once loaded, with zoom, coordinates, your position and heading, spawn, camps you've
  found and explorer-map targets.

Stairs are bottom-half only (no upside-down placement), and colors without a natural dye
source in this game are available in creative mode.

## Multiplayer

Like Minecraft's "Open to LAN": one player hosts one of their worlds and friends join
it with a four-letter code. Everyone sees each other, block edits show up for
everyone, there's chat (T) and you can hit each other. The world stays saved on the
host's computer, including what friends build. Up to 8 players per game.

Multiplayer needs the Blockcraft server (`server.js`), which GitHub Pages can't run.
Put it on [Render](https://render.com) for free:

1. Sign in to Render with GitHub.
2. Click **New → Blueprint** and pick this repository. Render reads `render.yaml`.
3. Click **Apply**. After a few minutes you get a link like
   `https://blockcraft-xxxx.onrender.com`.
4. Everyone opens that link. One player goes to **Multiplayer → Host** on one of their
   worlds and shares the code; the others enter it and click **Join Game**.

You can also play from GitHub Pages by pasting the Render address into the
Multiplayer screen's **Server address** box. Render's free plan puts the server to
sleep after 15 minutes without players; the first connection then takes up to a
minute. To run it on your own computer: `npm install`, then `npm start`.

### Multiplayer at school

If your school network blocks Render, use Google Apps Script instead: a free script
that runs on Google's own servers, which school Chromebooks can usually reach. Only the
host needs to set it up, once:

1. Go to [script.google.com](https://script.google.com) and click **New project**.
2. Delete what's in the editor, then paste in everything from
   [`relay/Code.gs`](relay/Code.gs). Click **Save**.
3. Click **Deploy → New deployment**. Next to "Select type", click the gear and pick
   **Web app**.
4. Set **Execute as** to **Me** and **Who has access** to **Anyone**, then click
   **Deploy**. Google asks you to allow access the first time (click **Advanced →
   Go to project** if it warns that the app isn't verified; it's your own script).
5. Copy the **Web app URL**. It ends in `/exec`.
6. In Blockcraft, open **Multiplayer** and paste that link into **Server address**.
   Give the same link to your friends: everyone pastes it in, then one player hosts
   and the others join with the code, as above.

If **Anyone** isn't in the list (some school Google accounts only allow people in
your school), pick **Anyone within** your school instead. Then everyone has to be
signed in to a school account in the browser. If it still won't connect, make the
script with a personal Google account at home; the link works the same at school.

Through Apps Script, other players' movement updates about 2 or 3 times a second
instead of 10, so they move a little jerkily. Block edits, chat and hits arrive within
about half a second. It's meant for a handful of friends, not a big server.

What's shared: player movement, every block placed or broken (including explosions),
chat, hits and the time of day (the host's clock; only the host can sleep through the
night). Each player has their own inventory, mobs and item drops, and chests and
furnaces aren't shared yet.

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
server.js                 Serves the game and runs multiplayer rooms (WebSocket /ws)
render.yaml               Render blueprint for hosting the server
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
  net.js                  Multiplayer client: rooms, other players, shared edits, chat
  input.js, audio.js      Keyboard/mouse with pointer lock; procedural sound
```

After changing anything in `src/` or `style.css`, run `npm run stamp` before committing.
It gives each file a versioned URL so browsers (and GitHub Pages' cache) always load a
matching set of files, and updates the version shown on the title screen.

`window.game` is available in the console, for example
`game.player.inventory.add({ id: 'diamond', count: 64 })` or `game.world.time = 13000`
(night). Blocks are appended to `DEFS` in `blocks.js` in order because their numeric ids
are part of the save format.
