import * as THREE from "three"
import type * as RAPIER from "@dimforge/rapier3d-compat"
import type { DriveInput } from "./InputManager"
import type { CarController } from "./CarController"
import { roadCenterX, roadYaw } from "./WorldManager"

export const ZERO_EDGES = {
  upshiftPressed: false,
  downshiftPressed: false,
  toggleModePressed: false,
  toggleLaunchPressed: false,
  toggleParkPressed: false,
  resetPressed: false,
  toggleCameraPressed: false,
  startPressed: false,
  pausePressed: false,
} as const

const _fwd = new THREE.Vector3()
const _right = new THREE.Vector3()
const _quat = new THREE.Quaternion()

function clamp(v: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, v))
}

function wrapPi(a: number) {
  while (a > Math.PI) a -= Math.PI * 2
  while (a < -Math.PI) a += Math.PI * 2
  return a
}

function farThreat(
  traffic: TrafficEntry[],
  selfBody: RAPIER.RigidBody,
  s: number,
  dir: 1 | -1,
  windowM: number,
): boolean {
  for (const t of traffic) {
    if (t.body === selfBody) continue
    const tp = t.body.translation()
    const ts = -tp.z
    const ahead = dir * (ts - s)
    if (ahead <= 2) continue
    const lv = t.body.linvel()
    const corr = Math.max(windowM, 25 + Math.hypot(lv.x, lv.z) * 3.6 * 1.1)
    if (ahead > corr) continue
    const lat = (tp.x - roadCenterX(ts)) * Math.cos(roadYaw(ts))
    if (lat * dir > -0.2) continue
    return true
  }
  return false
}

export interface TrafficEntry {
  body: RAPIER.RigidBody
  x: number
  z: number
}

export interface AIProfile {
  aggression: number
  reaction: number
  laneBias: number
  seed: number
  cruiseKmh?: number
  dir?: 1 | -1
}

export function makeProfile(index: number): AIProfile {
  const n = index + 1
  return {
    aggression: clamp(0.55 + ((n * 37) % 40) / 100, 0.55, 0.95),
    reaction: 0.04 + ((n * 13) % 8) / 100,
    laneBias: (((n * 17) % 7) - 3) * 0.55,
    seed: n * 17.13,
  }
}

export function makeTrafficProfile(
  rng: () => number,
  dir: 1 | -1 = 1,
): AIProfile {
  const roll = rng()
  const cruiseKmh =
    roll < 0.3
      ? 65 + rng() * 20
      : roll < 0.8
        ? 95 + rng() * 30
        : 135 + rng() * 30
  const outer = dir === 1 ? 6.0 : -6.0
  const inner = dir === 1 ? 2.0 : -2.0
  const lane = cruiseKmh < 105 ? outer : inner
  return {
    aggression: 0.3 + rng() * 0.3,
    reaction: 0.08 + rng() * 0.07,
    laneBias: lane + (rng() - 0.5) * 0.3,
    seed: rng() * 100,
    cruiseKmh,
    dir,
  }
}

let crossingBody: RAPIER.RigidBody | null = null

export class AIDriver {
  throttle = 0
  brake = 0
  steer = 0
  private stuck = 0
  private wobble = 0
  private mode: "drive" | "waitGear" | "toReverse" | "reversing" | "toDrive" =
    "drive"
  private modeT = 0
  private seqStep = 0
  private offroad = false
  private ovtT = 0
  private ovtLat = 0
  private ovtBody: RAPIER.RigidBody | null = null

  constructor(readonly profile: AIProfile) {}

  get recovering(): boolean {
    return this.mode !== "drive"
  }

  drive(car: CarController, traffic: TrafficEntry[], dt: number): DriveInput {
    const body = car.body
    const p = body.translation()
    const s = -p.z
    const speedNow = car.forwardSpeed

    if (this.mode === "drive") {
      if (Math.abs(speedNow) < 1.0) {
        this.stuck += dt
      } else {
        this.stuck = Math.max(0, this.stuck - dt * 2)
      }
      if (this.stuck > 1.2) {
        this.stuck = 0
        this.mode = "waitGear"
        this.modeT = 0
      }
    }

    if (this.mode !== "drive") {
      return this.unstick(car, dt)
    }
    const speed = Math.max(0, speedNow)
    const speedKmh = speed * 3.6

    const r = body.rotation()
    _quat.set(r.x, r.y, r.z, r.w)
    _fwd.set(0, 0, -1).applyQuaternion(_quat)
    _right.set(1, 0, 0).applyQuaternion(_quat)
    const heading = Math.atan2(_fwd.x, -_fwd.z)

    const ag = this.profile.aggression
    const cruising = this.profile.cruiseKmh
    const dir = this.profile.dir ?? 1
    const curv =
      Math.abs(wrapPi(roadYaw(s + dir * 40) - roadYaw(s))) +
      Math.abs(wrapPi(roadYaw(s + dir * 80) - roadYaw(s + dir * 40))) * 0.5
    const look = clamp((18 + speed * 0.85) / (1 + curv * 1.2), 10, 72)
    const targetS = s + dir * look
    const cx = roadCenterX(targetS)
    const yaw = roadYaw(targetS)
    const nx = Math.cos(yaw)
    const nz = Math.sin(yaw)
    let tx = cx + nx * this.profile.laneBias
    let tz = -targetS + nz * this.profile.laneBias

    let clat = 0
    if (cruising != null) {
      clat = (p.x - roadCenterX(s)) * Math.cos(roadYaw(s))
    }
    if (cruising != null) {
      if (!this.offroad && Math.abs(clat) > 7.0) this.offroad = true
      else if (this.offroad && Math.abs(clat) < 5.2) this.offroad = false
    } else {
      this.offroad = false
    }

    let bestD = 26
    let bestLong = 0
    let bestLat = 0
    let bestX = 0
    let bestZ = 0
    for (const t of traffic) {
      if (t.body === body) continue
      const rx = t.x - p.x
      const rz = t.z - p.z
      const d = Math.hypot(rx, rz)
      if (d >= bestD) continue
      bestD = d
      bestLong = rx * _fwd.x + rz * _fwd.z
      bestLat = rx * _right.x + rz * _right.z
      bestX = t.x
      bestZ = t.z
    }
    let followD = Infinity
    let followV = 0
    let followBody: RAPIER.RigidBody | null = null
    let blocked = false
    let blockLong = Infinity
    let blockLat = 0
    let passRoadLat: number | null = null
    if (cruising != null) {
      for (const t of traffic) {
        if (t.body === body) continue
        const rx = t.x - p.x
        const rz = t.z - p.z
        const long = rx * _fwd.x + rz * _fwd.z
        if (long < 1 || long > 45) continue
        const lat = rx * _right.x + rz * _right.z
        if (Math.abs(lat) > 2.6) continue
        const lv = t.body.linvel()
        const v = Math.hypot(lv.x, lv.z) * 3.6
        if (long < followD) {
          followD = long
          followV = v
          followBody = t.body
        }
        if (long < 35 && Math.abs(lat) < 2.0 && v < 8) {
          if (!blocked || long < blockLong) {
            blocked = true
            blockLong = long
            blockLat = lat
          }
        }
      }
    }
    if (bestD < 26) {
      const prox = clamp(1 - bestD / 26, 0, 1)
      if (bestLong > 2) {
        if (cruising != null) {
          if (!blocked && this.ovtT === 0 && Math.abs(bestLat) < 2.6) {
            const side =
              Math.sign(bestLat) ||
              (Math.sin(this.wobble * 0.7 + this.profile.seed) >= 0 ? 1 : -1)
            const w = Math.min(1, prox * 0.9)
            tx += -side * 2.6 * w
          } else if (blocked) {
            const myLat = clat
            const bLat = myLat + dir * blockLat
            const hlo = dir === 1 ? 0.4 : -6.4
            const hhi = dir === 1 ? 6.4 : -0.4
            const clearA = bLat - 0.9 - hlo
            const clearB = hhi - (bLat + 0.9)
            if (clearA > 2.1 && clearA >= clearB) passRoadLat = hlo + 1.1
            else if (clearB > 2.1) passRoadLat = hhi - 1.1
            if (passRoadLat != null) {
              tx = cx + nx * passRoadLat
              tz = -targetS + nz * passRoadLat
            }
          }
        } else {
          const w = Math.min(1, prox * (0.4 + ag))
          tx += (bestX - tx) * w
          tz += (bestZ - tz) * w
        }
      } else if (Math.abs(bestLat) < 4.5) {
        const w = Math.min(1, prox * (cruising != null ? ag * 0.4 : ag * 0.8))
        tx += Math.sign(bestLat) * 3.5 * w
      }
    }
    if (cruising != null) {
      if (this.offroad) {
        const home = dir === 1 ? 3.5 : -3.5
        tx = cx + home
        tz = -targetS + nz * home
      }
      if (this.ovtT > 0) {
        this.ovtT -= dt
        const obP = this.ovtBody?.translation()
        if (!obP || this.offroad) {
          this.ovtT = 0
          if (crossingBody === body) crossingBody = null
          this.ovtBody = null
        } else {
          const obS = -obP.z
          const oLong = dir * (obS - s)
          if (
            oLong < -3 ||
            farThreat(traffic, body, s, dir, 18 + speed * 0.5)
          ) {
            this.ovtT = Math.min(this.ovtT, 1.2)
            this.ovtLat = dir * 2.0
            if (crossingBody === body) crossingBody = null
            this.ovtBody = null
          } else {
            crossingBody = body
            tx = cx + nx * this.ovtLat
            tz = -targetS + nz * this.ovtLat
          }
        }
      } else if (
        this.ovtBody === null &&
        !blocked &&
        !this.offroad &&
        followD < 40 &&
        followBody != null &&
        followV > 5 &&
        followV < cruising - 12 &&
        speed > 6 &&
        (crossingBody == null || crossingBody === body) &&
        !farThreat(traffic, body, s, dir, 40 + speed * 1.2)
      ) {
        this.ovtBody = followBody
        this.ovtT = Math.min(22, 10 + followD / Math.max(6, speed))
        this.ovtLat = -dir * 2.4
      }
      if (this.ovtT > 0 || passRoadLat != null) {
        tx = clamp(tx, cx - 6.4, cx + 6.4)
      } else {
        const lo = dir === 1 ? cx + 0.4 : cx - 6.4
        const hi = dir === 1 ? cx + 6.4 : cx - 0.4
        tx = clamp(tx, lo, hi)
      }
    }

    const dx = tx - p.x
    const dz = tz - p.z
    const desired = Math.atan2(dx, -dz)
    let err = wrapPi(desired - heading)

    this.wobble += dt * (1.7 + (this.profile.seed % 1))
    err += Math.sin(this.wobble + this.profile.seed) * 0.012

    let steerTarget = clamp(-err / 0.42, -1, 1)
    if (cruising != null) {
      const latRef =
        this.ovtT > 0
          ? this.ovtLat
          : (passRoadLat ?? (this.offroad ? dir * 3.5 : this.profile.laneBias))
      const latErr = clat - latRef
      steerTarget = clamp(
        steerTarget +
          clamp((dir * 0.9 * latErr) / Math.max(6, speed), -0.3, 0.3),
        -1,
        1,
      )
    }
    const steerRate = 1 / Math.max(0.05, this.profile.reaction)
    this.steer += clamp(
      steerTarget - this.steer,
      -steerRate * dt,
      steerRate * dt,
    )

    let throttleTarget = 1
    let brakeTarget = 0
    if (Math.abs(err) > 0.7) {
      throttleTarget = 0.35
      brakeTarget = 0.3
    } else {
      const kappa = Math.max(1e-4, curv / 40)
      const aLat = 38 + ag * 30
      const vBendKmh = Math.sqrt(aLat / kappa) * 3.6
      if (speedKmh > vBendKmh) {
        throttleTarget = 0.25
        brakeTarget = clamp((speedKmh - vBendKmh) / 25, 0.25, 1)
      }
    }
    if (cruising != null) {
      if (this.offroad) {
        throttleTarget = Math.min(throttleTarget, 0.4)
        if (speedKmh > 60) {
          throttleTarget = 0
          brakeTarget = Math.max(brakeTarget, 0.4)
        }
      }
      if (speedKmh > cruising + 4) {
        throttleTarget = 0
        brakeTarget = Math.max(
          brakeTarget,
          clamp((speedKmh - cruising) / 18, 0.15, 0.6),
        )
      } else if (speedKmh > cruising - 8) {
        throttleTarget = Math.min(throttleTarget, 0.3)
      }
      if (this.ovtT > 0 && this.ovtBody != null && speedKmh < cruising + 12) {
        throttleTarget = Math.max(throttleTarget, 0.55)
      }
      if (
        followD < 40 &&
        !(blocked && passRoadLat != null) &&
        this.ovtBody !== followBody
      ) {
        const allow = Math.min(cruising, followV + 6)
        if (speedKmh > allow) {
          throttleTarget = 0
          brakeTarget = Math.max(
            brakeTarget,
            clamp((speedKmh - allow) / 15, 0.12, 0.7) +
              (followD < 10 ? 0.5 : 0),
          )
        }
      }
      if (blocked) {
        if (passRoadLat != null) {
          const creep = followD > 20 ? 30 : followD > 10 ? 15 : 6
          if (speedKmh > creep + 2) {
            throttleTarget = 0
            brakeTarget = Math.max(
              brakeTarget,
              clamp((speedKmh - creep) / 12, 0.15, 0.6),
            )
          } else {
            throttleTarget = Math.min(Math.max(throttleTarget, 0.3), 0.6)
          }
        } else {
          throttleTarget = 0
          brakeTarget =
            followD > 9
              ? Math.max(brakeTarget, clamp(speedKmh / 20, 0.15, 0.8))
              : 1
        }
      }
    }

    const pedal = 5
    this.throttle += clamp(
      throttleTarget - this.throttle,
      -pedal * dt,
      pedal * dt,
    )
    this.brake += clamp(brakeTarget - this.brake, -pedal * dt, pedal * dt)

    return {
      throttle: this.throttle,
      brake: this.brake,
      steer: this.steer,
      handbrake: false,
      ...ZERO_EDGES,
    }
  }

  private unstick(car: CarController, dt: number): DriveInput {
    this.modeT += dt
    const base = {
      throttle: 0,
      brake: 0.6,
      steer: this.steer,
      handbrake: false,
      ...ZERO_EDGES,
    } as DriveInput

    switch (this.mode) {
      case "waitGear": {
        if (car.gear === 1 || this.modeT > 1.5) {
          this.mode = "toReverse"
          this.modeT = 0
          this.seqStep = 0
        }
        return base
      }
      case "toReverse": {
        if (this.modeT > this.seqStep * 0.25) {
          this.seqStep++
          if (this.seqStep === 1) return { ...base, toggleModePressed: true }
          if (this.seqStep === 2) return { ...base, downshiftPressed: true }
          if (this.seqStep === 3) return { ...base, downshiftPressed: true }
          this.mode = "reversing"
          this.modeT = 0
        }
        return base
      }
      case "reversing": {
        const err = this.headingError(car, dt)
        const revSteer = clamp(err / 0.42, -1, 1)
        const rate = 1 / Math.max(0.05, this.profile.reaction)
        this.steer += clamp(revSteer - this.steer, -rate * dt, rate * dt)
        this.throttle = Math.min(1, this.throttle + 5 * dt)
        this.brake = 0
        if (this.modeT > 1.3) {
          this.mode = "toDrive"
          this.modeT = 0
          this.seqStep = 0
        }
        return {
          throttle: this.throttle,
          brake: 0,
          steer: this.steer,
          handbrake: false,
          ...ZERO_EDGES,
        }
      }
      case "toDrive": {
        if (this.modeT > this.seqStep * 0.25) {
          this.seqStep++
          if (this.seqStep === 1) return { ...base, upshiftPressed: true }
          if (this.seqStep === 2) return { ...base, upshiftPressed: true }
          if (this.seqStep === 3) return { ...base, toggleModePressed: true }
          this.mode = "drive"
          this.modeT = 0
          this.stuck = 0
        }
        return base
      }
      default:
        this.mode = "drive"
        return base
    }
  }

  private headingError(car: CarController, dt: number): number {
    const body = car.body
    const p = body.translation()
    const s = -p.z
    const speed = Math.max(0, car.forwardSpeed)
    const r = body.rotation()
    _quat.set(r.x, r.y, r.z, r.w)
    _fwd.set(0, 0, -1).applyQuaternion(_quat)
    const heading = Math.atan2(_fwd.x, -_fwd.z)
    const look = clamp(18 + speed * 0.85, 16, 72)
    const targetS = s + (this.profile.dir ?? 1) * look
    const cx = roadCenterX(targetS)
    const yaw = roadYaw(targetS)
    const tx = cx + Math.cos(yaw) * this.profile.laneBias
    const tz = -targetS + Math.sin(yaw) * this.profile.laneBias
    const desired = Math.atan2(tx - p.x, -(tz - p.z))
    this.wobble += dt * (1.7 + (this.profile.seed % 1))
    return (
      wrapPi(desired - heading) +
      Math.sin(this.wobble + this.profile.seed) * 0.012
    )
  }
}

export function holdInput(): DriveInput {
  return {
    throttle: 0,
    brake: 1,
    steer: 0,
    handbrake: true,
    ...ZERO_EDGES,
  }
}

export function stripEdges(inp: DriveInput): DriveInput {
  return { ...inp, ...ZERO_EDGES }
}

export function carProgress(body: RAPIER.RigidBody): number {
  return -body.translation().z
}
