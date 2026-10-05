import * as RAPIER_ from '@dimforge/rapier3d-compat';
import { CarController } from '../src/mainview/systems/CarController';
import { createChassisBody, initPhysics, moveGroundBody } from '../src/mainview/systems/PhysicsSystem';
import type { DriveInput } from '../src/mainview/systems/InputManager';

const RAPIER = await initPhysics();
const idle: DriveInput = {
  throttle: 0, brake: 0, steer: 0, handbrake: false,
  upshiftPressed: false, downshiftPressed: false, toggleModePressed: false,
  toggleLaunchPressed: false, resetPressed: false, toggleCameraPressed: false,
  startPressed: false, escapePressed: false,
} as DriveInput;

function mk() {
  const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
  world.timestep = 1 / 120;
  const gb = world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
  world.createCollider(RAPIER.ColliderDesc.cuboid(3000, 0.5, 3000).setTranslation(0, -0.55, 0).setFriction(1.0), gb);
  const body = createChassisBody(world, 0, 0.72, 0);
  const car: any = new CarController(world, body, RAPIER);
  return { world, gb, body, car };
}
function betaOf(body: any) {
  const v = body.linvel(); const q = body.rotation();
  const fx = 2 * (q.x * q.z + q.w * q.y), fz = 1 - 2 * (q.x * q.x + q.y * q.y);
  const rx = 1 - 2 * (q.y * q.y + q.z * q.z), rz = 2 * (q.x * q.z - q.w * q.y);
  return Math.atan2(v.x * rx + v.z * rz, Math.max(1, Math.abs(v.x * fx + v.z * fz)));
}
function run(s: any, inp: DriveInput, secs: number) {
  const n = Math.round(secs * 120);
  for (let i = 0; i < n; i++) {
    s.car.update(1 / 120, inp); s.world.step();
    if (i % 60 === 0) { const p = s.body.translation(); moveGroundBody(s.gb, p.x, p.z); }
  }
}

type Case = { name: string; gear: number; v0: number; entry: string };
const CASES: Case[] = [];
for (const gear of [1, 2, 3, 4, 5, 6]) {
  for (const v0 of [15, 25, 35, 50, 70]) {
    for (const entry of ['lock', 'hb']) CASES.push({ name: '', gear, v0, entry });
  }
}

console.log('gear  v0   entry | betaIn   yawIn  ->  betaOut  yawOut   | recovered?');
console.log('-'.repeat(80));
let bad = 0;
for (const c of CASES) {
  const s = mk();
  s.body.setLinvel({ x: 0, y: 0, z: -c.v0 }, true);
  s.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
  s.body.setRotation({ x: 0, y: 0, z: 0, w: 1 }, true);
  s.car.gear = c.gear; s.car.rpm = 5000; s.car.autoMode = false;
  s.car.update(1 / 120, idle); s.world.step();

  // establish a sustained right-hand circle / drift at full throttle
  run(s, { ...idle, throttle: 1, steer: 1, handbrake: c.entry === 'hb' }, c.entry === 'hb' ? 1.2 : 3.0);
  // then release the handbrake (if used) and steer LEFT, throttle still pinned
  const bIn = betaOf(s.body), yIn = s.body.angvel().y;
  const vIn = Math.abs(s.car.forwardSpeed) * 3.6;
  run(s, { ...idle, throttle: 1, steer: -1, handbrake: false }, 1.5);
  const bOut = betaOf(s.body), yOut = s.body.angvel().y;

  // "recovered" = the car is now rotating the OTHER way. Sign of yaw rate is
  // the honest test; beta's sign is ambiguous mid-spin.
  const flipped = yOut < 0;
  if (!flipped) bad++;
  console.log(
    `${String(c.gear).padEnd(5)}${String(c.v0).padEnd(5)}${c.entry.padEnd(6)}| ` +
    `${(bIn * 57.3).toFixed(1).padStart(6)} ${yIn.toFixed(2).padStart(6)}  ->  ` +
    `${(bOut * 57.3).toFixed(1).padStart(6)} ${yOut.toFixed(2).padStart(6)}  | ` +
    `${flipped ? 'yes' : 'NO'}  (v0=${vIn.toFixed(0)}km/h)`
  );
}
console.log(`\n${bad}/${CASES.length} cases where the car did NOT rotate back the other way`);