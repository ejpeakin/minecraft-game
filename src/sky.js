// Day/night cycle: sky gradient dome, square sun and moon, stars and a drifting layer
// of blocky clouds. Exposes the daylight factor and fog color the chunk shader uses.
import * as THREE from './three.js';
import { smoothstep, lerp, mulberry32 } from './noise.js';

export const DAY_TICKS = 24000;
const mixc = (a, b, t) => [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];

function squareTexture(draw) {
  const c = document.createElement('canvas');
  c.width = 32;
  c.height = 32;
  draw(c.getContext('2d'));
  const t = new THREE.CanvasTexture(c);
  t.magFilter = THREE.NearestFilter;
  t.minFilter = THREE.NearestFilter;
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

export class Sky {
  constructor(scene) {
    this.group = new THREE.Group();
    scene.add(this.group);
    this.domeMat = new THREE.ShaderMaterial({
      uniforms: {
        uTop: { value: new THREE.Vector3() }, uHorizon: { value: new THREE.Vector3() }, uSunset: { value: new THREE.Vector4() },
        uSunDir: { value: new THREE.Vector3(0, 1, 0) }, uGlow: { value: new THREE.Vector3() },
      },
      vertexShader: `varying vec3 vDir; void main(){ vDir = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
      fragmentShader: `uniform vec3 uTop; uniform vec3 uHorizon; uniform vec4 uSunset; uniform vec3 uSunDir; uniform vec3 uGlow; varying vec3 vDir;
        void main(){ float h = clamp(vDir.y, -0.2, 1.0); vec3 c = mix(uHorizon, uTop, smoothstep(-0.05, 0.45, h));
          float s = max(0.0, dot(normalize(vec3(vDir.x, 0.0, vDir.z) + 1e-4), vec3(sign(uSunset.w), 0.0, 0.0)));
          c = mix(c, uSunset.rgb, uSunset.w == 0.0 ? 0.0 : pow(s, 3.0) * (1.0 - smoothstep(0.0, 0.5, h)) * abs(uSunset.w));
          float sd = max(dot(normalize(vDir), uSunDir), 0.0);
          c += uGlow * (pow(sd, 6.0) * 0.28 + pow(sd, 48.0) * 0.55);
          gl_FragColor = vec4(c, 1.0); }`,
      side: THREE.BackSide,
      depthWrite: false,
      depthTest: false,
    });
    this.dome = new THREE.Mesh(new THREE.SphereGeometry(500, 24, 12), this.domeMat);
    this.dome.renderOrder = -10;
    this.dome.frustumCulled = false;
    this.group.add(this.dome);

    const sunTex = squareTexture((ctx) => {
      ctx.fillStyle = 'rgba(255,240,170,0.35)';
      ctx.fillRect(4, 4, 24, 24);
      ctx.fillStyle = '#fff7c8';
      ctx.fillRect(9, 9, 14, 14);
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(11, 11, 10, 10);
    });
    const moonTex = squareTexture((ctx) => {
      ctx.fillStyle = '#dfe6f2';
      ctx.fillRect(10, 10, 12, 12);
      ctx.fillStyle = '#aeb8c8';
      ctx.fillRect(12, 13, 3, 3);
      ctx.fillRect(17, 17, 3, 2);
      ctx.fillRect(18, 11, 2, 2);
    });
    const bodyMat = (map) => new THREE.MeshBasicMaterial({ map, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false });
    this.sun = new THREE.Mesh(new THREE.PlaneGeometry(90, 90), bodyMat(sunTex));
    this.moon = new THREE.Mesh(new THREE.PlaneGeometry(60, 60), bodyMat(moonTex));
    this.sun.renderOrder = -9;
    this.moon.renderOrder = -9;
    this.group.add(this.sun, this.moon);

    const r = mulberry32(7);
    const starPos = [];
    for (let i = 0; i < 900; i++) {
      const u = r() * 2 - 1;
      const a = r() * Math.PI * 2;
      const s = Math.sqrt(1 - u * u);
      starPos.push(Math.cos(a) * s * 450, Math.abs(u) * 450, Math.sin(a) * s * 450);
    }
    const sg = new THREE.BufferGeometry();
    sg.setAttribute('position', new THREE.Float32BufferAttribute(starPos, 3));
    this.starMat = new THREE.PointsMaterial({ color: 0xffffff, size: 1.6, sizeAttenuation: false, transparent: true, depthWrite: false, fog: false });
    this.stars = new THREE.Points(sg, this.starMat);
    this.stars.renderOrder = -9;
    this.group.add(this.stars);

    // Clouds: one texel per 12x12 blocks, thresholded noise.
    const cc = document.createElement('canvas');
    cc.width = 64;
    cc.height = 64;
    const cctx = cc.getContext('2d');
    const img = cctx.createImageData(64, 64);
    const rr = mulberry32(42);
    const grid = new Float32Array(64 * 64);
    for (let i = 0; i < grid.length; i++) grid[i] = rr();
    for (let y = 0; y < 64; y++) for (let x = 0; x < 64; x++) {
      let v = 0;
      for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) v += grid[((y + dy + 64) % 64) * 64 + ((x + dx + 64) % 64)];
      const on = v / 25 > 0.53;
      const i = (y * 64 + x) * 4;
      img.data[i] = img.data[i + 1] = img.data[i + 2] = 255;
      img.data[i + 3] = on ? 220 : 0;
    }
    cctx.putImageData(img, 0, 0);
    this.cloudTex = new THREE.CanvasTexture(cc);
    this.cloudTex.magFilter = THREE.NearestFilter;
    this.cloudTex.minFilter = THREE.NearestFilter;
    this.cloudTex.wrapS = this.cloudTex.wrapT = THREE.RepeatWrapping;
    this.cloudTex.repeat.set(2000 / 768, 2000 / 768);
    this.cloudMat = new THREE.MeshBasicMaterial({ map: this.cloudTex, transparent: true, depthWrite: false, side: THREE.DoubleSide, fog: false, opacity: 0.85 });
    this.clouds = new THREE.Mesh(new THREE.PlaneGeometry(2000, 2000), this.cloudMat);
    this.clouds.rotation.x = -Math.PI / 2;
    this.clouds.renderOrder = 2;
    this.group.add(this.clouds);
    // Fancy clouds: a darker copy a few blocks below reads as thickness from underneath.
    this.cloudUnderMat = this.cloudMat.clone();
    this.cloudsUnder = new THREE.Mesh(this.clouds.geometry, this.cloudUnderMat);
    this.cloudsUnder.rotation.x = -Math.PI / 2;
    this.cloudsUnder.renderOrder = 2;
    this.group.add(this.cloudsUnder);
    this.cloudOffset = 0;

    this.daylight = 1;
    this.fogColor = [0.7, 0.8, 1];
    this.skyColor = [0.5, 0.7, 1];
    this.skyDarken = 0; // 0 day .. 11 night, for mob spawning light levels
  }

  // rain: 0 (clear) to 1 (full rain), from Weather.
  update(time, camera, dt, showClouds = true, fancy = true, rain = 0) {
    const a = (time / DAY_TICKS) * Math.PI * 2;
    const e = Math.sin(a);
    const d = smoothstep(-0.2, 0.25, e);
    this.daylight = lerp(0.2, 1, d) * (1 - 0.3 * rain);
    this.skyDarken = Math.round((1 - d) * 11 + rain * 3);
    // Rain turns the sky a flat gray.
    let top = mixc([0.012, 0.014, 0.05], [0.42, 0.62, 1.0], d);
    let horizon = mixc([0.03, 0.04, 0.09], [0.74, 0.85, 1.0], d);
    top = mixc(top, [0.34 * d + 0.02, 0.37 * d + 0.02, 0.42 * d + 0.04], rain * 0.85);
    horizon = mixc(horizon, [0.5 * d + 0.03, 0.53 * d + 0.03, 0.58 * d + 0.05], rain * 0.85);
    const dusk = Math.max(0, 1 - Math.abs(e) / 0.32) * (1 - rain);
    const sunsetColor = [1.0, 0.5, 0.22];
    this.domeMat.uniforms.uTop.value.set(...top);
    this.domeMat.uniforms.uHorizon.value.set(...horizon);
    // w carries strength with the sign telling which side (+x sunrise, -x sunset).
    this.domeMat.uniforms.uSunset.value.set(...sunsetColor, dusk * 0.85 * (Math.cos(a) >= 0 ? 1 : -1));
    // Sunlight color: warm around sunrise and sunset, cool blue at night.
    const warmth = Math.max(0, 1 - Math.abs(e) / 0.35) * (1 - rain);
    this.lightTint = mixc(mixc([1, 1, 1], [1.0, 0.8, 0.62], warmth * 0.75), [0.72, 0.8, 1.0], (1 - d) * 0.9);
    horizon = mixc(horizon, sunsetColor, dusk * 0.25);
    this.fogColor = horizon;
    this.skyColor = top;

    const p = camera.position;
    this.group.position.copy(p);
    const sunDir = new THREE.Vector3(Math.cos(a), Math.sin(a), 0.15).normalize();
    this.domeMat.uniforms.uSunDir.value.copy(sunDir);
    const glow = fancy ? Math.max(0, Math.min(1, (e + 0.25) * 2.5)) * (1 - rain) : 0;
    const warm = Math.max(0, 1 - Math.abs(e) / 0.4);
    this.domeMat.uniforms.uGlow.value.set(glow, glow * lerp(0.95, 0.7, warm), glow * lerp(0.85, 0.42, warm));
    this.sun.position.copy(sunDir).multiplyScalar(400);
    this.sun.lookAt(0, 0, 0);
    this.moon.position.copy(sunDir).multiplyScalar(-400);
    this.moon.lookAt(0, 0, 0);
    this.sun.visible = e > -0.25 && rain < 0.6;
    this.moon.visible = e < 0.25 && rain < 0.6;
    this.starMat.opacity = Math.max(0, 1 - d * 1.6) * (1 - rain);
    this.stars.visible = this.starMat.opacity > 0.01;
    this.stars.rotation.z = a;

    this.cloudOffset += dt * 0.6;
    this.clouds.visible = showClouds;
    this.clouds.position.set(0, 112 - p.y, 0);
    this.cloudTex.offset.set((p.x + this.cloudOffset) / 768, -p.z / 768);
    const cl = lerp(0.12, 1, d) * (1 - 0.45 * rain);
    this.cloudMat.color.setRGB(cl, cl, cl * 1.02, THREE.SRGBColorSpace);
    this.cloudsUnder.visible = showClouds && fancy;
    this.cloudsUnder.position.set(0, 109 - p.y, 0);
    this.cloudUnderMat.color.setRGB(cl * 0.8, cl * 0.8, cl * 0.84, THREE.SRGBColorSpace);
    this.sunDir = sunDir;
  }
}
