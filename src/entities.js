// Everything that moves and isn't the player: dropped items, falling sand, primed
// TNT, and mobs (pig, sheep, zombie, creeper) with boxy textured models, simple AI and
// spawning rules based on light level. Also explosions.
import * as THREE from './three.js';
import { BLOCKS, B, SOLID, FLUID } from './blocks.js';
import { ITEMS, blockDrops } from './items.js';
import { moveEntity, fluidIn, touchesBlock } from './physics.js';
import { HEIGHT } from './worldgen.js';
import { mulberry32 } from './noise.js';

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

const MOBS = {
  pig: {
    w: 0.9, h: 0.9, health: 10, speed: 1.6, hostile: false,
    drops: (r) => [{ id: 'porkchop', count: 1 + Math.floor(r() * 3) }],
    parts: [
      { name: 'body', size: [10, 8, 16], at: [0, 10, 0], color: [240, 160, 160] },
      { name: 'head', size: [8, 8, 8], at: [0, 12, 8], off: [0, 0, 4], paint: skinPaint([240, 160, 160], (c, x, y) => {
        px(c, x + 1, y + 2, '#fff', 1, 1); px(c, x + 2, y + 2, '#1a1a1a'); px(c, x + 5, y + 2, '#1a1a1a'); px(c, x + 6, y + 2, '#fff');
        px(c, x + 2, y + 4, '#e58b95', 4, 3); px(c, x + 3, y + 5, '#9c4a52'); px(c, x + 4, y + 5, '#9c4a52');
      }) },
      { name: 'leg', size: [4, 6, 4], at: [-3, 6, 5], off: [0, -3, 0], color: [225, 145, 145], leg: 0 },
      { name: 'leg', size: [4, 6, 4], at: [3, 6, 5], off: [0, -3, 0], color: [225, 145, 145], leg: 1 },
      { name: 'leg', size: [4, 6, 4], at: [-3, 6, -5], off: [0, -3, 0], color: [225, 145, 145], leg: 1 },
      { name: 'leg', size: [4, 6, 4], at: [3, 6, -5], off: [0, -3, 0], color: [225, 145, 145], leg: 0 },
    ],
  },
  sheep: {
    w: 0.9, h: 1.3, health: 8, speed: 1.5, hostile: false,
    drops: (r) => [{ id: 'white_wool', count: 1 }, { id: 'mutton', count: 1 + Math.floor(r() * 2) }],
    parts: [
      { name: 'body', size: [10, 9, 16], at: [0, 16, 0], color: [236, 236, 230] },
      { name: 'head', size: [6, 7, 8], at: [0, 19, 8], off: [0, 0, 3], paint: skinPaint([210, 196, 176], (c, x, y) => {
        px(c, x + 1, y + 2, '#fff'); px(c, x + 1, y + 3, '#111'); px(c, x + 4, y + 2, '#fff'); px(c, x + 4, y + 3, '#111');
        px(c, x + 2, y + 5, '#8a6a5a', 2, 1);
      }) },
      { name: 'leg', size: [3, 12, 3], at: [-3, 12, 5], off: [0, -6, 0], color: [210, 196, 176], leg: 0 },
      { name: 'leg', size: [3, 12, 3], at: [3, 12, 5], off: [0, -6, 0], color: [210, 196, 176], leg: 1 },
      { name: 'leg', size: [3, 12, 3], at: [-3, 12, -5], off: [0, -6, 0], color: [210, 196, 176], leg: 1 },
      { name: 'leg', size: [3, 12, 3], at: [3, 12, -5], off: [0, -6, 0], color: [210, 196, 176], leg: 0 },
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
MOBS.sheep.parts[0].paint = skinPaint([236, 236, 230], null, 0.06);

const modelCache = new Map();
function modelFor(kind) {
  if (!modelCache.has(kind)) modelCache.set(kind, buildModel(MOBS[kind], kind.length * 977));
  return modelCache.get(kind);
}

export class Mob extends Entity {
  constructor(game, kind, x, y, z) {
    const def = MOBS[kind];
    super(game, x, y, z, def.w, def.h);
    this.kind = kind;
    this.def = def;
    this.health = def.health;
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
    const { tex, geos } = modelFor(kind);
    this.material = new THREE.MeshBasicMaterial({ map: tex, vertexColors: true });
    this.mesh = new THREE.Group();
    this.parts = [];
    def.parts.forEach((part, i) => {
      const m = new THREE.Mesh(geos[i], this.material);
      const pivot = new THREE.Group();
      pivot.position.set(part.at[0] * P, part.at[1] * P, part.at[2] * P);
      pivot.add(m);
      this.mesh.add(pivot);
      this.parts.push({ spec: part, pivot });
    });
    this.mesh.userData.ownMaterial = true;
    game.scene.add(this.mesh);
  }

  get hostile() {
    return this.def.hostile;
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
        for (const s of this.def.drops(r)) game.entities.dropItem(this.x, this.y + 0.5, this.z, s);
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
      if (this.fleeTime > 0) {
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
      if (this.moving) {
        moveX = Math.sin(this.targetYaw);
        moveZ = Math.cos(this.targetYaw);
        if (!this.hostile) speed *= 0.6;
      }
    }

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

  syncMesh(dt, sp) {
    this.walk += sp * dt * 2.2;
    const swing = Math.sin(this.walk) * Math.min(1, sp / 2) * 0.8;
    for (const { spec, pivot } of this.parts) {
      if (spec.leg !== undefined) pivot.rotation.x = spec.leg ? swing : -swing;
      if (spec.arm !== undefined) pivot.rotation.x = -Math.PI / 2 + (spec.arm ? swing : -swing) * 0.2;
    }
    this.mesh.position.set(this.x, this.y, this.z);
    this.mesh.rotation.y = this.yaw;
    const swell = this.fuse > 0 ? 1 + this.fuse * 0.12 : 1;
    this.mesh.scale.set(swell, 1 + (swell - 1) * 0.5, swell);
    if (this.deathTime > 0) return;
    const b = brightness(this.game.world, this.game.sky, this.x, this.y + this.h * 0.7, this.z);
    if (this.hurtTime > 0) this.material.color.setRGB(1, 0.35, 0.35);
    else if (this.fuse > 0 && Math.floor(this.fuse * 8) % 2) this.material.color.setRGB(1, 1, 1);
    else this.material.color.setRGB(b, b, b);
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
        if (e instanceof Mob) e.dead = true;
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
          const kind = Math.random() < 0.55 ? 'pig' : 'sheep';
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

  explode(x, y, z, power) {
    const game = this.game;
    const world = game.world;
    const r = Math.ceil(power);
    const destroyed = [];
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

