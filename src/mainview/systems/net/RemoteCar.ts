import * as THREE from "three"
import type * as RAPIER from "@dimforge/rapier3d-compat"
import { CarVisual } from "../CarVisual"
import { CAR_PHYSICS } from "../../constants/physics"
import type { TireSmoke } from "../TireSmoke"
import type { ValidatedState } from "./stateProtocol"
import {
  CORRECTION_ACCEL_MAX,
  CorrectionState,
  IMPACT_IMPULSE_THRESHOLD,
  RECOVER_CORR_MAX,
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
// Scratch world-normal for contact classification (sampleContacts only).
const _cn = { x: 0, y: 0, z: 0 }

export class RemoteCar {
  id: string
  name: string
  color: number
  visual: CarVisual
  colliderBody: RAPIER.RigidBody | null = null
  private world: RAPIER.World | null = null
  private collider: RAPIER.Collider | null = null

  /** Test hook: override the monotonic clock (null = performance.now()). */
  public nowOverride: number | null = null
  private now() {
    return this.nowOverride ?? performance.now()
  }

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

  // Phase 3: per-peer snapshot history. drive() samples an interpolated
  // target from this buffer; the Rapier body (collision + render source)
  // is unchanged — visuals still follow the body exactly, so there is no
  // visual/collision divergence. Timestamps are receiver-local arrivals.
  private interp = new SnapshotBuffer()
  private interpOut = newInterpTarget()
  private interpStats = { mode: "empty" as InterpMode, extrapMs: 0 }

  // Phase 4: hybrid correction state. Contact observations are sampled
  // once per frame (sampleContacts, outside the substep loop) and cached
  // here for drive(). lastCorr is the applied correction vector, used to
  // bound per-substep correction delta-v (energy bound).
  private corr = new CorrectionState()
  private lastCorr = { x: 0, y: 0, z: 0 }
  private appliedCorr = { x: 0, y: 0, z: 0 }
  /** Mode seen by the previous drive() call (recover-entry detection). */
  private prevCorrMode = "follow"
  private corrCmdMag = 0
  private corrDeltaV = 0
  private errMag = 0

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
        // Kept for Phase 4 contact queries (narrow-phase only, read-only).
        this.collider = world.createCollider(colDesc, this.colliderBody)
      } catch (e) {
        console.warn(`[RemoteCar] Failed to create body for ${name}:`, e)
        this.colliderBody = null
      }
    }
  }

  /**
   * Apply an already-validated + ordering-approved state atomically.
   * Phase 2: all validation and duplicate/stale rejection happens in
   * MultiplayerManager before this is called, so every field here is
   * trusted (quaternion pre-normalized) and no partial update is possible.
   * `arrivalMs` is the RECEIVER's local clock at packet arrival — the
   * sender timestamp is never used for freshness (see types.ts).
   */
  onPacket(state: ValidatedState, arrivalMs: number) {
    this.lastPacketTime = arrivalMs
    // Pose targets are owned by the interpolation sampler (see drive());
    // the buffer holds the history, target* holds the current sample.
    this.interp.append(state, arrivalMs, state.seq)
    this.steerAngle = state.steer
    this.speed = state.speed
    this.smoke = state.smoke
    this.drift = state.drift
    this.progress = state.progress
    this.hasReceivedPacket = true
  }

  /**
   * Drop interpolation history: session starts, teleports, teardown.
   * Reset-to-empty is deliberate — the next accepted packet re-primes the
   * buffer, and an empty buffer coasts the body instead of interpolating
   * across a discontinuity. Never throws.
   */
  resetInterpolation(reason: string) {
    this.interp.reset()
    this.corr.reset()
    this.prevCorrMode = "follow"
    this.lastCorr.x = 0
    this.lastCorr.y = 0
    this.lastCorr.z = 0
    netDiagBufferReset(this.id, reason)
  }

  /**
   * Phase 4: sample narrow-phase contacts for the proxy collider. Called
   * once per rendered frame from MultiplayerManager.updateRemoteCars —
   * NEVER per physics substep. Read-only queries; safe on freed worlds
   * and removed colliders (keeps the previous observation on failure).
   * `nowMs` defaults to the monotonic clock (tests pass explicit times).
   *
   * Only traffic contacts suppress correction: manifolds whose world
   * normal is near-vertical (|ny| > 0.7) are support contacts (a pitched
   * ghost resting its bumper on the road after a knock) — suppressing on
   * those would wedge recovery forever. The ghost normally flies with
   * 0.3 m clearance and gravity off, so road touch implies post-knock
   * attitude, exactly when correction is needed to level back out.
   *
   * Change A: support contacts are additionally reported via noteSupport.
   * Support covers road AND car-top rests (both near-vertical). drive()
   * uses it to refuse downward velocity commands into support. Sampling
   * stays per-frame (updateRemoteCars, post-step); drive() consumes the
   * cached flags per substep with at most one frame of staleness.
   */
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
                  ny = 0 // Unreadable normal: assume traffic (safe side).
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
              // Per-manifold read failure: keep other manifolds' data.
            }
          })
        } catch {
          // Per-pair failure: keep other pairs' data.
        }
      })
    } catch {
      // Freed world / removed collider: retain previous observation.
      return
    }
    this.corr.noteContact(touching, impulse, now)
    this.corr.noteSupport(support)
    netDiagContact(this.id, touching, impulse, this.corr.mode, support)
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
   * the owner's pose. Must run before world.step().
   *
   * Phase 4 (hybrid): the positional correction is scaled by the contact
   * mode (0 while touching, ramped during recovery) and its per-substep
   * change is acceleration-clamped, so collision displacement is no longer
   * treated as tracking error to be undone immediately. The solver's own
   * impulses are never clamped — only our commanded correction is.
   */
  drive(dt: number) {
    const b = this.colliderBody
    if (!b || !this.hasReceivedPacket || dt <= 0) return

    const now = this.now()
    // Freshness is purely receiver-local: `now` and `lastPacketTime` are
    // both stamped with this machine's monotonic clock at arrival
    // (onPacket). The sender's `t` field is never used here — comparing
    // monotonic clocks across machines would corrupt age on skewed pairs.
    //
    // Phase 3: sample the interpolated drive target for
    // (now - INTERP_DELAY_MS). Gains, caps, and warp threshold below are
    // otherwise unchanged (Phase 5+ territory).
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

    // Authority fades when packets go stale: a silent ghost coasts to a stop
    // instead of being nailed to its last known point like a wall anchor
    // that drags everything touching it up to speed.
    const authority = ageS < 0.2 ? 1 : Math.max(0, 1 - (ageS - 0.2) / 0.3)
    const cruiseScale = ageS < 0.5 ? 1 : Math.max(0, 1 - (ageS - 0.5) / 1.0)

    // Contact-mode scale: 1 in follow, 0 while touching, 0→1 ramp during
    // recovery (which additionally holds until error is small — see
    // factor()). Computed after errMag below; advances recover→follow.
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
    // Change B: velocity continuity on recover entry. Passive contact
    // leaves solver velocity untouched; without seeding, the first
    // recovery command would snap linvel to cruise+0 (a halt-pop).
    // Seeding lastCorr from current motion makes it continuous, then the
    // accel clamp + gentle cap brake it home smoothly.
    if (this.corr.mode === "recover" && this.prevCorrMode !== "recover") {
      try {
        const lv = b.linvel()
        this.lastCorr.x = lv.x - this.targetVel.x * cruiseScale
        this.lastCorr.y = lv.y - this.targetVel.y * cruiseScale
        this.lastCorr.z = lv.z - this.targetVel.z * cruiseScale
      } catch {
        // Torn-down body: keep stale correction state, never crash here.
      }
    }
    this.prevCorrMode = this.corr.mode

    try {
      if (distSq > WARP_DIST_SQ) {
        // Teleport/respawn/join-across-map: snap, never fly through the scene.
        netDiagSnap(this.id, "warp-threshold", Math.sqrt(distSq))
        // History spans the discontinuity — drop it so the sampler can
        // never interpolate between pre- and post-teleport positions.
        // Reset-to-empty: the next accepted packet re-primes the buffer.
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

      // Desired velocity = owner's (decaying) cruise velocity + capped
      // positional correction, kept as SEPARATE contributions. Only the
      // correction is contact-scaled and acceleration-clamped: the cruise
      // follows the owner's smooth interpolated trajectory, while the
      // correction is what used to fight collision impulses.
      //
      // Change A: the vertical correction is NOT contact-scaled. Height
      // tracking cannot bulldoze anyone sideways; suppressing it is what
      // let ghosts grind down other cars' flanks and stay sunk. Downward
      // motion into support is handled below by the support clamp instead.
      // Change B: the horizontal cap is gentler during recover
      // (RECOVER_CORR_MAX) so post-contact returns slide instead of pop.
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
      // Change B: the recover cap covers vertical too — a climbed ghost
      // returning from above at the 10 m/s follow cap slams down just as
      // visibly as a horizontal pop.
      const vcap = this.corr.mode === "recover" ? RECOVER_CORR_MAX : CORRECTION_MAX
      const cl = Math.abs(cy)
      if (cl > vcap) {
        cy *= vcap / cl
      }
      let tx = cx * authority * contactScale
      let ty = cy * authority
      let tz = cz * authority * contactScale
      // Change B: in recover, bound the whole correction VECTOR (per-axis
      // caps alone still combine to >4 m/s diagonally — the residual pop).
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
      // Applied per-substep correction change (≤ CORRECTION_ACCEL_MAX*dt
      // by construction) — the energy-bound diagnostic.
      this.corrDeltaV = Math.sqrt(
        (this.appliedCorr.x - px) * (this.appliedCorr.x - px) +
          (this.appliedCorr.y - py) * (this.appliedCorr.y - py) +
          (this.appliedCorr.z - pz) * (this.appliedCorr.z - pz),
      )
      let vx = this.targetVel.x * cruiseScale + this.appliedCorr.x
      let vy = this.targetVel.y * cruiseScale + this.appliedCorr.y
      let vz = this.targetVel.z * cruiseScale + this.appliedCorr.z
      // Change A: never command velocity INTO an active support surface.
      // The solver owns the contact normal direction; our per-substep
      // overwrite used to discard its separations and grind the ghost
      // into road/car-top rests. Horizontal motion is untouched, and the
      // SUPPORT_DESCENT_DY backstop lets ledge/dip descents through (the
      // support vanishes as geometry separates, releasing the clamp).
      if (this.corr.hasSupport && vy < 0 && dy > SUPPORT_DESCENT_DY) {
        vy = 0
      }
      // Change B: hard-hit contact goes passive — the solver owns velocity
      // entirely, so impact momentum persists instead of being erased by
      // the next setLinvel. Gated on impact impulse (not mere touch) so
      // gentle leans keep tracking and rejoin owners that drive off.
      // Warp above still guards true discontinuities.
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
          // Torn-down body: report zero speed, never crash here.
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

      // Angular drive: shortest-arc quaternion error -> angular velocity.
      // Suppressed entirely while touching (contactScale 0): the solver's
      // post-collision spin is left alone, never overwritten. Scaled back
      // in during recovery like the linear correction.
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
        // Hands off: keep whatever angular velocity the solver produced.
      } else if (sinHalf > 1e-4) {
        const angle = 2 * Math.atan2(sinHalf, _qe.w)
        _axis.set(_qe.x / sinHalf, _qe.y / sinHalf, _qe.z / sinHalf)
        let w = angle / dt
        if (w > MAX_DRIVE_ANGVEL) w = MAX_DRIVE_ANGVEL
        else if (w < -MAX_DRIVE_ANGVEL) w = -MAX_DRIVE_ANGVEL
        // No stale snap-back: a silent ghost keeps its knocked rotation.
        w *= authority * contactScale
        wMag = Math.abs(w)
        b.setAngvel({ x: _axis.x * w, y: _axis.y * w, z: _axis.z * w }, true)
      } else if (contactScale >= 1) {
        b.setAngvel({ x: 0, y: 0, z: 0 }, true)
      }
      // Latest-value samples only (no logging here).
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
    // Drop query handles: post-teardown sampleContacts() must no-op
    // instead of touching removed colliders.
    this.collider = null
  }
}
