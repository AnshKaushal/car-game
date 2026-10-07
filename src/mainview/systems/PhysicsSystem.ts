/**
 * Rapier bootstrap + helpers. Vehicle uses a SINGLE dynamic chassis body
 * with custom raycast suspension/tires in CarController (stable + realistic).
 */
import * as RAPIER from '@dimforge/rapier3d-compat';
import { CAR_PHYSICS } from '../constants/physics';

let R: typeof RAPIER | null = null;

export async function initPhysics(): Promise<typeof RAPIER> {
  if (R) return R;
  await RAPIER.init();
  R = RAPIER;
  return RAPIER;
}

export function getR(): typeof RAPIER {
  if (!R) throw new Error('Rapier not initialized — call initPhysics() first');
  return R;
}

export function createWorld(): RAPIER.World {
  const RAPIER_ = getR();
  const world = new RAPIER_.World({ x: 0, y: -9.81, z: 0 });
  world.timestep = 1 / 120;
  return world;
}

export function createChassisBody(world: RAPIER.World, x: number, y: number, z: number): RAPIER.RigidBody {
  const RAPIER_ = getR();
  const P = CAR_PHYSICS;
  const bodyDesc = RAPIER_.RigidBodyDesc.dynamic()
    .setTranslation(x, y, z)
    .setLinvel(0, 0, 0)
    .setAngvel({ x: 0, y: 0, z: 0 })
    .setLinearDamping(0.005) // tiny: just enough to settle numerical noise, real drag is modeled explicitly
    .setAngularDamping(0.55)
    .setCcdEnabled(true);
  const body = world.createRigidBody(bodyDesc);
  // hull: low and tight (real body shell, not full height) so the center of
  // mass sits at ~0.6m at ride height — resists endos without killing squat/dive
  const col = RAPIER_.ColliderDesc.cuboid(P.dimensions.width / 2, 0.32, P.dimensions.length / 2)
    .setTranslation(0, -0.1, 0)
    .setMass(P.mass.chassis)
    .setFriction(0.4)
    .setRestitution(0.1);
  world.createCollider(col, body);
  return body;
}

/** Fixed-step accumulator stepping */
export function stepWorld(world: RAPIER.World, dt: number) {
  const h = 1 / 120;
  const n = Math.min(6, Math.max(1, Math.round(dt / h)));
  for (let i = 0; i < n; i++) world.step();
}

/**
 * Teleport the (fixed) physics ground so it stays under the car.
 * The ground is an endless flat plane visually, but its Rapier collider is
 * finite — without this the car drives off the edge after ~1.5km and falls
 * through the world. Teleporting a fixed body imparts no velocity, so this
 * is artifact-free. Snap to whole meters to avoid f32 shimmer far from origin.
 */
export function moveGroundBody(body: RAPIER.RigidBody, x: number, z: number) {
  body.setTranslation({ x: Math.round(x), y: 0, z: Math.round(z) }, true);
}
