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

/**
 * BeamNG-style far-half check: is anything driving in the opposite
 * half ahead inside the corridor we'd need to cross the centre line?
 * windowM is the corridor length in metres; each candidate's own speed
 * also stretches the minimum safe look-ahead (fast oncomers demand
 * bigger gaps).
 */
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
    if (lat * dir > -0.2) continue // own half: not in our crossing path
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
  /** 0 = cautious, 1 = late braking / full send. */
  aggression: number
  /** Seconds of reaction lag on the steering. */
  reaction: number
  /** Persistent lateral offset from the racing line, metres. */
  laneBias: number
  /** Unique seed so identical setups don't drive identically. */
  seed: number
  /**
   * Cruise cap for ambient traffic (km/h). Absent = flat-out race pace.
   * Capped cars also follow slower vehicles and steer around them
   * instead of dive-bombing like racers.
   */
  cruiseKmh?: number
  /**
   * Travel direction along the road: 1 = with increasing s (same way
   * as the player), -1 = oncoming. Absent = 1. Only used by traffic.
   */
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

/**
 * BeamNG-style traffic driver: slow dawdlers, steady commuters, and
 * the odd speeder — 2 lanes per direction (inner at ±2.0, outer at
 * ±6.0 of the 8 m half-wide road). Lane assignment is by cruise
 * speed: everything under 105 km/h keeps to the outer lane, faster
 * cars take the inner lane. Mirrored for oncoming (their right side
 * is -x). Jitter is a tiny ±0.15 m so lanes read as painted.
 */
export function makeTrafficProfile(
  rng: () => number,
  dir: 1 | -1 = 1,
): AIProfile {
  const roll = rng()
  const cruiseKmh =
    roll < 0.3
      ? 65 + rng() * 20 // dawdlers: 65–85
      : roll < 0.8
        ? 95 + rng() * 30 // commuters: 95–125
        : 135 + rng() * 30 // speeders: 135–165
  const outer = dir === 1 ? 6.0 : -6.0
  const inner = dir === 1 ? 2.0 : -2.0
  const lane = cruiseKmh < 105 ? outer : inner
  return {
    aggression: 0.3 + rng() * 0.3,
    reaction: 0.08 + rng() * 0.07,
    // Painted-lane discipline: lock to the lane centre line.
    laneBias: lane + (rng() - 0.5) * 0.3,
    seed: rng() * 100,
    cruiseKmh,
    dir,
  }
}

/**
 * Global crossing permit: at most ONE traffic car crosses the centre
 * line at a time. Neighbouring cars all see the same slow car and
 * without this they pull out simultaneously and merge into each other.
 */
let crossingBody: RAPIER.RigidBody | null = null

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
  /** Off-asphalt recovery latch (traffic only, with rejoin hysteresis). */
  private offroad = false
  /** Cross-centre-line overtake commit (traffic only, seconds left). */
  private ovtT = 0
  /** Road-frame lateral target while overtaking. */
  private ovtLat = 0
  /** Slow car we pulled out to pass. */
  private ovtBody: RAPIER.RigidBody | null = null

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
    const cruising = this.profile.cruiseKmh
    const dir = this.profile.dir ?? 1
    // Upcoming curvature (total yaw over the next ~80 m). Shortens the
    // look-ahead through bends so the aim point stays inside the curve
    // instead of latching onto the far edge — this is half of why the
    // lane discipline holds on corners; the Stanley term is the other.
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

    // Lane sensor (traffic only): signed offset from the road centre
    // in the road frame. s is defined as -p.z, so the z delta is zero
    // and the lateral distance is just the x gap corrected for road
    // angle. Feeds both lane keeping and the off-road latch.
    let clat = 0
    if (cruising != null) {
      clat = (p.x - roadCenterX(s)) * Math.cos(roadYaw(s))
    }
    // Off-road hysteresis — declared off past 7.0 m, recovered under
    // 5.2. Thresholds sit below the physical 8 m edge by more than a
    // body half-width, so recovery starts while wheels are still on
    // asphalt.
    if (cruising != null) {
      if (!this.offroad && Math.abs(clat) > 7.0) this.offroad = true
      else if (this.offroad && Math.abs(clat) < 5.2) this.offroad = false
    } else {
      this.offroad = false
    }

    // Chaos: race the cars, not just the line. Nearest opponent inside
    // 26 m gets a lunge — dive at the rear bumper of anything ahead,
    // squeeze anything alongside. Weight scales with aggression and
    // proximity, so packed grids brawl and clean air stays clean.
    // Traffic (cruiseKmh set) does the opposite: steer AROUND the car
    // ahead to pass, squeeze away from anything alongside — unless the
    // way is blocked by something stopped, in which case it queues.
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
    // Car-following target for traffic: nearest vehicle ahead in our
    // lane corridor, with its speed. Racers ignore this (flat out).
    // A stopped vehicle in our path is a blocker: queue behind it by
    // default, or squeeze past via the roomier side when one fits.
    let followD = Infinity
    let followV = 0
    let followBody: RAPIER.RigidBody | null = null
    let blocked = false
    let blockLong = Infinity
    let blockLat = 0
    /** Road-frame lateral target for squeezing past a blocker (null = no room, hold). */
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
          // Lane check: the shallow swing only fires for a car actually
          // blocking our own lane — someone in the adjacent lane doesn't
          // get us wandering around.
          if (!blocked && this.ovtT === 0 && Math.abs(bestLat) < 2.6) {
            // Fallback: swing to the emptier side of the car ahead,
            // still inside our own half (shallow speed differences).
            const side =
              Math.sign(bestLat) ||
              (Math.sin(this.wobble * 0.7 + this.profile.seed) >= 0 ? 1 : -1)
            const w = Math.min(1, prox * 0.9)
            tx += -side * 2.6 * w
          } else if (blocked) {
            // Squeeze past the stopped blocker via the roomier side —
            // the own-half clamp below guarantees no wheels leave the
            // asphalt. If neither side fits (e.g. you're parked
            // sideways across both lanes), hold position instead.
            const myLat = clat
            const bLat = myLat + dir * blockLat
            const hlo = dir === 1 ? 0.4 : -6.4
            const hhi = dir === 1 ? 6.4 : -0.4
            const clearA = bLat - 0.9 - hlo
            const clearB = hhi - (bLat + 0.9)
            if (clearA > 2.1 && clearA >= clearB) passRoadLat = hlo + 1.1
            else if (clearB > 2.1) passRoadLat = hhi - 1.1
            // NOTE: no centre-line sweep here. In a stop-and-go queue
            // every car sees the same stopped pair and everyone would
            // pull out at once, so queues hold position instead.
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
        // Alongside: shove away from the neighbour, but traffic stays
        // polite — a half-strength nudge keeps entire interlocking
        // convoys from shoving each other off the lanes.
        const w = Math.min(
          1,
          prox * (cruising != null ? ag * 0.4 : ag * 0.8),
        )
        tx += Math.sign(bestLat) * 3.5 * w
      }
    }
    if (cruising != null) {
      if (this.offroad) {
        // Back onto the asphalt: aim at the middle of our own half.
        const home = dir === 1 ? 3.5 : -3.5
        tx = cx + home
        tz = -targetS + nz * home
      }
      // BeamNG-style overtake of slower vehicles: pull out across the
      // centre line once the far half is verifiably clear, hang out
      // there until we're past the target, then tuck back in. The
      // own-half swing above stays as the fallback for shallow gaps.
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
          // Abort while still crossing: any far-half vehicle inside
          // this shrinking window, past or not, book it back.
          if (
            oLong < -3 ||
            farThreat(traffic, body, s, dir, 18 + speed * 0.5)
          ) {
            // Past the target (or a head-on booked our lane): tuck back.
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
        followV > 5 && // never overtake parked cars / queues: follow them
        followV < cruising - 12 &&
        speed > 6 &&
        (crossingBody == null || crossingBody === body) &&
        !farThreat(traffic, body, s, dir, 40 + speed * 1.2)
      ) {
        // Commit: gap to the nearest oncoming vehicle has to cover
        // their closing speed for the length of the maneuver.
        this.ovtBody = followBody
        this.ovtT = Math.min(22, 10 + followD / Math.max(6, speed))
        this.ovtLat = -dir * 2.4
      }
      // Lateral clamping: committed overtakes and blocker sweeps get
      // the full road (the crossing goes through the far half);
      // everything else stays inside the driver's own half. The 6.4 m
      // bound keeps ~1.6 m of shy-away from the 8 m edge — car centres
      // past that put wheels on the grass even with body half-width.
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

    // steer +1 = left (KeyA). desired-heading > 0 means the target is
    // to the right (+x when facing -z), so the sign flips here.
    // Traffic adds a Stanley-style lateral term on top of the heading
    // error: the offset from the intended lane centre (or overtake /
    // squeeze path, or off-road recovery line) feeds back into the
    // steering proportional to how fast we're going. This is what
    // keeps cars painted on their lane through bends instead of
    // drifting outwards.
    let steerTarget = clamp(-err / 0.42, -1, 1)
    if (cruising != null) {
      const latRef =
        this.ovtT > 0
          ? this.ovtLat
          : (passRoadLat ?? (this.offroad ? dir * 3.5 : this.profile.laneBias))
      // positive = car sits right of the intended line → steer left.
      // dir factors the road-frame error into driver-frame steering:
      // an oncoming car that must shift toward -x steers right.
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

    // No cruise cap: flat-out everywhere, exactly like holding W in the
    // player car. Top speed is whatever the shared engine/drag gives.
    // The only braking is what a driver must do: gather it up when off
    // the line, and shed speed for bends from curvature (v = sqrt(aLat/κ)).
    // `curv` was computed up top for the look-ahead.
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
    if (cruising != null) {
      if (this.offroad) {
        // Crawling back to the asphalt: cap speed until rejoining.
        throttleTarget = Math.min(throttleTarget, 0.4)
        if (speedKmh > 60) {
          throttleTarget = 0
          brakeTarget = Math.max(brakeTarget, 0.4)
        }
      }
      // Cruise cap: ease off approaching the cap, brake past it.
      if (speedKmh > cruising + 4) {
        throttleTarget = 0
        brakeTarget = Math.max(
          brakeTarget,
          clamp((speedKmh - cruising) / 18, 0.15, 0.6),
        )
      } else if (speedKmh > cruising - 8) {
        throttleTarget = Math.min(throttleTarget, 0.3)
      }
      // Half-swap overtake: punch slightly above cruise while
      // committed — that's the whole point of pulling out.
      if (this.ovtT > 0 && this.ovtBody != null && speedKmh < cruising + 12) {
        throttleTarget = Math.max(throttleTarget, 0.55)
      }
      // Car following: never run over the vehicle ahead — match its
      // pace instead, braking harder the closer it gets. Skipped while
      // squeezing past a blocker: the creep rule below owns speed there.
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
          // Squeezing past: creep through, slower the tighter it is.
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
          // Nowhere to go: halt behind the blocker with a car-length gap.
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

/** Copy of an AI input with one-shot edges cleared for repeat application. */
export function stripEdges(inp: DriveInput): DriveInput {
  return { ...inp, ...ZERO_EDGES }
}

export function carProgress(body: RAPIER.RigidBody): number {
  return -body.translation().z
}
