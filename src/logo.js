// The title logo: chunky stone letters with a dark 3D edge underneath, drawn pixel by
// pixel like Minecraft's. Each letter is its own canvas so the letters can drop in
// one after another (see .logo .ch in style.css).

// Letters on a 6 x 7 grid with two-pixel strokes. Only the ones the logo uses.
const LETTERS = {
  B: ['#####.', '##..##', '##..##', '#####.', '##..##', '##..##', '#####.'],
  L: ['##....', '##....', '##....', '##....', '##....', '##....', '######'],
  O: ['.####.', '##..##', '##..##', '##..##', '##..##', '##..##', '.####.'],
  C: ['.#####', '##....', '##....', '##....', '##....', '##....', '.#####'],
  K: ['##..##', '##.##.', '####..', '###...', '####..', '##.##.', '##..##'],
  R: ['#####.', '##..##', '##..##', '#####.', '####..', '##.##.', '##..##'],
  A: ['.####.', '##..##', '##..##', '######', '##..##', '##..##', '##..##'],
  F: ['######', '##....', '##....', '#####.', '##....', '##....', '##....'],
  T: ['######', '..##..', '..##..', '..##..', '..##..', '..##..', '..##..'],
};
const ROWS = 7;

// The pixel size that fits the whole word in the space available.
function cellSize(text, maxWidth) {
  const cells = [...text].reduce((n, ch) => n + (LETTERS[ch]?.[0].length ?? 3) + 1, 0);
  return Math.max(3, Math.min(10, Math.floor(maxWidth / (cells + 1))));
}

function drawLetter(canvas, rows, s, stone) {
  const w = rows[0].length;
  const o = Math.max(2, Math.round(s / 4)); // black outline
  const depth = Math.round(s * 1.1); // the 3D edge below each pixel
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const cw = w * s + o * 2;
  const ch = ROWS * s + depth + o * 2;
  canvas.width = Math.round(cw * dpr);
  canvas.height = Math.round(ch * dpr);
  canvas.style.width = `${cw}px`;
  canvas.style.height = `${ch}px`;
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = false;
  ctx.setTransform(dpr, 0, 0, dpr, o * dpr, o * dpr);
  const on = (x, y) => y >= 0 && y < ROWS && x >= 0 && x < w && rows[y][x] === '#';
  const cells = [];
  for (let y = 0; y < ROWS; y++) for (let x = 0; x < w; x++) if (on(x, y)) cells.push([x, y]);

  // Outline, then the dark edge, then the stone face on top.
  ctx.fillStyle = '#000';
  for (const [x, y] of cells) ctx.fillRect(x * s - o, y * s - o, s + o * 2, s + depth + o * 2);
  for (const [x, y] of cells) {
    ctx.fillStyle = '#3b3b3b';
    ctx.fillRect(x * s, y * s, s, s + depth);
    if (!on(x, y + 1)) {
      // Bottom edge: lighter near the face, darker below.
      ctx.fillStyle = '#4a4a4a';
      ctx.fillRect(x * s, (y + 1) * s, s, Math.ceil(depth / 3));
      ctx.fillStyle = '#262626';
      ctx.fillRect(x * s, (y + 1) * s + Math.ceil((depth * 2) / 3), s, depth - Math.ceil((depth * 2) / 3));
    }
  }
  if (stone) {
    // One texture pixel is a quarter of a letter pixel, like Minecraft's logo.
    const t = document.createElement('canvas');
    const k = Math.max(1, Math.round((s / 4) * dpr));
    t.width = stone.width * k;
    t.height = stone.height * k;
    const tc = t.getContext('2d');
    tc.imageSmoothingEnabled = false;
    tc.drawImage(stone, 0, 0, t.width, t.height);
    const pattern = ctx.createPattern(t, 'repeat');
    pattern.setTransform(new DOMMatrix().scale(1 / dpr));
    ctx.fillStyle = pattern;
  } else {
    ctx.fillStyle = '#8f8f8f';
  }
  for (const [x, y] of cells) ctx.fillRect(x * s, y * s, s, s);
  // Bevel: light where open sky is above or to the left, shade below and right.
  const b = Math.max(1, Math.round(s / 4));
  for (const [x, y] of cells) {
    if (!on(x, y - 1)) { ctx.fillStyle = 'rgba(255, 255, 255, 0.38)'; ctx.fillRect(x * s, y * s, s, b); }
    if (!on(x - 1, y)) { ctx.fillStyle = 'rgba(255, 255, 255, 0.2)'; ctx.fillRect(x * s, y * s, b, s); }
    if (!on(x + 1, y)) { ctx.fillStyle = 'rgba(0, 0, 0, 0.22)'; ctx.fillRect((x + 1) * s - b, y * s, b, s); }
    if (!on(x, y + 1)) { ctx.fillStyle = 'rgba(0, 0, 0, 0.3)'; ctx.fillRect(x * s, (y + 1) * s - b, s, b); }
  }
}

// Fill `el` with the word as letter canvases; redraws at a new size when the window
// changes.
export function buildLogo(el, text, stone) {
  el.textContent = '';
  const letters = [...text].map((ch, i) => {
    const c = document.createElement('canvas');
    c.className = 'ch';
    c.style.setProperty('--i', i);
    c.setAttribute('aria-hidden', 'true');
    el.append(c);
    return [c, LETTERS[ch]];
  });
  let size = 0;
  const draw = () => {
    const s = cellSize(text, Math.min(window.innerWidth - 32, 760));
    if (s === size) return;
    size = s;
    el.style.setProperty('--gap', `${Math.max(1, s - Math.max(2, Math.round(s / 4)) * 2)}px`);
    for (const [c, rows] of letters) if (rows) drawLetter(c, rows, s, stone);
  };
  draw();
  window.addEventListener('resize', draw);
}
