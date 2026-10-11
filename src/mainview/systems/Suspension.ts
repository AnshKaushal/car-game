import * as THREE from "three"
import type * as RAPIER from "@dimforge/rapier3d-compat"
import { CAR_PHYSICS } from "../constants/physics"


export interface WheelDef {
  x: number
  z: number
  front: boolean
  left: boolean
}

export interface WheelSuspState {
  wi: number
  grounded: boolean
  compression: number
  suspVel: number
  springF: number
  damperF: number
  arbF: number
  force: number
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
// Absolute ceiling per corner (~7x static corner load). Legit driving,
// even hard landings, never reaches it — it exists only to bound faulty
// inputs (sub-surface rays, velocity spikes) to non-catastrophic levels.
const MAX_CORNER_FORCE = 30000

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

      const r = new THREE.Vector3(
        anchor.x - bodyPos.x,
        0,
        anchor.z - bodyPos.z,
      )
      const pointVel = linvel.clone().add(angvel.clone().cross(r))
      st.pointVel.copy(pointVel)

      if (!hit || hit.timeOfImpact < 0.05) {
        // No hit — or the ray started INSIDE solid (solid rays report
        // toi≈0). The latter happens when overturned/wedged with the ray
        // origin under the terrain: treating it as full compression would
        // fire max spring force along a body-up vector that points INTO
        // the ground and railgun the car through the floor. Airborne it is.
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
      st.arbF = 0
      st.contactY = contact.y
      const n = (hit as { normal?: { x: number; y: number; z: number } })
        .normal
      if (n) st.contactNormal.set(n.x, n.y, n.z)
      else st.contactNormal.set(0, 1, 0)
    }

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
    // Two hard guards so this path can never launch the car:
    // - MAX_CORNER_FORCE caps any single corner (~7x static load; legit
    //   driving, even hard landings, never reaches it).
    // - Forces only apply while roughly upright (up.y > 0.25). Past ~75°
    //   of roll the "suspension axis" points sideways/down and pushing
    //   along it would shove the car through the world.
    const upY = up.y
    for (const st of this.states) {
      if (!st.grounded || upY < 0.25) {
        st.force = 0
        st.load = 0
        continue
      }
      const force = Math.max(
        0,
        Math.min(MAX_CORNER_FORCE, st.springF + st.damperF + st.arbF),
      )
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
