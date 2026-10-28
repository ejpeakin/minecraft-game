// Keyboard and mouse state with per-frame edge detection, plus pointer lock.

export class Input {
  constructor(canvas) {
    this.canvas = canvas;
    this.down = new Set();
    this.pressed = new Set();
    this.mouse = [false, false, false];
    this.clicked = [false, false, false];
    this.dx = 0;
    this.dy = 0;
    this.wheel = 0;
    this.locked = false;
    this.onKey = null; // (code, event) => handled
    this.lastSpace = 0;
    this.doubleSpace = false;
    this.lastW = 0;
    this.doubleW = false;

    window.addEventListener('keydown', (e) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
      if (!e.repeat) {
        this.pressed.add(e.code);
        const now = performance.now();
        if (e.code === 'Space') {
          if (now - this.lastSpace < 300) this.doubleSpace = true;
          this.lastSpace = now;
        }
        if (e.code === 'KeyW') {
          if (now - this.lastW < 300) this.doubleW = true;
          this.lastW = now;
        }
      }
      this.down.add(e.code);
      if (this.onKey?.(e.code, e)) e.preventDefault();
      else if (this.locked && ['Space', 'Tab', 'ControlLeft', 'KeyQ', 'F1', 'F3'].includes(e.code)) e.preventDefault();
    });
    window.addEventListener('keyup', (e) => this.down.delete(e.code));
    window.addEventListener('blur', () => {
      this.down.clear();
      this.mouse = [false, false, false];
    });
    canvas.addEventListener('mousedown', (e) => {
      if (!this.locked) return;
      this.mouse[e.button] = true;
      this.clicked[e.button] = true;
    });
    window.addEventListener('mouseup', (e) => {
      this.mouse[e.button] = false;
    });
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    window.addEventListener('mousemove', (e) => {
      if (!this.locked) return;
      this.dx += e.movementX;
      this.dy += e.movementY;
    });
    window.addEventListener('wheel', (e) => {
      if (this.locked) this.wheel += Math.sign(e.deltaY);
    }, { passive: true });
    document.addEventListener('pointerlockchange', () => {
      this.locked = document.pointerLockElement === canvas;
      if (!this.locked) {
        this.mouse = [false, false, false];
        this.down.clear();
      }
      this.onLockChange?.(this.locked);
    });
    document.addEventListener('pointerlockerror', () => this.onLockError?.());
  }

  lock() {
    try {
      const p = this.canvas.requestPointerLock?.({ unadjustedMovement: false });
      if (p?.catch) p.catch(() => this.onLockError?.());
    } catch {
      this.onLockError?.();
    }
  }

  unlock() {
    if (document.pointerLockElement) document.exitPointerLock();
  }

  isDown(code) {
    return this.down.has(code);
  }

  wasPressed(code) {
    return this.pressed.has(code);
  }

  endFrame() {
    this.pressed.clear();
    this.clicked = [false, false, false];
    this.dx = 0;
    this.dy = 0;
    this.wheel = 0;
    this.doubleSpace = false;
    this.doubleW = false;
  }
}
