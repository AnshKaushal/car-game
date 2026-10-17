import * as THREE from "three"
import type * as RAPIER from "@dimforge/rapier3d-compat"
import { CarVisual } from "../CarVisual"
import { createCabinCollider } from "../PhysicsSystem"
import { CAR_PHYSICS } from "../../constants/physics"
import type { TireSmoke } from "../TireSmoke"
import type { ValidatedState } from "./stateProtocol"
import type { PaintTextureRule } from "../carTint"
import {
  CORRECTION_ACCEL_MAX,
  CorrectionState,
  IMPACT_IMPULSE_THRESHOLD,
  RECOVER_CORR_MAX,
  RECOVER_WARP_M,
  SUPPORT_DESCENT_DY,
  clampCorrectionDelta,
} from "./correction"
import {
  INTERP_DELAY_MS,
  SnapshotBuffer,
  newInterpTarget,
  type InterpMode,
} from "./SnapshotBuffer"
import {
  netDiagBufferReset,
  netDiagContact,
  netDiagCorrection,
  netDiagInterpSample,
  netDiagRemoteSample,
  netDiagSnap,
} from "./NetDiagnostics"

export interface RemoteCarOptions {
  modelFile?: string
  dims?: { width: number; height: number; length: number }
  mass?: number
  paintMatch?: string[]
  paintTexture?: PaintTextureRule
}

const REMOTE_DEFAULT_MODEL = "models/bmw_m3.glb"
const TIRE_RADIUS = 0.33
const DRIVE_EXTRAPOLATION_S = 0.1
const POS_GAIN = 4.5
const CORRECTION_MAX = 10
const MAX_DRIVE_SPEED = 120
const MAX_DRIVE_ANGVEL = 8
const WARP_DIST_SQ = 15 * 15

const _goal = new THREE.Vector3()
const _q = new THREE.Quaternion()
const _qe = new THREE.Quaternion()
const _axis = new THREE.Vector3()
const _pos = new THREE.Vector3()
const _quat = new THREE.Quaternion()
const _cn = { x: 0, y: 0, z: 0 }

export class RemoteCar {
  id: string
  name: string
  color: number
  visual: CarVisual
  colliderBody: RAPIER.RigidBody | null = null
  private world: RAPIER.World | null = null
  private collider: RAPIER.Collider | null = null

  public nowOverride: number | null = null
  private now() {
    return this.nowOverride ?? performance.now()
  }

  targetPos = new THREE.Vector3(0, 0.72, 0)
  targetQuat = new THREE.Quaternion()
  targetVel = new THREE.Vector3(0, 0, 0)

  steerAngle = 0
  wheelOmega = 0
  speed = 0
  private brakeTarget = 0
  smoke = false
  drift = false
  progress = 0
  finished = false
  finishTime: number | null = null

  lastPacketTime = 0
  hasReceivedPacket = false

  private interp = new SnapshotBuffer()
  private interpOut = newInterpTarget()
  private interpStats = { mode: "empty" as InterpMode, extrapMs: 0 }

  private corr = new CorrectionState()
  private lastCorr = { x: 0, y: 0, z: 0 }
  private appliedCorr = { x: 0, y: 0, z: 0 }
  private prevCorrMode = "follow"
  private corrCmdMag = 0
  private corrDeltaV = 0
  private errMag = 0

  private smokePosBuf: THREE.Vector3[] = []
  private scene: THREE.Scene | null = null
  private baseUrl = ""
  private modelFile: string
  private paintMatch: string[] | undefined
  private paintTexture: PaintTextureRule | undefined

  constructor(
    id: string,
    name: string,
    color: number,
    scene: THREE.Scene,
    baseUrl: string,
    world?: RAPIER.World,
    rapier?: typeof RAPIER,
    opts?: RemoteCarOptions,
  ) {
    this.id = id
    this.name = name
    this.color = color
    this.scene = scene
    this.baseUrl = baseUrl
    this.modelFile = opts?.modelFile ?? REMOTE_DEFAULT_MODEL
    this.paintMatch = opts?.paintMatch
    this.paintTexture = opts?.paintTexture

    this.visual = new CarVisual()
    this.visual.castShadow = true

    this.loadVisual()

    this.world = world ?? null
    if (world && rapier) {
      try {
        const P = CAR_PHYSICS
        const dims = opts?.dims ?? P.dimensions
        const mass = opts?.mass ?? P.mass.chassis
        const bodyDesc = rapier.RigidBodyDesc.dynamic()
          .setTranslation(0, 0.72, 0)
          .setLinvel(0, 0, 0)
          .setAngvel({ x: 0, y: 0, z: 0 })
          .setLinearDamping(0.001)
          .setAngularDamping(0.55)
          .setGravityScale(0)
          .setCanSleep(false)
          .setCcdEnabled(true)
        this.colliderBody = world.createRigidBody(bodyDesc)
        const colDesc = rapier.ColliderDesc.cuboid(
          dims.width / 2,
          0.32 * (dims.height / 1.43),
          dims.length / 2,
        ).setTranslation(0, -0.1, 0)
          .setMass(mass)
          .setFriction(0.15)
          .setFrictionCombineRule(rapier.CoefficientCombineRule.Min)
          .setRestitution(0.2)
        this.collider = world.createCollider(colDesc, this.colliderBody)
        world.createCollider(
          createCabinCollider(rapier, dims)
            .setFriction(0.15)
            .setFrictionCombineRule(rapier.CoefficientCombineRule.Min)
            .setRestitution(0.2),
          this.colliderBody,
        )
      } catch (e) {
        console.warn(`[RemoteCar] Failed to create body for ${name}:`, e)
        this.colliderBody = null
      }
    }
  }

  private loadVisual() {
    const scene = this.scene
    const visual = this.visual
    visual
      .load(this.baseUrl, this.color, {
        modelFile: this.modelFile,
        paintMatch: this.paintMatch,
        paintTexture: this.paintTexture,
      })
      .then(() => {
        scene?.add(visual.group)
      })
      .catch((e) => {
        console.warn(`[RemoteCar] Failed to load visual model for ${this.name}:`, e)
        scene?.add(visual.group)
      })
  }

  setModel(
    modelFile: string | undefined | null,
    ghost?: { paintMatch?: string[]; paintTexture?: PaintTextureRule },
  ) {
    const next = modelFile || REMOTE_DEFAULT_MODEL
    if (next === this.modelFile) return
    this.modelFile = next
    this.paintMatch = ghost?.paintMatch
    this.paintTexture = ghost?.paintTexture
    try {
      this.scene?.remove(this.visual.group)
    } catch {}
    this.visual = new CarVisual()
    this.visual.castShadow = true
    this.loadVisual()
  }

  onPacket(state: ValidatedState, arrivalMs: number) {
    this.lastPacketTime = arrivalMs
    this.interp.append(state, arrivalMs, state.seq)
    this.steerAngle = state.steer
    if (state.speed < this.speed - 0.3) this.brakeTarget = 1
    else if (state.speed > this.speed + 0.05) this.brakeTarget = 0
    this.speed = state.speed
    this.smoke = state.smoke
    this.drift = state.drift
    this.progress = state.progress
    this.hasReceivedPacket = true
  }

  resetInterpolation(reason: string) {
    this.interp.reset()
    this.corr.reset()
    this.prevCorrMode = "follow"
    this.lastCorr.x = 0
    this.lastCorr.y = 0
    this.lastCorr.z = 0
    netDiagBufferReset(this.id, reason)
  }

  sampleContacts(nowMs?: number) {
    const now = nowMs ?? this.now()
    const w = this.world
    const c = this.collider
    if (!w || !c) return
    let touching = false
    let support = false
    let impulse = 0
    try {
      w.contactPairsWith(c, (other) => {
        try {
          w.contactPair(c, other, (manifold) => {
            try {
              if (manifold.numContacts() > 0) {
                _cn.x = 0
                _cn.y = 0
                _cn.z = 0
                let ny = 0
                try {
                  manifold.normal(_cn)
                  ny = _cn.y
                } catch {
                  ny = 0
                }
                if (Math.abs(ny) <= 0.7) {
                  touching = true
                  const n = manifold.numSolverContacts()
                  for (let i = 0; i < n; i++) {
                    impulse += Math.abs(manifold.contactImpulse(i))
                  }
                } else {
                  support = true
                }
              }
            } catch {
            }
          })
        } catch {
        }
      })
    } catch {
      return
    }
    this.corr.noteContact(touching, impulse, now)
    this.corr.noteSupport(support)
    netDiagContact(this.id, touching, impulse, this.corr.mode, support)
  }

  setColor(color: number) {
    this.color = color
    try {
      this.visual.setTint(color)
    } catch (e) {
      console.warn(`[RemoteCar] Retint failed for ${this.name}:`, e)
    }
  }

  drive(dt: number) {
    const b = this.colliderBody
    if (!b || !this.hasReceivedPacket || dt <= 0) return

    const now = this.now()
    const mode = this.interp.sampleInto(
      this.interpOut,
      now - INTERP_DELAY_MS,
      this.interpStats,
    )
    netDiagInterpSample(
      this.id,
      mode,
      this.interp.size,
      this.interpStats.extrapMs,
      this.interp.underruns,
    )
    if (mode === "empty") return
    this.targetPos.set(this.interpOut.x, this.interpOut.y, this.interpOut.z)
    this.targetQuat.set(
      this.interpOut.qx,
      this.interpOut.qy,
      this.interpOut.qz,
      this.interpOut.qw,
    )
    this.targetVel.set(this.interpOut.vx, this.interpOut.vy, this.interpOut.vz)

    const ageS = Math.max(0, (now - this.lastPacketTime) / 1000)
    const age = Math.min(DRIVE_EXTRAPOLATION_S, ageS)
    _goal.copy(this.targetPos).addScaledVector(this.targetVel, age)

    const authority = ageS < 0.2 ? 1 : Math.max(0, 1 - (ageS - 0.2) / 0.3)
    const cruiseScale = ageS < 0.5 ? 1 : Math.max(0, 1 - (ageS - 0.5) / 1.0)

    let contactScale = 1

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
    this.errMag = Math.sqrt(distSq)
    contactScale = this.corr.factor(now, this.errMag)
    if (this.corr.mode === "recover" && this.prevCorrMode !== "recover") {
      try {
        const lv = b.linvel()
        this.lastCorr.x = lv.x - this.targetVel.x * cruiseScale
        this.lastCorr.y = lv.y - this.targetVel.y * cruiseScale
        this.lastCorr.z = lv.z - this.targetVel.z * cruiseScale
      } catch {
      }
    }
    this.prevCorrMode = this.corr.mode

    try {
      const explained = this.corr.mode !== "follow" && this.errMag < RECOVER_WARP_M
      if (distSq > WARP_DIST_SQ && !explained) {
        netDiagSnap(this.id, "warp-threshold", Math.sqrt(distSq))
        this.interp.reset()
        netDiagBufferReset(this.id, "warp-snap")
        this.corr.reset()
        this.prevCorrMode = "follow"
        this.lastCorr.x = 0
        this.lastCorr.y = 0
        this.lastCorr.z = 0
        b.setTranslation({ x: _goal.x, y: _goal.y, z: _goal.z }, true)
        b.setRotation(
          { x: this.targetQuat.x, y: this.targetQuat.y, z: this.targetQuat.z, w: this.targetQuat.w },
          true,
        )
        b.setLinvel({ x: 0, y: 0, z: 0 }, true)
        b.setAngvel({ x: 0, y: 0, z: 0 }, true)
        return
      }

      let cx = dx * POS_GAIN
      let cy = dy * POS_GAIN
      let cz = dz * POS_GAIN
      const corrCap = this.corr.mode === "recover" ? RECOVER_CORR_MAX : CORRECTION_MAX
      const chl = Math.sqrt(cx * cx + cz * cz)
      if (chl > corrCap) {
        const s = corrCap / chl
        cx *= s
        cz *= s
      }
      const vcap = this.corr.mode === "recover" ? RECOVER_CORR_MAX : CORRECTION_MAX
      const cl = Math.abs(cy)
      if (cl > vcap) {
        cy *= vcap / cl
      }
      let tx = cx * authority * contactScale
      let ty = cy * authority
      let tz = cz * authority * contactScale
      if (this.corr.mode === "recover") {
        const tm = Math.sqrt(tx * tx + ty * ty + tz * tz)
        if (tm > RECOVER_CORR_MAX) {
          const s = RECOVER_CORR_MAX / tm
          tx *= s
          ty *= s
          tz *= s
        }
      }
      const px = this.lastCorr.x
      const py = this.lastCorr.y
      const pz = this.lastCorr.z
      this.corrCmdMag = clampCorrectionDelta(
        px, py, pz,
        tx, ty, tz,
        CORRECTION_ACCEL_MAX * dt,
        this.appliedCorr,
      )
      this.lastCorr.x = this.appliedCorr.x
      this.lastCorr.y = this.appliedCorr.y
      this.lastCorr.z = this.appliedCorr.z
      this.corrDeltaV = Math.sqrt(
        (this.appliedCorr.x - px) * (this.appliedCorr.x - px) +
          (this.appliedCorr.y - py) * (this.appliedCorr.y - py) +
          (this.appliedCorr.z - pz) * (this.appliedCorr.z - pz),
      )
      let vx = this.targetVel.x * cruiseScale + this.appliedCorr.x
      let vy = this.targetVel.y * cruiseScale + this.appliedCorr.y
      let vz = this.targetVel.z * cruiseScale + this.appliedCorr.z
      if (this.corr.hasSupport && vy < 0 && dy > SUPPORT_DESCENT_DY) {
        vy = 0
      }
      const passive =
        this.corr.mode === "contact" &&
        this.corr.impactImpulse >= IMPACT_IMPULSE_THRESHOLD
      if (passive) {
        this.corrCmdMag = 0
        this.corrDeltaV = 0
        let spd = 0
        try {
          const lv = b.linvel()
          spd = Math.sqrt(lv.x * lv.x + lv.y * lv.y + lv.z * lv.z)
        } catch {
        }
        netDiagRemoteSample(this.id, Math.sqrt(distSq), spd, 0, ageS * 1000)
        netDiagCorrection(
          this.id,
          this.corr.mode,
          this.errMag,
          0,
          0,
          this.corr.suppressedSubsteps,
          this.corr.transitions,
          this.corr.recoverT(now),
        )
        return
      }
      const sp = Math.sqrt(vx * vx + vy * vy + vz * vz)
      if (sp > MAX_DRIVE_SPEED) {
        const s = MAX_DRIVE_SPEED / sp
        vx *= s
        vy *= s
        vz *= s
      }
      b.setLinvel({ x: vx, y: vy, z: vz }, true)

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
      let wMag = 0
      if (contactScale <= 0) {
      } else if (sinHalf > 1e-4) {
        const angle = 2 * Math.atan2(sinHalf, _qe.w)
        _axis.set(_qe.x / sinHalf, _qe.y / sinHalf, _qe.z / sinHalf)
        let w = angle / dt
        if (w > MAX_DRIVE_ANGVEL) w = MAX_DRIVE_ANGVEL
        else if (w < -MAX_DRIVE_ANGVEL) w = -MAX_DRIVE_ANGVEL
        w *= authority * contactScale
        wMag = Math.abs(w)
        b.setAngvel({ x: _axis.x * w, y: _axis.y * w, z: _axis.z * w }, true)
      } else if (contactScale >= 1) {
        b.setAngvel({ x: 0, y: 0, z: 0 }, true)
      }
      netDiagRemoteSample(
        this.id,
        Math.sqrt(distSq),
        Math.sqrt(vx * vx + vy * vy + vz * vz),
        wMag,
        ageS * 1000,
      )
      netDiagCorrection(
        this.id,
        this.corr.mode,
        this.errMag,
        this.corrCmdMag,
        this.corrDeltaV,
        this.corr.suppressedSubsteps,
        this.corr.transitions,
        this.corr.recoverT(now),
      )
    } catch {
    }
  }

  update(dt: number, smokeSystem?: TireSmoke) {
    const b = this.colliderBody
    if (!b || !this.hasReceivedPacket) return

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

    const vms = Math.sqrt(bv.x * bv.x + bv.y * bv.y + bv.z * bv.z)
    this.wheelOmega = vms / TIRE_RADIUS
    const omegas = [this.wheelOmega, this.wheelOmega, this.wheelOmega, this.wheelOmega]

    this.visual.syncFromPose(
      _pos,
      _quat,
      this.steerAngle,
      omegas,
      dt,
    )
    this.visual.setBrake(this.brakeTarget)

    if (smokeSystem && (this.smoke || this.drift) && this.speed > 5) {
      this.visual.wheelContactPositions(false, this.smokePosBuf)
      for (const p of this.smokePosBuf) {
        smokeSystem.spawn(p, this.drift ? 0.9 : 0.6)
      }
    }
  }

  dispose(scene: THREE.Scene, world?: RAPIER.World) {
    scene.remove(this.visual.group)
    const w = this.world ?? world ?? null
    if (this.colliderBody && w) {
      try {
        w.removeRigidBody(this.colliderBody)
      } catch {}
      this.colliderBody = null
    }
    this.collider = null
  }
}
