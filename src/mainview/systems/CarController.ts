/**
 * Simcade RWD vehicle controller on a single Rapier dynamic body.
 *
 * Architecture:
 * - stepPhysics(h, input) advances the car by EXACTLY h=1/120s. The render
 *   loop owns an accumulator and calls stepVehicle() (PhysicsSystem), so
 *   behaviour never depends on render FPS. Render uses interpolated transforms.
 * - Per-wheel state: suspension disp/vel, wheel omega, brake pressure, slip,
 *   Pacejka forces, camber, Ackermann steer. No axle averaging anywhere.
 * - Engine RPM is integrated from net torque (flywheel inertia). Wheels are
 *   integrated inertias. Torque flows engine -> converter -> gearbox ->
 *   LSD -> wheels -> contact patch. Wheelspin/brake-lock emerge.
 * - Weight transfer emerges from rigid-body pitch/roll driven by tire forces
 *   applied at the contact patch + per-corner suspension. Only small numerical
 *   damping remains (see simulation.*); no stability torques.
 * - Assists (ABS/TC/ESC/countersteer) act only on pressures/torque requests.
 */
import * as RAPIER from '@dimforge/rapier3d-compat';
import * as THREE from 'three';
import { CAR_PHYSICS, G, staticCornerLoads } from '../constants/physics';
import type { DriveInput } from './InputManager';
import {
  evalTire, frontTireParams, rearTireParams, slipAngle, slipRatio,
  rollingResistance, type PacejkaParams, type TireOutput,
} from './vehicle/tire';
import {
  evalSuspension, evalAntiRollBar, frontSuspConfig, rearSuspConfig,
  type CornerSuspConfig, type SuspForce,
} from './vehicle/suspension';
import {
  engineFriction, engineTorqueAvailable, totalRatio,
  shiftTorqueFactor, evalLsd, omegaToRpm, rpmToOmega,
} from './vehicle/drivetrain';
import { AbsController, TractionController, EscController } from './vehicle/assists';
import { evalAero, type AeroForces } from './vehicle/aero';
import { roadFrame, roadLateral, terrainHeight, type RoadFrame } from './road';

export type Gear = -1 | 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;

export interface WheelDebug {
  grounded: boolean;
  normalLoad: number;
  slipRatio: number;
  slipAngle: number;
  longitudinalForce: number;
  lateralForce: number;
  suspensionCompression: number;
  suspensionVelocity: number;
  wheelOmega: number;
  wheelSpeed: number;
  brakeTorque: number;
  driveTorque: number;
  camber: number;
  steerAngle: number;
}

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
  // extended physical telemetry
  yawRate: number;
  latAccelG: number;
  longAccelG: number;
  engineTorque: number;
  frontAxleLoad: number;
  rearAxleLoad: number;
  downforceFront: number;
  downforceRear: number;
  drag: number;
  tcCut: number;
  escActive: boolean;
  converterSlip: number;
  clutch: number;
  wheels: WheelDebug[];
}

function clamp(v: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, v));
}

// Wheel indices: 0 FL, 1 FR, 2 RL, 3 RR
const FL = 0, FR = 1, RL = 2, RR = 3;

interface WheelLocal {
  x: number;
  z: number;
  front: boolean;
  left: boolean;
}

const WHEEL_LOCAL: WheelLocal[] = [
  { x: -0.76, z: -1.51, front: true, left: true },
  { x: 0.76, z: -1.51, front: true, left: false },
  { x: -0.76, z: 1.31, front: false, left: true },
  { x: 0.76, z: 1.31, front: false, left: false },
];

const H = CAR_PHYSICS.simulation.fixedDt;
const ROAD_HALF = 6; // WORLD_CONFIG.road.width / 2 (kept local: no UI dep in physics)

export class CarController {
  body: RAPIER.RigidBody;
  world: RAPIER.World;
  R: typeof RAPIER;

  // gearbox / engine state
  gear: Gear = 1;
  autoMode = true;
  rpm: number = CAR_PHYSICS.engine.idleRPM;
  engineTorque = 0;
  throttleState = 0;
  brakeState = 0;
  clutchEngagement = 1;
  converterLocked = false;
  converterSR = 0;
  private shiftTimer = 0;
  private shiftDuration = 0.2;
  private autoCooldown = 0;
  private limiterCut = false;
  private launchTimer = 0;
  launchEnabled = true;
  launching = false;
  launchArmed = false;
  parkingBrake = true;

  // steering state (average road-wheel angle)
  steerAngle = 0;
  wheelSteer = [0, 0, 0, 0];

  // per-wheel dynamic state
  wheelOmega = [0, 0, 0, 0];
  wheelCamber = [0, 0, 0, 0];
  suspDisp = [0, 0, 0, 0];
  suspVelW = [0, 0, 0, 0];
  /** Debug patch velocities (m/s). */
  dbgVLong = [0, 0, 0, 0];
  dbgVLat = [0, 0, 0, 0];
  /** Relaxed (carcass) slip states — physical tire lag, also stabilizes the
   *  stiff wheel/tire coupling at 120 Hz. */
  kappaR = [0, 0, 0, 0];
  alphaR = [0, 0, 0, 0];
  /** Low-passed normal load per wheel (tire sidewall compliance). */
  fzSmooth = [0, 0, 0, 0];
  lastWheelLoad = [0, 0, 0, 0];
  lastWheelLong = [0, 0, 0, 0];
  lastWheelLat = [0, 0, 0, 0];
  wheelSlip = [0, 0, 0, 0];
  wheelAlpha = [0, 0, 0, 0];
  wheelGrounded = [false, false, false, false];
  driveTorqueW = [0, 0, 0, 0];
  brakeTorqueW = [0, 0, 0, 0];

  slipRatioAvg = 0;
  rearSlip = 0;
  spinOmega = 0;
  drifting = false;
  frontAxleLoad = 0;
  rearAxleLoad = 0;

  // interpolation snapshots (render reads between physics states)
  private prevPos = { x: 0, y: 0.72, z: 0 };
  private prevQuat = { x: 0, y: 0, z: 0, w: 1 };
  private currPos = { x: 0, y: 0.72, z: 0 };
  private currQuat = { x: 0, y: 0, z: 0, w: 1 };

  private simTime = 0;
  private abs = new AbsController();
  private tc = new TractionController();
  private esc = new EscController();
  private aeroOut: AeroForces = { drag: 0, frontDown: 0, rearDown: 0 };
  private escActiveFlag = false;

  // scratch (no per-step allocation)
  private _tireOut: TireOutput = { fx: 0, fy: 0, mz: 0, muEff: 0, combined: 0 };
  private _suspOut: SuspForce = { spring: 0, damper: 0, bumpStop: 0, total: 0, toppedOut: false, onBumpStop: false };
  private _frontTire: PacejkaParams = frontTireParams();
  private _rearTire: PacejkaParams = rearTireParams();
  private _frontSusp: CornerSuspConfig = frontSuspConfig();
  private _rearSusp: CornerSuspConfig = rearSuspConfig();
  private _springPreload = [0, 0, 0, 0];
  private _q = new THREE.Quaternion();
  private _v = new THREE.Vector3();
  private _w = new THREE.Vector3();
  private _p = new THREE.Vector3();
  private _prevVel = new THREE.Vector3();
  private _prevVelInit = false;
  private tcCutValue = 0;
  latAccelG = 0;
  longAccelG = 0;

  constructor(world: RAPIER.World, body: RAPIER.RigidBody, R: typeof RAPIER) {
    this.world = world;
    this.body = body;
    this.R = R;
    this.body.setLinearDamping(0.005);
    this.body.setAngularDamping(0.05);
    // Corner-balance the springs: preload each corner to its static share of
    // the weight so the car spawns in equilibrium (no pitch/roll seed torque).
    // Ride height then emerges; dampers/ARB handle everything dynamic.
    const stat = staticCornerLoads();
    for (let i = 0; i < 4; i++) {
      this._springPreload[i] = stat[i];
      this.fzSmooth[i] = stat[i];
    }
    this.snapshotCurr();
    this.snapshotPrev();
  }

  reset(pos: THREE.Vector3, yaw = 0) {
    this.body.setTranslation({ x: pos.x, y: pos.y, z: pos.z }, true);
    const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, yaw, 0));
    this.body.setRotation({ x: q.x, y: q.y, z: q.z, w: q.w }, true);
    this.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
    this.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
    this.gear = 1;
    this.rpm = CAR_PHYSICS.engine.idleRPM;
    this.engineTorque = 0;
    this.throttleState = 0;
    this.brakeState = 0;
    this.shiftTimer = 0;
    this.autoCooldown = 0;
    this.clutchEngagement = 1;
    this.converterLocked = false;
    this.wheelOmega = [0, 0, 0, 0];
    this.suspDisp = [0, 0, 0, 0];
    this.suspVelW = [0, 0, 0, 0];
    this.kappaR = [0, 0, 0, 0];
    this.alphaR = [0, 0, 0, 0];
    this.tcCutValue = 0;
    this._prevVelInit = false;
    this.parkingBrake = true;
    this.launchTimer = 0;
    this.limiterCut = false;
    this.steerAngle = 0;
    this.wheelSteer = [0, 0, 0, 0];
    this.slipRatioAvg = 0;
    this.rearSlip = 0;
    this.abs.reset();
    this.tc.reset();
    this.esc.reset();
    this.snapshotCurr();
    this.snapshotPrev();
  }

  get forwardSpeed(): number {
    const v = this.body.linvel();
    const q = this.body.rotation();
    this._q.set(q.x, q.y, q.z, q.w);
    this._v.set(0, 0, -1).applyQuaternion(this._q);
    return v.x * this._v.x + v.y * this._v.y + v.z * this._v.z;
  }

  // ------------------------------------------------------- fixed-step API ---
  snapshotPrev() {
    const t = this.body.translation();
    const r = this.body.rotation();
    this.prevPos = { x: t.x, y: t.y, z: t.z };
    this.prevQuat = { x: r.x, y: r.y, z: r.z, w: r.w };
  }

  snapshotCurr() {
    const t = this.body.translation();
    const r = this.body.rotation();
    this.currPos = { x: t.x, y: t.y, z: t.z };
    this.currQuat = { x: r.x, y: r.y, z: r.z, w: r.w };
  }

  /** Interpolated render transform. alpha=0 -> prev, 1 -> curr. */
  getRenderTransform(alpha: number, outPos: THREE.Vector3, outQuat: THREE.Quaternion) {
    const a = clamp(alpha, 0, 1);
    outPos.set(
      this.prevPos.x + (this.currPos.x - this.prevPos.x) * a,
      this.prevPos.y + (this.currPos.y - this.prevPos.y) * a,
      this.prevPos.z + (this.currPos.z - this.prevPos.z) * a,
    );
    const qa = new THREE.Quaternion(this.prevQuat.x, this.prevQuat.y, this.prevQuat.z, this.prevQuat.w);
    const qb = new THREE.Quaternion(this.currQuat.x, this.currQuat.y, this.currQuat.z, this.currQuat.w);
    outQuat.copy(qa.slerp(qb, a));
  }

  /**
   * Legacy frame-rate-dependent entry (kept for compat). Subdivides dt into
   * fixed 120 Hz substeps internally so behaviour matches stepPhysics.
   */
  update(dt: number, input: DriveInput): CarTelemetry {
    const steps = Math.max(1, Math.min(4, Math.round(dt / H)));
    const h = dt / steps;
    let tele: CarTelemetry = this.buildTelemetry(input);
    for (let i = 0; i < steps; i++) {
      this.snapshotPrev();
      this.stepPhysics(h, input);
      this.world.step();
      this.snapshotCurr();
      if (i === steps - 1) tele = this.buildTelemetry(input);
    }
    return tele;
  }

  /** Advance the vehicle by exactly h seconds (h should be 1/120). */
  stepPhysics(h: number, input: DriveInput) {
    const P = CAR_PHYSICS;
    this.simTime += h;

    if (input.toggleModePressed) this.autoMode = !this.autoMode;
    if (input.toggleLaunchPressed) this.launchEnabled = !this.launchEnabled;
    if (this.shiftTimer > 0) this.shiftTimer -= h;

    // smoothed pedals (SI boundary: 0..1 ratios)
    this.throttleState += clamp(input.throttle - this.throttleState, -h * 6, h * 6);
    this.brakeState += clamp(input.brake - this.brakeState, -h * 8, h * 8);
    const throttle = this.throttleState;
    const brake = this.brakeState;

    if (!this.autoMode) {
      if (input.upshiftPressed) this.manualShift(1);
      if (input.downshiftPressed) this.manualShift(-1);
    }
    if (input.throttle > 0.3) this.parkingBrake = false;

    const linvel = this.body.linvel();
    const angvel = this.body.angvel();
    const rot = this.body.rotation();
    const quat = this._q.set(rot.x, rot.y, rot.z, rot.w);
    const pos = this.body.translation();
    this._p.set(pos.x, pos.y, pos.z);
    this._v.set(linvel.x, linvel.y, linvel.z);
    this._w.set(angvel.x, angvel.y, angvel.z);

    const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(quat);
    const fwdSpeed = this._v.x * fwd.x + this._v.y * fwd.y + this._v.z * fwd.z;
    const speedKmh = Math.abs(fwdSpeed) * 3.6;

    // ------------------------------------------------------------ steering ---
    const ST = P.steering;
    const speedRef = ST.speedRefKmh / 3.6;
    const maxRoadAngle: number = ST.maxRoadAngle;
    // Speed-sensitive ratio: same rack travel asks for less road angle at speed.
    // This is a RATIO change (like a real variable-ratio rack), never a
    // grip-based cap — the driver can always saturate the front tires.
    const rackTarget = clamp(
      (input.steer * maxRoadAngle) / (1 + ST.speedGain * (fwdSpeed / speedRef) ** 2),
      -maxRoadAngle, maxRoadAngle,
    );
    // shaft dynamics: rate limit; aligning torque adds a small centering pull
    const rate = ST.maxSpeed * h;
    this.steerAngle += clamp(rackTarget - this.steerAngle, -rate, rate);
    this.applyAckermann();

    // -------------------------------------------------- launch / gear logic ---
    const atStandstill = Math.abs(fwdSpeed) < 1.2;
    this.launchArmed =
      this.launchEnabled && atStandstill && this.gear === 1 && throttle > 0.7 && brake > 0.2;
    if (this.launchArmed) this.launchTimer = 2.0;
    else this.launchTimer = Math.max(0, this.launchTimer - h);
    this.launching = !this.launchArmed && this.launchTimer > 0 && !atStandstill && throttle > 0.7;

    if (this.autoCooldown > 0) this.autoCooldown -= h;
    if (this.autoMode && this.shiftTimer <= 0 && this.autoCooldown <= 0 && this.gear >= 1) {
      if (throttle > 0.25 && this.rpm > P.transmission.autoUpshiftRPM && this.gear < 8) {
        this.doShift(1);
      } else if (throttle > 0.9 && this.rpm < P.transmission.kickdownRPM && this.gear > 1) {
        // kickdown, respecting over-rev
        const cand = (this.gear - 1) as Gear;
        if (this.predictedRpm(cand) < P.engine.redlineRPM - 200) this.doShift(-1);
      } else if (this.rpm < P.transmission.autoDownshiftRPM && this.gear > 1 && speedKmh < 120) {
        const cand = (this.gear - 1) as Gear;
        if (this.predictedRpm(cand) < P.engine.redlineRPM - 200) this.doShift(-1);
      } else if (speedKmh < 5 && this.gear > 1) {
        this.doShift(-1);
      }
    }
    const shifting = this.shiftTimer > 0;

    // ---------------------------------------------------------------- engine ---
    const ENG = P.engine;
    // rev limiter with hysteresis
    if (this.rpm >= ENG.revLimiterRPM) this.limiterCut = true;
    else if (this.rpm < ENG.revLimiterRPM - 400) this.limiterCut = false;
    if (this.rpm > ENG.revLimiterRPM + 50) this.rpm = ENG.revLimiterRPM + 50;

    let throttleEff = throttle;
    if (this.limiterCut) throttleEff = 0;
    // launch control pins rpm via ignition cut at launch RPM
    if (this.launchArmed && this.rpm > P.transmission.launchControlRPM) throttleEff = 0;

    const avail = engineTorqueAvailable(this.rpm);
    const TeGross = throttleEff * avail + (this.rpm < ENG.idleRPM ? Math.min(220, (ENG.idleRPM - this.rpm) * 1.5) : 0);
    const TeFric = engineFriction(this.rpm) * (throttleEff > 0.02 ? 0.35 : 1);
    // Signed engine thrust: positive = driving, negative = engine braking.
    const TeDrive = TeGross - TeFric;

    // ------------------------------------------------- converter + gearbox ---
    // Turbine (gearbox input) spins ratio x FASTER than the wheels.
    const ratio = totalRatio(this.gear);
    const avgRearOmega = (this.wheelOmega[RL] + this.wheelOmega[RR]) / 2;
    const turbineOmega = this.gear === 0 ? 0 : Math.abs(avgRearOmega) * ratio;
    const pumpOmega = Math.max(1, rpmToOmega(this.rpm));

    // lockup clutch (gears >= 3, settled, enough turbine speed)
    const turbineRpm = omegaToRpm(turbineOmega);
    const wantLock =
      this.gear >= 3 && !shifting && !this.launchArmed && turbineRpm > P.transmission.torqueConverter.lockupTurbineRPM;
    const wantUnlock = turbineRpm < P.transmission.torqueConverter.lockupTurbineRPM - 400;
    if (wantLock) this.converterLocked = true;
    else if (wantUnlock || shifting || this.gear < 3 || this.gear === -1 || this.gear === 0) this.converterLocked = false;

    // clutch engagement: open at launch staging, dip during shifts, dump on launch
    let engagement: number;
    if (this.launchArmed || this.gear === 0) engagement = 0;
    else if (this.launchTimer > 1.7 && !this.launchArmed && throttle > 0.7) {
      engagement = clamp((2.0 - this.launchTimer) / 0.3, 0.15, 1); // progressive dump
    } else if (shifting) {
      engagement = 0.15 + 0.85 * (1 - this.shiftTimer / Math.max(0.01, this.shiftDuration));
    } else engagement = 1;
    this.clutchEngagement = engagement;

    const TC = P.transmission.torqueConverter;
    const sr = clamp(turbineOmega / pumpOmega, -0.3, 1.2);
    this.converterSR = sr;
    let turbineTorque = 0;
    if (this.gear !== 0 && engagement > 0) {
      if (this.converterLocked) {
        // rigid lockup: engine speed IS turbine speed, torque passes through
        this.rpm += (turbineRpm - this.rpm) * Math.min(1, h * 12);
        turbineTorque = TeDrive;
      } else {
        // Unlocked converter: the fluid coupling transmits per its capacity
        // curve in BOTH directions. Forward: stall multiplication toward the
        // turbine. Overrun (turbine outruns pump): capacity goes negative and
        // the fluid drags the pump — engine braking without fuel, and the
        // engine flares if the wheels drive it. The engine integrates against
        // the same reaction (stall revs / overrun flare emerge, nothing set).
        const tr = 1 + (TC.stallMultiplication - 1) * clamp(1 - Math.max(0, sr) / TC.couplingPoint, 0, 1);
        const capK = 0.0043;
        const capacity = capK * pumpOmega * Math.max(pumpOmega - 0.85 * turbineOmega, -0.3 * pumpOmega);
        const reaction = capacity * engagement;
        turbineTorque = reaction * tr;
        const dW = (TeDrive - reaction) / ENG.inertia;
        this.rpm = Math.max(0, this.rpm + omegaToRpm(dW * h));
      }
      this.engineTorque = TeDrive;
    } else {
      // neutral / launch staging: free rev against own inertia + friction
      const dW = TeDrive / ENG.inertia;
      this.rpm = Math.max(0, this.rpm + omegaToRpm(dW * h));
      this.engineTorque = TeDrive;
    }

    // driveshaft -> differential -> axle shafts (RWD)
    const dirSign = this.gear === -1 ? -1 : 1;
    const shiftFactor = shifting ? shiftTorqueFactor(this.shiftTimer, this.shiftDuration) : 1;
    let axleTorque = 0;
    if (this.gear !== 0) {
      // (engagement already applied at the converter output above)
      axleTorque = turbineTorque * ratio * P.transmission.efficiency * shiftFactor * dirSign;
      // idle-speed-seeking creep: foot off both pedals, the converter feeds a
      // bounded axle torque toward walking pace (real ECU idle control).
      // Authority fades out above ~4 m/s so it never fights real driving.
      if (throttle < 0.05 && brake < 0.05 && !this.launchArmed) {
        const target = this.gear === -1 ? -TC.creepTargetMps : TC.creepTargetMps;
        const creepScale = clamp(1 - Math.abs(fwdSpeed) / 4, 0, 1);
        axleTorque += clamp(TC.creepGain * (target - fwdSpeed), -TC.creepMaxTorque, TC.creepMaxTorque) * creepScale;
      }
    }
    // TC torque governor. Slip measured against the UNDRIVEN front wheels
    // (true ground speed, robust mid-slide where patch slip lies).
    const frontRef = (Math.abs(this.wheelOmega[FL]) + Math.abs(this.wheelOmega[FR])) / 2 * P.tire.radius;
    const tcSlipL = (this.wheelOmega[RL] * P.tire.radius - Math.sign(this.wheelOmega[RL]) * frontRef) / Math.max(3, frontRef, Math.abs(fwdSpeed));
    const tcSlipR = (this.wheelOmega[RR] * P.tire.radius - Math.sign(this.wheelOmega[RR]) * frontRef) / Math.max(3, frontRef, Math.abs(fwdSpeed));
    const tcAuthority = (input.handbrake ? 0 : P.assists.tractionControl) * (this.launching ? 0.3 : 1);
    const tcMult = this.tc.update(tcSlipL, tcSlipR, tcAuthority, h);
    this.tcCutValue = 1 - tcMult;
    axleTorque *= tcMult;

    // ESC yaw-rate controller -> per-wheel brake add + engine cut
    const yawRate = this._w.y;
    const escOut = this.esc.update(fwdSpeed, this.steerAngle, yawRate, h);
    this.escActiveFlag = escOut.brakes.some((b) => b > 1) || escOut.engineCut > 0.01;
    axleTorque *= 1 - escOut.engineCut;

    const driving = axleTorque * dirSign > 5;
    const lsd = evalLsd(axleTorque, this.wheelOmega[RL], this.wheelOmega[RR], driving);
    this.driveTorqueW[RL] = lsd.leftTorque;
    this.driveTorqueW[RR] = lsd.rightTorque;
    this.driveTorqueW[FL] = 0;
    this.driveTorqueW[FR] = 0;

    // ---------------------------------------------------- per-wheel ground ---
    const bodyPos = this._p;
    const lin = this._v;
    const ang = this._w;
    let totalSlip = 0;
    let groundedCount = 0;
    this.frontAxleLoad = 0;
    this.rearAxleLoad = 0;

    // anti-roll state needs both sides: compute suspension first
    const suspF: number[] = [0, 0, 0, 0];
    const arbF: number[] = [0, 0, 0, 0];
    const grounded: boolean[] = [false, false, false, false];
    const gapInfo: { disp: number; vel: number; nx: number; ny: number; nz: number; surfY: number }[] = [];
    for (let i = 0; i < 4; i++) {
      gapInfo.push({ disp: 0, vel: 0, nx: 0, ny: 1, nz: 0, surfY: 0 });
    }

    for (let i = 0; i < 4; i++) {
      const wl = WHEEL_LOCAL[i];
      const lx = wl.x, lz = wl.z;
      // rotate hardpoint offset (lx, 0, lz) by body quat (y=0 local)
      const qx = quat.x, qy = quat.y, qz = quat.z, qw = quat.w;
      const rx = lx * (1 - 2 * (qy * qy + qz * qz)) + lz * 2 * (qx * qz + qw * qy);
      const ry = lx * 2 * (qx * qy + qw * qz) + lz * 2 * (qy * qz - qw * qx);
      const rz = lx * 2 * (qx * qz - qw * qy) + lz * (1 - 2 * (qx * qx + qy * qy));
      const anchorY = bodyPos.y + ry;

      // --- analytic ground: road surface near the road, terrain plane off-road
      const sWheel = -(bodyPos.z + rz);
      const frame: RoadFrame = roadFrame(sWheel);
      const lat = roadLateral(bodyPos.x + rx, bodyPos.z + rz);
      const roadness = clamp((ROAD_HALF + 2 - Math.abs(lat)) / 2, 0, 1);
      const roadY = frame.y + lat * Math.sin(frame.bank);
      // Off-road terrain hugs the road elevation (same function the visuals
      // use) so crossing the ribbon is an 8 cm curb, never a cliff.
      const terrY = terrainHeight(sWheel);
      const surfY = roadY * roadness + terrY * (1 - roadness);
      let nx = frame.normalX * roadness;
      let ny = frame.normalY * roadness + 1 * (1 - roadness);
      let nz = frame.normalZ * roadness;
      const nl = Math.hypot(nx, ny, nz) || 1;
      nx /= nl; ny /= nl; nz /= nl;

      // gap from hardpoint to surface, measured along the surface normal
      const gapAlongN = (anchorY - surfY) / Math.max(0.5, ny);

      const cfg = wl.front ? this._frontSusp : this._rearSusp;
      const preload = this._springPreload[i];
      // point velocity at anchor: v + w x r
      const pvx = lin.x + (ang.y * rz - ang.z * ry);
      const pvy = lin.y + (ang.z * rx - ang.x * rz);
      const pvz = lin.z + (ang.x * ry - ang.y * rx);
      const suspVel = -(pvx * nx + pvy * ny + pvz * nz);

      // compression + = bump, measured from static design ride height
      const disp = CAR_PHYSICS.geometry.rideHeight - gapAlongN;
      const sf = evalSuspension(cfg, preload, disp, suspVel, this._suspOut);
      suspF[i] = sf.total;
      // Tire contact needs the rubber near the surface; the suspension itself
      // keeps pulling on its straps past full droop (no force discontinuity).
      grounded[i] = gapAlongN < CAR_PHYSICS.geometry.rideHeight + CAR_PHYSICS.suspension.travelDroop + 0.05;
      gapInfo[i] = { disp, vel: suspVel, nx, ny, nz, surfY };
      this.suspDisp[i] = disp;
      this.suspVelW[i] = suspVel;
    }

    // anti-roll bars (equal/opposite per axle)
    const arbF0 = evalAntiRollBar(this._frontSusp.antiRollRate, gapInfo[FL].disp, gapInfo[FR].disp);
    arbF[FL] = arbF0[0]; arbF[FR] = arbF0[1];
    const arbR = evalAntiRollBar(this._rearSusp.antiRollRate, gapInfo[RL].disp, gapInfo[RR].disp);
    arbF[RL] = arbR[0]; arbF[RR] = arbR[1];
    for (let i = 0; i < 4; i++) {
      if (grounded[i]) suspF[i] = Math.max(0, suspF[i] + arbF[i]);
    }

    // apply suspension forces along the surface normal at each hardpoint
    // (straps included: a hanging wheel still pulls, no discontinuity)
    for (let i = 0; i < 4; i++) {
      if (suspF[i] === 0) continue;
      const wl = WHEEL_LOCAL[i];
      const lx = wl.x, lz = wl.z;
      const qx = quat.x, qy = quat.y, qz = quat.z, qw = quat.w;
      const rx = lx * (1 - 2 * (qy * qy + qz * qz)) + lz * 2 * (qx * qz + qw * qy);
      const rz = lx * 2 * (qx * qz - qw * qy) + lz * (1 - 2 * (qx * qx + qy * qy));
      const g = gapInfo[i];
      this.body.applyImpulseAtPoint(
        { x: g.nx * suspF[i] * h, y: g.ny * suspF[i] * h, z: g.nz * suspF[i] * h },
        { x: bodyPos.x + rx, y: bodyPos.y, z: bodyPos.z + rz },
        true,
      );
    }

    // ------------------------------------------------------- per-wheel tire ---
    for (let i = 0; i < 4; i++) {
      const wl = WHEEL_LOCAL[i];
      const g = gapInfo[i];
      if (!grounded[i]) {
        // airborne: spin freely toward drive/brake balance, no patch forces
        this.lastWheelLoad[i] = 0;
        this.lastWheelLong[i] = 0;
        this.lastWheelLat[i] = 0;
        this.wheelSlip[i] = 0;
        this.wheelAlpha[i] = 0;
        this.wheelGrounded[i] = false;
        const Iw = P.tire.spinInertia;
        const omegaFree = this.wheelOmega[i] + (this.driveTorqueW[i] * h) / Iw;
        const maxDv = (this.brakeTorqueW[i] * h) / Iw;
        this.wheelOmega[i] = Math.abs(omegaFree) <= maxDv
          ? 0
          : clamp(omegaFree - Math.sign(omegaFree) * maxDv, -260, 260);
        continue;
      }
      groundedCount++;

      // tire frame: forward yawed by steer around the surface normal
      const steer = this.wheelSteer[i];
      const cs = Math.cos(steer), sn = Math.sin(steer);
      // body forward/right flattened into the tangent plane
      let fx0 = fwd.x - g.nx * (fwd.x * g.nx + fwd.y * g.ny + fwd.z * g.nz);
      let fy0 = fwd.y - g.ny * (fwd.x * g.nx + fwd.y * g.ny + fwd.z * g.nz);
      let fz0 = fwd.z - g.nz * (fwd.x * g.nx + fwd.y * g.ny + fwd.z * g.nz);
      const fl = Math.hypot(fx0, fy0, fz0) || 1;
      fx0 /= fl; fy0 /= fl; fz0 /= fl;
      // yaw by steer around n: fwd_w = fwd*cos + (n x fwd)*sin
      const cx = g.ny * fz0 - g.nz * fy0;
      const cy = g.nz * fx0 - g.nx * fz0;
      const cz = g.nx * fy0 - g.ny * fx0;
      const wfx = fx0 * cs + cx * sn;
      const wfy = fy0 * cs + cy * sn;
      const wfz = fz0 * cs + cz * sn;
      // right = fwd x n... use n x fwd negated? right = cross(fwd_w, n)
      let wrx = wfy * g.nz - wfz * g.ny;
      let wry = wfz * g.nx - wfx * g.nz;
      let wrz = wfx * g.ny - wfy * g.nx;
      // cross(fwd,n) with fwd=-Z,n=+Y gives (-1,0,0) = LEFT; negate -> right
      wrx = -wrx; wry = -wry; wrz = -wrz;

      // contact patch: hardpoint projected down along n by the gap
      const lx = wl.x, lz = wl.z;
      const qx = quat.x, qy = quat.y, qz = quat.z, qw = quat.w;
      const rx = lx * (1 - 2 * (qy * qy + qz * qz)) + lz * 2 * (qx * qz + qw * qy);
      const ry = lx * 2 * (qx * qy + qw * qz) + lz * 2 * (qy * qz - qw * qx);
      const rz = lx * 2 * (qx * qz - qw * qy) + lz * (1 - 2 * (qx * qx + qy * qy));
      const anchorX = bodyPos.x + rx;
      const anchorY = bodyPos.y + ry;
      const anchorZ = bodyPos.z + rz;
      const gapAlongN = CAR_PHYSICS.geometry.rideHeight - gapInfo[i].disp;
      const cpx = anchorX - g.nx * gapAlongN;
      const cpy = anchorY - g.ny * gapAlongN;
      const cpz = anchorZ - g.nz * gapAlongN;
      // patch velocity = v + w x (cp - body)
      const dx = cpx - bodyPos.x, dy = cpy - bodyPos.y, dz = cpz - bodyPos.z;
      const cvx = lin.x + (ang.y * dz - ang.z * dy);
      const cvy = lin.y + (ang.z * dx - ang.x * dz);
      const cvz = lin.z + (ang.x * dy - ang.y * dx);
      const vLong = cvx * wfx + cvy * wfy + cvz * wfz;
      const vLat = cvx * wrx + cvy * wry + cvz * wrz;
      this.dbgVLong[i] = vLong;
      this.dbgVLat[i] = vLat;

      // camber from suspension travel. Mirrored per side: a symmetric static
      // setup must produce cancelling thrust left/right (both tops inboard),
      // and roll-induced camber stays anti-symmetric through the mirror.
      const camberRaw = (wl.front ? P.geometry.staticCamberFront : P.geometry.staticCamberRear) +
        gapInfo[i].disp * -P.geometry.camberGain;
      const camber = wl.left ? -camberRaw : camberRaw;
      this.wheelCamber[i] = camber;

      // --- brakes (per wheel, ABS-modulated) ---
      const brakeMax = wl.front ? P.brakes.frontTorque : P.brakes.rearTorque;
      let brakeDemand = brake * brakeMax;
      if (wl.front === false) {
        if (input.handbrake) brakeDemand = Math.max(brakeDemand, P.brakes.handbrakeTorque);
      }
      if (this.parkingBrake) brakeDemand = Math.max(brakeDemand, 6000);
      // ESC individual-wheel braking
      brakeDemand += escOut.brakes[i];
      const braking = brakeDemand > 20;
      // ABS watches last step's relaxed slip (honest carcass state, no lag tricks)
      const absMult = this.abs.updateWheel(i, braking ? this.wheelSlip[i] : 0, braking, h);
      const brakeTorque = brakeDemand * absMult;
      this.brakeTorqueW[i] = brakeTorque;

      // --- slip: lateral uses carcass relaxation, longitudinal is solved ---
      // Lateral (alphaR): transient Pacejka, rate = (V0 + |V|)/sigma. A parked
      // tire holds shear by deflection; at rolling speed response is instant.
      const rr = P.tire.radius;
      const denom = Math.max(3.0, Math.abs(vLong));
      const surf0 = this.wheelOmega[i] * rr;
      const surfAbs = Math.abs(surf0);
      const alpha0 = slipAngle(vLat, vLong);
      const kRate = Math.min(1, h * (1.4 + 2 * Math.max(Math.abs(vLong), surfAbs)));
      this.alphaR[i] += (alpha0 - this.alphaR[i]) * kRate;
      const alpha = this.alphaR[i];
      this.wheelAlpha[i] = alpha;

      // --- normal load (sidewall compliance low-pass) + tire params ---
      const fzRate = Math.min(1, h * 40);
      this.fzSmooth[i] += (suspF[i] - this.fzSmooth[i]) * fzRate;
      const fz = Math.max(0, this.fzSmooth[i]);
      const params = wl.front ? this._frontTire : this._rearTire;
      const e = 0.01;
      const fxAt = (k: number) => evalTire(params, { kappa: k, alpha, fz, camber }, this._tireOut).fx;
      const stiffAt = (k: number) => Math.max(0, (fxAt(k + e) - fxAt(k - e)) / (2 * e));

      // --- longitudinal: static lock first, Newton only if spinning ---
      // If the brake can hold the wheel against drive + contact force, the
      // wheel is EXACTLY locked (omega = 0) and transmits the dragged-skid
      // force evaluated at zero speed. Only a brake that cannot hold reaches
      // the Newton solver (spin/roll). This ordering is exact in both regimes
      // and never keeps a spinning candidate's force on a locked wheel.
      const Iw = P.tire.spinInertia;
      const aCoef = rr / denom;
      const bCoef = -vLong / denom;
      const drive = this.driveTorqueW[i];
      const omegaPrev = this.wheelOmega[i];
      const kkLocked = slipRatio(0, vLong);
      const FxLocked = fxAt(kkLocked);
      let om: number;
      let kk: number;
      let FxI: number;
      let SI: number;
      if (Math.abs(drive - FxLocked * rr) <= brakeTorque) {
        om = 0;
        kk = kkLocked;
        FxI = FxLocked;
        SI = stiffAt(kk);
      } else {
        om = omegaPrev;
        kk = slipRatio(om * rr, vLong);
        FxI = fxAt(kk);
        SI = stiffAt(kk);
        for (let it = 0; it < 3; it++) {
          // brake torque opposes rotation (explicit in the loop)
          const Tbr = om > 0 ? -brakeTorque : om < 0 ? brakeTorque : 0;
          const denI = 1 + (SI * aCoef * rr * h) / Iw;
          om = (omegaPrev + ((drive + Tbr - FxI * rr + SI * (kk - bCoef) * rr) * h) / Iw) / denI;
          kk = slipRatio(om * rr, vLong);
          FxI = fxAt(kk);
          SI = stiffAt(kk);
        }
        // brake cap applied without pushing past zero (no phantom reversal)
        const maxDv = (brakeTorque * h) / Iw;
        om = om > 0 ? Math.max(0, om - maxDv) : om < 0 ? Math.min(0, om + maxDv) : 0;
        kk = slipRatio(om * rr, vLong);
        FxI = fxAt(kk);
      }
      this.wheelOmega[i] = clamp(om, -260, 260);
      const kappa = kk;
      this.wheelSlip[i] = kappa;
      this.kappaR[i] = kappa;
      let Fx = FxI + rollingResistance(fz, vLong);
      const out = evalTire(params, { kappa, alpha, fz, camber }, this._tireOut);
      let Fy = -out.fy; // restoring force opposes slip
      // A locked tire sheds lateral grip (kappa -> -1). The combined-slip model
      // already reduces it; deep lock sheds further toward a sliding value.
      if (!wl.front && kappa < -0.6) {
        Fy *= clamp(1 - (Math.abs(kappa) - 0.6) * 1.2, 0.25, 1);
      }
      // Static vs kinetic friction regimes. A NON-ROLLING wheel in slow
      // contact (|surf| < 1 m/s and |vLong| < 2 m/s) is in STICTION: it can
      // only push as hard as the torques on it allow (drive + hub static
      // capacity), capped by the tire budget. A sliding or rolling contact
      // follows the full curve (kinetic friction needs no torque path).
      const surfNow = Math.abs(this.wheelOmega[i]) * rr;
      if (surfNow < 1.0 && Math.abs(vLong) < 2.0) {
        const budgetNow = out.muEff * fz;
        const staticCap = Math.min(budgetNow, (Math.abs(drive) + 1500) / rr);
        Fx = clamp(Fx, -staticCap, staticCap);
      }

      this.lastWheelLong[i] = Fx;
      this.lastWheelLat[i] = Fy;
      this.lastWheelLoad[i] = fz;
      this.wheelGrounded[i] = true;

      // force application point: tire forces at the contact patch, with
      // anti-dive / anti-squat moving part of the LONGITUDINAL path to the hub.
      // (Full ground-level application overstates pitch on a rigid body.)
      const anti = wl.front ? P.geometry.antiDive : P.geometry.antiSquat;
      const appY = cpy + (anchorY - cpy) * anti;
      const appx = cpx + (anchorX - cpx) * anti * 0.5;
      const appz = cpz + (anchorZ - cpz) * anti * 0.5;
      const Fxx = wfx * Fx + wrx * Fy;
      const Fyy = wfy * Fx + wry * Fy;
      const Fzz = wfz * Fx + wrz * Fy;
      this.body.applyImpulseAtPoint(
        { x: Fxx * h, y: Fyy * h, z: Fzz * h },
        { x: appx, y: appY, z: appz },
        true,
      );

      totalSlip += Math.abs(kappa);
    }

    // aero: drag at body, downforce split per axle (pitch moment is real)
    const rideH = pos.y;
    evalAero(fwdSpeed, rideH, this.aeroOut);
    {
      const A = this.aeroOut;
      const dragX = -fwd.x * A.drag, dragZ = -fwd.z * A.drag;
      this.body.applyImpulse({ x: dragX * h, y: 0, z: dragZ * h }, true);
      const qx = quat.x, qy = quat.y, qz = quat.z, qw = quat.w;
      const app = (lz: number, f: number) => {
        const rx = lz * 2 * (qx * qz + qw * qy);
        const rz = lz * (1 - 2 * (qx * qx + qy * qy));
        this.body.applyImpulseAtPoint(
          { x: 0, y: -f * h, z: 0 },
          { x: bodyPos.x + rx, y: bodyPos.y, z: bodyPos.z + rz },
          true,
        );
      };
      app(WHEEL_LOCAL[0].z, A.frontDown);
      app(WHEEL_LOCAL[2].z, A.rearDown);
      // aero load also presses the tires (adds to Fz for telemetry/grip)
      const perF = A.frontDown / 2, perR = A.rearDown / 2;
      this.lastWheelLoad[FL] += perF; this.lastWheelLoad[FR] += perF;
      this.lastWheelLoad[RL] += perR; this.lastWheelLoad[RR] += perR;
    }

    // track loads + slip telemetry
    this.frontAxleLoad = this.lastWheelLoad[FL] + this.lastWheelLoad[FR];
    this.rearAxleLoad = this.lastWheelLoad[RL] + this.lastWheelLoad[RR];
    this.slipRatioAvg += ((groundedCount > 0 ? totalSlip / 4 : 0) - this.slipRatioAvg) * Math.min(1, h * 5);
    this.rearSlip = (this.wheelSlip[RL] + this.wheelSlip[RR]) / 2;
    const rollingOmega = fwdSpeed / P.tire.radius;
    this.spinOmega = rollingOmega + (this.rearSlip * Math.max(3, Math.abs(fwdSpeed) + 3)) / P.tire.radius;

    // tiny numerical damping (NOT stability control — magnitudes ~1% of old)
    const upX = 2 * (quat.x * quat.z + quat.w * quat.y);
    const upY = 1 - 2 * (quat.x * quat.x + quat.y * quat.y);
    void upX; void upY;
    const av = this.body.angvel();
    const S = P.simulation;
    this.body.applyTorqueImpulse(
      { x: -av.x * S.numericalPitchDamping * h, y: -av.y * S.numericalYawDamping * h, z: -av.z * S.numericalRollDamping * h },
      true,
    );

    // weak optional countersteer help (assist, off by default path to zero)
    this.applyCountersteerAssist(input, fwdSpeed, h);

    // drift flag: sustained rear saturation + lateral motion
    const latV = Math.abs(this.lateralVelocity());
    this.drifting = latV > 4.5 && speedKmh > 40;

    // acceleration telemetry: finite difference of body velocity in body frame
    {
      const nv = this.body.linvel();
      if (this._prevVelInit) {
        const ax = (nv.x - this._prevVel.x) / h;
        const ay = (nv.y - this._prevVel.y) / h;
        const az = (nv.z - this._prevVel.z) / h;
        const right = new THREE.Vector3(1, 0, 0).applyQuaternion(quat);
        this.longAccelG = (ax * fwd.x + az * fwd.z) / G;
        this.latAccelG = (ax * right.x + az * right.z) / G;
        void ay;
      } else {
        this._prevVelInit = true;
      }
      this._prevVel.set(nv.x, nv.y, nv.z);
    }
  }

  private applyCountersteerAssist(input: DriveInput, fwdSpeed: number, h: number) {
    const P = CAR_PHYSICS;
    if (P.assists.countersteerAssist <= 0 || P.assists.stabilityControl <= 0) return;
    if (Math.abs(fwdSpeed) < 2.5 || input.handbrake) return;
    const rot = this.body.rotation();
    const quat = new THREE.Quaternion(rot.x, rot.y, rot.z, rot.w);
    const right = new THREE.Vector3(1, 0, 0).applyQuaternion(quat);
    const v = this.body.linvel();
    const latV = v.x * right.x + v.z * right.z;
    const beta = clamp(latV / Math.max(10, Math.abs(fwdSpeed)), -0.4, 0.4);
    const steering = Math.abs(input.steer) >= 0.05;
    const deadzone = steering ? 0.06 : 0.02;
    const excess = Math.abs(beta) - deadzone;
    if (excess <= 0) return;
    const countersteering = Math.sign(input.steer) === -Math.sign(beta);
    if (!countersteering) return;
    const intent = input.steer * clamp(excess / 0.1, 0, 1) * P.assists.countersteerAssist;
    this.body.applyTorqueImpulse({ x: 0, y: clamp(intent, -1500, 1500) * h, z: 0 }, true);
  }

  private applyAckermann() {
    const P = CAR_PHYSICS;
    const d = this.steerAngle;
    if (Math.abs(d) < 1e-5) {
      this.wheelSteer = [0, 0, 0, 0];
      return;
    }
    const wb = P.geometry.wheelbase;
    const track = P.geometry.trackWidth;
    const R = wb / Math.tan(Math.abs(d));
    const inner = Math.atan(wb / Math.max(0.5, R - track / 2));
    const outer = Math.atan(wb / Math.max(0.5, R + track / 2));
    const blend = P.steering.ackermann;
    const par = Math.abs(d);
    const inA = inner * blend + par * (1 - blend);
    const outA = outer * blend + par * (1 - blend);
    const s = Math.sign(d);
    // left positive steer = turning left = left wheels inner
    this.wheelSteer[FL] = s > 0 ? inA * s : outA * s;
    this.wheelSteer[FR] = s > 0 ? outA * s : inA * s;
    this.wheelSteer[RL] = 0;
    this.wheelSteer[RR] = 0;
  }

  private lateralVelocity(): number {
    const v = this.body.linvel();
    const q = this.body.rotation();
    const quat = new THREE.Quaternion(q.x, q.y, q.z, q.w);
    const right = new THREE.Vector3(1, 0, 0).applyQuaternion(quat);
    return v.x * right.x + v.z * right.z;
  }

  private predictedRpm(gear: Gear): number {
    // rpm the engine WOULD have in `gear` at current road speed (locked-clutch
    // reference) — used to refuse downshifts that would over-rev.
    if (gear <= 0) return 0;
    const ratio = totalRatio(gear);
    const wheelOmega = this.forwardSpeed / CAR_PHYSICS.tire.radius;
    return Math.abs(omegaToRpm(wheelOmega * ratio));
  }

  private manualShift(dir: 1 | -1) {
    if (this.shiftTimer > 0) return;
    const order: Gear[] = [-1, 0, 1, 2, 3, 4, 5, 6, 7, 8];
    const i = order.indexOf(this.gear);
    const j = clamp(i + dir, 0, order.length - 1);
    if (j === i) return;
    if (order[j] === -1 && Math.abs(this.forwardSpeed) > 3) return;
    if (order[j] >= 1 && dir < 0 && this.predictedRpm(order[j]) > CAR_PHYSICS.engine.redlineRPM - 200) return;
    this.gear = order[j];
    this.beginShift(true);
  }

  private doShift(dir: 1 | -1) {
    const next = clamp((this.gear as number) + dir, 1, 8) as Gear;
    if (next === this.gear) return;
    if (dir < 0 && this.predictedRpm(next) > CAR_PHYSICS.engine.redlineRPM - 200) return;
    this.gear = next;
    this.beginShift(false);
  }

  private beginShift(manual: boolean) {
    this.shiftDuration = manual ? CAR_PHYSICS.transmission.shiftTimeManual : CAR_PHYSICS.transmission.shiftTimeAuto;
    this.shiftTimer = this.shiftDuration;
    if (!manual) this.autoCooldown = 0.8;
  }

  /** Public telemetry snapshot (render loop reads this, never mutates physics). */
  buildTelemetryPublic(input: DriveInput): CarTelemetry {
    return this.buildTelemetry(input);
  }

  private buildTelemetry(input: DriveInput): CarTelemetry {
    const fwdSpeed = this.forwardSpeed;
    const gearLabel = this.gear === -1 ? 'R' : this.gear === 0 ? 'N' : String(this.gear);
    const wheels: WheelDebug[] = [];
    for (let i = 0; i < 4; i++) {
      wheels.push({
        grounded: this.wheelGrounded[i],
        normalLoad: this.lastWheelLoad[i],
        slipRatio: this.wheelSlip[i],
        slipAngle: this.wheelAlpha[i],
        longitudinalForce: this.lastWheelLong[i],
        lateralForce: this.lastWheelLat[i],
        suspensionCompression: this.suspDisp[i],
        suspensionVelocity: this.suspVelW[i],
        wheelOmega: this.wheelOmega[i],
        wheelSpeed: this.wheelOmega[i] * CAR_PHYSICS.tire.radius,
        brakeTorque: this.brakeTorqueW[i],
        driveTorque: this.driveTorqueW[i],
        camber: this.wheelCamber[i],
        steerAngle: this.wheelSteer[i],
      });
    }
    const av = this.body.angvel();
    return {
      speedKmh: Math.abs(fwdSpeed) * 3.6 * Math.sign(fwdSpeed || 1),
      rpm: Math.round(this.rpm),
      gear: this.gear,
      gearLabel,
      autoMode: this.autoMode,
      throttle: input.throttle,
      brake: input.brake,
      steer: input.steer,
      shifting: this.shiftTimer > 0,
      launchArmed: this.launchArmed,
      launching: this.launching,
      parkingBrake: this.parkingBrake,
      slipRatio: this.slipRatioAvg,
      drift: this.drifting,
      yawRate: av.y,
      latAccelG: this.latAccelG,
      longAccelG: this.longAccelG,
      engineTorque: this.engineTorque,
      frontAxleLoad: this.frontAxleLoad,
      rearAxleLoad: this.rearAxleLoad,
      downforceFront: this.aeroOut.frontDown,
      downforceRear: this.aeroOut.rearDown,
      drag: this.aeroOut.drag,
      tcCut: this.tcCutValue,
      escActive: this.escActiveFlag,
      converterSlip: 1 - clamp(this.converterSR, 0, 1),
      clutch: this.clutchEngagement,
      wheels,
    };
  }
}
