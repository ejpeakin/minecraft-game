// Axis-separated swept AABB collision against block shapes (the same clipping scheme
// Minecraft uses), step-up for slabs and stairs, sneaking edge protection, fluid
// checks, and a DDA voxel raycast that respects partial block shapes.
import { SOLID, SHAPES, SHAPE, FLUID, shapeBoxes, BLOCKS } from './blocks.js';

const EPS = 1e-7;

export function collisionBoxes(world, x0, y0, z0, x1, y1, z1, out = []) {
  out.length = 0;
  const ix0 = Math.floor(x0), ix1 = Math.floor(x1);
  const iy0 = Math.floor(y0) - 1, iy1 = Math.floor(y1);
  const iz0 = Math.floor(z0), iz1 = Math.floor(z1);
  for (let x = ix0; x <= ix1; x++) {
    for (let z = iz0; z <= iz1; z++) {
      if (!world.isLoaded(x, z)) {
        out.push([x, -64, z, x + 1, 512, z + 1]);
        continue;
      }
      for (let y = iy0; y <= iy1; y++) {
        const id = world.getBlock(x, y, z);
        if (!SOLID[id]) continue;
        if (SHAPES[id] === SHAPE.CUBE) {
          out.push([x, y, z, x + 1, y + 1, z + 1]);
          continue;
        }
        const get = (dx, dy, dz) => world.getBlock(x + dx, y + dy, z + dz);
        for (const b of shapeBoxes(id, get, true)) out.push([x + b[0], y + b[1], z + b[2], x + b[3], y + b[4], z + b[5]]);
      }
    }
  }
  return out;
}

function clip(boxes, a, axis, d) {
  const o1 = (axis + 1) % 3;
  const o2 = (axis + 2) % 3;
  for (const b of boxes) {
    if (b[o1 + 3] <= a[o1] + EPS || b[o1] >= a[o1 + 3] - EPS) continue;
    if (b[o2 + 3] <= a[o2] + EPS || b[o2] >= a[o2 + 3] - EPS) continue;
    if (d > 0 && b[axis] >= a[axis + 3] - EPS) d = Math.min(d, b[axis] - a[axis + 3]);
    else if (d < 0 && b[axis + 3] <= a[axis] + EPS) d = Math.max(d, b[axis + 3] - a[axis]);
  }
  return d;
}

function shift(a, axis, d) {
  a[axis] += d;
  a[axis + 3] += d;
}

const scratch = [];

function hasSupport(world, a, dx, dz, depth) {
  const boxes = collisionBoxes(world, a[0] + dx, a[1] - depth, a[2] + dz, a[3] + dx, a[1], a[5] + dz, scratch);
  const probe = [a[0] + dx + 0.001, a[1] - depth, a[2] + dz + 0.001, a[3] + dx - 0.001, a[1], a[5] + dz - 0.001];
  return boxes.some((b) => b[0] < probe[3] && b[3] > probe[0] && b[1] < probe[4] && b[4] > probe[1] && b[2] < probe[5] && b[5] > probe[2]);
}

// e: { x, y, z (feet center), vx, vy, vz, w, h, stepHeight, sneaking }
export function moveEntity(world, e, dt) {
  let dx = e.vx * dt;
  let dy = e.vy * dt;
  let dz = e.vz * dt;
  const hw = e.w / 2;
  const a = [e.x - hw, e.y, e.z - hw, e.x + hw, e.y + e.h, e.z + hw];

  if (e.sneaking && e.onGround) {
    const step = 0.05;
    while (dx !== 0 && !hasSupport(world, a, dx, 0, 0.6)) dx = Math.abs(dx) < step ? 0 : dx - Math.sign(dx) * step;
    while (dz !== 0 && !hasSupport(world, a, 0, dz, 0.6)) dz = Math.abs(dz) < step ? 0 : dz - Math.sign(dz) * step;
    while (dx !== 0 && dz !== 0 && !hasSupport(world, a, dx, dz, 0.6)) {
      dx = Math.abs(dx) < step ? 0 : dx - Math.sign(dx) * step;
      dz = Math.abs(dz) < step ? 0 : dz - Math.sign(dz) * step;
    }
  }

  const wantX = dx, wantY = dy, wantZ = dz;
  const boxes = collisionBoxes(world, Math.min(a[0], a[0] + dx) - 0.01, Math.min(a[1], a[1] + dy) - 0.01, Math.min(a[2], a[2] + dz) - 0.01,
    Math.max(a[3], a[3] + dx) + 0.01, Math.max(a[4], a[4] + dy) + (e.stepHeight ?? 0) + 0.01, Math.max(a[5], a[5] + dz) + 0.01, []);
  const start = [...a];
  dy = clip(boxes, a, 1, dy);
  shift(a, 1, dy);
  dx = clip(boxes, a, 0, dx);
  shift(a, 0, dx);
  dz = clip(boxes, a, 2, dz);
  shift(a, 2, dz);

  const onGroundNow = wantY < 0 && dy !== wantY;
  const step = e.stepHeight ?? 0;
  let stepped = false;
  if (step > 0 && (onGroundNow || e.onGround) && (dx !== wantX || dz !== wantZ)) {
    // Try climbing: up, across, back down.
    const b = [...start];
    let up = clip(boxes, b, 1, step);
    shift(b, 1, up);
    let sx = clip(boxes, b, 0, wantX);
    shift(b, 0, sx);
    let sz = clip(boxes, b, 2, wantZ);
    shift(b, 2, sz);
    const down = clip(boxes, b, 1, -up - Math.max(0, -wantY));
    shift(b, 1, down);
    if (sx * sx + sz * sz > dx * dx + dz * dz + 1e-6) {
      for (let k = 0; k < 6; k++) a[k] = b[k];
      dx = sx;
      dz = sz;
      dy = b[1] - start[1];
      stepped = true;
    }
  }

  e.collidedX = dx !== wantX;
  e.collidedZ = dz !== wantZ;
  e.collidedH = e.collidedX || e.collidedZ;
  e.onGround = onGroundNow || stepped;
  if (dy !== wantY && !stepped) e.vy = 0;
  if (stepped) e.vy = Math.max(0, e.vy);
  if (e.collidedX) e.vx = 0;
  if (e.collidedZ) e.vz = 0;
  e.x = (a[0] + a[3]) / 2;
  e.y = a[1];
  e.z = (a[2] + a[5]) / 2;
  return e;
}

// Fluid kind (1 water, 2 lava) overlapping a box; checks the cells the box touches.
export function fluidIn(world, x0, y0, z0, x1, y1, z1) {
  let kind = 0;
  for (let x = Math.floor(x0); x <= Math.floor(x1); x++) {
    for (let z = Math.floor(z0); z <= Math.floor(z1); z++) {
      for (let y = Math.floor(y0); y <= Math.floor(y1); y++) {
        const f = FLUID[world.getBlock(x, y, z)];
        if (f === 2) return 2;
        if (f === 1) kind = 1;
      }
    }
  }
  return kind;
}

export function touchesBlock(world, e, pred) {
  const hw = e.w / 2 + 0.02;
  for (let x = Math.floor(e.x - hw); x <= Math.floor(e.x + hw); x++) {
    for (let z = Math.floor(e.z - hw); z <= Math.floor(e.z + hw); z++) {
      for (let y = Math.floor(e.y - 0.02); y <= Math.floor(e.y + e.h); y++) {
        if (pred(world.getBlock(x, y, z), x, y, z)) return true;
      }
    }
  }
  return false;
}

function rayBox(ox, oy, oz, dx, dy, dz, b) {
  let tmin = -Infinity, tmax = Infinity, face = -1;
  const o = [ox, oy, oz], d = [dx, dy, dz];
  for (let k = 0; k < 3; k++) {
    if (Math.abs(d[k]) < 1e-12) {
      if (o[k] < b[k] || o[k] > b[k + 3]) return null;
      continue;
    }
    let t1 = (b[k] - o[k]) / d[k];
    let t2 = (b[k + 3] - o[k]) / d[k];
    let f1 = k * 2 + 1; // entering through the min side → face pointing negative
    if (t1 > t2) { [t1, t2] = [t2, t1]; f1 = k * 2; }
    if (t1 > tmin) { tmin = t1; face = f1; }
    tmax = Math.min(tmax, t2);
    if (tmin > tmax) return null;
  }
  if (tmax < 0) return null;
  return { t: Math.max(0, tmin), face };
}

// Returns { x, y, z, id, face, nx, ny, nz, t, boxes } for the first targetable block.
export function raycast(world, ox, oy, oz, dx, dy, dz, maxDist, { fluids = false } = {}) {
  let x = Math.floor(ox), y = Math.floor(oy), z = Math.floor(oz);
  const sx = Math.sign(dx), sy = Math.sign(dy), sz = Math.sign(dz);
  const tdx = sx ? Math.abs(1 / dx) : Infinity;
  const tdy = sy ? Math.abs(1 / dy) : Infinity;
  const tdz = sz ? Math.abs(1 / dz) : Infinity;
  let tmx = sx > 0 ? (x + 1 - ox) * tdx : sx < 0 ? (ox - x) * tdx : Infinity;
  let tmy = sy > 0 ? (y + 1 - oy) * tdy : sy < 0 ? (oy - y) * tdy : Infinity;
  let tmz = sz > 0 ? (z + 1 - oz) * tdz : sz < 0 ? (oz - z) * tdz : Infinity;
  let t = 0;
  for (let i = 0; i < 64 && t <= maxDist; i++) {
    const id = world.getBlock(x, y, z);
    if (id && (fluids || !FLUID[id])) {
      const get = (ax, ay, az) => world.getBlock(x + ax, y + ay, z + az);
      const boxes = SHAPES[id] === SHAPE.LIQUID ? [[0, 0, 0, 1, 1, 1]] : shapeBoxes(id, get, false);
      let best = null;
      for (const b of boxes) {
        const hit = rayBox(ox - x, oy - y, oz - z, dx, dy, dz, b);
        if (hit && (!best || hit.t < best.t)) best = hit;
      }
      if (best && best.t <= maxDist) {
        const f = best.face;
        const n = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]][f];
        return { x, y, z, id, face: f, nx: n[0], ny: n[1], nz: n[2], t: best.t, boxes, block: BLOCKS[id] };
      }
    }
    if (tmx < tmy && tmx < tmz) { x += sx; t = tmx; tmx += tdx; }
    else if (tmy < tmz) { y += sy; t = tmy; tmy += tdy; }
    else { z += sz; t = tmz; tmz += tdz; }
  }
  return null;
}
