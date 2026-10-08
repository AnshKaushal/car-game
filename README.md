# Car Game

An endless-road driving sandbox for the desktop: one car, one infinite highway, no finish line. Built as an Electrobun app (Hutch + Cottontail) with a React + three.js view and a hand-written vehicle physics model running on Rapier.

You spawn parked on a procedurally curving four-lane highway and drive as far as you want — the world recycles underneath you forever. There is no traffic, no AI and no win condition. It is a handling playground.

## Downloading a build

Grab the latest DMG (macOS) or Setup zip (Windows) from the [Releases page](../../releases). On macOS, the app is not Apple-signed, so the first open is blocked by Gatekeeper: try opening it once, then System Settings → Privacy & Security → **Open Anyway** (or run `xattr -cr /Applications/OverSteer.app` if that button is missing). It opens normally from then on.

## The game

- **Endless highway** — deterministic sum-of-sines centreline with elevation and banking, a ribbon-mesh road that recycles ahead of the car, and instanced trees/hills seeded per segment so a stretch looks the same every time you pass it.
- **Full drivetrain** — 800 HP / 1000 Nm torque curve, 8-speed ZF-style auto/manual box with torque converter, launch control, fuel-cut rev limiter, hill-hold and reverse.
- **Hand-written vehicle dynamics** — the car is a single Rapier rigid body; suspension, tire forces, brakes, aero and assists are computed every frame (friction ellipse, load transfer, anti-roll bars, rate-limited grip-capped steering).
- **Assists** — traction control, ABS, ESC with countersteer assist. Holding the handbrake disables TC and ESC for drifting.
- **Presentation** — chase camera with mouse orbit, speed-based FOV, peripheral speed lines, camera shake, tire smoke, and an SVG twin-dial dashboard (speedo to 340 km/h, tacho with a red band from 7 000 rpm).

## Controls

| Input | Action |
| --- | --- |
| `W` / `↑` | Throttle |
| `S` / `↓` | Brake in gear/neutral, throttle in reverse |
| `A` `D` / `←` `→` | Steer |
| `Q` / `E` | Downshift / upshift (manual mode) |
| `M` | Toggle auto / manual gearbox |
| `L` | Toggle launch control |
| `Space` | Handbrake — disables TC and ESC |
| `R` | Reset the car onto the road |
| `C` | Toggle chase-camera distance |
| `Enter` | Start |
| `Esc` | Release the mouse |
| Mouse | Orbit the camera; eases back behind the car after a couple of seconds |

## Tech stack

| Layer | Choice |
| --- | --- |
| Shell | Electrobun / Hutch |
| UI | React 18 + Tailwind CSS v4 (Vite plugin) |
| 3D | three.js |
| Physics | Rapier 3D (WASM) + hand-written vehicle model |
| Build | Vite 6, TypeScript 5.7 |

## Getting started

Install Hutch first (it owns packages, scripts and bundling):

```bash
# macOS / Linux
curl -fsSL https://hutch.blackboard.sh/hutch/install.sh | sh

# Windows PowerShell
& ([scriptblock]::Create((irm https://hutch.blackboard.sh/hutch/install.ps1)))
```

Then, in the repo:

```bash
hutch run install      # install dependencies
hutch run dev:hmr      # development with Vite HMR (recommended)
hutch run dev          # development without HMR (bundled assets)
hutch run build        # production build → build/ and artifacts/
hutch run build:canary # canary-channel build
```

### How HMR works

`hutch run dev:hmr` starts the Vite dev server on `http://localhost:5173`, then launches Electrobun against it — React components update instantly instead of reloading. `hutch run dev` skips the server and loads the bundled assets from `views://mainview/index.html`.

### Headless scripts

Physics/world checks run outside the app through Hutch's runtime:

```bash
hutch scripts/smoke-test.ts   # behaviour assertions (idle, launch, limiter, ...)
hutch scripts/drift-matrix.ts # 60-case drift recovery sweep
hutch scripts/road-test.ts    # road ribbon continuity
```

Run `drift-matrix.ts` after any change to steering, assists or tire forces — it is the regression net for the handling work.

## Project structure

```
src/mainview/
├── App.tsx                 # frame loop, camera, pointer lock, HUD wiring
├── constants/
│   ├── physics.ts          # CAR_PHYSICS — every vehicle tunable
│   └── world.ts            # WORLD_CONFIG — road/vegetation/environment
├── systems/
│   ├── road.ts             # analytic road: centreline, elevation, banking
│   ├── PhysicsSystem.ts    # Rapier world, chassis body, fixed timestep
│   ├── CarController.ts    # vehicle physics update (composes vehicle/)
│   ├── vehicle/            # tire, suspension, drivetrain, assists, aero
│   ├── InputManager.ts     # keyboard → DriveInput with analog smoothing
│   ├── CarVisual.ts        # GLB load, wheel pivots, per-frame pose
│   ├── TireSmoke.ts        # pooled GPU point-sprite smoke
│   └── WorldManager.ts     # road ribbons, trees, hills, physics ground
├── ui/
│   ├── Dashboard.tsx       # SVG speedo / tacho, gear, launch banner
│   └── SpeedLines.tsx      # peripheral streak overlay
└── models/                 # bmw_m3.glb, tree_pack.glb
scripts/                    # headless checks (see above)
```

## Releases

`.github/workflows/release.yml` is **manual** — run it from the *Actions → Build & Release → Run workflow* tab. Each run publishes one GitHub Release:

1. **Version** — reads the newest `vX.Y.Z` tag in the repo and bumps the patch (`v1.0.3` → `v1.0.4`). The first run, with no tags, starts at `v1.0.0`.
2. **Build** — a macOS (arm64) job and a Windows (x64) job install Hutch, run `hutch run install`, stamp the new version into `electrobun.config.ts`, and run `hutch run build` (stable channel).
3. **Release** — both platforms' artifacts are attached to a new tag/release, with auto-generated notes.

Assets on each release:

- `Car-Game-<version>-macOS-ARM64.dmg`
- `Car-Game-<version>-Windows-x64-Setup.zip`
- `stable-*-update.json` and `stable-*.tar.zst` — Electrobun's updater files, kept under their original names so the updater protocol still resolves them

Versions come from git tags only; the stamped config is a CI artefact and is not committed back. Two dispatches cannot race for the same number — the workflow serialises itself with a concurrency group.

## Physics reference

`GAME_OVERVIEW.md` is the deep dive into the vehicle model: constants, torque curve, gearing, the per-frame force pipeline and where tuning belongs. It is a snapshot as of the `checkpoint` commit, so parts of it lag the current code.

Where to change things:

- `src/mainview/constants/physics.ts` — the car's behaviour (single source of truth)
- `src/mainview/systems/CarController.ts` — per-wheel / per-frame force work
- `src/mainview/systems/road.ts` — centreline, elevation, banking
- `scripts/drift-matrix.ts` — regression net after handling changes
