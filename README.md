# Clawd Jump

A pixel-art platformer starring Clawd. Pure HTML5 Canvas and vanilla JS in a single
file — no libraries, no build step.

**Play:** https://d2mwhqxxcjoh5c.cloudfront.net

- **Game:** `frontend/index.html` (640x360 logical resolution, 16px tiles)
- **Infra:** private S3 bucket behind CloudFront with Origin Access Control (AWS CDK)
- **Design spec:** `docs/superpowers/specs/2026-09-01-clawd-jump-design.md`
- **Implementation plan:** `docs/superpowers/plans/2026-09-01-clawd-jump.md`

## Controls

| Key | Action |
| --- | --- |
| Left / Right | Move |
| Space | Jump (hold for a higher jump, tap for a hop) |
| R | Restart |

Collect coins, avoid spikes, reach the flag. Spikes and falling into a pit respawn
you at the start; collected coins are kept. `R` resets everything, including coins.

## Run locally

```bash
python3 -m http.server 8765 --directory frontend
# then open http://localhost:8765/index.html
```

`frontend/index.html` also runs correctly opened directly as a `file://` URL — it
makes no external requests.

## Deploy

```bash
npm ci
npm run build          # type-check
npm test               # CloudFormation template guard
npx cdk deploy         # prints the CloudFront URL as SiteUrl
```

Every deploy invalidates the CloudFront cache (`distributionPaths: ['/*']`), so a
new build is live immediately rather than after the TTL.

## Tear down

```bash
npx cdk destroy
```

The bucket uses `RemovalPolicy.DESTROY` with `autoDeleteObjects`, so teardown leaves
nothing behind.

## Tuning the game

Physics constants are grouped at the top of the `CONFIG` section. Two things to know
before editing the level, both learned the hard way (see the spec for the arithmetic):

- **A jump that loses altitude travels much further than the flat-ground reach.**
  Flat reach is 84px; dropping 80px off a platform carries 104px.
- **Spike fairness is about time, not height.** The hazard is 46px wide and needs
  0.329s of clearance, so no spike may sit where a ceiling caps the jump — including
  within ~2 tiles after the ceiling ends.
