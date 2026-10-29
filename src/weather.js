// Rain and snow. Whether it's raining follows from the world's seed and time, so every
// player in a multiplayer game sees the same weather (the host's clock is shared) and
// sleeping through the night moves the weather on too. Drops fall around the camera and
// stop at the first solid block, so roofs and trees keep you dry.
import * as THREE from './three.js';
import { hash3 } from './noise.js';

const DROPS = 700;
const RADIUS = 14;
const PERIOD = 9000; // ticks: the weather can change every ~7.5 minutes
const RAIN_CHANCE = 0.3;

export class Weather {
  constructor(game) {
    this.game = game;
    this.level = 0; // 0 clear .. 1 full rain
    this.drops = Array.from({ length: DROPS }, () => ({ x: 0, y: -999, z: 0, phase: Math.random() * 10 }));
    this.tops = new Map();
    this.topsTimer = 0;
    const g = new THREE.BufferGeometry();
    this.pos = new Float32Array(DROPS * 4 * 3);
    g.setAttribute('position', new THREE.BufferAttribute(this.pos, 3));
    const idx = new Uint16Array(DROPS * 6);
    for (let i = 0; i < DROPS; i++) idx.set([i * 4, i * 4 + 1, i * 4 + 2, i * 4, i * 4 + 2, i * 4 + 3], i * 6);
    g.setIndex(new THREE.BufferAttribute(idx, 1));
    this.material = new THREE.MeshBasicMaterial({ color: 0xa8bedf, transparent: true, opacity: 0, depthWrite: false, side: THREE.DoubleSide });
    this.mesh = new THREE.Mesh(g, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 5;
    game.scene.add(this.mesh);
  }

  // 1 while this stretch of time is a rainy one.
  target(world) {
    const ticks = world.day * 24000 + world.time;
    return hash3(Math.floor(ticks / PERIOD), 77, 13, world.seed) < RAIN_CHANCE ? 1 : 0;
  }

  // Height of the first solid block in a column (cached for a second).
  top(x, z) {
    const key = x * 100003 + z;
    let y = this.tops.get(key);
    if (y === undefined) {
      y = this.game.world.surfaceY(x, z);
      this.tops.set(key, y);
    }
    return y;
  }

  // Snow where it's cold (snowy biomes and high mountains).
  snowy(x, y, z) {
    const col = this.game.world.gen.column(Math.floor(x), Math.floor(z));
    return col.temp < -0.4 || y > 100;
  }

  update(dt, camera) {
    const world = this.game.world;
    if (!world) return;
    const want = this.target(world);
    this.level += Math.sign(want - this.level) * Math.min(Math.abs(want - this.level), dt / 15);
    this.topsTimer -= dt;
    if (this.topsTimer <= 0) {
      this.topsTimer = 1;
      this.tops.clear();
    }
    const cam = camera.position;
    const snow = this.snowy(cam.x, cam.y, cam.z);
    const on = this.level > 0.01 && this.game.state !== 'menu';
    this.mesh.visible = on;
    this.material.opacity = (snow ? 0.85 : 0.4) * Math.min(1, this.level * 1.5) * (0.35 + 0.65 * this.game.sky.daylight);
    this.material.color.set(snow ? 0xffffff : 0xa8bedf);
    const showDrops = Math.floor(DROPS * this.level);
    // Quads stand upright, square to the way the player faces.
    const yaw = this.game.player.yaw;
    const rx = Math.cos(yaw), rz = -Math.sin(yaw);
    const halfW = snow ? 0.05 : 0.02;
    const len = snow ? 0.1 : 0.55;
    const speed = snow ? 1.6 : 13;
    let o = 0;
    for (let i = 0; i < DROPS; i++) {
      const d = this.drops[i];
      if (i >= showDrops || !on) {
        this.pos.fill(0, o, o + 12);
        o += 12;
        continue;
      }
      d.y -= speed * dt;
      d.phase += dt;
      const groundY = this.top(Math.floor(d.x), Math.floor(d.z)) + 1;
      const far = Math.hypot(d.x - cam.x, d.z - cam.z) > RADIUS;
      if (d.y < groundY || d.y < cam.y - 10 || far) {
        // Start again somewhere above the camera.
        const a = Math.random() * Math.PI * 2;
        const r = Math.sqrt(Math.random()) * RADIUS;
        d.x = cam.x + Math.cos(a) * r;
        d.z = cam.z + Math.sin(a) * r;
        d.y = Math.max(cam.y + 2 + Math.random() * 12, this.top(Math.floor(d.x), Math.floor(d.z)) + 1 + Math.random() * 10);
      }
      const sway = snow ? Math.sin(d.phase * 1.7) * 0.25 : 0;
      const x = d.x + sway, z = d.z + sway * 0.6;
      const set = (k, px, py, pz) => { this.pos[o + k * 3] = px; this.pos[o + k * 3 + 1] = py; this.pos[o + k * 3 + 2] = pz; };
      set(0, x - rx * halfW, d.y, z - rz * halfW);
      set(1, x + rx * halfW, d.y, z + rz * halfW);
      set(2, x + rx * halfW, d.y + len, z + rz * halfW);
      set(3, x - rx * halfW, d.y + len, z - rz * halfW);
      o += 12;
    }
    this.mesh.geometry.attributes.position.needsUpdate = true;
    // Rain sounds muffled indoors (a roof over the camera).
    const covered = this.top(Math.floor(cam.x), Math.floor(cam.z)) > cam.y + 0.5;
    this.game.audio.setRain(on && !snow ? this.level * (covered ? 0.35 : 1) : 0, covered);
  }

  dispose() {
    this.game.scene.remove(this.mesh);
  }
}
