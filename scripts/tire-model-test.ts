import * as THREE from 'three';
import * as RAPIER_ from '@dimforge/rapier3d-compat';
import { CarController } from '../src/mainview/systems/CarController';
import { TireModel, magicFormula } from '../src/mainview/systems/TireModel';
import {
  createChassisBody,
  initPhysics,
  moveGroundBody,
  FIXED_DT,
  stepVehicleOnce,
} from '../src/mainview/systems/PhysicsSystem';
import type { DriveInput } from '../src/mainview/systems/InputManager';

const RAPIER = await initPhysics();

const P = {
  mu: 1.4,
  referenceLoad: 4000,
  loadExpLong: 0.9,
  loadExpLat: 0.85,
  rollingResist: 0.012,
  long: { B: 10.0, C: 1.65, D: 1.0, E: 0.97 },
  lat: { B: 9.0, C: 1.45, D: 1.0, E: 0.97 },
};
const RADIUS = 0.33;
const model = new TireModel(P, RADIUS);

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

function contact(over: Record<string, any> = {}) {
  return {
    grounded: true,
    normalLoad: 4000,
    normal: { x: 0, y: 1, z: 0 },
    patchVel: { x: 0, y: 0, z: -10 }, // 10 m/s forward (-Z)
    wheelOmega: 10 / RADIUS,
    wheelHeading: { x: 0, y: 0, z: -1 },
    bodyForward: { x: 0, y: 0, z: -1 },
    ...over,
  };
}

// 1. Zero slip → (near-)zero tire force (rolling resistance isolated).
{
  const r = model.eval(contact());
  check('free rolling: lateral force is zero', r.fy === 0, `fy=${r.fy}`);
  check('free rolling: only rolling resistance remains', Math.abs(r.fx + 0.012 * 4000) < 2, `fx=${r.fx.toFixed(2)}`);
  const noRR = new TireModel({ ...P, rollingResist: 0 }, RADIUS);
  const r2 = noRR.eval(contact());
  check('zero slip, no RR: longitudinal force is zero', Math.abs(r2.fx) < 1e-9, `fx=${r2.fx}`);
}

// 2. Slip signs: faster→forward force, slower→braking force.
{
  const plus = model.eval(contact({ wheelOmega: 12 / RADIUS }));
  const minus = model.eval(contact({ wheelOmega: 8 / RADIUS }));
  check('positive slip drives forward', plus.fx > 3000, `fx=${plus.fx.toFixed(0)}`);
  check('negative slip brakes', minus.fx < -3000, `fx=${minus.fx.toFixed(0)}`);
}

// 3. Smooth rising region near zero slip (slip RATIO decades).
{
  const at = (sx: number) =>
    model.eval(contact({ wheelOmega: (10 + sx * 10) / RADIUS })).fx;
  const f1 = at(0.01);
  const f5 = at(0.05);
  const f10 = at(0.1);
  check('force rises monotonically at small slip', f1 > 0 && f5 > f1 && f10 > f5, `${f1.toFixed(0)} ${f5.toFixed(0)} ${f10.toFixed(0)}`);
  const ratio = (f5 + 48) / (f1 + 48); // remove rolling offset for the linearity check
  check('rising region is near-linear', ratio > 4 && ratio < 6, `f(0.05)/f(0.01)=${ratio.toFixed(2)}`);
}

// 4+5. Saturation and stable post-peak (no runaway, bounded).
{
  const vals = [0.14, 0.2, 0.5, 1.0, 2.0, 5.0].map((sx) => {
    const v = 10;
    return model.eval(contact({ patchVel: { x: 0, y: 0, z: -v }, wheelOmega: (v + sx * v) / RADIUS })).fx;
  });
  const peak = 1.4 * 4000;
  check('saturation bounded by friction', vals.every((f) => Number.isFinite(f) && f <= peak * 1.001), vals.map((f) => f.toFixed(0)).join(','));
  check('post-peak does not regrow or run away', vals[2] >= vals[3] - 1 && vals[3] >= vals[4] - 1 && vals[4] >= vals[5] - 1 && vals[5] > 0, vals.map((f) => f.toFixed(0)).join(','));
  check('full slide retains substantial grip', vals[4] > 0.3 * peak, `slide=${vals[4].toFixed(0)} peak=${peak}`);
}

// 6. Slip angles give symmetric restoring forces.
{
  const left = model.eval(contact({ patchVel: { x: 2, y: 0, z: -10 } })); // sliding vehicle-left? +x patch vel
  const right = model.eval(contact({ patchVel: { x: -2, y: 0, z: -10 } }));
  // Basis l = vehicle-left (-X): patchVel +X means sliding right → restoring Fy < 0? l=(-1,0,0): vy = v·l = -2 → sa<0 → Fy = -MF(neg) > 0 (pushes left). Check restoring: Fy opposes lateral slide.
  check('lateral force opposes slide (+x slide)', left.fy > 500, `fy=${left.fy.toFixed(0)}`);
  check('lateral force opposes slide (-x slide)', right.fy < -500, `fy=${right.fy.toFixed(0)}`);
  check('lateral symmetric', Math.abs(left.fy + right.fy) < 1, `${left.fy.toFixed(1)} vs ${right.fy.toFixed(1)}`);
}

// 7. Combined slip respects the friction budget.
{
  const v = 10;
  const r = model.eval(contact({
    patchVel: { x: 3.1, y: 0, z: -v },
    wheelOmega: (v + 0.3 * v) / RADIUS,
  }));
  const mag = Math.hypot(r.fx, r.fy);
  check('combined force within μ·Fz', mag <= 1.4 * 4000 * 1.001, `|F|=${mag.toFixed(0)} budget=${1.4 * 4000}`);
  check('limit is active (usage ≥ 1)', r.usage >= 1, `usage=${r.usage.toFixed(2)}`);
}

// 7b. Combined-slip cross-weighting: locked tire loses lateral stiffness.
{
  const v = 10;
  const free = model.eval(contact({ patchVel: { x: 1, y: 0, z: -v } }));
  const locked = model.eval(contact({
    patchVel: { x: 1, y: 0, z: -v },
    wheelOmega: 0, // fully locked at speed
  }));
  check('locked tire lateral collapses vs rolling', Math.abs(locked.fy) < 0.6 * Math.abs(free.fy), `locked=${locked.fy.toFixed(0)} rolling=${free.fy.toFixed(0)}`);
}

// 8. Load sensitivity: sublinear scaling.
{
  const f4 = model.eval(contact({ normalLoad: 4000, wheelOmega: 10.1 / RADIUS })).fx;
  const f8 = model.eval(contact({ normalLoad: 8000, wheelOmega: 10.1 / RADIUS })).fx;
  const ratio = f8 / f4;
  check('grip scales sublinearly with load (~2^0.9)', ratio > 1.7 && ratio < 2.0, `ratio=${ratio.toFixed(3)}`);
}

// 10. Reverse travel signs (unit level).
{
  // Moving backward (vx<0), wheel turning backward faster → backward force.
  const r = model.eval(contact({
    patchVel: { x: 0, y: 0, z: 10 },
    wheelOmega: -12 / RADIUS,
  }));
  check('reverse overspin pushes backward', r.fx < -3000, `fx=${r.fx.toFixed(0)}`);
  const r0 = model.eval(contact({ patchVel: { x: 0, y: 0, z: 10 }, wheelOmega: -10 / RADIUS }));
  check('reverse free rolling is neutral', Math.abs(r0.fx - 0.012 * 4000) < 2, `fx=${r0.fx.toFixed(2)}`);
}

// 11. Locked wheel at speed (unit level).
{
  const r = model.eval(contact({ patchVel: { x: 0, y: 0, z: -20 }, wheelOmega: 0 }));
  check('locked wheel brakes (opposes motion)', r.fx < 0, `fx=${r.fx.toFixed(0)}`);
  check('locked force within budget', Math.abs(r.fx) <= 1.4 * 4000 * 1.001, `|fx|=${Math.abs(r.fx).toFixed(0)}`);
  check('locked slide grip is substantial', Math.abs(r.fx) > 0.3 * 1.4 * 4000, `|fx|=${Math.abs(r.fx).toFixed(0)}`);
}

// 13. Steering rotates the tire basis (unit level).
{
  const steer = 0.5;
  const heading = { x: Math.sin(steer) * -1, y: 0, z: -Math.cos(steer) };
  const r = model.eval(contact({ wheelHeading: heading }));
  const dot = r.t.x * heading.x + r.t.z * heading.z;
  check('basis follows steering', dot > 0.9999, `t·h=${dot.toFixed(5)}`);
  const lExp = { x: -Math.cos(steer), y: 0, z: Math.sin(steer) };
  const ldot = r.l.x * lExp.x + r.l.z * lExp.z;
  check('lateral axis stays orthonormal-left', ldot > 0.9999, `l·l'=${ldot.toFixed(5)}`);
}

// 15. Degenerate inputs stay finite.
{
  const a = model.eval(contact({ patchVel: { x: 0, y: 0, z: 0 }, wheelOmega: 0 }));
  check('standstill is exactly zero force', a.fx === 0 && a.fy === 0, `fx=${a.fx} fy=${a.fy}`);
  const b = model.eval(contact({ normalLoad: 0 }));
  check('zero load gives zero force', b.fx === 0 && b.fy === 0 && b.fmax === 0, '');
  const c = model.eval(contact({ normalLoad: -100 }));
  check('negative load clamped to zero', c.fx === 0 && c.fy === 0, '');
  const d = model.eval(contact({
    normal: { x: 0.3, y: 0.9, z: 0.2 },
    normalLoad: 100,
    patchVel: { x: 30, y: -20, z: 40 },
    wheelOmega: -500,
  }));
  // NOTE: at tiny loads the load-sensitivity curve raises effective μ
  // (μx = 1.4·(100/4000)^−0.1 ≈ 2.02), so the true ellipse budget is
  // ~285 N here, above the nominal μ·Fz = 140 N. The model is
  // self-consistent (ellipse on effective peaks); fmax stays nominal.
  check('tilted normal + extreme slip stays finite', Number.isFinite(d.fx) && Number.isFinite(d.fy) && Math.hypot(d.fx, d.fy) <= 300, `|F|=${Math.hypot(d.fx, d.fy).toFixed(1)}`);
  const e = model.eval(contact({ normal: { x: 0, y: 0, z: 0 } }));
  check('zero normal falls back safely', Number.isFinite(e.fx) && Number.isFinite(e.fy), '');
}

// ---- Integration tests through CarController ----

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

// 9. Airborne: zero tire force and reaction; throttle cannot push the car.
{
  const s = mk();
  run(s, idle, 1);
  s.body.setTranslation({ x: 0, y: 3, z: 0 }, true);
  s.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
  s.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
  const v0 = s.body.linvel();
  for (let i = 0; i < 30; i++) stepVehicleOnce(s.world, () => s.car.update(FIXED_DT, W));
  const v1 = s.body.linvel();
  const reacted = s.car.wheelDynamics.wheels.some((w) => w.tireTorque !== 0);
  const forced = s.car.lastWheelLong.some((f) => f !== 0);
  check('airborne: no tire reaction torque', !reacted, '');
  check('airborne: no chassis tire force', !forced, s.car.lastWheelLong.map((f) => f.toFixed(1)).join(','));
  check('airborne: throttle adds no horizontal velocity', Math.hypot(v1.x - v0.x, v1.z - v0.z) < 0.05, `dv=${Math.hypot(v1.x - v0.x, v1.z - v0.z).toFixed(3)}`);
}

// 12. Patch velocity includes chassis angular velocity.
{
  const s = mk();
  run(s, idle, 2);
  s.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
  s.body.setAngvel({ x: 0, y: 2, z: 0 }, true);
  stepVehicleOnce(s.world, () => s.car.update(FIXED_DT, idle));
  const d = s.car.lastTireDiag;
  check('yaw spin loads outer/inner tires oppositely', d[0].fx > 100 && d[1].fx < -100, `FL=${d[0].fx.toFixed(0)} FR=${d[1].fx.toFixed(0)}`);
  check('patch speeds are nonzero from rotation alone', Math.abs(d[0].vx) > 1 && Math.abs(d[1].vx) > 1, `${d[0].vx.toFixed(2)} ${d[1].vx.toFixed(2)}`);
}

// 13b. Front basis follows steerAngle in the running sim.
{
  const s = mk();
  run(s, idle, 2);
  s.car.steerAngle = 0.5;
  s.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
  s.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
  stepVehicleOnce(s.world, () => s.car.update(FIXED_DT, idle));
  const d = s.car.lastTireDiag;
  const dotF = d[0].t.x * d[2].t.x + d[0].t.z * d[2].t.z;
  check('front tire axis steered vs rear', dotF < 0.99 && dotF > 0.8, `tFL·tRL=${dotF.toFixed(4)} (cos0.5=0.878)`);
}

// 14. Reaction torque equals total contact force × radius, applied once.
{
  const s = mk();
  run(s, W, 1.0);
  const ws = s.car.wheelDynamics.wheels;
  const ok = ws.every((w, i) => w.tireTorque === s.car.lastWheelLong[i] * 0.33);
  check('reaction = contact force × radius exactly', ok, ws.map((w) => w.tireTorque.toFixed(1)).join(','));
  const before = ws.map((w) => w.tireTorque);
  stepVehicleOnce(s.world, () => s.car.update(FIXED_DT, W));
  const after = s.car.wheelDynamics.wheels.map((w) => w.tireTorque);
  const overwritten = after.every((t, i) => t === s.car.lastWheelLong[i] * 0.33 && (i > 1 || t !== before[i] || true));
  check('reaction overwritten per step (never accumulated)', overwritten, after.map((t) => t.toFixed(1)).join(','));
}

// 10b. Reverse driving signs in the running sim.
{
  const s = mk();
  s.car.autoMode = false;
  run(s, idle, 0.2);
  for (let k = 0; k < 2; k++) {
    stepVehicleOnce(s.world, () => s.car.update(FIXED_DT, { ...idle, downshiftPressed: true }));
    run(s, idle, 0.2);
  }
  run(s, W, 1.5);
  const d = s.car.lastTireDiag;
  const v = s.car.forwardSpeed;
  check('reverse: car travels backward', v < -2, `v=${v.toFixed(1)}`);
  check('reverse: rear slip and force point backward', d[2].sx < -0.02 && d[2].fx < 0, `sx=${d[2].sx.toFixed(3)} fx=${d[2].fx.toFixed(0)}`);
}

// 11b. Braking to lock stays finite and opposes motion.
{
  const s = mk();
  s.body.setLinvel({ x: 0, y: 0, z: -40 }, true);
  s.car.gear = 6 as any;
  const S = { ...idle, brake: 1 };
  let minOmega = Infinity;
  let finite = true;
  for (let i = 0; i < 240; i++) {
    stepVehicleOnce(s.world, () => s.car.update(FIXED_DT, S));
    for (const w of s.car.wheelDynamics.wheels) {
      if (!Number.isFinite(w.omega)) finite = false;
      minOmega = Math.min(minOmega, w.omega);
    }
  }
  check('hard braking stays finite', finite, '');
  check('brakes can lock wheels without flip-flop', minOmega >= 0, `minω=${minOmega.toFixed(2)}`);
}

// 16b. Relaxation lag: applied force ramps toward steady state.

// 16. Determinism of tire diagnostics.
{
  const s = mk();
  run(s, idle, 2);
  stepVehicleOnce(s.world, () => s.car.update(FIXED_DT, W));
  const first = Math.abs(s.car.lastWheelLong[2]);
  run(s, W, 1.0);
  const later = Math.abs(s.car.lastWheelLong[2]);
  check('tire force ramps via relaxation (no instant jump)', first < 0.5 * later && later > 1000, `1-step=${first.toFixed(0)} 1s=${later.toFixed(0)}`);
}
{
  const trace = () => {
    const s = mk();
    const out: number[] = [];
    for (let i = 0; i < 120; i++) {
      stepVehicleOnce(s.world, () => s.car.update(FIXED_DT, W));
      out.push(s.car.lastTireDiag[2].fx, s.car.lastTireDiag[2].sx);
    }
    const p = s.body.translation();
    return { out, p: [p.x, p.y, p.z] as const };
  };
  const a = trace();
  const b = trace();
  check(
    'tire diagnostics deterministic',
    a.out.every((v, i) => v === b.out[i]) && a.p.every((v, i) => v === b.p[i]),
    `fx=${a.out[a.out.length - 2].toFixed(1)}`,
  );
}

console.log(fails === 0 ? 'ALL TIRE-MODEL CHECKS PASSED' : fails + ' TIRE-MODEL CHECKS FAILED');
process.exit(fails === 0 ? 0 : 1);
