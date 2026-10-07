/**
 * Aerodynamics: drag at body centre, downforce SPLIT front/rear applied at
 * the axle lines so aero balance creates a real pitch moment. v^2 everywhere,
 * with mild ride-height sensitivity.
 */
import { CAR_PHYSICS } from '../../constants/physics';

export interface AeroForces {
  drag: number; // N, opposing velocity
  frontDown: number; // N at front axle
  rearDown: number; // N at rear axle
}

export function evalAero(speed: number, rideHeight: number, out: AeroForces): AeroForces {
  const A = CAR_PHYSICS.aero;
  const v = Math.abs(speed);
  const q = 0.5 * A.airDensity * v * v; // dynamic pressure
  const hFactor = 1 + A.rideSensitivity * (A.referenceRideHeight - rideHeight);
  const hf = Math.max(0.7, Math.min(1.4, hFactor));
  out.drag = q * A.dragCoefficient * A.frontalArea;
  out.frontDown = q * A.downforceFront * A.referenceArea * hf;
  out.rearDown = q * A.downforceRear * A.referenceArea * hf;
  return out;
}
