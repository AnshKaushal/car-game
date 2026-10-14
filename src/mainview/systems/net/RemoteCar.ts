import * as THREE from "three"
import type * as RAPIER from "@dimforge/rapier3d-compat"
import { CarVisual } from "../CarVisual"
import { CAR_PHYSICS } from "../../constants/physics"
import type { TireSmoke } from "../TireSmoke"
import type { CarStatePacket } from "./types"

const TIRE_RADIUS = 0.33
// How far ahead of the last packet the drive goal may extrapolate. Tight on
// purpose: overshooting through a turn the peer already took would ram us
// into walls that aren't there.
const DRIVE_EXTRAPOLATION_S = 0.1
// Position correction gain (1/s) toward the extrapolated goal. Soft on
// purpose: contacts must visibly displace the ghost, which then recovers
// over ~0.5 s like a real car being shoved — not snap back in 100 ms.
const POS_GAIN = 4.5
// The correction term alone may never add more than this: the drive follows
// the owner's velocity, it must never bulldoze (e.g. dragging a parked car
// along at speed, or being dragged along while pushing one).
const CORRECTION_MAX = 10
// Hard cap on driven speed so a warp can never turn the ghost into a missile.
const MAX_DRIVE_SPEED = 120
// Soft angular drive: knocks visibly rotate the ghost before it recovers.
const MAX_DRIVE_ANGVEL = 8
// Beyond this the peer teleported (or joined across the map): snap, don't fly.
const WARP_DIST_SQ = 15 * 15

// Scratch objects — drive() runs per physics substep, never allocate there.
const _goal = new THREE.Vector3()
const _q = new THREE.Quaternion()
const _qe = new THREE.Quaternion()
const _axis = new THREE.Vector3()
const _pos = new THREE.Vector3()
const _quat = new THREE.Quaternion()

export class RemoteCar {
  id: string
  name: string
  color: number
  visual: CarVisual
  colliderBody: RAPIER.RigidBody | null = null
  private world: RAPIER.World | null = null

  // Latest packet target pose (movement authority stays with the owner).
  targetPos = new THREE.Vector3(0, 0.72, 0)
  targetQuat = new THREE.Quaternion()
  targetVel = new THREE.Vector3(0, 0, 0)

  steerAngle = 0
  wheelOmega = 0
  speed = 0
  smoke = false
  drift = false
  progress = 0
  finished = false
  finishTime: number | null = null

  lastPacketTime = 0
  hasReceivedPacket = false

  private smokePosBuf: THREE.Vector3[] = []

  constructor(
    id: string,
    name: string,
    color: number,
    scene: THREE.Scene,
    baseUrl: string,
    world?: RAPIER.World,
    rapier?: typeof RAPIER,
  ) {
    this.id = id
    this.name = name
    this.color = color

    this.visual = new CarVisual()
    this.visual.castShadow = true

    // Load car model and add to scene
    this.visual.load(baseUrl, color).then(() => {
      scene.add(this.visual.group)
    }).catch((e) => {
      console.warn(`[RemoteCar] Failed to load visual model for ${name}:`, e)
      scene.add(this.visual.group)
    })

    // Shared-physics ghost: a DYNAMIC body with the same mass as the local
    // chassis, velocity-driven toward the owner's authoritative pose every
    // substep (see drive()). Contacts are dynamic-vs-dynamic, so shoves land
    // on both cars instead of one side bouncing off infinite mass.
    // Gravity is off — the drive fully owns the trajectory; falling is the
    // owner's simulation to run, not ours to guess.
    this.world = world ?? null
    if (world && rapier) {
      try {
        const P = CAR_PHYSICS
        const bodyDesc = rapier.RigidBodyDesc.dynamic()
          .setTranslation(0, 0.72, 0)
          .setLinvel(0, 0, 0)
          .setAngvel({ x: 0, y: 0, z: 0 })
          .setLinearDamping(0.005)
          .setAngularDamping(0.55)
          .setGravityScale(0)
          .setCanSleep(false)
          .setCcdEnabled(true)
        this.colliderBody = world.createRigidBody(bodyDesc)
        const colDesc = rapier.ColliderDesc.cuboid(
          P.dimensions.width / 2,
          0.32,
          P.dimensions.length / 2,
        ).setTranslation(0, -0.1, 0)
          .setMass(P.mass.chassis)
          // Paint slides on paint: low car-vs-car friction (Min wins over the
          // chassis' default Average rule) so side-swipes deflect and slide
          // apart instead of interlocking and dragging to 300. Modest bounce:
          // metal crumples, it doesn't pinball.
          .setFriction(0.15)
          .setFrictionCombineRule(rapier.CoefficientCombineRule.Min)
          .setRestitution(0.2)
        world.createCollider(colDesc, this.colliderBody)
      } catch (e) {
        console.warn(`[RemoteCar] Failed to create body for ${name}:`, e)
        this.colliderBody = null
      }
    }
  }

  onPacket(pkt: CarStatePacket) {    this.lastPacketTime = performance.now()
    if (
      !Number.isFinite(pkt.x) ||
      !Number.isFinite(pkt.y) ||
      !Number.isFinite(pkt.z)
    ) {
      return
    }
    this.targetPos.set(pkt.x, pkt.y, pkt.z)
    this.targetQuat.set(pkt.qx, pkt.qy, pkt.qz, pkt.qw)
    this.targetVel.set(pkt.vx, pkt.vy, pkt.vz)
    this.steerAngle = Number.isFinite(pkt.steer) ? pkt.steer : 0
    this.speed = Number.isFinite(pkt.speed) ? pkt.speed : 0
    this.smoke = pkt.smoke
    this.drift = pkt.drift
    this.progress = pkt.progress
    this.hasReceivedPacket = true
  }

  /** Live paint + name update (peer's lobby picks after joining). */
  setColor(color: number) {
    this.color = color
    try {
      this.visual.setTint(color)
    } catch (e) {
      console.warn(`[RemoteCar] Retint failed for ${this.name}:`, e)
    }
  }

  /**
   * Per-physics-substep drive: prescribe the ghost's velocity so it tracks
   * the owner's pose. Must run before world.step(). Contacts still resolve
   * physically — being shoved just adds error the drive then corrects.
   */
  drive(dt: number) {
    const b = this.colliderBody
    if (!b || !this.hasReceivedPacket || dt <= 0) return

    const now = performance.now()
    const ageS = Math.max(0, (now - this.lastPacketTime) / 1000)
    const age = Math.min(DRIVE_EXTRAPOLATION_S, ageS)
    _goal.copy(this.targetPos).addScaledVector(this.targetVel, age)

    // Authority fades when packets go stale: a silent ghost coasts to a stop
    // instead of being nailed to its last known point like a wall anchor
    // that drags everything touching it up to speed.
    const authority = ageS < 0.2 ? 1 : Math.max(0, 1 - (ageS - 0.2) / 0.3)
    const cruiseScale = ageS < 0.5 ? 1 : Math.max(0, 1 - (ageS - 0.5) / 1.0)

    let bp: { x: number; y: number; z: number }
    try {
      bp = b.translation()
    } catch {
      return
    }
    const dx = _goal.x - bp.x
    const dy = _goal.y - bp.y
    const dz = _goal.z - bp.z
    const distSq = dx * dx + dy * dy + dz * dz

    try {
      if (distSq > WARP_DIST_SQ) {
        // Teleport/respawn/join-across-map: snap, never fly through the scene.
        b.setTranslation({ x: _goal.x, y: _goal.y, z: _goal.z }, true)
        b.setRotation(
          { x: this.targetQuat.x, y: this.targetQuat.y, z: this.targetQuat.z, w: this.targetQuat.w },
          true,
        )
        b.setLinvel({ x: 0, y: 0, z: 0 }, true)
        b.setAngvel({ x: 0, y: 0, z: 0 }, true)
        return
      }

      // Desired velocity = owner's (decaying) velocity + capped positional
      // correction. Capping the correction separately is what stops the
      // bulldozer: the ghost yields to shoves and reconverges slowly.
      let cx = dx * POS_GAIN
      let cy = dy * POS_GAIN
      let cz = dz * POS_GAIN
      const cl = Math.sqrt(cx * cx + cy * cy + cz * cz)
      if (cl > CORRECTION_MAX) {
        const s = CORRECTION_MAX / cl
        cx *= s
        cy *= s
        cz *= s
      }
      let vx = this.targetVel.x * cruiseScale + cx * authority
      let vy = this.targetVel.y * cruiseScale + cy * authority
      let vz = this.targetVel.z * cruiseScale + cz * authority
      const sp = Math.sqrt(vx * vx + vy * vy + vz * vz)
      if (sp > MAX_DRIVE_SPEED) {
        const s = MAX_DRIVE_SPEED / sp
        vx *= s
        vy *= s
        vz *= s
      }
      b.setLinvel({ x: vx, y: vy, z: vz }, true)

      // Angular drive: shortest-arc quaternion error -> angular velocity.
      const bq = b.rotation()
      _q.set(bq.x, bq.y, bq.z, bq.w)
      _qe.copy(this.targetQuat).multiply(_q.invert())
      if (_qe.w < 0) {
        _qe.x = -_qe.x
        _qe.y = -_qe.y
        _qe.z = -_qe.z
        _qe.w = -_qe.w
      }
      const sinHalf = Math.sqrt(
        Math.max(0, 1 - _qe.w * _qe.w),
      )
      if (sinHalf > 1e-4) {
        const angle = 2 * Math.atan2(sinHalf, _qe.w)
        _axis.set(_qe.x / sinHalf, _qe.y / sinHalf, _qe.z / sinHalf)
        let w = angle / dt
        if (w > MAX_DRIVE_ANGVEL) w = MAX_DRIVE_ANGVEL
        else if (w < -MAX_DRIVE_ANGVEL) w = -MAX_DRIVE_ANGVEL
        // No stale snap-back: a silent ghost keeps its knocked rotation.
        w *= authority
        b.setAngvel({ x: _axis.x * w, y: _axis.y * w, z: _axis.z * w }, true)
      } else {
        b.setAngvel({ x: 0, y: 0, z: 0 }, true)
      }
    } catch {
      // World torn down mid-drive — teardown owns cleanup, never crash here.
    }
  }

  update(dt: number, smokeSystem?: TireSmoke) {
    const b = this.colliderBody
    if (!b || !this.hasReceivedPacket) return

    // Visual follows the simulated body: what you see is what collides.
    let bp: { x: number; y: number; z: number }
    let bq: { x: number; y: number; z: number; w: number }
    let bv: { x: number; y: number; z: number }
    try {
      bp = b.translation()
      bq = b.rotation()
      bv = b.linvel()
    } catch {
      return
    }
    _pos.set(bp.x, bp.y, bp.z)
    _quat.set(bq.x, bq.y, bq.z, bq.w)

    // Wheel spin from actual body speed (m/s).
    const vms = Math.sqrt(bv.x * bv.x + bv.y * bv.y + bv.z * bv.z)
    this.wheelOmega = vms / TIRE_RADIUS
    const omegas = [this.wheelOmega, this.wheelOmega, this.wheelOmega, this.wheelOmega]

    // Sync visual meshes
    this.visual.syncFromPose(
      _pos,
      _quat,
      this.steerAngle,
      omegas,
      dt,
    )

    // Spawn tire smoke if peer is drifting or doing a burnout
    if (smokeSystem && (this.smoke || this.drift) && this.speed > 5) {
      this.visual.wheelContactPositions(false, this.smokePosBuf)
      for (const p of this.smokePosBuf) {
        smokeSystem.spawn(p, this.drift ? 0.9 : 0.6)
      }
    }
  }

  dispose(scene: THREE.Scene, world?: RAPIER.World) {
    scene.remove(this.visual.group)
    // Prefer the world the body was actually created in — the passed
    // world may belong to a different session after a rebuild.
    const w = this.world ?? world ?? null
    if (this.colliderBody && w) {
      try {
        w.removeRigidBody(this.colliderBody)
      } catch {}
      this.colliderBody = null
    }
  }
}
