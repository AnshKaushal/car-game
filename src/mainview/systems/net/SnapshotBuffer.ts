/**
 * Phase 3 — per-peer snapshot buffer with delayed interpolation and
 * bounded extrapolation.
 *
 * Dependency-free (plain {x,y,z,w} math, no three/rapier) so it runs
 * under `bun scripts/...` for deterministic regression tests.
 *
 * Timing model: snapshots are stamped with RECEIVER-LOCAL arrival time
 * (performance.now() at handleStatePacket entry). Arrival time is NOT
 * the remote vehicle's simulation time — varying network delay injects
 * timing error. The interpolation delay exists precisely to absorb that
 * error: by rendering ~100 ms behind the newest snapshot we usually
 * have a bracketing pair and never need the sender's clock.
 *
 * The sender's `t` field is never stored here (alien clock domain).
 *
 * Ordering assumption: only Phase-2-accepted packets are appended, so
 * sequence numbers arrive in increasing order and the buffer stays
 * sorted by both seq and arrival time. Append does not sort.
 */

export interface SnapshotIn {
  x: number
  y: number
  z: number
  qx: number
  qy: number
  qz: number
  qw: number
  vx: number
  vy: number
  vz: number
}

export interface Snapshot extends SnapshotIn {
  /** Receiver-local arrival time (ms). */
  arrivalMs: number
  seq: number
}

export interface InterpTarget {
  x: number
  y: number
  z: number
  qx: number
  qy: number
  qz: number
  qw: number
  vx: number
  vy: number
  vz: number
}

export type InterpMode = "empty" | "hold" | "interp" | "extrap"

/** Render this far behind the newest arrival (ms). ~3 packets at 30 Hz. */
export const INTERP_DELAY_MS = 100
/** Never extrapolate further than this past the newest snapshot (ms). */
export const EXTRAP_MAX_MS = 250
/** Hard cap on retained snapshots (~1 s at 30 Hz plus burst headroom). */
export const SNAPSHOT_CAP = 32

export function newInterpTarget(): InterpTarget {
  return {
    x: 0, y: 0.72, z: 0,
    qx: 0, qy: 0, qz: 0, qw: 1,
    vx: 0, vy: 0, vz: 0,
  }
}

function copySnap(s: Snapshot, out: InterpTarget): void {
  out.x = s.x
  out.y = s.y
  out.z = s.z
  out.qx = s.qx
  out.qy = s.qy
  out.qz = s.qz
  out.qw = s.qw
  out.vx = s.vx
  out.vy = s.vy
  out.vz = s.vz
}

/**
 * Quaternion slerp on plain components. Defensive: Phase 2 already
 * rejects degenerate quats, but the buffer must never emit NaN even if
 * one slips through (e.g. a future sender change).
 */
export function slerpQuat(
  ax: number, ay: number, az: number, aw: number,
  bx: number, by: number, bz: number, bw: number,
  t: number,
  out: { x: number; y: number; z: number; w: number },
): void {
  let dot = ax * bx + ay * by + az * bz + aw * bw
  let cx = bx
  let cy = by
  let cz = bz
  let cw = bw
  if (dot < 0) {
    // Shortest path: q and -q are the same rotation.
    dot = -dot
    cx = -cx
    cy = -cy
    cz = -cz
    cw = -cw
  }
  const DOT_THRESHOLD = 0.9995
  if (dot > DOT_THRESHOLD) {
    // Nearly identical: lerp + normalize avoids div-by-zero.
    out.x = ax + t * (cx - ax)
    out.y = ay + t * (cy - ay)
    out.z = az + t * (cz - az)
    out.w = aw + t * (cw - aw)
  } else {
    const theta0 = Math.acos(dot)
    const sin0 = Math.sin(theta0)
    const s0 = Math.sin((1 - t) * theta0) / sin0
    const s1 = Math.sin(t * theta0) / sin0
    out.x = ax * s0 + cx * s1
    out.y = ay * s0 + cy * s1
    out.z = az * s0 + cz * s1
    out.w = aw * s0 + cw * s1
  }
  const n2 = out.x * out.x + out.y * out.y + out.z * out.z + out.w * out.w
  if (!(n2 > 1e-12)) {
    // Degenerate (should be unreachable post-validation): identity fallback.
    out.x = 0
    out.y = 0
    out.z = 0
    out.w = 1
    return
  }
  const inv = 1 / Math.sqrt(n2)
  out.x *= inv
  out.y *= inv
  out.z *= inv
  out.w *= inv
}

export interface SampleStats {
  mode: InterpMode
  /** Extrapolation duration actually applied (ms, 0 when interpolating). */
  extrapMs: number
}

const _q = { x: 0, y: 0, z: 0, w: 1 }

export class SnapshotBuffer {
  private snaps: Snapshot[] = []
  /** Times sample() wanted interpolation but history couldn't bracket. */
  underruns = 0

  get size(): number {
    return this.snaps.length
  }

  /** Append a Phase-2-accepted snapshot. Oldest entries fall off past the cap. */
  append(s: SnapshotIn, arrivalMs: number, seq: number): void {
    this.snaps.push({
      x: s.x, y: s.y, z: s.z,
      qx: s.qx, qy: s.qy, qz: s.qz, qw: s.qw,
      vx: s.vx, vy: s.vy, vz: s.vz,
      arrivalMs,
      seq,
    })
    if (this.snaps.length > SNAPSHOT_CAP) {
      this.snaps.splice(0, this.snaps.length - SNAPSHOT_CAP)
    }
  }

  /** Latest accepted snapshot (for discontinuity reseeding checks). */
  latest(): Snapshot | null {
    return this.snaps.length > 0 ? this.snaps[this.snaps.length - 1] : null
  }

  /** Drop all history — session changes, teleports, teardown. Never throws. */
  reset(): void {
    this.snaps.length = 0
  }

  /**
   * Compute the drive target for renderTimeMs (receiver clock, normally
   * now - INTERP_DELAY_MS). Writes into `out`, no allocation. Fallbacks:
   * empty -> "empty" (caller keeps previous target / coasts); single
   * snapshot or renderTime older than oldest -> hold nearest ("hold",
   * underrun counted when history exists but can't bracket); newer than
   * newest -> velocity extrapolation clamped to EXTRAP_MAX_MS ("extrap").
   */
  sampleInto(out: InterpTarget, renderTimeMs: number, stats?: SampleStats): InterpMode {
    const n = this.snaps.length
    if (n === 0) {
      if (stats) {
        stats.mode = "empty"
        stats.extrapMs = 0
      }
      this.underruns++
      return "empty"
    }
    const newest = this.snaps[n - 1]
    if (renderTimeMs <= this.snaps[0].arrivalMs) {
      // Render time predates history (priming): hold the oldest snapshot.
      copySnap(this.snaps[0], out)
      if (n > 1) this.underruns++
      if (stats) {
        stats.mode = "hold"
        stats.extrapMs = 0
      }
      return "hold"
    }
    if (renderTimeMs >= newest.arrivalMs) {
      // Bounded extrapolation from the newest validated velocity
      // (world-space m/s — see broadcastLocalState reading body.linvel()).
      // Also covers the single-snapshot case: a fresh snapshot
      // extrapolates ~0 ms (== hold); a stale one coasts to the clamp
      // and freezes, where drive()'s authority fade then stops the body.
      const overMs = Math.max(0, Math.min(EXTRAP_MAX_MS, renderTimeMs - newest.arrivalMs))
      const dt = overMs / 1000
      out.x = newest.x + newest.vx * dt
      out.y = newest.y + newest.vy * dt
      out.z = newest.z + newest.vz * dt
      // Orientation is held, never extrapolated: angular velocity is
      // unknown and guessing rotations causes visible flips.
      out.qx = newest.qx
      out.qy = newest.qy
      out.qz = newest.qz
      out.qw = newest.qw
      out.vx = newest.vx
      out.vy = newest.vy
      out.vz = newest.vz
      if (stats) {
        stats.mode = "extrap"
        stats.extrapMs = overMs
      }
      return "extrap"
    }
    // Bracketed: find newest snapshot at or before renderTimeMs.
    let i = n - 1
    while (i > 0 && this.snaps[i].arrivalMs > renderTimeMs) i--
    const a = this.snaps[i]
    const b = this.snaps[i + 1]
    const span = b.arrivalMs - a.arrivalMs
    const t = span > 0 ? (renderTimeMs - a.arrivalMs) / span : 1
    const tc = t < 0 ? 0 : t > 1 ? 1 : t
    out.x = a.x + (b.x - a.x) * tc
    out.y = a.y + (b.y - a.y) * tc
    out.z = a.z + (b.z - a.z) * tc
    slerpQuat(a.qx, a.qy, a.qz, a.qw, b.qx, b.qy, b.qz, b.qw, tc, _q)
    out.qx = _q.x
    out.qy = _q.y
    out.qz = _q.z
    out.qw = _q.w
    // Drive velocity follows the newer snapshot: it best represents where
    // the owner is going, and blending velocities across a turn causes
    // corner-cutting overshoot.
    out.vx = b.vx
    out.vy = b.vy
    out.vz = b.vz
    if (stats) {
      stats.mode = "interp"
      stats.extrapMs = 0
    }
    return "interp"
  }
}
