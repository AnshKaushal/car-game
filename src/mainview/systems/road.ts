/**
 * Shared analytic road definition — ONE source of truth for visuals AND physics.
 *
 * The road runs along -Z. `s` = distance along the road (s = -z for the spine).
 * - roadCenterX(s): lateral offset of the centerline
 * - roadElevation(s): height of the surface
 * - roadBank(s): banking angle (rad, + = right side higher in direction of travel)
 * - roadFrame(s): full surface frame { center, tangent, normal, curvature }
 *
 * Physics samples this per wheel; WorldManager builds ribbons from it.
 * Elevation is zero at s=0 so the spawn point is unchanged.
 */

export function roadCenterX(s: number): number {
  return Math.sin(s * 0.004) * 60 + Math.sin(s * 0.0013 + 1.7) * 120;
}

/** Gentle elevation, 0 at s=0. Wavelengths are long so grades stay small. */
export function roadElevation(s: number): number {
  const e =
    6 * Math.sin(s * 0.0011) +
    3 * Math.sin(s * 0.0027 + 1.0) +
    1.5 * Math.sin(s * 0.006 + 0.4);
  const e0 = 3 * Math.sin(1.0) + 1.5 * Math.sin(0.4); // value at s=0
  return e - e0;
}

/** Path curvature 1/m (signed, from centerline second derivative). */
export function roadCurvature(s: number): number {
  const h = 2;
  const d2 = roadCenterX(s + h) - 2 * roadCenterX(s) + roadCenterX(s - h);
  return d2 / (h * h);
}

/**
 * Banking: corners are cambered into the turn (like a real highway), plus a
 * small sinusoidal crown so banking is never exactly zero.
 * Positive bank raises the outside of the turn.
 */
export function roadBank(s: number): number {
  const k = roadCurvature(s);
  // bank into the corner: lateral accel at 25 m/s fully compensated * 0.6
  const fromCurve = Math.max(-0.1, Math.min(0.1, -k * 25 * 25 * 0.6 * 0.06));
  const crown = 0.012 * Math.sin(s * 0.0016 + 0.7);
  return fromCurve + crown;
}

export interface RoadFrame {
  centerX: number;
  y: number;
  z: number;
  /** Unit tangent in the XZ plane (direction of travel, -Z-ish). */
  tangentX: number;
  tangentZ: number;
  /** Unit surface normal. */
  normalX: number;
  normalY: number;
  normalZ: number;
  bank: number;
  curvature: number;
}

const _cache = { s: NaN, frame: null as RoadFrame | null };

/** Full surface frame at distance s. Result is cached for repeated s. */
export function roadFrame(s: number): RoadFrame {
  if (_cache.frame && _cache.s === s) return _cache.frame;
  const h = 0.5;
  const cx = roadCenterX(s);
  const tx = (roadCenterX(s + h) - roadCenterX(s - h)) / (2 * h);
  const inv = 1 / Math.hypot(tx, 1);
  // travel direction: (tx, -1)/n in xz
  const tangentX = tx * inv;
  const tangentZ = -inv;
  // grade from elevation
  const grade = (roadElevation(s + h) - roadElevation(s - h)) / (2 * h);
  const bank = roadBank(s);
  // surface normal: start up, tilt by grade (pitch) then bank (roll)
  // n = normalize(-grade * tangentXZ_perp..., 1, ...) — build explicitly:
  // forward f=(tangentX, grade, tangentZ) normalized; right r=(−tz,0,tx); n = r × f
  const fl = Math.hypot(tangentX, grade, tangentZ);
  const fx = tangentX / fl, fy = grade / fl, fz = tangentZ / fl;
  let rx = -fz, rz = fx; // right vector (y=0)
  const rl = Math.hypot(rx, rz);
  rx /= rl; rz /= rl;
  // apply banking: rotate right/up around forward axis
  const cb = Math.cos(bank), sb = Math.sin(bank);
  // up0 = (0,1,0); up' = up0*cos + r*sin ; r' = r*cos - up0*sin
  const upx = rx * sb, upy = cb, upz = rz * sb;
  // n = r' × f
  const r2x = rx * cb, r2y = -sb, r2z = rz * cb;
  const nx = r2y * fz - r2z * fy;
  const ny = r2z * fx - r2x * fz;
  const nz = r2x * fy - r2y * fx;
  void upx; void upy; void upz;
  const nl = Math.hypot(nx, ny, nz) || 1;
  const frame: RoadFrame = {
    centerX: cx,
    y: roadElevation(s),
    z: -s,
    tangentX,
    tangentZ,
    normalX: nx / nl,
    normalY: ny / nl,
    normalZ: nz / nl,
    bank,
    curvature: roadCurvature(s),
  };
  _cache.s = s;
  _cache.frame = frame;
  return frame;
}

/** Terrain height away from the ribbon: hugs the road elevation (no cliffs). */
export function terrainHeight(s: number): number {
  return roadElevation(s) - 0.08;
}

/** Signed lateral offset of world (x,z) from the centerline. + = right of travel. */
export function roadLateral(x: number, z: number): number {
  const s = -z;
  const f = roadFrame(s);
  // right vector in xz: (−tz, tx)... travel dir (tx,tz); right = (-tz, tx)? check:
  // forward -Z, right +X when straight: t=(0,-1) -> right should be (1,0)... use (−tz, tx) = (1, 0). yes.
  const rx = -f.tangentZ, rz = f.tangentX;
  return (x - f.centerX) * rx + (z - f.z) * rz;
}

export function roadYaw(s: number): number {
  const dx = (roadCenterX(s + 4) - roadCenterX(s - 4)) / 8;
  return Math.atan2(dx, 1);
}
