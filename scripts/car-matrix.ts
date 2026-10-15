/**
 * Per-car physics gate. Every entry in the car registry (constants/cars)
 * must: settle on its suspension, launch from a standstill, pull to a
 * sane top speed, survive a handbrake slide + recovery, and expose
 * exactly 4 GLB wheel pivots (else the car silently gets cylinder
 * wheels in-game). Add a car to CARS and it is tested automatically.
 */
import * as RAPIER_ from "@dimforge/rapier3d-compat"
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js"
import * as THREE from "three"
import { CarController } from "../src/mainview/systems/CarController"
import {
  createChassisBody,
  initPhysics,
  moveGroundBody,
  FIXED_DT,
  stepVehicleOnce,
} from "../src/mainview/systems/PhysicsSystem"
import type { DriveInput } from "../src/mainview/systems/InputManager"
import { CARS } from "../src/mainview/constants/cars"
import {
  MIN_PIVOT_FRAC,
  pivotMatches,
} from "../src/mainview/systems/CarVisual"

const RAPIER = await initPhysics()

const idle: DriveInput = {
  throttle: 0, brake: 0, steer: 0, handbrake: false,
  upshiftPressed: false, downshiftPressed: false, toggleModePressed: false,
  toggleLaunchPressed: false, resetPressed: false, toggleCameraPressed: false,
  startPressed: false, escapePressed: false,
}
const W = { ...idle, throttle: 1 }

let fails = 0
const check = (car: string, name: string, cond: boolean, extra = "") => {
  console.log(
    (cond ? "PASS" : "FAIL") + " | " + car + " | " + name + (extra ? " | " + extra : ""),
  )
  if (!cond) fails++
}

/** Straight-line expectations per car (0-100 s, top-speed km/h). */
const EXPECT: Record<string, { t100: number; vmax: number }> = {
  "bmw-m3": { t100: 7, vmax: 270 },
  "audi-r8": { t100: 5, vmax: 335 },
  "g-wagon": { t100: 6, vmax: 315 },
  "lambo-urus": { t100: 5.5, vmax: 315 },
}

for (const def of CARS) {
  // --- visual: exactly 4 pivots (same rule as CarVisual.load) ---
  try {
    const buf = await Bun.file(`src/mainview/models/${def.modelFile.split("/").pop()}`).arrayBuffer()
    const glb: any = await new GLTFLoader().parseAsync(buf, "")
    const model = glb.scene
    const box = new THREE.Box3().setFromObject(model)
    const size = box.getSize(new THREE.Vector3())
    const longest = Math.max(size.x, size.y, size.z)
    const pivotBox = new THREE.Box3()
    const pivotSize = new THREE.Vector3()
    let pivots = 0
    model.traverse((o: any) => {
      if (!o.isMesh && o.children.length > 0 && pivotMatches(o.name, def.pivots)) {
        pivotBox.setFromObject(o)
        pivotBox.getSize(pivotSize)
        if (
          pivotSize.x >= longest * MIN_PIVOT_FRAC &&
          pivotSize.y >= longest * MIN_PIVOT_FRAC &&
          pivotSize.z >= longest * MIN_PIVOT_FRAC
        ) {
          pivots++
        }
      }
    })
    check(def.id, "4 wheel pivots in GLB", pivots === 4, `found=${pivots}`)
  } catch (e) {
    check(def.id, "4 wheel pivots in GLB", false, String(e).slice(0, 120))
  }

  // --- physics ---
  const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 })
  world.timestep = FIXED_DT
  const gb = world.createRigidBody(RAPIER.RigidBodyDesc.fixed())
  world.createCollider(
    RAPIER.ColliderDesc.cuboid(3000, 0.5, 3000).setTranslation(0, -0.55, 0).setFriction(1.0),
    gb,
  )
  const body = createChassisBody(
    world,
    0,
    0.72,
    0,
    def.physics.dimensions,
    def.physics.mass.chassis,
  )
  const car = new CarController(
    world,
    body,
    RAPIER,
    def.physics,
    def.wheels,
    def.dash,
  )

  const step = (inp: DriveInput, n: number) => {
    let t: any = null
    for (let i = 0; i < n; i++) {
      t = stepVehicleOnce(world, () => car.update(FIXED_DT, inp))
      if (i % 120 === 0) {
        const p = body.translation()
        moveGroundBody(gb, p.x, p.z)
      }
    }
    return t
  }

  step(idle, 120)
  const y = body.translation().y
  check(def.id, "suspension settles", y > 0.55 && y < 0.9, `y=${y.toFixed(3)}`)
  // Parking brake: engaged at spawn, cleared by throttle (electronic
  // park-brake auto-release). Idle alone must NOT release it.
  check(def.id, "parking brake engaged at spawn", car.parkingBrake === true)
  car.parkingBrake = true
  step(W, 1)
  check(def.id, "throttle releases parking brake", car.parkingBrake === false)

  // straight-line performance: 0-100 timing + top-speed run to
  // PLATEAU (3 s chunks, stops when gaining < 1.5 km/h — measures the
  // true drag-limited vmax, however long the approach takes).
  let t100 = -1
  let top = 0
  let t: any = null
  let plateau = false
  for (let chunk = 0; chunk < 30 && !plateau; chunk++) {
    const before = top
    for (let i = 0; i < 3 * 120; i++) {
      t = stepVehicleOnce(world, () => car.update(FIXED_DT, W))
      const v = Math.abs(car.forwardSpeed)
      if (v > top) top = v
      if (t100 < 0 && Math.abs(t.speedKmh) >= 100) {
        // sim time = chunks + in-chunk steps
        t100 = chunk * 3 + i / 120
      }
      if (i % 60 === 0) {
        const p = body.translation()
        moveGroundBody(gb, p.x, p.z)
      }
    }
    if (top * 3.6 - before * 3.6 < 1.5 && top > 10) plateau = true
  }
  const topKmh = top * 3.6
  const finite = Number.isFinite(topKmh) && Number.isFinite(body.translation().y)
  const alive = body.translation().y > -1
  check(def.id, "44 s WOT stays sane", finite && alive, `top=${topKmh.toFixed(0)} km/h`)
  const exp = EXPECT[def.id] ?? { t100: 8, vmax: 180 }
  check(def.id, `0-100 under ${exp.t100}s`, t100 > 0 && t100 < exp.t100, `t100=${t100.toFixed(2)}s`)
  check(def.id, `top speed > ${exp.vmax} km/h`, topKmh > exp.vmax, `top=${topKmh.toFixed(0)} km/h`)
  check(def.id, "gearbox walks up", t.gear >= 3, `gear=${t.gearLabel}`)

  // lift-off coast: foot off at 150, 6 s of idle. Must shed speed
  // like a real car (drag + half engine braking ≈ 20–40 km/h here),
  // never like the brakes are on (>55) nor freewheel forever (<8).
  body.setLinvel({ x: 0, y: 0, z: 0 }, true)
  body.setAngvel({ x: 0, y: 0, z: 0 }, true)
  body.setTranslation({ x: 0, y: 0.72, z: 0 }, true)
  moveGroundBody(gb, 0, 0)
  car.gear = 1 as any
  for (let i = 0; i < 30 * 120 && Math.abs(car.forwardSpeed) * 3.6 < 150; i++) {
    t = stepVehicleOnce(world, () => car.update(FIXED_DT, W))
    if (i % 60 === 0) {
      const p = body.translation()
      moveGroundBody(gb, p.x, p.z)
    }
  }
  const vLift = Math.abs(t.speedKmh)
  for (let i = 0; i < 6 * 120; i++) {
    t = stepVehicleOnce(world, () => car.update(FIXED_DT, idle))
    if (i % 60 === 0) {
      const p = body.translation()
      moveGroundBody(gb, p.x, p.z)
    }
  }
  const vCoast = Math.abs(t.speedKmh)
  const loss = vLift - vCoast
  check(
    def.id,
    "lift-off coasts sanely",
    loss > 8 && loss < 55,
    `150→${vCoast.toFixed(0)} loss=${loss.toFixed(0)} km/h/6s`,
  )

  // slide + recovery: steady speed, handbrake flick with lock, then
  // countersteer off-throttle — yaw rate must flip sign (car comes back).
  step(idle, 60)
  const hb = { ...idle, handbrake: true, steer: 1, throttle: 0.6 }
  step(hb, 90)
  const yawBefore = body.angvel().y
  const rec = { ...idle, steer: -1 }
  step(rec, 150)
  const yawAfter = body.angvel().y
  const recovered =
    Math.sign(yawBefore) !== Math.sign(yawAfter) || Math.abs(yawAfter) < 0.4
  check(
    def.id,
    "slide recovers with opposite lock",
    recovered,
    `yaw ${yawBefore.toFixed(2)} -> ${yawAfter.toFixed(2)}`,
  )

  try {
    world.free()
  } catch {}
}

if (fails > 0) {
  console.log(`\n${fails} check(s) FAILED`)
  process.exit(1)
}
console.log("\nAll car-matrix checks passed")
