/**
 * Phase 4 — per-wheel tire model (pure math: no Rapier, no three).
 *
 * Slip conventions (right-handed tire basis (t, l, n); t = wheel heading
 * projected on the contact plane, l = vehicle-left on the plane,
 * n = contact normal):
 * - Longitudinal slip ratio:  sx = (ω·r − vx) / max(|vx|, V0),  V0 = 2 m/s.
 *   sx > 0 (tire surface out-running the road forward) yields Fx > 0, i.e.
 *   a forward force on the chassis that drives/accelerates it forward.
 *   sx < 0 yields braking force. Holds for reverse travel too: with the
 *   car moving backward (vx < 0) a faster-backward-spinning wheel gives
 *   sx < 0 and a backward (-t) force, which is what propels reverse.
 *   V0 regularizes standstill (slip velocity over V0); the Magic Formula
 *   is intrinsically bounded (sin∘atan), so no slip clamp is needed.
 * - Slip angle:  sa = atan2(vy, max(|vx|, V0)). Lateral force is
 *   Fy = −MF(sa): always restoring (opposes the slide), zero at zero
 *   slip angle. Sh = Sv = 0 throughout, so the curves pass exactly
 *   through the origin — no force offset at zero slip.
 *
 * Force law: simplified Pacejka Magic Formula per direction,
 *   F(s) = D·sin(C·atan(B·s − E·(B·s − atan(B·s)))),
 * with shape (B, C, E) taken from constants/physics.ts and documented
 * units (B: 1/slip, C: -, E: -). Peak force D = cfgD·μ_eff·Fz, i.e. the
 * configured D (= 1.0) acts as a no-op scaler and the peak comes from
 * friction × actual normal load. Resulting curve properties (μ = 1.4):
 *   long. (B=10, C=1.65, E=0.97): stiffness B·C·D ≈ 16.5·μFz per unit
 *     slip, peak near sx ≈ 0.14, full-slide value ≈ 0.52 × peak.
 *   lat.  (B=9, C=1.45, E=0.97): stiffness ≈ 13·μFz, peak near 0.21 rad,
 *     full-slide value ≈ 0.76 × peak.
 * Post-peak falls gently to a bounded slide value — no runaway growth,
 * no hidden clamps. This is a SIMPLIFIED, documented use of the
 * configured shapes — not a calibrated full Pacejka set.
 *
 * Load sensitivity: μ_eff = μ·(Fz/FzRef)^(n−1) with the configured
 * per-direction exponents (0.9 long / 0.85 lat) and FzRef = 4000 N
 * nominal corner load. Fz ≤ 1 N (or airborne) yields exactly zero force.
 * Rolling resistance is a separate load-proportional term
 * (−Crr·Fz·tanh(vx/0.5), Crr = 0.012 ≈ 48 N at 4000 N, tanh smoothing
 * removes the zero-speed discontinuity) applied pre-ellipse so it
 * honestly consumes grip; it replaces the legacy flat 55 N offset.
 *
 * Combined slip: normalized friction ellipse. (Fx0/Dx, Fy0/Dy) are scaled
 * by 1/hypot when their magnitude exceeds 1, so the combined force can
 * never exceed the μ·Fz budget. No axle multipliers, no handbrake lateral
 * cuts, no assist grip boosts — grip comes from load × μ only.
 *
 * Combined-slip cross-weighting (Pacejka MF-style, C = 1 special case):
 * a heavily sliding tire in one direction loses grip in the other:
 *   Fx *= cos(atan(Bw·|sa|)),  Fy *= cos(atan(Bw·|sx|)),  Bw = 2.
 * At full longitudinal slide (|sx| = 1) lateral keeps cos(atan 2) ≈ 0.45;
 * near the drive peak (sx ≈ 0.14) lateral keeps ≈ 0.96. Without this, a
 * locked tire would keep 100% small-angle lateral stiffness, which is
 * unphysical (sliding contact has no stiffness regime) and makes
 * handbrake turns impossible. The ellipse remains as the final guard.
 */

export interface Vec3 {
  x: number
  y: number
  z: number
}

export interface PacejkaShape {
  B: number
  C: number
  D: number
  E: number
}

export interface TireParams {
  mu: number
  referenceLoad: number
  loadExpLong: number
  loadExpLat: number
  rollingResist: number
  long: PacejkaShape
  lat: PacejkaShape
}

export interface TireContact {
  /** False (or Fz ≤ 0) → all outputs exactly zero. */
  grounded: boolean
  /** Suspension normal load, N. Counted once, here. */
  normalLoad: number
  /** Contact normal (need not be unit; normalized internally). */
  normal: Vec3
  /** Contact-patch velocity (chassis linvel + angvel × lever), m/s. */
  patchVel: Vec3
  /** Wheel angular velocity, rad/s (+ = forward rolling). */
  wheelOmega: number
  /** Flat wheel heading (includes steering for front wheels), unit-ish. */
  wheelHeading: Vec3
  /** Body forward, used only if the heading projects degenerately. */
  bodyForward: Vec3
}

export interface TireResult {
  /** Longitudinal force on the chassis along +t, N. */
  fx: number
  /** Lateral force on the chassis along +l (vehicle-left), N. */
  fy: number
  /** World-space force (t·fx + l·fy). */
  force: Vec3
  /** Orthonormal basis actually used. */
  t: Vec3
  l: Vec3
  sx: number
  slipAngle: number
  /** Longitudinal contact speed, m/s. */
  vx: number
  /** Lateral contact speed, m/s. */
  vy: number
  muX: number
  muY: number
  /** Nominal friction budget μ·Fz (before load-sensitivity; HUD use). */
  fmax: number
  /** Combined-slip utilization (1 = at the limit). */
  usage: number
  rollingForce: number
}

/** Low-speed regularization, m/s. Slip velocity below this reads as partial slip. */
export const SLIP_V0 = 2.0
/** Rolling-resistance velocity smoothing, m/s. */
export const RR_V0 = 0.5
/** Combined-slip cross-weighting sharpness (Pacejka MF-style, C = 1). */
export const COMBINED_BW = 2.0

export function magicFormula(
  s: number,
  B: number,
  C: number,
  D: number,
  E: number,
): number {
  const Bs = B * s
  return D * Math.sin(C * Math.atan(Bs - E * (Bs - Math.atan(Bs))))
}

function dot(a: Vec3, b: Vec3): number {
  return a.x * b.x + a.y * b.y + a.z * b.z
}

function sub(a: Vec3, b: Vec3): Vec3 {
  return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z }
}

function scale(a: Vec3, k: number): Vec3 {
  return { x: a.x * k, y: a.y * k, z: a.z * k }
}

function norm(a: Vec3): Vec3 {
  const m = Math.hypot(a.x, a.y, a.z)
  if (!(m > 1e-9)) return { x: 0, y: 1, z: 0 }
  return scale(a, 1 / m)
}

export class TireModel {
  constructor(
    readonly params: TireParams,
    readonly radius: number,
  ) {}

  eval(c: TireContact): TireResult {
    const zero = (t: Vec3, l: Vec3): TireResult => ({
      fx: 0,
      fy: 0,
      force: { x: 0, y: 0, z: 0 },
      t,
      l,
      sx: 0,
      slipAngle: 0,
      vx: 0,
      vy: 0,
      muX: this.params.mu,
      muY: this.params.mu,
      fmax: 0,
      usage: 0,
      rollingForce: 0,
    });

    const n = norm(c.normal)
    // Longitudinal axis: heading projected onto the contact plane.
    let t = sub(c.wheelHeading, scale(n, dot(c.wheelHeading, n)))
    if (Math.hypot(t.x, t.y, t.z) < 1e-4) {
      // Degenerate (heading parallel to normal — cannot happen for a
      // rolling car wheel): fall back to body forward, then world -Z.
      t = sub(c.bodyForward, scale(n, dot(c.bodyForward, n)))
      if (Math.hypot(t.x, t.y, t.z) < 1e-4) {
        t = sub({ x: 0, y: 0, z: -1 }, scale(n, -n.z))
        if (Math.hypot(t.x, t.y, t.z) < 1e-4) t = { x: 0, y: 0, z: -1 }
      }
    }
    t = norm(t)
    // Lateral axis: l = n × t gives vehicle-left; (t, l, n) right-handed
    // since t × (n × t) = n for orthonormal t ⊥ n.
    const l = norm({
      x: n.y * t.z - n.z * t.y,
      y: n.z * t.x - n.x * t.z,
      z: n.x * t.y - n.y * t.x,
    });

    const Fz = c.grounded ? Math.max(0, c.normalLoad) : 0
    if (Fz <= 1) return zero(t, l)

    const vx = dot(c.patchVel, t)
    const vy = dot(c.patchVel, l)
    const denom = Math.max(Math.abs(vx), SLIP_V0)
    const sx = (c.wheelOmega * this.radius - vx) / denom
    const sa = Math.atan2(vy, denom)

    const P = this.params
    const loadRatio = Fz / P.referenceLoad
    const muX = P.mu * Math.pow(loadRatio, P.loadExpLong - 1)
    const muY = P.mu * Math.pow(loadRatio, P.loadExpLat - 1)
    const Dx = P.long.D * muX * Fz
    const Dy = P.lat.D * muY * Fz

    let fx0 = magicFormula(sx, P.long.B, P.long.C, Dx, P.long.E)
    let fy0 = -magicFormula(sa, P.lat.B, P.lat.C, Dy, P.lat.E)
    const rollingForce = -P.rollingResist * Fz * Math.tanh(vx / RR_V0)
    fx0 += rollingForce

    // MF-style cross-weighting: slide in one direction costs grip in the
    // other (C = 1 closed form: cos(atan(x)) = 1/sqrt(1+x²)).
    fx0 *= 1 / Math.hypot(1, COMBINED_BW * sa)
    fy0 *= 1 / Math.hypot(1, COMBINED_BW * sx)

    // Normalized friction ellipse on the direction peaks.
    const nx = fx0 / Dx
    const ny = fy0 / Dy
    const m = Math.hypot(nx, ny)
    const k = m > 1 ? 1 / m : 1
    const fx = fx0 * k
    const fy = fy0 * k

    return {
      fx,
      fy,
      force: {
        x: t.x * fx + l.x * fy,
        y: t.y * fx + l.y * fy,
        z: t.z * fx + l.z * fy,
      },
      t,
      l,
      sx,
      slipAngle: sa,
      vx,
      vy,
      muX,
      muY,
      fmax: P.mu * Fz,
      usage: m,
      rollingForce,
    }
  }
}
