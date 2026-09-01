# Clawd Jump Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a single-file HTML5 Canvas platformer starring Clawd and deploy it to S3 + CloudFront with CDK.

**Architecture:** One `frontend/index.html` containing all HTML, CSS and JS. A flat
module of plain-object state (`clawd`, `cam`, `game`) driven by a fixed-timestep
accumulator loop. Physics uses axis-separated AABB resolution against a tile map of
strings. Deployment is a private S3 bucket fronted by CloudFront with Origin Access
Control, uploaded by `BucketDeployment`.

**Tech Stack:** Vanilla JS (no libraries, no build step), HTML5 Canvas 2D, AWS CDK v2 (TypeScript), Playwright MCP for smoke checks.

**Spec:** `docs/superpowers/specs/2026-09-01-clawd-jump-design.md`

## Global Constraints

- `frontend/index.html` is the entire game: one HTML file, one inline `<style>`, one inline `<script>`. No external libraries. No external requests of any kind.
- Logical resolution exactly 640x360 (`<canvas width="640" height="360">`). CSS upscales; `image-rendering: pixelated`.
- `CLAWD` (12x8) and `PALETTE` (`{ A: "#D97757", B: "#14130F" }`) are copied verbatim from the requirements. Never restyle Clawd.
- Cell size `CELL = 3`. Tile size `TILE = 16`.
- Coyote time `COYOTE = 0.10`s. Jump buffer `BUFFER = 0.10`s.
- Physics: `GRAVITY 1400`, `MAX_FALL 620`, `ACCEL 900`, `FRICTION 1400`, `MAX_RUN 140`, `JUMP_VY -420`, `JUMP_CUT 0.4`, `STEP 1/60`, `MAX_STEPS 5`.
- Clawd collision box is `BOX_W 30` x `BOX_H 24`; sprite is 36x24; `SPRITE_OFF = 3`.
- Controls: `ArrowLeft` / `ArrowRight` move, `Space` jumps, `KeyR` restarts.
- Coins are score only. The flag is never locked.
- **No unit tests.** Every task is verified by a Playwright MCP smoke check plus a human manual-play checkpoint.
- Phase order is fixed and must not be reordered: Phase 1 (Tasks 1-3) engine, Phase 2 (Tasks 4-5) level/collision/camera, Phase 3 (Tasks 6-8) entities/HUD, Phase 4 (Tasks 9-10) deploy.
- The game must expose `window.__game` for smoke checks. This is the only concession to testability in the game file.
- Commit after every task.

## Local Verification Harness

Started once in Task 1 and reused by every later task:

```bash
python3 -m http.server 8765 --directory frontend >/dev/null 2>&1 &
```

Page URL for all Playwright MCP calls: `http://localhost:8765/index.html`

Playwright MCP tools used: `browser_navigate`, `browser_press_key`, `browser_evaluate`,
`browser_take_screenshot`, `browser_console_messages`.

**Note on key handling:** the game listens on `window`, so `browser_press_key` works
without focusing an element. `browser_press_key` sends a press-and-release, so it
cannot express "hold ArrowRight for 1 second". For held input, use `browser_evaluate`
to dispatch raw events, e.g.:

```js
() => {
  dispatchEvent(new KeyboardEvent('keydown', { code: 'ArrowRight' }));
  return true;
}
```

and a matching `keyup` dispatch to release.

---

### Task 1: HTML shell, canvas scaling, fixed-timestep loop

**Files:**
- Create: `frontend/index.html`

**Interfaces:**
- Consumes: nothing.
- Produces: `W`, `H`, `TILE`, `CELL`, all physics constants, `CLAWD`, `PALETTE`,
  `SPRITE_W`, `SPRITE_H`, `BOX_W`, `BOX_H`, `SPRITE_OFF`, colour constants,
  `canvas`, `ctx`, `clamp(v, lo, hi)`, `game` (`{ state, coins, t }`),
  `render()`, `step(dt)`, `frame(now)`, `window.__game`.

- [ ] **Step 1: Create the file with shell, CONFIG and a running loop**

Create `frontend/index.html`:

```html
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Clawd Jump</title>
<style>
  html, body {
    margin: 0;
    height: 100%;
    background: #14130F;
    display: flex;
    align-items: center;
    justify-content: center;
    font-family: monospace;
  }
  canvas {
    display: block;
    width: 100%;
    max-width: 1280px;
    aspect-ratio: 16 / 9;
    image-rendering: pixelated;
  }
</style>
</head>
<body>
<canvas id="game" width="640" height="360"></canvas>
<script>
/* ============================== CONFIG ============================== */
const W = 640, H = 360, TILE = 16, CELL = 3;

const GRAVITY = 1400, MAX_FALL = 620;
const ACCEL = 900, FRICTION = 1400, MAX_RUN = 140;
const JUMP_VY = -420, JUMP_CUT = 0.4;
const COYOTE = 0.10, BUFFER = 0.10;
const STEP = 1 / 60, MAX_STEPS = 5;

const CLAWD = [
  ".AAAAAAAAAA.",
  ".AAAAAAAAAA.",
  ".AABAAAABAA.",
  "AAAAAAAAAAAA",
  "AAAAAAAAAAAA",
  ".AAAAAAAAAA.",
  "..A.A..A.A..",
  "..A.A..A.A.."
];
const PALETTE = { A: "#D97757", B: "#14130F" };

const SPRITE_W = 12 * CELL, SPRITE_H = 8 * CELL;   /* 36 x 24 */
const BOX_W = 30, BOX_H = 24;
const SPRITE_OFF = (SPRITE_W - BOX_W) / 2;          /* 3 */

const C_SKY_TOP = "#F0EEE6", C_SKY_BOT = "#E3DDD0", C_HILL = "#CFC7B5";
const C_TERRAIN = "#3B3630", C_TERRAIN_CAP = "#5C554A";
const C_COIN = "#E8C547", C_COIN_HI = "#FFF3C4";
const C_SPIKE = "#9A9287";
const C_FLAG_POLE = "#14130F", C_FLAG_CLOTH = "#3F9E77";
const C_TEXT = "#14130F";

const canvas = document.getElementById("game");
const ctx = canvas.getContext("2d");
ctx.imageSmoothingEnabled = false;

function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

/* ============================== STATE =============================== */
const game = { state: "play", coins: 0, t: 0 };

/* ============================== PHYSICS ============================= */
function step(dt) {
  if (game.state !== "play") return;
}

/* ============================== RENDER ============================== */
let skyGrad = null;
function drawSky() {
  if (!skyGrad) {
    skyGrad = ctx.createLinearGradient(0, 0, 0, H);
    skyGrad.addColorStop(0, C_SKY_TOP);
    skyGrad.addColorStop(1, C_SKY_BOT);
  }
  ctx.fillStyle = skyGrad;
  ctx.fillRect(0, 0, W, H);
}

function render() {
  drawSky();
}

/* ============================== GAME =============================== */
let last = performance.now(), acc = 0;
function frame(now) {
  acc += (now - last) / 1000;
  last = now;
  let n = 0;
  while (acc >= STEP && n < MAX_STEPS) {
    game.t += STEP;
    step(STEP);
    acc -= STEP;
    n++;
  }
  if (acc > STEP * MAX_STEPS) acc = 0;
  render();
  requestAnimationFrame(frame);
}

window.__game = { game };
requestAnimationFrame(frame);
</script>
</body>
</html>
```

- [ ] **Step 2: Start the static server**

```bash
python3 -m http.server 8765 --directory frontend >/dev/null 2>&1 &
sleep 1
curl -s -o /dev/null -w '%{http_code}\n' http://localhost:8765/index.html
```

Expected: `200`

- [ ] **Step 3: Smoke check — page loads clean and the loop advances**

Playwright MCP:
1. `browser_navigate` to `http://localhost:8765/index.html`
2. `browser_console_messages` — expected: no errors
3. `browser_evaluate` with:

```js
async () => {
  const t0 = window.__game.game.t;
  await new Promise(r => setTimeout(r, 500));
  const t1 = window.__game.game.t;
  return { t0, t1, advanced: t1 - t0 };
}
```

Expected: `advanced` is roughly 0.45-0.55 (the accumulator tracks wall-clock).
If `advanced` is 0, `requestAnimationFrame` is not firing.

4. `browser_take_screenshot` — expected: a cream vertical gradient filling the frame.

- [ ] **Step 4: Manual play checkpoint**

Human opens the page and confirms: canvas is centred on a dark background, fills the
width up to 1280px, and holds a 16:9 shape when the window is resized.

- [ ] **Step 5: Commit**

```bash
git add frontend/index.html
git commit -m "feat(game): canvas shell with fixed-timestep loop"
```

---

### Task 2: Input and Clawd sprite rendering with horizontal flip

**Files:**
- Modify: `frontend/index.html` (add INPUT section; extend STATE and RENDER)

**Interfaces:**
- Consumes: `CLAWD`, `PALETTE`, `CELL`, `SPRITE_OFF`, `BOX_W`, `BOX_H`, `ctx`, `render()`.
- Produces: `keys` (Set of `KeyboardEvent.code`), `clawd`
  (`{ x, y, vx, vy, onGround, face, coyoteT, bufferT }`), `cam` (`{ x, y }`),
  `drawClawd()`, `blit(pattern, x, y, scale, color)`.

- [ ] **Step 1: Add the INPUT section**

Insert after the CONFIG section, before STATE:

```js
/* ============================== INPUT ============================== */
const keys = new Set();

addEventListener("keydown", e => {
  if (["ArrowLeft", "ArrowRight", "Space", "KeyR"].includes(e.code)) e.preventDefault();
  if (e.repeat) return;
  keys.add(e.code);
  if (e.code === "Space") clawd.bufferT = BUFFER;
  if (e.code === "KeyR") reset();
});

addEventListener("keyup", e => {
  keys.delete(e.code);
  if (e.code === "Space" && clawd.vy < 0) clawd.vy *= JUMP_CUT;
});
```

`e.repeat` is filtered so that holding `Space` does not refill the jump buffer every
OS key-repeat tick, which would let a held key re-trigger a jump the instant Clawd
lands. Jump cut lives in `keyup` rather than in `step()`: multiplying by 0.4 every
frame the key is up would compound to an instant halt instead of a shortened hop.

- [ ] **Step 2: Extend the STATE section**

Replace the STATE section with:

```js
/* ============================== STATE =============================== */
const clawd = {
  x: 300, y: 200, vx: 0, vy: 0,
  onGround: false, face: 1, coyoteT: 0, bufferT: 0
};
const cam = { x: 0, y: 0 };
const game = { state: "play", coins: 0, t: 0 };

function reset() {
  game.state = "play";
  game.coins = 0;
}
```

`reset()` is a stub here because the `keydown` handler already references it; it is
filled in as the level and entities land in later tasks.

- [ ] **Step 3: Add sprite rendering**

Add to the RENDER section, after `drawSky`:

```js
function blit(pattern, x, y, scale, color) {
  ctx.fillStyle = color;
  for (let r = 0; r < pattern.length; r++) {
    const row = pattern[r];
    for (let c = 0; c < row.length; c++) {
      if (row[c] === ".") continue;
      ctx.fillRect(x + c * scale, y + r * scale, scale, scale);
    }
  }
}

function drawClawd() {
  const x = Math.round(clawd.x - SPRITE_OFF - cam.x);
  const y = Math.round(clawd.y - cam.y);
  for (let r = 0; r < 8; r++) {
    const row = CLAWD[r];
    for (let c = 0; c < 12; c++) {
      const ch = row[clawd.face === 1 ? c : 11 - c];
      if (ch === ".") continue;
      ctx.fillStyle = PALETTE[ch];
      ctx.fillRect(x + c * CELL, y + r * CELL, CELL, CELL);
    }
  }
}
```

Clawd does not use `blit` because each cell picks its colour from `PALETTE` by
character, and because the flip is an index transform (`11 - c`) rather than a canvas
transform. Using `ctx.scale(-1, 1)` would require a `save`/`restore` pair every frame
and push draw coordinates negative, which defeats the integer snapping above.

- [ ] **Step 4: Draw Clawd and update the export**

Replace `render()` with:

```js
function render() {
  drawSky();
  drawClawd();
}
```

Replace the `window.__game` line with:

```js
window.__game = { game, clawd, cam, keys };
```

- [ ] **Step 5: Smoke check — sprite renders and flips**

Playwright MCP:
1. `browser_navigate` to `http://localhost:8765/index.html`
2. `browser_take_screenshot` — expected: a 36x24 orange Clawd with two dark eyes,
   on the cream gradient.
3. `browser_evaluate`:

```js
() => {
  const g = window.__game;
  const before = g.clawd.face;
  dispatchEvent(new KeyboardEvent('keydown', { code: 'ArrowLeft' }));
  return { before, keysHas: g.keys.has('ArrowLeft') };
}
```

Expected: `before` is 1 and `keysHas` is true. (`face` still flips only once
movement code exists in Task 3; this step verifies the key reaches the game.)

4. `browser_evaluate` to force a flip and confirm the render path handles it:

```js
() => { window.__game.clawd.face = -1; return window.__game.clawd.face; }
```

Then `browser_take_screenshot` — expected: the sprite still renders (this array is
horizontally symmetric, so the image is unchanged; the check is that no error is
thrown and the sprite does not disappear or shift).

5. `browser_console_messages` — expected: no errors.

- [ ] **Step 6: Manual play checkpoint**

Human confirms Clawd's pixels are crisp squares with no blur at the canvas's
upscaled size, and that arrow keys do not scroll the page.

- [ ] **Step 7: Commit**

```bash
git add frontend/index.html
git commit -m "feat(game): input handling and Clawd sprite rendering"
```

---

### Task 3: Gravity, AABB resolution, coyote time and jump buffer

**Files:**
- Modify: `frontend/index.html` (fill in PHYSICS; add a temporary flat floor)

**Interfaces:**
- Consumes: `clawd`, `keys`, all physics constants, `clamp`.
- Produces: `isSolid(c, r)`, `spansSolidV(c, top, bot)`, `spansSolidH(r, left, right)`,
  `moveX(d)`, `moveY(d)`, a working `step(dt)`.

Note: `isSolid` is introduced here against a **temporary** hardcoded floor so Phase 1
can be played before the level exists. Task 4 replaces its body with a map lookup and
keeps the signature identical.

- [ ] **Step 1: Replace the PHYSICS section**

```js
/* ============================== PHYSICS ============================= */
/* TEMPORARY: replaced by a map lookup in Task 4. Flat floor at row 21. */
function isSolid(c, r) {
  return r >= 21;
}

function spansSolidV(c, top, bot) {
  for (let r = Math.floor(top / TILE); r <= Math.floor(bot / TILE); r++)
    if (isSolid(c, r)) return true;
  return false;
}

function spansSolidH(r, left, right) {
  for (let c = Math.floor(left / TILE); c <= Math.floor(right / TILE); c++)
    if (isSolid(c, r)) return true;
  return false;
}

function moveX(d) {
  if (d === 0) return;
  clawd.x += d;
  const top = clawd.y, bot = clawd.y + BOX_H - 1;
  if (d > 0) {
    const c = Math.floor((clawd.x + BOX_W - 1) / TILE);
    if (spansSolidV(c, top, bot)) { clawd.x = c * TILE - BOX_W; clawd.vx = 0; }
  } else {
    const c = Math.floor(clawd.x / TILE);
    if (spansSolidV(c, top, bot)) { clawd.x = (c + 1) * TILE; clawd.vx = 0; }
  }
}

function moveY(d) {
  clawd.onGround = false;
  clawd.y += d;
  const left = clawd.x, right = clawd.x + BOX_W - 1;
  if (d > 0) {
    const r = Math.floor((clawd.y + BOX_H - 1) / TILE);
    if (spansSolidH(r, left, right)) {
      clawd.y = r * TILE - BOX_H;
      clawd.vy = 0;
      clawd.onGround = true;
    }
  } else if (d < 0) {
    const r = Math.floor(clawd.y / TILE);
    if (spansSolidH(r, left, right)) { clawd.y = (r + 1) * TILE; clawd.vy = 0; }
  }
}

function step(dt) {
  if (game.state !== "play") return;

  const dir = (keys.has("ArrowRight") ? 1 : 0) - (keys.has("ArrowLeft") ? 1 : 0);
  if (dir !== 0) {
    clawd.vx += dir * ACCEL * dt;
    clawd.face = dir;
  } else if (clawd.vx !== 0) {
    const s = Math.sign(clawd.vx);
    clawd.vx -= s * FRICTION * dt;
    if (Math.sign(clawd.vx) !== s) clawd.vx = 0;
  }
  clawd.vx = clamp(clawd.vx, -MAX_RUN, MAX_RUN);

  clawd.coyoteT = clawd.onGround ? COYOTE : Math.max(0, clawd.coyoteT - dt);
  clawd.bufferT = Math.max(0, clawd.bufferT - dt);

  if (clawd.bufferT > 0 && clawd.coyoteT > 0) {
    clawd.vy = JUMP_VY;
    clawd.bufferT = 0;
    clawd.coyoteT = 0;
    clawd.onGround = false;
  }

  clawd.vy = Math.min(clawd.vy + GRAVITY * dt, MAX_FALL);

  moveX(clawd.vx * dt);
  moveY(clawd.vy * dt);
}
```

Axis separation is why `moveX` and `moveY` are separate functions: resolving a
diagonal move in one pass leaves the push-out axis ambiguous and snags Clawd on
corners during wall-adjacent jumps. Probing a single tile column/row per axis is safe
because the largest per-step displacement is 2.33px horizontally and 10.33px
vertically, both under `TILE`.

- [ ] **Step 2: Smoke check — Clawd falls and lands on the temporary floor**

Playwright MCP `browser_navigate`, then `browser_evaluate`:

```js
async () => {
  await new Promise(r => setTimeout(r, 1200));
  const c = window.__game.clawd;
  return { y: c.y, vy: c.vy, onGround: c.onGround };
}
```

Expected: `y` is 312 (row 21 top is 336, minus `BOX_H` 24), `onGround` is true,
`vy` is a small positive value or 0.

- [ ] **Step 3: Smoke check — jump apex matches the designed 57px**

`browser_evaluate`:

```js
async () => {
  const c = window.__game.clawd;
  const ground = c.y;
  dispatchEvent(new KeyboardEvent('keydown', { code: 'Space' }));
  let min = ground;
  for (let i = 0; i < 60; i++) {
    await new Promise(r => requestAnimationFrame(r));
    if (c.y < min) min = c.y;
  }
  dispatchEvent(new KeyboardEvent('keyup', { code: 'Space' }));
  return { ground, min, apex: ground - min };
}
```

Expected: `apex` is 58-61 (discrete-Euler apex for JUMP_VY -420 is 59.5). A value near 28 means the `keyup` jump cut fired early;
a value near 0 means the buffer/coyote gate never opened.

- [ ] **Step 4: Smoke check — jump buffer accepts a press made just before landing**

The buffer must do two things: fire a jump for a press made slightly *before* Clawd
lands, and expire so an early press does not fire on a much later landing.

`browser_evaluate`:

```js
async () => {
  const c = window.__game.clawd;
  const frame = () => new Promise(r => requestAnimationFrame(r));

  /* negative case: press far too early - the buffer must expire before landing */
  dispatchEvent(new KeyboardEvent('keydown', { code: 'Space' }));
  dispatchEvent(new KeyboardEvent('keyup', { code: 'Space' }));
  while (c.vy <= 0) await frame();                 /* rise to apex */
  dispatchEvent(new KeyboardEvent('keydown', { code: 'Space' }));
  dispatchEvent(new KeyboardEvent('keyup', { code: 'Space' }));
  while (!c.onGround) await frame();               /* ~0.29s fall, buffer is 0.10s */
  await frame();
  const staleFired = c.vy < 0;

  /* positive case: airborne a few pixels above the floor, press now */
  c.y -= 6; c.vy = 100; c.onGround = false;
  dispatchEvent(new KeyboardEvent('keydown', { code: 'Space' }));
  const buffered = c.bufferT;
  for (let i = 0; i < 6; i++) await frame();
  dispatchEvent(new KeyboardEvent('keyup', { code: 'Space' }));

  return { staleFired, buffered, freshFired: c.vy < 0 || c.y < 312 };
}
```

Expected: `staleFired` is false, `buffered` is 0.1, `freshFired` is true.
`staleFired` true means the buffer never decays. `freshFired` false means the buffer
is consumed before the landing frame sets `onGround`.

- [ ] **Step 5: Smoke check — coyote time allows a jump just after leaving an edge**

`browser_evaluate`:

```js
() => {
  const c = window.__game.clawd;
  c.onGround = false;
  c.coyoteT = 0.05;
  c.vy = 10;
  c.bufferT = 0.1;
  return { coyoteBefore: c.coyoteT };
}
```

Then after one frame, `browser_evaluate` returning `window.__game.clawd.vy` —
expected: negative (the jump fired while airborne inside the coyote window).

- [ ] **Step 6: Manual play checkpoint**

Human plays and confirms: left/right accelerate and coast to a stop, jumping feels
responsive, tapping `Space` gives a shorter hop than holding it, and jumping right as
Clawd walks off an edge still works.

- [ ] **Step 7: Commit**

```bash
git add frontend/index.html
git commit -m "feat(game): gravity, AABB collision, coyote time and jump buffer"
```

---

### Task 4: Level map, tile lookup, tile rendering, real collision

**Files:**
- Modify: `frontend/index.html` (add LEVEL section; replace temporary `isSolid`; add `drawTiles`)

**Interfaces:**
- Consumes: `TILE`, `ctx`, colour constants, `blit`, `clawd`, `cam`, `game`.
- Produces: `MAP_SRC`, `ROWS`, `COLS`, `LEVEL_W`, `LEVEL_H`, `map` (mutable char grid),
  `loadMap()`, `tileAt(c, r)`, `isSolid(c, r)`, `findTile(ch)`, `countTile(ch)`,
  `SPAWN` (`{ c, r }`), `COIN_TOTAL`, `COIN`, `SPIKE` sprite patterns,
  `drawTiles()`, `drawFlag(x, y)`, `respawn()`, a real `reset()`.

- [ ] **Step 1: Add the LEVEL section**

Insert a new section between CONFIG and INPUT:

```js
/* ============================== LEVEL ============================== */
const COIN = [
  "..XXXX..",
  ".XXXXXX.",
  "XXXXXXXX",
  "XXXXXXXX",
  "XXXXXXXX",
  "XXXXXXXX",
  ".XXXXXX.",
  "..XXXX.."
];
const SPIKE = [
  "...X........X...",
  "...X........X...",
  "..XXX......XXX..",
  "..XXX......XXX..",
  ".XXXXX....XXXXX.",
  ".XXXXX....XXXXX.",
  "XXXXXXX..XXXXXXX",
  "XXXXXXX..XXXXXXX"
];

const MAP_SRC = [
  "....................................................................................................",
  "....................................................................................................",
  "....................................................................................................",
  "....................................................................................................",
  "....................................................................................................",
  "....................................................................................................",
  "....................................................................................................",
  "....................................................................................................",
  "....................................................................................................",
  "....................................................................................................",
  "....................................................................................................",
  "....................................................................................................",
  "....................................................................................................",
  "....................................................................................................",
  "....................................................................................................",
  ".........................................................C....C....................................",
  ".............................................C......C...XXX..XXX....................................",
  ".............................CC...........C.XXXXX..XXX................XXXXXXXXX..............C...F..",
  "...................C........XXXX.......C.XXXXXXXX...........................................XXXXXXXX",
  "......................................XXXXXXXXXXX....................................C..XXX.....XXXX",
  "..S....C..C....XXX.......^^......^.XXXXXXXXXXXXXX...................^...C...C....^..XXX.XXX.....XXXX",
  "XXXXXXXXXXXXXXXXXX...XXXXXXXXXXXXXXXXXXXXXXXXXXXX.................XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
  "XXXXXXXXXXXXXXXXXX...XXXXXXXXXXXXXXXXXXXXXXXXXXXX.................XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX"
];

const ROWS = MAP_SRC.length, COLS = MAP_SRC[0].length;
const LEVEL_W = COLS * TILE, LEVEL_H = ROWS * TILE;

let map = [];
function loadMap() { map = MAP_SRC.map(row => row.split("")); }

function tileAt(c, r) {
  if (c < 0 || c >= COLS || r < 0 || r >= ROWS) return ".";
  return map[r][c];
}

function findTile(ch) {
  for (let r = 0; r < ROWS; r++)
    for (let c = 0; c < COLS; c++)
      if (MAP_SRC[r][c] === ch) return { c: c, r: r };
  return null;
}

function countTile(ch) {
  let n = 0;
  for (let r = 0; r < ROWS; r++)
    for (let c = 0; c < COLS; c++)
      if (MAP_SRC[r][c] === ch) n++;
  return n;
}

const SPAWN = findTile("S");
const COIN_TOTAL = countTile("C");
```

`COIN_TOTAL` is counted rather than hardcoded so editing the map cannot desync the
HUD denominator. `findTile`/`countTile` read `MAP_SRC`, not `map`, because `map` is
mutated when coins are collected.

- [ ] **Step 2: Replace the temporary `isSolid`**

In the PHYSICS section, delete the temporary implementation and its comment, and
replace with:

```js
function isSolid(c, r) {
  if (c < 0 || c >= COLS) return true;
  if (r < 0 || r >= ROWS) return false;
  return map[r][c] === "X";
}
```

Out-of-range columns are solid, giving invisible walls at both level edges.
`r < 0` is open sky. `r >= ROWS` is deliberately **not** solid: falling out of the
level must be a death in Task 7, not a landing.

- [ ] **Step 3: Add spawn and reset to the STATE section**

Replace the stub `reset()` with:

```js
function respawn() {
  clawd.x = SPAWN.c * TILE + TILE / 2 - BOX_W / 2;
  clawd.y = (SPAWN.r + 1) * TILE - BOX_H;
  clawd.vx = 0;
  clawd.vy = 0;
  clawd.onGround = false;
  clawd.face = 1;
  clawd.coyoteT = 0;
  clawd.bufferT = 0;
}

function reset() {
  loadMap();
  game.state = "play";
  game.coins = 0;
  respawn();
}
```

Clawd's 30px box is centred on the 16px `S` tile, and his feet are placed on that
tile's bottom edge, which is the ground surface.

- [ ] **Step 4: Add tile rendering**

Add to the RENDER section, after `blit`:

```js
function drawFlag(x, y) {
  ctx.fillStyle = C_FLAG_POLE;
  ctx.fillRect(x + 3, y - 12, 2, TILE + 12);
  ctx.fillStyle = C_FLAG_CLOTH;
  for (let i = 0; i < 9; i++) ctx.fillRect(x + 5, y - 11 + i, 9 - i, 1);
}

function drawTiles() {
  const cx = Math.round(cam.x), cy = Math.round(cam.y);
  const c0 = Math.max(0, Math.floor(cx / TILE));
  const c1 = Math.min(COLS - 1, Math.floor((cx + W) / TILE));
  const r0 = Math.max(0, Math.floor(cy / TILE));
  const r1 = Math.min(ROWS - 1, Math.floor((cy + H) / TILE));
  for (let r = r0; r <= r1; r++) {
    for (let c = c0; c <= c1; c++) {
      const t = map[r][c];
      if (t === "." || t === "S") continue;
      const x = c * TILE - cx, y = r * TILE - cy;
      if (t === "X") {
        ctx.fillStyle = C_TERRAIN;
        ctx.fillRect(x, y, TILE, TILE);
        if (!isSolid(c, r - 1)) {
          ctx.fillStyle = C_TERRAIN_CAP;
          ctx.fillRect(x, y, TILE, 4);
        }
      } else if (t === "C") {
        const bob = Math.round(Math.sin(game.t * 3 + c) * 1.5);
        blit(COIN, x + 4, y + 4 + bob, 1, C_COIN);
        ctx.fillStyle = C_COIN_HI;
        ctx.fillRect(x + 6, y + 6 + bob, 2, 2);
      } else if (t === "^") {
        blit(SPIKE, x, y + 8, 1, C_SPIKE);
      } else if (t === "F") {
        drawFlag(x, y);
      }
    }
  }
}
```

Only the visible tile window is iterated, so the empty upper 15 rows cost nothing.
The 4px cap is drawn only where the tile above is not solid, which outlines terrain
surfaces without a second tile glyph.

- [ ] **Step 5: Wire rendering and the map load**

Replace `render()` with:

```js
function render() {
  drawSky();
  drawTiles();
  drawClawd();
}
```

Replace the two lines at the bottom of the GAME section:

```js
window.__game = { game, clawd, cam, keys, get map() { return map; }, COIN_TOTAL, SPAWN, LEVEL_W, LEVEL_H, ROWS, COLS };
reset();
requestAnimationFrame(frame);
```

`map` is exposed through a getter because `loadMap()` rebinds the variable on every
reset; a plain property would freeze the first grid.

- [ ] **Step 6: Smoke check — map integrity**

`browser_navigate`, then `browser_evaluate`:

```js
() => {
  const g = window.__game;
  const widths = new Set(g.map.map(r => r.length));
  return {
    rows: g.ROWS, cols: g.COLS,
    uniformWidth: widths.size === 1,
    coinTotal: g.COIN_TOTAL,
    spawn: g.SPAWN,
    glyphs: [...new Set(g.map.flat())].sort().join('')
  };
}
```

Expected: `rows` 23, `cols` 100, `uniformWidth` true, `coinTotal` 15,
`spawn` `{c: 2, r: 20}`, `glyphs` exactly `.CFSX^`.

- [ ] **Step 7: Smoke check — Clawd spawns standing and collides with terrain**

`browser_evaluate`:

```js
async () => {
  const c = window.__game.clawd;
  const spawn = { x: c.x, y: c.y };
  dispatchEvent(new KeyboardEvent('keydown', { code: 'ArrowRight' }));
  await new Promise(r => setTimeout(r, 3000));
  dispatchEvent(new KeyboardEvent('keyup', { code: 'ArrowRight' }));
  await new Promise(r => setTimeout(r, 400));
  return { spawn, after: { x: c.x, y: c.y, onGround: c.onGround } };
}
```

Expected: `spawn` is `{x: 25, y: 312}`. `after.onGround` is true and `after.x` is
greater than 200 — Clawd ran right along the ground. He will be stopped by the
3-tile gap at cols 18-20 (falling in) or standing against the step; either is fine,
`onGround` must be true and `after.y` must not exceed `LEVEL_H`.

- [ ] **Step 8: Smoke check — terrain is impassable**

`browser_evaluate`:

```js
() => {
  const g = window.__game;
  /* drop Clawd inside the far-right solid block and confirm push-out on the next frames */
  g.clawd.x = 97 * 16;
  g.clawd.y = 21 * 16;
  g.clawd.vx = 0; g.clawd.vy = 0;
  return { placed: { x: g.clawd.x, y: g.clawd.y } };
}
```

Then after ~10 frames, `browser_evaluate` returning `window.__game.clawd.y` —
expected: 264 or less is wrong; the box must be pushed to rest on a surface, i.e.
`y` equals `18 * 16 - 24` = 264 only if resolved upward. Accept any value where
`onGround` is true and `y <= 312`. A value increasing without bound means push-out
failed.

- [ ] **Step 9: Screenshot check**

`browser_take_screenshot` — expected: dark terrain with lighter top caps, gold coins,
grey spike triangles sitting on the ground, and Clawd standing near the left edge.

- [ ] **Step 10: Manual play checkpoint**

Human runs right, jumps the 3-tile gap, and confirms terrain feels solid: no falling
through floors, no sticking to walls, head bumps stop upward motion.

- [ ] **Step 11: Commit**

```bash
git add frontend/index.html
git commit -m "feat(game): tile map, tile rendering and map-driven collision"
```

---

### Task 5: Camera follow with clamping, and parallax background

**Files:**
- Modify: `frontend/index.html` (add `updateCamera`, `drawHills`)

**Interfaces:**
- Consumes: `clawd`, `cam`, `clamp`, `LEVEL_W`, `LEVEL_H`, `W`, `H`, `ctx`, `C_HILL`.
- Produces: `updateCamera()`, `drawHills()`.

- [ ] **Step 1: Add the camera**

Add at the end of the PHYSICS section:

```js
function updateCamera() {
  cam.x = clamp(clawd.x + BOX_W / 2 - W / 2, 0, LEVEL_W - W);
  cam.y = clamp(clawd.y + BOX_H / 2 - H / 2, 0, LEVEL_H - H);
}
```

Call it as the last line of `step(dt)`, after `moveY(...)`:

```js
  moveY(clawd.vy * dt);
  updateCamera();
}
```

Also call it as the last line of `respawn()` so a respawn does not render one frame
with a stale camera:

```js
  clawd.bufferT = 0;
  updateCamera();
}
```

The vertical clamp range is only `368 - 360 = 8`px, so the camera behaves as a fixed
one today. Using the same formula on both axes means raising the map height later
turns on real vertical scrolling with no code change.

- [ ] **Step 2: Add the parallax hill layer**

Add to the RENDER section, after `drawSky`:

```js
function drawHills() {
  ctx.fillStyle = C_HILL;
  const off = cam.x * 0.35;
  for (let x = 0; x < W; x += 2) {
    const k = x + off;
    const h = 46 + 20 * Math.sin(k * 0.010) + 12 * Math.sin(k * 0.027);
    ctx.fillRect(x, 300 - h, 2, h + 68);
  }
}
```

Two summed sines sampled every 2px produce a non-repeating ridge with no artwork and
no extra requests. It is drawn before the tiles so terrain occludes its base.

- [ ] **Step 3: Insert it into the render order**

```js
function render() {
  drawSky();
  drawHills();
  drawTiles();
  drawClawd();
}
```

- [ ] **Step 4: Smoke check — camera clamps at both ends**

`browser_evaluate`:

```js
async () => {
  const g = window.__game;
  const out = {};
  g.clawd.x = 25; g.clawd.y = 312;
  await new Promise(r => requestAnimationFrame(r));
  out.atLeft = { camX: g.cam.x, camY: g.cam.y };
  g.clawd.x = 1500;
  await new Promise(r => requestAnimationFrame(r));
  out.atRight = { camX: g.cam.x };
  g.clawd.x = 800;
  await new Promise(r => requestAnimationFrame(r));
  out.middle = { camX: g.cam.x };
  out.maxCamX = g.LEVEL_W - 640;
  return out;
}
```

Expected: `atLeft.camX` is 0, `atLeft.camY` is 8, `atRight.camX` is 960
(`maxCamX`), `middle.camX` is 495.

- [ ] **Step 5: Screenshot check at two positions**

Set `clawd.x = 25` then screenshot; set `clawd.x = 1450` then screenshot.
Expected: the two frames show different level geometry and a visibly different hill
ridge, confirming the parallax layer scrolls slower than the tiles.

- [ ] **Step 6: Manual play checkpoint**

Human runs from the left edge to the right end and confirms the camera follows
smoothly, does not scroll past either level edge, and the hills drift slower than the
ground.

- [ ] **Step 7: Commit**

```bash
git add frontend/index.html
git commit -m "feat(game): camera follow with clamping and parallax hills"
```

---

### Task 6: Coin pickup and HUD

**Files:**
- Modify: `frontend/index.html` (add ENTITIES section; add `drawHud`)

**Interfaces:**
- Consumes: `clawd`, `game`, `map`, `tileAt`, `COIN_TOTAL`, `ctx`, `C_TEXT`.
- Produces: `checkTriggers()`, `drawHud()`.

- [ ] **Step 1: Add the ENTITIES section**

Insert between PHYSICS and RENDER:

```js
/* ============================== ENTITIES =========================== */
function checkTriggers() {
  const c0 = Math.floor(clawd.x / TILE);
  const c1 = Math.floor((clawd.x + BOX_W - 1) / TILE);
  const r0 = Math.floor(clawd.y / TILE);
  const r1 = Math.floor((clawd.y + BOX_H - 1) / TILE);
  for (let r = r0; r <= r1; r++) {
    for (let c = c0; c <= c1; c++) {
      if (tileAt(c, r) === "C") {
        map[r][c] = ".";
        game.coins++;
      }
    }
  }
}
```

- [ ] **Step 2: Call it from `step`**

In `step(dt)`, insert between `moveY(...)` and `updateCamera()`:

```js
  moveY(clawd.vy * dt);
  checkTriggers();
  updateCamera();
```

- [ ] **Step 3: Add the HUD**

Add to the RENDER section, after `drawClawd`:

```js
function drawHud() {
  ctx.fillStyle = C_TEXT;
  ctx.font = "bold 12px monospace";
  ctx.textAlign = "left";
  ctx.textBaseline = "top";
  ctx.fillText("COINS " + game.coins + "/" + COIN_TOTAL, 8, 8);
}
```

Then:

```js
function render() {
  drawSky();
  drawHills();
  drawTiles();
  drawClawd();
  drawHud();
}
```

Canvas text is antialiased and will not be pixel-perfect. That is an accepted
tradeoff from the spec: a bitmap font is out of budget, and 12px monospace stays
legible once the canvas is upscaled.

- [ ] **Step 4: Smoke check — a coin is collected exactly once**

`browser_evaluate`:

```js
async () => {
  const g = window.__game;
  /* the first tutorial coin is at col 7, row 20 */
  g.clawd.x = 7 * 16 + 8 - 15;
  g.clawd.y = 21 * 16 - 24;
  g.clawd.vx = 0; g.clawd.vy = 0;
  const before = g.game.coins;
  await new Promise(r => setTimeout(r, 200));
  const after = g.game.coins;
  const tile = g.map[20][7];
  await new Promise(r => setTimeout(r, 200));
  return { before, after, tile, stable: g.game.coins };
}
```

Expected: `after` is `before + 1`, `tile` is `.`, `stable` equals `after` (standing
on a collected coin must not keep incrementing).

- [ ] **Step 5: Smoke check — HUD denominator comes from the map**

`browser_evaluate` returning `window.__game.COIN_TOTAL` — expected: 15.
Then `browser_take_screenshot` — expected: `COINS 1/15` at the top-left.

- [ ] **Step 6: Manual play checkpoint**

Human collects several coins and confirms the counter increments once per coin, coins
visibly disappear, and the bob animation reads as intended.

- [ ] **Step 7: Commit**

```bash
git add frontend/index.html
git commit -m "feat(game): coin pickup and coin HUD"
```

---

### Task 7: Spike death, void death, respawn

**Files:**
- Modify: `frontend/index.html` (extend `checkTriggers`)

**Interfaces:**
- Consumes: `clawd`, `respawn`, `tileAt`, `LEVEL_H`, `TILE`, `BOX_H`.
- Produces: `die()`; `checkTriggers()` gains spike and void handling.

- [ ] **Step 1: Add `die` and extend `checkTriggers`**

Replace the ENTITIES section with:

```js
/* ============================== ENTITIES =========================== */
function die() {
  respawn();
}

function checkTriggers() {
  if (clawd.y > LEVEL_H) { die(); return; }

  const c0 = Math.floor(clawd.x / TILE);
  const c1 = Math.floor((clawd.x + BOX_W - 1) / TILE);
  const r0 = Math.floor(clawd.y / TILE);
  const r1 = Math.floor((clawd.y + BOX_H - 1) / TILE);
  for (let r = r0; r <= r1; r++) {
    for (let c = c0; c <= c1; c++) {
      const t = tileAt(c, r);
      if (t === "C") {
        map[r][c] = ".";
        game.coins++;
      } else if (t === "^") {
        /* the spike sprite only occupies the lower half of its tile, so the
           hurtbox must too - otherwise clearing a spike by a few pixels of
           daylight would still kill. */
        if (clawd.y + BOX_H > r * TILE + 8) { die(); return; }
      }
    }
  }
}
```

Collected coins are **not** restored by `die()`, because `die()` calls `respawn()`
and only `reset()` calls `loadMap()`. That is the intended rule from the spec: death
carries no coin penalty.

- [ ] **Step 2: Smoke check — a spike kills and respawns**

`browser_evaluate`:

```js
async () => {
  const g = window.__game;
  /* first spike pair is at cols 25-26, row 20 */
  g.clawd.x = 25 * 16;
  g.clawd.y = 21 * 16 - 24;
  g.clawd.vx = 0; g.clawd.vy = 0;
  await new Promise(r => setTimeout(r, 200));
  return { x: g.clawd.x, y: g.clawd.y, spawnX: g.SPAWN.c };
}
```

Expected: `x` is 25 and `y` is 312 — Clawd is back at spawn.

- [ ] **Step 3: Smoke check — the spike hurtbox is only the lower half**

`browser_evaluate`:

```js
async () => {
  const g = window.__game;
  /* sit just above the spike tip: box bottom at r*TILE + 7 */
  g.clawd.x = 25 * 16;
  g.clawd.y = 20 * 16 + 7 - 24;
  g.clawd.vy = -1;
  const placed = g.clawd.y;
  await new Promise(r => requestAnimationFrame(r));
  return { placed, y: g.clawd.y, survived: g.clawd.y < 300 };
}
```

Expected: `survived` is true — one frame above the tip does not kill.

- [ ] **Step 4: Smoke check — falling out of the level respawns**

`browser_evaluate`:

```js
async () => {
  const g = window.__game;
  const coinsBefore = g.game.coins;
  /* the death pit spans cols 49-65 */
  g.clawd.x = 56 * 16;
  g.clawd.y = 300;
  g.clawd.vy = 0;
  await new Promise(r => setTimeout(r, 1500));
  return { x: g.clawd.x, y: g.clawd.y, coinsBefore, coinsAfter: g.game.coins };
}
```

Expected: `x` is 25, `y` is 312, and `coinsAfter` equals `coinsBefore` — coins
survive death.

- [ ] **Step 5: Manual play checkpoint**

Human walks into a spike, jumps over a spike, and falls into the pit at cols 49-65.
Confirms all three respawn at the start with the coin count preserved.

- [ ] **Step 6: Commit**

```bash
git add frontend/index.html
git commit -m "feat(game): spike and void death with respawn"
```

---

### Task 8: Flag, CLEAR state, R restart

**Files:**
- Modify: `frontend/index.html` (extend `checkTriggers`; add `drawClear`)

**Interfaces:**
- Consumes: `game`, `tileAt`, `ctx`, `W`, `H`, `C_TEXT`, `COIN_TOTAL`, `reset`.
- Produces: `drawClear()`; `checkTriggers()` gains flag handling; `render()` branches on `game.state`.

- [ ] **Step 1: Handle the flag**

In `checkTriggers()`, add a final branch to the glyph chain, after the `"^"` branch:

```js
      } else if (t === "F") {
        game.state = "clear";
        return;
      }
```

`step(dt)` already returns early when `game.state !== "play"`, so reaching the flag
freezes physics without any extra guard.

- [ ] **Step 2: Add the CLEAR overlay**

Add to the RENDER section, after `drawHud`:

```js
function drawClear() {
  ctx.fillStyle = "rgba(240,238,230,0.88)";
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = C_TEXT;
  ctx.textAlign = "center";
  ctx.textBaseline = "top";
  ctx.font = "bold 32px monospace";
  ctx.fillText("CLEAR!", W / 2, 120);
  ctx.font = "bold 14px monospace";
  ctx.fillText("COINS " + game.coins + " / " + COIN_TOTAL, W / 2, 178);
  ctx.fillText("press R to restart", W / 2, 206);
  ctx.textAlign = "left";
}
```

- [ ] **Step 3: Branch the render**

```js
function render() {
  drawSky();
  drawHills();
  drawTiles();
  drawClawd();
  if (game.state === "clear") drawClear();
  else drawHud();
}
```

- [ ] **Step 4: Smoke check — flag sets CLEAR and freezes physics**

`browser_evaluate`:

```js
async () => {
  const g = window.__game;
  /* the flag is at col 97, row 17; the surface is row 18 */
  g.clawd.x = 97 * 16;
  g.clawd.y = 18 * 16 - 24;
  g.clawd.vx = 0; g.clawd.vy = 0;
  await new Promise(r => setTimeout(r, 200));
  const state = g.game.state;
  const frozenAt = g.clawd.x;
  dispatchEvent(new KeyboardEvent('keydown', { code: 'ArrowLeft' }));
  await new Promise(r => setTimeout(r, 300));
  dispatchEvent(new KeyboardEvent('keyup', { code: 'ArrowLeft' }));
  return { state, frozenAt, x: g.clawd.x, frozen: g.clawd.x === frozenAt };
}
```

Expected: `state` is `"clear"` and `frozen` is true.

- [ ] **Step 5: Screenshot the CLEAR screen**

`browser_take_screenshot` — expected: a pale overlay with `CLEAR!`, the coin ratio,
and `press R to restart`.

- [ ] **Step 6: Smoke check — R performs a full reset from both states**

`browser_evaluate`:

```js
async () => {
  const g = window.__game;
  const cleared = g.game.state;
  dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyR' }));
  await new Promise(r => setTimeout(r, 200));
  const afterClear = { state: g.game.state, coins: g.game.coins, x: g.clawd.x, y: g.clawd.y };
  /* now collect a coin, then reset from the play state */
  g.clawd.x = 7 * 16 + 8 - 15;
  g.clawd.y = 21 * 16 - 24;
  await new Promise(r => setTimeout(r, 200));
  const withCoin = g.game.coins;
  dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyR' }));
  await new Promise(r => setTimeout(r, 200));
  return {
    cleared, afterClear, withCoin,
    afterPlay: { state: g.game.state, coins: g.game.coins, x: g.clawd.x },
    coinRestored: g.map[20][7] === 'C'
  };
}
```

Expected: `cleared` is `"clear"`; `afterClear` is
`{state: "play", coins: 0, x: 25, y: 312}`; `withCoin` is 1;
`afterPlay.coins` is 0; `coinRestored` is true (a full reset rebuilds the map).

- [ ] **Step 7: Full manual playthrough**

Human plays the level start to finish: collects coins, dies at least once, reaches
the flag, sees CLEAR with the correct ratio, presses R and confirms a clean restart.
This is the gate on physics feel — if the jump arc or run speed feels wrong, retune
the constants in CONFIG only and re-run Steps 4-7.

- [ ] **Step 8: Commit**

```bash
git add frontend/index.html
git commit -m "feat(game): flag goal, CLEAR screen and R restart"
```

---

### Task 9: CDK stack for S3 + CloudFront, verified by synth

**Files:**
- Modify: `lib/clawd-jump-stack.ts`
- Modify: `bin/clawd-jump.ts:6-20`
- Modify: `test/clawd-jump.test.ts`

**Interfaces:**
- Consumes: `frontend/index.html` (as a `BucketDeployment` asset).
- Produces: `ClawdJumpStack` with a private `SiteBucket`, a `SiteDistribution`, a
  `DeploySite` deployment, and a `SiteUrl` output.

- [ ] **Step 1: Write the stack**

Replace `lib/clawd-jump-stack.ts` entirely:

```ts
import * as path from 'node:path';
import * as cdk from 'aws-cdk-lib/core';
import { Construct } from 'constructs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';

export class ClawdJumpStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const siteBucket = new s3.Bucket(this, 'SiteBucket', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    const distribution = new cloudfront.Distribution(this, 'SiteDistribution', {
      comment: 'Clawd Jump',
      defaultRootObject: 'index.html',
      priceClass: cloudfront.PriceClass.PRICE_CLASS_100,
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(siteBucket),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
      },
    });

    new s3deploy.BucketDeployment(this, 'DeploySite', {
      sources: [s3deploy.Source.asset(path.join(__dirname, '..', 'frontend'))],
      destinationBucket: siteBucket,
      distribution,
      distributionPaths: ['/*'],
      cacheControl: [
        s3deploy.CacheControl.setPublic(),
        s3deploy.CacheControl.maxAge(cdk.Duration.minutes(5)),
      ],
    });

    new cdk.CfnOutput(this, 'SiteUrl', {
      value: `https://${distribution.distributionDomainName}`,
      description: 'Clawd Jump CloudFront URL',
    });
  }
}
```

`S3BucketOrigin.withOriginAccessControl` keeps the bucket fully private and writes
the bucket policy granting only this distribution `s3:GetObject`. Passing
`distribution` + `distributionPaths` to `BucketDeployment` makes every deploy
invalidate the edge cache, so a redeploy is visible immediately rather than after the
TTL. `max-age=300` bounds how long a browser can pin a stale build.

- [ ] **Step 2: Enable the environment in the app entry point**

Replace `bin/clawd-jump.ts` entirely:

```ts
#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib/core';
import { ClawdJumpStack } from '../lib/clawd-jump-stack';

const app = new cdk.App();
new ClawdJumpStack(app, 'ClawdJumpStack', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
```

- [ ] **Step 3: Replace the scaffold's placeholder test**

The scaffold left a commented-out SQS test with an empty body. It passes, but it
asserts nothing and names a resource this stack does not have. Replace
`test/clawd-jump.test.ts` entirely with a synth guard — this is not a unit test of
game logic (which the spec excludes), it is a check that the template still contains
the three resources the deploy depends on:

```ts
import * as cdk from 'aws-cdk-lib/core';
import { Template } from 'aws-cdk-lib/assertions';
import { ClawdJumpStack } from '../lib/clawd-jump-stack';

test('stack has a private bucket, a CloudFront distribution and a site deployment', () => {
  const app = new cdk.App();
  const stack = new ClawdJumpStack(app, 'TestStack');
  const template = Template.fromStack(stack);

  template.hasResourceProperties('AWS::S3::Bucket', {
    PublicAccessBlockConfiguration: {
      BlockPublicAcls: true,
      BlockPublicPolicy: true,
      IgnorePublicAcls: true,
      RestrictPublicBuckets: true,
    },
  });
  template.resourceCountIs('AWS::CloudFront::Distribution', 1);
  template.resourceCountIs('AWS::CloudFront::OriginAccessControl', 1);
  template.resourceCountIs('Custom::CDKBucketDeployment', 1);
});
```

- [ ] **Step 4: Type-check**

```bash
npm run build
```

Expected: exits 0 with no output.

- [ ] **Step 5: Run the synth guard**

```bash
npm test
```

Expected: 1 passing test. If `AWS::CloudFront::OriginAccessControl` is missing, the
origin was built with the legacy OAI helper instead of
`withOriginAccessControl`.

- [ ] **Step 6: Synthesize the template**

```bash
npx cdk synth ClawdJumpStack > /dev/null && echo SYNTH_OK
```

Expected: `SYNTH_OK`.

Then confirm the game file is actually in the asset:

```bash
grep -c 'index.html' cdk.out/ClawdJumpStack.assets.json || true
ls -la cdk.out/asset.*/index.html
```

Expected: the asset directory contains `index.html`. An empty asset means
`frontend/` was resolved from the wrong base path.

- [ ] **Step 7: Commit**

```bash
git add lib/clawd-jump-stack.ts bin/clawd-jump.ts test/clawd-jump.test.ts
git commit -m "feat(infra): S3 + CloudFront stack with OAC and site deployment"
```

---

### Task 10: Deploy and verify on CloudFront

**Files:**
- Modify: `README.md`

**Interfaces:**
- Consumes: `ClawdJumpStack`, `frontend/index.html`.
- Produces: a live CloudFront URL; README run/deploy instructions.

- [ ] **Step 1: Confirm credentials and region**

```bash
aws sts get-caller-identity
echo "region=${CDK_DEFAULT_REGION:-$(aws configure get region)}"
```

Expected: an account/ARN and a non-empty region. If this fails, stop and report —
do not proceed with a deploy that will half-fail.

- [ ] **Step 2: Bootstrap if needed**

```bash
aws cloudformation describe-stacks --stack-name CDKToolkit >/dev/null 2>&1 \
  && echo BOOTSTRAPPED \
  || npx cdk bootstrap
```

Expected: `BOOTSTRAPPED`, or a successful bootstrap run.

- [ ] **Step 3: Deploy**

```bash
npx cdk deploy ClawdJumpStack --require-approval never --outputs-file cdk.out/outputs.json
```

Expected: `ClawdJumpStack: deploy` completes and `SiteUrl` is printed.
CloudFront distribution creation typically takes 3-5 minutes.

- [ ] **Step 4: Verify the deployed site over HTTPS**

```bash
URL=$(node -e "console.log(require('./cdk.out/outputs.json').ClawdJumpStack.SiteUrl)")
echo "$URL"
curl -s -o /dev/null -w 'status=%{http_code} type=%{content_type}\n' "$URL/"
curl -s "$URL/" | grep -c 'Clawd Jump'
```

Expected: `status=200`, `type=text/html`, and a non-zero grep count.

- [ ] **Step 5: Confirm the bucket is not publicly readable**

```bash
BUCKET=$(aws cloudformation describe-stack-resources --stack-name ClawdJumpStack \
  --query "StackResources[?ResourceType=='AWS::S3::Bucket'].PhysicalResourceId" --output text)
aws s3api get-public-access-block --bucket "$BUCKET" \
  --query 'PublicAccessBlockConfiguration' --output json
curl -s -o /dev/null -w '%{http_code}\n' "https://$BUCKET.s3.amazonaws.com/index.html"
```

Expected: all four block flags `true`, and the direct S3 URL returns `403`.
A `200` means OAC is not the only access path and the bucket is exposed.

- [ ] **Step 6: Smoke check the live URL in a browser**

Playwright MCP: `browser_navigate` to the CloudFront URL, then
`browser_console_messages` (expected: no errors) and `browser_take_screenshot`
(expected: the game renders identically to local).

- [ ] **Step 7: Manual play on the deployed URL**

Human plays the CloudFront URL start to finish and confirms it behaves the same as
local: no missing assets, no console errors, CLEAR reachable.

- [ ] **Step 8: Update the README**

Replace `README.md` entirely:

````markdown
# Clawd Jump

A pixel-art platformer starring Clawd. Pure HTML5 Canvas and vanilla JS in a single
file — no libraries, no build step.

- **Game:** `frontend/index.html` (640x360 logical resolution)
- **Infra:** private S3 bucket behind CloudFront with Origin Access Control (AWS CDK)
- **Design spec:** `docs/superpowers/specs/2026-09-01-clawd-jump-design.md`

## Controls

| Key | Action |
| --- | --- |
| Left / Right | Move |
| Space | Jump (hold for a higher jump) |
| R | Restart |

Collect coins, avoid spikes, reach the flag.

## Run locally

```bash
python3 -m http.server 8765 --directory frontend
# then open http://localhost:8765/index.html
```

`frontend/index.html` also runs correctly opened directly as a `file://` URL.

## Deploy

```bash
npm ci
npm run build          # type-check
npm test               # template synth guard
npx cdk deploy         # prints the CloudFront URL as SiteUrl
```

## Tear down

```bash
npx cdk destroy
```

The bucket uses `RemovalPolicy.DESTROY` with `autoDeleteObjects`, so teardown leaves
nothing behind.
````

- [ ] **Step 9: Commit**

```bash
git add README.md
git commit -m "docs: document Clawd Jump controls, local run and deploy"
```

---

## Self-Review

**Spec coverage:**

| Spec section | Task |
| --- | --- |
| 4.1 coordinate system / pixelated upscale | 1 |
| 4.2 script sections | 1-8 (each task adds its section) |
| 4.3 fixed timestep | 1 |
| 5 Clawd sprite, hitbox, flip | 2 |
| 6 physics constants, jump cut, coyote, buffer | 3 |
| 7 collision and `isSolid` edge rules | 3 (temporary), 4 (real) |
| 8 level map, glyphs, spawn | 4 |
| 9 camera | 5 |
| 10 background / parallax | 5 |
| 11 palette | 1 (constants), 4 (tiles), 6 (HUD) |
| 12 coins | 6 |
| 12 death and respawn | 7 |
| 12 flag, CLEAR, R | 8 |
| 13 deployment | 9, 10 |
| 14 verification strategy | every task's smoke + manual steps |

No gaps.

**Type consistency:** `isSolid(c, r)` keeps its signature across Tasks 3 and 4.
`checkTriggers()` is introduced in Task 6 and extended in place in Tasks 7 and 8.
`reset()` is stubbed in Task 2 (because the Task 2 `keydown` handler calls it) and
completed in Task 4. `respawn()` is introduced in Task 4 and gains its
`updateCamera()` call in Task 5. `window.__game` grows in Tasks 1, 2 and 4 and is
final after Task 4.

**Known ordering constraint:** Task 2 introduces a `keydown` handler that references
`clawd` and `reset`, both defined below it in the file. This is safe because the
handler body only runs on a real key event, long after the whole script has been
evaluated. Do not "fix" this by reordering the sections.
