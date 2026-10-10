import * as RAPIER_ from '@dimforge/rapier3d-compat';
import { CarController } from '../src/mainview/systems/CarController';
import {
  createChassisBody,
  initPhysics,
  FIXED_DT,
  MAX_SUBSTEPS,
  createFixedStepper,
  pushFrameTime,
  consumeSubstep,
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

function mk() {
  const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
  world.timestep = FIXED_DT;
  const body = createChassisBody(world, 0, 0.72, 0);
  const car = new CarController(world, body, RAPIER);
  return { world, body, car };
}

let fails = 0;
const check = (name: string, cond: boolean, extra = '') => {
  console.log((cond ? 'PASS' : 'FAIL') + ' | ' + name + (extra ? ' | ' + extra : ''));
  if (!cond) fails++;
};

// Instrument: count controller updates (+ dts seen) and Rapier steps.
function instrument(s: ReturnType<typeof mk>) {
  let updates = 0;
  let steps = 0;
  const dts: number[] = [];
  const origUpdate = s.car.update.bind(s.car);
  (s.car as any).update = (dt: number, inp: DriveInput) => {
    updates++;
    dts.push(dt);
    return origUpdate(dt, inp);
  };
  const origStep = s.world.step.bind(s.world);
  (s.world as any).step = () => {
    steps++;
    return origStep();
  };
  return {
    get updates() { return updates; },
    get steps() { return steps; },
    dts,
  };
}

// Simulates one rendered frame through the same accumulator pipeline as App.
function runFrame(
  s: ReturnType<typeof mk>,
  stepper: ReturnType<typeof createFixedStepper>,
  frameDt: number,
  inp: DriveInput,
) {
  const n = pushFrameTime(stepper, frameDt);
  for (let i = 0; i < n; i++) {
    stepVehicleOnce(s.world, () => s.car.update(FIXED_DT, inp));
    consumeSubstep(stepper);
  }
  return n;
}

// 1. One fixed-size frame -> exactly one controller update + one Rapier step.
{
  const s = mk();
  const probe = instrument(s);
  const stepper = createFixedStepper();
  const n = runFrame(s, stepper, FIXED_DT, idle);
  check('single fixed frame runs one substep', n === 1, `n=${n}`);
  check('controller updated exactly once', probe.updates === 1, `updates=${probe.updates}`);
  check('rapier stepped exactly once', probe.steps === 1, `steps=${probe.steps}`);
  check('controller dt is exactly FIXED_DT', probe.dts.length === 1 && probe.dts[0] === FIXED_DT, `dt=${probe.dts[0]}`);
}

// 2. A long (1/30 s) frame subdivides into 4 fixed substeps, none oversized.
{
  const s = mk();
  const probe = instrument(s);
  const stepper = createFixedStepper();
  const n = runFrame(s, stepper, 1 / 30, idle);
  check('1/30s frame subdivides into 4 substeps', n === 4, `n=${n}`);
  check('controller ran 4x, rapier 4x', probe.updates === 4 && probe.steps === 4, `u=${probe.updates} s=${probe.steps}`);
  check('no oversized controller dt', probe.dts.every((d) => d === FIXED_DT), `dts=[${probe.dts.join(',')}]`);
}

// 3. Backlog policy: excessive time is capped and measured, never looped forever.
{
  const stepper = createFixedStepper();
  const n = pushFrameTime(stepper, 0.5);
  const expectedDropped = 0.5 - MAX_SUBSTEPS * FIXED_DT;
  check('overflow frame capped at MAX_SUBSTEPS', n === MAX_SUBSTEPS, `n=${n} max=${MAX_SUBSTEPS}`);
  check(
    'dropped time is measured',
    Math.abs(stepper.droppedTotal - expectedDropped) < 1e-9,
    `dropped=${stepper.droppedTotal.toFixed(6)} expected=${expectedDropped.toFixed(6)}`,
  );
}

// 4. Determinism: same frame sequence twice -> identical body state.
{
  const runSeq = () => {
    const s = mk();
    const stepper = createFixedStepper();
    const W = { ...idle, throttle: 1 };
    for (const f of [1 / 60, 1 / 30, 1 / 120, 1 / 45]) runFrame(s, stepper, f, W);
    const p = s.body.translation();
    const v = s.body.linvel();
    return `${p.x.toFixed(9)},${p.y.toFixed(9)},${p.z.toFixed(9)}|${v.x.toFixed(9)},${v.y.toFixed(9)},${v.z.toFixed(9)}`;
  };
  const a = runSeq();
  const b = runSeq();
  check('identical frame sequences are deterministic', a === b, a);
}

console.log(fails === 0 ? 'ALL FIXED-STEP CHECKS PASSED' : fails + ' FIXED-STEP CHECKS FAILED');
process.exit(fails === 0 ? 0 : 1);
