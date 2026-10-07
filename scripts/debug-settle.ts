import * as RAPIER_ from '@dimforge/rapier3d-compat';
import { CarController } from '../src/mainview/systems/CarController';
import { createChassisBody, initPhysics, moveGroundBody, stepVehicle } from '../src/mainview/systems/PhysicsSystem';
import type { DriveInput } from '../src/mainview/systems/InputManager';

const RAPIER = await initPhysics();
const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
world.timestep = 1 / 120;
const g = RAPIER.RigidBodyDesc.fixed();
const gb = world.createRigidBody(g);
world.createCollider(RAPIER.ColliderDesc.cuboid(3000, 0.5, 3000).setTranslation(0, -0.55, 0).setFriction(1.0), gb);
const body = createChassisBody(world, 0, 0.72, 0);
const car = new CarController(world, body, RAPIER);
const idle: DriveInput = {
  throttle: 0, brake: 0, steer: 0, handbrake: false,
  upshiftPressed: false, downshiftPressed: false, toggleModePressed: false,
  toggleLaunchPressed: false, resetPressed: false, toggleCameraPressed: false,
  startPressed: false, escapePressed: false,
};
const W = { ...idle, throttle: 1 };
const followGround = () => {
  const p = body.translation();
  moveGroundBody(gb, p.x, p.z, p.y - 2.0);
};
for (let s = 0; s < 45; s++) {
  for (let i = 0; i < 120; i++) {
    stepVehicle(world, car, W, 1 / 120);
    if (i % 60 === 0) followGround();
  }
  const t = car.buildTelemetryPublic(W);
  console.log(`t=${s + 1}s v=${Math.abs(t.speedKmh).toFixed(0)} rpm=${t.rpm} gear=${t.gearLabel} Te=${t.engineTorque.toFixed(0)} tc=${t.tcCut.toFixed(2)} esc=${t.escActive} slip=${t.slipRatio.toFixed(3)} drv=${t.wheels[2].driveTorque.toFixed(0)},${t.wheels[3].driveTorque.toFixed(0)} om=${car.wheelOmega.map((o) => o.toFixed(0)).join(',')} lock=${car.converterLocked} clutch=${car.clutchEngagement.toFixed(2)}`);
}
process.exit(0);
