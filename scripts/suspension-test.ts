import * as THREE from 'three';
import * as RAPIER_ from '@dimforge/rapier3d-compat';
import { CarController } from '../src/mainview/systems/CarController';
import {
  createChassisBody,
  initPhysics,
  moveGroundBody,
  FIXED_DT,
  stepVehicleOnce,
} from '../src/mainview/systems/PhysicsSystem';
import type { DriveInput } from '../src/mainview/systems/InputManager';

const RAPIER = await initPhysics();

const idle: DriveInput = {
  throttle: 0, brake: 0, steer: 0, handbrake: false,
  upshiftPressed: false, downshiftPressed: false, toggleModePressed: false,
  toggleLaunchPressed: false, resetPressed: false, toggleCameraPressed: false,
  startPressed: false, escapePressed: false,
};
const W = { ...idle, throttle: 1 };
const S = { ...idle, brake: 1 };

const WEIGHT = 1650 * 9.81; // modelled chassis mass only (wheels unsprung)

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

function snap(s: ReturnType<typeof mk>) {
  return s.car.suspension.states.map((st) => ({
    c: st.compression,
    v: st.suspVel,
    load: st.load,
    F: st.force,
    g: st.grounded,
    nY: st.contactNormal.y,
  }));
}

function logStates(tag: string, s: ReturnType<typeof mk>) {
  const rows = snap(s)
    .map(
      (r, i) =>
        `w${i}[${['FL', 'FR', 'RL', 'RR'][i]}] c=${(r.c * 1000).toFixed(1)}mm v=${r.v.toFixed(3)}m/s load=${r.load.toFixed(0)}N F=${r.F.toFixed(0)}N g=${r.g} nY=${r.nY.toFixed(3)}`,
    )
    .join(' | ');
  console.log(`  [${tag}] y=${s.body.translation().y.toFixed(4)} ${rows}`);
}

function pitchOf(body: any): number {
  const q = body.rotation();
  const quat = new THREE.Quaternion(q.x, q.y, q.z, q.w);
  const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(quat);
  return Math.asin(Math.max(-1, Math.min(1, fwd.y))); // >0 = nose up
}

function rollOf(body: any): number {
  const q = body.rotation();
  const quat = new THREE.Quaternion(q.x, q.y, q.z, q.w);
  const right = new THREE.Vector3(1, 0, 0).applyQuaternion(quat);
  return Math.asin(Math.max(-1, Math.min(1, right.y)));
}

let fails = 0;
const check = (name: string, cond: boolean, extra = '') => {
  console.log((cond ? 'PASS' : 'FAIL') + ' | ' + name + (extra ? ' | ' + extra : ''));
  if (!cond) fails++;
};

// 1. Static equilibrium + ride height + load vs weight.
{
  const s = mk();
  run(s, idle, 3);
  const y = s.body.translation().y;
  const st = snap(s);
  const total = st.reduce((a, r) => a + r.load, 0);
  const front = st[0].load + st[1].load;
  logStates('static-3s', s);
  check('static ride height in [0.6, 0.85]m', y > 0.6 && y < 0.85, `y=${y.toFixed(4)}`);
  check('total supported load matches weight ±5%', Math.abs(total - WEIGHT) / WEIGHT < 0.05, `sum=${total.toFixed(0)}N vs ${WEIGHT.toFixed(0)}N`);
  check('front share plausible 40-53% (rear-biased)', front / total > 0.4 && front / total < 0.53, `front=${((front / total) * 100).toFixed(1)}%`);
  check('corners near individual equilibrium 40-110mm', st.every((r) => r.c > 0.04 && r.c < 0.11), st.map((r) => (r.c * 1000).toFixed(1)).join(','));
}

// 2. Stable settling: no persistent oscillation.
{
  const s = mk();
  run(s, idle, 3.5);
  const ys: number[] = [];
  for (let i = 0; i < 60; i++) {
    stepVehicleOnce(s.world, () => s.car.update(FIXED_DT, idle));
    ys.push(s.body.translation().y);
  }
  const range = Math.max(...ys) - Math.min(...ys);
  const vy = s.body.linvel().y;
  check('settling has no oscillation (>0.5s window <3mm)', range < 0.003, `range=${(range * 1000).toFixed(2)}mm`);
  check('vertical velocity ~0 at rest', Math.abs(vy) < 0.05, `vy=${vy.toFixed(4)}`);
}

// 3. Independent contact: 5 cm plank under FL only.
{
  const s = mk();
  const plank = s.world.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(-0.76, -0.025, -1.51));
  s.world.createCollider(RAPIER.ColliderDesc.cuboid(0.5, 0.025, 0.5).setFriction(1.0), plank);
  run(s, idle, 2);
  const st = snap(s);
  const contactY = (i: number) => s.car.suspension.states[i].contactY;
  const othersY = (contactY(1) + contactY(2) + contactY(3)) / 3;
  const total = st.reduce((a, r) => a + r.load, 0);
  const roll = rollOf(s.body);
  logStates('plank-FL', s);
  check('all four wheels stay grounded on uneven support', st.every((r) => r.g), st.map((r) => String(r.g)).join(','));
  check(
    'FL contact patch sits ~plank height above the others',
    contactY(0) - othersY > 0.03 && contactY(0) - othersY < 0.07,
    `dY=${((contactY(0) - othersY) * 1000).toFixed(1)}mm`,
  );
  check('total load conserved under redistribution ±5%', Math.abs(total - WEIGHT) / WEIGHT < 0.05, `sum=${total.toFixed(0)}N`);
  check('body rolls in response to single-corner lift', Math.abs(roll) > 0.003, `roll=${(roll * 57.3).toFixed(2)}deg`);
}

// 4. Compression then recovery (pushed down 5 cm, released).
{
  const s = mk();
  run(s, idle, 2);
  const p0 = s.body.translation().y;
  s.body.setTranslation({ x: 0, y: p0 - 0.05, z: 0 }, true);
  s.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
  stepVehicleOnce(s.world, () => s.car.update(FIXED_DT, idle));
  const peak = s.car.suspension.states.reduce((a, st) => a + st.load, 0);
  run(s, idle, 2);
  const y1 = s.body.translation().y;
  const st = snap(s);
  logStates('push-recover', s);
  check('push-down spikes support load (first step)', peak > WEIGHT * 1.5, `sum=${peak.toFixed(0)}N`);
  check('ride height recovers ±5mm', Math.abs(y1 - p0) < 0.005, `y0=${p0.toFixed(4)} y1=${y1.toFixed(4)}`);
  check('loads never negative during recovery', st.every((r) => r.load >= 0 && r.F >= 0), '');
}

// 5. Pitch: squat under power, dive under braking.
{
  const s = mk();
  run(s, idle, 1);
  run(s, W, 1.5);
  const st = snap(s);
  const fA = (st[0].c + st[1].c) / 2;
  const rA = (st[2].c + st[3].c) / 2;
  const pitchAcc = pitchOf(s.body);
  logStates('wot-1.5s', s);
  check('acceleration squats rear (rear comp > front)', rA - fA > 0.003, `d=${((rA - fA) * 1000).toFixed(1)}mm pitch=${(pitchAcc * 57.3).toFixed(2)}deg`);
  check('pitch sign nose-up under power', pitchAcc > 0.0005, `pitch=${(pitchAcc * 57.3).toFixed(3)}deg`);
  // Capture dive mid-braking while still at speed (a full stop returns to rest).
  run(s, W, 1.5);
  let dive: ReturnType<typeof snap> | null = null;
  let divePitch = 0;
  let diveV = 0;
  for (let i = 0; i < 90; i++) {
    const t = stepVehicleOnce(s.world, () => s.car.update(FIXED_DT, S));
    if (i === 30) {
      dive = snap(s);
      divePitch = pitchOf(s.body);
      diveV = t.speedKmh;
    }
    if (i % 60 === 0) {
      const p = s.body.translation();
      moveGroundBody(s.gb, p.x, p.z);
    }
  }
  const st2 = dive!;
  const fB = (st2[0].c + st2[1].c) / 2;
  const rB = (st2[2].c + st2[3].c) / 2;
  const pitchBrk = divePitch;
  logStates('brake-mid', s);
  check('braking dives front (front comp > rear)', fB - rB > 0.003, `d=${((fB - rB) * 1000).toFixed(1)}mm pitch=${(pitchBrk * 57.3).toFixed(2)}deg v=${diveV.toFixed(0)}km/h`);
  check('pitch sign nose-down under braking', pitchBrk < -0.0005, `pitch=${(pitchBrk * 57.3).toFixed(3)}deg`);
}

// 6. Roll during cornering (lean-out, outer loaded).
{
  const s = mk();
  run(s, W, 1.0);
  const circ = { ...idle, throttle: 0.6, steer: 0.5 };
  run(s, circ, 4.0);
  const yaw = s.body.angvel().y;
  const st = snap(s);
  const roll = rollOf(s.body);
  // Turn centre is on the inner side: yaw>0 (CCW from above) => left turn => outer = right.
  const leftC = (st[0].c + st[2].c) / 2;
  const rightC = (st[1].c + st[3].c) / 2;
  const outerMinusInner = yaw > 0 ? rightC - leftC : leftC - rightC;
  logStates('circle', s);
  check('sustained cornering builds yaw', Math.abs(yaw) > 0.1, `yaw=${yaw.toFixed(3)}rad/s roll=${(roll * 57.3).toFixed(2)}deg`);
  check('outer wheels compress more (lean-out)', outerMinusInner > 0.002, `d=${(outerMinusInner * 1000).toFixed(1)}mm`);
}

// 7. Airborne: no suspension force without contact.
{
  const s = mk();
  run(s, idle, 1);
  s.body.setTranslation({ x: 0, y: 3, z: 0 }, true);
  s.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
  s.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
  for (let i = 0; i < 30; i++) stepVehicleOnce(s.world, () => s.car.update(FIXED_DT, idle));
  const st = snap(s);
  const vy = s.body.linvel().y;
  logStates('airborne', s);
  check('no contacts while airborne', st.every((r) => !r.g), st.map((r) => String(r.g)).join(','));
  check('zero suspension force/load airborne', st.every((r) => r.load === 0 && r.F === 0), st.map((r) => r.F.toFixed(1)).join(','));
  check('ballistic fall (~-g*t, no suspension pull)', vy < -1.5 && vy > -3.5, `vy=${vy.toFixed(2)}`);
  check('suspension velocities finite', st.every((r) => Number.isFinite(r.v)), '');
}

// 8. Tilt recovery without uprighting torque (validates natural righting).
{
  const s = mk();
  run(s, idle, 1);
  const e = new THREE.Euler(0, 0, 0.12);
  const q = new THREE.Quaternion().setFromEuler(e);
  s.body.setRotation({ x: q.x, y: q.y, z: q.z, w: q.w }, true);
  s.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
  s.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
  run(s, idle, 3);
  const roll = rollOf(s.body);
  const upY = (() => {
    const qq = s.body.rotation();
    const quat = new THREE.Quaternion(qq.x, qq.y, qq.z, qq.w);
    return new THREE.Vector3(0, 1, 0).applyQuaternion(quat).y;
  })();
  logStates('tilt-recover', s);
  check('rolled body settles back toward level', Math.abs(roll) < 0.04 && upY > 0.99, `roll=${(roll * 57.3).toFixed(2)}deg upY=${upY.toFixed(4)}`);
}

console.log(fails === 0 ? 'ALL SUSPENSION CHECKS PASSED' : fails + ' SUSPENSION CHECKS FAILED');
process.exit(fails === 0 ? 0 : 1);
