/**
 * Timing model (Phase 2):
 *
 * - `t` is stamped with the SENDER's `performance.now()`. It lives in the
 *   sender's clock domain and MUST NOT be compared with the receiver's
 *   `performance.now()`. It is preserved for diagnostics only.
 * - Freshness/age is measured from LOCAL packet arrival time
 *   (receiver's monotonic clock at `handleStatePacket` entry).
 * - Ordering is defined by `seq` alone, never by `t`.
 *
 * Session model:
 *
 * - `seq` is monotonic within one sender session (one room join). It
 *   restarts at 0 on every join; `sess` (random per join) disambiguates
 *   a new session from delayed traffic of an old one.
 * - `sess` is additive and optional: packets without it are treated as
 *   legacy and ordered by `seq` only.
 */
export interface CarStatePacket {
  id: string
  t: number // sender-local performance.now(); diagnostics only, alien clock domain
  seq: number // per-session monotonic sequence (restarts at 0 each join)
  sess?: string // sender session id (per join); absent = legacy sender
  // Position
  x: number
  y: number
  z: number
  // Orientation quaternion
  qx: number
  qy: number
  qz: number
  qw: number
  // Linear velocity for dead-reckoning extrapolation
  vx: number
  vy: number
  vz: number
  // Driving telemetry
  steer: number
  speed: number // km/h or m/s
  rpm: number
  gear: number
  drift: boolean
  smoke: boolean
  progress: number
}

export type NetworkEventType =
  | "HELLO"
  | "READY"
  | "START_RACE"
  | "FINISH_RACE"
  | "PING"
  | "PONG"
  | "DENY"

export interface NetworkEventPacket {
  type: NetworkEventType
  senderId: string
  t: number
  payload?: any
}

export interface PeerPlayer {
  id: string
  name: string
  color: number
  colorHex: string
  /** Car registry id from the peer's HELLO (undefined = legacy/M3). */
  carId?: string
  pingMs: number
  ready: boolean
  isHost: boolean
  lastSeen: number
  progress: number
  finished: boolean
  finishTime: number | null
}
