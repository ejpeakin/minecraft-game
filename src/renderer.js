// Chunk meshes and the custom shader that lights them, plus small render helpers:
// block-shaped geometry for entities and the held item, the selection outline, the
// crack overlay, and a pooled particle system.
import * as THREE from './three.js';
import { SHAPES, SHAPE, FACE_TEX, FACE_ROT, shapeBoxes } from './blocks.js';
import { meshChunk, setFireLayer } from './mesher.js';
import { CHUNK, HEIGHT } from './worldgen.js';
import { chunkKey } from './world.js';

const VERT = /* glsl */ `
  attribute vec3 aTex;
  attribute vec3 aLight;
  attribute vec3 aTint;
  varying vec3 vTint;
  uniform float uTime;
  uniform float uWaterLayer;
  uniform float uLavaLayer;
  uniform float uWave;
  varying vec3 vTex;
  varying vec3 vLight;
  varying vec3 vWorld;
  varying float vDist;
  void main() {
    vTex = aTex;
    // Biome color, stored halved; geometry without one (entities) reads as zero.
    vTint = aTint * 2.0;
    if (vTint.r + vTint.g + vTint.b < 0.05) vTint = vec3(1.0);
    float L = floor(aTex.z + 0.5);
    if (abs(L - uWaterLayer) < 0.5) vTex.xy += vec2(uTime * 0.02, uTime * 0.05);
    else if (abs(L - uLavaLayer) < 0.5) vTex.xy += vec2(uTime * 0.01, uTime * 0.025);
    // The mesher adds 2 (plant tops) or 4 (leaves) to the shade of vertices that sway.
    float flag = floor(aLight.z / 2.0);
    vLight = vec3(aLight.xy, aLight.z - flag * 2.0);
    vec3 p = position;
    if (flag > 0.5 && uWave > 0.5) {
      vec4 w0 = modelMatrix * vec4(position, 1.0);
      float amp = flag > 1.5 ? 0.03 : 0.06;
      float t = uTime * 1.7 + w0.x * 0.55 + w0.z * 0.4;
      p.x += sin(t) * amp;
      p.z += cos(t * 0.83 + 1.3) * amp;
    }
    vec4 world = modelMatrix * vec4(p, 1.0);
    vWorld = world.xyz;
    vec4 mv = viewMatrix * world;
    vDist = length(mv.xyz);
    gl_Position = projectionMatrix * mv;
  }
`;

const FRAG = /* glsl */ `
  precision highp float;
#ifdef SAFE
  // Safe graphics: one 2D atlas, 16 tiles per row (WebGL 1 compatible, no mipmaps).
  uniform sampler2D uAtlas;
  uniform vec2 uAtlasGrid;
  vec4 tile(vec2 uv, float layer) {
    vec2 f = clamp(uv - floor(uv), 0.5 / 16.0, 15.5 / 16.0);
    float col = mod(layer, uAtlasGrid.x);
    float row = floor(layer / uAtlasGrid.x + 0.001);
    return texture2D(uAtlas, vec2((col + f.x) / uAtlasGrid.x, 1.0 - (row + 1.0 - f.y) / uAtlasGrid.y));
  }
#else
  precision highp sampler2DArray;
  uniform sampler2DArray uAtlas;
  vec4 tile(vec2 uv, float layer) { return texture(uAtlas, vec3(uv, layer)); }
#endif
  uniform float uDaylight;
  uniform float uBrightness;
  uniform vec3 uFogColor;
  uniform float uFogNear;
  uniform float uFogFar;
  uniform float uAlphaTest;
  uniform float uOpacity;
  uniform float uEntity;
  uniform vec2 uEntityLight;
  uniform vec3 uTint;
  uniform float uFlash;
  uniform float uFireLayer;
  uniform float uTime;
  uniform float uFancy;
  uniform float uFlicker;
  uniform vec3 uSunDir;
  uniform vec3 uSkyColor;
  uniform vec3 uSkyTint;
  varying vec3 vTex;
  varying vec3 vLight;
  varying vec3 vWorld;
  varying float vDist;
  varying vec3 vTint;
  float curve(float l) { return pow(0.8, 15.0 * (1.0 - l)); }
  void main() {
    float layer = floor(vTex.z + 0.5);
    vec4 c = tile(vTex.xy, layer);
    if (c.a < uAlphaTest) discard;
    vec2 L = mix(vLight.xy, uEntityLight, uEntity);
    float s = curve(L.x) * uDaylight;
    float b = curve(L.y) * mix(1.0, uFlicker, uFancy);
    vec3 light = max(vec3(s) * uSkyTint, vec3(b, b * 0.9, b * 0.74));
    light = max(light, vec3(0.05));
    // Brightness setting: lift the dark end of the curve, like Minecraft's slider.
    light = mix(light, sqrt(light), uBrightness * 0.6);
    float shade = vLight.z;
    if (abs(layer - uFireLayer) < 0.5) { light = vec3(1.0); shade = 0.9 + 0.1 * sin(uTime * 17.0 + vTex.x * 9.0); }
    // Pixels marked with alpha 254 (grass, oak leaves) take the biome color.
    vec3 tint = mix(vec3(1.0), vTint, clamp((1.0 - c.a) * 255.0, 0.0, 1.0));
    vec3 col = c.rgb * tint * light * shade * uTint;
    float alpha = c.a * uOpacity;
#ifdef WATER
    if (uFancy > 0.5) {
      // Rippled surface normal, sky reflection at grazing angles, and a sun glint.
      vec3 viewDir = normalize(cameraPosition - vWorld);
      float t = uTime * 1.5;
      vec3 n = normalize(vec3(sin(vWorld.x * 1.7 + t) * 0.06 + sin(vWorld.z * 0.9 - t * 0.7) * 0.04, 1.0, cos(vWorld.z * 1.5 + t * 1.1) * 0.06));
      float fres = pow(1.0 - clamp(dot(n, viewDir), 0.0, 1.0), 3.0);
      col = mix(col, uSkyColor * max(s, 0.08), fres * 0.65);
      float spec = pow(max(dot(n, normalize(uSunDir + viewDir)), 0.0), 90.0) * smoothstep(0.0, 0.2, uSunDir.y) * curve(L.x);
      col += vec3(1.0, 0.92, 0.75) * spec * 0.9;
      alpha = mix(alpha, 0.92, fres);
    }
#endif
    if (uFancy > 0.5) col = mix(vec3(dot(col, vec3(0.299, 0.587, 0.114))), col, 1.12);
    col = mix(col, vec3(1.0), uFlash);
    float fog = smoothstep(uFogNear, uFogFar, vDist);
    gl_FragColor = vec4(mix(col, uFogColor, fog), alpha);
  }
`;

// A flat 16x16 picture as a solid model one pixel thick, the way Minecraft draws items
// in the hand and on the ground: a front and back for every pixel, and edge faces
// around the outline. One unit across; colors are baked into the vertices.
const itemGeos = new Map();
export function itemGeometry(key, canvas) {
  if (itemGeos.has(key)) return itemGeos.get(key);
  const n = canvas.width;
  const px = canvas.getContext('2d').getImageData(0, 0, n, n).data;
  const solid = (x, y) => x >= 0 && y >= 0 && x < n && y < n && px[(y * n + x) * 4 + 3] > 128;
  const pos = [], col = [], idx = [];
  const c = new THREE.Color();
  const quad = (pts, shade) => {
    const base = pos.length / 3;
    for (const p of pts) { pos.push(...p); col.push(c.r * shade, c.g * shade, c.b * shade); }
    idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
  };
  const s = 1 / n, t = s / 2;
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      if (!solid(x, y)) continue;
      const i = (y * n + x) * 4;
      c.setRGB(px[i] / 255, px[i + 1] / 255, px[i + 2] / 255, THREE.SRGBColorSpace);
      const x0 = x * s - 0.5, x1 = x0 + s, y1 = 0.5 - y * s, y0 = y1 - s;
      quad([[x0, y0, t], [x1, y0, t], [x1, y1, t], [x0, y1, t]], 1);
      quad([[x1, y0, -t], [x0, y0, -t], [x0, y1, -t], [x1, y1, -t]], 0.85);
      if (!solid(x - 1, y)) quad([[x0, y0, -t], [x0, y0, t], [x0, y1, t], [x0, y1, -t]], 0.7);
      if (!solid(x + 1, y)) quad([[x1, y0, t], [x1, y0, -t], [x1, y1, -t], [x1, y1, t]], 0.7);
      if (!solid(x, y - 1)) quad([[x0, y1, t], [x1, y1, t], [x1, y1, -t], [x0, y1, -t]], 0.92);
      if (!solid(x, y + 1)) quad([[x0, y0, -t], [x1, y0, -t], [x1, y0, t], [x0, y0, t]], 0.6);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.setIndex(idx);
  itemGeos.set(key, g);
  return g;
}

export class ChunkRenderer {
  constructor(scene, bank) {
    this.scene = scene;
    this.bank = bank;
    setFireLayer(bank.fireLayer);
    this.shared = {
      uAtlas: { value: bank.atlas },
      uAtlasGrid: { value: new THREE.Vector2(...(bank.atlasGrid ?? [16, 16])) },
      uDaylight: { value: 1 },
      uBrightness: { value: 0.5 },
      uFancy: { value: 1 },
      uWave: { value: 1 },
      uFlicker: { value: 1 },
      uSunDir: { value: new THREE.Vector3(0, 1, 0) },
      uSkyColor: { value: new THREE.Vector3(0.7, 0.8, 1) },
      uSkyTint: { value: new THREE.Vector3(1, 1, 1) },
      uFogColor: { value: new THREE.Vector3(0.6, 0.75, 1) },
      uFogNear: { value: 60 },
      uFogFar: { value: 90 },
      uTime: { value: 0 },
      uWaterLayer: { value: bank.waterLayer },
      uLavaLayer: { value: bank.lavaLayer },
      uFireLayer: { value: bank.fireLayer },
    };
    this.solidMat = this.makeMaterial({ alphaTest: 0.5 });
    this.waterMat = this.makeMaterial({ alphaTest: 0.01, opacity: 0.72, transparent: true, water: true });
    this.meshes = new Map();
    this.group = new THREE.Group();
    scene.add(this.group);
    this.buildMs = 0;
  }

  makeMaterial({ alphaTest = 0.5, opacity = 1, transparent = false, entity = false, water = false, side = THREE.FrontSide } = {}) {
    const defines = {};
    if (this.bank.safe) defines.SAFE = '';
    if (water) defines.WATER = '';
    return new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      defines,
      uniforms: {
        ...this.shared,
        uAlphaTest: { value: alphaTest },
        uOpacity: { value: opacity },
        uEntity: { value: entity ? 1 : 0 },
        uEntityLight: { value: new THREE.Vector2(1, 0) },
        uTint: { value: new THREE.Vector3(1, 1, 1) },
        uFlash: { value: 0 },
      },
      transparent,
      depthWrite: !transparent,
      side: transparent ? THREE.DoubleSide : side,
    });
  }

  setFog(color, near, far) {
    this.shared.uFogColor.value.set(color[0], color[1], color[2]);
    this.shared.uFogNear.value = near;
    this.shared.uFogFar.value = far;
  }

  // Rebuild dirty chunks within the time budget, nearest (and urgent) first.
  update(world, px, pz, radius, budgetMs) {
    const pcx = Math.floor(px / CHUNK);
    const pcz = Math.floor(pz / CHUNK);
    const candidates = [];
    for (const chunk of world.chunks.values()) {
      if (!chunk.dirty) continue;
      const dx = chunk.cx - pcx;
      const dz = chunk.cz - pcz;
      if (dx * dx + dz * dz > radius * radius) continue;
      if (!this.neighborsReady(world, chunk)) continue;
      candidates.push([chunk, (chunk.urgent ? -1e6 : 0) + dx * dx + dz * dz]);
    }
    candidates.sort((a, b) => a[1] - b[1]);
    const start = performance.now();
    let built = 0;
    for (const [chunk] of candidates) {
      if (built > 0 && performance.now() - start > budgetMs && !chunk.urgent) break;
      this.build(world, chunk);
      built++;
    }
    this.buildMs = performance.now() - start;
    return built;
  }

  neighborsReady(world, chunk) {
    for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
      if (!world.chunks.has(chunkKey(chunk.cx + dx, chunk.cz + dz))) return false;
    }
    return true;
  }

  build(world, chunk) {
    const data = meshChunk(world, chunk.cx, chunk.cz);
    chunk.light = data.light;
    chunk.campfires = data.campfires;
    chunk.dirty = false;
    chunk.urgent = false;
    chunk.meshed = true;
    let entry = this.meshes.get(chunk.key);
    if (!entry) {
      entry = { solid: null, water: null };
      this.meshes.set(chunk.key, entry);
    }
    entry.solid = this.replaceMesh(entry.solid, data.solid, this.solidMat, chunk, 0);
    entry.water = this.replaceMesh(entry.water, data.water, this.waterMat, chunk, 1);
  }

  replaceMesh(old, d, material, chunk, order) {
    if (old) {
      this.group.remove(old);
      old.geometry.dispose();
    }
    if (!d.index.length) return null;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(d.pos, 3));
    g.setAttribute('aTex', new THREE.BufferAttribute(d.tex, 3));
    g.setAttribute('aLight', new THREE.BufferAttribute(d.light, 3));
    g.setAttribute('aTint', new THREE.BufferAttribute(d.tint, 3, true));
    g.setIndex(new THREE.BufferAttribute(d.index, 1));
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(CHUNK / 2, HEIGHT / 2, CHUNK / 2), Math.hypot(CHUNK / 2, HEIGHT / 2, CHUNK / 2));
    const mesh = new THREE.Mesh(g, material);
    mesh.position.set(chunk.cx * CHUNK, 0, chunk.cz * CHUNK);
    mesh.matrixAutoUpdate = false;
    mesh.updateMatrix();
    mesh.renderOrder = order;
    this.group.add(mesh);
    return mesh;
  }

  remove(chunk) {
    const entry = this.meshes.get(chunk.key);
    if (!entry) return;
    for (const m of [entry.solid, entry.water]) {
      if (!m) continue;
      this.group.remove(m);
      m.geometry.dispose();
    }
    this.meshes.delete(chunk.key);
  }

  clear() {
    for (const entry of this.meshes.values()) {
      for (const m of [entry.solid, entry.water]) {
        if (!m) continue;
        this.group.remove(m);
        m.geometry.dispose();
      }
    }
    this.meshes.clear();
  }

  // Geometry for a block as an entity: centered on x/z, bottom at y = 0, given size.
  blockGeometry(id) {
    this.geoCache ??= new Map();
    if (this.geoCache.has(id)) return this.geoCache.get(id);
    const pos = [], tex = [], light = [], index = [];
    const shadeOf = [0.8, 0.8, 1, 0.55, 0.65, 0.65];
    const quad = (pts, uvs, layer, shade) => {
      const base = pos.length / 3;
      for (let k = 0; k < 4; k++) {
        pos.push(pts[k][0] - 0.5, pts[k][1], pts[k][2] - 0.5);
        tex.push(uvs[k][0], uvs[k][1], layer);
        light.push(1, 0, shade);
      }
      index.push(base, base + 1, base + 2, base, base + 2, base + 3);
    };
    const shape = SHAPES[id];
    if (shape === SHAPE.CROSS) {
      const layer = FACE_TEX[id * 6 + 4];
      for (const [[ax, az], [bx, bz]] of [[[0.15, 0.15], [0.85, 0.85]], [[0.15, 0.85], [0.85, 0.15]]]) {
        quad([[ax, 0, az], [bx, 0, bz], [bx, 1, bz], [ax, 1, az]], [[0, 0], [1, 0], [1, 1], [0, 1]], layer, 1);
        quad([[bx, 0, bz], [ax, 0, az], [ax, 1, az], [bx, 1, bz]], [[1, 0], [0, 0], [0, 1], [1, 1]], layer, 1);
      }
    } else {
      const boxes = shape === SHAPE.LIQUID || shape === SHAPE.CUBE || shape === SHAPE.NONE ? [[0, 0, 0, 1, 1, 1]] : shapeBoxes(id, () => 0);
      const corners = [
        [[1, 0, 1], [1, 0, 0], [1, 1, 0], [1, 1, 1]],
        [[0, 0, 0], [0, 0, 1], [0, 1, 1], [0, 1, 0]],
        [[0, 1, 1], [1, 1, 1], [1, 1, 0], [0, 1, 0]],
        [[0, 0, 0], [1, 0, 0], [1, 0, 1], [0, 0, 1]],
        [[0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1]],
        [[1, 0, 0], [0, 0, 0], [0, 1, 0], [1, 1, 0]],
      ];
      const uvOf = (f, x, y, z) => [[1 - z, y], [z, y], [x, 1 - z], [x, z], [x, y], [1 - x, y]][f];
      for (const [x0, y0, z0, x1, y1, z1] of boxes) {
        for (let f = 0; f < 6; f++) {
          const pts = corners[f].map(([cx, cy, cz]) => [cx ? x1 : x0, cy ? y1 : y0, cz ? z1 : z0]);
          const rot = FACE_ROT[id * 6 + f];
          const uvs = pts.map((p) => {
            let [u, v] = uvOf(f, p[0], p[1], p[2]);
            for (let k = 0; k < rot; k++) [u, v] = [v, 1 - u];
            return [u, v];
          });
          quad(pts, uvs, FACE_TEX[id * 6 + f], shadeOf[f]);
        }
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('aTex', new THREE.Float32BufferAttribute(tex, 3));
    g.setAttribute('aLight', new THREE.Float32BufferAttribute(light, 3));
    g.setIndex(index);
    this.geoCache.set(id, g);
    return g;
  }

  entityMaterial() {
    return this.makeMaterial({ alphaTest: 0.5, entity: true, side: THREE.DoubleSide });
  }
}

// Wireframe around the targeted block (fitted to its shape).
export class SelectionBox {
  constructor(scene) {
    const mat = new THREE.LineBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.55 });
    this.lines = new THREE.LineSegments(new THREE.BufferGeometry(), mat);
    this.lines.visible = false;
    scene.add(this.lines);
    this.key = '';
  }
  show(x, y, z, boxes) {
    const key = `${x},${y},${z},${JSON.stringify(boxes)}`;
    if (key !== this.key) {
      this.key = key;
      const pts = [];
      const e = 0.002;
      for (const [x0, y0, z0, x1, y1, z1] of boxes) {
        const a = [x0 - e, y0 - e, z0 - e];
        const b = [x1 + e, y1 + e, z1 + e];
        const c = (i, j, k) => [i ? b[0] : a[0], j ? b[1] : a[1], k ? b[2] : a[2]];
        const edges = [
          [c(0, 0, 0), c(1, 0, 0)], [c(0, 0, 1), c(1, 0, 1)], [c(0, 1, 0), c(1, 1, 0)], [c(0, 1, 1), c(1, 1, 1)],
          [c(0, 0, 0), c(0, 1, 0)], [c(1, 0, 0), c(1, 1, 0)], [c(0, 0, 1), c(0, 1, 1)], [c(1, 0, 1), c(1, 1, 1)],
          [c(0, 0, 0), c(0, 0, 1)], [c(1, 0, 0), c(1, 0, 1)], [c(0, 1, 0), c(0, 1, 1)], [c(1, 1, 0), c(1, 1, 1)],
        ];
        for (const [p, q] of edges) pts.push(...p, ...q);
      }
      this.lines.geometry.dispose();
      this.lines.geometry = new THREE.BufferGeometry();
      this.lines.geometry.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
    }
    this.lines.position.set(x, y, z);
    this.lines.visible = true;
  }
  hide() {
    this.lines.visible = false;
  }
}

export class CrackOverlay {
  constructor(scene, stages) {
    this.stages = stages;
    this.mat = new THREE.MeshBasicMaterial({
      map: stages[0], transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2, opacity: 0.85,
    });
    this.mesh = new THREE.Mesh(new THREE.BoxGeometry(1.004, 1.004, 1.004), this.mat);
    this.mesh.visible = false;
    scene.add(this.mesh);
  }
  show(x, y, z, progress, box) {
    const stage = Math.min(9, Math.floor(progress * 10));
    this.mat.map = this.stages[stage];
    const [x0, y0, z0, x1, y1, z1] = box ?? [0, 0, 0, 1, 1, 1];
    this.mesh.scale.set(x1 - x0 + 0.004, y1 - y0 + 0.004, z1 - z0 + 0.004);
    this.mesh.position.set(x + (x0 + x1) / 2, y + (y0 + y1) / 2, z + (z0 + z1) / 2);
    this.mesh.visible = true;
  }
  hide() {
    this.mesh.visible = false;
  }
}

// Screen-aligned square particles: block debris, smoke, falling poplar leaves.
export class Particles {
  constructor(scene, max = 900) {
    this.max = max;
    this.items = [];
    this.geo = new THREE.BufferGeometry();
    this.posArr = new Float32Array(max * 3);
    this.colArr = new Float32Array(max * 3);
    this.sizeArr = new Float32Array(max);
    this.geo.setAttribute('position', new THREE.BufferAttribute(this.posArr, 3));
    this.geo.setAttribute('color', new THREE.BufferAttribute(this.colArr, 3));
    this.geo.setAttribute('size', new THREE.BufferAttribute(this.sizeArr, 1));
    const mat = new THREE.ShaderMaterial({
      uniforms: { uScale: { value: 600 } },
      vertexShader: `
        attribute float size;
        attribute vec3 color;
        uniform float uScale;
        varying vec3 vColor;
        void main() {
          vColor = color;
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_PointSize = size * uScale / -mv.z;
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: `
        varying vec3 vColor;
        void main() { gl_FragColor = vec4(vColor, 1.0); }`,
    });
    this.points = new THREE.Points(this.geo, mat);
    this.points.frustumCulled = false;
    this.material = mat;
    scene.add(this.points);
  }

  spawn(p) {
    if (this.items.length >= this.max) this.items.shift();
    this.items.push({ gravity: 18, drag: 0.98, size: 0.1, life: 1, age: 0, ...p });
  }

  burst(x, y, z, color, count = 24, light = 1) {
    for (let i = 0; i < count; i++) {
      const f = 0.75 + Math.random() * 0.4;
      this.spawn({
        x: x + Math.random(), y: y + Math.random(), z: z + Math.random(),
        vx: (Math.random() - 0.5) * 3, vy: Math.random() * 3.5, vz: (Math.random() - 0.5) * 3,
        color: [color[0] * f * light, color[1] * f * light, color[2] * f * light],
        size: 0.06 + Math.random() * 0.07, life: 0.5 + Math.random() * 0.6,
      });
    }
  }

  update(dt, solidAt) {
    let n = 0;
    const keep = [];
    for (const p of this.items) {
      p.age += dt;
      if (p.age >= p.life) continue;
      p.vy -= p.gravity * dt;
      if (p.sway) {
        p.vx += Math.sin(p.age * 2.3 + p.phase) * p.sway * dt;
        p.vz += Math.cos(p.age * 1.7 + p.phase) * p.sway * dt;
        p.vy = Math.max(p.vy, -p.fall);
      }
      p.vx *= p.drag;
      p.vz *= p.drag;
      const nx = p.x + p.vx * dt;
      const ny = p.y + p.vy * dt;
      const nz = p.z + p.vz * dt;
      if (solidAt(Math.floor(nx), Math.floor(ny), Math.floor(nz))) {
        p.vx *= 0.3;
        p.vz *= 0.3;
        p.vy = 0;
        if (p.sway) p.sway = 0;
      } else {
        p.x = nx;
        p.y = ny;
        p.z = nz;
      }
      keep.push(p);
      if (n < this.max) {
        this.posArr[n * 3] = p.x;
        this.posArr[n * 3 + 1] = p.y;
        this.posArr[n * 3 + 2] = p.z;
        this.colArr.set(p.color, n * 3);
        this.sizeArr[n] = p.size;
        n++;
      }
    }
    this.items = keep;
    this.geo.setDrawRange(0, n);
    this.geo.attributes.position.needsUpdate = true;
    this.geo.attributes.color.needsUpdate = true;
    this.geo.attributes.size.needsUpdate = true;
  }

  setViewport(height, fov) {
    this.material.uniforms.uScale.value = height / (2 * Math.tan((fov * Math.PI) / 360));
  }
}

