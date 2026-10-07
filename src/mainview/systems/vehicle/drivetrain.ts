/**
 * Drivetrain: engine (torque curve + flywheel inertia + friction),
 * torque converter (pump/turbine hydraulics + lockup + creep), clutch,
 * gearbox (ratios, shift interruption, kickdown, hysteresis), LSD.
 *
 * Engine RPM is a STATE integrated from net torque — never kinematically set.
 *   I_eng * dω = T_engine(throttle,ω) − T_friction(ω) − T_load/clutch
 */
import { CAR_PHYSICS } from '../../constants/physics';

export function torqueCurveMult(rpm: number): number {
  const curve = CAR_PHYSICS.engine.torqueCurve;
  if (rpm <= curve[0].rpm) return curve[0].mult;
  for (let i = 1; i < curve.length; i++) {
    if (rpm <= curve[i].rpm) {
      const a = curve[i - 1], b = curve[i];
      const t = (rpm - a.rpm) / Math.max(1, b.rpm - a.rpm);
      return a.mult + (b.mult - a.mult) * t;
    }
  }
  return 0;
}

/** Engine friction torque (Nm) at rpm — also the source of engine braking. */
export function engineFriction(rpm: number): number {
  return CAR_PHYSICS.engine.frictionBase + rpm * CAR_PHYSICS.engine.frictionPerRpm;
}

/** Full-throttle engine torque available at rpm (Nm), before throttle scaling. */
export function engineTorqueAvailable(rpm: number): number {
  return CAR_PHYSICS.engine.peakTorqueNm * torqueCurveMult(rpm);
}

export interface ConverterState {
  pumpOmega: number; // rad/s (engine side)
  turbineOmega: number; // rad/s (gearbox side)
  locked: boolean;
}

/**
 * Torque converter hydraulics.
 * speedRatio = turbine/pump. Torque ratio falls from stallMultiplication at
 * sr=0 to 1.0 at the coupling point. Capacity factor K rises with slip.
 * Returns { pumpTorque (load on engine), turbineTorque (drive into gearbox) }.
 */
export function evalConverter(
  pumpOmega: number,
  turbineOmega: number,
  locked: boolean,
): { pumpTorque: number; turbineTorque: number; speedRatio: number; torqueRatio: number } {
  const TC = CAR_PHYSICS.transmission.torqueConverter;
  if (locked) {
    return { pumpTorque: 0, turbineTorque: 0, speedRatio: 1, torqueRatio: 1 };
  }
  const pump = Math.max(1, pumpOmega);
  const sr = Math.max(0, Math.min(1, turbineOmega / pump));
  const tr = 1 + (TC.stallMultiplication - 1) * Math.max(0, 1 - sr / TC.couplingPoint);
  // Capacity: how much torque the fluid can carry ~ pump speed^2 * (1 - sr)
  const kCap = 0.00042 * (1.15 - sr);
  const pumpTorque = kCap * pump * pump * 0.12;
  const turbineTorque = pumpTorque * tr;
  return { pumpTorque, turbineTorque, speedRatio: sr, torqueRatio: tr };
}

export function rpmToOmega(rpm: number): number {
  return (rpm * 2 * Math.PI) / 60;
}

export function omegaToRpm(omega: number): number {
  return (omega * 60) / (2 * Math.PI);
}

/**
 * Clutch torque capacity model. engagement 0..1.
 * When slipping, transmits capacity*engagement in the direction opposing the
 * speed difference; when speeds match it transmits up to that (static).
 */
export function clutchTorque(
  engagement: number,
  engineOmega: number,
  gearboxOmega: number,
): number {
  const cap = CAR_PHYSICS.transmission.clutchCapacity * engagement;
  const dW = engineOmega - gearboxOmega;
  if (Math.abs(dW) < 2) {
    // near-locked: will be resolved by the caller clamping to demand
    return Math.sign(dW || 1) * cap;
  }
  return Math.sign(dW) * cap;
}

export interface GearboxState {
  gear: number; // -1 R, 0 N, 1..8
  shiftTimer: number; // s remaining of torque interruption
  shiftDuration: number;
  autoMode: boolean;
}

export function totalRatio(gear: number): number {
  const T = CAR_PHYSICS.transmission;
  if (gear > 0) return T.gearRatios[gear - 1] * T.finalDriveRatio;
  if (gear === -1) return T.reverseRatio * T.finalDriveRatio;
  return 0;
}

/** 0..1 drive-torque multiplier during a shift (interruption profile). */
export function shiftTorqueFactor(timer: number, duration: number): number {
  if (timer <= 0 || duration <= 0) return 1;
  // dip toward ~10% mid-shift, recover at engagement
  const t = 1 - timer / duration; // 0 -> 1 over the shift
  return 0.1 + 0.9 * t * t;
}

export interface LsdResult {
  leftTorque: number;
  rightTorque: number;
  biasTorque: number;
}

/**
 * Limited-slip differential.
 * inputTorque is split 50/50 open; a bias torque proportional to input torque
 * (accel ramp under power, decel ramp on coast) plus preload resists speed
 * difference by moving torque from the faster wheel to the slower wheel.
 */
export function evalLsd(
  inputTorque: number,
  omegaLeft: number,
  omegaRight: number,
  driving: boolean,
): LsdResult {
  const D = CAR_PHYSICS.differential;
  if (D.type === 'locked') {
    return { leftTorque: inputTorque / 2, rightTorque: inputTorque / 2, biasTorque: 0 };
  }
  const open = D.type === 'open';
  const ramp = open ? 0 : driving ? D.accelRamp : D.decelRamp;
  const preload = open ? 0 : D.preload;
  const dW = omegaLeft - omegaRight;
  const biasCap = preload + Math.abs(inputTorque) * ramp;
  // Bias torque flows from the faster wheel to the slower wheel, capped.
  const raw = dW * 8;
  const bias = Math.max(-biasCap, Math.min(biasCap, raw));
  const base = inputTorque / 2;
  return {
    leftTorque: base - bias,
    rightTorque: base + bias,
    biasTorque: bias,
  };
}
