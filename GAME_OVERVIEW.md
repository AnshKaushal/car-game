# Car Game — Current State & Physics Reference

Snapshot of the repo as of the `checkpoint` commit. Covers what the game is,
how it is structured, and exactly how the vehicle physics is defined and
computed.

---

## 1. What the game is

An **endless-road arcade-sim driving sandbox** built around one car: a
**BMW M3 (G80-generation silhouette, heavily fictionalised)** rated at
**800 HP / 1000 Nm**. You spawn parked on a procedurally-curving two-lane-each-way
highway, drive as far as you want in any direction, and the world recycles
indefinitely. There is no lap system, no traffic, no AI, no win condition — it is
a **handling playground**, and the code comments show the bulk of the recent work
went into making the car catchable, holdable and predictable rather than into
adding content.

**Shape of the experience**

- Endless deterministic highway (sum-of-sines curvature, no banking, no
  elevation).
- Flat infinite physics ground; the *visual* road is a ribbon mesh that curves
  over a *flat* physics plane.
- Full drivetrain simulation: torque curve, 8-speed auto/manual box with
  torque converter, launch control, rev limiter with fuel cut.
- Handling model: raycast suspension, per-wheel tire forces, friction ellipse,
  traction control, ABS, ESC with countersteer assist.
- Presentation: chase camera with mouse orbit, speed FOV widening, screen-edge
  speed lines, camera shake, tire smoke, twin-dial SVG dashboard (red band
  painted from **7 000 rpm**, see §4.14).

### Stack

| Layer | Choice |
| --- | --- |
| Shell | Electrobun / Hutch (`hutch run dev`, `dev:hmr`, `build:canary`) |
| UI | React 18 + Tailwind v4 (Vite plugin) |
| 3D | three.js `^0.186.1` |
| Physics | `@dimforge/rapier3d-compat` `^0.21.0` (WASM) |
| Build | Vite 6, TypeScript 5.7 |
| Headless tests | Bun-run scripts in `scripts/` |

### File map

```
src/mainview/
├── App.tsx                    # main loop, camera, pointer lock, speed feel, HUD wiring
├── constants/
│   ├── physics.ts             # CAR_PHYSICS — every vehicle tunable lives here
│   └── world.ts               # WORLD_CONFIG — road/terrain/veg/env constants
├── systems/
│   ├── PhysicsSystem.ts       # Rapier bootstrap, chassis body, fixed stepping, ground teleport
│   ├── CarController.ts       # ALL vehicle physics (the core of the project, ~700 lines)
│   ├── InputManager.ts        # keyboard → DriveInput, with analog smoothing
│   ├── CarVisual.ts           # GLB load, wheel pivot extraction, per-frame pose
│   ├── TireSmoke.ts           # pooled GPU point-sprite smoke
│   └── WorldManager.ts        # road ribbons, instanced trees, hills, physics ground
└── ui/
    ├── Dashboard.tsx          # SVG speed/tacho dials, gear, launch banner
    └── SpeedLines.tsx         # peripheral streak overlay

scripts/
├── smoke-test.ts              # headless behaviour assertions
├── drift-matrix.ts            # 60-case countersteer/recovery sweep
└── road-test.ts               # road ribbon continuity checks
```

Git history is three commits (`First draft` → `drift fix` → `checkpoint`), so the
handling model has been iterated on roughly twice, both times targeting drift
recovery.

---

## 2. Architecture: how a frame runs

`App.tsx` owns a single `requestAnimationFrame` loop:

1. `dt = min(realDt, CAR_PHYSICS.simulation.maxFrameDt)` — capped at **1/30 s**.
2. `input.update(dt)` → `DriveInput` (throttle/brake/steer ramped, edges).
3. `car.update(dt, inp)` → applies **all** tire/suspension/force impulses, reads
   back telemetry.
4. `stepWorld(world, dt)` — advances Rapier, internally subdivided.
5. Visual sync: `CarVisual.syncFromBody`, `WorldManager.update`,
   `moveGroundBody`, tire smoke spawn/update.
6. Camera: orbit accumulation, ease-back-to-behind, FOV/shake, `lookAt`.
7. Render, then push telemetry to React at **~20 Hz** (HUD gauges interpolate
   themselves at 60 fps via direct DOM writes).

**Critical invariant:** the render loop and `CarController.update` clamp `dt` to
the *same* `maxFrameDt`. If the loop advanced the world further than the tire
forces were integrated for, grip would silently drop exactly when the frame rate
dips. `CarController.ts:141-145` and `App.tsx:309-314` both document this.

### Physics body model

The vehicle is **one dynamic Rapier rigid body** — not Rapier's `DynamicRayCast-
VehicleController`. Every force is hand-computed and applied as an impulse. This
was chosen for stability at 300+ km/h and for full control over the tire model.
Consequences:

- Rapier only integrates rigid-body motion + resolves the chassis collider.
- Suspension, tires, brakes, drivetrain, aero and assists are all manual.
- The chassis collider is a low, tight cuboid (`halfHeight = 0.32`, offset
  `y = -0.1`) rather than a full-height box, to put the effective CoM at
  ~0.6 m at ride height — high enough to resist endo, low enough to allow
  squat and dive.

---

## 3. Physics constants — `constants/physics.ts`

`CAR_PHYSICS` is a frozen (`as const`) nested object, exported as
`CarPhysicsConfig`, with `createPhysicsConfig(overrides)` doing a one-level-deep
merge per sub-object. **No override path is currently wired up** — `App.tsx`
imports `CAR_PHYSICS` directly.

### 3.1 Dimensions & mass

| Key | Value | Note |
| --- | --- | --- |
| `dimensions.width` | 1.85 m | |
| `dimensions.height` | 1.43 m | |
| `dimensions.length` | 4.71 m | drives `CarVisual` auto-scale |
| `dimensions.wheelbase` | 2.85 m | **not read by code** — hardcoded `2.85` in the grip cap |
| `dimensions.trackWidth` | 1.58 m | **not read** — hardcoded `±0.76` in `WHEEL_LOCAL` |
| `dimensions.groundClearance` | 0.12 m | **not read** |
| `dimensions.centerOfMassHeight` | 0.5 m | **not read** — actual CoM emerges from collider geometry |
| `mass.chassis` | **1650 kg** | the only mass actually applied (`.setMass()`) |
| `mass.frontWheel` / `rearWheel` | 25 kg each | **not read** |
| `mass.total` | 1750 kg | **not read** — only used as documentation |

Effective vehicle mass is therefore **1650 kg**, not 1750. All derived numbers
below use 1650.

### 3.2 Engine — `engine`

- `maxPowerHP: 800` *(informational; the curve actually peaks at 829 hp — see
  below. Slight inconsistency.)*
- `maxTorqueNm: 1000`
- `maxPowerRPM: 7200`, `maxTorqueRPM: 3500`, `redlineRPM: 7500`,
  `revLimiterRPM: 7500`, `idleRPM: 800`
- `engineInertia: 0.3` — **not read**; the RPM model is kinematic, not
  integrated from torque.
- `frictionTorqueBase: 50`, `frictionTorqueRPMFactor: 0.015` → friction torque
  `= 50 + 0.015 × rpm`, i.e. **50 Nm at idle, 162 Nm at redline**.

**Torque curve** — `[[rpm, multiplier], ...]`, linearly interpolated by
`torqueMult()`. Engine torque = `1000 Nm × multiplier × throttle`.

| rpm | mult | torque | power (T·rpm/7120) |
| --- | --- | --- | --- |
| 0 | 0.30 | 300 | 0 |
| 800 | 0.42 | 420 | 47 |
| 1500 | 0.62 | 620 | 131 |
| 2500 | 0.85 | 850 | 298 |
| **3500** | **1.00** | **1000** | 492 |
| 4500 | 0.97 | 970 | 613 |
| 5500 | 0.93 | 930 | 718 |
| 6500 | 0.88 | 880 | 803 |
| **7200** | 0.82 | 820 | **829 (peak)** |
| 7500 | 0.55 | 550 | 579 |
| 7700 | 0.00 | 0 | limiter cut zone |

The shape is deliberate: the multiplier decays slowly past peak torque so power
keeps climbing until 7200, then falls off a cliff. Above idle the falloff is
shallow enough that power rises monotonically to the 7200 point.

**Torque chain per frame** (`CarController.ts:275-324`):

```
engineTorque = 1000 × curve(rpm) × throttle − friction × 0.25
  gear === N            → 0
  shifting              → × 0.25 (power cut)
  rev limiter engaged   → 0 (fuel cut)
  traction control      → × lerp(1, 1 − min(0.85, tcGain×2), cut)
  clamped to ≥ 0
driveTorquePerRear = engineTorque × gearRatio × 0.85 × tcMult × dir / 2   [RWD, per rear wheel]
```

`0.85` is driveline efficiency; `/2` splits torque across the two driven wheels.

### 3.3 Transmission — `transmission`

ZF 8HP-style torque-converter 8-speed. Gear ratios **and the road speed they
produce at the 7200 rpm upshift point** (final drive 3.15, wheel radius 0.33 m):

| Gear | Ratio | Total | Speed @7200 rpm |
| --- | --- | --- | --- |
| 1 | 4.71 | 14.84 | **60 km/h** |
| 2 | 3.14 | 9.89 | 91 km/h |
| 3 | 2.10 | 6.62 | 135 km/h |
| 4 | 1.67 | 5.26 | 170 km/h |
| 5 | 1.29 | 4.06 | 220 km/h |
| 6 | 1.00 | 3.15 | 284 km/h |
| 7 | 0.84 | 2.65 | 339 km/h |
| 8 | 0.67 | 2.11 | **424 km/h** (441 at limiter) |

That 424 km/h gearing ceiling is why the speedo dial is scaled to 340 km/h — 7th
tops the gauge, 8th goes past it.

**Reverse** uses a hardcoded ratio `3.2 × finalDrive` (not in the constants file).

- `shiftTimeAuto: 0.15 s`, `shiftTimeManual: 0.08 s`
- `clutchEngagementRPM: 1500`, `clutchSlipTime: 0.3` — **not read**. Clutch slip is
  faked by blending in a `throttleFlare` term at low speed.
- `launchControlRPM: 5000`, `launchControlActive: true` — the RPM pin is active;
  the boolean is **not read** (the live gate is `CarController.launchEnabled`,
  toggled with `L`).
- Torque converter:
  - `stallMultiplication: 1.7` — multiplies drive torque, faded linearly to 1.0
    at `lockupSpeedKmh: 25`.
  - `creepForce: 1200 N` per axle in D, faded out by ~11 km/h → settles around
    **8–9 km/h at ~1k rpm** with no pedal.
  - `creepForceReverse: 700 N` per axle in R.
- `autoUpshiftRPM: 7200` (used). `autoDownshiftRPM: 2100` — **not read**;
  downshift logic uses hardcoded 1400 rpm (lugging) and 5 km/h (stopping).

### 3.4 Differential — `differential`

```ts
type: 'lsd', lsdAccelLock: 0.4, lsdDecelLock: 0.3, preloadTorque: 50
```

**Entirely unused.** There is no differential model; both rear wheels receive the
identical `driveTorquePerRear`. This is the single largest "declared but absent"
system.

### 3.5 Wheels & tires — `wheels`

Geometry: `radius: 0.33 m` (~19"), `width: 0.265 m`.

**Hardpoints** (`WHEEL_LOCAL`, `CarController.ts:62-69`) — measured from the GLB,
not from `dimensions`:

| Wheel | x | z | Driven |
| --- | --- | --- | --- |
| FL | −0.76 | −1.51 | no |
| FR | +0.76 | −1.51 | no |
| RL | −0.76 | +1.31 | **yes** |
| RR | +0.76 | +1.31 | **yes** |

Physics forward is **−Z**.

#### Pacejka coefficients — mostly declared, barely used

A full-looking Pacejka block exists for longitudinal, lateral and aligning
torque (`B`, `C`, `D`, `E`, `Sh`, `Sv`, `loadSensitivity`). In practice:

- The **lateral** model uses only `B = 9.0` as a linear cornering-stiffness
  coefficient: `latForce = −vLat × 9.0 × 520`.
- `C`, `D`, `E`, `Sv`, `Sh`, `loadSensitivity` are **never read**.
- The **longitudinal** and **aligning** coefficient sets are **never read at
  all** — longitudinal force is built from tractive torque, braking torque and a
  `tanh()` slip approximation instead.
- The friction peak is a single hardcoded constant: **`muPeak = 1.4`** in
  `CarController.ts:412`, not `D = 1.0 × load`.

At static load (~4038 N/wheel for 1650 kg) the lateral force saturates at
`|vLat| ≈ 1.28 m/s`, so the tire response is **stiff and near-linear until it
clips** — closer to a "sliding block with a slip threshold" than a Pacejka
curve.

#### Suspension — `wheels.suspension`

| Key | Value | Used? |
| --- | --- | --- |
| `springRate` | 55 000 N/m | yes |
| `damperRate` | 4500 N·s/m | yes |
| `travel` | 0.12 m | yes (compression clamp) |
| `targetDampingRatio` | 0.85 | **no** — damping is a raw velocity coefficient |
| `antiRollBarFront/Rear` | 15 000 / 12 000 Nm/rad | **no** |

Raycast rest length is a hardcoded **`REST = 0.915`** with `maxToi = 1.035`
(`CarController.ts:363-364`). Ray origin is the hardpoint + 0.1 m, direction
−Y, `solid = true`, excluding the chassis body.

Static equilibrium: `4 × 55000 × compression = 1650 × 9.81` → compression
≈ 73 mm, contact at ≈ 0.84 m below the ray origin, body centre settling at
**≈ 0.69 m**. `CarVisual` offsets the model by a hardcoded **−0.72 m** to
compensate, and `App` spawns the body at exactly `y = 0.72`.

A **progressive bump-stop** multiplier `1 + max(0, compression − 0.1) × 12`
engages in the last 20 mm.

#### Brakes & handbrake

- `brakeForce.front: 1800`, `brakeForce.rear: 1400` Nm per wheel at full pedal.
- `handbrakeForce: 3500` Nm, rear only.
- Handbrake **fades to a drift mode when throttle is pinned**:
  `hbForce = (2600 − 1400 × |steer|) − 800 × clamp(speedKmh/15)`. Strong drag at
  a standstill (burnouts stay put), freed up at full lock (rolling donuts keep
  travelling).

#### Steering — `wheels.steering`

| Key | Value | Used? |
| --- | --- | --- |
| `maxAngle` | 0.6 rad (~34°) | yes |
| `speedSensitivity` | 0.6 | yes |
| `speedFalloffKmh` | 190 | yes |
| `minAngleAtSpeed` | 0.05 rad | yes |
| `ackermannFactor` | 0.3 | **no** — both front wheels get the identical angle |
| `returnSpeed` | 3.0 rad/s | **no** — a hardcoded `steerRate = 6` rad/s is used |

### 3.6 Aerodynamics — `aero`

```
drag      = 0.5 × 1.225 × 0.32 × 2.2 × v²      →  0.4312 · v²  N
downforce = (150 / 27.78²) × v²                   →  0.1945 · v²  N   (applied as −Y)
```

`dragCoefficient: 0.32`, `frontalArea: 2.2 m²`, `downforceAt100kmh: 150 N`,
`airDensity: 1.225`. `liftCoefficient: 0.15` is **not used** (no aero pitch, no
ride-height change).

Worked numbers: at 300 km/h drag ≈ 2994 N, downforce ≈ 1350 N (≈ +16% rear
grip). **Downforce is applied to the CoM only** — it produces no load transfer
and no aero balance, just extra grip.

### 3.7 Assists — `assists`

| Key | Value | Effect |
| --- | --- | --- |
| `tractionControl` | 0.3 | torque cut from `slipRatioAvg > 0.18` |
| `stabilityControl` | 0.2 | ESC yaw torque past a slip deadzone |
| `countersteerAssist` | 4500 | ESC yaw impulse that *follows* opposite lock |
| `absEnabled` | true | brake pulsation at 90 rad/s |
| `absSlipThreshold` | 0.15 | **not used** — ABS keys off `vLong` and pedal pressure |
| `speedFeel.*` | FOV 68→104°, lines, shake | presentation only, never touching the car |

`speedFeel` sub-keys: `fovBase 68`, `fovMax 104`, `fovAtMaxSpeedKmh 330`,
`linesStrength 0.85`, `linesFromKmh 110`, `shakeAmp 0.0016 rad`,
`shakeFromKmh 140`.

### 3.8 Simulation — `simulation`

| Key | Value | Used? |
| --- | --- | --- |
| `subSteps` | 8 | **no** |
| `maxSubStep` | 1/60 | **no** |
| `maxFrameDt` | **1/30** | **yes — the load-bearing one** |
| `raycastDistance` | 0.4 | **no** — superseded by `REST = 0.915` |
| `chassisRaycastDistance` | 0.5 | **no** |

Actual stepping lives in `PhysicsSystem.stepWorld`: Rapier's `world.timestep`
is set to **1/120 s** and `stepWorld` runs `clamp(round(dt/h), 1, 6)` sub-steps,
so the world always advances in exact 1/120 s increments, at most 6 per frame
(50 ms of sim per frame, comfortably above the 33 ms `maxFrameDt`).

---

## 4. The physics pipeline — `CarController.update()`

Order of operations per frame (all forces are impulses `F × dt`):

### 4.1 Mode / gear edges
Auto-manual toggle, launch-enable toggle, shift timer countdown, manual
up/downshift when in manual mode.

### 4.2 Vehicle-frame quantities
`forwardSpeed` = velocity · body forward. Flattened `fwd`/`right` vectors
(rotated `−Z` / `+X`, y zeroed). Sideslip angle
`beta = clamp(latV / max(10, |fwdSpeed|), ±0.4)` — a cheap global estimate used
only by TC and ESC.

### 4.3 Parking brake
`parkingBrake` starts **true** at spawn and clears the instant `throttle > 0.3`.
While engaged it forces ≥ 3000 Nm on **all four** wheels — an automatic P-gear.
Menu text tells the player this.

### 4.4 Steering

```
speedFactor = 1 / (1 + (speedKmh/190)² × 0.6 × 3)
gripCap     = atan(2.85 × 32 / max(40, fwdSpeed²))     // ~3.3g lateral budget
steerCap    = max(gripCap, 0.05)
target      = clamp(input.steer × 0.6 × speedFactor, ±steerCap)
steerAngle += clamp(target − steerAngle, ±6·dt)       // rate-limited both ways
```

The grip cap is a hard ceiling on usable lock derived from what the front axle
can physically hold, with a 0.05 rad floor so countersteer always has authority
at speed. The comments are explicit that the previous 1.25g version capped full
lock at 0.4° above 250 km/h and made the car unable to change direction at all.

### 4.5 Launch control

Armed when: launch enabled **AND** `|fwdSpeed| < 1.2` **AND** gear == 1 **AND**
`throttle > 0.7` **AND** `brake > 0.2`.

While armed: rpm pinned to 5000 with a `sin(t×50)×120` bounce, **and the clutch is
held fully open** (`driveTorquePerRear = 0`) so the car does not creep an inch.
Releasing the brake with throttle still pinned is `launching` — the HUD flashes
`LAUNCH!` for 2 s. TC is scaled to 0.35 during arm/launch.

### 4.6 RPM model

The RPM is **kinematic, not torque-integrated** — no flywheel inertia is
simulated. In gear:

```
rollingOmega = fwdSpeed / 0.33
coupled      = |rollingOmega × gearRatio × 60 / 2π|
clutchSlip   = clamp(1 − |fwdSpeed|/6, 0, 1)
throttleFlare= throttle × clutchSlip × 2500
targetRpm    = max(idle × 0.95, coupled + throttleFlare)
```

Plus a low-speed clutch floor (`idle + throttle × 2200` below 3 m/s in gear ≥1).
RPM then eases toward target at rate `dt × 10`. In **neutral** the engine
free-revs (throttle → 90% of the way to redline) and then **decays
exponentially back to idle**:

```
excess = rpm − idle
decay  = 1.2 + 1.3 × min(1, excess / 3500)      // 1.2 …/s at idle, 2.5 …/s up high
rpm    = idle + excess × e^(−decay × dt)
```

The rate rises with rpm because there is more stored energy (and more friction
power) up high, so a big blip falls faster than a small one and everything eases
into idle. A full 6 400 rpm blip settles to idle in **~2.5 s** and is visibly
seen to coast.

> This was previously an **absolute decrement** — a flat `−0.25…−0.8 rpm per
> frame` — which was not tied to how far the needle still had to travel. From a
> 6 400 rpm blip it would have taken *hours* to reach idle, so releasing the
> throttle in neutral left the needle pinned high. Decaying the **excess** is the
> fix: the rate of closure now shrinks with the distance remaining, so it always
> converges. Fixed in this pass; see §10.

**Rev limiter**: fuel cut with 400 rpm hysteresis — `rpm ≥ 7500` → torque = 0,
`rpm < 7100` → restore. The cut is genuine (zero torque), so speed cannot keep
climbing through the limiter.

### 4.7 Auto gearbox

Only when `throttle > 0.25`, no shift in progress, gear ≥ 1:

- upshift if `rpm > 7200` and gear < 8,
- downshift if `rpm < 1400` (lugging),
- downshift if `speedKmh < 5` (cascade back to 1st).

No kickdown, no throttle mapping. Both manual and auto downshifts are **refused**
if `predictedRpm(targetGear) > redline − 200`, where predicted rpm is computed
from the current wheel speed through the candidate gear ratio.

### 4.8 Suspension — pass 1

Per wheel, in body-local space:

1. Build the world anchor from `WHEEL_LOCAL` + body transform.
2. Cast a ray straight down, `solid = true`, excluding the chassis.
3. `compression = clamp(REST − toi, −0.06, travel + 0.06)`.
4. `pointVel = linvel + angvel × r` (r = horizontal anchor offset).
5. `springF = 55000 × bumpStop × compression`
   `damperF = −4500 × pointVel.y`
   `suspF = max(0, springF + damperF)`
6. `applyImpulseAtPoint(0, suspF·dt, 0)` at the anchor.
7. **`load = suspF`** — normal load is taken directly from the suspension force.

Then axle averages are computed (`avgFront`, `avgRear`, floored at 800 N) so
that friction caps in pass 2 use a symmetric load. The comment explains why:
per-corner solver noise would otherwise produce asymmetric caps and phantom yaw
moments.

### 4.9 Tire forces — pass 2

Per grounded wheel, with `capLoad = max(800, axle-average)`, `maxTire = 1.4 × capLoad`.

**Longitudinal (rear only):**

- `tractive = driveTorquePerRear / 0.33`
- Slip estimate: `spinVel = wheelOmega × 0.33 + throttle × 2.5 × clamp(1 − |vLong|/22, 0.12, 1)`,
  `slip = clamp((spinVel − vLong)/max(3, |vLong| + 3), ±1)`. The throttle term is a
  low-speed wheelspin stand-in, deliberately faded with road speed (an earlier
  flat `+2.5 m/s` made the rears read as permanently spinning and dragged TC in
  for no reason).
- `grip = tanh(|slip| × 4) × sign(...)`, `spinLoss = |grip| × 0.28 × (1 − TC×0.6)`
- `longForce = clamp(tractive × (1 − spinLoss), ±maxTire)`
- Plus: **hill-hold** forward push (≤ 2000 N) when rolling back in gear ≥ 1;
  **torque-converter creep** in D with no pedal; in R, `revTractive` capped
  ~40 km/h plus reverse creep.

**Braking:**

- `brakeTorque = input.brake × brakeMax (+ handbrake force)`, parking brake floors
  this at 3000 Nm.
- Below 0.6 m/s the brake fades linearly to zero (no creep/jitter at walking pace).
- **ABS**: if `|vLong| < 2` and `brake > 0.7`, force is multiplied by
  `0.6 + 0.4·sin(t×90)` — a ~14 Hz pulse.
- Clamp to `±(maxTire + 2000)`, and to ±4000 N at standstill so the car is never
  pushed.

**Engine braking:** on the driven axle only, when coasting with `|vLong| > 1`,
`coastT = friction × gearRatio × 0.85 × lockup / 2 / 0.33` where
`lockup = clamp((speedKmh − 10)/15, 0, 1)` — so the fluid coupling slips at
crawl (the car can creep) and high gears barely slow the car.

**Rolling resistance:** a flat 55 N opposing `vLong`.

**Lateral:**

```
latForce   = −vLat × 9.0 × 520            // linear cornering stiffness
maxLat     = 1.4 × capLoad × (handbrake ? 0.35 rear : 1) × (front ? 0.92 : 1.15)
latUse     = clamp(|longForce| / maxTire, 0, 1)
latRoom    = maxLat × clamp(sqrt(1 − latUse² × 0.7), 0.5, 1)   // friction ELLIPSE
latForce   = clamp(latForce, ±latRoom)
```

The rear gets **1.15×** lateral capacity and the front **0.92×** — a synthetic
understeer bias for keyboard drivability.

The ellipse (rather than the old `maxLat − |long|×0.85` subtraction) is the most
important recent fix: under the old formula, full throttle left the rear axle with
~26% lateral capacity and the car could never be caught. The ellipse with a 0.5
floor keeps half the lateral budget always available.

ESC also boosts lateral force by `1 + 0.2 × 0.4 = 1.08×` above 4 m/s of lateral
velocity, clamped to `±1.2 × maxLat`.

**Force application point:** horizontal impulse applied at
`contactY + (anchor.y − contactY) × 0.5` — halfway between contact patch and hub.
Applying at ground level on a single rigid body produced violent pitch moments;
0.5 gives believable squat/dive without endo.

### 4.10 Aero
Drag and downforce as a single impulse on the CoM (see §3.6).

### 4.11 Attitude stabilization
A torque impulse, not a real anti-roll bar:

```
x: −tilt.x × 5500 − angvel.x × 2600     // roll righting
y: −angvel.y × 1800                    // yaw damping
z: −tilt.z × 5500 − angvel.z × 2600     // pitch righting
```

Pitch damping (2600) is deliberately strong — the comment says it prevents
stoppies at 300 km/h braking. Combined with the low CoM collider this is what
keeps the car from spinning on the spot.

If **all four wheels lose ground contact**, pitch/roll damping drops to 300.

### 4.12 ESC / countersteer assist

Active when `|fwdSpeed| > 2.5`, ≥3 wheels grounded, and handbrake is **not** held.

```
deadzone    = steering ? 0.06 rad : 0.02 rad      // 3.4° vs 1.1°
betaExcess  = |beta| − deadzone
speedF      = clamp(|fwdSpeed| / 33.3, 0, 1)
powerOn     = throttle > 0.15 && !launching
authority   = (steering ? lerp(0.9, 0.5, speedF) : 1) × (0.5 + SC) × (powerOn ? 1.0 : 1.35)

esc = −sign(beta) × betaExcess × 6000 − angvel.y × 1500     // bleed the slide off
if (sign(input.steer) === −sign(beta)):                       // ONLY when countersteering
    esc += input.steer × clamp(betaExcess / 0.1, 0, 1) × countersteerAssist
applyTorqueImpulse(y = clamp(esc × authority, ±6000) × dt)
```

Two design points stand out and are both called out in comments:

- The countersteer term is gated on the steer input **opposing** the slide.
  Keying off steer alone made the assist feed the slide it was supposed to catch,
  and spun the car on entry.
- Authority is **strongest at low speed** and weakest at 0.5× when steering,
  because 1st/2nd/3rd-gear slides need to re-hook fastest.

### 4.13 Telemetry smoothing
- `slipRatioAvg` — exponential, `dt × 5`, averaged over 4 wheels (fronts
  contribute 0).
- `rearSlip` — mean signed rear slip ratio.
- `spinOmega = rollingOmega + rearSlip × max(3, |fwdSpeed| + 3) / 0.33` — drives
  honest visual rear-wheel spin (hooked tires track road speed exactly).
- `drifting = |lateralVelocity| > 4.5 && speedKmh > 40` — drives the DRIFT badge.

### 4.14 Dashboard gauge scale

The tacho dial spans **0–8 000 rpm** (`MAX_RPM`) with **16 ticks**, i.e. one tick
per 500 rpm.

The **painted red band starts at 7 000 rpm** (`RED_FROM_RPM` in `Dashboard.tsx`),
covering the final 1 000 rpm. The arc, the tick and label colours, the needle
colour and the numeric readout all switch at that same threshold.

This is deliberately *not* `redlineRPM` (7 500), which is where the ECU actually
cuts fuel. On a dial topping out at 8 000, starting the band at 7 500 paints only
the last 1/16th of the sweep — a sliver that does not read as a redline. Starting
at 7 000 marks the band the driver is being warned off, and 7 500 still falls
inside it, so the needle goes red slightly before the limiter bites.
**Presentation only — the limiter's behaviour in `CarController` is unchanged.**

---

## 5. World physics

`WorldManager.createPhysicsGround` builds **one fixed body** with a
`cuboid(3000, 0.5, 3000)` collider at `y = −0.55` (surface at **y = −0.05**),
friction 1.0, restitution 0. `moveGroundBody` **teleports** it to whole-metre
snapped positions under the car each frame — a fixed body teleport imparts no
velocity, so it is artifact-free, and it is what makes the "endless flat plane"
actually endless instead of ending after ~1.5 km.

**The visual road and the physics road disagree by design.** Visually the road is
a set of 35 pooled ribbon meshes whose vertices are sampled from
`roadCenterX(s) = sin(s × 0.004) × 60 + sin(s × 0.0013 + 1.7) × 120` — 12 m wide,
50 m segments, 30 ahead / 5 behind, 16 cross-sections each, lifted 0.02 m off the
ground. Physically it is **completely flat**. Curvature is therefore visual only;
the tires never feel it. The road's asphalt texture also carries its own lane
markings, so `laneWidth`/`shoulderWidth` in `WORLD_CONFIG` are unused.

Segment geometry is rewritten **in place** on recycle (fixed topology, positions
zeroed until `writeRibbon` fills them), which is why `frustumCulled = false` —
culling would need per-recycle bounding volumes. Shared boundary samples keep
neighbouring segments watertight; the previous flat-tile approach opened visible
wedges of bare ground at every segment boundary on curves.

Vegetation: up to 6 variants extracted from `tree_pack.glb`, normalized to 6.5 m
tall, baked to one merged geometry each, drawn as `InstancedMesh` (≤900 total,
40 per segment). Trees and the 14 pooled hills are **seeded by segment index**, so
a given stretch of road looks the same every time you pass it, and they respawn
150–700 m off the road center, ahead and inside fog, so nothing pops in.

---

## 6. Controls

| Input | Action |
| --- | --- |
| `W` / `↑` | Throttle |
| `S` / `↓` | **Brake in gears ≥1 and N; throttle in R** |
| `A` `D` / `←` `→` | Steer |
| `Q` / `E` | Downshift / upshift (manual mode) |
| `M` | Auto / manual |
| `L` | Toggle launch control enable |
| `Space` | Handbrake — **disables TC and ESC entirely** |
| `R` | Reset car to road center at current `s` |
| `C` | Toggle chase distance (5.5 m / 4.3 m) |
| `Enter` | Start |
| `Esc` | Release mouse |
| Mouse | Orbit camera; eases back behind the car after 2.5 s |

Analog smoothing in `InputManager`: pedals ramp at 6/s toward target; steering at
4.5/s on attack, 7.0/s on release.

**Pointer lock** is handled with a promise-observing `tryLock` and a 350 ms
backoff retry, `unadjustedMovement: true` where supported (bypasses OS mouse
acceleration), plus a belt-and-braces `cursor: none` on `html` and `body`.

---

## 7. Testing

Three headless Bun scripts that construct the same Rapier world and drive
`CarController` at a fixed 1/120 s:

- **`scripts/smoke-test.ts`** — PASS/FAIL assertions: suspension settles in
  0.6–0.85 m, parking brake engages at spawn and releases on first throttle,
  idle creep settles into a 2–15 km/h cruise, launch-control arming and rpm pin,
  rev limiter behaviour, plus more. **Note:** this script currently does not run
  to completion — `t` is referenced at line 45 before its `let` declaration at
  line 73, so it dies with a TDZ `ReferenceError` after the first two checks
  (which do pass: suspension settles at y = 0.693, parking brake engaged at
  spawn). The `t` declaration needs hoisting above line 40; the neutral
  wind-down fix in §10 was verified with a standalone harness in the meantime.
- **`scripts/drift-matrix.ts`** — 60 cases (gears 1–6 × entry speeds
  15/25/35/50/70 m/s × handbrake or steering entry). Establishes a sustained
  drift at full throttle, then applies opposite lock and checks the **sign of the
  resulting yaw rate flips** — "did the car rotate back the other way". This is
  the regression harness for the handling fixes.
- **`scripts/road-test.ts`** — road ribbon continuity (watertight segment joins).

`scripts/smoke-test.ts:20` still contains `toggleDebugPressed` in its `idle`
input object, a field that no longer exists on `DriveInput` — harmless (the cast
to `DriveInput` absorbs it) but a leftover.

---

## 8. Honest assessment of the physics

**What is genuinely implemented**

- Drivetrain with a real torque curve, gear ratios, a torque converter, fuel-cut
  limiter, and over-rev-protected shifting.
- Raycast suspension with progressive bump-stops and load transfer via spring
  compression.
- A friction **ellipse** with a floor, so lateral grip is always partly
  recoverable under power — the key fix that makes slides catchable.
- Rate-limited, grip-capped steering with a hard floor, so countersteer always
  has authority.
- Aero drag + downforce, engine braking, rolling resistance, hill-hold.
- TC / ABS / ESC / countersteer-assist with careful, documented gating.

**What is nominal rather than physical**

- **No differential model.** The LSD block is dead config.
- **Tire model is linear-then-clip, not Pacejka.** The coefficient tables are
  decoration; only lateral `B` and a hardcoded `muPeak = 1.4` are live.
- **No Ackermann**, identical front wheel angles.
- **No suspension geometry** — no anti-dive/anti-squat, no roll centers, no
  camber gain. Anti-roll bars are replaced by a torque impulse.
- **RPM is kinematic**, not integrated from torque with flywheel inertia. Engine
  braking is the only place real engine friction shows up.
- **Aero has no pitch moment** — no lift coefficient, no front/rear balance, and
  downforce doesn't transfer load between axles.
- **The road the car drives on is flat**; the curved road is a texture of
  positions with no effect on grip.
- **Declared vs actual mass** (1650 vs 1750 kg) and **declared vs actual power**
  (800 vs 829 hp) disagree.
- Roughly **20 constants in `physics.ts` and 15 in `world.ts` are never read** —
  they read as intent for features not yet built (differential, Pacejka,
  Ackermann, anti-roll bars, terrain, banking, elevation, LOD).

**Structural notes**

- There is no physics/render interpolation — `CarVisual` reads the body transform
  post-step, so visual smoothness depends on render rate (motion blur at low fps).
- `WORLD_CONFIG`'s terrain, banking, elevation and curvature systems are
  entirely bypassed in favour of the analytic `roadCenterX(s)` sine sum.
- The tuning loop is **git comments**: nearly every non-obvious constant carries a
  paragraph explaining what it replaced and why, which is unusually valuable
  context and is preserved here.

---

## 9. Where physics tuning would go

1. `src/mainview/constants/physics.ts` — the single source of vehicle truth.
   Anything you want to change about the car's behaviour belongs here (or be
   hardcoded like `muPeak`, `REST`, `steerRate`, `REST` — which is the real
   problem: the top-level constants file is only *partly* authoritative).
2. `CarController.update()` — for changes that need per-wheel or per-frame
   context (assist logic, force blending, torque impulses).
3. `PhysicsSystem.ts` — body/collider mass, damping, timestep, ground.
4. `WorldManager.createPhysicsGround` — for the only world geometry that has any
   physical effect.
5. `scripts/drift-matrix.ts` — run after any change to steering, assists, tire
   forces or the friction ellipse; it is the regression net for the handling
   work that dominates the recent history.

---

## 10. Changelog

### Neutral RPM wind-down fix

**Symptom:** in neutral (`Q` down twice from 1st, or `M` into manual), blipping
the throttle sent the needle up to ~6 400 rpm and it never came back down — not
slowly, essentially at all.

**Cause** (`CarController.ts`, the `gear === 0` branch of the RPM model): the
wind-down subtracted a fixed **absolute** amount per frame,

```
windDown = (0.25 + 0.55 × min(1, excess / 3500)) × dt   // 0.25 … 0.8 rpm/frame
rpm     -= windDown
```

At the 1/120 s timestep that is a maximum of 96 rpm per *second*, independent of
how much needle travel remained. Closing a 5 600 rpm gap therefore took ~58
seconds of sim time — long enough that in practice it read as "the needle is
stuck". The bug was that the step size did not scale with the distance remaining,
so the decay never converged.

**Fix:** decay the **excess** exponentially instead of stepping it down a fixed
amount, with a rate that rises with rpm (more stored energy and more friction
power up high):

```
excess = rpm − idle
decay  = 1.2 + 1.3 × min(1, excess / 3500)      // 1.2 /s near idle → 2.5 /s up high
rpm    = idle + excess × e^(−decay × dt)
```

**Verified** headlessly (`gear = 0`, 0.5 s of full throttle from idle, then
throttle released):

| time after release | rpm |
| --- | --- |
| 0.00 s | 6 246 |
| 0.50 s | 2 558 |
| 1.00 s | 1 573 |
| 1.50 s | 1 183 |
| 2.00 s | 999 |
| 2.56 s | **< 900 (settled)** |
| 3.50 s | 831 |

A full blip now settles in ~2.5 s with a visible coast down, instead of never.
`scripts/drift-matrix.ts` re-run afterwards: **60/60 cases recovered** — the
drivetrain change does not disturb handling.

### Tacho redline band → 7 000 rpm

`Dashboard.tsx` now paints the red band, red ticks/labels, red needle and red
numeric readout from **7 000 rpm** instead of 7 500. Introduced as
`RED_FROM_RPM` so the display threshold is decoupled from
`engine.redlineRPM`; the constant is a local UI value and `CAR_PHYSICS` is no
longer imported by `Dashboard.tsx`.

**Functionality is untouched** — the rev limiter still cuts fuel at 7 500 rpm in
`CarController`. Only the gauge's presentation threshold moved. See §4.14.