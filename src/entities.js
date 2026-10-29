// Everything that moves and isn't the player: dropped items, falling sand, primed
// TNT, and mobs (pigs, sheep, cows, chickens, zombies, creepers) with boxy textured
// models, simple AI and spawning rules based on light level. Also explosions.
import * as THREE from './three.js';
import { BLOCKS, B, SOLID, FLUID } from './blocks.js';
import { ITEMS, blockDrops } from './items.js';
import { moveEntity, fluidIn, touchesBlock } from './physics.js';
import { HEIGHT } from './worldgen.js';
import { mulberry32 } from './noise.js';
import { DYE_COLORS } from './textures.js';

const lightCurve = (l) => Math.pow(0.8, 15 - l);
let brightnessSetting = 0.5;
export function setEntityBrightness(b) {
  brightnessSetting = b;
}

function brightness(world, sky, x, y, z) {
  const { sky: s, block: b } = world.getLight(Math.floor(x), Math.floor(y), Math.floor(z));
  const v = Math.max(lightCurve(s) * sky.daylight, lightCurve(b), 0.05);
  return v + (Math.sqrt(v) - v) * brightnessSetting * 0.6;
}

// --- Base entity -------------------------------------------------------------------

class Entity {
  constructor(game, x, y, z, w, h) {
    this.game = game;
    this.x = x; this.y = y; this.z = z;
    this.vx = 0; this.vy = 0; this.vz = 0;
    this.w = w; this.h = h;
    this.onGround = false;
    this.stepHeight = 0;
    this.dead = false;
    this.age = 0;
    this.inWater = false;
    this.inLava = false;
  }
  physics(dt, gravity = 28, drag = 0.0) {
    const world = this.game.world;
    const hw = this.w / 2;
    const fluid = fluidIn(world, this.x - hw + 0.01, this.y + 0.1, this.z - hw + 0.01, this.x + hw - 0.01, this.y + this.h * 0.6, this.z + hw - 0.01);
    this.inWater = fluid === 1;
    this.inLava = fluid === 2;
    if (this.inWater || this.inLava) {
      this.vy -= gravity * 0.15 * dt;
      this.vy *= 0.9;
      this.vx *= 0.88;
      this.vz *= 0.88;
    } else {
      this.vy -= gravity * dt;
    }
    if (drag) {
      const f = Math.pow(drag, dt * 20);
      this.vx *= f;
      this.vz *= f;
    }
    this.vy = Math.max(this.vy, -60);
    const steps = Math.ceil(Math.max(Math.abs(this.vx), Math.abs(this.vy), Math.abs(this.vz)) * dt / 0.45) || 1;
    for (let i = 0; i < steps; i++) moveEntity(world, this, dt / steps);
    if (this.y < -40) this.dead = true;
  }
  distTo(p) {
    return Math.hypot(this.x - p.x, this.y - p.y, this.z - p.z);
  }
  dispose() {
    if (this.mesh) {
      this.game.scene.remove(this.mesh);
      this.mesh.traverse((o) => {
        if (o.material && o.userData.ownMaterial) o.material.dispose();
      });
    }
  }
}

// --- Items ---------------------------------------------------------------------------

export class ItemEntity extends Entity {
  constructor(game, x, y, z, stack, vel = null) {
    super(game, x, y, z, 0.25, 0.25);
    this.stack = stack;
    this.pickupDelay = 0.6;
    this.phase = Math.random() * Math.PI * 2;
    if (vel) { this.vx = vel[0]; this.vy = vel[1]; this.vz = vel[2]; }
    else { this.vx = (Math.random() - 0.5) * 3; this.vy = 3 + Math.random() * 2; this.vz = (Math.random() - 0.5) * 3; }
    this.mesh = game.entities.itemMesh(stack.id);
    game.scene.add(this.mesh);
  }
  update(dt) {
    this.age += dt;
    this.pickupDelay -= dt;
    if (this.age > 300) { this.dead = true; return; }
    this.physics(dt, 22, this.onGround ? 0.5 : 0.98);
    if (this.inLava) { this.dead = true; return; }
    const p = this.game.player;
    if (this.pickupDelay <= 0 && !p.dead) {
      const d = Math.hypot(this.x - p.x, this.y + 0.1 - (p.y + 0.8), this.z - p.z);
      if (d < 1.6) {
        const left = p.inventory.add(this.stack);
        const took = !left || left.count < this.stack.count;
        if (took) {
          this.game.audio.pop();
          this.game.ui.flashHotbar();
          if (left) this.stack = left;
          else this.dead = true;
        }
      }
    }
    const bob = Math.sin(this.age * 3 + this.phase) * 0.08 + 0.15;
    this.mesh.position.set(this.x, this.y + bob, this.z);
    this.mesh.rotation.y = this.age * 1.6 + this.phase;
    this.game.entities.applyLight(this.mesh, this.x, this.y + 0.2, this.z);
  }
}

export class FallingBlock extends Entity {
  constructor(game, x, y, z, id) {
    super(game, x + 0.5, y, z + 0.5, 0.98, 0.98);
    this.id = id;
    this.mesh = new THREE.Mesh(game.chunkRenderer.blockGeometry(id), game.chunkRenderer.entityMaterial());
    this.mesh.userData.ownMaterial = true;
    this.mesh.scale.setScalar(0.98);
    game.scene.add(this.mesh);
  }
  update(dt) {
    this.age += dt;
    this.physics(dt, 30);
    this.mesh.position.set(this.x, this.y, this.z);
    this.game.entities.applyLight(this.mesh, this.x, this.y + 0.5, this.z);
    if (this.onGround || this.age > 30) {
      const world = this.game.world;
      const bx = Math.floor(this.x), by = Math.round(this.y), bz = Math.floor(this.z);
      const cur = world.getBlock(bx, by, bz);
      if (cur === 0 || BLOCKS[cur].replaceable || BLOCKS[cur].washable) world.setBlock(bx, by, bz, this.id);
      else this.game.entities.dropItem(bx + 0.5, by + 0.5, bz + 0.5, { id: BLOCKS[this.id].item, count: 1 });
      this.dead = true;
    }
  }
}

export class PrimedTNT extends Entity {
  constructor(game, x, y, z, fuse = 4) {
    super(game, x + 0.5, y, z + 0.5, 0.98, 0.98);
    this.fuse = fuse;
    this.vy = 2;
    this.vx = (Math.random() - 0.5) * 0.8;
    this.vz = (Math.random() - 0.5) * 0.8;
    this.mesh = new THREE.Mesh(game.chunkRenderer.blockGeometry(B.tnt), game.chunkRenderer.entityMaterial());
    this.mesh.userData.ownMaterial = true;
    game.scene.add(this.mesh);
    game.audio.fuse(this, game.player);
  }
  update(dt) {
    this.fuse -= dt;
    this.physics(dt, 24, this.onGround ? 0.6 : 1);
    const pulse = 1 + Math.max(0, 0.2 - this.fuse * 0.05);
    this.mesh.position.set(this.x, this.y, this.z);
    this.mesh.scale.setScalar(pulse);
    this.mesh.material.uniforms.uFlash.value = Math.floor(this.fuse * 4) % 2 ? 0.55 : 0;
    this.game.entities.applyLight(this.mesh, this.x, this.y + 0.5, this.z);
    if (this.fuse <= 0) {
      this.dead = true;
      this.game.entities.explode(this.x, this.y + 0.5, this.z, 4);
    }
  }
}

// --- Mob models ---------------------------------------------------------------------

const P = 1 / 16;

function noisyFill(ctx, x, y, w, h, base, amt, rnd) {
  for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
    const f = 1 + (rnd() - 0.5) * 2 * amt;
    ctx.fillStyle = `rgb(${Math.min(255, base[0] * f) | 0},${Math.min(255, base[1] * f) | 0},${Math.min(255, base[2] * f) | 0})`;
    ctx.fillRect(x + i, y + j, 1, 1);
  }
}

// Part spec: size in pixels [w, h, d]; at = pivot position in pixels; off = box center
// offset from pivot; color per face or a painter(ctx, face, x, y, w, h, rnd).
function buildModel(spec, seed) {
  const rnd = mulberry32(seed);
  const canvas = document.createElement('canvas');
  canvas.width = 128;
  canvas.height = 128;
  const ctx = canvas.getContext('2d');
  let cx = 0, cy = 0, rowH = 0;
  const regions = [];
  for (const part of spec.parts) {
    const [w, h, d] = part.size;
    const faceSizes = [[d, h], [d, h], [w, d], [w, d], [w, h], [w, h]];
    const rects = [];
    for (let f = 0; f < 6; f++) {
      const [fw, fh] = faceSizes[f];
      if (cx + fw > 128) { cx = 0; cy += rowH; rowH = 0; }
      rects.push([cx, cy, fw, fh]);
      const paint = part.paint ?? ((c, face, x, y, pw, ph, r) => noisyFill(c, x, y, pw, ph, part.color, 0.08, r));
      paint(ctx, f, cx, cy, fw, fh, rnd);
      cx += fw;
      rowH = Math.max(rowH, fh);
    }
    regions.push(rects);
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.magFilter = THREE.NearestFilter;
  tex.minFilter = THREE.NearestFilter;
  tex.colorSpace = THREE.SRGBColorSpace;
  const geos = spec.parts.map((part, pi) => {
    const [w, h, d] = part.size;
    const g = new THREE.BoxGeometry(w * P, h * P, d * P);
    const uv = g.attributes.uv;
    const colors = [];
    const shades = [0.8, 0.8, 1, 0.55, 0.7, 0.7];
    for (let f = 0; f < 6; f++) {
      const [rx, ry, rw, rh] = regions[pi][f];
      const u0 = rx / 128, u1 = (rx + rw) / 128;
      const vTop = 1 - ry / 128, vBot = 1 - (ry + rh) / 128;
      const order = [[0, 1], [1, 1], [0, 0], [1, 0]];
      for (let k = 0; k < 4; k++) {
        const [a, b] = order[k];
        uv.setXY(f * 4 + k, u0 + a * (u1 - u0), vBot + b * (vTop - vBot));
        colors.push(shades[f], shades[f], shades[f]);
      }
    }
    g.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    const off = part.off ?? [0, 0, 0];
    g.translate(off[0] * P, off[1] * P, off[2] * P);
    return g;
  });
  return { tex, geos };
}

// Painter for a part: noisy skin color, plus an optional face drawn on the front.
function skinPaint(base, frontDraw = null, amt = 0.08) {
  return (ctx, f, x, y, w, h, r) => {
    noisyFill(ctx, x, y, w, h, base, amt, r);
    if (f === 4 && frontDraw) frontDraw(ctx, x, y, w, h, r);
  };
}

const px = (ctx, x, y, c, w = 1, h = 1) => {
  ctx.fillStyle = c;
  ctx.fillRect(x, y, w, h);
};

// Painters for the animals. f is the face: 0 +x, 1 -x, 2 top, 3 bottom, 4 front, 5 back.
const solid = (base, amt = 0.08) => (ctx, f, x, y, w, h, r) => noisyFill(ctx, x, y, w, h, base, amt, r);
// Blotches of a second color (cow hide, wool curls).
function blotched(base, spot, count, amt = 0.08) {
  return (ctx, f, x, y, w, h, r) => {
    noisyFill(ctx, x, y, w, h, base, amt, r);
    const n = Math.round((count * w * h) / 64);
    for (let i = 0; i < n; i++) {
      let bx = Math.floor(r() * w), by = Math.floor(r() * h);
      const len = 2 + Math.floor(r() * 5);
      for (let k = 0; k < len; k++) {
        noisyFill(ctx, x + bx, y + by, 1, 1, spot, amt, r);
        if (r() < 0.5) bx = Math.min(w - 1, Math.max(0, bx + (r() < 0.5 ? 1 : -1)));
        else by = Math.min(h - 1, Math.max(0, by + (r() < 0.5 ? 1 : -1)));
      }
    }
  };
}
const withFront = (paint, front) => (ctx, f, x, y, w, h, r) => {
  paint(ctx, f, x, y, w, h, r);
  if (f === 4) front(ctx, x, y, w, h, r);
};
const eyes = (ctx, x, y, row, left, right, white = true) => {
  if (white) { px(ctx, x + left - 1, y + row, '#f4f4f4'); px(ctx, x + right + 1, y + row, '#f4f4f4'); }
  px(ctx, x + left, y + row, '#141414'); px(ctx, x + right, y + row, '#141414');
};

const PINK = [236, 156, 160];
const SHEEP_SKIN = [222, 204, 188];
const COW_BROWN = [92, 62, 42];
const COW_WHITE = [232, 228, 220];
const HEN_WHITE = [244, 244, 238];
const HEN_LEG = [232, 168, 48];

const MOBS = {
  pig: {
    w: 0.9, h: 0.9, health: 10, speed: 1.6, hostile: false, food: 'wheat',
    drops: (r) => [{ id: 'porkchop', count: 1 + Math.floor(r() * 3) }],
    parts: [
      { name: 'body', size: [10, 8, 16], at: [0, 10, 0], paint: blotched(PINK, [222, 140, 146], 3, 0.06) },
      { id: 'head', name: 'head', size: [8, 8, 8], at: [0, 12, 7], off: [0, 0, 4], paint: withFront(solid(PINK, 0.06), (c, x, y) => {
        px(c, x, y + 2, '#d88c92', 8, 1);
        eyes(c, x, y, 3, 2, 5);
      }) },
      { name: 'snout', parent: 'head', size: [4, 3, 1], at: [0, 12, 7], off: [0, -1.5, 8.5], paint: withFront(solid([226, 134, 144], 0.05), (c, x, y) => {
        px(c, x, y, '#f0a6ae', 4, 1); px(c, x + 1, y + 1, '#8c3c46'); px(c, x + 2, y + 1, '#8c3c46');
      }) },
      { name: 'leg', size: [4, 6, 4], at: [-3, 6, 5], off: [0, -3, 0], paint: solid([222, 142, 148]), leg: 0 },
      { name: 'leg', size: [4, 6, 4], at: [3, 6, 5], off: [0, -3, 0], paint: solid([222, 142, 148]), leg: 1 },
      { name: 'leg', size: [4, 6, 4], at: [-3, 6, -5], off: [0, -3, 0], paint: solid([222, 142, 148]), leg: 1 },
      { name: 'leg', size: [4, 6, 4], at: [3, 6, -5], off: [0, -3, 0], paint: solid([222, 142, 148]), leg: 0 },
    ],
  },
  sheep: {
    w: 0.9, h: 1.3, health: 8, speed: 1.5, hostile: false, food: 'wheat', wool: true,
    drops: (r, mob) => [...(mob?.sheared ? [] : [{ id: `${mob?.color ?? 'white'}_wool`, count: 1 }]), { id: 'mutton', count: 1 + Math.floor(r() * 2) }],
    parts: [
      { id: 'leg0', name: 'leg', size: [4, 12, 4], at: [-3, 12, 5], off: [0, -6, 0], paint: solid(SHEEP_SKIN), leg: 0 },
      { id: 'leg1', name: 'leg', size: [4, 12, 4], at: [3, 12, 5], off: [0, -6, 0], paint: solid(SHEEP_SKIN), leg: 1 },
      { id: 'leg2', name: 'leg', size: [4, 12, 4], at: [-3, 12, -6], off: [0, -6, 0], paint: solid(SHEEP_SKIN), leg: 1 },
      { id: 'leg3', name: 'leg', size: [4, 12, 4], at: [3, 12, -6], off: [0, -6, 0], paint: solid(SHEEP_SKIN), leg: 0 },
      { name: 'body', size: [8, 6, 16], at: [0, 15, 0], paint: solid(SHEEP_SKIN) },
      { id: 'head', name: 'head', size: [6, 6, 8], at: [0, 18, 7], off: [0, 1, 4], paint: withFront(solid(SHEEP_SKIN, 0.05), (c, x, y) => {
        eyes(c, x, y, 2, 1, 4);
        px(c, x + 2, y + 4, '#b28c82', 2, 1); px(c, x + 2, y + 5, '#8c6a62', 2, 1);
      }) },
      // The fleece: shown until the sheep is sheared, tinted to the sheep's color.
      { name: 'wool', wool: true, size: [11, 9, 19], at: [0, 15, 0], off: [0, 0.5, 0], paint: blotched([238, 238, 232], [214, 214, 208], 9, 0.04) },
      { name: 'wool', wool: true, parent: 'head', size: [7, 6, 6], at: [0, 18, 7], off: [0, 2.5, 2.5], paint: blotched([238, 238, 232], [214, 214, 208], 9, 0.04) },
      ...[0, 1, 2, 3].map((i) => ({ name: 'wool', wool: true, parent: `leg${i}`, size: [5, 5, 5], at: [[-3, 12, 5], [3, 12, 5], [-3, 12, -6], [3, 12, -6]][i], off: [0, -2.5, 0], paint: blotched([238, 238, 232], [214, 214, 208], 9, 0.04) })),
    ],
  },
  cow: {
    w: 0.9, h: 1.4, health: 10, speed: 1.4, hostile: false, food: 'wheat',
    drops: (r) => [{ id: 'leather', count: Math.floor(r() * 3) }, { id: 'beef', count: 1 + Math.floor(r() * 3) }].filter((s) => s.count > 0),
    parts: [
      { name: 'leg', size: [4, 12, 4], at: [-4, 12, 6], off: [0, -6, 0], paint: blotched(COW_BROWN, COW_WHITE, 2), leg: 0 },
      { name: 'leg', size: [4, 12, 4], at: [4, 12, 6], off: [0, -6, 0], paint: blotched(COW_BROWN, COW_WHITE, 2), leg: 1 },
      { name: 'leg', size: [4, 12, 4], at: [-4, 12, -7], off: [0, -6, 0], paint: blotched(COW_BROWN, COW_WHITE, 2), leg: 1 },
      { name: 'leg', size: [4, 12, 4], at: [4, 12, -7], off: [0, -6, 0], paint: blotched(COW_BROWN, COW_WHITE, 2), leg: 0 },
      { name: 'body', size: [12, 10, 18], at: [0, 17, 0], paint: blotched(COW_BROWN, COW_WHITE, 7) },
      { name: 'udder', size: [4, 2, 5], at: [0, 11.5, -4], paint: solid([232, 168, 170]) },
      { id: 'head', name: 'head', size: [8, 8, 6], at: [0, 20, 8], off: [0, 0, 3], paint: withFront(solid(COW_BROWN, 0.07), (c, x, y) => {
        px(c, x + 2, y, '#e8e4dc', 4, 5);
        eyes(c, x, y, 3, 1, 6, false);
        px(c, x, y + 5, '#d8b8a4', 8, 3); px(c, x + 2, y + 6, '#6a4c40'); px(c, x + 5, y + 6, '#6a4c40');
      }) },
      { name: 'horn', parent: 'head', size: [1, 3, 1], at: [0, 20, 8], off: [-4.5, 4.5, 2], paint: withFront(solid([226, 222, 206], 0.04), (c, x, y) => px(c, x, y, '#8a8678')) },
      { name: 'horn', parent: 'head', size: [1, 3, 1], at: [0, 20, 8], off: [4.5, 4.5, 2], paint: withFront(solid([226, 222, 206], 0.04), (c, x, y) => px(c, x, y, '#8a8678')) },
    ],
  },
  chicken: {
    w: 0.4, h: 0.7, health: 4, speed: 1.3, hostile: false, food: 'wheat_seeds',
    drops: (r) => [{ id: 'feather', count: Math.floor(r() * 3) }, { id: 'chicken', count: 1 }].filter((s) => s.count > 0),
    parts: [
      { id: 'legL', name: 'leg', size: [1, 5, 1], at: [-1.5, 5, 0.5], off: [0, -2.5, 0], paint: solid(HEN_LEG, 0.05), leg: 0 },
      { id: 'legR', name: 'leg', size: [1, 5, 1], at: [1.5, 5, 0.5], off: [0, -2.5, 0], paint: solid(HEN_LEG, 0.05), leg: 1 },
      { name: 'foot', parent: 'legL', size: [3, 1, 3], at: [-1.5, 5, 0.5], off: [0, -4.5, 0.5], paint: solid(HEN_LEG, 0.05) },
      { name: 'foot', parent: 'legR', size: [3, 1, 3], at: [1.5, 5, 0.5], off: [0, -4.5, 0.5], paint: solid(HEN_LEG, 0.05) },
      { name: 'body', size: [6, 6, 8], at: [0, 8, 0], paint: blotched(HEN_WHITE, [226, 226, 220], 4, 0.04) },
      { name: 'wing', size: [1, 4, 6], at: [-3.5, 11, 0], off: [0, -2, 0], paint: blotched(HEN_WHITE, [222, 222, 214], 4, 0.04), wing: 0 },
      { name: 'wing', size: [1, 4, 6], at: [3.5, 11, 0], off: [0, -2, 0], paint: blotched(HEN_WHITE, [222, 222, 214], 4, 0.04), wing: 1 },
      { id: 'head', name: 'head', size: [4, 6, 3], at: [0, 11, 3], off: [0, 1, 1.5], paint: withFront(solid(HEN_WHITE, 0.04), (c, x, y) => eyes(c, x, y, 1, 0, 3, false)) },
      { name: 'beak', parent: 'head', size: [4, 2, 2], at: [0, 11, 3], off: [0, 1, 4], paint: solid([246, 186, 44], 0.05) },
      { name: 'wattle', parent: 'head', size: [2, 2, 2], at: [0, 11, 3], off: [0, -1, 4], paint: solid([204, 32, 32], 0.05) },
    ],
  },
  // Other players in multiplayer (never spawned as a mob).
  player: {
    w: 0.6, h: 1.8, health: 20, speed: 4.3, hostile: false,
    drops: () => [],
    parts: [
      { name: 'head', size: [8, 8, 8], at: [0, 24, 0], off: [0, 4, 0], paint: skinPaint([196, 142, 106], (c, x, y) => {
        px(c, x, y, '#3b2412', 8, 2); px(c, x, y + 2, '#3b2412', 1, 1); px(c, x + 7, y + 2, '#3b2412', 1, 1);
        px(c, x + 1, y + 4, '#fff', 2, 1); px(c, x + 2, y + 4, '#4a3a8c'); px(c, x + 5, y + 4, '#fff', 2, 1); px(c, x + 5, y + 4, '#4a3a8c');
        px(c, x + 3, y + 6, '#7a4a30', 2, 1);
      }) },
      { name: 'body', size: [8, 12, 4], at: [0, 18, 0], color: [47, 168, 176] },
      { name: 'arm', size: [4, 12, 4], at: [-6, 22, 0], off: [0, -5, 0], color: [196, 142, 106], swing: 0 },
      { name: 'arm', size: [4, 12, 4], at: [6, 22, 0], off: [0, -5, 0], color: [196, 142, 106], swing: 1 },
      { name: 'leg', size: [4, 12, 4], at: [-2, 12, 0], off: [0, -6, 0], color: [58, 63, 156], leg: 0 },
      { name: 'leg', size: [4, 12, 4], at: [2, 12, 0], off: [0, -6, 0], color: [58, 63, 156], leg: 1 },
    ],
  },
  zombie: {
    w: 0.6, h: 1.95, health: 20, speed: 2.4, hostile: true, burns: true, damage: 3,
    drops: (r) => (r() < 0.8 ? [{ id: 'rotten_flesh', count: 1 + Math.floor(r() * 2) }] : []),
    parts: [
      { name: 'head', size: [8, 8, 8], at: [0, 24, 0], off: [0, 4, 0], paint: skinPaint([92, 140, 76], (c, x, y) => {
        px(c, x + 1, y + 3, '#1e2a1a', 2, 1); px(c, x + 5, y + 3, '#1e2a1a', 2, 1);
        px(c, x + 3, y + 5, '#3a5530', 2, 1); px(c, x + 2, y + 6, '#2a3f22', 4, 1);
      }) },
      { name: 'body', size: [8, 12, 4], at: [0, 18, 0], color: [40, 150, 160] },
      { name: 'arm', size: [4, 12, 4], at: [-6, 22, 0], off: [0, -5, 0], color: [92, 140, 76], arm: 0 },
      { name: 'arm', size: [4, 12, 4], at: [6, 22, 0], off: [0, -5, 0], color: [92, 140, 76], arm: 1 },
      { name: 'leg', size: [4, 12, 4], at: [-2, 12, 0], off: [0, -6, 0], color: [60, 60, 150], leg: 0 },
      { name: 'leg', size: [4, 12, 4], at: [2, 12, 0], off: [0, -6, 0], color: [60, 60, 150], leg: 1 },
    ],
  },
  creeper: {
    w: 0.6, h: 1.7, health: 20, speed: 2.2, hostile: true, explodes: true,
    drops: (r) => [{ id: 'gunpowder', count: 1 + Math.floor(r() * 2) }],
    parts: [
      { name: 'head', size: [8, 8, 8], at: [0, 18, 0], off: [0, 4, 0], paint: skinPaint([90, 180, 70], (c, x, y) => {
        px(c, x + 1, y + 2, '#111', 2, 2); px(c, x + 5, y + 2, '#111', 2, 2);
        px(c, x + 3, y + 4, '#111', 2, 2); px(c, x + 2, y + 5, '#111', 1, 2); px(c, x + 5, y + 5, '#111', 1, 2);
      }, 0.22) },
      { name: 'body', size: [8, 12, 4], at: [0, 12, 0], off: [0, 0, 0], paint: skinPaint([80, 170, 64], null, 0.22) },
      { name: 'leg', size: [4, 6, 4], at: [-2, 6, 4], off: [0, -3, 0], paint: skinPaint([70, 150, 56], null, 0.2), leg: 0 },
      { name: 'leg', size: [4, 6, 4], at: [2, 6, 4], off: [0, -3, 0], paint: skinPaint([70, 150, 56], null, 0.2), leg: 1 },
      { name: 'leg', size: [4, 6, 4], at: [-2, 6, -4], off: [0, -3, 0], paint: skinPaint([70, 150, 56], null, 0.2), leg: 1 },
      { name: 'leg', size: [4, 6, 4], at: [2, 6, -4], off: [0, -3, 0], paint: skinPaint([70, 150, 56], null, 0.2), leg: 0 },
    ],
  },
};

const modelCache = new Map();
function modelFor(kind) {
  if (!modelCache.has(kind)) modelCache.set(kind, buildModel(MOBS[kind], kind.length * 977));
  return modelCache.get(kind);
}

// A posable model for a mob kind: { mesh, parts: [{ spec, pivot }], material }.
// A part with a parent (a snout on a head, wool on a leg) hangs from the parent's pivot
// and moves with it. Wool uses its own material so it can be tinted.
export function buildFigure(kind) {
  const def = MOBS[kind];
  const { tex, geos } = modelFor(kind);
  const material = new THREE.MeshBasicMaterial({ map: tex, vertexColors: true });
  const woolMaterial = def.wool ? new THREE.MeshBasicMaterial({ map: tex, vertexColors: true }) : null;
  const mesh = new THREE.Group();
  const parts = [];
  const byId = new Map();
  def.parts.forEach((part, i) => {
    const m = new THREE.Mesh(geos[i], part.wool ? woolMaterial : material);
    m.userData.ownMaterial = true;
    const pivot = new THREE.Group();
    const parent = part.parent ? byId.get(part.parent) : null;
    const base = parent ? parent.spec.at : [0, 0, 0];
    pivot.position.set((part.at[0] - base[0]) * P, (part.at[1] - base[1]) * P, (part.at[2] - base[2]) * P);
    pivot.add(m);
    (parent ? parent.pivot : mesh).add(pivot);
    const entry = { spec: part, pivot };
    parts.push(entry);
    if (part.id) byId.set(part.id, entry);
  });
  return { mesh, parts, material, woolMaterial };
}

// Natural sheep colors and how often they turn up, as in Minecraft.
const SHEEP_COLORS = [['white', 0.818], ['black', 0.05], ['gray', 0.05], ['light_gray', 0.05], ['brown', 0.03], ['pink', 0.002]];
function randomSheepColor() {
  let r = Math.random();
  for (const [c, p] of SHEEP_COLORS) if ((r -= p) < 0) return c;
  return 'white';
}
// Wool tint: the dye color relative to white wool.
function woolTint(color) {
  const c = DYE_COLORS[color] ?? DYE_COLORS.white;
  const w = DYE_COLORS.white;
  const ch = (v, s) => Math.min(1.1, ((v >> s) & 255) / Math.max(1, (w >> s) & 255));
  return [ch(c, 16), ch(c, 8), ch(c, 0)];
}

export class Mob extends Entity {
  constructor(game, kind, x, y, z, opts = {}) {
    const def = MOBS[kind];
    const baby = !!opts.baby;
    super(game, x, y, z, def.w * (baby ? 0.5 : 1), def.h * (baby ? 0.5 : 1));
    this.kind = kind;
    this.def = def;
    this.health = opts.health ?? def.health;
    this.baby = baby;
    this.growTime = opts.growTime ?? (baby ? 240 : 0);
    this.color = kind === 'sheep' ? opts.color ?? randomSheepColor() : null;
    this.sheared = !!opts.sheared;
    this.loveTime = 0;
    this.breedCooldown = opts.breedCooldown ?? 0;
    this.eggTimer = 300 + Math.random() * 300;
    this.grazeTime = 0;
    this.headYaw = 0;
    this.headPitch = 0;
    this.lookTimer = 0;
    this.idleYaw = 0;
    this.stepHeight = 0.6;
    this.yaw = Math.random() * Math.PI * 2;
    this.targetYaw = this.yaw;
    this.wanderTime = 0;
    this.moving = false;
    this.walk = 0;
    this.hurtTime = 0;
    this.invuln = 0;
    this.attackCooldown = 0;
    this.fuse = 0;
    this.fleeTime = 0;
    this.deathTime = 0;
    this.burnTimer = 0;
    this.soundTimer = 4 + Math.random() * 10;
    this.drownTimer = 0;
    Object.assign(this, buildFigure(kind));
    if (opts.yaw !== undefined) this.yaw = this.targetYaw = opts.yaw;
    game.scene.add(this.mesh);
  }

  get hostile() {
    return this.def.hostile;
  }

  // What's kept when the world is saved or the mob's chunk unloads.
  serialize() {
    return {
      kind: this.kind, x: +this.x.toFixed(2), y: +this.y.toFixed(2), z: +this.z.toFixed(2), yaw: +this.yaw.toFixed(2), health: this.health,
      baby: this.baby, growTime: Math.round(this.growTime), color: this.color, sheared: this.sheared, breedCooldown: Math.round(this.breedCooldown),
    };
  }

  // Right click with an item: feed, milk, shear or dye. Returns true if something happened.
  interact(player, stack) {
    if (this.hostile || this.deathTime > 0) return false;
    const game = this.game;
    const id = stack?.id;
    const survival = player.mode === 'survival';
    const use = () => { if (survival) player.inventory.consumeHeld(1); };
    if (this.kind === 'cow' && id === 'bucket' && !this.baby) {
      player.exchangeHeld({ id: 'milk_bucket', count: 1 });
      game.audio.splash(this, player);
      return true;
    }
    if (this.kind === 'sheep' && id === 'shears' && !this.sheared && !this.baby) {
      this.sheared = true;
      const n = 1 + Math.floor(Math.random() * 3);
      for (let i = 0; i < n; i++) game.entities.dropItem(this.x, this.y + this.h * 0.8, this.z, { id: `${this.color}_wool`, count: 1 });
      if (survival && player.inventory.damageHeld(1)) game.audio.block('glass', 'break');
      game.audio.block('cloth', 'break', this, player);
      return true;
    }
    const dye = ITEMS[id]?.dye;
    if (this.kind === 'sheep' && dye && dye !== this.color) {
      this.color = dye;
      use();
      return true;
    }
    if (id && id === this.def.food) {
      if (this.baby) {
        this.growTime -= this.growTime * 0.1 + 10;
        use();
        this.hearts(2);
        return true;
      }
      if (this.loveTime <= 0 && this.breedCooldown <= 0) {
        this.loveTime = 30;
        use();
        this.hearts(5);
        game.audio.eat();
        return true;
      }
    }
    return false;
  }

  hearts(n) {
    this.game.particles.burst(this.x - 0.5, this.y + this.h * 0.7, this.z - 0.5, [1, 0.25, 0.35], n);
  }

  // Two animals in love make a baby between them.
  breed(other) {
    const game = this.game;
    this.loveTime = other.loveTime = 0;
    this.breedCooldown = other.breedCooldown = 300;
    const color = this.kind === 'sheep' ? (Math.random() < 0.5 ? this.color : other.color) : undefined;
    const baby = new Mob(game, this.kind, (this.x + other.x) / 2, Math.max(this.y, other.y), (this.z + other.z) / 2, { baby: true, color });
    game.entities.add(baby);
    baby.hearts(8);
  }

  growUp() {
    this.baby = false;
    this.w = this.def.w;
    this.h = this.def.h;
  }

  damage(amount, fromX, fromZ, knock = 1) {
    if (this.invuln > 0 || this.deathTime > 0) return false;
    this.health -= amount;
    this.hurtTime = 0.35;
    this.invuln = 0.45;
    const dx = this.x - fromX;
    const dz = this.z - fromZ;
    const d = Math.hypot(dx, dz) || 1;
    this.vx = (dx / d) * 6 * knock;
    this.vz = (dz / d) * 6 * knock;
    this.vy = 5 * Math.min(1, knock);
    this.fleeTime = this.hostile ? 0 : 5;
    this.game.audio.mob(this.kind, 'hurt', this, this.game.player);
    if (this.health <= 0) this.deathTime = 0.0001;
    return true;
  }

  update(dt) {
    const game = this.game;
    const player = game.player;
    this.age += dt;
    this.invuln -= dt;
    this.hurtTime -= dt;
    this.attackCooldown -= dt;
    if (this.deathTime > 0) {
      this.deathTime += dt;
      this.mesh.rotation.z = Math.min(Math.PI / 2, this.deathTime * 4);
      this.material.color.setRGB(1, 0.4, 0.4);
      if (this.deathTime > 0.7) {
        this.dead = true;
        const r = Math.random;
        if (!this.baby) for (const s of this.def.drops(r, this)) game.entities.dropItem(this.x, this.y + 0.5, this.z, s);
        game.particles.burst(this.x - 0.5, this.y, this.z - 0.5, [0.85, 0.85, 0.85], 18);
      }
      this.physics(dt);
      this.syncMesh(dt, 0);
      return;
    }

    let moveX = 0, moveZ = 0, speed = this.def.speed;
    const canTarget = this.hostile && !player.dead && player.mode === 'survival';
    const pd = this.distTo(player);
    if (canTarget && pd < 18) {
      const dx = player.x - this.x;
      const dz = player.z - this.z;
      this.targetYaw = Math.atan2(dx, dz);
      const close = Math.hypot(dx, dz);
      if (this.def.explodes) {
        if (pd < 3.2) {
          if (this.fuse === 0) game.audio.fuse(this, player);
          this.fuse += dt;
          speed *= 0.2;
        } else {
          this.fuse = Math.max(0, this.fuse - dt);
        }
        if (this.fuse >= 1.5) {
          this.dead = true;
          game.entities.explode(this.x, this.y + 0.8, this.z, 3);
          return;
        }
      }
      if (close > 0.9) { moveX = dx / close; moveZ = dz / close; }
      if (this.def.damage && pd < 1.6 && Math.abs(player.y - this.y) < 1.6 && this.attackCooldown <= 0) {
        this.attackCooldown = 1;
        player.damage(this.def.damage, { x: this.x, z: this.z, cause: 'zombie' });
      }
    } else {
      if (this.def.explodes) this.fuse = Math.max(0, this.fuse - dt);
      this.wanderTime -= dt;
      this.breedCooldown = Math.max(0, this.breedCooldown - dt);
      if (this.baby) {
        this.growTime -= dt;
        if (this.growTime <= 0) this.growUp();
      }
      // An animal in love looks for a partner of its kind; one holding no grudge follows
      // a player holding its food.
      let goal = null;
      if (this.loveTime > 0) {
        this.loveTime -= dt;
        if (Math.floor(this.loveTime * 2) !== Math.floor((this.loveTime + dt) * 2)) this.hearts(1);
        let best = 8;
        for (const m of game.entities.mobs) {
          if (m === this || m.kind !== this.kind || m.baby || m.loveTime <= 0) continue;
          const d = this.distTo(m);
          if (d < best) { best = d; goal = m; }
        }
        if (goal && best < 1.4) {
          this.breed(goal);
          goal = null;
        }
      }
      if (!goal && !this.hostile && this.fleeTime <= 0 && player.held?.id === this.def.food && pd < 8 && !player.dead) goal = player;
      if (this.kind === 'sheep') this.graze(dt);
      if (this.kind === 'chicken' && !this.baby) {
        this.eggTimer -= dt;
        if (this.eggTimer <= 0) {
          this.eggTimer = 300 + Math.random() * 300;
          game.entities.dropItem(this.x, this.y + 0.3, this.z, { id: 'egg', count: 1 });
          game.audio.pop();
        }
      }
      if (this.grazeTime > 0) {
        this.moving = false;
      } else if (goal && this.fleeTime <= 0) {
        const dx = goal.x - this.x, dz = goal.z - this.z;
        const d = Math.hypot(dx, dz);
        this.targetYaw = Math.atan2(dx, dz);
        if (d > (goal === player ? 2.2 : 0.8)) { moveX = dx / d; moveZ = dz / d; }
        this.wanderTime = 1;
      } else if (this.fleeTime > 0) {
        this.fleeTime -= dt;
        speed *= 1.8;
        if (this.wanderTime <= 0) {
          this.targetYaw = Math.atan2(this.x - player.x, this.z - player.z) + (Math.random() - 0.5);
          this.wanderTime = 0.8;
        }
        this.moving = true;
      } else if (this.wanderTime <= 0) {
        this.moving = Math.random() < 0.55;
        this.targetYaw = this.yaw + (Math.random() - 0.5) * 3;
        this.wanderTime = 2 + Math.random() * 4;
      }
      if (this.moving && !goal && this.grazeTime <= 0) {
        moveX = Math.sin(this.targetYaw);
        moveZ = Math.cos(this.targetYaw);
        if (!this.hostile) speed *= 0.6;
      }
    }
    this.lookAround(dt, player, pd);
    // Chickens flap and float down instead of falling.
    if (this.kind === 'chicken' && !this.onGround && this.vy < -2.4) this.vy = -2.4;

    // Turn smoothly toward the target heading.
    let dyaw = this.targetYaw - this.yaw;
    dyaw = Math.atan2(Math.sin(dyaw), Math.cos(dyaw));
    this.yaw += dyaw * Math.min(1, dt * 8);

    const accel = this.onGround ? 12 : 2;
    const wantX = moveX * speed;
    const wantZ = moveZ * speed;
    if (this.hurtTime <= 0.15) {
      this.vx += (wantX - this.vx) * Math.min(1, accel * dt);
      this.vz += (wantZ - this.vz) * Math.min(1, accel * dt);
    }
    if ((moveX || moveZ) && this.collidedH && this.onGround) this.vy = 8.6;
    if (this.inWater) this.vy = Math.max(this.vy, 1.6);
    this.physics(dt);

    // Environment damage.
    if (this.inLava && this.invuln <= 0) this.damage(4, this.x, this.z, 0.2);
    if (touchesBlock(game.world, this, (id) => BLOCKS[id].hurts) && this.invuln <= 0) this.damage(1, this.x + 0.01, this.z, 0.2);
    if (this.def.burns) {
      const light = game.world.getLight(Math.floor(this.x), Math.floor(this.y + 1.6), Math.floor(this.z));
      if (game.sky.daylight > 0.75 && light.sky >= 15 && !this.inWater) {
        this.burnTimer -= dt;
        if (this.burnTimer <= 0) {
          this.burnTimer = 1;
          this.damage(1, this.x, this.z, 0.05);
          game.particles.burst(this.x - 0.5, this.y + 0.5, this.z - 0.5, [1, 0.55, 0.15], 6);
        }
      }
    }
    this.soundTimer -= dt;
    if (this.soundTimer <= 0) {
      this.soundTimer = 6 + Math.random() * 12;
      game.audio.mob(this.kind, 'idle', this, player);
    }
    const sp = Math.hypot(this.vx, this.vz);
    this.syncMesh(dt, sp);
  }

  // Sheep stop now and then to eat grass, which grows their wool back.
  graze(dt) {
    const world = this.game.world;
    if (this.grazeTime > 0) {
      this.grazeTime -= dt;
      if (this.grazeTime <= 0) {
        const bx = Math.floor(this.x), by = Math.floor(this.y - 0.5), bz = Math.floor(this.z);
        const here = world.getBlock(bx, by + 1, bz);
        if (here === B.tall_grass) world.setBlock(bx, by + 1, bz, 0);
        else if (world.getBlock(bx, by, bz) === B.grass) world.setBlock(bx, by, bz, B.dirt);
        else return;
        this.sheared = false;
        if (this.baby) this.growTime -= 30;
      }
    } else if (this.onGround && Math.random() < dt / (this.sheared ? 12 : 40)) {
      const below = world.getBlock(Math.floor(this.x), Math.floor(this.y - 0.5), Math.floor(this.z));
      if (below === B.grass) this.grazeTime = 2;
    }
  }

  // Heads turn toward a nearby player, or glance around now and then.
  lookAround(dt, player, pd) {
    let wantYaw = this.idleYaw, wantPitch = 0;
    this.lookTimer -= dt;
    if (this.lookTimer <= 0) {
      this.lookTimer = 2 + Math.random() * 4;
      this.idleYaw = Math.random() < 0.6 ? 0 : (Math.random() - 0.5) * 1.4;
    }
    if (pd < 8 && !player.dead) {
      const dx = player.x - this.x, dz = player.z - this.z;
      let rel = Math.atan2(dx, dz) - this.yaw;
      rel = Math.atan2(Math.sin(rel), Math.cos(rel));
      if (Math.abs(rel) < 1.7) {
        wantYaw = Math.max(-1.1, Math.min(1.1, rel));
        wantPitch = -Math.max(-0.7, Math.min(0.7, Math.atan2(player.y + 1.5 - (this.y + this.h * 0.8), Math.hypot(dx, dz))));
      }
    }
    if (this.grazeTime > 0) { wantYaw = 0; wantPitch = 1.0; }
    const k = Math.min(1, dt * 6);
    this.headYaw += (wantYaw - this.headYaw) * k;
    this.headPitch += (wantPitch - this.headPitch) * k;
  }

  syncMesh(dt, sp) {
    this.walk += sp * dt * 2.2;
    const swing = Math.sin(this.walk) * Math.min(1, sp / 2) * 0.8;
    const flap = this.onGround ? 0 : Math.abs(Math.sin(this.age * 24)) * 1.2;
    for (const { spec, pivot } of this.parts) {
      if (spec.leg !== undefined) pivot.rotation.x = spec.leg ? swing : -swing;
      if (spec.arm !== undefined) pivot.rotation.x = -Math.PI / 2 + (spec.arm ? swing : -swing) * 0.2;
      if (spec.wing !== undefined) pivot.rotation.z = spec.wing ? -flap : flap;
      if (spec.wool) pivot.visible = !this.sheared;
      if (spec.name === 'head' && !spec.parent) {
        pivot.rotation.y = this.headYaw;
        pivot.rotation.x = this.headPitch;
        // Babies have big heads, like in Minecraft.
        pivot.scale.setScalar(this.baby ? 1.5 : 1);
      }
    }
    this.mesh.position.set(this.x, this.y, this.z);
    this.mesh.rotation.y = this.yaw;
    const swell = this.fuse > 0 ? 1 + this.fuse * 0.12 : 1;
    const size = this.baby ? 0.5 : 1;
    this.mesh.scale.set(swell * size, (1 + (swell - 1) * 0.5) * size, swell * size);
    if (this.deathTime > 0) return;
    const b = brightness(this.game.world, this.game.sky, this.x, this.y + this.h * 0.7, this.z);
    if (this.hurtTime > 0) this.material.color.setRGB(1, 0.35, 0.35);
    else if (this.fuse > 0 && Math.floor(this.fuse * 8) % 2) this.material.color.setRGB(1, 1, 1);
    else this.material.color.setRGB(b, b, b);
    if (this.woolMaterial) {
      const [r, g, bl] = woolTint(this.color);
      if (this.hurtTime > 0) this.woolMaterial.color.setRGB(1, 0.35, 0.35);
      else this.woolMaterial.color.setRGB(r * b, g * b, bl * b);
    }
  }
}

// --- Manager ---------------------------------------------------------------------------

export class EntityManager {
  constructor(game) {
    this.game = game;
    this.list = [];
    this.spawnTimer = 0;
    this.passiveTimer = 0;
    this.iconTextures = new Map();
    // Animals in chunks that aren't loaded right now, waiting to come back.
    this.parked = [];
    this.unparkTimer = 0;
  }

  // Animals for the save file: the ones around and the ones parked.
  serializeAnimals() {
    return [...this.mobs.filter((m) => !m.hostile).map((m) => m.serialize()), ...this.parked];
  }

  loadAnimals(list) {
    this.parked = Array.isArray(list) ? list.filter((m) => MOBS[m?.kind] && !MOBS[m.kind].hostile) : [];
  }

  unpark() {
    const world = this.game.world;
    const still = [];
    for (const m of this.parked) {
      const ready = world.isLoaded(m.x, m.z) && world.getChunk(Math.floor(m.x / 16), Math.floor(m.z / 16))?.light;
      if (ready) this.add(new Mob(this.game, m.kind, m.x, m.y, m.z, m));
      else still.push(m);
    }
    this.parked = still;
  }

  add(e) {
    this.list.push(e);
    return e;
  }

  get mobs() {
    return this.list.filter((e) => e instanceof Mob && !e.dead);
  }

  clear() {
    for (const e of this.list) e.dispose();
    this.list = [];
    this.parked = [];
  }

  dropItem(x, y, z, stack, vel = null) {
    if (!stack || !stack.id || !ITEMS[stack.id] || stack.count <= 0) return null;
    return this.add(new ItemEntity(this.game, x, y, z, { ...stack }, vel));
  }

  dropBlockItems(x, y, z, id, tool = null) {
    const b = BLOCKS[id];
    for (const s of blockDrops(b, tool, Math.random)) this.dropItem(x + 0.5, y + 0.4, z + 0.5, s);
  }

  itemMesh(id) {
    const def = ITEMS[id];
    if (def?.block !== undefined) {
      const b = BLOCKS[def.block];
      if (b.shape !== 'cross' && b.shape !== 'torch') {
        const mesh = new THREE.Mesh(this.game.chunkRenderer.blockGeometry(def.block), this.game.chunkRenderer.entityMaterial());
        mesh.scale.setScalar(0.26);
        mesh.userData.ownMaterial = true;
        const g = new THREE.Group();
        mesh.position.y = 0;
        g.add(mesh);
        g.userData.ownMaterial = false;
        return g;
      }
    }
    let tex = this.iconTextures.get(id);
    if (!tex) {
      tex = new THREE.CanvasTexture(this.game.bank.icon(id));
      tex.magFilter = THREE.NearestFilter;
      tex.minFilter = THREE.NearestFilter;
      tex.colorSpace = THREE.SRGBColorSpace;
      this.iconTextures.set(id, tex);
    }
    const mat = new THREE.MeshBasicMaterial({ map: tex, transparent: true, alphaTest: 0.5, side: THREE.DoubleSide });
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(0.42, 0.42), mat);
    mesh.position.y = 0.21;
    mesh.userData.ownMaterial = true;
    const g = new THREE.Group();
    g.add(mesh);
    return g;
  }

  applyLight(obj, x, y, z) {
    const world = this.game.world;
    const { sky, block } = world.getLight(Math.floor(x), Math.floor(y), Math.floor(z));
    obj.traverse((o) => {
      const m = o.material;
      if (!m) return;
      if (m.uniforms?.uEntityLight) m.uniforms.uEntityLight.value.set(sky / 15, block / 15);
      else if (m.color) {
        const b = brightness(world, this.game.sky, x, y, z);
        m.color.setRGB(b, b, b);
      }
    });
  }

  update(dt) {
    const p = this.game.player;
    for (const e of this.list) {
      if (e.dead) continue;
      if (!this.game.world.isLoaded(e.x, e.z)) {
        if (e instanceof Mob) {
          if (!e.hostile && e.deathTime <= 0 && this.parked.length < 400) this.parked.push(e.serialize());
          e.dead = true;
        }
        continue;
      }
      e.update(dt);
      if (e instanceof Mob && e.hostile && e.distTo(p) > 72) e.dead = true;
    }
    if (this.list.some((e) => e.dead)) {
      for (const e of this.list) if (e.dead) e.dispose();
      this.list = this.list.filter((e) => !e.dead);
    }
    this.mergeItems(dt);
    this.unparkTimer -= dt;
    if (this.unparkTimer <= 0 && this.parked.length) {
      this.unparkTimer = 1;
      this.unpark();
    }
    this.spawn(dt);
  }

  mergeItems(dt) {
    this.mergeTimer = (this.mergeTimer ?? 0) - dt;
    if (this.mergeTimer > 0) return;
    this.mergeTimer = 0.5;
    const items = this.list.filter((e) => e instanceof ItemEntity && !e.dead);
    for (let i = 0; i < items.length; i++) {
      const a = items[i];
      if (a.dead) continue;
      for (let j = i + 1; j < items.length; j++) {
        const b = items[j];
        if (b.dead || b.stack.id !== a.stack.id || a.stack.dmg || b.stack.data || a.stack.data) continue;
        if (Math.abs(a.x - b.x) + Math.abs(a.y - b.y) + Math.abs(a.z - b.z) > 1.2) continue;
        const max = ITEMS[a.stack.id].maxStack;
        if (a.stack.count + b.stack.count > max) continue;
        a.stack.count += b.stack.count;
        b.dead = true;
      }
    }
  }

  spawn(dt) {
    const game = this.game;
    const world = game.world;
    const p = game.player;
    if (game.settings.peaceful) {
      for (const m of this.mobs) if (m.hostile) m.dead = true;
    }
    this.spawnTimer -= dt;
    this.passiveTimer -= dt;
    const mobs = this.mobs;
    if (this.spawnTimer <= 0 && !game.settings.peaceful) {
      this.spawnTimer = 0.8;
      const hostile = mobs.filter((m) => m.hostile).length;
      if (hostile < 16) {
        const spot = this.findSpot(p, 22, 44, (x, y, z) => {
          const { sky, block } = world.getLight(x, y, z);
          return Math.max(block, sky - game.sky.skyDarken) <= 7 && block <= 7;
        });
        if (spot) this.add(new Mob(game, Math.random() < 0.6 ? 'zombie' : 'creeper', spot.x + 0.5, spot.y, spot.z + 0.5));
      }
    }
    if (this.passiveTimer <= 0) {
      this.passiveTimer = 4;
      const passive = mobs.filter((m) => !m.hostile).length;
      if (passive < 10 && game.sky.daylight > 0.5) {
        const spot = this.findSpot(p, 24, 56, (x, y, z) => world.getBlock(x, y - 1, z) === B.grass && world.getLight(x, y, z).sky >= 12, true);
        if (spot) {
          const kind = ['pig', 'sheep', 'cow', 'chicken'][Math.floor(Math.random() * 4)];
          const n = 2 + Math.floor(Math.random() * 3);
          for (let i = 0; i < n; i++) {
            const sx = spot.x + Math.floor((Math.random() - 0.5) * 4);
            const sz = spot.z + Math.floor((Math.random() - 0.5) * 4);
            const sy = world.surfaceY(sx, sz) + 1;
            if (Math.abs(sy - spot.y) < 3 && !SOLID[world.getBlock(sx, sy, sz)]) this.add(new Mob(game, kind, sx + 0.5, sy, sz + 0.5));
          }
        }
      }
    }
  }

  // A random air cell with a solid floor and two blocks of headroom, between rMin and rMax.
  findSpot(p, rMin, rMax, ok, surfaceOnly = false) {
    const world = this.game.world;
    for (let attempt = 0; attempt < 6; attempt++) {
      const a = Math.random() * Math.PI * 2;
      const r = rMin + Math.random() * (rMax - rMin);
      const x = Math.floor(p.x + Math.cos(a) * r);
      const z = Math.floor(p.z + Math.sin(a) * r);
      if (!world.isLoaded(x, z) || !world.getChunk(Math.floor(x / 16), Math.floor(z / 16))?.light) continue;
      let y;
      if (surfaceOnly || Math.random() < 0.5) y = world.surfaceY(x, z) + 1;
      else y = 4 + Math.floor(Math.random() * Math.max(4, world.surfaceY(x, z) - 6));
      for (let k = 0; k < 12 && y > 1; k++, y--) {
        const floor = world.getBlock(x, y - 1, z);
        if (SOLID[floor] && BLOCKS[floor].shape === 'cube' && !SOLID[world.getBlock(x, y, z)] && !SOLID[world.getBlock(x, y + 1, z)] &&
          !FLUID[world.getBlock(x, y, z)] && floor !== B.bedrock && y < HEIGHT - 2) {
          if (ok(x, y, z)) return { x, y, z };
          break;
        }
      }
    }
    return null;
  }

  destroy(destroyed) {
    const game = this.game;
    const world = game.world;
    for (const [bx, by, bz, id] of destroyed) {
      if (id === B.tnt) {
        world.setBlock(bx, by, bz, 0);
        this.add(new PrimedTNT(game, bx, by, bz, 0.5 + Math.random() * 1));
        continue;
      }
      world.ensureLoot(bx, by, bz);
      world.setBlock(bx, by, bz, 0);
      if (Math.random() < 0.3) this.dropBlockItems(bx, by, bz, id, { type: BLOCKS[id].tool, level: 3, speed: 1 });
    }
  }

  // remote: another player's explosion. Its block changes arrive as edits, so only
  // the effects and the damage to things on this screen happen here.
  explode(x, y, z, power, { remote = false } = {}) {
    const game = this.game;
    const world = game.world;
    const r = remote ? -1 : Math.ceil(power);
    const destroyed = [];
    if (!remote) game.net?.send({ t: 'boom', x, y, z, power });
    for (let dx = -r; dx <= r; dx++) {
      for (let dy = -r; dy <= r; dy++) {
        for (let dz = -r; dz <= r; dz++) {
          const d = Math.hypot(dx, dy, dz);
          if (d > power * (0.7 + Math.random() * 0.35)) continue;
          const bx = Math.floor(x + dx), by = Math.floor(y + dy), bz = Math.floor(z + dz);
          const id = world.getBlock(bx, by, bz);
          if (!id || FLUID[id]) continue;
          const b = BLOCKS[id];
          if (b.hardness < 0 || b.blastproof) continue;
          destroyed.push([bx, by, bz, id]);
        }
      }
    }
    game.net ? game.net.capture(() => this.destroy(destroyed)) : this.destroy(destroyed);
    // Damage and knock back everything nearby, the player included.
    const targets = [...this.mobs, game.player];
    for (const e of targets) {
      const ex = e.x, ey = e.y + e.h / 2, ez = e.z;
      const d = Math.hypot(ex - x, ey - y, ez - z);
      if (d > power * 2) continue;
      const impact = 1 - d / (power * 2);
      const dmg = Math.floor(((impact * impact + impact) / 2) * 7 * power + 1);
      const k = impact * 14 / Math.max(0.5, d);
      if (e === game.player) {
        e.damage(dmg, { x, z, cause: 'explosion' });
        e.vx += (ex - x) * k; e.vy += Math.max(2, (ey - y) * k); e.vz += (ez - z) * k;
      } else {
        e.damage(dmg, x, z, impact * 2);
        e.vy += impact * 8;
      }
    }
    for (const e of this.list) {
      if (e instanceof ItemEntity && Math.hypot(e.x - x, e.y - y, e.z - z) < power * 1.5) {
        e.vy += 4; e.vx += (e.x - x) * 2; e.vz += (e.z - z) * 2;
      }
    }
    for (let i = 0; i < 60; i++) {
      const c = 0.6 + Math.random() * 0.4;
      game.particles.spawn({
        x: x + (Math.random() - 0.5) * power * 1.5, y: y + (Math.random() - 0.5) * power, z: z + (Math.random() - 0.5) * power * 1.5,
        vx: (Math.random() - 0.5) * 4, vy: Math.random() * 3, vz: (Math.random() - 0.5) * 4,
        gravity: -1.5, drag: 0.94, color: [c, c, c], size: 0.35 + Math.random() * 0.4, life: 0.7 + Math.random() * 0.8,
      });
    }
    game.audio.explode({ x, y, z }, game.player);
    game.player.shake = Math.max(game.player.shake, Math.max(0, 1 - game.player.distTo({ x, y, z }) / 24));
  }
}

