import * as RAPIER_ from '@dimforge/rapier3d-compat';
import { CarController } from '../src/mainview/systems/CarController';
import { createChassisBody, initPhysics, moveGroundBody } from '../src/mainview/systems/PhysicsSystem';
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
  startPressed: false, escapePressed: false, toggleDebugPressed: false,
};
const W = { ...idle, throttle: 1 };
const S = { ...idle, brake: 1 };

const step = (inp: DriveInput, n: number) => {
  let t: any = null;
  for (let i = 0; i < n; i++) {
    t = car.update(1 / 120, inp); world.step();
    if (i % 60 === 0) { const p = body.translation(); moveGroundBody(gb, p.x, p.z); }
  }
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
for (let i = 0; i < 2 * 120; i++) { t = car.update(1 / 120, idle); world.step(); }
check('parking brake holds car still', Math.abs(t.speedKmh) < 0.5, 'v=' + t.speedKmh.toFixed(2));
car.update(1 / 120, W); world.step();
check('throttle releases parking brake', car.parkingBrake === false);
// idle creep: no pedals in D settles into a slow cruise (~1k rpm, walking pace)
for (let i = 0; i < 8 * 120; i++) { t = car.update(1 / 120, idle); world.step(); }
check('idle creep cruises slowly', Math.abs(t.speedKmh) > 2 && Math.abs(t.speedKmh) < 15, `v=${t.speedKmh.toFixed(1)} rpm=${t.rpm}`);

// launch control: arm with W+S at standstill, rpm pins ~4500; release S to launch
body.setLinvel({ x: 0, y: 0, z: 0 }, true);
body.setAngvel({ x: 0, y: 0, z: 0 }, true);
body.setTranslation({ x: 0, y: 0.72, z: 0 }, true);
body.setRotation({ x: 0, y: 0, z: 0, w: 1 }, true);
moveGroundBody(gb, 0, 0);
car.gear = 1 as any;
const WS = { ...idle, throttle: 1, brake: 1 };
for (let i = 0; i < 2 * 120; i++) { t = car.update(1 / 120, WS); world.step(); }
check('W+S arms launch control', t.launchArmed === true, `rpm=${t.rpm}`);
check('launch rpm pinned ~5000', Math.abs(t.rpm - 5000) < 600, 'rpm=' + t.rpm);
check('launch staging: zero movement (clutch open)', Math.abs(t.speedKmh) < 0.3, 'v=' + t.speedKmh.toFixed(2));
for (let i = 0; i < 3 * 120; i++) { t = car.update(1 / 120, W); world.step(); } // release S, keep W
check('launch fires on brake release', t.launching === true || Math.abs(t.speedKmh) > 30, `v=${t.speedKmh.toFixed(1)}`);
body.setLinvel({ x: 0, y: 0, z: 0 }, true);
body.setTranslation({ x: 0, y: 0.72, z: 0 }, true);
body.setRotation({ x: 0, y: 0, z: 0, w: 1 }, true);
moveGroundBody(gb, 0, 0);

// 0-100 timing
let t: any;
let t100 = -1;
for (let i = 0; i < 14 * 120; i++) {
  t = car.update(1 / 120, W); world.step();
  if (i % 60 === 0) { const p = body.translation(); moveGroundBody(gb, p.x, p.z); }
  if (t100 < 0 && Math.abs(t.speedKmh) >= 100) t100 = i / 120;
}
check('0-100km/h under 7s', t100 > 0 && t100 < 7, 't100=' + t100.toFixed(2) + 's');
// top speed run
for (let i = 0; i < 30 * 120; i++) {
  t = car.update(1 / 120, W); world.step();
  if (i % 60 === 0) { const p = body.translation(); moveGroundBody(gb, p.x, p.z); }
}
check('top speed > 270km/h', Math.abs(t.speedKmh) > 270, 'vmax=' + Math.abs(t.speedKmh).toFixed(0) + ' gear=' + t.gearLabel);
// brake, never reverse
const vBefore = Math.abs(t.speedKmh);
for (let i = 0; i < 8 * 120; i++) { t = car.update(1 / 120, S); world.step(); }
check('brakes slow the car', Math.abs(t.speedKmh) < vBefore * 0.2, 'v=' + t.speedKmh.toFixed(2));
check('S never reverses in D', t.speedKmh >= -0.05, 'v=' + t.speedKmh.toFixed(3));
const rq = body.rotation();
const upY = 1 - 2 * (rq.x * rq.x + rq.z * rq.z); // y of body-up vector
check('car stays upright after 300km/h braking', upY > 0.5, 'upY=' + upY.toFixed(2));
// reverse gear: manual, N then R (8 presses to be sure from any gear)
car.update(1 / 120, { ...idle, toggleModePressed: true }); world.step(); // manual
for (let i = 0; i < 10; i++) { car.update(1 / 120, { ...idle, downshiftPressed: true }); for (let j = 0; j < 15; j++) { car.update(1 / 120, idle); world.step(); } world.step(); }
console.log('gear after downs from 1:', car.gear);
for (let i = 0; i < 3 * 120; i++) { t = car.update(1 / 120, W); world.step(); } // W = accelerator in R
check('reverse works in R via W', t.speedKmh < -2, 'v=' + t.speedKmh.toFixed(1));
const vRev = t.speedKmh;
for (let i = 0; i < 2 * 120; i++) { t = car.update(1 / 120, S); world.step(); } // S = brake in R
check('S brakes in R', Math.abs(t.speedKmh) < Math.abs(vRev), 'v=' + t.speedKmh.toFixed(1));
// grip re-attachment: induce a power-on slide in 2nd, then lift. The car must
// come back to straight (sideslip < 0.05) within ~1.5s of lift-off.
car.gear = 2 as any;
body.setLinvel({ x: 0, y: 0, z: -22 }, true);
body.setAngvel({ x: 0, y: 0, z: 0 }, true);
body.setRotation({ x: 0, y: 0, z: 0, w: 1 }, true);
for (let i = 0; i < 150; i++) { car.update(1 / 120, { ...idle, throttle: 1, steer: 1 }); world.step(); }
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
  car.update(1 / 120, { ...idle, steer: -0.3 }); world.step();
  if (i % 60 === 0) { const p = body.translation(); moveGroundBody(gb, p.x, p.z); }
  if (tRecover < 0 && sideslip() < 0.05) tRecover = i / 120;
}
check('lift-off re-attaches grip quickly', betaHeld > 0.2 && tRecover > 0 && tRecover < 1.5, `slide=${betaHeld.toFixed(2)} recovered=${tRecover.toFixed(2)}s`);

// steering stability at speed
car.gear = 3 as any;
body.setLinvel({ x: 0, y: 0, z: -16.7 }, true);
// downshift protection: 200kmh in 5th — dropping to 4th would over-rev, must refuse
car.gear = 5 as any;
body.setLinvel({ x: 0, y: 0, z: -55.5 }, true);
body.setAngvel({ x: 0, y: 0, z: 0 }, true);
body.setRotation({ x: 0, y: 0, z: 0, w: 1 }, true);
for (let i = 0; i < 30; i++) { car.update(1 / 120, idle); world.step(); }
car.update(1 / 120, { ...idle, downshiftPressed: true }); world.step();
check('downshift into over-rev refused', car.gear === 5, 'gear=' + car.gear);
// ...but the same downshift at sane speed is allowed
body.setLinvel({ x: 0, y: 0, z: -38 }, true);
for (let i = 0; i < 30; i++) { car.update(1 / 120, idle); world.step(); }
car.update(1 / 120, { ...idle, downshiftPressed: true }); world.step();
check('downshift allowed when safe', car.gear === 4, 'gear=' + car.gear);
body.setLinvel({ x: 0, y: 0, z: -16.7 }, true);
body.setRotation({ x: 0, y: 0, z: 0, w: 1 }, true);
car.gear = 3 as any;
const steerInp = { ...idle, steer: 0.5 };
for (let i = 0; i < 3 * 120; i++) { t = car.update(1 / 120, steerInp); world.step(); }
check('car turns (yaw changes)', Math.abs(body.translation().x) > 3, 'x=' + body.translation().x.toFixed(1));
// donuts: roll in, then handbrake (TC off) + full lock + throttle.
// The tail should come around, not just push wide.
body.setLinvel({ x: 0, y: 0, z: 0 }, true);
body.setAngvel({ x: 0, y: 0, z: 0 }, true);
body.setTranslation({ x: 0, y: 0.72, z: 0 }, true);
body.setRotation({ x: 0, y: 0, z: 0, w: 1 }, true);
moveGroundBody(gb, 0, 0);
car.gear = 1 as any;
for (let i = 0; i < 1.5 * 120; i++) { car.update(1 / 120, W); world.step(); } // roll up to speed
let spin = 0;
const donutInp = { ...idle, throttle: 1, steer: 1, handbrake: true };
for (let i = 0; i < 7 * 120; i++) {
  t = car.update(1 / 120, donutInp); world.step();
  const av = body.angvel();
  spin += Math.abs(av.y) / 120;
  if (i % 120 === 0) { const p = body.translation(); moveGroundBody(gb, p.x, p.z); }
}
{
  const qd = body.rotation();
  check('donuts possible (sustained rotation)', spin > 8, 'total yaw=' + spin.toFixed(1) + 'rad');
  check('donut stays rubber-side down', 1 - 2 * (qd.x * qd.x + qd.z * qd.z) > 0.3, '');
}
// standing burnout: W + handbrake, no steering — rears should spin up (high
// slip) while the car barely moves
body.setLinvel({ x: 0, y: 0, z: 0 }, true);
body.setAngvel({ x: 0, y: 0, z: 0 }, true);
body.setTranslation({ x: 0, y: 0.72, z: 0 }, true);
body.setRotation({ x: 0, y: 0, z: 0, w: 1 }, true);
moveGroundBody(gb, 0, 0);
car.gear = 1 as any;
const burnoutInp = { ...idle, throttle: 1, handbrake: true };
for (let i = 0; i < 3 * 120; i++) { t = car.update(1 / 120, burnoutInp); world.step(); }
check('burnout spins rears (TC off on handbrake)', t.slipRatio > 0.3 && Math.abs(t.speedKmh) < 30, `slip=${t.slipRatio.toFixed(2)} v=${t.speedKmh.toFixed(1)}`);
// rev limiter: manual 1st, hold WOT — speed must plateau, rpm must never exceed limiter
car.gear = 1 as any;
body.setLinvel({ x: 0, y: 0, z: 0 }, true);
body.setAngvel({ x: 0, y: 0, z: 0 }, true);
body.setTranslation({ x: 0, y: 0.72, z: 0 }, true);
body.setRotation({ x: 0, y: 0, z: 0, w: 1 }, true);
moveGroundBody(gb, 0, 0); // ground follows the car — teleport it back too
let v6 = 0, v8 = 0, rpmMax = 0;
for (let i = 0; i < 8 * 120; i++) {
  t = car.update(1 / 120, W); world.step();
  rpmMax = Math.max(rpmMax, t.rpm);
  if (i === 6 * 120) v6 = Math.abs(t.speedKmh);
  if (i === 8 * 120 - 1) v8 = Math.abs(t.speedKmh);
}
check('rev limiter caps rpm', rpmMax <= 7550, 'rpmMax=' + rpmMax);
check('speed plateaus on limiter (no runaway)', v8 - v6 < 8 && v8 < 90, `v6=${v6.toFixed(1)} v8=${v8.toFixed(1)}`);
// coastdown: lift off at speed in D — car should roll freely, not brake itself.
// roll at 150kmh in 8th (as a real cruise), then 5s of no pedals.
car.gear = 8 as any;
car.rpm = 2600;
body.setLinvel({ x: 0, y: 0, z: -41.7 }, true); // 150kmh
body.setAngvel({ x: 0, y: 0, z: 0 }, true);
body.setRotation({ x: 0, y: 0, z: 0, w: 1 }, true);
for (let i = 0; i < 120; i++) { car.update(1 / 120, idle); world.step(); }
const vCoast0 = Math.abs(car.update(1 / 120, idle).speedKmh);
for (let i = 0; i < 5 * 120; i++) {
  t = car.update(1 / 120, idle); world.step();
}
check('coasts freely (no phantom braking)', vCoast0 - Math.abs(t.speedKmh) < 30, `lost=${(vCoast0 - Math.abs(t.speedKmh)).toFixed(1)}kmh over 5s`);
// neutral rpm fall: rev it in N, release — flywheel should spin down slowly (>2.5k after 1s)
car.gear = 0 as any;
body.setLinvel({ x: 0, y: 0, z: 0 }, true);
for (let i = 0; i < 2 * 120; i++) { t = car.update(1 / 120, W); world.step(); }
for (let i = 0; i < 1 * 120; i++) { t = car.update(1 / 120, idle); world.step(); }
check('neutral rpm falls slowly (flywheel inertia)', t.rpm > 6000, 'rpm=' + t.rpm);
// full throttle in top gear: box holds the gear and pulls (no kickdown anymore)
car.update(1 / 120, { ...idle, toggleModePressed: true }); world.step(); // back to AUTO
car.gear = 8 as any;
car.rpm = 2600;
body.setLinvel({ x: 0, y: 0, z: -41.7 }, true);
body.setAngvel({ x: 0, y: 0, z: 0 }, true);
body.setRotation({ x: 0, y: 0, z: 0, w: 1 }, true);
const vPull0 = 150;
for (let i = 0; i < 3 * 120; i++) { t = car.update(1 / 120, W); world.step(); }
check('top gear pulls without downshifting', t.gear === 8 && Math.abs(t.speedKmh) > vPull0 + 15, `gear=${t.gearLabel} v=${Math.abs(t.speedKmh).toFixed(0)}`);
// stop cascade: brake to a halt in auto — box must walk back down to 1st
for (let i = 0; i < 10 * 120; i++) { t = car.update(1 / 120, S); world.step(); }
check('auto returns to 1st after stopping', t.gear === 1, 'gear=' + t.gearLabel);

// --- countersteer at speed ------------------------------------------------
// Regression: full lock used to be capped at ~0.4 degrees above 250km/h, so
// the car could not be made to change direction no matter how hard you
// steered, and the ESC's steering deadzone (6.9 deg) was wider than most
// usable slides so the assist switched itself off exactly when needed.
// Expected: entry builds a slide, then opposite lock reverses the yaw rate.
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
car.gear = 8 as any;
car.rpm = 6000;
// Old cap budgeted only ~1.25g, which clamped full lock to 0.4deg up here —
// the car could not be made to change direction at all.
let steerPeak = 0, yawPeak = 0;
for (let i = 0; i < 5 * 120; i++) {
  car.update(1 / 120, { ...idle, throttle: 1, steer: 1 }); world.step();
  steerPeak = Math.max(steerPeak, Math.abs(car.steerAngle));
  yawPeak = Math.max(yawPeak, Math.abs(body.angvel().y));
}
check('full lock still meaningful at 250km/h', steerPeak > 0.04, `steer=${(steerPeak * 57.3).toFixed(2)}deg`);
check('power-on turn generates real yaw', yawPeak > 0.1, `yaw=${yawPeak.toFixed(3)}rad/s`);
for (let i = 0; i < 1.5 * 120; i++) { car.update(1 / 120, { ...idle, throttle: 1, steer: -1 }); world.step(); }

// --- countersteer out of a real power slide ------------------------------
// Full user scenario: wind the car up to speed, circle it on full throttle,
// then throw opposite lock WITHOUT lifting. Grip used to barely return and
// the car kept rotating the way it was already going. Opposite lock must now
// carry the car THROUGH neutral and out the other side, same throttle held.
car.reset(new (await import('three')).Vector3(0, 0.72, 0), 0);
car.autoMode = true;
for (let i = 0; i < 14 * 120; i++) {
  car.update(1 / 120, W); world.step();
  if (i % 60 === 0) { const p = body.translation(); moveGroundBody(gb, p.x, p.z); }
}
for (let i = 0; i < 3.5 * 120; i++) {
  car.update(1 / 120, { ...idle, throttle: 1, steer: 1 }); world.step();
  if (i % 60 === 0) { const p = body.translation(); moveGroundBody(gb, p.x, p.z); }
}
const betaSlide = sideSlip();
const yawSlide = body.angvel().y;
const vSlide = Math.abs(car.forwardSpeed) * 3.6;
// Grip must SURVIVE the throttle. This used to read 35-88 degrees of sideslip
// at speed because the rear was permanently "spinning" from a flat phantom
// slip term AND the friction circle left it ~26% of its lateral capacity, so
// grip never came back while you were on the power. Cornering hard on full
// throttle at 250km/h in 8th should now stay planted.
check('grip survives full throttle at speed', Math.abs(betaSlide) < 0.09,
  `v=${vSlide.toFixed(0)}km/h beta=${(betaSlide * 57.3).toFixed(1)}deg`);
for (let i = 0; i < 1.6 * 120; i++) {
  car.update(1 / 120, { ...idle, throttle: 1, steer: -1 }); world.step();
  if (i % 60 === 0) { const p = body.translation(); moveGroundBody(gb, p.x, p.z); }
}
const betaOut = sideSlip();
const yawOut = body.angvel().y;
check('countersteer flips the car the other way (250km/h)', yawSlide > 0 && yawOut < 0,
  `yaw ${yawSlide.toFixed(2)} -> ${yawOut.toFixed(2)} rad/s, beta ${(betaSlide * 57.3).toFixed(1)} -> ${(betaOut * 57.3).toFixed(1)}deg`);

// THE reported bug, at the speed it actually broke: get the car sideways in a
// low-speed donut (handbrake flick + full lock + full throttle), release the
// handbrake and throw OPPOSITE lock with the throttle still pinned. Pre-fix
// the car sat at ~86deg of sideslip and kept rotating the ORIGINAL way
// (yaw 2.58 -> 1.08) because the rear had no lateral capacity left to give
// and the ESC was gated off below 29km/h.
body.setLinvel({ x: 0, y: 0, z: -25 }, true);
body.setAngvel({ x: 0, y: 0, z: 0 }, true);
body.setRotation({ x: 0, y: 0, z: 0, w: 1 }, true);
car.gear = 4 as any;
car.autoMode = false;
car.rpm = 5000;
car.update(1 / 120, idle); world.step();
for (let i = 0; i < 1.2 * 120; i++) {
  car.update(1 / 120, { ...idle, throttle: 1, steer: 1, handbrake: true }); world.step();
  if (i % 60 === 0) { const p = body.translation(); moveGroundBody(gb, p.x, p.z); }
}
const yawDonut = body.angvel().y;
const betaDonut = Math.abs(sideSlip());
for (let i = 0; i < 1.5 * 120; i++) {
  car.update(1 / 120, { ...idle, throttle: 1, steer: -1 }); world.step();
  if (i % 60 === 0) { const p = body.translation(); moveGroundBody(gb, p.x, p.z); }
}
const yawDonutOut = body.angvel().y;
check('donut is entered', yawDonut > 1.5, `yaw=${yawDonut.toFixed(2)}rad/s beta=${(betaDonut * 57.3).toFixed(0)}deg`);
check('countersteer flips the car the other way (low speed donut)', yawDonut > 0 && yawDonutOut < 0,
  `yaw ${yawDonut.toFixed(2)} -> ${yawDonutOut.toFixed(2)} rad/s`);

console.log(fails === 0 ? 'ALL CHECKS PASSED' : fails + ' CHECKS FAILED');
process.exit(fails === 0 ? 0 : 1);
