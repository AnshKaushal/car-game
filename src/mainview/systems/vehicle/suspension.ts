/**
 * Wheel suspension model: spring + asymmetric bump/rebound damper +
 * progressive bump stop + travel limits. Stateless per-call evaluation plus a
 * per-wheel state struct. ARB forces are computed per axle from the left/right
 * compression difference and applied equal/opposite.
 */
import { CAR_PHYSICS } from '../../constants/physics';

export interface CornerSuspConfig {
  springRate: number;
  bumpDamping: number;
  reboundDamping: number;
  bumpStopRate: number;
  bumpStopGap: number;
  antiRollRate: number;
}

export function frontSuspConfig(): CornerSuspConfig {
  const s = CAR_PHYSICS.suspension.front;
  return {
    springRate: s.springRate, bumpDamping: s.bumpDamping, reboundDamping: s.reboundDamping,
    bumpStopRate: s.bumpStopRate, bumpStopGap: s.bumpStopGap, antiRollRate: s.antiRollRate,
  };
}

export function rearSuspConfig(): CornerSuspConfig {
  const s = CAR_PHYSICS.suspension.rear;
  return {
    springRate: s.springRate, bumpDamping: s.bumpDamping, reboundDamping: s.reboundDamping,
    bumpStopRate: s.bumpStopRate, bumpStopGap: s.bumpStopGap, antiRollRate: s.antiRollRate,
  };
}

export interface SuspState {
  /** Compression from static equilibrium: + = bump, − = droop (m). */
  disp: number;
  /** Compression velocity (m/s). + = bump. */
  vel: number;
}

export interface SuspForce {
  spring: number;
  damper: number;
  bumpStop: number;
  total: number; // N; can go slightly negative on the droop straps
  toppedOut: boolean;
  onBumpStop: boolean;
}

/**
 * Evaluate suspension force.
 * - Spring preload holds static equilibrium at disp=0.
 * - Damper: bump vs rebound rates with correct sign (rebound resists droop).
 * - Bump stop: progressive (quadratic) once past the gap.
 * - Droop: past max droop the wheel hangs on its limit straps — force goes
 *   mildly negative (capped) instead of vanishing discontinuously. A real
 *   damper tops out with a clunk, it does not teleport to zero load, and the
 *   discontinuity is what lets one topped axle hand the car to the other.
 */
export function evalSuspension(
  cfg: CornerSuspConfig,
  preload: number,
  disp: number,
  vel: number,
  out: SuspForce,
): SuspForce {
  const travelBump = CAR_PHYSICS.suspension.travelBump;
  const travelDroop = CAR_PHYSICS.suspension.travelDroop;

  const toppedOut = disp <= -travelDroop;

  // Hard travel stops: past full bump the chassis sits on the stops (nearly
  // solid rate), past full droop the straps go bar-taut. Without stops the
  // wheel travels without bound and spring/bump-stop forces explode.
  const STOP_RATE = 800000; // N/m — chassis on the bump stops
  const overBump = Math.max(0, disp - travelBump);
  const overDroop = Math.max(0, -travelDroop - disp);

  const spring = preload + cfg.springRate * disp + STOP_RATE * (overBump - overDroop);
  // Damper opposes compression velocity: bump (vel>0, body moving toward the
  // ground) pushes the body UP. F = +c*vel dissipates energy (-c*v^2 power).
  // Blow-off valve: real dampers saturate — clamp keeps 120 Hz stable.
  const c = vel >= 0 ? cfg.bumpDamping : cfg.reboundDamping;
  const damper = Math.max(-15000, Math.min(15000, c * vel));

  let bumpStop = 0;
  let onBumpStop = false;
  if (disp > cfg.bumpStopGap) {
    const over = disp - cfg.bumpStopGap;
    bumpStop = cfg.bumpStopRate * over * over * 10;
    onBumpStop = true;
  }
  void travelBump;

  out.spring = spring;
  out.damper = damper;
  out.bumpStop = bumpStop;
  out.total = Math.max(-2500, Math.min(45000, spring + damper + bumpStop));
  out.toppedOut = toppedOut;
  out.onBumpStop = onBumpStop;
  return out;
}

/**
 * Anti-roll bar: equal/opposite forces from left-right compression difference.
 * Returns [leftForce, rightForce] additions (N). Positive difference
 * (left more compressed) pushes left down harder... i.e. resists roll by
 * loading the more-compressed side and unloading the other.
 */
export function evalAntiRollBar(rate: number, dispLeft: number, dispRight: number): [number, number] {
  const diff = dispLeft - dispRight;
  const f = diff * rate;
  return [f, -f];
}
