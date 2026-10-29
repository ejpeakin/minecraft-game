// Chunk mesher. Copies a chunk and its eight neighbors into a padded 48x130x48 volume,
// flood-fills sky and block light through it, then emits faces for the middle chunk
// with smooth lighting and ambient occlusion. Output is plain typed arrays so this
// could move to a worker; the renderer turns them into BufferGeometry.
import {
  BLOCKS, OPAQUE, EMIT, FILTER, SHAPES, PASSES, FLUID, CULL_SELF, FACE_TEX, FACE_ROT, SHAPE, PASS, B, shapeBoxes,
} from './blocks.js';
import { CHUNK, HEIGHT } from './worldgen.js';
import { chunkKey } from './world.js';

const PW = CHUNK * 3; // 48
const PH = HEIGHT + 2; // y = -1 .. HEIGHT
const SX = 1;
const SZ = PW;
const SY = PW * PW;
const VOL = PW * PW * PH;

const pad = new Uint16Array(VOL);
const sky = new Uint8Array(VOL);
const blk = new Uint8Array(VOL);
const top = new Int16Array(PW * PW);
const QSIZE = 1 << 20;
const QMASK = QSIZE - 1;
const queue = new Int32Array(QSIZE);

// Face tables (see blocks.js FACES order). Corner positions are CCW seen from outside.
const FACE_N = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
const CORNERS = [
  [[1, 0, 1], [1, 0, 0], [1, 1, 0], [1, 1, 1]],
  [[0, 0, 0], [0, 0, 1], [0, 1, 1], [0, 1, 0]],
  [[0, 1, 1], [1, 1, 1], [1, 1, 0], [0, 1, 0]],
  [[0, 0, 0], [1, 0, 0], [1, 0, 1], [0, 0, 1]],
  [[0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1]],
  [[1, 0, 0], [0, 0, 0], [0, 1, 0], [1, 1, 0]],
];
const FACE_SHADE = [0.8, 0.8, 1, 0.55, 0.65, 0.65];
const AO_CURVE = [0.42, 0.62, 0.82, 1];
const STRIDE = [SX, SY, SZ]; // per axis 0=x, 1=y, 2=z
const DELTA = FACE_N.map(([x, y, z]) => x * SX + y * SY + z * SZ);

// Per face/corner: index deltas (relative to the cell in front of the face) for
// side1, side2 and the diagonal corner used by AO and smooth lighting.
const AO_OFF = CORNERS.map((corners, f) => {
  const n = FACE_N[f];
  const axes = [0, 1, 2].filter((a) => n[a] === 0);
  return corners.map((c) => {
    const s1 = (c[axes[0]] * 2 - 1) * STRIDE[axes[0]];
    const s2 = (c[axes[1]] * 2 - 1) * STRIDE[axes[1]];
    return [s1, s2, s1 + s2];
  });
});

// Texture coordinates from a point on a face, in block-local units.
function faceUV(f, x, y, z) {
  switch (f) {
    case 0: return [1 - z, y];
    case 1: return [z, y];
    case 2: return [x, 1 - z];
    case 3: return [x, z];
    case 4: return [x, y];
    default: return [1 - x, y];
  }
}

// Biome colors for grass and oak leaves, from the column's temperature and humidity:
// multipliers on the textures' own green, blended between four corners (cold/hot,
// dry/wet) with a warm autumn cast in the Dappled Forest. Stored /2 in bytes.
const TINTED = new Uint8Array(BLOCKS.length);
for (const name of ['grass', 'tall_grass', 'oak_leaves']) TINTED[B[name]] = 1;
const TINT_CORNERS = [[0.84, 0.93, 1.12], [0.78, 0.94, 1.02], [1.3, 1.04, 0.72], [0.84, 1.08, 0.78]];
const smooth = (a, b, x) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};
function biomeTint(col, out, o) {
  const t = Math.min(1, Math.max(0, (col.temp + 0.45) / 0.9));
  const h = Math.min(1, Math.max(0, (col.hum + 0.35) / 0.7));
  const autumn = smooth(0.17, 0.07, col.temp) * smooth(-0.25, -0.15, col.temp) * smooth(-0.3, -0.2, col.hum);
  for (let k = 0; k < 3; k++) {
    const [c00, c01, c10, c11] = TINT_CORNERS.map((c) => c[k]);
    let v = (c00 * (1 - h) + c01 * h) * (1 - t) + (c10 * (1 - h) + c11 * h) * t;
    v += ([1.18, 1.0, 0.7][k] - v) * autumn * 0.65;
    out[o + k] = Math.round(Math.min(2, v) * 127.5);
  }
}
const colTint = new Uint8Array(18 * 18 * 3);
const cornerTint = new Uint8Array(17 * 17 * 3);
let tintOn = false;

function computeTints(world, cx, cz) {
  for (let z = 0; z < 18; z++) for (let x = 0; x < 18; x++) {
    biomeTint(world.gen.column(cx * CHUNK + x - 1, cz * CHUNK + z - 1), colTint, (x + z * 18) * 3);
  }
  // Each block corner averages the four columns around it, so colors blend smoothly.
  for (let z = 0; z <= 16; z++) for (let x = 0; x <= 16; x++) {
    for (let k = 0; k < 3; k++) {
      const a = colTint[(x + z * 18) * 3 + k], b = colTint[(x + 1 + z * 18) * 3 + k];
      const c = colTint[(x + (z + 1) * 18) * 3 + k], d = colTint[(x + 1 + (z + 1) * 18) * 3 + k];
      cornerTint[(x + z * 17) * 3 + k] = (a + b + c + d + 2) >> 2;
    }
  }
}

class Buffer {
  constructor() {
    this.pos = new Float32Array(1 << 16);
    this.tex = new Float32Array(1 << 16);
    this.light = new Float32Array(1 << 16);
    this.tint = new Uint8Array(1 << 16);
    this.index = new Uint32Array(1 << 15);
    this.v = 0;
    this.i = 0;
  }
  reset() {
    this.v = 0;
    this.i = 0;
  }
  grow() {
    const g = (a) => {
      const n = new a.constructor(a.length * 2);
      n.set(a);
      return n;
    };
    this.pos = g(this.pos);
    this.tex = g(this.tex);
    this.light = g(this.light);
    this.tint = g(this.tint);
  }
  vert(x, y, z, u, v, layer, s, b, shade) {
    if ((this.v + 1) * 3 > this.pos.length) this.grow();
    const o = this.v * 3;
    this.pos[o] = x; this.pos[o + 1] = y; this.pos[o + 2] = z;
    this.tex[o] = u; this.tex[o + 1] = v; this.tex[o + 2] = layer;
    this.light[o] = s; this.light[o + 1] = b; this.light[o + 2] = shade;
    if (tintOn) {
      const c = (Math.min(16, Math.max(0, Math.round(x))) + Math.min(16, Math.max(0, Math.round(z))) * 17) * 3;
      this.tint[o] = cornerTint[c]; this.tint[o + 1] = cornerTint[c + 1]; this.tint[o + 2] = cornerTint[c + 2];
    } else {
      this.tint[o] = 128; this.tint[o + 1] = 128; this.tint[o + 2] = 128;
    }
    return this.v++;
  }
  quad(a, b, c, d, flip = false) {
    if (this.i + 6 > this.index.length) {
      const n = new Uint32Array(this.index.length * 2);
      n.set(this.index);
      this.index = n;
    }
    const ix = this.index;
    if (flip) {
      ix[this.i++] = b; ix[this.i++] = c; ix[this.i++] = d;
      ix[this.i++] = b; ix[this.i++] = d; ix[this.i++] = a;
    } else {
      ix[this.i++] = a; ix[this.i++] = b; ix[this.i++] = c;
      ix[this.i++] = a; ix[this.i++] = c; ix[this.i++] = d;
    }
  }
  output() {
    return {
      pos: this.pos.slice(0, this.v * 3),
      tex: this.tex.slice(0, this.v * 3),
      light: this.light.slice(0, this.v * 3),
      tint: this.tint.slice(0, this.v * 3),
      index: this.index.slice(0, this.i),
    };
  }
}

const solidBuf = new Buffer();
const waterBuf = new Buffer();

function fillPadded(world, cx, cz) {
  for (let dz = -1; dz <= 1; dz++) {
    for (let dx = -1; dx <= 1; dx++) {
      const chunk = world.chunks.get(chunkKey(cx + dx, cz + dz));
      const bx = (dx + 1) * CHUNK;
      const bz = (dz + 1) * CHUNK;
      for (let y = 0; y < HEIGHT; y++) {
        for (let lz = 0; lz < CHUNK; lz++) {
          const dst = bx + (bz + lz) * SZ + (y + 1) * SY;
          if (chunk) pad.set(chunk.blocks.subarray(lz * CHUNK + y * CHUNK * CHUNK, lz * CHUNK + y * CHUNK * CHUNK + CHUNK), dst);
          else pad.fill(0, dst, dst + CHUNK);
        }
      }
    }
  }
  pad.fill(B.bedrock, 0, SY);
  pad.fill(0, (PH - 1) * SY, VOL);
}

function propagate(arr, head, tail, useFilter) {
  while (head !== tail) {
    const i = queue[head];
    head = (head + 1) & QMASK;
    const l = arr[i];
    if (l <= 1) continue;
    const px = i % PW;
    const t = (i / PW) | 0;
    const pz = t % PW;
    const py = (t / PW) | 0;
    for (let n = 0; n < 6; n++) {
      if ((n === 0 && px === PW - 1) || (n === 1 && px === 0) || (n === 2 && py === PH - 1) || (n === 3 && py === 0) || (n === 4 && pz === PW - 1) || (n === 5 && pz === 0)) continue;
      const j = i + DELTA[n];
      const b = pad[j];
      if (OPAQUE[b]) continue;
      const nl = l - 1 - (useFilter ? FILTER[b] : 0);
      if (nl > arr[j]) {
        arr[j] = nl;
        queue[tail] = j;
        tail = (tail + 1) & QMASK;
      }
    }
  }
}

function computeLight() {
  // Sunlight straight down each column.
  for (let pz = 0; pz < PW; pz++) {
    for (let px = 0; px < PW; px++) {
      let l = 15;
      let t = -1;
      for (let py = PH - 1; py >= 0; py--) {
        const i = px + pz * SZ + py * SY;
        const b = pad[i];
        if (b !== 0 && t < 0) t = py;
        if (OPAQUE[b]) l = 0;
        else if (FILTER[b]) l = Math.max(0, l - FILTER[b]);
        sky[i] = l;
      }
      top[px + pz * PW] = t;
    }
  }
  // Spread sideways from the band where neighboring columns differ.
  let tail = 0;
  for (let pz = 0; pz < PW; pz++) {
    for (let px = 0; px < PW; px++) {
      let m = top[px + pz * PW];
      if (px > 0) m = Math.max(m, top[px - 1 + pz * PW]);
      if (px < PW - 1) m = Math.max(m, top[px + 1 + pz * PW]);
      if (pz > 0) m = Math.max(m, top[px + (pz - 1) * PW]);
      if (pz < PW - 1) m = Math.max(m, top[px + (pz + 1) * PW]);
      const yMax = Math.min(PH - 1, m + 1);
      for (let py = 0; py <= yMax; py++) {
        const i = px + pz * SZ + py * SY;
        if (sky[i] > 1) {
          queue[tail] = i;
          tail = (tail + 1) & QMASK;
        }
      }
    }
  }
  propagate(sky, 0, tail, true);
  // Block light from emitters.
  blk.fill(0);
  tail = 0;
  for (let i = SY; i < VOL - SY; i++) {
    const e = EMIT[pad[i]];
    if (e) {
      blk[i] = e;
      queue[tail] = i;
      tail = (tail + 1) & QMASK;
    }
  }
  propagate(blk, 0, tail, false);
}

function fluidHeight(i, kind) {
  const b = pad[i];
  if (FLUID[b] !== kind) return -1;
  if (FLUID[pad[i + SY]] === kind) return 1;
  const def = BLOCKS[b];
  if (def.source || def.fallingFluid) return 0.889;
  return (8 - def.fluidLevel) / 9;
}

function cornerHeight(i, kind, sx, sz) {
  let sum = 0;
  let n = 0;
  const cells = [i, i + sx, i + sz, i + sx + sz];
  for (const c of cells) {
    if (FLUID[pad[c + SY]] === kind) return 1;
    const h = fluidHeight(c, kind);
    if (h >= 0) {
      sum += h;
      n++;
    }
  }
  return n ? sum / n : 0.889;
}

export function meshChunk(world, cx, cz) {
  fillPadded(world, cx, cz);
  computeLight();
  computeTints(world, cx, cz);
  solidBuf.reset();
  waterBuf.reset();
  const lightOut = new Uint8Array(CHUNK * CHUNK * HEIGHT);
  const campfires = [];
  const getAt = (i) => (dx, dy, dz) => pad[i + dx * SX + dy * SY + dz * SZ];

  for (let py = 1; py <= HEIGHT; py++) {
    const y = py - 1;
    for (let lz = 0; lz < CHUNK; lz++) {
      for (let lx = 0; lx < CHUNK; lx++) {
        const i = lx + CHUNK + (lz + CHUNK) * SZ + py * SY;
        lightOut[lx + lz * CHUNK + y * CHUNK * CHUNK] = (sky[i] << 4) | blk[i];
        const id = pad[i];
        if (id === 0) continue;
        const shape = SHAPES[id];
        tintOn = TINTED[id] === 1;
        if (shape === SHAPE.CUBE) emitCube(id, i, lx, y, lz);
        else if (shape === SHAPE.CROSS) emitCross(id, i, lx, y, lz);
        else if (shape === SHAPE.LIQUID) emitLiquid(id, i, lx, y, lz);
        else if (shape !== SHAPE.NONE) {
          emitBoxes(id, i, lx, y, lz, shapeBoxes(id, getAt(i)));
          if (shape === SHAPE.CAMPFIRE) {
            emitFire(i, lx, y, lz);
            campfires.push([cx * CHUNK + lx, y, cz * CHUNK + lz]);
          }
        }
      }
    }
  }
  return { solid: solidBuf.output(), water: waterBuf.output(), light: lightOut, campfires };
}

function emitCube(id, i, x, y, z) {
  const buf = PASSES[id] === PASS.WATER ? waterBuf : solidBuf;
  const selfCull = CULL_SELF[id];
  for (let f = 0; f < 6; f++) {
    const n = i + DELTA[f];
    const nb = pad[n];
    if (OPAQUE[nb]) continue;
    if (selfCull && nb === id) continue;
    if (PASSES[id] === PASS.WATER && FLUID[nb] === 1 && f !== 2) continue;
    const layer = FACE_TEX[id * 6 + f];
    const rot = FACE_ROT[id * 6 + f];
    const corners = CORNERS[f];
    const offs = AO_OFF[f];
    const shade = FACE_SHADE[f];
    const sway = BLOCKS[id].leaves ? 4 : 0; // see VERT in renderer.js
    const v = [0, 0, 0, 0];
    const ao = [0, 0, 0, 0];
    for (let c = 0; c < 4; c++) {
      const [o1, o2, o3] = offs[c];
      const s1 = OPAQUE[pad[n + o1]];
      const s2 = OPAQUE[pad[n + o2]];
      const s3 = s1 && s2 ? 1 : OPAQUE[pad[n + o3]];
      ao[c] = s1 && s2 ? 0 : 3 - (s1 + s2 + s3);
      let ls = sky[n], lb = blk[n], cnt = 1;
      if (!s1) { ls += sky[n + o1]; lb += blk[n + o1]; cnt++; }
      if (!s2) { ls += sky[n + o2]; lb += blk[n + o2]; cnt++; }
      if (!s3) { ls += sky[n + o3]; lb += blk[n + o3]; cnt++; }
      const p = corners[c];
      let [u, vv] = faceUV(f, p[0], p[1], p[2]);
      if (rot) [u, vv] = [vv, 1 - u];
      v[c] = buf.vert(x + p[0], y + p[1], z + p[2], u, vv, layer, ls / cnt / 15, lb / cnt / 15, shade * AO_CURVE[ao[c]] + sway);
    }
    buf.quad(v[0], v[1], v[2], v[3], ao[0] + ao[2] < ao[1] + ao[3]);
  }
}

function emitBoxes(id, i, x, y, z, boxes) {
  const buf = PASSES[id] === PASS.WATER ? waterBuf : solidBuf;
  for (const [x0, y0, z0, x1, y1, z1] of boxes) {
    for (let f = 0; f < 6; f++) {
      const onEdge = (f === 0 && x1 >= 1) || (f === 1 && x0 <= 0) || (f === 2 && y1 >= 1) || (f === 3 && y0 <= 0) || (f === 4 && z1 >= 1) || (f === 5 && z0 <= 0);
      const n = i + DELTA[f];
      if (onEdge && OPAQUE[pad[n]]) continue;
      const li = onEdge ? n : i;
      const ls = sky[li] / 15;
      const lb = Math.max(blk[li], blk[i]) / 15;
      const layer = FACE_TEX[id * 6 + f];
      const rot = FACE_ROT[id * 6 + f];
      const shade = FACE_SHADE[f];
      const v = [];
      for (const c of CORNERS[f]) {
        const px = c[0] ? x1 : x0;
        const py = c[1] ? y1 : y0;
        const pz = c[2] ? z1 : z0;
        let [u, vv] = faceUV(f, px, py, pz);
        for (let k = 0; k < rot; k++) [u, vv] = [vv, 1 - u];
        v.push(buf.vert(x + px, y + py, z + pz, u, vv, layer, ls, lb, shade));
      }
      buf.quad(v[0], v[1], v[2], v[3]);
    }
  }
}

// sway: added to the shade of the top vertices so the vertex shader waves them.
function crossQuads(buf, layer, i, x, y, z, inset, height, shade, sway = 0) {
  const ls = sky[i] / 15;
  const lb = blk[i] / 15;
  const a = inset;
  const b = 1 - inset;
  const diag = [
    [[a, a], [b, b]],
    [[a, b], [b, a]],
  ];
  for (const [[ax, az], [bx, bz]] of diag) {
    const v0 = buf.vert(x + ax, y, z + az, 0, 0, layer, ls, lb, shade);
    const v1 = buf.vert(x + bx, y, z + bz, 1, 0, layer, ls, lb, shade);
    const v2 = buf.vert(x + bx, y + height, z + bz, 1, height, layer, ls, lb, shade + sway);
    const v3 = buf.vert(x + ax, y + height, z + az, 0, height, layer, ls, lb, shade + sway);
    buf.quad(v0, v1, v2, v3);
    buf.quad(v1, v0, v3, v2);
  }
}

function emitCross(id, i, x, y, z) {
  crossQuads(solidBuf, FACE_TEX[id * 6 + 4], i, x, y, z, 0.15, 1, 0.9, 2);
}

function emitFire(i, x, y, z) {
  crossQuads(solidBuf, fireLayer, i, x, y, z, 0.2, 0.95, 1.2);
}

let fireLayer = 0;
export function setFireLayer(layer) {
  fireLayer = layer;
}

function emitLiquid(id, i, x, y, z) {
  const kind = FLUID[id];
  const buf = kind === 1 ? waterBuf : solidBuf;
  const layer = FACE_TEX[id * 6 + 2];
  const coveredAbove = FLUID[pad[i + SY]] === kind;
  // Corner heights: (0,0), (1,0), (1,1), (0,1) in x/z.
  const h00 = coveredAbove ? 1 : cornerHeight(i, kind, -SX, -SZ);
  const h10 = coveredAbove ? 1 : cornerHeight(i, kind, SX, -SZ);
  const h11 = coveredAbove ? 1 : cornerHeight(i, kind, SX, SZ);
  const h01 = coveredAbove ? 1 : cornerHeight(i, kind, -SX, SZ);
  const heightAt = (cx, cz) => (cx ? (cz ? h11 : h10) : (cz ? h01 : h00));
  for (let f = 0; f < 6; f++) {
    const n = i + DELTA[f];
    const nb = pad[n];
    if (FLUID[nb] === kind) continue;
    if (OPAQUE[nb] && f !== 2) continue;
    if (f === 2 && coveredAbove) continue;
    if (kind === 1 && nb === B.ice) continue;
    const ls = sky[n] / 15;
    const lb = Math.max(blk[n], blk[i]) / 15;
    const shade = FACE_SHADE[f];
    const v = [];
    for (const c of CORNERS[f]) {
      const py = c[1] ? heightAt(c[0], c[2]) : 0;
      const [u, vv] = faceUV(f, c[0], py, c[2]);
      v.push(buf.vert(x + c[0], y + py, z + c[2], u, vv, layer, ls, lb, shade));
    }
    buf.quad(v[0], v[1], v[2], v[3]);
  }
}
