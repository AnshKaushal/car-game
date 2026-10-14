/**
 * Phase 4 — hybrid dynamic correction policy (pure math + mode machine).
 *
 * Dependency-free so correction behavior is unit-testable under bun.
 * RemoteCar owns one CorrectionState per peer and feeds it contact
 * observations sampled once per frame (see RemoteCar.sampleContacts).
 *
 * Calibrated 2026-10-14 with scripts-grade probe (bun + rapier-compat):
 * - resting car-vs-car touch: 8 narrow-phase contacts, summed solver
 *   impulse ≈ 0 N·s.
 * - 20 m/s ram of a parked 1650 kg ghost: peak summed impulse ≈ 20,600.
 *   (1650 kg × ~12 m/s Δv ≈ 20,000 — physically consistent.)
 * - IMPACT_IMPULSE_THRESHOLD = 2000 sits ~4 orders of magnitude above
 *   resting touch and ~10× below a real ram. Re-calibrate if car mass,
 *   solver iterations, or timestep change.
 */

export type CorrectionMode = "follow" | "contact" | "recover"

/**
 * Max change of the CORRECTION contribution per second (m/s²). The old
 * 10 m/s cap limited the correction term, not its per-substep change —
 * setLinvel could still impose 0→120 m/s in one substep. 25 m/s² keeps
 * correction authority inside what tires/brakes could plausibly do
 * (~2.5 g) so the ghost can never yank itself or a touching car.
 */
export const CORRECTION_ACCEL_MAX = 25

/** Stay suppressed this long after the last observed touch (ms). */
export const CONTACT_GRACE_MS = 300
/** Extended suppression after a hard impact (ms). Shorter than the first
 * 800 ms draft: a passive ghost coasts at impact velocity during grace,
 * and 800 ms × 6 m/s already outruns the 15 m warp into a teleport pop.
 * 400 ms still covers lingering contact (measured). */
export const HARD_IMPACT_GRACE_MS = 400
/** Summed solver impulse (N·s) qualifying as a hard impact. */
export const IMPACT_IMPULSE_THRESHOLD = 2000
/** Ramp correction 0→1 over this long after grace expires (ms). */
export const RECOVER_RAMP_MS = 400
/** Recover mode holds (gentle RECOVER_CORR_MAX cap) until tracking error
 * drops below this (m) even after the time ramp completes: returning from
 * a multi-metre knock at the 10 m/s follow cap reads as a pop. The value
 * is the continuity point with the recover cap (0.65 × POS_GAIN 4.5 ≈ 3),
 * so graduating to follow causes no command step. Small errors (normal
 * recovery) pass through immediately. A fast-moving owner is still
 * followed via full cruise while the gap closes gently; warp stays the
 * divergence backstop. */
export const RECOVER_FOLLOW_ERR_M = 0.65
/** Warp fallback stays armed while contact/recover explains the divergence
 * only past this error (m). Measured 2026-10-14 (deterministic pit repro:
 * driven 12 m/s side-push vs 10 m/s owner): passive drag + grace coast
 * reached 11.3 m error at recover entry and crossed the 15 m warp
 * mid-recovery — a 13 m teleport from an ordinary collision. Collision
 * separation grows at most ~25 m/s (knock + cruise-apart) over the
 * ~1 s contact+grace window, so 30 keeps 2× margin above measured
 * ordinary pits while true teleports (100s of metres) still snap. */
export const RECOVER_WARP_M = 30

// --- Change B: gentle recovery + support descent (Phase 3b) ---
/** Correction magnitude cap during recover mode (m/s). Follow keeps 10:
 * the T1b slide-back peaked at ~10 m/s (the old cap); visible pops read
 * as teleports above ~3 m/s in test. Initial test-calibrated value. */
export const RECOVER_CORR_MAX = 3
/** While support contact is active, allow commanded descent only if the
 * goal is this far below the body (m): owners do drive off ledges, and
 * support vanishes as geometry separates. Prevents hover-deadlock while
 * still killing the grind (Change A backstop). */
export const SUPPORT_DESCENT_DY = -0.5

export class CorrectionState {
  mode: CorrectionMode = "follow"
  inContact = false
  /** Largest summed impulse observed during the current touch. */
  impactImpulse = 0
  /** Support contact (road or car-top rest) observed at last sample. */
  hasSupport = false
  /** Cumulative substeps spent with correction suppressed. */
  suppressedSubsteps = 0
  /** Contact→other transitions (hysteresis observability). */
  transitions = 0
  private lastContactMs = -Infinity
  private recoverStartMs = 0
  private hardHit = false
  reset() {
    this.mode = "follow"
    this.inContact = false
    this.impactImpulse = 0
    this.hasSupport = false
    this.lastContactMs = -Infinity
    this.recoverStartMs = 0
    this.hardHit = false
  }

  /**
   * Frame-rate contact observation. `touching` = any narrow-phase car
   * contact on the proxy collider; `impulse` = summed solver impulse.
   * Suppression covers ALL touches (a resting push is exactly the
   * bulldozer case); impulse only extends the grace after hard hits.
   */
  noteContact(touching: boolean, impulse: number, nowMs: number) {
    if (touching) {
      this.lastContactMs = nowMs
      if (impulse > this.impactImpulse) this.impactImpulse = impulse
      if (impulse >= IMPACT_IMPULSE_THRESHOLD) this.hardHit = true
      if (this.mode !== "contact") {
        this.mode = "contact"
        this.transitions++
      }
      this.inContact = true
      return
    }
    this.inContact = false
    if (this.mode === "contact") {
      const grace = this.hardHit ? HARD_IMPACT_GRACE_MS : CONTACT_GRACE_MS
      if (nowMs - this.lastContactMs >= grace) {
        this.mode = "recover"
        this.recoverStartMs = nowMs
        this.transitions++
        // Change B: separation confirmed — drop stale impact state so a
        // later gentle touch isn't misread as a hard hit (grace length,
        // passivity gate). The grace above already used the old value.
        this.impactImpulse = 0
        this.hardHit = false
      }
    }
  }

  /**
   * Frame-rate support observation (road or car-top rest). Independent of
   * traffic contact: a ghost can rest on support without touching a car.
   */
  noteSupport(supporting: boolean) {
    this.hasSupport = supporting
  }

  /**
   * Correction scale for this substep (0..1). Advances recover→follow
   * when the ramp completes AND tracking error is small: a big knock
   * must crawl home under the gentle recover cap, not graduate early
   * into full follow authority (pop). errM defaults to 0 (old behavior)
   * so pure unit tests are unaffected. Counts suppressed substeps.
   */
  factor(nowMs: number, errM = 0): number {
    if (this.mode === "follow") return 1
    if (this.mode === "contact") {
      this.suppressedSubsteps++
      return 0
    }
    const t = (nowMs - this.recoverStartMs) / RECOVER_RAMP_MS
    if (t >= 1 && errM < RECOVER_FOLLOW_ERR_M) {
      this.mode = "follow"
      this.transitions++
      return 1
    }
    this.suppressedSubsteps++
    return t <= 0 ? 0 : t >= 1 ? 1 : t
  }

  /** 0..1 recovery progress for diagnostics (1 when not recovering). */
  recoverT(nowMs: number): number {
    if (this.mode !== "recover") return 1
    const t = (nowMs - this.recoverStartMs) / RECOVER_RAMP_MS
    return t <= 0 ? 0 : t >= 1 ? 1 : t
  }
}

/**
 * Clamp the change of the correction vector to maxDelta magnitude.
 * Writes the applied correction into `out`, returns its magnitude.
 * Pure — no Rapier, no clock.
 */
export function clampCorrectionDelta(
  prevX: number, prevY: number, prevZ: number,
  targetX: number, targetY: number, targetZ: number,
  maxDelta: number,
  out: { x: number; y: number; z: number },
): number {
  let dx = targetX - prevX
  let dy = targetY - prevY
  let dz = targetZ - prevZ
  const len = Math.sqrt(dx * dx + dy * dy + dz * dz)
  if (len > maxDelta && len > 0) {
    const s = maxDelta / len
    dx *= s
    dy *= s
    dz *= s
  }
  out.x = prevX + dx
  out.y = prevY + dy
  out.z = prevZ + dz
  return Math.sqrt(out.x * out.x + out.y * out.y + out.z * out.z)
}
