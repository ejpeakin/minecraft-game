// The player: look and movement (walk, sprint, sneak, swim, fly, sit), vitals
// (health, hunger, saturation, air, fall damage), and every way of acting on the
// world (mining, attacking, placing, eating, using blocks and items).
import { BLOCKS, B, SOLID, FLUID, FACING_DIR, OPAQUE } from './blocks.js';
import { ITEMS, breakTime, toolOf, attackDamage, SMELTING } from './items.js';
import { Inventory } from './inventory.js';
import { moveEntity, fluidIn, raycast, touchesBlock } from './physics.js';
import { canPlantOn } from './world.js';
import { PrimedTNT } from './entities.js';
import { HEIGHT } from './worldgen.js';

const GRAVITY = 32;
const WALK = 4.317;
const SPRINT = 5.612;
const SNEAK = 1.31;
const FLY = 10.9;

export class Player {
  constructor(game) {
    this.game = game;
    this.inventory = new Inventory();
    this.w = 0.6;
    this.h = 1.8;
    this.stepHeight = 0.6;
    this.mode = 'survival';
    this.reset();
  }

  reset() {
    this.x = 0; this.y = 80; this.z = 0;
    this.vx = 0; this.vy = 0; this.vz = 0;
    this.yaw = 0;
    this.pitch = 0;
    this.onGround = false;
    this.health = 20;
    this.food = 20;
    this.saturation = 5;
    this.exhaustion = 0;
    this.air = 15;
    this.fallDistance = 0;
    this.flying = false;
    this.sneaking = false;
    this.sprinting = false;
    this.seated = null;
    this.dead = false;
    this.invuln = 0;
    this.hurtFlash = 0;
    this.shake = 0;
    this.mining = null;
    this.eating = 0;
    this.useCooldown = 0;
    this.attackCooldown = 0;
    this.creativeBreakCooldown = 0;
    this.regenTimer = 0;
    this.starveTimer = 0;
    this.drownTimer = 0;
    this.lavaTimer = 0;
    this.cactusTimer = 0;
    this.walkDist = 0;
    this.stepDist = 0;
    this.swing = 0;
    this.headInWater = false;
    this.headInLava = false;
    this.inWater = false;
    this.inLava = false;
    this.spawn = null;
    this.target = null;
    this.targetMob = null;
  }

  get eyeHeight() {
    if (this.seated) return 1.1;
    return this.sneaking && !this.flying ? 1.27 : 1.62;
  }

  get held() {
    return this.inventory.held;
  }

  distTo(p) {
    return Math.hypot(this.x - p.x, this.y - p.y, this.z - p.z);
  }

  lookDir() {
    const cp = Math.cos(this.pitch);
    return [-Math.sin(this.yaw) * cp, Math.sin(this.pitch), -Math.cos(this.yaw) * cp];
  }

  serialize() {
    return {
      x: this.x, y: this.y, z: this.z, yaw: this.yaw, pitch: this.pitch,
      health: this.health, food: this.food, saturation: this.saturation, air: this.air,
      flying: this.flying, spawn: this.spawn, inventory: this.inventory.serialize(),
    };
  }

  load(d) {
    Object.assign(this, {
      x: d.x, y: d.y, z: d.z, yaw: d.yaw ?? 0, pitch: d.pitch ?? 0, health: d.health ?? 20, food: d.food ?? 20,
      saturation: d.saturation ?? 5, air: d.air ?? 15, flying: !!d.flying && this.mode === 'creative', spawn: d.spawn ?? null,
    });
    this.inventory.load(d.inventory);
  }

  // --- Frame update ------------------------------------------------------------------

  update(dt, input, active) {
    if (this.dead) return;
    this.invuln -= dt;
    this.hurtFlash = Math.max(0, this.hurtFlash - dt * 2.5);
    this.shake = Math.max(0, this.shake - dt * 2);
    this.useCooldown -= dt;
    this.attackCooldown -= dt;
    this.creativeBreakCooldown -= dt;
    this.swing = Math.max(0, this.swing - dt * 3.5);
    if (active) this.look(input);
    this.move(dt, input, active);
    this.vitals(dt);
    this.updateTarget();
    if (active) this.act(dt, input);
    else {
      this.mining = null;
      this.eating = 0;
    }
  }

  look(input) {
    const s = this.game.settings.sensitivity * 0.0022;
    this.yaw -= input.dx * s;
    this.pitch -= input.dy * s * (this.game.settings.invertY ? -1 : 1);
    this.pitch = Math.max(-Math.PI / 2 + 0.001, Math.min(Math.PI / 2 - 0.001, this.pitch));
  }

  move(dt, input, active) {
    const world = this.game.world;
    const key = (k) => active && input.isDown(k);
    if (this.seated) {
      const [sx, sy, sz] = this.seated;
      if (key('KeyC') || !BLOCKS[world.getBlock(sx, sy, sz)].interact) {
        this.seated = null;
        this.y = sy + 0.3;
      } else {
        this.x = sx + 0.5; this.y = sy + 0.2; this.z = sz + 0.5;
        this.vx = this.vy = this.vz = 0;
        this.onGround = true;
        return;
      }
    }
    let fwd = 0, strafe = 0;
    if (key('KeyW')) fwd += 1;
    if (key('KeyS')) fwd -= 1;
    if (key('KeyA')) strafe -= 1;
    if (key('KeyD')) strafe += 1;
    const creative = this.mode === 'creative';
    if (creative && active && input.doubleSpace) {
      this.flying = !this.flying;
      this.vy = 0;
    }
    if (!creative) this.flying = false;
    // Shift sprints (or flies faster); C sneaks, flies down and stands up from a cushion.
    const sprintKey = key('ShiftLeft') || key('ShiftRight');
    this.sneaking = !this.flying && key('KeyC');
    if (fwd > 0 && (sprintKey || input.doubleW) && !this.sneaking && (this.food > 6 || creative)) this.sprinting = true;
    if (fwd <= 0 || this.sneaking || (this.collidedH && !this.flying) || (this.food <= 6 && !creative)) this.sprinting = false;

    const hw = this.w / 2;
    const fluid = fluidIn(world, this.x - hw + 0.01, this.y + 0.05, this.z - hw + 0.01, this.x + hw - 0.01, this.y + 1.2, this.z + hw - 0.01);
    this.inWater = fluid === 1;
    this.inLava = fluid === 2;
    const headId = world.getBlock(Math.floor(this.x), Math.floor(this.y + this.eyeHeight), Math.floor(this.z));
    this.headInWater = FLUID[headId] === 1;
    this.headInLava = FLUID[headId] === 2;

    let speed = this.flying ? (this.sprinting ? FLY * 2 : FLY) : this.sneaking ? SNEAK : this.sprinting ? SPRINT : WALK;
    if (this.inWater && !this.flying) speed = this.sprinting ? 3.2 : 2.2;
    if (this.inLava && !this.flying) speed = 1.2;
    if (this.eating > 0) speed *= 0.35;
    const len = Math.hypot(fwd, strafe) || 1;
    const sin = Math.sin(this.yaw), cos = Math.cos(this.yaw);
    const wx = ((-sin * fwd + cos * strafe) / len) * speed;
    const wz = ((-cos * fwd - sin * strafe) / len) * speed;
    const below = world.getBlock(Math.floor(this.x), Math.floor(this.y - 0.1), Math.floor(this.z));
    const slippery = BLOCKS[below].slippery;
    const accel = this.flying ? 6 : this.onGround ? (slippery ? 1.5 : 14) : this.inWater ? 6 : 2.8;
    const k = 1 - Math.exp(-accel * dt);
    this.vx += (wx - this.vx) * k;
    this.vz += (wz - this.vz) * k;

    if (this.flying) {
      let vyWant = 0;
      if (key('Space')) vyWant += speed * 0.75;
      if (key('KeyC')) vyWant -= speed * 0.75;
      this.vy += (vyWant - this.vy) * (1 - Math.exp(-8 * dt));
      this.sneaking = false;
    } else if (this.inWater || this.inLava) {
      this.vy -= (this.inLava ? 4 : 6) * dt;
      if (key('Space')) this.vy = Math.min(this.vy + 22 * dt, this.inLava ? 1.5 : 3.2);
      this.vy = Math.max(this.vy, -2.5);
      this.vy *= Math.pow(0.4, dt);
      if (key('Space') && this.collidedH) this.vy = 5.5;
      this.fallDistance = 0;
    } else {
      this.vy -= GRAVITY * dt;
      this.vy = Math.max(this.vy, -78);
      if (key('Space') && this.onGround) {
        this.vy = 9.0;
        this.exhaustion += this.sprinting ? 0.2 : 0.05;
        if (this.sprinting) {
          this.vx += -sin * 2;
          this.vz += -cos * 2;
        }
      }
    }

    const wasGround = this.onGround;
    const y0 = this.y;
    const ox = this.x, oz = this.z;
    const steps = Math.ceil(Math.max(Math.abs(this.vx), Math.abs(this.vy), Math.abs(this.vz)) * dt / 0.45) || 1;
    for (let i = 0; i < steps; i++) moveEntity(world, this, dt / steps);
    const dyMoved = this.y - y0;
    const moved = Math.hypot(this.x - ox, this.z - oz);
    if (this.onGround && !this.flying) {
      this.walkDist += moved;
      this.stepDist += moved;
      if (this.stepDist > 2.2) {
        this.stepDist = 0;
        const bid = world.getBlock(Math.floor(this.x), Math.floor(this.y - 0.2), Math.floor(this.z));
        if (bid) this.game.audio.block(BLOCKS[bid].sound, 'step');
      }
    }
    if (this.sprinting) this.exhaustion += moved * 0.1;
    else if (this.inWater) this.exhaustion += moved * 0.01;

    // Fall damage.
    if (this.flying || this.inWater || this.inLava) this.fallDistance = 0;
    else if (dyMoved < 0 && !this.onGround) this.fallDistance -= dyMoved;
    if (this.onGround && !wasGround) {
      if (this.fallDistance > 3.5 && this.mode === 'survival') {
        const bid = world.getBlock(Math.floor(this.x), Math.floor(this.y - 0.2), Math.floor(this.z));
        const soft = bid === B.straw_bed || BLOCKS[bid].shape === 'cushion' ? 0.5 : 1;
        this.damage(Math.ceil((this.fallDistance - 3) * soft), { cause: 'fall' });
        this.game.audio.block('stone', 'step');
      }
      this.fallDistance = 0;
    }
    if (this.onGround && this.flying && this.mode === 'creative' && dyMoved === 0 && this.vy < 0) this.flying = false;
    if (this.y < -20) this.damage(4, { cause: 'void' });
  }

  vitals(dt) {
    const world = this.game.world;
    const survival = this.mode === 'survival';
    // Air.
    if (this.headInWater && survival) {
      this.air -= dt;
      if (this.air <= 0) {
        this.air = 0;
        this.drownTimer -= dt;
        if (this.drownTimer <= 0) {
          this.drownTimer = 1;
          this.damage(2, { cause: 'drown' });
        }
      }
    } else {
      this.air = Math.min(15, this.air + dt * 5);
    }
    if (this.inLava) {
      this.lavaTimer -= dt;
      if (this.lavaTimer <= 0) {
        this.lavaTimer = 0.5;
        this.damage(4, { cause: 'lava' });
      }
    }
    if (touchesBlock(world, this, (id) => BLOCKS[id].hurts)) {
      this.cactusTimer -= dt;
      if (this.cactusTimer <= 0) {
        this.cactusTimer = 0.5;
        this.damage(1, { cause: 'cactus' });
      }
    }
    if (!survival) {
      this.health = 20;
      this.food = 20;
      return;
    }
    // Hunger.
    while (this.exhaustion >= 4) {
      this.exhaustion -= 4;
      if (this.saturation > 0) this.saturation = Math.max(0, this.saturation - 1);
      else this.food = Math.max(0, this.food - 1);
    }
    this.regenTimer -= dt;
    if (this.food >= 18 && this.health < 20) {
      const fast = this.food >= 20 && this.saturation > 0;
      if (this.regenTimer <= 0) {
        this.regenTimer = fast ? 0.5 : 4;
        this.health = Math.min(20, this.health + 1);
        this.exhaustion += fast ? 1.5 : 6;
      }
    } else if (this.food === 0) {
      this.starveTimer -= dt;
      if (this.starveTimer <= 0) {
        this.starveTimer = 4;
        if (this.health > 1) this.damage(1, { cause: 'starve' });
      }
    } else if (this.regenTimer < 0) {
      this.regenTimer = 0;
    }
  }

  damage(amount, src = {}) {
    if (this.dead || this.mode === 'creative' || amount <= 0) return;
    if (this.invuln > 0 && src.cause !== 'drown' && src.cause !== 'starve') return;
    this.health -= amount;
    this.invuln = 0.5;
    this.hurtFlash = 1;
    this.exhaustion += 0.1;
    this.shake = Math.max(this.shake, 0.4);
    this.game.audio.hurt();
    if (src.x !== undefined) {
      const dx = this.x - src.x, dz = this.z - src.z;
      const d = Math.hypot(dx, dz) || 1;
      this.vx += (dx / d) * 6;
      this.vz += (dz / d) * 6;
      this.vy = Math.max(this.vy, 4.5);
    }
    if (this.seated) this.seated = null;
    if (this.health <= 0) this.die(src.cause);
  }

  die(cause) {
    this.health = 0;
    this.dead = true;
    this.deathCause = cause;
    this.mining = null;
    if (!this.game.settings.keepInventory) {
      for (let i = 0; i < this.inventory.slots.length; i++) {
        const s = this.inventory.slots[i];
        if (s) this.game.entities.dropItem(this.x, this.y + 1, this.z, s, [(Math.random() - 0.5) * 6, 3 + Math.random() * 3, (Math.random() - 0.5) * 6]);
      }
      this.inventory.clear();
    }
    this.game.onPlayerDeath(cause);
  }

  respawn() {
    const s = this.spawn ?? this.game.worldSpawn;
    const keep = this.inventory;
    const mode = this.mode;
    const spawn = this.spawn;
    this.reset();
    this.inventory = keep;
    this.mode = mode;
    this.spawn = spawn;
    this.x = s.x; this.y = s.y; this.z = s.z;
  }

  // --- Targeting -----------------------------------------------------------------------

  updateTarget() {
    const world = this.game.world;
    const [dx, dy, dz] = this.lookDir();
    const ex = this.x, ey = this.y + this.eyeHeight, ez = this.z;
    const reach = this.mode === 'creative' ? 5.5 : 4.6;
    this.target = raycast(world, ex, ey, ez, dx, dy, dz, reach);
    this.targetMob = null;
    let best = this.target ? this.target.t : reach;
    for (const m of this.game.entities.mobs) {
      const hw = m.w / 2;
      const t = rayAabb(ex, ey, ez, dx, dy, dz, m.x - hw, m.y, m.z - hw, m.x + hw, m.y + m.h, m.z + hw);
      if (t !== null && t < best && t < 3.6) {
        best = t;
        this.targetMob = m;
      }
    }
    if (this.targetMob) this.target = null;
  }

  // --- Actions ---------------------------------------------------------------------------

  act(dt, input) {
    const game = this.game;
    // Hotbar.
    for (let i = 0; i < 9; i++) if (input.wasPressed(`Digit${i + 1}`)) this.inventory.selected = i;
    if (input.wheel) this.inventory.selected = (this.inventory.selected + input.wheel + 9) % 9;
    if (input.wasPressed('KeyQ') && this.held) {
      const all = input.isDown('ShiftLeft') || input.isDown('ShiftRight');
      const h = this.held;
      const n = all ? h.count : 1;
      const [dx, dy, dz] = this.lookDir();
      game.entities.dropItem(this.x, this.y + this.eyeHeight - 0.3, this.z, { ...h, count: n }, [dx * 6, dy * 6 + 1.5, dz * 6]).pickupDelay = 1.5;
      this.inventory.consumeHeld(n);
    }

    // Left: attack or mine.
    if (input.clicked[0]) this.swing = 1;
    if (this.targetMob && input.clicked[0] && this.attackCooldown <= 0) {
      this.attackCooldown = 0.3;
      const dmg = attackDamage(this.held) * (this.vy < -1 && !this.onGround ? 1.5 : 1);
      if (this.targetMob.damage(dmg, this.x, this.z, this.sprinting ? 1.6 : 1)) {
        this.exhaustion += 0.1;
        if (toolOf(this.held)) this.inventory.damageHeld(toolOf(this.held).type === 'sword' ? 1 : 2);
      }
      this.mining = null;
    } else if (input.mouse[0] && this.target) {
      this.mine(dt);
    } else {
      this.mining = null;
    }

    // Right: use.
    if (input.mouse[2]) {
      const food = ITEMS[this.held?.id]?.food;
      if (food && (this.food < 20 || this.mode === 'creative') && !(this.target && this.canInteract(this.target) && !this.sneaking)) {
        this.eat(dt, food);
      } else {
        this.eating = 0;
        if (input.clicked[2] || this.useCooldown <= 0) {
          if (this.use()) this.swing = 1;
          this.useCooldown = 0.22;
        }
      }
    } else {
      this.eating = 0;
    }

    if (input.clicked[1]) this.pickBlock();
  }

  canInteract(t) {
    const b = t.block;
    if (!b.interact) return false;
    if (b.interact === 'tnt') return ITEMS[this.held?.id]?.igniter;
    if (b.interact === 'campfire') return !!SMELTING[this.held?.id] && !!ITEMS[this.held.id].food;
    return true;
  }

  mine(dt) {
    const game = this.game;
    const t = this.target;
    const b = t.block;
    if (this.mode === 'creative') {
      if (this.creativeBreakCooldown <= 0) {
        this.creativeBreakCooldown = 0.25;
        this.breakTarget(false);
      }
      return;
    }
    const key = `${t.x},${t.y},${t.z}`;
    if (!this.mining || this.mining.key !== key) this.mining = { key, progress: 0, hitTimer: 0 };
    const time = breakTime(b, toolOf(this.held));
    if (!isFinite(time)) return;
    this.mining.progress += dt / Math.max(0.05, time);
    this.mining.hitTimer -= dt;
    this.swing = Math.max(this.swing, 0.6);
    if (this.mining.hitTimer <= 0) {
      this.mining.hitTimer = 0.25;
      game.audio.block(b.sound, 'hit');
      const layer = b.tex ? game.bank.layers.get(b.tex.side) : 0;
      const c = game.bank.avg[layer] ?? [1, 1, 1];
      game.particles.burst(t.x, t.y, t.z, c, 3, this.lightAt(t.x, t.y + 1, t.z));
    }
    if (this.mining.progress >= 1) {
      this.mining = null;
      this.breakTarget(true);
    }
  }

  lightAt(x, y, z) {
    const { sky, block } = this.game.world.getLight(x, y, z);
    return Math.max(Math.pow(0.8, 15 - sky) * this.game.sky.daylight, Math.pow(0.8, 15 - block), 0.15);
  }

  breakTarget(survival) {
    const game = this.game;
    const world = game.world;
    const { x, y, z, block: b } = this.target;
    world.ensureLoot(x, y, z);
    const below = world.getBlock(x, y - 1, z);
    let replacement = 0;
    if (b.id === B.ice && survival && below !== 0) replacement = B.water;
    world.setBlock(x, y, z, replacement);
    const layer = b.tex ? game.bank.layers.get(b.tex.side) : 0;
    game.particles.burst(x, y, z, game.bank.avg[layer] ?? [1, 1, 1], 26, this.lightAt(x, y + 1, z));
    game.audio.block(b.sound, 'break', { x, y, z }, this);
    if (survival) {
      game.entities.dropBlockItems(x, y, z, b.id, toolOf(this.held));
      this.exhaustion += 0.005;
      if (b.hardness > 0 && toolOf(this.held)) {
        if (this.inventory.damageHeld(toolOf(this.held).type === 'sword' ? 2 : 1)) game.audio.block('glass', 'break');
      }
    }
  }

  eat(dt, food) {
    this.eating += dt;
    if (Math.floor(this.eating * 5) !== Math.floor((this.eating - dt) * 5)) {
      this.game.audio.eat();
      this.swing = 0.4;
    }
    if (this.eating >= 1.6) {
      this.eating = 0;
      this.food = Math.min(20, this.food + food.hunger);
      this.saturation = Math.min(this.food, this.saturation + food.saturation);
      const leftover = food.leaves;
      this.inventory.consumeHeld(1);
      if (leftover) {
        if (!this.held) this.inventory.held = { id: leftover, count: 1 };
        else {
          const left = this.inventory.add({ id: leftover, count: 1 });
          if (left) this.game.entities.dropItem(this.x, this.y + 1, this.z, left);
        }
      }
      this.game.audio.burp();
    }
  }

  // Right click on the world. Returns true if something happened (to swing the arm).
  use() {
    const game = this.game;
    const world = game.world;
    const held = this.held;
    const item = held ? ITEMS[held.id] : null;
    const t = this.target;

    if (t && !this.sneaking && this.canInteract(t)) {
      return this.interact(t);
    }
    if (item?.map) {
      game.ui.openMap(held);
      return true;
    }
    if (!t || !item || item.block === undefined) return false;

    // Where the block goes: into the target if it is replaceable, else next to it.
    let px = t.x + t.nx, py = t.y + t.ny, pz = t.z + t.nz;
    if (BLOCKS[t.id].replaceable && !FLUID[t.id]) { px = t.x; py = t.y; pz = t.z; }
    if (py < 0 || py >= HEIGHT) return false;
    const cur = world.getBlock(px, py, pz);
    if (!(cur === 0 || BLOCKS[cur].replaceable)) return false;
    let id = item.block;
    const b = BLOCKS[id];
    const [lx, , lz] = this.lookDir();
    const lookFacing = Math.abs(lx) > Math.abs(lz) ? (lx > 0 ? 3 : 1) : (lz > 0 ? 0 : 2);
    const toward = (lookFacing + 2) % 4;
    if (b.variants === 'axis') id += t.nx !== 0 ? 1 : t.nz !== 0 ? 2 : 0;
    else if (b.variants === 'facing') {
      if (b.shape === 'stairs') id += lookFacing;
      else if (b.shelf) {
        if (t.ny !== 0 || !t.block.name.endsWith('_log')) return false;
        id += FACING_DIR.findIndex(([fx, fz]) => fx === t.nx && fz === t.nz);
      } else id += toward;
    }
    const below = world.getBlock(px, py - 1, pz);
    if (b.plant && !canPlantOn(id, below)) return false;
    if (id === B.cactus && below !== B.sand && below !== B.cactus) return false;
    if (id === B.torch && !SOLID[below] && ![[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dz]) => OPAQUE[world.getBlock(px + dx, py, pz + dz)])) return false;
    if (SOLID[id] && this.blocksEntity(px, py, pz)) return false;
    world.setBlock(px, py, pz, id);
    game.audio.block(b.sound, 'place', { x: px, y: py, z: pz }, this);
    if (this.mode === 'survival') this.inventory.consumeHeld(1);
    return true;
  }

  blocksEntity(x, y, z) {
    const boxes = [this, ...this.game.entities.mobs];
    for (const e of boxes) {
      const hw = e.w / 2;
      if (e.x + hw > x + 0.001 && e.x - hw < x + 0.999 && e.z + hw > z + 0.001 && e.z - hw < z + 0.999 && e.y + e.h > y + 0.001 && e.y < y + 0.999) return true;
    }
    return false;
  }

  interact(t) {
    const game = this.game;
    const world = game.world;
    const b = t.block;
    switch (b.interact) {
      case 'crafting':
        game.ui.open('crafting');
        return true;
      case 'furnace':
        game.ui.open('furnace', world.getTile(t.x, t.y, t.z), [t.x, t.y, t.z]);
        return true;
      case 'chest':
        game.ui.open('chest', world.getTile(t.x, t.y, t.z), [t.x, t.y, t.z]);
        return true;
      case 'tnt':
        world.setBlock(t.x, t.y, t.z, 0);
        game.entities.add(new PrimedTNT(game, t.x, t.y, t.z));
        if (this.mode === 'survival') this.inventory.damageHeld(1);
        return true;
      case 'campfire': {
        const tile = world.getTile(t.x, t.y, t.z);
        const free = tile.slots.findIndex((s) => !s);
        if (free < 0) return false;
        tile.slots[free] = { id: this.held.id, count: 1 };
        tile.cook[free] = 0;
        if (this.mode === 'survival') this.inventory.consumeHeld(1);
        game.ui.toast('Cooking on the campfire…');
        return true;
      }
      case 'sit':
        this.seated = [t.x, t.y, t.z];
        this.vx = this.vy = this.vz = 0;
        game.ui.toast('Press C to stand up');
        return true;
      case 'bed':
        game.trySleep(t.x, t.y, t.z);
        return true;
      default:
        return false;
    }
  }

  pickBlock() {
    if (this.mode !== 'creative' || !this.target) return;
    const name = BLOCKS[this.target.block.baseId].item ?? this.target.block.drop;
    if (!name || !ITEMS[name]) return;
    const inv = this.inventory;
    const found = inv.slots.findIndex((s, i) => i < 9 && s?.id === name);
    if (found >= 0) inv.selected = found;
    else inv.held = { id: name, count: ITEMS[name].maxStack };
  }

  // Shape boxes of the targeted block, for the selection outline.
  get targetBoxes() {
    return this.target?.boxes ?? null;
  }
}

function rayAabb(ox, oy, oz, dx, dy, dz, x0, y0, z0, x1, y1, z1) {
  let tmin = 0, tmax = Infinity;
  const o = [ox, oy, oz], d = [dx, dy, dz], lo = [x0, y0, z0], hi = [x1, y1, z1];
  for (let k = 0; k < 3; k++) {
    if (Math.abs(d[k]) < 1e-9) {
      if (o[k] < lo[k] || o[k] > hi[k]) return null;
      continue;
    }
    let t1 = (lo[k] - o[k]) / d[k];
    let t2 = (hi[k] - o[k]) / d[k];
    if (t1 > t2) [t1, t2] = [t2, t1];
    tmin = Math.max(tmin, t1);
    tmax = Math.min(tmax, t2);
    if (tmin > tmax) return null;
  }
  return tmin;
}

