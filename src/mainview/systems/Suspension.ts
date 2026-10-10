import * as THREE from "three"
import type * as RAPIER from "@dimforge/rapier3d-compat"
import { CAR_PHYSICS } from "../constants/physics"

/**
 * Phase 2 — independent per-wheel suspension with body-axis kinematics.
 *
 * Geometry reconciliation (see constants/physics.ts + WHEEL_LOCAL):
 * - Anchors sit at body-local y=0 (chassis origin height), ±0.76 m lateral,
 *   z=-1.51 m front / +1.31 m rear (2.82 m effective wheelbase vs 2.85
 *   configured; 1.52 m effective track vs 1.58 configured — anchors were
 *   measured from the GLB and are kept as-is).
 * - Ray origin = anchor + suspensionAxis * RAY_LIFT, REST_LENGTH = 0.915 m.
 *   At equilibrium (compression ~0.074 m) the contact lands at
 *   bodyY + 0.1 - (0.915 - 0.074) = bodyY - 0.741, i.e. bodyY ≈ 0.691 m
 *   over the physics ground surface at y = -0.05. Matches observed rest.
 * - Static distribution emerges from geometry: front axle 1.51 m ahead of
 *   the CoM (body origin), rear axle 1.31 m behind → ~46.5 % front /
 *   ~53.5 % rear. Corner loads are NOT assumed equal.
 * - Supported weight is the modelled chassis mass only:
 *   1650 kg * 9.81 = 16186.5 N. The 1750 kg config total includes the
 *   (unmodelled, non-rigid) unsprung wheel masses.
 *
 * Physical assumptions:
 * - Suspension axis = chassis up (body Y). Displacement, relative velocity
 *   and damping are measured along this axis, so slopes and body roll are
 *   handled instead of blindly using world Y.
 * - Motion ratio 1.0 (direct-acting): wheel rate == spring rate (55000 N/m).
 *   Mean corner mass ~412 kg → ride frequency ≈ 1.84 Hz (sports-sedan
 *   plausible). Damper 4500 N·s/m → damping ratio ≈ 0.47 (the config's
 *   targetDampingRatio 0.85 is not wired to anything; actual ratio stated
 *   here instead of retuning blindly).
 * - Spring pushes only (no tension past rest length); total corner force is
 *   clamped >= 0 and is exactly 0 when airborne, so suspension can never
 *   pull the chassis toward an absent contact.
 * - Bump stop: existing progressive multiplier 1 + max(0, c-0.10)*12 over
 *   the last ~20 mm of the 0.12 m travel, kept and documented.
 * - Anti-roll bars use the configured rates (15000/12000 N/m of left/right
 *   displacement difference), act only when BOTH axle wheels are grounded,
 *   sum to zero net heave force, and are force-limited.
 */

export interface WheelDef {
  x: number
  z: number
  front: boolean
  left: boolean
}

export interface WheelSuspState {
  wi: number
  grounded: boolean
  /** Suspension compression along the suspension axis, metres. >0 = compressed. */
  compression: number
  /** Rate of compression, m/s. >0 = compressing. */
  suspVel: number
  springF: number
  damperF: number
  arbF: number
  /** Total vertical (suspension-axis) force applied to the chassis, N. */
  force: number
  /** Normal load reported to the tire system, N. Equals force. */
  load: number
  contactY: number
  contactNormal: THREE.Vector3
  anchorWorld: THREE.Vector3
  pointVel: THREE.Vector3
}

const REST_LENGTH = 0.915
const RAY_LIFT = 0.1
const MAX_REACH = REST_LENGTH + 0.12
const DROOP_LIMIT = -0.06
const BUMP_START = 0.1
const BUMP_GAIN = 12
const ARB_FORCE_LIMIT = 4000

function clamp(v: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, v))
}

export class SuspensionSystem {
  readonly states: WheelSuspState[] = []
  private world: RAPIER.World
  private body: RAPIER.RigidBody
  private R: typeof RAPIER
  private wheels: WheelDef[]

  constructor(
    world: RAPIER.World,
    body: RAPIER.RigidBody,
    R: typeof RAPIER,
    wheels: WheelDef[],
  ) {
    this.world = world
    this.body = body
    this.R = R
    this.wheels = wheels
    wheels.forEach((_, wi) => {
      this.states.push({
        wi,
        grounded: false,
        compression: 0,
        suspVel: 0,
        springF: 0,
        damperF: 0,
        arbF: 0,
        force: 0,
        load: 0,
        contactY: 0,
        contactNormal: new THREE.Vector3(0, 1, 0),
        anchorWorld: new THREE.Vector3(),
        pointVel: new THREE.Vector3(),
      })
    })
  }

  /**
   * Solve one FIXED_DT substep: raycast each corner, integrate spring +
   * damper + anti-roll forces, apply the chassis impulse at each anchor so
   * pitch/roll moments emerge from geometry. Returns persistent per-wheel
   * states (same object identities every call).
   */
  update(
    dt: number,
    quat: THREE.Quaternion,
    bodyPos: THREE.Vector3,
    linvel: THREE.Vector3,
    angvel: THREE.Vector3,
  ): WheelSuspState[] {
    const P = CAR_PHYSICS
    const k = P.wheels.suspension.springRate
    const c = P.wheels.suspension.damperRate
    const travelLimit = P.wheels.suspension.travel + 0.06
    const up = new THREE.Vector3(0, 1, 0).applyQuaternion(quat)

    for (let wi = 0; wi < this.wheels.length; wi++) {
      const w = this.wheels[wi]
      const st = this.states[wi]
      const anchor = new THREE.Vector3(w.x, 0, w.z)
        .applyQuaternion(quat)
        .add(bodyPos)
      st.anchorWorld.copy(anchor)

      const origin = anchor.clone().addScaledVector(up, RAY_LIFT)
      const dir = up.clone().negate()
      const ray = new this.R.Ray(origin, dir)
      const hit = this.world.castRayAndGetNormal(
        ray,
        MAX_REACH,
        true,
        undefined,
        undefined,
        undefined,
        this.body,
      )

      // Lever arm from CoM to anchor (legacy convention: horizontal only;
      // the anchor sits at CoM height so the vertical part is ~0 anyway).
      const r = new THREE.Vector3(
        anchor.x - bodyPos.x,
        0,
        anchor.z - bodyPos.z,
      )
      const pointVel = linvel.clone().add(angvel.clone().cross(r))
      st.pointVel.copy(pointVel)

      if (!hit) {
        st.grounded = false
        st.compression = 0
        st.suspVel = 0
        st.springF = 0
        st.damperF = 0
        st.arbF = 0
        st.force = 0
        st.load = 0
        continue
      }

      const toi = hit.timeOfImpact
      const compression = clamp(REST_LENGTH - toi, DROOP_LIMIT, travelLimit)
      // Rate of compression = chassis approaching ground along +up.
      const suspVel = -pointVel.dot(up)

      const bump = 1 + Math.max(0, compression - BUMP_START) * BUMP_GAIN
      const springF = k * bump * Math.max(0, compression)
      const damperF = -c * pointVel.dot(up)

      const contact = origin.clone().addScaledVector(dir, toi)
      st.grounded = true
      st.compression = compression
      st.suspVel = suspVel
      st.springF = springF
      st.damperF = damperF
      st.arbF = 0 // filled in by the axle pass below
      st.contactY = contact.y
      const n = (hit as { normal?: { x: number; y: number; z: number } })
        .normal
      if (n) st.contactNormal.set(n.x, n.y, n.z)
      else st.contactNormal.set(0, 1, 0)
    }

    // Anti-roll pass: per axle, from left/right displacement difference.
    // Equal and opposite (no net heave), grounded-axles only, force-limited.
    // An airborne axle generates nothing, so the bar can never pull the
    // chassis toward missing ground.
    for (const front of [true, false]) {
      const idx = this.wheels
        .map((_, i) => i)
        .filter((i) => this.wheels[i].front === front)
      if (idx.length !== 2) continue
      const li = this.wheels[idx[0]].left ? idx[0] : idx[1]
      const ri = li === idx[0] ? idx[1] : idx[0]
      const left = this.states[li]
      const right = this.states[ri]
      if (!left.grounded || !right.grounded) continue
      const kArb = front
        ? P.wheels.suspension.antiRollBarFront
        : P.wheels.suspension.antiRollBarRear
      const arb = clamp(
        (kArb * (left.compression - right.compression)) / 2,
        -ARB_FORCE_LIMIT,
        ARB_FORCE_LIMIT,
      )
      left.arbF = arb
      right.arbF = -arb
    }

    // Force application pass: along the suspension axis at each anchor.
    for (const st of this.states) {
      if (!st.grounded) {
        st.force = 0
        st.load = 0
        continue
      }
      const force = Math.max(0, st.springF + st.damperF + st.arbF)
      st.force = force
      st.load = force
      this.body.applyImpulseAtPoint(
        {
          x: up.x * force * dt,
          y: up.y * force * dt,
          z: up.z * force * dt,
        },
        st.anchorWorld,
        true,
      )
    }

    return this.states
  }
}
