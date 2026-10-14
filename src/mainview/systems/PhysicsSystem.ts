import * as RAPIER from "@dimforge/rapier3d-compat"
import { CAR_PHYSICS } from "../constants/physics"

let R: typeof RAPIER | null = null
// StrictMode/HMR can start two session setups at once — concurrent init()
// calls race on the same WASM memory and corrupt the heap (surfacing later
// as "Out of bounds memory access" inside raw set constructors). One flight.
let initP: Promise<typeof RAPIER> | null = null

export function initPhysics(): Promise<typeof RAPIER> {
  if (R) return Promise.resolve(R)
  if (!initP) {
    initP = RAPIER.init().then(() => RAPIER)
  }
  return initP.then((mod) => {
    R = mod
    return mod
  })
}

export function getR(): typeof RAPIER {
  if (!R) throw new Error("Rapier not initialized — call initPhysics() first")
  return R
}

export function createWorld(): RAPIER.World {
  const RAPIER_ = getR()
  const world = new RAPIER_.World({ x: 0, y: -9.81, z: 0 })
  world.timestep = 1 / 120
  return world
}

export function createChassisBody(
  world: RAPIER.World,
  x: number,
  y: number,
  z: number,
): RAPIER.RigidBody {
  const RAPIER_ = getR()
  const P = CAR_PHYSICS
  const bodyDesc = RAPIER_.RigidBodyDesc.dynamic()
    .setTranslation(x, y, z)
    .setLinvel(0, 0, 0)
    .setAngvel({ x: 0, y: 0, z: 0 })
    .setLinearDamping(0.005)
    .setAngularDamping(0.55)
    .setCcdEnabled(true)
  const body = world.createRigidBody(bodyDesc)
  const col = RAPIER_.ColliderDesc.cuboid(
    P.dimensions.width / 2,
    0.32,
    P.dimensions.length / 2,
  )
    .setTranslation(0, -0.1, 0)
    .setMass(P.mass.chassis)
    .setFriction(0.4)
    .setRestitution(0.1)
  world.createCollider(col, body)
  world.createCollider(createCabinCollider(RAPIER_), body)
  return body
}

/**
 * Cabin/roof volume the chassis slab doesn't cover (slab top is at
 * body-local +0.22; the visual roof is at ~+0.69). Without it a flipped
 * car settles on the slab at body y≈0.22 and the rendered roof ends up
 * ~0.45 m underground. With it the car rests on its roof at y≈0.69,
 * matching the visual. Upright it only fills the previously hollow
 * cabin, so door-height side contacts now land instead of clipping.
 * Mass comes from default density (~2 kg) — dynamics unchanged.
 */
export function createCabinCollider(RAPIER_: typeof RAPIER) {
  return RAPIER_.ColliderDesc.cuboid(0.75, 0.33, 1.05)
    .setTranslation(0, 0.36, 0.2)
    .setFriction(0.4)
    .setRestitution(0.1)
}

export function stepWorld(world: RAPIER.World, dt: number) {
  const n = Math.min(
    MAX_SUBSTEPS,
    Math.max(1, Math.round(dt / FIXED_DT)),
  )
  for (let i = 0; i < n; i++) world.step()
}

export const FIXED_DT = 1 / 120

export const MAX_SUBSTEPS = 6

export interface FixedStepper {
  acc: number
  droppedTotal: number
}

export function createFixedStepper(): FixedStepper {
  return { acc: 0, droppedTotal: 0 }
}

export function pushFrameTime(stepper: FixedStepper, frameDt: number): number {
  stepper.acc += frameDt
  let steps = Math.floor(stepper.acc / FIXED_DT)
  if (steps > MAX_SUBSTEPS) {
    const dropped = stepper.acc - MAX_SUBSTEPS * FIXED_DT
    stepper.droppedTotal += dropped
    stepper.acc = MAX_SUBSTEPS * FIXED_DT
    steps = MAX_SUBSTEPS
  }
  return steps
}

export function consumeSubstep(stepper: FixedStepper): void {
  stepper.acc -= FIXED_DT
  if (stepper.acc < 0) stepper.acc = 0
}

export function stepVehicleOnce<T>(
  world: RAPIER.World,
  updateController: () => T,
): T {
  const out = updateController()
  world.step()
  return out
}

export function moveGroundBody(body: RAPIER.RigidBody, x: number, z: number) {
  body.setTranslation({ x: Math.round(x), y: 0, z: Math.round(z) }, true)
}
