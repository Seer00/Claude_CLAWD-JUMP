# Clawd Jump — Design Spec

**Date:** 2026-09-01
**Status:** Approved

## 1. Goal

A single-file, dependency-free HTML5 Canvas platformer starring Clawd, deployed
to S3 + CloudFront via CDK. Built in four phases inside a two-hour budget.

## 2. Non-Goals

- No unit tests. Verification is manual browser play, backed by Playwright smoke checks.
- No Amazon Bedrock, no backend, no persistence, no audio, no mobile/touch controls.
- No external libraries, no build step, no bundler for the game itself.
- No multiple levels, no lives system, no timer, no score beyond the coin count.

## 3. Global Constraints

- `frontend/index.html` is the entire game: one HTML file, one inline `<style>`, one inline `<script>`.
- Zero external requests. The file must run correctly opened directly as `file://`.
- Logical resolution 640x360. `image-rendering: pixelated`. `requestAnimationFrame` driven.
- Clawd is rendered from the given 12x8 array at 3px cells, with horizontal flip support.
- `CLAWD` and `PALETTE` are copied verbatim from the requirements; do not restyle Clawd.
- Coyote time 0.10s, jump buffer 0.10s.
- Tile size 16px. Level is a array-of-strings tile map, wider than the screen, camera follows Clawd.
- Phase order is fixed: engine, then level/collision/camera, then entities/HUD, then deploy.

## 4. Architecture

Approach A (approved): single file, flat module, plain-object state, fixed-timestep
accumulator loop. No classes, no module system.

### 4.1 Coordinate system

All gameplay math is in logical pixels. The canvas backing store is exactly
640x360; CSS scales it up (`width: 100%; max-width: 1280px; aspect-ratio: 16/9`)
and `image-rendering: pixelated` makes the upscale nearest-neighbour.

The camera is snapped to integers at draw time only (`Math.round(cam.x)`).
Gameplay keeps sub-pixel precision; rendering does not. Skipping the snap makes
tile seams shimmer once the canvas is upscaled.

### 4.2 Script sections

One `<script>`, separated by comment banners, in this order:

| Section | Responsibility |
| --- | --- |
| CONFIG | Dimensions, physics constants, `PALETTE`, `CLAWD`, `COIN`, `SPIKE` sprites |
| LEVEL | `MAP` strings, `ROWS`/`COLS`, `tileAt`, `isSolid`, `findTile` |
| INPUT | `keys` Set, keydown/keyup handlers, jump-buffer and jump-cut triggers |
| PHYSICS | `step(dt)`, `moveX`, `moveY`, axis-separated AABB resolution |
| ENTITIES | Coin pickup, spike/void death, flag trigger |
| RENDER | Sky and parallax, tiles, entities, Clawd, HUD, CLEAR overlay |
| GAME | `reset()`, `respawn()`, accumulator loop, state machine |

### 4.3 Fixed timestep

Physics runs at a fixed `1/60` step driven by an accumulator; rendering runs once
per frame. The accumulator is capped at 5 steps per frame so that returning to a
backgrounded tab does not simulate a multi-second catch-up burst.

This matters because gravity is Euler-integrated (`vy += G * dt`). With a variable
`dt`, identical jump input produces different apex heights, so a coin tuned to be
"just barely reachable" at 60Hz becomes unreachable at 144Hz.

## 5. Clawd

- Sprite: 12x8 cells at 3px = 36x24 logical px.
- Collision box: **30x24**, horizontally centred on the sprite (3px slack per side).
  Decoupling hitbox from sprite is what makes wall-grazing feel fair.
- Horizontal flip is done by reading cell index `11 - c`, not `ctx.scale(-1, 1)`.
  A transform would need a `save`/`restore` pair every frame and would push
  coordinates into negative space, breaking integer snapping.

## 6. Physics constants

| Constant | Value | Unit |
| --- | --- | --- |
| `GRAVITY` | 1400 | px/s^2 |
| `MAX_FALL` | 620 | px/s |
| `ACCEL` | 900 | px/s^2 |
| `FRICTION` | 1400 | px/s^2 |
| `MAX_RUN` | 140 | px/s |
| `JUMP_VY` | -420 | px/s |
| `JUMP_CUT` | 0.4 | multiplier on release while rising |
| `COYOTE` | 0.10 | s |
| `BUFFER` | 0.10 | s |

Derived envelope, which the level design must respect.

The continuous-time formula `v^2 / 2g` overstates the real apex. Physics is explicit
Euler at `dt = 1/60` with gravity applied *before* the position update, so the first
step already sheds `g * dt` from the launch velocity. The apex actually reached is:

```
apex = (1/60) * sum(i=1..n) (JUMP_VY + i * GRAVITY / 60),  n = floor(|JUMP_VY| * 60 / GRAVITY)
```

For `JUMP_VY = -420`: `n = 18`, terms stay negative through `i = 17`, giving
**59.5px**. (`-400` would give 53.8px, only 5.8px of margin over the level's
tightest 3-tile rise — measured, not estimated.)

- Jump apex: **59.5px ~= 3.7 tiles**
- Airtime = `2 * 420 / 1400` = 0.6s; horizontal reach = `0.6 * 140` = **84px ~= 5 tiles**
- Therefore: **max gap 4 tiles, max single rise 3 tiles**, leaving 11.5px of apex margin.

Per-step displacement is at most 2.33px horizontally and 10.3px vertically, both
under `TILE`, so single-tile collision probing per axis cannot tunnel.

Jump cut is applied once in the `keyup` handler, not per-frame in `step()`.
Applying it every frame while the key is up would compound to an instant stop.

## 7. Collision

Axis-separated: apply `vx * dt`, resolve against solid tiles on X, then apply
`vy * dt` and resolve on Y. Resolving a diagonal move in one pass leaves the push-out
axis ambiguous and causes corner snagging during wall-adjacent jumps.

`isSolid(c, r)`:
- `c` out of range: **solid** (invisible walls at both level edges).
- `r < 0`: not solid (open sky above the level).
- `r >= ROWS`: not solid (falling out of the level is a death, not a floor).

## 8. Level

100 columns x 23 rows = 1600x368px, 2.5 screens wide.

Level height is deliberately 8px taller than the viewport so the vertical camera
uses the same clamp formula as the horizontal one without a special case, while
in practice behaving as a fixed camera. Making the map taller later enables real
vertical scrolling with no code change.

### 8.1 Tile glyphs

| Glyph | Meaning | Solid |
| --- | --- | --- |
| `.` | empty | no |
| `X` | terrain | yes |
| `C` | coin | no (trigger) |
| `^` | spike | no (trigger) |
| `F` | flag / goal | no (trigger) |
| `S` | spawn point | no (renders nothing) |

`S` is an addition to the original glyph list. The requirements call for respawn at
the start point, so the start point belongs in the map data rather than as a
hardcoded constant.

### 8.2 Map

```
....................................................................................................
....................................................................................................
....................................................................................................
....................................................................................................
....................................................................................................
....................................................................................................
....................................................................................................
....................................................................................................
....................................................................................................
....................................................................................................
....................................................................................................
....................................................................................................
....................................................................................................
....................................................................................................
....................................................................................................
.........................................................C....C.....................................
.............................................C......C...XXX..XXX....................................
.............................CC...........C.XXXXX..XXX................XXXXXXXXX..............C...F..
...................C........XXXX.......C.XXXXXXXX...........................................XXXXXXXX
......................................XXXXXXXXXXX....................................C..XXX.....XXXX
..S....C..C....XXX.......^^.....^^.XXXXXXXXXXXXXX.......................C...C......^XXX.XXX.....XXXX
XXXXXXXXXXXXXXXXXX...XXXXXXXXXXXXXXXXXXXXXXXXXXXX.................XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX
XXXXXXXXXXXXXXXXXX...XXXXXXXXXXXXXXXXXXXXXXXXXXXX.................XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX
```

Totals: **15 coins**, 5 spikes, 1 spawn, 1 flag. The coin total is counted from the
map at load time, never hardcoded.

### 8.3 Sections

| Cols | Content |
| --- | --- |
| 0-17 | Flat tutorial ground, 2 coins, one 1-tile step |
| 18-20 | 3-tile gap with an airborne coin at the jump apex |
| 21-34 | Ground with spikes at cols 25/26 and 32/33; overhead platform (cols 28-31) holding 2 coins |
| 35-48 | Four-step staircase climbing 4 tiles, 3 coins |
| 49-65 | Death pit spanned by three floating platforms, 3 coins |
| 66-83 | Ground restored; low 3-tile ceiling corridor (cols 70-78), 2 coins, no spikes (see fairness rule) |
| 84-99 | Final climb over two steps and a platform to the flag at col 97 |

**Spike fairness is a question of time, not height.** Clearing a spike needs 8px of
lift (the hurtbox is the tile's lower half), but that lift must be *held* for the whole
crossing: hazard width = `BOX_W + TILE` = 46px, so at `MAX_RUN` 140px/s the feet must
stay above the tip for **0.329s**.

- Open sky: feet are above 8px for 0.56s. Comfortable.
- Under a 3-tile ceiling (24px headroom): the rise is cut off at 24px after 0.064s,
  then the 16px fall back to the tip takes 0.151s - a window of just **0.195s**.

So **no spike may sit anywhere a ceiling caps the jump**, regardless of headroom -
and that includes just *past* a ceiling. Clawd's jump stays capped while any part of
his 30px box is still under the last ceiling tile, so a hazard needs roughly 2 tiles
of unobstructed runway after the ceiling ends before its window opens. A spike at
col 81, three tiles past the corridor's end at col 78, left about 2px of free runway
and was moved to col 83.

A
spike was moved into the corridor at col 74 to escape a landing zone and turned out to
be equally impossible; it now sits at col 32, pairing with col 33 at the same
difficulty as the proven col 25/26 pair.

Spikes are also never placed in a landing zone. **A jump that loses altitude travels
much further than the flat-ground reach.** Leaving platform 3 (col 63, row 16) for the
ground at row 21 drops 80px, which stretches airtime to 0.746s and horizontal travel
to 104px (6.5 tiles) - and even walking off the edge without jumping carries 47px.
A spike originally sat at col 68, exactly in that arc, with no avoidance path at all;
it was moved into the corridor at col 74. When editing the map, size landing pads
against the descending-jump reach, not the 84px flat reach.

## 9. Camera

```
cam.x = clamp(clawd.cx - 320, 0, LEVEL_W - 640)   // 0..960
cam.y = clamp(clawd.cy - 180, 0, LEVEL_H - 360)   // 0..8
```

## 10. Background

A vertical sky gradient plus one procedural hill silhouette layer scrolling at
0.35x. This is not decoration: all level geometry sits in the bottom 128px, so
without a background the upper two thirds of the frame reads as an unfinished
flat fill. The hills are a sum of two sines sampled every 2px, drawn behind the
terrain, so no artwork or extra requests are needed.

## 11. Palette

| Role | Colour |
| --- | --- |
| Clawd body / accent | `#D97757` (`PALETTE.A`) |
| Clawd eyes | `#14130F` (`PALETTE.B`) |
| Sky top / bottom | `#F0EEE6` / `#E3DDD0` |
| Parallax hills | `#CFC7B5` |
| Terrain body / top cap | `#3B3630` / `#5C554A` |
| Coin / highlight | `#E8C547` / `#FFF3C4` |
| Spike | `#9A9287` |
| Flag pole / cloth | `#14130F` / `#3F9E77` |
| HUD text | `#14130F` |

Coins are gold rather than Clawd's `#D97757` so a coin is never mistaken for
Clawd at a glance; the flag cloth is green for the same reason.

## 12. Game rules and state

Two states: `play` and `clear`.

- **Coins** are score only. The flag is never locked. Collecting sets the map cell
  to `.`.
- **Death** = touching a spike **or** falling past the bottom of the level.
  Respawn at `S` with velocity zeroed.
- **Collected coins survive respawn.** Death carries no coin penalty.
- **`R`** performs a full reset (coins included) and works in both states.
- **Flag** switches to `clear`, which draws a `CLEAR!` overlay with the collection
  ratio and a `press R` prompt.
- **HUD** (state `play`): `COINS n/15` top-left.

## 13. Deployment (Phase 4)

- Private S3 bucket: `BLOCK_ALL` public access, S3-managed encryption, `enforceSSL`,
  `RemovalPolicy.DESTROY` + `autoDeleteObjects` so the stack tears down cleanly.
- CloudFront distribution with **Origin Access Control**
  (`origins.S3BucketOrigin.withOriginAccessControl`), `defaultRootObject: 'index.html'`,
  `REDIRECT_TO_HTTPS`, `PRICE_CLASS_100`.
- `BucketDeployment` uploads `frontend/`, passing `distribution` and
  `distributionPaths: ['/*']` so every deploy invalidates the edge cache.
  `Cache-Control: public, max-age=300` keeps a stale build from pinning for hours.
- `CfnOutput` exposes the CloudFront URL.
- `bin/clawd-jump.ts` enables `env` from `CDK_DEFAULT_ACCOUNT` / `CDK_DEFAULT_REGION`.

## 14. Verification strategy

No unit tests, per the time budget. Each phase is gated by:

1. **Playwright smoke check** — load the page, assert no console errors, drive
   keys via script, screenshot, and read game state through `page.evaluate`.
2. **Manual browser play** — the human confirms feel (responsiveness, coyote time,
   jump arc), which no automated check can judge.

Phase 4 additionally runs `npm run build`, `npx cdk synth`, `npx cdk deploy`, and a
real play session on the CloudFront URL.

## 15. Risks

| Risk | Mitigation |
| --- | --- |
| Physics tuning feels wrong on real play | Constants are grouped in CONFIG; retune without touching logic |
| HUD text is antialiased, not pixel-perfect | Accepted. A bitmap font is out of budget; 12px monospace upscales legibly |
| `cdk deploy` blocked by missing bootstrap | Plan checks `sts get-caller-identity` and bootstraps before deploying |
| Level too hard or too easy | Section table maps cols to difficulty; edit map strings only |
