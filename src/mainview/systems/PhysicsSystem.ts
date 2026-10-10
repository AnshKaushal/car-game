import * as RAPIER from "@dimforge/rapier3d-compat"
import { CAR_PHYSICS } from "../constants/physics"

let R: typeof RAPIER | null = null

export async function initPhysics(): Promise<typeof RAPIER> {
  if (R) return R
  await RAPIER.init()
  R = RAPIER
  return RAPIER
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
  return body
}

export function stepWorld(world: RAPIER.World, dt: number) {
  // Deprecated: applied vehicle forces once per frame, then stepped Rapier
  // N times. Kept for compatibility; new code must use the fixed-step
  // accumulator (FIXED_DT / createFixedStepper / stepVehicleOnce) so the
  // controller runs exactly once per world.step().
  const n = Math.min(
    MAX_SUBSTEPS,
    Math.max(1, Math.round(dt / FIXED_DT)),
  )
  for (let i = 0; i < n; i++) world.step()
}

/**
 * Fixed simulation timestep (seconds). All controller integration and
 * Rapier steps run at exactly this rate via an accumulator in the frame
 * loop. Matches Rapier `world.timestep` set in createWorld().
 */
export const FIXED_DT = 1 / 120

/**
 * Maximum physics substeps executed per rendered frame.
 * A normal frame (<= maxFrameDt = 1/30 s) needs at most 4 substeps;
 * 6 covers up to 50 ms of backlog (frame hitch) before the backlog
 * policy below discards time.
 */
export const MAX_SUBSTEPS = 6

export interface FixedStepper {
  acc: number
  droppedTotal: number
}

export function createFixedStepper(): FixedStepper {
  return { acc: 0, droppedTotal: 0 }
}

/**
 * Backlog policy: accumulate clamped frame time, run at most MAX_SUBSTEPS
 * substeps, and DISCARD any time beyond that (counted in droppedTotal for
 * dev measurement) instead of spiralling to catch up. Call once per frame;
 * returns how many FIXED_DT substeps the caller must execute.
 */
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
  // Guard float drift: never let a tiny negative residue accumulate.
  if (stepper.acc < 0) stepper.acc = 0
}

/**
 * One authoritative physics substep: controller forces first (exactly
 * FIXED_DT of integration), then exactly one Rapier step. Shared by the
 * game loop and headless tests so both advance identically.
 */
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
