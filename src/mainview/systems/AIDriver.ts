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
  escapePressed: false,
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

export interface TrafficEntry {
  body: RAPIER.RigidBody
  x: number
  z: number
}

export interface AIProfile {
  /** 0 = cautious, 1 = late braking / full send. */
  aggression: number
  /** Seconds of reaction lag on the steering. */
  reaction: number
  /** Persistent lateral offset from the racing line, metres. */
  laneBias: number
  /** Unique seed so identical setups don't drive identically. */
  seed: number
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

/**
 * Pure-pursuit driver. It only writes a DriveInput — the car is still a
 * full CarController, so grip, braking, and collisions stay physical.
 */
export class AIDriver {
  throttle = 0
  brake = 0
  steer = 0
  private stuck = 0
  private wobble = 0
  // Unstick maneuver state. No teleporting: a stuck car shifts itself
  // into reverse (real R gear via the manual box), backs out, then
  // shifts back up and carries on.
  private mode: "drive" | "waitGear" | "toReverse" | "reversing" | "toDrive" =
    "drive"
  private modeT = 0
  private seqStep = 0

  constructor(readonly profile: AIProfile) {}

  /** True while running the reverse-out maneuver (needs full-rate updates). */
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
    const look = clamp(18 + speed * 0.85, 16, 72)
    const targetS = s + look
    const cx = roadCenterX(targetS)
    const yaw = roadYaw(targetS)
    const nx = Math.cos(yaw)
    const nz = Math.sin(yaw)
    let tx = cx + nx * this.profile.laneBias
    let tz = -targetS + nz * this.profile.laneBias

    // Chaos: race the cars, not just the line. Nearest opponent inside
    // 26 m gets a lunge — dive at the rear bumper of anything ahead,
    // squeeze anything alongside. Weight scales with aggression and
    // proximity, so packed grids brawl and clean air stays clean.
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
    if (bestD < 26) {
      const prox = clamp(1 - bestD / 26, 0, 1)
      if (bestLong > 2) {
        const w = Math.min(1, prox * (0.4 + ag))
        tx += (bestX - tx) * w
        tz += (bestZ - tz) * w
      } else if (Math.abs(bestLat) < 4.5) {
        const w = Math.min(1, prox * ag * 0.8)
        tx += Math.sign(bestLat) * 3.5 * w
      }
    }

    const dx = tx - p.x
    const dz = tz - p.z
    const desired = Math.atan2(dx, -dz)
    let err = wrapPi(desired - heading)

    this.wobble += dt * (1.7 + (this.profile.seed % 1))
    err += Math.sin(this.wobble + this.profile.seed) * 0.012

    // steer +1 = left (KeyA). desired-heading > 0 means the target is
    // to the right (+x when facing -z), so the sign flips here.
    const steerTarget = clamp(-err / 0.42, -1, 1)
    const steerRate = 1 / Math.max(0.05, this.profile.reaction)
    this.steer += clamp(
      steerTarget - this.steer,
      -steerRate * dt,
      steerRate * dt,
    )

    const curv =
      Math.abs(wrapPi(roadYaw(s + 40) - roadYaw(s))) +
      Math.abs(wrapPi(roadYaw(s + 80) - roadYaw(s + 40))) * 0.5
    // No cruise cap: flat-out everywhere, exactly like holding W in the
    // player car. Top speed is whatever the shared engine/drag gives.
    // The only braking is what a driver must do: gather it up when off
    // the line, and shed speed for bends from curvature (v = sqrt(aLat/κ)).
    let throttleTarget = 1
    let brakeTarget = 0
    if (Math.abs(err) > 0.7) {
      throttleTarget = 0.35
      brakeTarget = 0.3
    } else {
      const kappa = Math.max(1e-4, curv / 40)
      const aLat = 38 + ag * 30
      const vBendKmh = (Math.sqrt(aLat / kappa) * 3.6)
      if (speedKmh > vBendKmh) {
        throttleTarget = 0.25
        brakeTarget = clamp((speedKmh - vBendKmh) / 25, 0.25, 1)
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

  /**
   * Drive itself out: hold still until the auto box has walked down to
   * 1st, flip to the manual box, shift 1→N→R, reverse out while swinging
   * the nose toward the road, then shift R→N→1 and hand back to auto.
   * Edges are spaced 0.25 s apart (manual shift time is 0.08 s).
   */
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
        // Let the auto box settle to 1st (it downshifts below 5 km/h).
        if (car.gear === 1 || this.modeT > 1.5) {
          this.mode = "toReverse"
          this.modeT = 0
          this.seqStep = 0
        }
        return base
      }
      case "toReverse": {
        // toggle auto→manual, then 1→N→R.
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
        // Back out with mirrored steering so the nose swings toward the
        // road (yaw rate flips sign in reverse).
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
        // R→N→1, then manual→auto.
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

  /** Signed heading error to the lookahead point (with wobble). */
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
    const targetS = s + look
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

/** Copy of an AI input with one-shot edges cleared for repeat application. */
export function stripEdges(inp: DriveInput): DriveInput {
  return { ...inp, ...ZERO_EDGES }
}

export function carProgress(body: RAPIER.RigidBody): number {
  return -body.translation().z
}
