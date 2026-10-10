import * as RAPIER from "@dimforge/rapier3d-compat"
import * as THREE from "three"
import { CAR_PHYSICS } from "../constants/physics"
import type { DriveInput } from "./InputManager"
import { SuspensionSystem, type WheelSuspState } from "./Suspension"
import {
  WheelDynamics,
  estimateWheelInertia,
} from "./WheelDynamics"
import {
  TireModel,
  type TireResult,
} from "./TireModel"

export type Gear = -1 | 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8

export interface CarTelemetry {
  speedKmh: number
  rpm: number
  gear: Gear
  gearLabel: string
  autoMode: boolean
  throttle: number
  brake: number
  steer: number
  shifting: boolean
  launchArmed: boolean
  launching: boolean
  parkingBrake: boolean
  slipRatio: number
  drift: boolean
}

function lerp(a: number, b: number, t: number) {
  return a + (b - a) * t
}

function clamp(v: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, v))
}

function torqueMult(
  curve: readonly (readonly number[])[],
  rpm: number,
): number {
  if (rpm <= curve[0][0]) return curve[0][1]
  for (let i = 1; i < curve.length; i++) {
    if (rpm <= curve[i][0]) {
      const [r0, m0] = curve[i - 1]
      const [r1, m1] = curve[i]
      const t = (rpm - r0) / Math.max(1, r1 - r0)
      return lerp(m0, m1, t)
    }
  }
  return 0
}

const WHEEL_LOCAL = [
  { x: -0.76, z: -1.51, front: true, left: true },
  { x: 0.76, z: -1.51, front: true, left: false },
  { x: -0.76, z: 1.31, front: false, left: true },
  { x: 0.76, z: 1.31, front: false, left: false },
]

export class CarController {
  body: RAPIER.RigidBody
  world: RAPIER.World
  R: typeof RAPIER

  gear: Gear = 1
  autoMode = true
  rpm: number = CAR_PHYSICS.engine.idleRPM
  private shiftTimer = 0
  private clutch = 1
  /** Mean rear-wheel angular velocity, rad/s (diagnostic for RPM coupling). */
  private wheelOmega = 0
  /** Mean rear-wheel angular velocity, rad/s (legacy visual/telemetry tap). */
  spinOmega = 0
  launchEnabled = true
  launching = false
  launchArmed = false
  private simTime = 0
  private limiterCut = false
  private launchTimer = 0
  parkingBrake = true

  steerAngle = 0
  slipRatioAvg = 0
  drifting = false
  rearSlip = 0
  lastWheelLoad = [0, 0, 0, 0]
  lastWheelLong = [0, 0, 0, 0]
  /** Persistent per-wheel suspension states (Phase 2 solver). */
  suspension: SuspensionSystem
  /** Persistent per-wheel rotational states (Phase 3 solver). */
  wheelDynamics: WheelDynamics
  /** Coherent per-wheel tire model (Phase 4). Owns all tire forces. */
  tireModel: TireModel
  /** Per-wheel tire diagnostics (slip, forces, limits) for tests/HUD. */
  lastTireDiag: TireResult[] = []
  /**
   * Relaxation-lagged contact forces per wheel (Pacejka transient
   * model). The lag state — not the wheel — absorbs contact stiffness,
   * which is what makes the whole coupling stable without Newton
   * solves. Reset with the car.
   */
  tireLag: { fx: number; fy: number }[] = [{ fx: 0, fy: 0 }, { fx: 0, fy: 0 }, { fx: 0, fy: 0 }, { fx: 0, fy: 0 }]

  private filteredSpeed = 0

  constructor(world: RAPIER.World, body: RAPIER.RigidBody, R: typeof RAPIER) {
    this.world = world
    this.body = body
    this.R = R
    this.body.setLinearDamping(0.005)
    this.body.setAngularDamping(0.55)
    this.suspension = new SuspensionSystem(world, body, R, WHEEL_LOCAL)
    const P0 = CAR_PHYSICS
    const wheelMass =
      (P0.mass.frontWheel + P0.mass.rearWheel) / 2
    this.wheelDynamics = new WheelDynamics(
      P0.wheels.radius,
      estimateWheelInertia(wheelMass, P0.wheels.radius),
      P0.wheels.slipDampRate,
    )
    this.tireModel = new TireModel(
      {
        mu: P0.wheels.frictionMu,
        referenceLoad: P0.wheels.referenceLoad,
        loadExpLong: P0.wheels.pacejka.longitudinal.loadSensitivity,
        loadExpLat: P0.wheels.pacejka.lateral.loadSensitivity,
        rollingResist: P0.wheels.rollingResist,
        long: {
          B: P0.wheels.pacejka.longitudinal.B,
          C: P0.wheels.pacejka.longitudinal.C,
          D: P0.wheels.pacejka.longitudinal.D,
          E: P0.wheels.pacejka.longitudinal.E,
        },
        lat: {
          B: P0.wheels.pacejka.lateral.B,
          C: P0.wheels.pacejka.lateral.C,
          D: P0.wheels.pacejka.lateral.D,
          E: P0.wheels.pacejka.lateral.E,
        },
      },
      P0.wheels.radius,
    )
  }

  reset(pos: THREE.Vector3, yaw = 0) {
    this.body.setTranslation({ x: pos.x, y: pos.y, z: pos.z }, true)
    const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, yaw, 0))
    this.body.setRotation({ x: q.x, y: q.y, z: q.z, w: q.w }, true)
    this.body.setLinvel({ x: 0, y: 0, z: 0 }, true)
    this.body.setAngvel({ x: 0, y: 0, z: 0 }, true)
    this.gear = 1
    this.rpm = CAR_PHYSICS.engine.idleRPM
    this.shiftTimer = 0
    this.clutch = 1
    this.wheelOmega = 0
    this.spinOmega = 0
    this.wheelDynamics.reset()
    for (const lag of this.tireLag) {
      lag.fx = 0
      lag.fy = 0
    }
    // Transient filters must not leak across a reset, otherwise a reset
    // car behaves differently from a fresh one (e.g. a hot TC slip average
    // would cut engine torque on the first post-reset launch).
    this.steerAngle = 0
    this.slipRatioAvg = 0
    this.rearSlip = 0
    this.parkingBrake = true
    this.launchTimer = 0
    this.limiterCut = false
    for (const st of this.suspension.states) {
      st.grounded = false
      st.compression = 0
      st.suspVel = 0
      st.springF = 0
      st.damperF = 0
      st.arbF = 0
      st.force = 0
      st.load = 0
    }
  }

  get forwardSpeed(): number {
    const v = this.body.linvel()
    const q = this.body.rotation()
    const quat = new THREE.Quaternion(q.x, q.y, q.z, q.w)
    const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(quat)
    return v.x * fwd.x + v.y * fwd.y + v.z * fwd.z
  }

  /** Per-wheel angular velocities in WHEEL_LOCAL order, rad/s. */
  getWheelOmegas(): [number, number, number, number] {
    return this.wheelDynamics.omegas()
  }

  /**
   * Service + parking + handbrake torque magnitude for one wheel, N·m.
   * Handbrake targets the rear axle only (see hbLock). Returned value is
   * a magnitude — the wheel integrator applies the opposing direction.
   * Includes the legacy ABS pulse (simplified approximation, Phase 6 owns
   * a true slip-based ABS): below 2 m/s patch speed under hard braking
   * the torque pulsates at ~14 Hz to limit low-speed lock/jitter. The
   * tire pass calls this same helper so the chassis-force path and
   * the rotation path can never disagree on brake input.
   */
  private brakeTorqueFor(
    w: (typeof WHEEL_LOCAL)[number],
    input: DriveInput,
    speedKmh: number,
    vLongPatch: number,
    simTime: number,
  ): number {
    const P = CAR_PHYSICS
    const brakeMax = w.front
      ? P.wheels.brakeForce.front
      : P.wheels.brakeForce.rear
    let base: number
    if (this.gear === -1) {
      base = input.brake * brakeMax
      if (this.parkingBrake) base = Math.max(base, 3000)
    } else {
      const hbLock = input.handbrake && !w.front
      const lockF = Math.abs(input.steer)
      const hbDrag = 2600 - 1400 * lockF - 800 * clamp(speedKmh / 15, 0, 1)
      const hbForce = hbLock
        ? input.throttle > 0.5
          ? hbDrag
          : P.wheels.handbrakeForce
        : 0
      base = input.brake * brakeMax + hbForce
      if (this.parkingBrake) base = Math.max(base, 3000)
    }
    const wheelLock =
      Math.abs(vLongPatch) < 2 && input.brake > 0.7 && Math.abs(vLongPatch) > 0.5
    if (P.assists.absEnabled && wheelLock)
      base *= 0.6 + 0.4 * Math.sin(simTime * 90)
    return base
  }

  /** Per-wheel suspension compressions in WHEEL_LOCAL order, metres. */
  getWheelCompressions(): [number, number, number, number] {
    const s = this.suspension.states
    return [
      s[0]?.compression ?? 0,
      s[1]?.compression ?? 0,
      s[2]?.compression ?? 0,
      s[3]?.compression ?? 0,
    ]
  }

  update(dt: number, input: DriveInput): CarTelemetry {
    const P = CAR_PHYSICS
    dt = Math.min(dt, P.simulation.maxFrameDt)
    this.simTime += dt

    if (input.toggleModePressed) this.autoMode = !this.autoMode
    if (input.toggleLaunchPressed) this.launchEnabled = !this.launchEnabled
    if (this.shiftTimer > 0) this.shiftTimer -= dt

    if (!this.autoMode) {
      if (input.upshiftPressed) this.manualShift(1)
      if (input.downshiftPressed) this.manualShift(-1)
    }

    const linvel = this.body.linvel()
    const fwdSpeed = this.forwardSpeed
    this.filteredSpeed +=
      (Math.abs(fwdSpeed) - this.filteredSpeed) * Math.min(1, dt * 6)

    const rot = this.body.rotation()
    const quat = new THREE.Quaternion(rot.x, rot.y, rot.z, rot.w)
    const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(quat)
    const right = new THREE.Vector3(1, 0, 0).applyQuaternion(quat)
    fwd.y = 0
    right.y = 0
    fwd.normalize()
    right.normalize()

    const latVGlobal = linvel.x * right.x + linvel.z * right.z
    const beta = clamp(latVGlobal / Math.max(10, Math.abs(fwdSpeed)), -0.4, 0.4)

    if (input.throttle > 0.3) this.parkingBrake = false

    const speedKmh = Math.abs(fwdSpeed) * 3.6
    const S = P.wheels.steering
    const steerFactor =
      1 /
      (1 + Math.pow(speedKmh / S.speedFalloffKmh, 2) * S.speedSensitivity * 3)
    const gripCap = Math.atan((2.85 * 32) / Math.max(40, fwdSpeed * fwdSpeed))
    const steerCap = Math.max(gripCap, S.minAngleAtSpeed)
    const targetSteer = clamp(
      input.steer * S.maxAngle * steerFactor,
      -steerCap,
      steerCap,
    )
    const steerRate = 6
    this.steerAngle += clamp(
      targetSteer - this.steerAngle,
      -steerRate * dt,
      steerRate * dt,
    )

    const atStandstill = Math.abs(fwdSpeed) < 1.2
    this.launchArmed =
      this.launchEnabled &&
      atStandstill &&
      this.gear === 1 &&
      input.throttle > 0.7 &&
      input.brake > 0.2

    const ratios = P.transmission.gearRatios
    const finalDrive = P.transmission.finalDriveRatio
    const wheelRadius = P.wheels.radius
    const rollingOmega = fwdSpeed / Math.max(0.2, wheelRadius)

    let gearRatio = 0
    if (this.gear > 0) gearRatio = ratios[this.gear - 1] * finalDrive
    else if (this.gear === -1) gearRatio = 3.2 * finalDrive

    let targetRpm: number
    if (this.gear === 0) {
      targetRpm =
        P.engine.idleRPM +
        input.throttle * (P.engine.redlineRPM - P.engine.idleRPM) * 0.9
      if (targetRpm > this.rpm) {
        this.rpm += (targetRpm - this.rpm) * Math.min(1, dt * 5.0)
      } else {
        const excess = Math.max(0, this.rpm - P.engine.idleRPM)
        const decay = 1.2 + 1.3 * Math.min(1, excess / 3500)
        this.rpm = P.engine.idleRPM + excess * Math.exp(-decay * dt)
      }
    } else {
      const coupled = Math.abs((rollingOmega * gearRatio * 60) / (2 * Math.PI))
      const clutchSlip =
        clamp(1 - Math.abs(fwdSpeed) / 6, 0, 1) * (1 - this.clutch * 0)
      const throttleFlare = input.throttle * clutchSlip * 2500
      targetRpm = Math.max(P.engine.idleRPM * 0.95, coupled + throttleFlare)
      if (
        !this.launchArmed &&
        Math.abs(fwdSpeed) < 3 &&
        input.throttle > 0.1 &&
        this.gear >= 1
      ) {
        targetRpm = Math.max(
          targetRpm,
          P.engine.idleRPM + input.throttle * 2200,
        )
      }
      if (this.launchArmed) targetRpm = P.transmission.launchControlRPM
      this.rpm += (targetRpm - this.rpm) * Math.min(1, dt * 10)
      // Phase 3: wheel angular velocity is integrated independently in
      // wheelDynamics (see tire pass). It is NEVER overwritten here; the
      // gearbox reads mean rear-wheel speed via predictedRpm/afterShift.
    }

    this.launching = false
    if (this.launchArmed) {
      this.launchTimer = 2.0
      if (this.rpm > P.transmission.launchControlRPM) {
        this.rpm =
          P.transmission.launchControlRPM + Math.sin(this.simTime * 50) * 120
      }
    } else {
      this.launchTimer = Math.max(0, this.launchTimer - dt)
    }
    this.launching =
      !this.launchArmed &&
      this.launchTimer > 0 &&
      !atStandstill &&
      input.throttle > 0.7
    const LIM = P.engine.revLimiterRPM
    if (this.rpm >= LIM) this.limiterCut = true
    else if (this.rpm < LIM - 400) this.limiterCut = false
    if (this.rpm > LIM) this.rpm = LIM

    if (this.autoMode && this.shiftTimer <= 0 && this.gear >= 1) {
      if (
        input.throttle > 0.25 &&
        this.rpm > P.transmission.autoUpshiftRPM &&
        this.gear < 8
      ) {
        this.doShift(1)
      } else if (this.rpm < 1400 && this.gear > 1) {
        this.doShift(-1)
      } else if (speedKmh < 5 && this.gear > 1) {
        this.doShift(-1)
      }
    }
    const shifting = this.shiftTimer > 0

    const torqueCurveMult = torqueMult(P.engine.torqueCurve, this.rpm)
    let engineTorque = P.engine.maxTorqueNm * torqueCurveMult * input.throttle
    const friction =
      P.engine.frictionTorqueBase + this.rpm * P.engine.frictionTorqueRPMFactor
    engineTorque -= friction * 0.25
    if (this.gear === 0) engineTorque = 0
    if (shifting) engineTorque *= 0.25
    if (this.limiterCut) engineTorque = 0

    const tcGain =
      (input.handbrake ? 0 : P.assists.tractionControl) *
      (this.launching || this.launchArmed ? 0.35 : 1)
    if (this.slipRatioAvg > 0.18) {
      let cut = clamp((this.slipRatioAvg - 0.18) / 0.5, 0, 1)
      if (input.throttle > 0.5 && Math.abs(beta) > 0.14 && !this.launching) {
        cut = Math.min(1, cut + clamp((Math.abs(beta) - 0.14) * 4, 0, 0.3))
      }
      if (
        !input.handbrake &&
        Math.abs(this.steerAngle) > 0.12 &&
        !this.launching
      ) {
        cut = Math.min(
          1,
          cut + clamp((this.slipRatioAvg - 0.15) * 2.5, 0, 0.55),
        )
      }
      engineTorque *= lerp(1, 1 - Math.min(0.85, tcGain * 2), cut)
    }
    engineTorque = Math.max(0, engineTorque)

    const tcMult =
      this.gear !== 0
        ? 1 +
          (P.transmission.torqueConverter.stallMultiplication - 1) *
            clamp(
              1 - speedKmh / P.transmission.torqueConverter.lockupSpeedKmh,
              0,
              1,
            )
        : 1
    let driveTorquePerRear = 0
    if (this.gear !== 0) {
      const dir = this.gear === -1 ? -1 : 1
      driveTorquePerRear = (engineTorque * gearRatio * 0.85 * tcMult * dir) / 2
      if (this.launchArmed) driveTorquePerRear = 0
    }

    const pos = this.body.translation()
    const bodyPos = new THREE.Vector3(pos.x, pos.y, pos.z)
    let totalSlip = 0
    let rearSlipSum = 0
    let rearCount = 0

    interface WheelSolve {
      w: (typeof WHEEL_LOCAL)[number]
      wi: number
      grounded: boolean
      load: number
      contactY: number
      anchor: THREE.Vector3
      /** Contact-point velocity (linvel + angvel × full lever), m/s. */
      patchVel: THREE.Vector3
      /** Flat wheel heading (steer included for fronts). */
      heading: THREE.Vector3
      /** Contact normal from the suspension raycast. */
      normal: THREE.Vector3
      /** Shaft drive torque for the rotation solve (rear only, RWD). */
      driveT: number
      /** Brake torque magnitude for the rotation solve. */
      brakeM: number
    }
    const solves: WheelSolve[] = []
    const angvel0 = this.body.angvel()

    // Phase 2 suspension: independent per-wheel spring/damper/ARB solve
    // along the chassis-up axis. Applies chassis impulses at each anchor
    // and returns persistent contact/load states for the tire pass below.
    const linVec = new THREE.Vector3(linvel.x, linvel.y, linvel.z)
    const angVec = new THREE.Vector3(angvel0.x, angvel0.y, angvel0.z)
    const suspStates: WheelSuspState[] = this.suspension.update(
      dt,
      quat,
      bodyPos,
      linVec,
      angVec,
    )
    let groundedWheels = 0
    for (const st of suspStates) {
      this.lastWheelLoad[st.wi] = st.load
      if (!st.grounded) this.lastWheelLong[st.wi] = 0
      else groundedWheels++
    }

    for (let wi = 0; wi < WHEEL_LOCAL.length; wi++) {
      const w = WHEEL_LOCAL[wi]
      const st = suspStates[wi]
      const anchorWorld = st.anchorWorld

      const steer = w.front ? this.steerAngle : 0
      const wheelFwd = new THREE.Vector3(
        Math.sin(steer) * -1,
        0,
        -Math.cos(steer),
      ).applyQuaternion(quat)
      wheelFwd.y = 0
      wheelFwd.normalize()

      // Phase 3+4 wheel torques: shaft drive routes to the rear axle
      // only (RWD); brake magnitudes come from the shared helper. The
      // rotation solve runs in the tire pass below for grounded wheels
      // (explicit, fed by the lagged contact force) and here for
      // airborne wheels (no contact at all).
      const driveT = w.front ? 0 : driveTorquePerRear
      const vLongPre = st.pointVel.dot(wheelFwd)
      const brakeM = this.brakeTorqueFor(
        w,
        input,
        speedKmh,
        vLongPre,
        this.simTime,
      )

      if (!st.grounded) {
        this.wheelDynamics.step(wi, dt, driveT, brakeM, 0, undefined)
        this.tireLag[wi].fx = 0
        this.tireLag[wi].fy = 0
        solves.push({
          w,
          wi,
          grounded: false,
          load: 0,
          contactY: 0,
          anchor: anchorWorld,
          patchVel: new THREE.Vector3(),
          heading: wheelFwd,
          normal: new THREE.Vector3(0, 1, 0),
          driveT,
          brakeM,
        })
        continue
      }

      // True contact-point velocity: rigid-body motion at the contact
      // patch (not the hub), so pitch/roll/yaw rates feed the tire.
      const contactPoint = new THREE.Vector3(
        anchorWorld.x,
        st.contactY,
        anchorWorld.z,
      )
      const lever = contactPoint.clone().sub(bodyPos)
      const patchVel = linVec.clone().add(angVec.clone().cross(lever))
      solves.push({
        w,
        wi,
        grounded: true,
        load: st.load,
        contactY: st.contactY,
        anchor: anchorWorld,
        patchVel,
        heading: wheelFwd,
        normal: st.contactNormal.clone(),
        driveT,
        brakeM,
      })
    }

    // Phase 4 tire pass: ONE model (TireModel) owns all tire forces.
    // Shaft/brake torques act only on the wheels (solves loop above);
    // contact forces emerge from slip and feed the chassis here, with the
    // equal-and-opposite reaction stored for the next rotation solve.
    for (const s of solves) {
      const { w, wi } = s
      if (!s.grounded) {
        this.lastWheelLong[wi] = 0
        this.lastTireDiag[wi] = this.tireModel.eval({
          grounded: false,
          normalLoad: 0,
          normal: { x: 0, y: 1, z: 0 },
          patchVel: { x: 0, y: 0, z: 0 },
          wheelOmega: 0,
          wheelHeading: { x: 0, y: 0, z: -1 },
          bodyForward: { x: 0, y: 0, z: -1 },
        })
        continue
      }
      const omega = this.wheelDynamics.wheels[wi].omega
      const contact = {
        grounded: true,
        normalLoad: s.load,
        normal: { x: s.normal.x, y: s.normal.y, z: s.normal.z },
        patchVel: { x: s.patchVel.x, y: s.patchVel.y, z: s.patchVel.z },
        wheelOmega: omega,
        wheelHeading: { x: s.heading.x, y: s.heading.y, z: s.heading.z },
        bodyForward: { x: fwd.x, y: 0, z: fwd.z },
      }
      const res = this.tireModel.eval(contact)

      // TEMPORARY Phase-5 driveline placeholders, behavior-identical to
      // the legacy tire pass: torque-converter creep, engine-braking
      // coast, hill-hold. Small contact forces with no tire-model home
      // yet; kept isolated here (outside the friction ellipse) and
      // included in the wheel reaction like all contact forces.
      let legacyLong = 0
      if (this.gear >= 1 && fwdSpeed < 0.05 && fwdSpeed > -2) {
        if (!w.front) legacyLong += clamp(-fwdSpeed * 1500, 0, 2000)
      }
      if (
        this.gear >= 1 &&
        input.throttle < 0.05 &&
        input.brake < 0.05 &&
        fwdSpeed > -0.5 &&
        fwdSpeed < 3
      ) {
        if (!w.front)
          legacyLong +=
            (P.transmission.torqueConverter.creepForce / 2) *
            clamp(1 - fwdSpeed / 3, 0, 1)
      }
      if (this.gear === -1) {
        if (
          !w.front &&
          input.throttle < 0.05 &&
          input.brake < 0.05 &&
          fwdSpeed < 0.5 &&
          fwdSpeed > -3
        ) {
          legacyLong -=
            (P.transmission.torqueConverter.creepForceReverse / 2) *
            clamp(1 + fwdSpeed / 3, 0, 1)
        }
      }
      if (
        !w.front &&
        input.throttle < 0.05 &&
        this.gear >= 1 &&
        Math.abs(res.vx) > 1
      ) {
        const lockup = clamp((speedKmh - 10) / 15, 0, 1)
        const engFric =
          P.engine.frictionTorqueBase +
          this.rpm * P.engine.frictionTorqueRPMFactor
        const coastT = (engFric * gearRatio * 0.85 * lockup) / 2 / wheelRadius
        legacyLong += clamp(-Math.sign(res.vx) * coastT, -2500, 2500)
      }

      // Relaxation-lagged contact force (Pacejka transient model): the
      // lag state chases the steady-state curve with rate |vx|/σ,
      // integrated implicitly (unconditionally stable, exact, one line).
      // The lag — not the wheel — absorbs contact stiffness, so the
      // wheel integrator below stays explicit and can neither explode
      // nor trap in false slide-side wells. TC slip still reads the
      // instantaneous (steady-state) slip, so assists stay responsive.
      // The +0.5 m/s floor keeps parked forces from freezing stale
      // (relaxing in ~0.8 s at standstill instead of never).
      const lag = this.tireLag[wi]
      const rate =
        (Math.abs(res.vx) + 0.5) / CAR_PHYSICS.wheels.relaxationLength
      lag.fx = (lag.fx + dt * rate * res.fx) / (1 + dt * rate)
      lag.fy = (lag.fy + dt * rate * res.fy) / (1 + dt * rate)
      this.lastTireDiag[wi] = res

      // TC slip source: signed rear-axle slip ratio (fronts read 0, as
      // before — TC manages driven-wheel spin only in this phase).
      if (!w.front) {
        totalSlip += Math.abs(res.sx)
        rearSlipSum += res.sx
        rearCount++
      }

      // Explicit wheel rotation with the lagged contact force (0-delay
      // within the step) plus the viscous saturation brake. Bounded
      // torques only: unconditionally non-explosive.
      this.wheelDynamics.step(
        wi,
        dt,
        s.driveT,
        s.brakeM,
        (lag.fx + legacyLong) * wheelRadius,
        res.vx,
      )

      const fxFinal = lag.fx + legacyLong
      const fyFinal = lag.fy
      this.lastWheelLong[wi] = fxFinal
      // Reaction bookkeeping: exact match to the applied chassis force
      // (diagnostic — the rotation solve above consumed the same value).
      this.wheelDynamics.wheels[wi].tireTorque = fxFinal * wheelRadius

      const Fx = res.t.x * fxFinal + res.l.x * fyFinal
      const Fy = res.t.y * fxFinal + res.l.y * fyFinal
      const Fz = res.t.z * fxFinal + res.l.z * fyFinal
      const applyY = s.contactY + (s.anchor.y - s.contactY) * 0.5
      this.body.applyImpulseAtPoint(
        { x: Fx * dt, y: Fy * dt, z: Fz * dt },
        { x: s.anchor.x, y: applyY, z: s.anchor.z },
        true,
      )
    }

    this.slipRatioAvg +=
      ((groundedWheels > 0 ? totalSlip / 4 : 0) - this.slipRatioAvg) *
      Math.min(1, dt * 5)
    if (rearCount > 0) this.rearSlip = rearSlipSum / rearCount
    // Phase 3: mean rear-wheel speed comes from the independent rotation
    // solver (wheelspin/lock included). Hooked rolling matches rollingOmega
    // exactly, so RPM coupling via predictedRpm/afterShift is preserved.
    const rearOm = this.wheelDynamics.omegas()
    this.wheelOmega = (rearOm[2] + rearOm[3]) / 2
    this.spinOmega = this.wheelOmega
    this.drifting = Math.abs(this.lateralVelocity()) > 4.5 && speedKmh > 40

    const vVec = new THREE.Vector3(linvel.x, 0, linvel.z)
    const vMag = vVec.length()
    if (vMag > 0.5) {
      const dragF =
        0.5 *
        P.aero.airDensity *
        P.aero.dragCoefficient *
        P.aero.frontalArea *
        vMag *
        vMag
      const downF =
        (P.aero.downforceAt100kmh / Math.pow(27.78, 2)) * vMag * vMag
      const drag = vVec.clone().normalize().multiplyScalar(-dragF)
      this.body.applyImpulse(
        { x: drag.x * dt, y: -downF * dt, z: drag.z * dt },
        true,
      )
    }

    // Phase 2: artificial pitch/roll righting REMOVED. Pitch and roll
    // moments now come only from suspension geometry (forces at anchors),
    // tire forces, mass distribution and inertia. Yaw damping below is a
    // separate stability-assist concern (Phase 6 territory), not chassis
    // uprighting, so it stays.
    const angvel = this.body.angvel()
    this.body.applyTorqueImpulse(
      { x: 0, y: -angvel.y * 1800 * dt, z: 0 },
      true,
    )

    if (Math.abs(fwdSpeed) > 2.5 && groundedWheels >= 3 && !input.handbrake) {
      const steering = Math.abs(input.steer) >= 0.05
      const deadzone = steering ? 0.06 : 0.02
      const betaExcess = Math.abs(beta) - deadzone
      if (betaExcess > 0) {
        const speedF = clamp(Math.abs(fwdSpeed) / 33.3, 0, 1)
        const armed = this.launchArmed || this.launching
        const powerOn = input.throttle > 0.15 && !armed
        const authority =
          (steering ? lerp(0.9, 0.5, speedF) : 1) *
          (0.5 + P.assists.stabilityControl) *
          (powerOn ? 1.0 : 1.35)
        let esc = -Math.sign(beta) * betaExcess * 6000 - angvel.y * 1500
        const countersteering = Math.sign(input.steer) === -Math.sign(beta)
        const intent = countersteering
          ? input.steer *
            clamp(betaExcess / 0.1, 0, 1) *
            P.assists.countersteerAssist
          : 0
        esc += intent
        this.body.applyTorqueImpulse(
          { x: 0, y: clamp(esc * authority, -6000, 6000) * dt, z: 0 },
          true,
        )
      }
    }
    // Airborne: no active attitude control — with no contacts there is
    // nothing physical to push against. (Phase 2: the old pitch/roll
    // damping here was removed with the grounded uprighting torques.)

    const gearLabel =
      this.gear === -1 ? "R" : this.gear === 0 ? "N" : String(this.gear)
    return {
      speedKmh: Math.abs(fwdSpeed) * 3.6 * Math.sign(fwdSpeed || 1),
      rpm: Math.round(this.rpm),
      gear: this.gear,
      gearLabel,
      autoMode: this.autoMode,
      throttle: input.throttle,
      brake: input.brake,
      steer: input.steer,
      shifting,
      launchArmed: this.launchArmed,
      launching: this.launching,
      parkingBrake: this.parkingBrake,
      slipRatio: this.slipRatioAvg,
      drift: this.drifting,
    }
  }

  private lateralVelocity(): number {
    const v = this.body.linvel()
    const q = this.body.rotation()
    const quat = new THREE.Quaternion(q.x, q.y, q.z, q.w)
    const right = new THREE.Vector3(1, 0, 0).applyQuaternion(quat)
    return v.x * right.x + v.z * right.z
  }

  private predictedRpm(gear: Gear): number {
    if (gear <= 0) return 0
    const P = CAR_PHYSICS
    const ratio =
      P.transmission.gearRatios[gear - 1] * P.transmission.finalDriveRatio
    return Math.abs((this.wheelOmega * ratio * 60) / (2 * Math.PI))
  }

  private manualShift(dir: 1 | -1) {
    if (this.shiftTimer > 0) return
    const order: Gear[] = [-1, 0, 1, 2, 3, 4, 5, 6, 7, 8]
    const i = order.indexOf(this.gear)
    const j = clamp(i + dir, 0, order.length - 1)
    if (j === i) return
    if (order[j] === -1 && Math.abs(this.forwardSpeed) > 3) return
    if (order[j] >= 1 && this.gear === 0 && Math.abs(this.forwardSpeed) > 60)
      return
    if (
      order[j] >= 1 &&
      dir < 0 &&
      this.predictedRpm(order[j]) > CAR_PHYSICS.engine.redlineRPM - 200
    )
      return
    this.gear = order[j]
    this.shiftTimer = CAR_PHYSICS.transmission.shiftTimeManual
    this.afterShift()
  }

  private doShift(dir: 1 | -1) {
    const next = clamp((this.gear as number) + dir, 1, 8) as Gear
    if (next === this.gear) return
    if (
      dir < 0 &&
      this.predictedRpm(next) > CAR_PHYSICS.engine.redlineRPM - 200
    )
      return
    this.gear = next
    this.shiftTimer = CAR_PHYSICS.transmission.shiftTimeAuto
    this.afterShift()
  }

  private afterShift() {
    const P = CAR_PHYSICS
    if (this.gear === 0 || this.gear === -1) return
    const ratio =
      P.transmission.gearRatios[this.gear - 1] * P.transmission.finalDriveRatio
    const coupled = Math.abs((this.wheelOmega * ratio * 60) / (2 * Math.PI))
    this.rpm = clamp(coupled, P.engine.idleRPM, P.engine.redlineRPM - 400)
  }
}
