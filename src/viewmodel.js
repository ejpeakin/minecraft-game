// First-person arm and held item, drawn in their own scene on top of the world so they
// never clip into blocks. Swings when mining or placing and bobs while walking.
import * as THREE from './three.js';
import { ITEMS } from './items.js';
import { BLOCKS } from './blocks.js';

export class ViewModel {
  constructor(game) {
    this.game = game;
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(70, 1, 0.01, 10);
    this.root = new THREE.Group();
    this.scene.add(this.root);
    this.armMat = new THREE.MeshBasicMaterial({ color: 0xffffff, map: this.skinTexture() });
    this.arm = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.16, 0.62), this.armMat);
    this.arm.position.set(0.5, -0.5, -0.78);
    this.arm.rotation.set(0.45, 0.22, 0.12);
    this.root.add(this.arm);
    this.itemHolder = new THREE.Group();
    this.itemHolder.position.set(0.44, -0.4, -0.8);
    this.root.add(this.itemHolder);
    this.heldKey = null;
    this.heldMesh = null;
    this.lowered = 0;
  }

  skinTexture() {
    const c = document.createElement('canvas');
    c.width = 8;
    c.height = 8;
    const ctx = c.getContext('2d');
    for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) {
      const f = 0.92 + Math.random() * 0.12;
      ctx.fillStyle = `rgb(${(214 * f) | 0},${(160 * f) | 0},${(122 * f) | 0})`;
      ctx.fillRect(x, y, 1, 1);
    }
    const t = new THREE.CanvasTexture(c);
    t.magFilter = THREE.NearestFilter;
    t.colorSpace = THREE.SRGBColorSpace;
    return t;
  }

  setHeld(stack) {
    const key = stack?.id ?? null;
    if (key === this.heldKey) return;
    this.heldKey = key;
    if (this.heldMesh) {
      this.itemHolder.remove(this.heldMesh);
      this.heldMesh.traverse((o) => o.material?.dispose?.());
      this.heldMesh = null;
    }
    this.arm.visible = !key;
    if (!key) return;
    const def = ITEMS[key];
    const block = def.block !== undefined ? BLOCKS[def.block] : null;
    if (block && block.shape !== 'cross' && block.shape !== 'torch') {
      const mesh = new THREE.Mesh(this.game.chunkRenderer.blockGeometry(def.block), this.game.chunkRenderer.entityMaterial());
      mesh.scale.setScalar(0.24);
      mesh.position.set(0.02, -0.06, -0.05);
      mesh.rotation.set(0.1, Math.PI / 4 + 0.3, 0);
      this.heldMesh = mesh;
    } else {
      const tex = new THREE.CanvasTexture(this.game.bank.icon(key));
      tex.magFilter = THREE.NearestFilter;
      tex.minFilter = THREE.NearestFilter;
      tex.colorSpace = THREE.SRGBColorSpace;
      const mat = new THREE.MeshBasicMaterial({ map: tex, transparent: true, alphaTest: 0.5, side: THREE.DoubleSide });
      const mesh = new THREE.Mesh(new THREE.PlaneGeometry(0.42, 0.42), mat);
      mesh.rotation.set(0, -Math.PI / 2.6, 0.35);
      mesh.position.set(0.04, 0.05, 0);
      this.heldMesh = mesh;
    }
    this.lowered = 1;
    this.itemHolder.add(this.heldMesh);
  }

  update(dt, player, light) {
    this.setHeld(player.held);
    this.lowered = Math.max(0, this.lowered - dt * 5);
    const s = player.swing;
    const swingA = Math.sin(s * Math.PI);
    const bob = player.onGround && !player.flying ? Math.sin(player.walkDist * 2.2) : 0;
    const bobAmt = Math.min(1, Math.hypot(player.vx, player.vz) / 4.3);
    const eat = player.eating > 0 ? Math.sin(player.eating * 20) * 0.03 : 0;
    this.root.position.set(bob * 0.025 * bobAmt, -Math.abs(bob) * 0.03 * bobAmt - this.lowered * 0.4 + eat + (player.eating > 0 ? 0.12 : 0), 0);
    this.root.rotation.set(-swingA * 0.6, swingA * 0.35, -swingA * 0.25);
    if (player.eating > 0) this.root.position.x -= 0.2;
    this.armMat.color.setScalar(light.brightness);
    this.heldMesh?.traverse((o) => {
      const m = o.material;
      if (!m) return;
      if (m.uniforms?.uEntityLight) m.uniforms.uEntityLight.value.set(light.sky, light.block);
      else m.color?.setScalar(light.brightness);
    });
  }

  render(renderer, aspect) {
    this.camera.aspect = aspect;
    this.camera.updateProjectionMatrix();
    renderer.autoClear = false;
    renderer.clearDepth();
    renderer.render(this.scene, this.camera);
    renderer.autoClear = true;
  }
}
