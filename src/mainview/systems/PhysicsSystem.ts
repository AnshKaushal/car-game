/**
 * Rapier bootstrap + chassis construction + fixed-step vehicle stepping.
 *
 * Mass properties are EXPLICIT here (single source of truth lives in
 * constants/physics.ts): total mass, center of mass, and principal inertias
 * are set via ColliderDesc.setMassProperties — never inherited from an
 * accidental box geometry.
 */
import * as RAPIER from '@dimforge/rapier3d-compat';
import { CAR_PHYSICS } from '../constants/physics';
import type { CarController } from './CarController';
import type { DriveInput } from './InputManager';

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
  const world = new RAPIER_.World({ x: 0, y: -CAR_PHYSICS.simulation.gravity, z: 0 });
  world.timestep = CAR_PHYSICS.simulation.fixedDt;
  return world;
}

export function createChassisBody(world: RAPIER.World, x: number, y: number, z: number): RAPIER.RigidBody {
  const RAPIER_ = getR();
  const P = CAR_PHYSICS;
  const bodyDesc = RAPIER_.RigidBodyDesc.dynamic()
    .setTranslation(x, y, z)
    .setLinvel(0, 0, 0)
    .setAngvel({ x: 0, y: 0, z: 0 })
    .setLinearDamping(0.005) // tiny: real drag is modeled explicitly
    .setAngularDamping(0.05) // near-zero: attitude comes from suspension/tires
    .setCcdEnabled(true);
  const body = world.createRigidBody(bodyDesc);
  // Explicit mass properties. Body origin rides at design ride height; the CG
  // sits cgHeight above ground and frontShare-biased toward the front axle.
  // Principal axes: X lateral = pitch, Y vertical = yaw, Z longitudinal = roll.
  const comY = P.mass.cgHeight - P.geometry.rideHeight; // ~-0.20
  const wb = P.geometry.wheelbase;
  const comZ = P.geometry.frontAxleZ + wb * (1 - P.mass.frontShare); // ~-0.157
  const col = RAPIER_.ColliderDesc.cuboid(P.geometry.width / 2, 0.32, P.geometry.length / 2)
    .setMassProperties(
      P.mass.total,
      { x: 0, y: comY, z: comZ },
      { x: P.mass.pitchInertia, y: P.mass.yawInertia, z: P.mass.rollInertia },
      { x: 0, y: 0, z: 0, w: 1 },
    )
    .setFriction(0.4)
    .setRestitution(0.1);
  world.createCollider(col, body);
  return body;
}

/**
 * Advance the coupled vehicle + world by exactly one fixed step h.
 * Brackets the Rapier step with interpolation snapshots so the renderer can
 * interpolate between physics states instead of extrapolating body transforms.
 */
export function stepVehicle(
  world: RAPIER.World,
  car: CarController,
  input: DriveInput,
  h: number = CAR_PHYSICS.simulation.fixedDt,
) {
  car.snapshotPrev();
  car.stepPhysics(h, input);
  world.step();
  car.snapshotCurr();
}

/** Legacy fixed-step accumulator stepping (kept for compat). */
export function stepWorld(world: RAPIER.World, dt: number) {
  const h = CAR_PHYSICS.simulation.fixedDt;
  const n = Math.min(6, Math.max(1, Math.round(dt / h)));
  for (let i = 0; i < n; i++) world.step();
}

/**
 * Teleport the (fixed) physics ground so it stays under the car.
 * The ground is an endless flat plane visually, but its Rapier collider is
 * finite — without this the car drives off the edge and falls through.
 * Teleporting a fixed body imparts no velocity. Follows X/Z snapped to whole
 * metres plus the road elevation Y so the safety net never fights the car on
 * hills. The car's own suspension uses the analytic road surface, not this.
 */
export function moveGroundBody(body: RAPIER.RigidBody, x: number, z: number, y = 0) {
  body.setTranslation({ x: Math.round(x), y, z: Math.round(z) }, true);
}
