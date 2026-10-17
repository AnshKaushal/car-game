
export type CorrectionMode = "follow" | "contact" | "recover"

export const CORRECTION_ACCEL_MAX = 25

export const CONTACT_GRACE_MS = 300
export const HARD_IMPACT_GRACE_MS = 400
export const IMPACT_IMPULSE_THRESHOLD = 2000
export const RECOVER_RAMP_MS = 400
export const RECOVER_FOLLOW_ERR_M = 0.65
export const RECOVER_WARP_M = 30

export const RECOVER_CORR_MAX = 3
export const SUPPORT_DESCENT_DY = -0.5

export class CorrectionState {
  mode: CorrectionMode = "follow"
  inContact = false
  impactImpulse = 0
  hasSupport = false
  suppressedSubsteps = 0
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
        this.impactImpulse = 0
        this.hardHit = false
      }
    }
  }

  noteSupport(supporting: boolean) {
    this.hasSupport = supporting
  }

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

  recoverT(nowMs: number): number {
    if (this.mode !== "recover") return 1
    const t = (nowMs - this.recoverStartMs) / RECOVER_RAMP_MS
    return t <= 0 ? 0 : t >= 1 ? 1 : t
  }
}

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
