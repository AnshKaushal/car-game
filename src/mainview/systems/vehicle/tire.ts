/**
 * Simplified Pacejka Magic Formula tire model with load sensitivity and
 * combined-slip friction-ellipse coupling. Stateless pure functions + a small
 * per-wheel scratch struct. All SI units.
 */
import { CAR_PHYSICS } from '../../constants/physics';

export interface PacejkaParams {
  peakMu: number;
  longB: number; longC: number; longD: number; longE: number;
  latB: number; latC: number; latD: number; latE: number;
  loadSensitivity: number;
  corneringStiffness: number;
}

export function frontTireParams(): PacejkaParams {
  const t = CAR_PHYSICS.tire.front;
  return {
    peakMu: t.peakMu, longB: t.longB, longC: t.longC, longD: t.longD, longE: t.longE,
    latB: t.latB, latC: t.latC, latD: t.latD, latE: t.latE,
    loadSensitivity: t.loadSensitivity, corneringStiffness: t.corneringStiffness,
  };
}

export function rearTireParams(): PacejkaParams {
  const t = CAR_PHYSICS.tire.rear;
  return {
    peakMu: t.peakMu, longB: t.longB, longC: t.longC, longD: t.longD, longE: t.longE,
    latB: t.latB, latC: t.latC, latD: t.latD, latE: t.latE,
    loadSensitivity: t.loadSensitivity, corneringStiffness: t.corneringStiffness,
  };
}

/** Magic formula core: F = D sin(C atan(Bx − E(Bx − atan Bx))). */
export function magicFormula(B: number, C: number, D: number, E: number, x: number): number {
  const Bx = B * x;
  return D * Math.sin(C * Math.atan(Bx - E * (Bx - Math.atan(Bx))));
}

/**
 * Load-sensitive friction: mu falls as load rises.
 * muEff = peakMu * (Fz / Fz0)^(-sens), clamped to a sane band.
 */
export function effectiveMu(peakMu: number, sens: number, fz: number): number {
  const fz0 = CAR_PHYSICS.tire.refLoad;
  const ratio = Math.max(0.15, fz / fz0);
  const mu = peakMu * Math.pow(ratio, -sens);
  return Math.max(0.4, Math.min(2.2, mu));
}

export interface TireInput {
  /** Longitudinal slip ratio (signed). */
  kappa: number;
  /** Lateral slip angle (rad, signed). */
  alpha: number;
  /** Vertical load (N). */
  fz: number;
  /** Camber angle (rad). */
  camber: number;
}

export interface TireOutput {
  fx: number; // longitudinal force (N), + forward
  fy: number; // lateral force (N), + right... (tire frame: + right)
  mz: number; // aligning torque (Nm)
  muEff: number;
  combined: number; // 0..1 fraction of friction budget used
}

/**
 * Combined-slip evaluation:
 * 1. raw longitudinal force from kappa, raw lateral from alpha (+ camber thrust)
 * 2. scale each by muEff * Fz
 * 3. friction-ellipse coupling: if |F| exceeds the budget, scale both down
 *    proportionally so the tire can NEVER exceed mu*Fz in any direction and no
 *    artificial lateral floor remains.
 */
export function evalTire(p: PacejkaParams, t: TireInput, out: TireOutput): TireOutput {
  const mu = effectiveMu(p.peakMu, p.loadSensitivity, t.fz);
  const budget = mu * t.fz;

  let fxRaw = magicFormula(p.longB, p.longC, p.longD, p.longE, t.kappa);
  // Camber thrust: small lateral force from camber even at zero slip.
  const alphaEff = t.alpha + t.camber * 0.6;
  let fyRaw = magicFormula(p.latB, p.latC, p.latD * p.corneringStiffness, p.latE, alphaEff);

  let fx = fxRaw * budget;
  let fy = fyRaw * budget;

  const mag = Math.hypot(fx, fy);
  let combined = mag / Math.max(1, budget);
  if (mag > budget && mag > 1e-6) {
    const s = budget / mag;
    fx *= s;
    fy *= s;
    combined = 1;
  }
  // Aligning torque: pneumatic trail * Fy, trail collapses at high slip.
  const trail = CAR_PHYSICS.tire.pneumaticTrail * Math.max(0, 1 - Math.min(1, Math.abs(t.alpha) / 0.35));
  out.fx = fx;
  out.fy = fy;
  out.mz = -trail * fy;
  out.muEff = mu;
  out.combined = combined;
  return out;
}

/**
 * Longitudinal slip ratio from contact-patch kinematics.
 * kappa = (wheelSurfaceSpeed − vLong) / max(|vLong|, vMin)
 * Positive kappa = driving, negative = braking. Uses the actual contact patch
 * velocity, never the chassis-center velocity.
 */
export function slipRatio(wheelSurfaceSpeed: number, vLong: number): number {
  // Soft low-speed response: below ~3 m/s the contact is in the carcass-
  // compliance regime, not fully developed sliding (also keeps 120 Hz stable).
  const denom = Math.max(3.0, Math.abs(vLong));
  const k = (wheelSurfaceSpeed - vLong) / denom;
  return Math.max(-1.5, Math.min(1.5, k));
}

/**
 * Lateral slip angle from contact-patch velocity in the tire frame.
 * alpha = atan2(vLat, |vLong|). Each wheel uses its own patch velocity.
 */
export function slipAngle(vLat: number, vLong: number): number {
  return Math.atan2(vLat, Math.abs(vLong) + 0.5);
}

/** Rolling resistance force opposing motion (N). */
export function rollingResistance(fz: number, vLong: number): number {
  if (Math.abs(vLong) < 0.2) return 0;
  return -Math.sign(vLong) * CAR_PHYSICS.tire.rollingResistance * fz;
}
