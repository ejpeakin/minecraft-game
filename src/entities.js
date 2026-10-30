// Everything that moves and isn't the player: dropped items, falling sand, primed
// TNT, and mobs (pigs, sheep, cows, chickens, zombies, creepers) with boxy textured
// models, simple AI and spawning rules based on light level. Also explosions.
import * as THREE from './three.js';
import { BLOCKS, B, SOLID, FLUID, SHAPES, SHAPE, shapeBoxes } from './blocks.js';
import { ITEMS, blockDrops } from './items.js';
import { moveEntity, fluidIn, touchesBlock, raycast } from './physics.js';
import { HEIGHT, SEA, BIOME } from './worldgen.js';

const GOAT_BIOMES = new Set([BIOME.SNOWY_SLOPES, BIOME.JAGGED_PEAKS, BIOME.FROZEN_PEAKS, BIOME.STONY_PEAKS]);
const GOAT_GROUND = new Set([B.snow_block, B.stone, B.packed_ice, B.calcite, B.snowy_grass]);
import { mulberry32 } from './noise.js';
import { DYE_COLORS } from './textures.js';
import { itemGeometry } from './renderer.js';

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

// --- Shadows -------------------------------------------------------------------------

// A soft round shadow on the ground under a creature or item, fading as it rises.
let shadowTexture = null;
function shadowTex() {
  if (!shadowTexture) {
    const c = document.createElement('canvas');
    c.width = c.height = 32;
    const ctx = c.getContext('2d');
    const g = ctx.createRadialGradient(16, 16, 2, 16, 16, 16);
    g.addColorStop(0, 'rgba(0,0,0,0.62)');
    g.addColorStop(0.6, 'rgba(0,0,0,0.38)');
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 32, 32);
    shadowTexture = new THREE.CanvasTexture(c);
  }
  return shadowTexture;
}
const shadowGeo = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);

export class Shadow {
  constructor(game, size) {
    this.game = game;
    this.size = size;
    this.material = new THREE.MeshBasicMaterial({ map: shadowTex(), transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
    this.mesh = new THREE.Mesh(shadowGeo, this.material);
    this.mesh.renderOrder = 2;
    game.scene.add(this.mesh);
  }

  update(x, y, z, scale = 1) {
    const world = this.game.world;
    let ground = -1;
    for (let by = Math.floor(y + 0.01); by >= Math.floor(y) - 3; by--) {
      const id = world.getBlock(Math.floor(x), by, Math.floor(z));
      if (FLUID[id]) break;
      if (SOLID[id]) {
        ground = by + (SHAPES[id] === SHAPE.CUBE ? 1 : Math.min(1, Math.max(...shapeBoxes(id, () => 0, false).map((b) => b[4]), 0)));
        break;
      }
    }
    const height = y - ground;
    const far = Math.hypot(x - this.game.player.x, z - this.game.player.z) > 40;
    this.mesh.visible = ground >= 0 && height < 3 && !far;
    if (!this.mesh.visible) return;
    this.mesh.position.set(x, ground + 0.002, z);
    this.mesh.scale.setScalar(this.size * scale * (1 - height * 0.15));
    this.material.opacity = (1 - height / 3) * (0.35 + 0.65 * this.game.sky.daylight);
  }

  dispose() {
    this.game.scene.remove(this.mesh);
    this.material.dispose();
  }
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
    this.shadow?.dispose();
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
    this.shadow = new Shadow(game, 0.45);
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
    this.shadow.update(this.x, this.y, this.z);
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

// --- Arrows ----------------------------------------------------------------------------

// A box with one color baked into its vertices (the material color is the lighting).
function coloredBox(w, h, d, color, x = 0, y = 0, z = 0) {
  const g = new THREE.BoxGeometry(w, h, d);
  g.translate(x, y, z);
  const c = [];
  for (let i = 0; i < g.attributes.position.count; i++) c.push(color[0] / 255, color[1] / 255, color[2] / 255);
  g.setAttribute('color', new THREE.Float32BufferAttribute(c, 3));
  return g;
}

export class Arrow extends Entity {
  constructor(game, x, y, z, vx, vy, vz, { shooter = null, damage = 6, pickup = false } = {}) {
    super(game, x, y, z, 0.2, 0.2);
    this.vx = vx; this.vy = vy; this.vz = vz;
    this.shooter = shooter;
    this.damageAmount = damage;
    this.pickup = pickup;
    this.stuck = false;
    const material = new THREE.MeshBasicMaterial({ vertexColors: true });
    this.mesh = new THREE.Group();
    this.mesh.rotation.order = 'YXZ';
    for (const g of [coloredBox(0.04, 0.04, 0.5, [120, 86, 44]), coloredBox(0.07, 0.07, 0.08, [130, 130, 136], 0, 0, 0.27),
      coloredBox(0.12, 0.01, 0.1, [236, 236, 230], 0, 0, -0.22), coloredBox(0.01, 0.12, 0.1, [236, 236, 230], 0, 0, -0.22)]) {
      const m = new THREE.Mesh(g, material);
      m.userData.ownMaterial = true;
      this.mesh.add(m);
    }
    game.scene.add(this.mesh);
  }

  update(dt) {
    const game = this.game;
    const world = game.world;
    this.age += dt;
    if (this.stuck) {
      // Stuck arrows can be picked back up (if a player shot them) and fade after a minute.
      const p = game.player;
      if (this.pickup && !p.dead && this.distTo({ x: p.x, y: p.y + 0.6, z: p.z }) < 1.4 && !p.inventory.add({ id: 'arrow', count: 1 })) {
        game.audio.pop();
        this.dead = true;
      }
      if (this.age > 60) this.dead = true;
      return;
    }
    const speed = Math.hypot(this.vx, this.vy, this.vz);
    const steps = Math.max(1, Math.ceil((speed * dt) / 0.2));
    const h = dt / steps;
    for (let i = 0; i < steps && !this.dead && !this.stuck; i++) {
      const nx = this.x + this.vx * h, ny = this.y + this.vy * h, nz = this.z + this.vz * h;
      // Creatures first: the player (unless they shot it) and mobs.
      const p = game.player;
      const hits = (e, ex, ey, ez) => e.w && Math.abs(ex - e.x) < e.w / 2 + 0.1 && Math.abs(ez - e.z) < e.w / 2 + 0.1 && ey > e.y - 0.1 && ey < e.y + e.h + 0.1;
      if (this.shooter !== p && !p.dead && hits(p, nx, ny, nz)) {
        p.damage(this.damageAmount, { x: this.x - this.vx, z: this.z - this.vz, cause: 'arrow' });
        this.dead = true;
        break;
      }
      for (const m of game.entities.mobs) {
        if (m === this.shooter || m.deathTime > 0 || !hits(m, nx, ny, nz)) continue;
        if (m.damage(this.damageAmount, this.x - this.vx, this.z - this.vz, 0.6) && this.shooter === p && m.hostile) m.angry = 15;
        game.audio.block('cloth', 'hit', m, p);
        this.dead = true;
        break;
      }
      if (this.dead) break;
      const id = world.getBlock(Math.floor(nx), Math.floor(ny), Math.floor(nz));
      if (SOLID[id]) {
        this.stuck = true;
        this.age = 0;
        game.audio.block(BLOCKS[id].sound, 'hit', { x: nx, y: ny, z: nz }, p);
        break;
      }
      this.x = nx; this.y = ny; this.z = nz;
      this.vy -= 20 * h;
      const drag = Math.pow(0.99, h * 20);
      this.vx *= drag; this.vy *= drag; this.vz *= drag;
    }
    if (FLUID[world.getBlock(Math.floor(this.x), Math.floor(this.y), Math.floor(this.z))]) {
      this.vx *= 0.8; this.vy *= 0.8; this.vz *= 0.8;
    }
    if (this.y < -20 || this.age > 30) this.dead = true;
    this.mesh.position.set(this.x, this.y, this.z);
    if (!this.stuck) {
      this.mesh.rotation.y = Math.atan2(this.vx, this.vz);
      this.mesh.rotation.x = -Math.atan2(this.vy, Math.hypot(this.vx, this.vz));
    }
    game.entities.applyLight(this.mesh, this.x, this.y, this.z);
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
const GOAT_WHITE = [232, 228, 216];
const SQUID = [44, 62, 98];
const GLOW = [46, 168, 160];
const AXOLOTL = [238, 168, 200];
// Squid: a tall body with eight tentacles hanging from a ring underneath.
const squidParts = (base, spot, glow) => [
  { name: 'body', size: [10, 12, 10], at: [0, 16, 0], paint: withFront(blotched(base, spot, glow ? 10 : 4, 0.06), (c, x, y) => {
    px(c, x + 2, y + 8, glow ? '#e8fff4' : '#d8dce8', 2, 2); px(c, x + 6, y + 8, glow ? '#e8fff4' : '#d8dce8', 2, 2);
    px(c, x + 2, y + 9, '#101418'); px(c, x + 7, y + 9, '#101418');
  }) },
  ...Array.from({ length: 8 }, (_, i) => {
    const a = (i / 8) * Math.PI * 2;
    return { name: 'tentacle', size: [2, 10, 2], at: [Math.round(Math.sin(a) * 3.5), 10, Math.round(Math.cos(a) * 3.5)], off: [0, -5, 0], paint: blotched(mul3(base, 0.9), spot, glow ? 3 : 1, 0.06), tentacle: i };
  }),
];
function mul3(c, f) { return [c[0] * f, c[1] * f, c[2] * f]; }

// A player's arm: skin, with the shirt's short sleeve at the top.
const sleeve = (ctx, f, x, y, w, h, r) => {
  noisyFill(ctx, x, y, w, h, [196, 142, 106], 0.06, r);
  if (f === 2) noisyFill(ctx, x, y, w, h, [47, 168, 176], 0.06, r);
  else if (f !== 3) noisyFill(ctx, x, y, w, 4, [47, 168, 176], 0.06, r);
};

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
  // Caves & Cliffs. Goats live on the high mountains, jump far and sometimes ram you.
  goat: {
    w: 0.9, h: 1.3, health: 10, speed: 1.6, hostile: false, food: 'wheat', leaps: true,
    drops: () => [],
    parts: [
      { name: 'leg', size: [3, 10, 3], at: [-2.5, 10, 5], off: [0, -5, 0], paint: solid(GOAT_WHITE), leg: 0 },
      { name: 'leg', size: [3, 10, 3], at: [2.5, 10, 5], off: [0, -5, 0], paint: solid(GOAT_WHITE), leg: 1 },
      { name: 'leg', size: [3, 10, 3], at: [-2.5, 10, -5], off: [0, -5, 0], paint: solid(GOAT_WHITE), leg: 1 },
      { name: 'leg', size: [3, 10, 3], at: [2.5, 10, -5], off: [0, -5, 0], paint: solid(GOAT_WHITE), leg: 0 },
      { name: 'body', size: [9, 9, 16], at: [0, 14.5, 0], paint: blotched(GOAT_WHITE, [212, 204, 190], 7, 0.05) },
      { id: 'head', name: 'head', size: [5, 7, 8], at: [0, 19, 7], off: [0, 1, 4], paint: withFront(solid(GOAT_WHITE, 0.05), (c, x, y) => {
        px(c, x, y + 2, '#c8a26a'); px(c, x + 4, y + 2, '#c8a26a'); px(c, x, y + 2, '#2a2016'); px(c, x + 4, y + 2, '#2a2016');
        px(c, x + 1, y + 5, '#b8a890', 3, 1);
      }) },
      { name: 'horn', parent: 'head', size: [2, 6, 2], at: [0, 19, 7], off: [-1.5, 7, 2], paint: solid([186, 172, 146], 0.05) },
      { name: 'horn', parent: 'head', size: [2, 6, 2], at: [0, 19, 7], off: [1.5, 7, 2], paint: solid([186, 172, 146], 0.05) },
      { name: 'beard', parent: 'head', size: [1, 4, 2], at: [0, 19, 7], off: [0, -4.5, 6], paint: solid([220, 214, 200], 0.05) },
    ],
  },
  squid: {
    w: 0.8, h: 1.0, health: 10, speed: 1.6, hostile: false, aquatic: true, dries: true,
    drops: (r) => [{ id: 'ink_sac', count: 1 + Math.floor(r() * 3) }],
    parts: squidParts(SQUID, [70, 92, 140], false),
  },
  glow_squid: {
    w: 0.8, h: 1.0, health: 10, speed: 1.4, hostile: false, aquatic: true, dries: true, glows: true,
    drops: (r) => [{ id: 'glow_ink_sac', count: 1 + Math.floor(r() * 3) }],
    parts: squidParts(GLOW, [140, 250, 220], true),
  },
  // Axolotls swim in lush cave pools, in five colors (blue is very rare).
  axolotl: {
    w: 0.75, h: 0.42, health: 14, speed: 2.2, hostile: false, aquatic: true, food: 'glow_berries', tinted: true,
    drops: () => [],
    parts: [
      { name: 'body', size: [8, 4, 10], at: [0, 3, 0], paint: blotched(AXOLOTL, [222, 140, 182], 4, 0.05) },
      { id: 'head', name: 'head', size: [8, 5, 5], at: [0, 3.5, 5], off: [0, 0, 2.5], paint: withFront(solid(AXOLOTL, 0.05), (c, x, y) => {
        px(c, x + 1, y + 2, '#101010'); px(c, x + 6, y + 2, '#101010'); px(c, x + 3, y + 4, '#c86a96', 2, 1);
      }) },
      ...[-1, 1].flatMap((side) => [0, 1, 2].map((k) => ({ name: 'gill', parent: 'head', size: [1, 3, 1], at: [0, 3.5, 5], off: [side * 4.5, 2 + k * 0.5 - 1, 1 + k], paint: solid([214, 70, 132], 0.06) }))),
      { name: 'tail', size: [1, 4, 8], at: [0, 3.5, -5], off: [0, 0, -4], paint: solid([230, 150, 190], 0.05), tail: true },
      { name: 'leg', size: [3, 1, 2], at: [-4.5, 1, 3], paint: solid(AXOLOTL), leg: 0 },
      { name: 'leg', size: [3, 1, 2], at: [4.5, 1, 3], paint: solid(AXOLOTL), leg: 1 },
      { name: 'leg', size: [3, 1, 2], at: [-4.5, 1, -3], paint: solid(AXOLOTL), leg: 1 },
      { name: 'leg', size: [3, 1, 2], at: [4.5, 1, -3], paint: solid(AXOLOTL), leg: 0 },
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
      { name: 'arm', size: [4, 12, 4], at: [-6, 22, 0], off: [0, -5, 0], paint: sleeve, swing: 0 },
      { name: 'arm', size: [4, 12, 4], at: [6, 22, 0], off: [0, -5, 0], paint: sleeve, swing: 1 },
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
  skeleton: {
    w: 0.6, h: 1.99, health: 20, speed: 2.4, hostile: true, burns: true, ranged: true,
    drops: (r) => [{ id: 'bone', count: Math.floor(r() * 3) }, { id: 'arrow', count: Math.floor(r() * 3) }].filter((s) => s.count > 0),
    parts: [
      { name: 'head', size: [8, 8, 8], at: [0, 24, 0], off: [0, 4, 0], paint: withFront(solid([204, 204, 196], 0.06), (c, x, y) => {
        px(c, x + 1, y + 3, '#2a2a2a', 2, 2); px(c, x + 5, y + 3, '#2a2a2a', 2, 2);
        px(c, x + 3, y + 5, '#4a4a46', 2, 1);
        for (let i = 1; i < 7; i++) px(c, x + i, y + 6, i % 2 ? '#3a3a38' : '#d8d8d0');
      }) },
      { name: 'body', size: [8, 12, 4], at: [0, 18, 0], paint: (c, f, x, y, w, h, r) => {
        noisyFill(c, x, y, w, h, [54, 54, 52], 0.05, r);
        for (let j = 1; j < h - 2; j += 2) noisyFill(c, x, y + j, w, 1, [200, 200, 192], 0.06, r);
        if (f === 4 || f === 5) noisyFill(c, x + Math.floor(w / 2) - 1, y, 2, h, [210, 210, 202], 0.05, r);
      } },
      { name: 'arm', size: [2, 12, 2], at: [-5, 22, 0], off: [0, -5, 0], paint: solid([204, 204, 196]), arm: 0 },
      { name: 'arm', size: [2, 12, 2], at: [5, 22, 0], off: [0, -5, 0], paint: solid([204, 204, 196]), arm: 1 },
      { name: 'leg', size: [2, 12, 2], at: [-2, 12, 0], off: [0, -6, 0], paint: solid([204, 204, 196]), leg: 0 },
      { name: 'leg', size: [2, 12, 2], at: [2, 12, 0], off: [0, -6, 0], paint: solid([204, 204, 196]), leg: 1 },
    ],
  },
  spider: {
    w: 1.4, h: 0.9, health: 16, speed: 3.0, hostile: true, damage: 2, climbs: true, calmInDaylight: true,
    drops: (r) => [{ id: 'string', count: Math.floor(r() * 3) }].filter((s) => s.count > 0),
    parts: [
      { name: 'abdomen', size: [10, 8, 12], at: [0, 9, -9], paint: blotched([52, 44, 40], [74, 30, 26], 3, 0.08) },
      { name: 'thorax', size: [6, 6, 6], at: [0, 9, 0], paint: solid([46, 40, 36], 0.08) },
      { id: 'head', name: 'head', size: [8, 8, 8], at: [0, 9, 3], off: [0, 0, 4], paint: withFront(solid([50, 42, 38], 0.08), (c, x, y) => {
        px(c, x + 1, y + 3, '#c81e1e', 2, 2); px(c, x + 5, y + 3, '#c81e1e', 2, 2);
        px(c, x + 2, y + 2, '#a01818'); px(c, x + 5, y + 2, '#a01818'); px(c, x + 3, y + 4, '#ff4040'); px(c, x + 4, y + 4, '#ff4040');
      }) },
      // Eight legs splayed out from the thorax, tilted down to the ground.
      ...[2, 1, 0, -1].flatMap((z, i) => [-1, 1].map((side) => ({
        name: 'leg', size: [16, 2, 2], at: [side * 3, 9, z], off: [side * 8, 0, 0], paint: solid([44, 38, 34], 0.08),
        rot: [0, side * [-0.6, -0.2, 0.2, 0.6][i], side * -0.6], spider: i % 2 === (side > 0 ? 0 : 1) ? 1 : 0,
      }))),
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
    if (part.rot) pivot.rotation.set(...part.rot);
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
// Axolotl colors (lucy, wild, gold, cyan, and the rare blue) as tints of the pink skin.
const AXOLOTL_TINTS = { lucy: [1, 1, 1], wild: [0.62, 0.46, 0.4], gold: [1.06, 0.86, 0.42], cyan: [0.74, 0.96, 1.04], blue: [0.44, 0.52, 1.12] };
function randomAxolotl() {
  if (Math.random() < 1 / 1200) return 'blue';
  return ['lucy', 'wild', 'gold', 'cyan'][Math.floor(Math.random() * 4)];
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
    this.color = kind === 'sheep' ? opts.color ?? randomSheepColor() : kind === 'axolotl' ? opts.color ?? randomAxolotl() : null;
    this.ramTimer = 20 + Math.random() * 40;
    this.ram = 0; // > 0 while a goat lowers its head and charges
    this.swimGoal = null;
    this.swimTime = 0;
    this.dryTime = 0;
    this.sheared = !!opts.sheared;
    this.loveTime = 0;
    this.breedCooldown = opts.breedCooldown ?? 0;
    this.eggTimer = 300 + Math.random() * 300;
    this.grazeTime = 0;
    this.headYaw = 0;
    this.headPitch = 0;
    this.lookTimer = 0;
    this.idleYaw = 0;
    this.shootCooldown = 1 + Math.random() * 2;
    this.strafe = Math.random() < 0.5 ? 1 : -1;
    this.angry = 0;
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
    this.shadow = new Shadow(game, Math.max(def.w, 0.5) * 1.25);
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
    if ((this.kind === 'cow' || this.kind === 'goat') && id === 'bucket' && !this.baby) {
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

  // A clear line from this mob's eyes to the target's.
  canSee(target) {
    const ex = this.x, ey = this.y + this.h * 0.85, ez = this.z;
    const dx = target.x - ex, dy = target.y + 1.5 - ey, dz = target.z - ez;
    const d = Math.hypot(dx, dy, dz);
    if (d < 0.01) return true;
    const hit = raycast(this.game.world, ex, ey, ez, dx / d, dy / d, dz / d, d);
    return !hit;
  }

  // Shoot an arrow at the target, aiming a little high so it drops onto them.
  shoot(target) {
    const game = this.game;
    const sx = this.x, sy = this.y + 1.45, sz = this.z;
    const dx = target.x - sx, dy = target.y + 1.1 - sy, dz = target.z - sz;
    const hd = Math.hypot(dx, dz) || 1;
    const t = hd / 26;
    const spread = () => (Math.random() - 0.5) * 1.2;
    game.entities.add(new Arrow(game, sx + (dx / hd) * 0.6, sy, sz + (dz / hd) * 0.6, dx / t + spread(), dy / t + 10 * t + spread(), dz / t + spread(), { shooter: this, damage: 2 + Math.floor(Math.random() * 3) }));
    game.audio.bow(this, game.player);
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
    if (this.hostile) this.angry = 15; // a spider you hit stays angry even in daylight
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

    if (this.def.aquatic && (this.inWater || this.kind !== 'axolotl')) {
      this.swim(dt);
      return;
    }
    let moveX = 0, moveZ = 0, speed = this.def.speed;
    this.angry = Math.max(0, this.angry - dt);
    let canTarget = this.hostile && !player.dead && player.mode === 'survival';
    if (canTarget && this.def.calmInDaylight && this.angry <= 0) {
      const l = game.world.getLight(Math.floor(this.x), Math.floor(this.y + 0.5), Math.floor(this.z));
      if (game.sky.daylight > 0.6 && l.sky >= 12) canTarget = false;
    }
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
      if (this.def.ranged) {
        // Keep a bow's distance: back off when close, close in when far or out of sight,
        // otherwise circle; shoot when there's a clear line.
        const sight = this.canSee(player);
        this.shootCooldown -= dt;
        if (close > 0.01) {
          if (pd < 6) { moveX = -dx / close; moveZ = -dz / close; }
          else if (pd > 11 || !sight) { moveX = dx / close; moveZ = dz / close; }
          else {
            if (Math.random() < dt / 2.5) this.strafe = -this.strafe;
            moveX = (-dz / close) * this.strafe; moveZ = (dx / close) * this.strafe;
            speed *= 0.55;
          }
        }
        if (sight && pd < 16 && this.shootCooldown <= 0) {
          this.shootCooldown = 1.8 + Math.random() * 1.4;
          this.shoot(player);
        }
      } else if (close > 0.9) { moveX = dx / close; moveZ = dz / close; }
      if (this.kind === 'spider' && this.onGround && pd > 1.6 && pd < 4 && Math.random() < dt * 1.2) {
        this.vy = 5.5;
        this.vx += (dx / close) * 4;
        this.vz += (dz / close) * 4;
      }
      if (this.def.damage && pd < 1.6 && Math.abs(player.y - this.y) < 1.6 && this.attackCooldown <= 0) {
        this.attackCooldown = 1;
        player.damage(this.def.damage, { x: this.x, z: this.z, cause: this.kind });
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
      if (this.def.leaps) this.goatMind(dt, player, pd);
      if (this.ram > 0) {
        // Charging: head down, straight at where the player stood.
        this.ram -= dt;
        const [tx, tz] = this.ramAt;
        const dx = tx - this.x, dz = tz - this.z;
        const d = Math.hypot(dx, dz) || 1;
        this.targetYaw = Math.atan2(dx, dz);
        if (this.ram < 1.2) { moveX = dx / d; moveZ = dz / d; speed = 6.5; }
        if (this.ram < 1.2 && pd < 1.5 && !player.dead) {
          this.ram = 0;
          player.damage(2, { x: this.x, z: this.z, cause: 'goat' });
          player.vx += (dx / d) * 9;
          player.vz += (dz / d) * 9;
          player.vy = Math.max(player.vy, 6);
        }
        if (d < 0.6) this.ram = 0;
      } else if (this.grazeTime > 0) {
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
    if ((moveX || moveZ) && this.collidedH && this.onGround) this.vy = this.def.leaps ? 11 : 8.6;
    // Spiders walk up walls.
    if (this.def.climbs && (moveX || moveZ) && this.collidedH) this.vy = Math.max(this.vy, 3.2);
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

  // Goats leap now and then, and every so often pick a player to ram.
  goatMind(dt, player, pd) {
    if (this.onGround && this.moving && Math.random() < dt / 8) {
      this.vy = 11;
      this.vx += Math.sin(this.yaw) * 3;
      this.vz += Math.cos(this.yaw) * 3;
    }
    this.ramTimer -= dt;
    if (this.ramTimer <= 0 && this.ram <= 0) {
      this.ramTimer = 30 + Math.random() * 60;
      if (!this.baby && pd > 3 && pd < 12 && !player.dead && player.mode === 'survival' && this.canSee(player)) {
        this.ram = 2.2; // a second of lowering the head, then the charge
        this.ramAt = [player.x, player.z];
        this.game.audio.mob('goat', 'idle', this, player);
      }
    }
  }

  // Squid, glow squid and axolotls in water: drift toward a spot somewhere in the water
  // nearby, and flee when hit. Squid out of water flop about and dry out.
  swim(dt) {
    const game = this.game;
    const world = game.world;
    const player = game.player;
    const water = (x, y, z) => FLUID[world.getBlock(Math.floor(x), Math.floor(y), Math.floor(z))] === 1;
    this.swimTime -= dt;
    this.fleeTime -= dt;
    if (this.inWater) {
      this.dryTime = 0;
      if (this.swimTime <= 0 || !this.swimGoal) {
        this.swimTime = 2 + Math.random() * 4;
        this.swimGoal = null;
        for (let k = 0; k < 8 && !this.swimGoal; k++) {
          let tx = this.x + (Math.random() - 0.5) * 12, ty = this.y + (Math.random() - 0.5) * 5, tz = this.z + (Math.random() - 0.5) * 12;
          if (this.fleeTime > 0) { tx = this.x + (this.x - player.x) * 2; tz = this.z + (this.z - player.z) * 2; }
          if (water(tx, ty, tz) && water(tx, ty + this.h, tz)) this.swimGoal = [tx, ty, tz];
        }
      }
      let wx = 0, wy = 0.2, wz = 0;
      if (this.swimGoal) {
        const [tx, ty, tz] = this.swimGoal;
        const dx = tx - this.x, dy = ty - this.y, dz = tz - this.z;
        const d = Math.hypot(dx, dy, dz);
        if (d < 0.6) this.swimGoal = null;
        else {
          const sp = this.def.speed * (this.fleeTime > 0 ? 2 : 1);
          wx = (dx / d) * sp; wy = (dy / d) * sp; wz = (dz / d) * sp;
          this.targetYaw = Math.atan2(dx, dz);
        }
      }
      const k = Math.min(1, dt * 12);
      this.vx += (wx - this.vx) * k;
      this.vy += (wy - this.vy) * k;
      this.vz += (wz - this.vz) * k;
    } else if (this.def.dries) {
      this.dryTime += dt;
      if (this.onGround && Math.random() < dt * 1.5) { this.vy = 4; this.vx = (Math.random() - 0.5) * 3; this.vz = (Math.random() - 0.5) * 3; }
      if (this.dryTime > 1) { this.dryTime = 0; this.damage(1, this.x, this.z, 0); }
    }
    let dyaw = this.targetYaw - this.yaw;
    dyaw = Math.atan2(Math.sin(dyaw), Math.cos(dyaw));
    this.yaw += dyaw * Math.min(1, dt * 4);
    this.physics(dt, this.inWater ? 0 : 28);
    this.lookAround(dt, player, this.distTo(player));
    this.soundTimer -= dt;
    if (this.soundTimer <= 0) {
      this.soundTimer = 8 + Math.random() * 12;
      game.audio.mob(this.kind, 'idle', this, player);
    }
    this.syncMesh(dt, Math.hypot(this.vx, this.vz));
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
      if (spec.leg !== undefined && spec.spider === undefined) pivot.rotation.x = spec.leg ? swing : -swing;
      if (spec.arm !== undefined) pivot.rotation.x = -Math.PI / 2 + (spec.arm ? swing : -swing) * 0.2;
      if (spec.wing !== undefined) pivot.rotation.z = spec.wing ? -flap : flap;
      if (spec.spider !== undefined) {
        const k = spec.spider ? swing : -swing;
        pivot.rotation.y = spec.rot[1] + k * 0.45;
        pivot.rotation.z = spec.rot[2] + Math.abs(k) * 0.25 * Math.sign(spec.rot[2]);
      }
      if (spec.wool) pivot.visible = !this.sheared;
      if (spec.tentacle !== undefined) {
        // Tentacles open and close as a squid swims.
        const a = (spec.tentacle / 8) * Math.PI * 2;
        const open = 0.25 + Math.sin(this.age * 3.2) * 0.25;
        pivot.rotation.x = -Math.cos(a) * open;
        pivot.rotation.z = Math.sin(a) * open;
      }
      if (spec.tail) pivot.rotation.y = Math.sin(this.age * (this.inWater ? 7 : 3)) * 0.35;
      if (spec.name === 'head' && !spec.parent && this.ram > 1.2) { pivot.rotation.x = 0.7; continue; }
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
    this.shadow.update(this.x, this.y, this.z, size);
    this.mesh.scale.set(swell * size, (1 + (swell - 1) * 0.5) * size, swell * size);
    if (this.deathTime > 0) return;
    const b = this.def.glows ? 1 : brightness(this.game.world, this.game.sky, this.x, this.y + this.h * 0.7, this.z);
    const tint = this.def.tinted ? AXOLOTL_TINTS[this.color] ?? AXOLOTL_TINTS.lucy : null;
    if (this.hurtTime > 0) this.material.color.setRGB(1, 0.35, 0.35);
    else if (this.fuse > 0 && Math.floor(this.fuse * 8) % 2) this.material.color.setRGB(1, 1, 1);
    else if (tint) this.material.color.setRGB(b * tint[0], b * tint[1], b * tint[2]);
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
    // Flat items are solid one-pixel-thick models, like Minecraft's dropped items.
    const tile = this.game.bank.flatTile(id);
    let mesh;
    if (tile) {
      mesh = new THREE.Mesh(itemGeometry(id, tile), new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide }));
      mesh.scale.setScalar(0.42);
    } else {
      let tex = this.iconTextures.get(id);
      if (!tex) {
        tex = new THREE.CanvasTexture(this.game.bank.icon(id));
        tex.magFilter = THREE.NearestFilter;
        tex.minFilter = THREE.NearestFilter;
        tex.colorSpace = THREE.SRGBColorSpace;
        this.iconTextures.set(id, tex);
      }
      mesh = new THREE.Mesh(new THREE.PlaneGeometry(0.42, 0.42), new THREE.MeshBasicMaterial({ map: tex, transparent: true, alphaTest: 0.5, side: THREE.DoubleSide }));
    }
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
          if (!e.hostile && !e.def.aquatic && e.deathTime <= 0 && this.parked.length < 400) this.parked.push(e.serialize());
          e.dead = true;
        }
        continue;
      }
      e.update(dt);
      if (e instanceof Mob && (e.hostile || e.def.aquatic) && e.distTo(p) > 72) e.dead = true;
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
        const r = Math.random();
        const kind = r < 0.35 ? 'zombie' : r < 0.6 ? 'skeleton' : r < 0.8 ? 'creeper' : 'spider';
        if (spot) this.add(new Mob(game, kind, spot.x + 0.5, spot.y, spot.z + 0.5));
      }
    }
    this.waterTimer = (this.waterTimer ?? 3) - dt;
    if (this.waterTimer <= 0) {
      this.waterTimer = 5;
      if (mobs.filter((m) => m.def.aquatic).length < 6) this.spawnInWater(p);
    }
    if (this.passiveTimer <= 0) {
      this.passiveTimer = 4;
      const passive = mobs.filter((m) => !m.hostile && !m.def.aquatic).length;
      if (passive < 10 && game.sky.daylight > 0.5) {
        // Farm animals on grass; goats on the high mountains.
        const spot = this.findSpot(p, 24, 56, (x, y, z) => {
          const ground = world.getBlock(x, y - 1, z);
          if (world.getLight(x, y, z).sky < 12) return false;
          return ground === B.grass || (GOAT_GROUND.has(ground) && GOAT_BIOMES.has(world.gen.column(x, z).biome));
        }, true);
        if (spot) {
          const goats = GOAT_BIOMES.has(world.gen.column(spot.x, spot.z).biome);
          const kind = goats ? 'goat' : ['pig', 'sheep', 'cow', 'chicken'][Math.floor(Math.random() * 4)];
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

  // Squid in open water near the surface; glow squid in dark underground water, or
  // axolotls if it's a lush cave.
  spawnInWater(p) {
    const game = this.game;
    const world = game.world;
    const water = (x, y, z) => FLUID[world.getBlock(x, y, z)] === 1;
    for (let attempt = 0; attempt < 4; attempt++) {
      const a = Math.random() * Math.PI * 2;
      const r = 14 + Math.random() * 30;
      const x = Math.floor(p.x + Math.cos(a) * r), z = Math.floor(p.z + Math.sin(a) * r);
      if (!world.isLoaded(x, z) || !world.getChunk(Math.floor(x / 16), Math.floor(z / 16))?.light) continue;
      const col = world.gen.column(x, z);
      const deep = Math.random() < 0.5;
      const y = deep ? 8 + Math.floor(Math.random() * 30) : SEA - 2 - Math.floor(Math.random() * 6);
      if (!water(x, y, z) || !water(x, y + 1, z)) continue;
      const light = world.getLight(x, y, z);
      let kind, n;
      if (deep && light.sky === 0 && col.height > y + 6) {
        kind = col.lush ? 'axolotl' : 'glow_squid';
        n = 1 + Math.floor(Math.random() * 2);
      } else if (!deep && light.sky >= 8 && col.height < SEA - 4) {
        kind = 'squid';
        n = 2 + Math.floor(Math.random() * 3);
      } else continue;
      for (let i = 0; i < n; i++) this.add(new Mob(game, kind, x + 0.5 + (Math.random() - 0.5) * 2, y + 0.2, z + 0.5 + (Math.random() - 0.5) * 2));
      return;
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

