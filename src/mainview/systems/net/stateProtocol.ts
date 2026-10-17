
const POS_ABS_MAX = 100_000
const VEL_COMP_MAX = 150
const STEER_MAX = 2.0
const SPEED_ABS_MAX = 500
const RPM_MIN = 0
const RPM_MAX = 9000
const GEAR_MIN = -1
const GEAR_MAX = 8
const PROGRESS_MIN = -10_000
const PROGRESS_MAX = 1_000_000_000
const QUAT_NORM_SQ_MIN = 1e-6
const QUAT_NORM_SQ_MAX = 16

export interface ValidatedState {
  id: string
  senderT: number
  seq: number
  sess: string | null
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
  steer: number
  speed: number
  rpm: number
  gear: number
  drift: boolean
  smoke: boolean
  progress: number
}

export type ValidateFailure =
  | { ok: false; reason: string }
  | { ok: true; state: ValidatedState }

function isFiniteNum(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v)
}

export function validateStatePacket(pkt: unknown): ValidateFailure {
  if (!pkt || typeof pkt !== "object" || Array.isArray(pkt)) {
    return { ok: false, reason: "malformed-envelope" }
  }
  const p = pkt as Record<string, unknown>

  if (typeof p["id"] !== "string" || p["id"].length === 0 || p["id"].length > 128) {
    return { ok: false, reason: "bad-id" }
  }
  if (!isFiniteNum(p["t"])) {
    return { ok: false, reason: "bad-t" }
  }
  if (!Number.isInteger(p["seq"]) || (p["seq"] as number) < 0 || (p["seq"] as number) > Number.MAX_SAFE_INTEGER) {
    return { ok: false, reason: "bad-seq" }
  }
  const sessRaw = p["sess"]
  let sess: string | null = null
  if (sessRaw !== undefined) {
    if (typeof sessRaw !== "string" || sessRaw.length === 0 || sessRaw.length > 64) {
      return { ok: false, reason: "bad-sess" }
    }
    sess = sessRaw
  }

  for (const k of ["x", "y", "z"] as const) {
    const v = p[k]
    if (!isFiniteNum(v) || Math.abs(v) > POS_ABS_MAX) {
      return { ok: false, reason: "bad-pos" }
    }
  }

  const qx = p["qx"]
  const qy = p["qy"]
  const qz = p["qz"]
  const qw = p["qw"]
  if (!isFiniteNum(qx) || !isFiniteNum(qy) || !isFiniteNum(qz) || !isFiniteNum(qw)) {
    return { ok: false, reason: "bad-quat" }
  }
  const normSq = qx * qx + qy * qy + qz * qz + qw * qw
  if (!(normSq >= QUAT_NORM_SQ_MIN && normSq <= QUAT_NORM_SQ_MAX)) {
    return { ok: false, reason: "bad-quat" }
  }
  const invNorm = 1 / Math.sqrt(normSq)

  for (const k of ["vx", "vy", "vz"] as const) {
    const v = p[k]
    if (!isFiniteNum(v) || Math.abs(v) > VEL_COMP_MAX) {
      return { ok: false, reason: "bad-vel" }
    }
  }

  if (!isFiniteNum(p["steer"]) || Math.abs(p["steer"] as number) > STEER_MAX) {
    return { ok: false, reason: "bad-steer" }
  }
  if (!isFiniteNum(p["speed"]) || Math.abs(p["speed"] as number) > SPEED_ABS_MAX) {
    return { ok: false, reason: "bad-speed" }
  }
  if (!isFiniteNum(p["rpm"]) || (p["rpm"] as number) < RPM_MIN || (p["rpm"] as number) > RPM_MAX) {
    return { ok: false, reason: "bad-rpm" }
  }
  if (!Number.isInteger(p["gear"]) || (p["gear"] as number) < GEAR_MIN || (p["gear"] as number) > GEAR_MAX) {
    return { ok: false, reason: "bad-gear" }
  }
  if (typeof p["drift"] !== "boolean" || typeof p["smoke"] !== "boolean") {
    return { ok: false, reason: "bad-flags" }
  }
  if (!isFiniteNum(p["progress"]) || (p["progress"] as number) < PROGRESS_MIN || (p["progress"] as number) > PROGRESS_MAX) {
    return { ok: false, reason: "bad-progress" }
  }

  return {
    ok: true,
    state: {
      id: p["id"] as string,
      senderT: p["t"] as number,
      seq: p["seq"] as number,
      sess,
      x: p["x"] as number,
      y: p["y"] as number,
      z: p["z"] as number,
      qx: (qx as number) * invNorm,
      qy: (qy as number) * invNorm,
      qz: (qz as number) * invNorm,
      qw: (qw as number) * invNorm,
      vx: p["vx"] as number,
      vy: p["vy"] as number,
      vz: p["vz"] as number,
      steer: p["steer"] as number,
      speed: p["speed"] as number,
      rpm: p["rpm"] as number,
      gear: p["gear"] as number,
      drift: p["drift"] as boolean,
      smoke: p["smoke"] as boolean,
      progress: p["progress"] as number,
    },
  }
}

export type SeqDecision =
  | "accept-initial"
  | "accept"
  | "reject-duplicate"
  | "reject-stale"
  | "reject-stale-session"

export function isAccept(dec: SeqDecision): boolean {
  return dec === "accept-initial" || dec === "accept"
}

interface SessionEntry {
  sess: string | null
  lastSeq: number
}

export class PeerSessionTracker {
  private entries = new Map<string, SessionEntry>()

  evaluate(peerId: string, sess: string | null, seq: number): SeqDecision {
    const e = this.entries.get(peerId)
    if (!e) {
      this.entries.set(peerId, { sess, lastSeq: seq })
      return "accept-initial"
    }
    if (sess !== e.sess) {
      if (sess === null || e.sess === null) {
        if (seq === e.lastSeq) return "reject-duplicate"
        if (seq < e.lastSeq) return "reject-stale"
        e.lastSeq = seq
        return "accept"
      }
      return "reject-stale-session"
    }
    if (e.lastSeq < 0) {
      e.lastSeq = seq
      return "accept-initial"
    }
    if (seq === e.lastSeq) return "reject-duplicate"
    if (seq < e.lastSeq) return "reject-stale"
    e.lastSeq = seq
    return "accept"
  }

  noteSession(peerId: string, sess: unknown): void {
    if (typeof sess !== "string" || sess.length === 0 || sess.length > 64) return
    const e = this.entries.get(peerId)
    if (!e) {
      this.entries.set(peerId, { sess, lastSeq: -1 })
    } else if (e.sess !== sess) {
      e.sess = sess
      e.lastSeq = -1
    }
  }

  lastSeq(peerId: string): number {
    return this.entries.get(peerId)?.lastSeq ?? -1
  }

  reset(peerId: string): void {
    this.entries.delete(peerId)
  }

  clear(): void {
    this.entries.clear()
  }
}

export function newSessionId(): string {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789"
  let s = ""
  for (let i = 0; i < 12; i++) {
    s += chars[(Math.random() * chars.length) | 0]
  }
  return s
}
