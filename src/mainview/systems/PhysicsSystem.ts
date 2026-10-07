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
  const h = 1 / 120
  const n = Math.min(6, Math.max(1, Math.round(dt / h)))
  for (let i = 0; i < n; i++) world.step()
}

export function moveGroundBody(body: RAPIER.RigidBody, x: number, z: number) {
  body.setTranslation({ x: Math.round(x), y: 0, z: Math.round(z) }, true)
}
