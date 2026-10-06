/**
 * Realistic arcade-sim car controller on top of a single Rapier dynamic body.
 * - Raycast suspension (spring + damper per wheel), two passes so friction
 *   caps can use axle-averaged load.
 * - Simplified Pacejka-ish tire grip (longitudinal + lateral)
 * - 800hp / 1000Nm engine with torque curve, fuel-cut rev limiter
 * - Gearbox: R, N, 1-8. Auto + Manual. Q downshift / E upshift.
 * - S is BRAKE ONLY in N and gears >= 1. Reverse motion only in R (where
 *   W is the accelerator and S is the brake, like a real automatic).
 * - Launch control: hold W + S together in 1st to arm (clutch held open so
 *   the car does not move an inch), release S to launch.
 * - Torque-converter creep in D/R, parking brake at spawn.
 *
 * Tunables live in constants/physics.ts (CAR_PHYSICS).
 */
import * as RAPIER from '@dimforge/rapier3d-compat';
import * as THREE from 'three';
import { CAR_PHYSICS } from '../constants/physics';
import type { DriveInput } from './InputManager';

export type Gear = -1 | 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;

export interface CarTelemetry {
  speedKmh: number;
  rpm: number;
  gear: Gear;
  gearLabel: string;
  autoMode: boolean;
  throttle: number;
  brake: number;
  steer: number;
  shifting: boolean;
  launchArmed: boolean;
  launching: boolean;
  parkingBrake: boolean;
  slipRatio: number;
  drift: boolean;
}

function lerp(a: number, b: number, t: number) {
  return a + (b - a) * t;
}

function clamp(v: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, v));
}

/** Interpolate torque curve [[rpm, mult], ...] */
function torqueMult(curve: readonly (readonly number[])[], rpm: number): number {
  if (rpm <= curve[0][0]) return curve[0][1];
  for (let i = 1; i < curve.length; i++) {
    if (rpm <= curve[i][0]) {
      const [r0, m0] = curve[i - 1];
      const [r1, m1] = curve[i];
      const t = (rpm - r0) / Math.max(1, r1 - r0);
      return lerp(m0, m1, t);
    }
  }
  return 0;
}

const WHEEL_LOCAL = [
  // NOTE: physics forward is -Z. Hardpoints match the GLB's own wheels
  // (measured: front axle z=-1.51, rear z=+1.31, track ±0.76)
  { x: -0.76, z: -1.51, front: true, left: true }, // FL
  { x: 0.76, z: -1.51, front: true, left: false }, // FR
  { x: -0.76, z: 1.31, front: false, left: true }, // RL (driven)
  { x: 0.76, z: 1.31, front: false, left: false }, // RR (driven)
];

export class CarController {
  body: RAPIER.RigidBody;
  world: RAPIER.World;
  R: typeof RAPIER;

  // gearbox state
  gear: Gear = 1;
  autoMode = true;
  rpm: number = CAR_PHYSICS.engine.idleRPM;
  private shiftTimer = 0;
  private clutch = 1; // 1 engaged
  private wheelOmega = 0; // free-rolling axle speed (rad/s)
  launchEnabled = true;
  launching = false;
  launchArmed = false;
  private simTime = 0;
  private limiterCut = false; // rev-limiter fuel cut state (with hysteresis)
  private launchTimer = 0; // time since launch was armed (drives LAUNCH! banner)
  parkingBrake = true; // auto P-gear: engaged at spawn, releases on first throttle

  steerAngle = 0;
  slipRatioAvg = 0;
  drifting = false;
  /** driven-axle angular velocity incl. slip (for visual wheel spin) */
  spinOmega = 0;
  /** average rear-axle longitudinal slip ratio (drives honest visual spin) */
  rearSlip = 0;
  /** debug/tuning: last computed per-wheel normal load (N) and longitudinal
   *  force (N), order FL,FR,RL,RR */
  lastWheelLoad = [0, 0, 0, 0];
  lastWheelLong = [0, 0, 0, 0];

  // smoothing
  private filteredSpeed = 0;

  constructor(world: RAPIER.World, body: RAPIER.RigidBody, R: typeof RAPIER) {
    this.world = world;
    this.body = body;
    this.R = R;
    // speed-proportional drag is modeled explicitly; keep solver damping tiny
    this.body.setLinearDamping(0.005);
    this.body.setAngularDamping(0.55);
  }

  reset(pos: THREE.Vector3, yaw = 0) {
    this.body.setTranslation({ x: pos.x, y: pos.y, z: pos.z }, true);
    const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, yaw, 0));
    this.body.setRotation({ x: q.x, y: q.y, z: q.z, w: q.w }, true);
    this.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
    this.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
    this.gear = 1;
    this.rpm = CAR_PHYSICS.engine.idleRPM;
    this.shiftTimer = 0;
    this.clutch = 1;
    this.wheelOmega = 0;
    this.parkingBrake = true;
    this.launchTimer = 0;
    this.limiterCut = false;
  }

  get forwardSpeed(): number {
    const v = this.body.linvel();
    const q = this.body.rotation();
    const quat = new THREE.Quaternion(q.x, q.y, q.z, q.w);
    const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(quat);
    return v.x * fwd.x + v.y * fwd.y + v.z * fwd.z;
  }

  update(dt: number, input: DriveInput): CarTelemetry {
    const P = CAR_PHYSICS;
    // Same cap the render loop uses — see simulation.maxFrameDt. These MUST match:
    // the loop hands this same dt to stepWorld, so if we integrated tire forces
    // over a shorter span than the world advanced, grip would quietly drop
    // whenever the frame rate dipped.
    dt = Math.min(dt, P.simulation.maxFrameDt);
    this.simTime += dt;

    // --- mode / gear edge inputs ---
    if (input.toggleModePressed) this.autoMode = !this.autoMode;
    if (input.toggleLaunchPressed) this.launchEnabled = !this.launchEnabled;
    if (this.shiftTimer > 0) this.shiftTimer -= dt;

    if (!this.autoMode) {
      if (input.upshiftPressed) this.manualShift(1);
      if (input.downshiftPressed) this.manualShift(-1);
    }

    const linvel = this.body.linvel();
    const fwdSpeed = this.forwardSpeed;
    this.filteredSpeed += (Math.abs(fwdSpeed) - this.filteredSpeed) * Math.min(1, dt * 6);

    const rot = this.body.rotation();
    const quat = new THREE.Quaternion(rot.x, rot.y, rot.z, rot.w);
    const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(quat);
    const right = new THREE.Vector3(1, 0, 0).applyQuaternion(quat);
    fwd.y = 0; right.y = 0; fwd.normalize(); right.normalize();

    // sideslip angle (for TC slide-cut + ESC), cheap global estimate
    const latVGlobal = linvel.x * right.x + linvel.z * right.z;
    const beta = clamp(latVGlobal / Math.max(10, Math.abs(fwdSpeed)), -0.4, 0.4);

    // parking brake (auto P-gear): engaged at spawn, releases the moment you
    // touch the throttle. Holds all four wheels like leaving it in Park.
    if (input.throttle > 0.3) this.parkingBrake = false;

    // --- steering (speed sensitive + grip-capped) ---
    // Beyond capping by feel, the angle is hard-limited to what the tires can
    // actually hold (~1.3g): at 250kmh+ even full lock is only a few
    // milliradians, so yanking the wheel can't flick the car into a slide.
    const speedKmh = Math.abs(fwdSpeed) * 3.6;
    const S = P.wheels.steering;
    const steerFactor = 1 / (1 + Math.pow(speedKmh / S.speedFalloffKmh, 2) * S.speedSensitivity * 3);
    // Grip cap: the steer angle that would use up the front axle's whole
    // lateral budget. Budget is ~3.3g (a loaded outside tyre briefly exceeds
    // 1g), NOT 1.25g — the old 1.25g budget capped full lock at 0.4 degrees
    // above 250km/h, which made the car physically unable to change direction
    // no matter how hard you steered. Anything past the cap just means the
    // fronts are saturated (understeer), which is the real-world behaviour.
    const gripCap = Math.atan((2.85 * 32) / Math.max(40, fwdSpeed * fwdSpeed));
    // ...and a hard floor, because there is always usable lock at speed even
    // when the fronts are past their peak. Without this the car goes numb.
    const steerCap = Math.max(gripCap, S.minAngleAtSpeed);
    const targetSteer = clamp(input.steer * S.maxAngle * steerFactor, -steerCap, steerCap);
    const steerRate = 6;
    this.steerAngle += clamp(targetSteer - this.steerAngle, -steerRate * dt, steerRate * dt);

    // --- launch control: arm by holding W + S together at a standstill in 1st.
    // rpm pins to launch RPM; release S (keep W) to launch. HUD flashes red.
    // (computed before the RPM section so the flare logic can defer to it)
    const atStandstill = Math.abs(fwdSpeed) < 1.2;
    this.launchArmed =
      this.launchEnabled && atStandstill && this.gear === 1 &&
      input.throttle > 0.7 && input.brake > 0.2;

    // --- RPM from wheels ---
    const ratios = P.transmission.gearRatios;
    const finalDrive = P.transmission.finalDriveRatio;
    const wheelRadius = P.wheels.radius;
    // estimate wheel omega from forward speed
    const rollingOmega = fwdSpeed / Math.max(0.2, wheelRadius);

    let gearRatio = 0;
    if (this.gear > 0) gearRatio = ratios[this.gear - 1] * finalDrive;
    else if (this.gear === -1) gearRatio = 3.2 * finalDrive; // reverse ratio

    let targetRpm: number;
    if (this.gear === 0) {
      // Neutral: free rev. Blips up fast on throttle, then winds back down to
      // idle on its own (flywheel inertia + neutral idle control).
      targetRpm = P.engine.idleRPM + input.throttle * (P.engine.redlineRPM - P.engine.idleRPM) * 0.9;
      if (targetRpm > this.rpm) {
        this.rpm += (targetRpm - this.rpm) * Math.min(1, dt * 5.0);
      } else {
        // EXPONENTIAL decay of the rpm ABOVE idle, with a decay rate that rises
        // with rpm: lots of stored energy (and lots of friction power) up high,
        // so a big blip falls faster than a small one, then everything eases
        // into idle. Keeps the intended flyweight feel — a full 6800rpm blip
        // takes ~2.5s to settle, and you can see it coast.
        //
        // This was previously an ABSOLUTE decrement (a flat -0.25..-0.8 rpm per
        // frame) that was not tied to how far the needle still had to travel:
        // from a 6800rpm blip it would have needed ~hours to reach idle, so
        // letting go of the throttle in N left the needle pinned high. Decaying
        // the EXCESS is the fix — the distance to close now shrinks with the
        // distance remaining, so it always converges.
        const excess = Math.max(0, this.rpm - P.engine.idleRPM);
        const decay = 1.2 + 1.3 * Math.min(1, excess / 3500);
        this.rpm = P.engine.idleRPM + excess * Math.exp(-decay * dt);
      }
    } else {
      const coupled = Math.abs(rollingOmega * gearRatio * 60 / (2 * Math.PI));
      // blend wheel-coupled rpm with throttle influence & clutch slip at low speed
      const clutchSlip = clamp(1 - Math.abs(fwdSpeed) / 6, 0, 1) * (1 - this.clutch * 0);
      const throttleFlare = input.throttle * clutchSlip * 2500;
      targetRpm = Math.max(P.engine.idleRPM * 0.95, coupled + throttleFlare);
      // low-speed clutch: let rpm sit above stall (unless launch control owns the needle)
      if (!this.launchArmed && Math.abs(fwdSpeed) < 3 && input.throttle > 0.1 && this.gear >= 1) {
        targetRpm = Math.max(targetRpm, P.engine.idleRPM + input.throttle * 2200);
      }
      // launch control owns the needle while armed: pin to launch RPM
      if (this.launchArmed) targetRpm = P.transmission.launchControlRPM;
      this.rpm += (targetRpm - this.rpm) * Math.min(1, dt * 10);
      this.wheelOmega = rollingOmega;
    }

    this.launching = false;
    if (this.launchArmed) {
      // both pedals pinned: ECU bounces rpm AT the launch target
      this.launchTimer = 2.0;
      if (this.rpm > P.transmission.launchControlRPM) {
        this.rpm = P.transmission.launchControlRPM + Math.sin(this.simTime * 50) * 120;
      }
    } else {
      this.launchTimer = Math.max(0, this.launchTimer - dt);
    }
    // launching: just released the brake with throttle pinned, still slow
    this.launching = !this.launchArmed && this.launchTimer > 0 && !atStandstill && input.throttle > 0.7;
    // rev limiter: FUEL CUT with hysteresis (bounce off the limiter like a real ECU).
    // While cut, engine produces zero torque so speed cannot keep increasing.
    const LIM = P.engine.revLimiterRPM;
    if (this.rpm >= LIM) this.limiterCut = true;
    else if (this.rpm < LIM - 400) this.limiterCut = false;
    if (this.rpm > LIM) this.rpm = LIM;

    // --- auto gearbox: fixed shift points (no throttle mapping, no kickdown).
    // Upshifts at peak-power rpm; downshifts only to prevent lugging or
    // when coming to a stop. Over-rev refusal still applies throughout.
    if (this.autoMode && this.shiftTimer <= 0 && this.gear >= 1) {
      if (input.throttle > 0.25 && this.rpm > P.transmission.autoUpshiftRPM && this.gear < 8) {
        this.doShift(1);
      } else if (this.rpm < 1400 && this.gear > 1) {
        this.doShift(-1); // lugging protection at any speed (over-rev refusal still applies)
      } else if (speedKmh < 5 && this.gear > 1) {
        this.doShift(-1); // coming to a stop: cascade back down to 1st
      }
    }
    const shifting = this.shiftTimer > 0;

    // --- engine torque ---
    const torqueCurveMult = torqueMult(P.engine.torqueCurve, this.rpm);
    let engineTorque = P.engine.maxTorqueNm * torqueCurveMult * input.throttle;
    // friction
    const friction = P.engine.frictionTorqueBase + this.rpm * P.engine.frictionTorqueRPMFactor;
    engineTorque -= friction * 0.25;
    if (this.gear === 0) engineTorque = 0; // neutral: no drive
    if (shifting) engineTorque *= 0.25; // cut during shift
    if (this.limiterCut) engineTorque = 0; // REV LIMITER fuel cut: no torque, speed can't rise
    // NOTE: no torque limit while launch-armed — full beans on release (aggressive).

    // traction control: cut torque when slipping hard.
    // holding the handbrake disables TC (like real cars) so you can do
    // burnouts and donuts. Extra cut under power-on oversteer (big sideslip
    // + throttle) so slides re-hook instead of tank-slapping.
    const tcGain = (input.handbrake ? 0 : P.assists.tractionControl) *
      ((this.launching || this.launchArmed) ? 0.35 : 1); // launch: let it rip
    if (this.slipRatioAvg > 0.18) {
      let cut = clamp((this.slipRatioAvg - 0.18) / 0.5, 0, 1);
      // power-on oversteer: only rein in BIG slides under power, let moderate
      // RWD slides keep their power so drifts are holdable, not killed
      if (input.throttle > 0.5 && Math.abs(beta) > 0.14 && !this.launching) {
        cut = Math.min(1, cut + clamp((Math.abs(beta) - 0.14) * 4, 0, 0.3));
      }
      // cornering + power: deep cut when the wheel is turned AND rears spin.
      // This is what stops 3rd-gear full-throttle spins mid-corner (real TC
      // does exactly this). Handbrake exempts it, so intentional
      // donuts/burnouts still work.
      if (!input.handbrake && Math.abs(this.steerAngle) > 0.12 && !this.launching) {
        cut = Math.min(1, cut + clamp((this.slipRatioAvg - 0.15) * 2.5, 0, 0.55));
      }
      engineTorque *= lerp(1, 1 - Math.min(0.85, tcGain * 2), cut);
    }
    engineTorque = Math.max(0, engineTorque);

    // wheel drive torque (RWD — M3) with torque-converter stall multiplication
    // off the line (fades out by lockup speed, like a real slushbox)
    const tcMult =
      this.gear !== 0
        ? 1 + (P.transmission.torqueConverter.stallMultiplication - 1) *
            clamp(1 - speedKmh / P.transmission.torqueConverter.lockupSpeedKmh, 0, 1)
        : 1;
    let driveTorquePerRear = 0;
    if (this.gear !== 0) {
      const dir = this.gear === -1 ? -1 : 1;
      driveTorquePerRear = (engineTorque * gearRatio * 0.85 /* efficiency */ * tcMult * dir) / 2;
      // launch staging: clutch held OPEN while armed (zero drive = zero creep,
      // not even an inch) — full aggressive dump the instant S is released
      if (this.launchArmed) driveTorquePerRear = 0;
    }

    // --- per-wheel suspension (pass 1) + tire forces (pass 2) ---
    // Pass 1 resolves all suspension loads first so pass 2 can use
    // AXLE-AVERAGED load for friction caps. (Per-corner solver noise would
    // otherwise create asymmetric caps -> phantom yaw moments.)
    const pos = this.body.translation();
    const bodyPos = new THREE.Vector3(pos.x, pos.y, pos.z);
    let totalSlip = 0;
    let groundedWheels = 0;
    let rearSlipSum = 0;
    let rearCount = 0;

    interface WheelSolve {
      w: (typeof WHEEL_LOCAL)[number];
      wi: number;
      grounded: boolean;
      load: number;
      contactY: number;
      anchor: THREE.Vector3;
      vLong: number;
      vLat: number;
      fwd: THREE.Vector3;
      right: THREE.Vector3;
    }
    const solves: WheelSolve[] = [];
    const angvel0 = this.body.angvel();
    const ang0 = new THREE.Vector3(angvel0.x, angvel0.y, angvel0.z);
    const lin0 = new THREE.Vector3(linvel.x, linvel.y, linvel.z);

    for (const w of WHEEL_LOCAL) {
      const wi = WHEEL_LOCAL.indexOf(w);
      const local = new THREE.Vector3(w.x, 0, w.z);
      const anchorWorld = local.clone().applyQuaternion(quat).add(bodyPos);

      const rayOrigin = { x: anchorWorld.x, y: anchorWorld.y + 0.1, z: anchorWorld.z };
      const rayDir = { x: 0, y: -1, z: 0 };
      const ray = new this.R.Ray(rayOrigin, rayDir);
      // rest length tuned so equilibrium lands at body-center height ≈ 0.72m
      const REST = 0.915;
      const maxToi = REST + 0.12;
      // exclude own chassis (ray starts inside it); solid=true so we get contact even when overlapping
      const hit = this.world.castRay(ray, maxToi, true, undefined, undefined, undefined, this.body);

      const steer = w.front ? this.steerAngle : 0;
      const wheelFwd = new THREE.Vector3(Math.sin(steer) * -1, 0, -Math.cos(steer)).applyQuaternion(quat);
      wheelFwd.y = 0; wheelFwd.normalize();
      // NOTE: fwd x up points left; negate to get vehicle-right
      const wheelRight = new THREE.Vector3().crossVectors(wheelFwd, new THREE.Vector3(0, 1, 0)).normalize().negate();

      if (!hit) {
        this.lastWheelLoad[wi] = 0;
        this.lastWheelLong[wi] = 0;
        solves.push({ w, wi, grounded: false, load: 0, contactY: 0, anchor: anchorWorld, vLong: 0, vLat: 0, fwd: wheelFwd, right: wheelRight });
        continue;
      }
      groundedWheels++;
      const contactY = rayOrigin.y - hit.timeOfImpact;
      const compression = clamp(REST - hit.timeOfImpact, -0.06, P.wheels.suspension.travel + 0.06);

      // suspension spring + damper (vertical velocity at wheel point)
      // + progressive bump-stop: rate rises in the last 2cm of travel
      const r = new THREE.Vector3(anchorWorld.x - bodyPos.x, 0, anchorWorld.z - bodyPos.z);
      const pointVel = lin0.clone().add(ang0.clone().cross(r));
      const bump = 1 + Math.max(0, compression - 0.1) * 12; // bump-stop
      const springF = P.wheels.suspension.springRate * bump * compression;
      const damperF = -P.wheels.suspension.damperRate * pointVel.y;
      const suspF = Math.max(0, springF + damperF);
      this.body.applyImpulseAtPoint({ x: 0, y: suspF * dt, z: 0 }, anchorWorld, true);

      const load = suspF; // normal load ~ suspension force
      this.lastWheelLoad[wi] = load;

      solves.push({
        w, wi, grounded: true, load, contactY, anchor: anchorWorld,
        vLong: pointVel.dot(wheelFwd), vLat: pointVel.dot(wheelRight),
        fwd: wheelFwd, right: wheelRight,
      });
    }

    const axleLoad = (front: boolean) => {
      const ls = solves.filter((s) => s.w.front === front && s.grounded).map((s) => s.load);
      if (ls.length === 0) return 800;
      return ls.reduce((a, b) => a + b, 0) / ls.length;
    };
    const avgFront = axleLoad(true);
    const avgRear = axleLoad(false);

    const muPeak = 1.4; // sticky sport tires

    for (const s of solves) {
      if (!s.grounded) continue;
      const { w, wi, vLong, vLat } = s;
      // friction caps use the AXLE-AVERAGED load (see note above)
      const capLoad = Math.max(800, w.front ? avgFront : avgRear);

      // --- longitudinal: drive + brake ---
      const maxTire = muPeak * capLoad;
      let longForce = 0;
      if (!w.front) {
        // RWD
        const wheelTorque = driveTorquePerRear;
        const tractive = wheelTorque / wheelRadius;
        // slip ratio approx. The throttle term stands in for wheelspin, which
        // is a LOW-speed phenomenon — it used to add a flat +2.5 m/s of wheel
        // speed at every velocity, so simply being on the throttle kept the
        // rear permanently "spinning" at low speed (and dragged TC in for no
        // reason). Faded out with road speed.
        const spinBoost = input.throttle * 2.5 * clamp(1 - Math.abs(vLong) / 22, 0.12, 1);
        const spinVel = this.gear === 0 ? vLong : (this.wheelOmega * wheelRadius + spinBoost);
        const slip = clamp((spinVel - vLong) / Math.max(3, Math.abs(vLong) + 3), -1, 1);
        totalSlip += Math.abs(slip);
        rearSlipSum += slip;
        rearCount++;
        const grip = Math.tanh(Math.abs(slip) * 4) * Math.sign(slip || tractive);
        // spinning tires waste energy (partially rescued by traction control)
        const spinLoss = Math.abs(grip) * 0.28 * (1 - P.assists.tractionControl * 0.6);
        // when no slip, apply tractive directly capped by friction circle
        longForce = clamp(tractive * (1 - spinLoss), -maxTire, maxTire);
        if (this.gear === 0) longForce = 0;
        // hill-hold: only ever pushes FORWARD against rollback (never fights
        // the torque-converter creep, which is also forward in D)
        if (this.gear >= 1 && fwdSpeed < 0.05 && fwdSpeed > -2) {
          longForce += clamp(-fwdSpeed * 1500, 0, 2000);
        }
        // torque-converter idle creep in D when no pedal is touched (real automatic).
        // Fades out by ~11kmh so the car settles into a ~8kmh / ~1k-rpm cruise.
        // Brake pedal overrides it, so holding S still holds the car.
        if (this.gear >= 1 && input.throttle < 0.05 && input.brake < 0.05 && fwdSpeed > -0.5 && fwdSpeed < 3) {
          longForce += (P.transmission.torqueConverter.creepForce / 2) * clamp(1 - fwdSpeed / 3, 0, 1);
        }
      } else {
        totalSlip += 0;
      }

      // brakes: S is BRAKE ONLY in gears >=1 and N. In R, W/SWAP: W = accelerator, S = brake.
      let brakeTorque = 0;
      const brakeMax = w.front ? P.wheels.brakeForce.front : P.wheels.brakeForce.rear;
      if (this.gear === -1) {
        // reverse: W = accelerator (drives backwards, rpm-coupled like a real car),
        // S = brake. Soft-capped ~40km/h.
        const revCap = clamp(1 - Math.max(0, -fwdSpeed - 7) / 5, 0, 1);
        const revTractive = (engineTorque * gearRatio * 0.85 * revCap) / 2 / wheelRadius;
        if (!w.front) longForce = clamp(-revTractive, -8000, 8000);
        // idle creep in R when no pedal is touched (fades by ~11kmh backwards)
        if (!w.front && input.throttle < 0.05 && input.brake < 0.05 && fwdSpeed < 0.5 && fwdSpeed > -3) {
          longForce -= (P.transmission.torqueConverter.creepForceReverse / 2) * clamp(1 + fwdSpeed / 3, 0, 1);
        }
        brakeTorque = input.brake * brakeMax;
        // parking brake (auto P-gear): clamps all wheels until first throttle
        if (this.parkingBrake) brakeTorque = Math.max(brakeTorque, 3000);
      } else {
        // handbrake: full rear lock normally — BUT with throttle pinned it
        // becomes drift/burnout mode (TC stays off). Drag is strong at a
        // standstill so the car stays put for burnouts, and is freed up at
        // full lock so rolling donuts keep traveling.
        const hbLock = input.handbrake && !w.front;
        const lockF = Math.abs(input.steer);
        const hbDrag = (2600 - 1400 * lockF) - 800 * clamp(speedKmh / 15, 0, 1);
        const hbForce = hbLock ? (input.throttle > 0.5 ? hbDrag : P.wheels.handbrakeForce) : 0;
        brakeTorque = input.brake * brakeMax + hbForce;
        // parking brake (auto P-gear): clamps all wheels until first throttle
        if (this.parkingBrake) brakeTorque = Math.max(brakeTorque, 3000);
      }
      if (brakeTorque > 0) {
        // ABS: pulse when locking
        let b = brakeTorque / wheelRadius;
        // no overshoot jitter at crawl speeds: fade brake as wheel stops
        if (Math.abs(vLong) < 0.6) b *= Math.abs(vLong) / 0.6;
        const wheelLock = Math.abs(vLong) < 2 && input.brake > 0.7;
        if (P.assists.absEnabled && wheelLock && Math.abs(vLong) > 0.5) b *= 0.6 + 0.4 * Math.sin(this.simTime * 90);
        longForce += clamp(-Math.sign(vLong || 1) * b, -maxTire - 2000, maxTire + 2000);
        // at standstill, don't push car
        if (Math.abs(vLong) < 0.4 && this.gear >= 1) longForce = clamp(longForce, -4000, 4000);
      }

      // engine braking when coasting in gear (DRIVEN axle only): the engine's
      // internal friction drags back through the gearbox. Fades out below
      // converter-lockup speed (fluid coupling slips at crawl, like a real
      // automatic), so the car can creep instead of juddering to a halt.
      // High gears barely slow the car, low gears slow it strongly.
      if (!w.front && input.throttle < 0.05 && this.gear >= 1 && Math.abs(vLong) > 1) {
        const lockup = clamp((speedKmh - 10) / 15, 0, 1); // 0 below ~10kmh, 1 above ~25kmh
        const engFric = P.engine.frictionTorqueBase + this.rpm * P.engine.frictionTorqueRPMFactor;
        const coastT = (engFric * gearRatio * 0.85 * lockup) / 2 / wheelRadius;
        longForce += clamp(-Math.sign(vLong) * coastT, -2500, 2500);
      }
      // rolling resistance (tires + bearings): small, always present
      if (Math.abs(vLong) > 0.5) {
        longForce += -Math.sign(vLong) * 55;
      }
      this.lastWheelLong[wi] = longForce;

      // --- lateral grip (simplified pacejka) ---
      const latStiff = P.wheels.pacejka.lateral.B;
      let latForce = -vLat * latStiff * 520;
      // wider rear tires: rear grips more (like a real M3 stagger).
      // mild understeer bias up front keeps keyboard driving friendly.
      const maxLat = muPeak * capLoad * (input.handbrake && !w.front ? 0.35 : 1) * (w.front ? 0.92 : 1.15);
      // Friction ELLIPSE, not a subtraction.
      //
      // The old coupling was `maxLat - |longForce| * 0.85`, which went to
      // almost nothing whenever the rear was driving: on full throttle the
      // longitudinal force sat at the tire limit, leaving the rear axle ~26%
      // of its lateral capacity. Grip could therefore NEVER come back while
      // you were on the power — circle the car on full throttle and it stays
      // loose and refuses to answer the steering, which is exactly the
      // reported symptom. An ellipse with a floor keeps half the lateral
      // capacity available even at full longitudinal demand, so the car can
      // always be caught and pointed again.
      const latUse = clamp(Math.abs(longForce) / Math.max(1, maxTire), 0, 1);
      const latRoom = maxLat * clamp(Math.sqrt(Math.max(0, 1 - latUse * latUse * 0.7)), 0.5, 1);
      latForce = clamp(latForce, -latRoom, latRoom);
      // stability control: damp yaw when sliding
      if (P.assists.stabilityControl > 0 && Math.abs(vLat) > 4) {
        latForce *= 1 + P.assists.stabilityControl * 0.4;
        latForce = clamp(latForce, -maxLat * 1.2, maxLat * 1.2);
      }

      const F = s.fwd.clone().multiplyScalar(longForce).add(s.right.clone().multiplyScalar(latForce));
      // Apply horizontal tire forces halfway between contact patch and hub height.
      // (Real cars transmit tire forces through suspension geometry with anti-dive/
      // anti-squat; applying at ground level would give this rigid body violent
      // pitch moments. 0.5 keeps believable squat/dive without endos.)
      const applyY = s.contactY + (s.anchor.y - s.contactY) * 0.5;
      this.body.applyImpulseAtPoint({ x: F.x * dt, y: 0, z: F.z * dt }, { x: s.anchor.x, y: applyY, z: s.anchor.z }, true);
    }

    this.slipRatioAvg += ((groundedWheels > 0 ? totalSlip / 4 : 0) - this.slipRatioAvg) * Math.min(1, dt * 5);
    if (rearCount > 0) this.rearSlip = rearSlipSum / rearCount;
    // honest driven-axle spin for visuals: rolling speed + measured rear slip
    // (no phantom offset) — hooked tires track road speed exactly, spinning
    // tires visibly overspeed in exact proportion to their slip
    this.spinOmega = rollingOmega + (this.rearSlip * Math.max(3, Math.abs(fwdSpeed) + 3)) / wheelRadius;
    this.drifting = Math.abs(this.lateralVelocity()) > 4.5 && speedKmh > 40;

    // --- aero: drag + downforce ---
    const vVec = new THREE.Vector3(linvel.x, 0, linvel.z);
    const vMag = vVec.length();
    if (vMag > 0.5) {
      const dragF = 0.5 * P.aero.airDensity * P.aero.dragCoefficient * P.aero.frontalArea * vMag * vMag;
      const downF = (P.aero.downforceAt100kmh / Math.pow(27.78, 2)) * vMag * vMag;
      const drag = vVec.clone().normalize().multiplyScalar(-dragF);
      this.body.applyImpulse({ x: drag.x * dt, y: -downF * dt, z: drag.z * dt }, true);
    }

    // --- anti-roll bars + upright stabilization ---
    // (gains kept moderate so the car can squat under power and dive under brakes,
    // which produces natural longitudinal load transfer)
    const up = new THREE.Vector3(0, 1, 0).applyQuaternion(quat);
    const tilt = new THREE.Vector3().crossVectors(up, new THREE.Vector3(0, 1, 0));
    // roll correction torque (strong pitch damping to prevent stoppies at 300km/h braking)
    const angvel = this.body.angvel();
    this.body.applyTorqueImpulse(
      {
        x: (-tilt.x * 5500 - angvel.x * 2600) * dt,
        y: (-angvel.y * 1800) * dt,
        z: (-tilt.z * 5500 - angvel.z * 2600) * dt,
      },
      true
    );

    // ESC stability: always on, but RWD-flavored — moderate slides are ALLOWED
    // (deadzone while steering so powerslides and donuts survive), it only
    // steps in to catch big angles. Authority is strongest at LOW speed so
    // 1st/2nd/3rd-gear slides re-hook fast, easing off with speed.
    // The handbrake exempts it entirely (donuts/burnouts stay yours).
    // Full authority hands-off at any speed.
    // Gate used to be >8 m/s (29km/h), which meant a low-speed donut got NO
    // stability help at all — precisely the regime where the car refuses to
    // come back. Real ESC works at any speed.
    if (Math.abs(fwdSpeed) > 2.5 && groundedWheels >= 3 && !input.handbrake) {
      const steering = Math.abs(input.steer) >= 0.05;
      // Deadzone while steering was 6.9 degrees — WIDER than most usable
      // slides, so the assist simply switched itself off the moment you
      // needed it. Now it stays out of the way of small angles but engages
      // for anything past ~3.4 degrees of slip.
      const deadzone = steering ? 0.06 : 0.02;
      const betaExcess = Math.abs(beta) - deadzone;
      if (betaExcess > 0) {
        const speedF = clamp(Math.abs(fwdSpeed) / 33.3, 0, 1); // 0..120kmh
        // hand off to the throttle: less assist while power is on (so you can
        // hold a slide with throttle), full help the moment you lift
        const armed = this.launchArmed || this.launching;
        const powerOn = input.throttle > 0.15 && !armed;
        const authority = (steering ? lerp(0.9, 0.5, speedF) : 1) * (0.5 + P.assists.stabilityControl) *
          (powerOn ? 1.0 : 1.35);
        // plain opposing torque: bleeds the sideslip off
        let esc = -Math.sign(beta) * betaExcess * 6000 - angvel.y * 1500;
        // Countersteer assist. A real ESC does not just push against the
        // slide — it builds the yaw moment the driver ASKED for, by braking
        // individual wheels. Modelled as a yaw impulse that follows the steer
        // input, scaled by how far past the deadzone we already are. This is
        // what makes countersteer actually flick the car the other way
        // instead of only unwinding the angle slowly.
        //
        // ONLY when the steer input opposes the slide. Keying off steer
        // alone made the assist feed the slide it was supposed to be
        // catching, which spun the car on entry.
        const countersteering = Math.sign(input.steer) === -Math.sign(beta);
        const intent = countersteering
          ? input.steer * clamp(betaExcess / 0.1, 0, 1) * P.assists.countersteerAssist
          : 0;
        esc += intent;
        this.body.applyTorqueImpulse({ x: 0, y: clamp(esc * authority, -6000, 6000) * dt, z: 0 }, true);
      }
    }
    if (groundedWheels === 0) {
      this.body.applyTorqueImpulse({ x: -angvel.x * 300 * dt, y: 0, z: -angvel.z * 300 * dt }, true);
    }

    const gearLabel = this.gear === -1 ? 'R' : this.gear === 0 ? 'N' : String(this.gear);
    return {
      speedKmh: Math.abs(fwdSpeed) * 3.6 * Math.sign(fwdSpeed || 1),
      rpm: Math.round(this.rpm),
      gear: this.gear,
      gearLabel,
      autoMode: this.autoMode,
      throttle: input.throttle,
      brake: input.brake,
      steer: input.steer,
      shifting,
      launchArmed: this.launchArmed,
      launching: this.launching,
      parkingBrake: this.parkingBrake,
      slipRatio: this.slipRatioAvg,
      drift: this.drifting,
    };
  }

  private lateralVelocity(): number {
    const v = this.body.linvel();
    const q = this.body.rotation();
    const quat = new THREE.Quaternion(q.x, q.y, q.z, q.w);
    const right = new THREE.Vector3(1, 0, 0).applyQuaternion(quat);
    return v.x * right.x + v.z * right.z;
  }

  private predictedRpm(gear: Gear): number {
    // rpm the engine WOULD have in `gear` at the current wheel speed —
    // used to refuse downshifts that would over-rev past redline
    if (gear <= 0) return 0;
    const P = CAR_PHYSICS;
    const ratio = P.transmission.gearRatios[gear - 1] * P.transmission.finalDriveRatio;
    return Math.abs(this.wheelOmega * ratio * 60 / (2 * Math.PI));
  }

  private manualShift(dir: 1 | -1) {
    if (this.shiftTimer > 0) return;
    // sequence: R(-1) <-> N(0) <-> 1..8
    const order: Gear[] = [-1, 0, 1, 2, 3, 4, 5, 6, 7, 8];
    const i = order.indexOf(this.gear);
    const j = clamp(i + dir, 0, order.length - 1);
    if (j === i) return;
    // prevent R engagement at speed
    if (order[j] === -1 && Math.abs(this.forwardSpeed) > 3) return;
    // prevent 1st engagement at very high speed
    if (order[j] >= 1 && this.gear === 0 && Math.abs(this.forwardSpeed) > 60) return;
    // refuse any downshift that would spin past redline in the target gear
    if (order[j] >= 1 && dir < 0 && this.predictedRpm(order[j]) > CAR_PHYSICS.engine.redlineRPM - 200) return;
    this.gear = order[j];
    this.shiftTimer = CAR_PHYSICS.transmission.shiftTimeManual;
    this.afterShift();
  }

  private doShift(dir: 1 | -1) {
    const next = clamp((this.gear as number) + dir, 1, 8) as Gear;
    if (next === this.gear) return;
    // auto box also respects per-gear speeds: no downshift into over-rev
    if (dir < 0 && this.predictedRpm(next) > CAR_PHYSICS.engine.redlineRPM - 200) return;
    this.gear = next;
    this.shiftTimer = CAR_PHYSICS.transmission.shiftTimeAuto;
    this.afterShift();
  }

  private afterShift() {
    // drop rpm to match new gear (power cut feel)
    const P = CAR_PHYSICS;
    if (this.gear === 0 || this.gear === -1) return;
    const ratio = P.transmission.gearRatios[this.gear - 1] * P.transmission.finalDriveRatio;
    const coupled = Math.abs(this.wheelOmega * ratio * 60 / (2 * Math.PI));
    this.rpm = clamp(coupled, P.engine.idleRPM, P.engine.redlineRPM - 400);
  }
}