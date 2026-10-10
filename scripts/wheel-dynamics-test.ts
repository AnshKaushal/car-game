import * as RAPIER_ from '@dimforge/rapier3d-compat';
import { CarController } from '../src/mainview/systems/CarController';
import {
  WheelDynamics,
  estimateWheelInertia,
} from '../src/mainview/systems/WheelDynamics';
import {
  createChassisBody,
  initPhysics,
  moveGroundBody,
  FIXED_DT,
  stepVehicleOnce,
} from '../src/mainview/systems/PhysicsSystem';
import type { DriveInput } from '../src/mainview/systems/InputManager';

const RAPIER = await initPhysics();
const DT = FIXED_DT;
const INERTIA = estimateWheelInertia(25, 0.33); // ≈ 1.36125 kg·m²

const idle: DriveInput = {
  throttle: 0, brake: 0, steer: 0, handbrake: false,
  upshiftPressed: false, downshiftPressed: false, toggleModePressed: false,
  toggleLaunchPressed: false, resetPressed: false, toggleCameraPressed: false,
  startPressed: false, escapePressed: false,
};
const W = { ...idle, throttle: 1 };

let fails = 0;
const check = (name: string, cond: boolean, extra = '') => {
  console.log((cond ? 'PASS' : 'FAIL') + ' | ' + name + (extra ? ' | ' + extra : ''));
  if (!cond) fails++;
};

// ---- Unit tests: WheelDynamics module directly (no Rapier) ----

// 1. Stationary, undriven wheel stays stationary.
{
  const wd = new WheelDynamics(0.33, INERTIA);
  for (let i = 0; i < 120; i++) wd.step(0, DT, 0, 0, 0);
  check('undriven wheel stays at rest', wd.wheels[0].omega === 0, `ω=${wd.wheels[0].omega}`);
}

// 2. Positive drive torque gives the expected angular acceleration.
{
  const wd = new WheelDynamics(0.33, INERTIA);
  const T = 500;
  for (let i = 0; i < 120; i++) wd.step(0, DT, T, 0, 0);
  const expected = (T / INERTIA) * 1.0;
  check('drive torque integrates to T/I*t', Math.abs(wd.wheels[0].omega - expected) < 1e-9, `ω=${wd.wheels[0].omega.toFixed(6)} exp=${expected.toFixed(6)}`);
  check('alpha recorded as T/I', Math.abs(wd.wheels[0].alpha - T / INERTIA) < 1e-9, `α=${wd.wheels[0].alpha.toFixed(6)}`);
}

// 3. Equal and opposite torque over equal intervals cancels out.
{
  const wd = new WheelDynamics(0.33, INERTIA);
  for (let i = 0; i < 60; i++) wd.step(0, DT, 800, 0, 0);
  for (let i = 0; i < 60; i++) wd.step(0, DT, -800, 0, 0);
  check('+T then -T returns to rest', Math.abs(wd.wheels[0].omega) < 1e-6, `ω=${wd.wheels[0].omega}`);
}

// 4. Brake opposes forward and reverse rotation.
{
  const fwd = new WheelDynamics(0.33, INERTIA);
  fwd.wheels[0].omega = 50;
  fwd.step(0, DT, 0, 500, 0);
  const expectedF = 50 - (500 / INERTIA) * DT;
  const rev = new WheelDynamics(0.33, INERTIA);
  rev.wheels[0].omega = -50;
  rev.step(0, DT, 0, 500, 0);
  check('brake slows forward spin by T_b/I*dt', Math.abs(fwd.wheels[0].omega - expectedF) < 1e-9, `ω=${fwd.wheels[0].omega.toFixed(6)}`);
  check('brake slows reverse spin toward zero', Math.abs(rev.wheels[0].omega + expectedF) < 1e-9, `ω=${rev.wheels[0].omega.toFixed(6)}`);
}

// 5. Strong braking locks without sign-flipping or chatter.
{
  const wd = new WheelDynamics(0.33, INERTIA);
  wd.wheels[0].omega = 5;
  wd.step(0, DT, 0, 3000, 0);
  const lockedAt = wd.wheels[0].omega;
  let min = Infinity;
  for (let i = 0; i < 120; i++) {
    wd.step(0, DT, 0, 3000, 0);
    min = Math.min(min, wd.wheels[0].omega);
  }
  check('brake clamps exactly to rest (no flip)', lockedAt === 0, `ω=${lockedAt}`);
  check('locked wheel never goes negative under brake', min === 0, `min=${min}`);
}

// 9a. Wheels driven differently end up different (unit level).
{
  const wd = new WheelDynamics(0.33, INERTIA);
  for (let i = 0; i < 60; i++) {
    wd.step(0, DT, 1000, 0, 0);
    wd.step(1, DT, 200, 0, 0);
  }
  check('independently driven wheels diverge', Math.abs(wd.wheels[0].omega - wd.wheels[1].omega) > 1, `Δ=${(wd.wheels[0].omega - wd.wheels[1].omega).toFixed(1)}`);
}

// 10. Angular acceleration follows the configured inertia.
{
  const a = new WheelDynamics(0.33, 1.0);
  const b = new WheelDynamics(0.33, 2.0);
  a.step(0, DT, 300, 0, 0);
  b.step(0, DT, 300, 0, 0);
  check('omega scales inversely with inertia', Math.abs(a.wheels[0].omega / b.wheels[0].omega - 2) < 1e-9, `${a.wheels[0].omega.toFixed(6)} vs ${b.wheels[0].omega.toFixed(6)}`);
  check('inertia estimate matches 1/2·m·r²', Math.abs(INERTIA - 0.5 * 25 * 0.33 * 0.33) < 1e-12, `I=${INERTIA}`);
}

// Slip damper: relaxes toward road speed, idle when airborne.
{
  const K = 1500;
  const spin = new WheelDynamics(0.33, INERTIA, K);
  spin.wheels[0].omega = 100;
  spin.step(0, DT, 0, 0, 0, 10); // road at 10 m/s
  // Implicit damper closed form: (ω + dt*k*r*v/I) / (1 + dt*k*r²/I).
  const expected =
    (100 + ((DT * K * 0.33) / INERTIA) * 10) /
    (1 + ((DT * K * 0.33 * 0.33) / INERTIA));
  check('damper pulls spinning wheel toward road speed', spin.wheels[0].omega < 100 && Math.abs(spin.wheels[0].omega - expected) < 1e-9, `ω=${spin.wheels[0].omega.toFixed(4)} exp=${expected.toFixed(4)}`);
  const still = new WheelDynamics(0.33, INERTIA, K);
  for (let i = 0; i < 120; i++) still.step(0, DT, 0, 0, 0, 20); // road moving, wheel relaxed only by damper
  check('damper spins a free wheel up toward rolling', Math.abs(still.wheels[0].omega - 20 / 0.33) < 0.5, `ω=${still.wheels[0].omega.toFixed(2)} road=${(20 / 0.33).toFixed(1)}`);
  const air = new WheelDynamics(0.33, INERTIA, K);
  air.wheels[0].omega = 50;
  air.step(0, DT, 0, 0, 0, undefined); // airborne: no damping
  check('no damping without road contact', air.wheels[0].omega === 50 && air.wheels[0].slipDampTorque === 0, `ω=${air.wheels[0].omega}`);
}

// ---- Integration tests: through CarController ----

function mk() {
  const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
  world.timestep = FIXED_DT;
  const g = RAPIER.RigidBodyDesc.fixed();
  const gb = world.createRigidBody(g);
  world.createCollider(
    RAPIER.ColliderDesc.cuboid(3000, 0.5, 3000).setTranslation(0, -0.55, 0).setFriction(1.0),
    gb,
  );
  const body = createChassisBody(world, 0, 0.72, 0);
  const car = new CarController(world, body, RAPIER);
  return { world, gb, body, car };
}

function run(s: ReturnType<typeof mk>, inp: DriveInput, secs: number) {
  const n = Math.round(secs * 120);
  for (let i = 0; i < n; i++) {
    stepVehicleOnce(s.world, () => s.car.update(FIXED_DT, inp));
    if (i % 60 === 0) {
      const p = s.body.translation();
      moveGroundBody(s.gb, p.x, p.z);
    }
  }
}

// 6+7. RWD routing: fronts get zero drive, rears split equally.
{
  const s = mk();
  let frontDriveMax = 0;
  let splitOk = true;
  for (let i = 0; i < 240; i++) {
    stepVehicleOnce(s.world, () => s.car.update(FIXED_DT, W));
    const ws = s.car.wheelDynamics.wheels;
    frontDriveMax = Math.max(frontDriveMax, Math.abs(ws[0].driveTorque), Math.abs(ws[1].driveTorque));
    if (ws[2].driveTorque !== ws[3].driveTorque) splitOk = false;
  }
  const ws = s.car.wheelDynamics.wheels;
  check('front wheels receive zero drive torque (RWD)', frontDriveMax === 0, `max=${frontDriveMax}`);
  check('rear torque split equally left/right', splitOk && ws[2].driveTorque > 0, `RL=${ws[2].driveTorque.toFixed(1)} RR=${ws[3].driveTorque.toFixed(1)}`);
}

// 8. Airborne: no tire reaction, but drive still spins the wheel.
{
  const s = mk();
  run(s, idle, 1);
  s.body.setTranslation({ x: 0, y: 3, z: 0 }, true);
  s.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
  s.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
  const w0 = s.car.wheelDynamics.wheels[2].omega;
  let reactionMax = 0;
  for (let i = 0; i < 60; i++) {
    stepVehicleOnce(s.world, () => s.car.update(FIXED_DT, W));
    for (const w of s.car.wheelDynamics.wheels) reactionMax = Math.max(reactionMax, Math.abs(w.tireTorque));
  }
  const w1 = s.car.wheelDynamics.wheels[2].omega;
  check('airborne wheels get zero tire reaction', reactionMax === 0, `max=${reactionMax}`);
  check('airborne driven wheel still spins up', w1 > w0, `${w0.toFixed(1)} -> ${w1.toFixed(1)} rad/s`);
  check('airborne undriven wheels hold velocity (no fake ground)', s.car.wheelDynamics.wheels[0].omega === 0, `FL=${s.car.wheelDynamics.wheels[0].omega}`);
}

// 9b. Wheels differ in a real drive (rears spin, fronts don't).
{
  const s = mk();
  run(s, W, 1.0);
  const om = s.car.getWheelOmegas();
  check('rear wheels rotate under power', om[2] > 5 && om[3] > 5, `RL=${om[2].toFixed(1)} RR=${om[3].toFixed(1)}`);
  check('axles differ: driven vs undriven', Math.abs(om[2] - om[0]) > 1, `RL-FL=${(om[2] - om[0]).toFixed(1)}`);
}

// Reverse: rear wheels turn backward.
{
  const s = mk();
  s.car.autoMode = false;
  run(s, idle, 0.2);
  for (let k = 0; k < 2; k++) {
    stepVehicleOnce(s.world, () => s.car.update(FIXED_DT, { ...idle, downshiftPressed: true }));
    run(s, idle, 0.2);
  }
  run(s, W, 1.0);
  const om = s.car.getWheelOmegas();
  check('reverse gear reached', s.car.gear === -1, `gear=${s.car.gear}`);
  check('reverse drive turns rears backward', om[2] < -1 && om[3] < -1, `RL=${om[2].toFixed(1)} RR=${om[3].toFixed(1)}`);
}

// 11+12. Reset determinism + fixed-step determinism.
{
  // NOTE: a brand-new Rapier world needs one step before raycasts see
  // freshly added colliders, so the very first update ever reads all
  // wheels airborne (and applies no creep). Both traces below warm up with
  // one idle step and then reset, so the measured windows start from
  // exactly the reset state — which is precisely what reset determinism
  // means.
  const THREE_V = await import('three');
  const trace = () => {
    const s = mk();
    stepVehicleOnce(s.world, () => s.car.update(FIXED_DT, idle));
    s.car.reset(new THREE_V.Vector3(0, 0.72, 0), 0);
    const omegas: number[] = [];
    for (let i = 0; i < 120; i++) {
      stepVehicleOnce(s.world, () => s.car.update(FIXED_DT, W));
      omegas.push(s.car.wheelDynamics.wheels[2].omega);
    }
    const p = s.body.translation();
    return { omegas, p: [p.x, p.y, p.z] as const };
  };
  const a = trace();
  const s = mk();
  run(s, W, 1.0);
  const dirty = s.car.wheelDynamics.wheels[2].omega;
  s.car.reset(new THREE_V.Vector3(0, 0.72, 0), 0);
  const cleared = s.car.wheelDynamics.wheels.map((w) => [w.omega, w.driveTorque, w.brakeTorque, w.tireTorque, w.netTorque, w.alpha]);
  stepVehicleOnce(s.world, () => s.car.update(FIXED_DT, idle));
  s.car.reset(new THREE_V.Vector3(0, 0.72, 0), 0);
  const rerunTrace: number[] = [];
  for (let i = 0; i < 120; i++) {
    stepVehicleOnce(s.world, () => s.car.update(FIXED_DT, W));
    rerunTrace.push(s.car.wheelDynamics.wheels[2].omega);
  }
  const b = trace();
  check('reset returns wheels to deterministic zero', cleared.every((c) => c.every((v) => v === 0)), `dirty=${dirty.toFixed(1)}`);
  check(
    'identical runs give identical wheel traces',
    a.omegas.every((v, i) => v === b.omegas[i]) && a.p.every((v, i) => v === b.p[i]),
    `final ω=${a.omegas[119].toFixed(3)}`,
  );
  check('post-reset run matches fresh run', rerunTrace.every((v, i) => v === b.omegas[i]), `${rerunTrace[119].toFixed(3)} vs ${b.omegas[119].toFixed(3)}`);
}

console.log(fails === 0 ? 'ALL WHEEL-DYNAMICS CHECKS PASSED' : fails + ' WHEEL-DYNAMICS CHECKS FAILED');
process.exit(fails === 0 ? 0 : 1);
