/**
 * Phase 4 regression tests: hybrid dynamic correction.
 *
 * Run: `bun scripts/net-correction-test.ts` (exit 1 on any failure).
 * Deterministic: RemoteCar.nowOverride freezes the monotonic clock;
 * contact observations take explicit timestamps. No wall-clock sleeps.
 */
import * as THREE from "three"
import {
  initPhysics,
  createWorld,
  createChassisBody,
  FIXED_DT,
} from "../src/mainview/systems/PhysicsSystem"
import {
  CorrectionState,
  clampCorrectionDelta,
  CORRECTION_ACCEL_MAX,
  CONTACT_GRACE_MS,
  HARD_IMPACT_GRACE_MS,
} from "../src/mainview/systems/net/correction"
import { validateStatePacket } from "../src/mainview/systems/net/stateProtocol"
import { getNetDiagSnapshot } from "../src/mainview/systems/net/NetDiagnostics"
import { RemoteCar } from "../src/mainview/systems/net/RemoteCar"

let failures = 0
let passes = 0
function check(name: string, cond: boolean, extra?: unknown) {
  if (cond) {
    passes++
    console.log(`ok - ${name}`)
  } else {
    failures++
    console.error(`FAIL - ${name}`, extra ?? "")
  }
}
const approx = (a: number, b: number, eps = 1e-6) => Math.abs(a - b) <= eps

const R = await initPhysics()
function makeWorld() {
  const world = createWorld()
  const ground = world.createRigidBody(R.RigidBodyDesc.fixed())
  world.createCollider(
    R.ColliderDesc.cuboid(500, 0.5, 500).setTranslation(0, -0.5, 0),
    ground,
  )
  const scene = new THREE.Scene()
  return { world, scene }
}
function makeRemote(world: any, scene: THREE.Scene, id: string): RemoteCar {
  return new RemoteCar(id, id, 0xffffff, scene, "./", world, R)
}
function pkt(seq: number, x: number, z: number, vx = 0, vz = 0) {
  const r = validateStatePacket({
    id: "p",
    t: 0,
    seq,
    sess: "s",
    x,
    y: 0.72,
    z,
    qx: 0,
    qy: 0,
    qz: 0,
    qw: 1,
    vx,
    vy: 0,
    vz,
    steer: 0,
    speed: 0,
    rpm: 800,
    gear: 1,
    drift: false,
    smoke: false,
    progress: seq,
  })
  if (!r.ok) throw new Error("bad test packet")
  return r.state
}
const diag = (id: string) => getNetDiagSnapshot().peers[id]

// ---------- A1. correction delta clamp (pure) ----------
{
  const out = { x: 0, y: 0, z: 0 }
  const m = clampCorrectionDelta(0, 0, 0, 10, 0, 0, 0.2, out)
  check("A1 clamp direction+mag", approx(out.x, 0.2) && approx(m, 0.2), out)
  const out2 = { x: 0, y: 0, z: 0 }
  clampCorrectionDelta(1, 0, 0, 1.05, 0, 0, 0.2, out2)
  check("A1 under-limit passes", approx(out2.x, 1.05), out2)
}

// ---------- A2. mode machine + hysteresis (pure, fake clock) ----------
{
  const c = new CorrectionState()
  check("A2 follow factor 1", c.factor(0) === 1)
  c.noteContact(true, 0, 1000)
  check("A2 contact factor 0", c.factor(1000) === 0 && c.mode === "contact")
  c.noteContact(false, 0, 1000 + CONTACT_GRACE_MS - 50)
  check("A2 grace holds", c.mode === "contact", c.mode)
  c.noteContact(false, 0, 1000 + CONTACT_GRACE_MS + 1)
  check("A2 recover after grace", c.mode === "recover", c.mode)
  const f = c.factor(1000 + CONTACT_GRACE_MS + 1 + 200)
  check("A2 ramp mid", f > 0 && f < 1, f)
  check(
    "A2 ramp completes",
    c.factor(1000 + CONTACT_GRACE_MS + 1 + 1000) === 1 && c.mode === "follow",
  )
  // Hard impact extends suppression (calibrated grace, not the 300 ms base).
  const h = new CorrectionState()
  h.noteContact(true, 9000, 0)
  h.noteContact(false, 0, CONTACT_GRACE_MS + 50)
  check("A2 hard hit extends", h.mode === "contact", h.mode)
  h.noteContact(false, 0, HARD_IMPACT_GRACE_MS + 50)
  check("A2 extended grace ends", h.mode === "recover", h.mode)
}

// ---------- B3. normal trajectory following ----------
{
  const { world, scene } = makeWorld()
  const car = makeRemote(world, scene, "c-follow")
  const T = 1_000_000
  car.nowOverride = T
  for (let i = 0; i < 10; i++) car.onPacket(pkt(i, i * 0.5, -50), T + i * 33)
  car.nowOverride = T + 9 * 33 + 100 // renderTime == newest arrival
  const p0 = car.colliderBody!.translation()
  const e0 = Math.hypot(4.5 - p0.x, -50 - p0.z)
  let maxDv = 0
  for (let i = 0; i < 30; i++) {
    car.drive(FIXED_DT)
    world.step()
    const d = diag("c-follow")
    if (d) maxDv = Math.max(maxDv, d.corrDv)
  }
  const p1 = car.colliderBody!.translation()
  const e1 = Math.hypot(4.5 - p1.x, -50 - p1.z)
  check("B3 converges", e1 < e0, { e0, e1 })
  check("B3 dv bound", maxDv <= CORRECTION_ACCEL_MAX * FIXED_DT + 1e-6, maxDv)
  check(
    "B3 follow mode",
    diag("c-follow")?.corrMode === "follow",
    diag("c-follow")?.corrMode,
  )
  car.dispose(scene, world)
  world.free()
}

// ---------- B4/B5/B6. contact suppresses servos, no oscillation ----------
{
  const { world, scene } = makeWorld()
  const local = createChassisBody(world, 0, 0.72, -8)
  for (let i = 0; i < 60; i++) world.step() // settle
  const car = makeRemote(world, scene, "c-contact")
  const T = 2_000_000
  car.nowOverride = T
  // Drive the ghost -z at 8 m/s straight through the parked local car.
  for (let i = 0; i < 40; i++)
    car.onPacket(pkt(i, 0, -i * 0.264, 0, -8), T + i * 33)
  car.nowOverride = T + 39 * 33 + 100
  let sawContact = false
  // Applied correction bleeds to zero at the accel limit on contact entry
  // (no abrupt velocity reversal by design) — then stays there.
  let entryCmd = -1
  let maxCmdAfterEntry = 0
  let minCmd = Infinity
  let violatedMono = false
  let prevCmd = Infinity
  let maxContactSpeed = 0
  let minContactSpeed = Infinity
  let contactCount = 0
  for (let i = 0; i < 300; i++) {
    car.drive(FIXED_DT)
    world.step()
    car.sampleContacts(T + 39 * 33 + 100)
    const d = diag("c-contact")
    if (d?.inContact) sawContact = true
    // Suppression is keyed on MODE (drive-time), not the frame-sampled
    // flag: contact observation lags at most one frame by design.
    if (d?.corrMode === "contact") {
      if (entryCmd < 0) {
        entryCmd = d.corrCmd
        prevCmd = d.corrCmd
      } else {
        if (d.corrCmd > prevCmd + 1e-6) violatedMono = true
        prevCmd = d.corrCmd
      }
      maxCmdAfterEntry = Math.max(maxCmdAfterEntry, d.corrCmd)
      minCmd = Math.min(minCmd, d.corrCmd)
      contactCount++
      // Speeds only after the entry transient has bled off at the accel
      // limit (~35 substeps from full correction): steady contact behavior.
      if (contactCount > 40) {
        const v = car.colliderBody!.linvel()
        const sp = Math.hypot(v.x, v.z)
        maxContactSpeed = Math.max(maxContactSpeed, sp)
        minContactSpeed = Math.min(minContactSpeed, sp)
      }
    }
  }
  check("B4 contact observed", sawContact)
  check(
    "B4 correction never grows in contact",
    !violatedMono && maxCmdAfterEntry <= entryCmd + 1e-6,
    { entryCmd, maxCmdAfterEntry },
  )
  check("B4 correction bleeds to zero", minCmd < 0.1, minCmd)
  check(
    "B5 no oscillation/bounce in contact",
    maxContactSpeed <= 8 + 3 && minContactSpeed >= -1,
    { maxContactSpeed, minContactSpeed },
  )
  const lv = local.linvel()
  check("B5 local not launched", Math.hypot(lv.x, lv.z) <= 8 + 3, lv)
  car.dispose(scene, world)
  world.free()
}

// ---------- B7. recovery: hysteresis then gradual reconvergence, no warp ----------
{
  const { world, scene } = makeWorld()
  const local = createChassisBody(world, 0, 0.72, -8)
  for (let i = 0; i < 60; i++) world.step()
  const car = makeRemote(world, scene, "c-recover")
  const T = 3_000_000
  car.nowOverride = T
  for (let i = 0; i < 10; i++)
    car.onPacket(pkt(i, 0, -i * 0.3, 0, -9), T + i * 33)
  car.nowOverride = T + 9 * 33 + 100
  // Push into the local car until contact registers.
  for (let i = 0; i < 120 && !diag("c-recover")?.inContact; i++) {
    car.drive(FIXED_DT)
    world.step()
    car.sampleContacts(T + 9 * 33 + 100)
  }
  check("B7 contact first", !!diag("c-recover")?.inContact)
  // Separate: teleport the LOCAL car away (ghost keeps its packets).
  const lp = local.translation()
  local.setTranslation({ x: lp.x + 30, y: lp.y, z: lp.z }, true)
  local.setLinvel({ x: 0, y: 0, z: 0 }, true)
  // Still inside grace: mode must hold contact (hysteresis, deterministic).
  car.sampleContacts(T + 9 * 33 + 200)
  check(
    "B7 grace holds",
    diag("c-recover")?.corrMode === "contact",
    diag("c-recover")?.corrMode,
  )
  // Recovery with live packets and wall≈sim time advancing together (as in
  // production). The opening ram was a hard hit → 800 ms extended grace,
  // then 400 ms ramp: run 200 steps (1.7 s) to pass through all modes.
  const snapsBefore = diag("c-recover")?.snaps ?? -1
  const errAtSep = diag("c-recover")?.posErrM ?? -1
  let now = T + 9 * 33 + 100
  let seq = 10
  let z = -2.7
  const modes = new Set<string>()
  for (let i = 0; i < 200; i++) {
    now += 1000 / 120
    car.nowOverride = now
    if (i % 4 === 0) {
      z -= 0.3
      car.onPacket(pkt(seq++, 0, z, 0, -9), now)
    }
    car.drive(FIXED_DT)
    world.step()
    if (i % 10 === 0) car.sampleContacts(now)
    const d = diag("c-recover")
    if (d) modes.add(d.corrMode)
  }
  const d = diag("c-recover")
  check(
    "B7 passed through recovery",
    modes.has("recover") && modes.has("follow"),
    [...modes],
  )
  check(
    "B7 reconverges gradually",
    (d?.posErrM ?? 1e9) < Math.min(errAtSep, 3),
    { sep: errAtSep, after: d?.posErrM },
  )
  check(
    "B7 no warp during recovery",
    (d?.snaps ?? -1) === snapsBefore,
    d?.snaps,
  )
  car.dispose(scene, world)
  world.free()
}

// ---------- B8. stale peer: commands zero, drags nothing ----------
{
  const { world, scene } = makeWorld()
  const local = createChassisBody(world, 2.2, 0.72, 0) // adjacent to ghost
  for (let i = 0; i < 60; i++) world.step()
  const car = makeRemote(world, scene, "c-stale")
  const T = 4_000_000
  car.onPacket(pkt(0, 0, 0), T) // arrival 2 s "ago"
  car.nowOverride = T + 2000
  for (let i = 0; i < 60; i++) {
    car.drive(FIXED_DT)
    world.step()
  }
  const v = car.colliderBody!.linvel()
  check("B8 stale ghost still", Math.hypot(v.x, v.z) < 0.5, v)
  const lp0 = { x: 2.2, z: 0 }
  const lp1 = local.translation()
  check(
    "B8 neighbor not dragged",
    Math.hypot(lp1.x - lp0.x, lp1.z - lp0.z) < 0.1,
    lp1,
  )
  car.dispose(scene, world)
  world.free()
}

// ---------- B9. large discontinuity still warps ----------
{
  const { world, scene } = makeWorld()
  const car = makeRemote(world, scene, "c-warp")
  const T = 5_000_000
  car.nowOverride = T
  car.onPacket(pkt(0, 0, 0), T)
  car.onPacket(pkt(1, 50, 0), T + 33)
  car.nowOverride = T + 33 + 100
  car.drive(FIXED_DT)
  const p = car.colliderBody!.translation()
  check("B9 warp snaps", Math.hypot(p.x - 50, p.z) < 2, p)
  check(
    "B9 warp counted",
    (diag("c-warp")?.snaps ?? 0) >= 1,
    diag("c-warp")?.snaps,
  )
  check(
    "B9 mode reset to follow",
    diag("c-warp")?.corrMode === "follow",
    diag("c-warp")?.corrMode,
  )
  car.dispose(scene, world)
  world.free()
}

// ---------- B10. repeated correction never injects unbounded energy ----------
{
  const { world, scene } = makeWorld()
  const car = makeRemote(world, scene, "c-energy")
  const T = 6_000_000
  let seq = 0
  let maxSpeed = 0
  let maxDv = 0
  for (let step = 0; step < 600; step++) {
    // Oscillating target ±8 m at ~7 Hz: worst case for servo pumping.
    const now = T + step * (1000 / 120)
    car.nowOverride = now
    if (step % 4 === 0) {
      const x = 8 * Math.sin(step / 4 / 5)
      car.onPacket(pkt(seq++, x, -50), now)
    }
    car.drive(FIXED_DT)
    world.step()
    const v = car.colliderBody!.linvel()
    maxSpeed = Math.max(maxSpeed, Math.hypot(v.x, v.z))
    const d = diag("c-energy")
    if (d) maxDv = Math.max(maxDv, d.corrDv)
  }
  check("B10 speed capped", maxSpeed <= 120, maxSpeed)
  check(
    "B10 dv bounded every substep",
    maxDv <= CORRECTION_ACCEL_MAX * FIXED_DT + 1e-6,
    maxDv,
  )
  car.dispose(scene, world)
  world.free()
}

// ---------- B11/B12. reset, cleanup, post-teardown queries ----------
{
  const { world, scene } = makeWorld()
  const car = makeRemote(world, scene, "c-teardown")
  const T = 7_000_000
  car.nowOverride = T
  car.onPacket(pkt(0, 0, 0), T)
  car.drive(FIXED_DT)
  car.sampleContacts(T)
  car.resetInterpolation("test")
  check(
    "B11 reset mode",
    diag("c-teardown")?.corrMode === "follow" ||
      diag("c-teardown") === undefined,
    diag("c-teardown")?.corrMode,
  )
  car.dispose(scene, world)
  let threw = false
  try {
    car.sampleContacts(T + 100)
    car.drive(FIXED_DT)
  } catch {
    threw = true
  }
  check("B11 post-dispose safe", !threw)
  world.free()
  threw = false
  try {
    car.sampleContacts(T + 200)
  } catch {
    threw = true
  }
  check("B12 post-free safe", !threw)
}

// ---------- B13. angular servo hands off in contact, alive in follow ----------
{
  const { world, scene } = makeWorld()
  // Striker parked 5 cm into the ghost's flank: real narrow-phase contact.
  const striker = createChassisBody(world, 1.8, 0.72, 0)
  for (let i = 0; i < 60; i++) world.step() // settle
  const car = makeRemote(world, scene, "c-angular")
  const T = 9_000_000
  car.nowOverride = T
  // Identity-quat target at the ghost's position: only orientation differs.
  car.onPacket(pkt(0, 0, 0), T)
  // Establish traffic contact (horizontal normals) with the flank.
  for (let i = 0; i < 30 && !diag("c-angular")?.inContact; i++) {
    car.drive(FIXED_DT)
    world.step()
    car.sampleContacts(T)
  }
  check(
    "B13 contact established",
    diag("c-angular")?.corrMode === "contact",
    diag("c-angular")?.corrMode,
  )
  // Knock the ghost 90° off target with solver-style spin (as a side-swipe
  // would leave it). The follow-mode servo would command up to 8 rad/s
  // against this error — in contact mode it must not touch angvel at all.
  const yaw90 = new THREE.Quaternion().setFromEuler(
    new THREE.Euler(0, Math.PI / 2, 0),
  )
  car.colliderBody!.setRotation(
    { x: yaw90.x, y: yaw90.y, z: yaw90.z, w: yaw90.w },
    true,
  )
  car.colliderBody!.setAngvel({ x: 0, y: 2.5, z: 0 }, true)
  car.drive(FIXED_DT) // contact mode: servo must be hands-off
  const w = car.colliderBody!.angvel()
  check(
    "B13 collision spin preserved in contact",
    approx(w.x, 0) && approx(w.y, 2.5) && approx(w.z, 0),
    w,
  )
  // Separate and let grace+ramp expire: the same 90° error must now be
  // servoed (proves the servo is alive in follow, not globally dead).
  // NOTE: step first — the narrow phase only refreshes on world.step(),
  // so sampling immediately after a teleport would read stale manifolds.
  // Production always samples after stepping (updateRemoteCars per frame).
  const sp = striker.translation()
  striker.setTranslation({ x: sp.x + 30, y: sp.y, z: sp.z }, true)
  striker.setLinvel({ x: 0, y: 0, z: 0 }, true)
  for (let i = 0; i < 5; i++) world.step()
  car.nowOverride = T + 1000
  car.onPacket(pkt(1, 0, 0), T + 1000) // fresh arrival: authority 1
  car.sampleContacts(T + 1000)
  car.nowOverride = T + 1600 // past 300 ms grace + 400 ms ramp
  car.sampleContacts(T + 1600)
  car.onPacket(pkt(2, 0, 0), T + 1600) // fresh arrival: authority 1
  car.colliderBody!.setAngvel({ x: 0, y: 2.5, z: 0 }, true)
  car.drive(FIXED_DT)
  const w2 = car.colliderBody!.angvel()
  const w2mag = Math.hypot(w2.x, w2.y, w2.z)
  check(
    "B13 servo re-engages in follow",
    !approx(w2.y, 2.5) && w2mag > 1 && w2mag <= 8 + 1e-6,
    w2,
  )
  car.dispose(scene, world)
  world.free()
}

// ---------- overhead probe ----------
{
  const { world, scene } = makeWorld()
  const local = createChassisBody(world, 0, 0.72, -3)
  const car = makeRemote(world, scene, "c-perf")
  for (let i = 0; i < 30; i++) world.step()
  const t0 = performance.now()
  for (let i = 0; i < 2000; i++) car.sampleContacts(8_000_000)
  const us = ((performance.now() - t0) / 2000) * 1000
  console.log(
    `contact-sample cost: ${us.toFixed(2)}us/call (touching=${diag("c-perf")?.inContact})`,
  )
  check("overhead sane (<50us)", us < 50, us)
  void local
  car.dispose(scene, world)
  world.free()
}

console.log(`\n${passes} passed, ${failures} failed`)
process.exit(failures ? 1 : 0)
