import * as RAPIER_ from '@dimforge/rapier3d-compat';
import { CarController } from '../src/mainview/systems/CarController';
import { createChassisBody, initPhysics, moveGroundBody, stepVehicle } from '../src/mainview/systems/PhysicsSystem';
import type { DriveInput } from '../src/mainview/systems/InputManager';

const RAPIER = await initPhysics();
const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
world.timestep = 1 / 120; // must match the dt passed to car.update
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
const S = { ...idle, brake: 1 };

const followGround = () => {
  const p = body.translation();
  // safety-net plane rides just below the car (never fights the suspension)
  moveGroundBody(gb, p.x, p.z, p.y - 2.0);
};

let t: ReturnType<typeof car.update>;
const step = (inp: DriveInput, n: number) => {
  for (let i = 0; i < n; i++) {
    stepVehicle(world, car, inp, 1 / 120);
    if (i % 60 === 0) followGround();
  }
  t = car.buildTelemetryPublic(inp);
  return t;
};

let fails = 0;
const check = (name: string, cond: boolean, extra = '') => {
  console.log((cond ? 'PASS' : 'FAIL') + ' | ' + name + (extra ? ' | ' + extra : ''));
  if (!cond) fails++;
};

step(idle, 120);
check('suspension settles', body.translation().y > 0.6 && body.translation().y < 0.85, 'y=' + body.translation().y.toFixed(3));

// parking brake: engaged at spawn, holds the car, releases on first throttle
check('parking brake engaged at spawn', car.parkingBrake === true);
step(idle, 2 * 120);
check('parking brake holds car still', Math.abs(t.speedKmh) < 0.5, 'v=' + t.speedKmh.toFixed(2));
stepVehicle(world, car, W, 1 / 120);
check('throttle releases parking brake', car.parkingBrake === false);
// idle creep: no pedals in D settles into a slow cruise (~1k rpm, walking pace)
step(idle, 8 * 120);
check('idle creep cruises slowly', Math.abs(t.speedKmh) > 2 && Math.abs(t.speedKmh) < 15, `v=${t.speedKmh.toFixed(1)} rpm=${t.rpm}`);

// launch control: arm with W+S at standstill, rpm pins ~5000; release S to launch
body.setLinvel({ x: 0, y: 0, z: 0 }, true);
body.setAngvel({ x: 0, y: 0, z: 0 }, true);
body.setTranslation({ x: 0, y: 0.72, z: 0 }, true);
body.setRotation({ x: 0, y: 0, z: 0, w: 1 }, true);
moveGroundBody(gb, 0, 0, -0.55);
car.gear = 1 as never;
const WS = { ...idle, throttle: 1, brake: 1 };
step(WS, 2 * 120);
check('W+S arms launch control', t.launchArmed === true, `rpm=${t.rpm}`);
check('launch rpm pinned ~5000', Math.abs(t.rpm - 5000) < 600, 'rpm=' + t.rpm);
check('launch staging: zero movement (clutch open)', Math.abs(t.speedKmh) < 0.3, 'v=' + t.speedKmh.toFixed(2));
step(W, 3 * 120); // release S, keep W
check('launch fires on brake release', t.launching === true || Math.abs(t.speedKmh) > 30, `v=${t.speedKmh.toFixed(1)}`);
body.setLinvel({ x: 0, y: 0, z: 0 }, true);
body.setTranslation({ x: 0, y: 0.72, z: 0 }, true);
body.setRotation({ x: 0, y: 0, z: 0, w: 1 }, true);
moveGroundBody(gb, 0, 0, -0.55);

// 0-100 timing
let t100 = -1;
for (let i = 0; i < 14 * 120; i++) {
  stepVehicle(world, car, W, 1 / 120);
  if (i % 60 === 0) followGround();
  if (t100 < 0 && Math.abs(car.buildTelemetryPublic(W).speedKmh) >= 100) t100 = i / 120;
}
t = car.buildTelemetryPublic(W);
check('0-100km/h under 7s', t100 > 0 && t100 < 7, 't100=' + t100.toFixed(2) + 's');
// top speed run
for (let i = 0; i < 30 * 120; i++) {
  stepVehicle(world, car, W, 1 / 120);
  if (i % 60 === 0) followGround();
}
t = car.buildTelemetryPublic(W);
check('top speed > 270km/h', Math.abs(t.speedKmh) > 270, 'vmax=' + Math.abs(t.speedKmh).toFixed(0) + ' gear=' + t.gearLabel);
// brake, never reverse
const vBefore = Math.abs(t.speedKmh);
step(S, 8 * 120);
check('brakes slow the car', Math.abs(t.speedKmh) < vBefore * 0.2, 'v=' + t.speedKmh.toFixed(2));
check('S never reverses in D', t.speedKmh >= -0.05, 'v=' + t.speedKmh.toFixed(3));
const rq = body.rotation();
const upY = 1 - 2 * (rq.x * rq.x + rq.z * rq.z); // y of body-up vector
check('car stays upright after 300km/h braking', upY > 0.5, 'upY=' + upY.toFixed(2));
// reverse gear: manual, N then R. First stop fully (R is refused at speed,
// like a real gearbox), then walk down the gate.
for (let i = 0; i < 6 * 120 && Math.abs(car.forwardSpeed) > 1.5; i++) {
  stepVehicle(world, car, S, 1 / 120);
  if (i % 60 === 0) followGround();
}
stepVehicle(world, car, { ...idle, toggleModePressed: true }, 1 / 120);
for (let i = 0; i < 10; i++) {
  stepVehicle(world, car, { ...idle, downshiftPressed: true }, 1 / 120);
  step(idle, 25); // longer than the 0.15 s manual shift so every press lands
}
console.log('gear after downs from 1:', car.gear);
step(W, 3 * 120); // W = accelerator in R
check('reverse works in R via W', t.speedKmh < -2, 'v=' + t.speedKmh.toFixed(1));
const vRev = t.speedKmh;
step(S, 2 * 120); // S = brake in R
check('S brakes in R', Math.abs(t.speedKmh) < Math.abs(vRev), 'v=' + t.speedKmh.toFixed(1));
// grip re-attachment: induce a power-on slide in 2nd, then lift. The car must
// come back to straight (sideslip < 0.05) within ~1.5s of lift-off.
car.gear = 2 as never;
body.setLinvel({ x: 0, y: 0, z: -22 }, true);
body.setAngvel({ x: 0, y: 0, z: 0 }, true);
body.setRotation({ x: 0, y: 0, z: 0, w: 1 }, true);
step({ ...idle, throttle: 1, steer: 1 }, 150);
const sideslip = () => {
  const v = body.linvel(); const q = body.rotation();
  const rx = 1 - 2 * (q.y * q.y + q.z * q.z);
  const rz = 2 * (q.x * q.y - q.w * q.z);
  const spd = Math.hypot(v.x, v.z);
  return spd > 1 ? Math.abs((v.x * rx + v.z * rz) / spd) : 0;
};
const betaHeld = sideslip();
let tRecover = -1;
for (let i = 0; i < 240; i++) {
  stepVehicle(world, car, { ...idle, steer: -0.3 }, 1 / 120);
  if (i % 60 === 0) followGround();
  if (tRecover < 0 && sideslip() < 0.05) tRecover = i / 120;
}
check('lift-off re-attaches grip', betaHeld > 0.2 && tRecover > 0 && tRecover < 2.0, `slide=${betaHeld.toFixed(2)} recovered=${tRecover.toFixed(2)}s`);

// steering stability at speed
car.gear = 3 as never;
body.setLinvel({ x: 0, y: 0, z: -16.7 }, true);
// downshift protection: 200kmh in 5th — dropping to 4th would over-rev, must refuse
car.gear = 5 as never;
body.setLinvel({ x: 0, y: 0, z: -55.5 }, true);
body.setAngvel({ x: 0, y: 0, z: 0 }, true);
body.setRotation({ x: 0, y: 0, z: 0, w: 1 }, true);
step(idle, 30);
stepVehicle(world, car, { ...idle, downshiftPressed: true }, 1 / 120);
check('downshift into over-rev refused', car.gear === 5, 'gear=' + car.gear);
// ...but the same downshift at sane speed is allowed
body.setLinvel({ x: 0, y: 0, z: -38 }, true);
step(idle, 30);
stepVehicle(world, car, { ...idle, downshiftPressed: true }, 1 / 120);
check('downshift allowed when safe', car.gear === 4, 'gear=' + car.gear);
body.setLinvel({ x: 0, y: 0, z: -16.7 }, true);
body.setRotation({ x: 0, y: 0, z: 0, w: 1 }, true);
car.gear = 3 as never;
const steerInp = { ...idle, steer: 0.5 };
step(steerInp, 3 * 120);
check('car turns (yaw changes)', Math.abs(body.translation().x) > 3, 'x=' + body.translation().x.toFixed(1));
// donuts: roll in, then handbrake (TC off) + full lock + throttle.
// The tail should come around, not just push wide.
body.setLinvel({ x: 0, y: 0, z: 0 }, true);
body.setAngvel({ x: 0, y: 0, z: 0 }, true);
body.setTranslation({ x: 0, y: 0.72, z: 0 }, true);
body.setRotation({ x: 0, y: 0, z: 0, w: 1 }, true);
moveGroundBody(gb, 0, 0, -0.55);
car.gear = 1 as never;
step(W, Math.round(1.5 * 120)); // roll up to speed
let spin = 0;
const donutInp = { ...idle, throttle: 1, steer: 1, handbrake: true };
for (let i = 0; i < 7 * 120; i++) {
  stepVehicle(world, car, donutInp, 1 / 120);
  const av = body.angvel();
  spin += Math.abs(av.y) / 120;
  if (i % 120 === 0) followGround();
}
{
  const qd = body.rotation();
  check('donuts possible (sustained rotation)', spin > 8, 'total yaw=' + spin.toFixed(1) + 'rad');
  check('donut stays rubber-side down', 1 - 2 * (qd.x * qd.x + qd.z * qd.z) > 0.3, '');
}
// standing burnout: foot brake + throttle + handbrake (TC off), launch
// control disabled — the honest line-lock scenario: fronts hold, rears spin.
// (W+S alone would arm launch control, which opens the clutch by design.)
stepVehicle(world, car, { ...idle, toggleLaunchPressed: true }, 1 / 120); // launch OFF
body.setLinvel({ x: 0, y: 0, z: 0 }, true);
body.setAngvel({ x: 0, y: 0, z: 0 }, true);
body.setTranslation({ x: 0, y: 0.72, z: 0 }, true);
body.setRotation({ x: 0, y: 0, z: 0, w: 1 }, true);
moveGroundBody(gb, 0, 0, -0.55);
car.gear = 1 as never;
const burnoutInp = { ...idle, throttle: 1, brake: 1, handbrake: true };
step(burnoutInp, 3 * 120);
check('burnout spins rears (TC off on handbrake)', t.slipRatio > 0.3 && Math.abs(t.speedKmh) < 30, `slip=${t.slipRatio.toFixed(2)} v=${t.speedKmh.toFixed(1)}`);
stepVehicle(world, car, { ...idle, toggleLaunchPressed: true }, 1 / 120); // launch back ON
// rev limiter: manual 1st, hold WOT — speed must plateau, rpm must never exceed limiter
car.gear = 1 as never;
body.setLinvel({ x: 0, y: 0, z: 0 }, true);
body.setAngvel({ x: 0, y: 0, z: 0 }, true);
body.setTranslation({ x: 0, y: 0.72, z: 0 }, true);
body.setRotation({ x: 0, y: 0, z: 0, w: 1 }, true);
moveGroundBody(gb, 0, 0, -0.55); // ground follows the car — teleport it back too
let v6 = 0, v8 = 0, rpmMax = 0;
for (let i = 0; i < 8 * 120; i++) {
  stepVehicle(world, car, W, 1 / 120);
  const tt = car.buildTelemetryPublic(W);
  rpmMax = Math.max(rpmMax, tt.rpm);
  if (i === 6 * 120) v6 = Math.abs(tt.speedKmh);
  if (i === 8 * 120 - 1) { v8 = Math.abs(tt.speedKmh); t = tt; }
}
check('rev limiter caps rpm', rpmMax <= 7600, 'rpmMax=' + rpmMax);
check('speed plateaus on limiter (no runaway)', v8 - v6 < 8 && v8 < 90, `v6=${v6.toFixed(1)} v8=${v8.toFixed(1)}`);
// coastdown: lift off at speed in D — car should roll freely, not brake itself.
// roll at 150kmh in 8th (as a real cruise), then 5s of no pedals.
car.gear = 8 as never;
car.rpm = 2600;
body.setLinvel({ x: 0, y: 0, z: -41.7 }, true); // 150kmh
body.setAngvel({ x: 0, y: 0, z: 0 }, true);
body.setRotation({ x: 0, y: 0, z: 0, w: 1 }, true);
step(idle, 120);
const vCoast0 = Math.abs(car.buildTelemetryPublic(idle).speedKmh);
step(idle, 5 * 120);
check('coasts freely (no phantom braking)', vCoast0 - Math.abs(t.speedKmh) < 30, `lost=${(vCoast0 - Math.abs(t.speedKmh)).toFixed(1)}kmh over 5s`);
// neutral rpm fall: rev it in N, release — flywheel should spin down slowly (>2.5k after 1s)
car.gear = 0 as never;
body.setLinvel({ x: 0, y: 0, z: 0 }, true);
step(W, 2 * 120);
step(idle, 1 * 120);
check('neutral rpm falls slowly (flywheel inertia)', t.rpm > 6000, 'rpm=' + t.rpm);
// full throttle in top gear: box holds the gear and pulls (no kickdown anymore)
stepVehicle(world, car, { ...idle, toggleModePressed: true }, 1 / 120); // back to AUTO
car.gear = 8 as never;
car.rpm = 2600;
body.setLinvel({ x: 0, y: 0, z: -41.7 }, true);
body.setAngvel({ x: 0, y: 0, z: 0 }, true);
body.setRotation({ x: 0, y: 0, z: 0, w: 1 }, true);
const vPull0 = 150;
step(W, 3 * 120);
// NOTE: kickdown is now physical (WOT below kickdownRPM downshifts): with rpm
// seeded at 2600 the box legitimately kicks down to pull. Accept 7th or 8th.
check('top gear pulls (kickdown allowed when lugging)', Math.abs(t.speedKmh) > vPull0 + 15, `gear=${t.gearLabel} v=${Math.abs(t.speedKmh).toFixed(0)}`);
// stop cascade: brake to a halt in auto — box must walk back down to 1st
step(S, 10 * 120);
check('auto returns to 1st after stopping', t.gear === 1, 'gear=' + t.gearLabel);

// --- countersteer at speed ------------------------------------------------
const sideSlip = () => {
  const v = body.linvel(); const q = body.rotation();
  const fx = 2 * (q.x * q.z + q.w * q.y), fz = 1 - 2 * (q.x * q.x + q.y * q.y);
  const rx = 1 - 2 * (q.y * q.y + q.z * q.z), rz = 2 * (q.x * q.z - q.w * q.y);
  const lat = v.x * rx + v.z * rz, lon = Math.abs(v.x * fx + v.z * fz);
  return Math.atan2(lat, Math.max(1, lon));
};
body.setLinvel({ x: 0, y: 0, z: -70 }, true); // ~250 km/h
body.setAngvel({ x: 0, y: 0, z: 0 }, true);
body.setRotation({ x: 0, y: 0, z: 0, w: 1 }, true);
car.gear = 8 as never;
car.rpm = 6000;
let steerPeak = 0, yawPeak = 0;
for (let i = 0; i < 5 * 120; i++) {
  stepVehicle(world, car, { ...idle, throttle: 1, steer: 1 }, 1 / 120);
  steerPeak = Math.max(steerPeak, Math.abs(car.steerAngle));
  yawPeak = Math.max(yawPeak, Math.abs(body.angvel().y));
}
check('full lock still meaningful at 250km/h', steerPeak > 0.04, `steer=${(steerPeak * 57.3).toFixed(2)}deg`);
check('power-on turn generates real yaw', yawPeak > 0.1, `yaw=${yawPeak.toFixed(3)}rad/s`);
for (let i = 0; i < Math.round(1.5 * 120); i++) { stepVehicle(world, car, { ...idle, throttle: 1, steer: -1 }, 1 / 120); }

// --- high-speed grip vs power oversteer ---------------------------------
// Physical expectations for an 800hp RWD car, verified separately:
// (a) MODERATE demand at speed stays gripped (no phantom looseness);
// (b) FULL lock + FULL throttle provokes real power oversteer (no arcade glue);
// (c) the slide is catchable with opposite lock on power (no assist needed).
car.reset(new (await import('three')).Vector3(0, 0.72, 0), 0);
car.autoMode = true;
for (let i = 0; i < 8 * 120; i++) {
  stepVehicle(world, car, W, 1 / 120);
  if (i % 60 === 0) followGround();
}
// moderate demand at ~150 km/h: small steer + power must stay gripped.
// (At 200+, even quarter rack demands several g — no road car holds that.)
for (let i = 0; i < Math.round(3.5 * 120); i++) {
  stepVehicle(world, car, { ...idle, throttle: 1, steer: 0.08 }, 1 / 120);
  if (i % 60 === 0) followGround();
}
const betaMod = sideSlip();
const vMod = Math.abs(car.forwardSpeed) * 3.6;
check('grip survives moderate demand at speed', Math.abs(betaMod) < 0.12,
  `v=${vMod.toFixed(0)}km/h beta=${(betaMod * 57.3).toFixed(1)}deg`);
for (let i = 0; i < Math.round(1.2 * 120); i++) {
  stepVehicle(world, car, { ...idle, throttle: 1, steer: 1 }, 1 / 120);
  if (i % 60 === 0) followGround();
}
const betaProv = sideSlip();
const yawProv = body.angvel().y;
check('full demand provokes real oversteer', Math.abs(betaProv) > 0.06,
  `beta=${(betaProv * 57.3).toFixed(1)}deg yaw=${yawProv.toFixed(2)}rad/s`);
for (let i = 0; i < Math.round(1.6 * 120); i++) {
  stepVehicle(world, car, { ...idle, throttle: 1, steer: -1 }, 1 / 120);
  if (i % 60 === 0) followGround();
}
const yawOut = body.angvel().y;
check('power slide is catchable with opposite lock',
  (yawProv > 0 && yawOut < 0) || Math.abs(yawOut) < Math.abs(yawProv) * 0.5,
  `yaw ${yawProv.toFixed(2)} -> ${yawOut.toFixed(2)} rad/s`);

// low-speed handbrake turn: lift, flick, rotate — then catch it on power.
// Entry is a real handbrake turn (no throttle, like the real technique).
body.setLinvel({ x: 0, y: 0, z: -25 }, true);
body.setAngvel({ x: 0, y: 0, z: 0 }, true);
body.setRotation({ x: 0, y: 0, z: 0, w: 1 }, true);
car.gear = 4 as never;
car.autoMode = false;
car.rpm = 5000;
stepVehicle(world, car, idle, 1 / 120);
// handbrake turn: partial lock (full lock would just plow the fronts),
// no throttle — the real technique.
for (let i = 0; i < Math.round(1.2 * 120); i++) {
  stepVehicle(world, car, { ...idle, steer: 0.4, handbrake: true }, 1 / 120);
  if (i % 60 === 0) followGround();
}
const yawDonut = body.angvel().y;
const betaDonut = Math.abs(sideSlip());
for (let i = 0; i < Math.round(1.5 * 120); i++) {
  stepVehicle(world, car, { ...idle, throttle: 1, steer: -1 }, 1 / 120);
  if (i % 60 === 0) followGround();
}
const yawDonutOut = body.angvel().y;
check('handbrake turn rotates the car', yawDonut > 1.0, `yaw=${yawDonut.toFixed(2)}rad/s beta=${(betaDonut * 57.3).toFixed(0)}deg`);
check('slide caught with power + opposite lock', yawDonut > 0 && (yawDonutOut < 0 || Math.abs(yawDonutOut) < yawDonut * 0.5),
  `yaw ${yawDonut.toFixed(2)} -> ${yawDonutOut.toFixed(2)} rad/s`);

console.log(fails === 0 ? 'ALL CHECKS PASSED' : fails + ' CHECKS FAILED');
process.exit(fails === 0 ? 0 : 1);
