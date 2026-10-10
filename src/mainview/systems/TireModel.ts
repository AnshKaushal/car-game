
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
  grounded: boolean
  normalLoad: number
  normal: Vec3
  patchVel: Vec3
  wheelOmega: number
  wheelHeading: Vec3
  bodyForward: Vec3
}

export interface TireResult {
  fx: number
  fy: number
  force: Vec3
  t: Vec3
  l: Vec3
  sx: number
  slipAngle: number
  vx: number
  vy: number
  muX: number
  muY: number
  fmax: number
  usage: number
  rollingForce: number
}

export const SLIP_V0 = 2.0
export const RR_V0 = 0.5
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
    let t = sub(c.wheelHeading, scale(n, dot(c.wheelHeading, n)))
    if (Math.hypot(t.x, t.y, t.z) < 1e-4) {
      t = sub(c.bodyForward, scale(n, dot(c.bodyForward, n)))
      if (Math.hypot(t.x, t.y, t.z) < 1e-4) {
        t = sub({ x: 0, y: 0, z: -1 }, scale(n, -n.z))
        if (Math.hypot(t.x, t.y, t.z) < 1e-4) t = { x: 0, y: 0, z: -1 }
      }
    }
    t = norm(t)
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

    fx0 *= 1 / Math.hypot(1, COMBINED_BW * sa)
    fy0 *= 1 / Math.hypot(1, COMBINED_BW * sx)

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
