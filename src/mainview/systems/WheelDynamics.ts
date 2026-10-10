/**
 * Phase 3 — independent per-wheel rotational dynamics.
 *
 * Rotational equation of motion (explicit Euler at FIXED_DT):
 *
 *   I * dω/dt = T_drive - T_brake_signed - T_tire
 *
 * Sign convention: positive ω = forward rolling (matches forward vehicle
 * motion; the visual mesh consumes ω and integrates rotation from it, never
 * the reverse). All torques in newton-metres, I in kg·m², ω in rad/s.
 *
 * - T_drive: signed. Positive drives forward; negative (reverse gear)
 *   drives backward. Zero for undriven wheels (front axle in RWD).
 * - T_brake: passed as a non-negative magnitude; the integrator opposes the
 *   wheel's current rotation and clamps to rest instead of flipping sign,
 *   so brakes can lock a wheel without numerical chatter.
 * - T_tire: ground reaction torque from the previous substep's longitudinal
 *   tire force (T_tire = F_long_on_chassis * radius). By Newton's third law
 *   the ground force accelerating the chassis forward reacts backward on
 *   the wheel, hence the minus sign. Zero when airborne.
 * - T_damp: TEMPORARY adapter (see slipDampRate in physics.ts) — viscous
 *   tire-loss torque k*(ωr - v_road)*r opposing contact slip velocity,
 *   wheel-side only. Zero at perfect hook and zero when airborne.
 *
 * Full equation: I * dω/dt = T_drive - T_brake_signed - T_tire - T_damp
 *
 * NOTE on stiffness: the tire contact itself is far too stiff for this
 * explicit solve (tens of kN per m/s at the hook → gain dT/dω·dt/I ≈
 * 20-30 at low speed). Stability comes from the architecture, not this
 * integrator: the tire force it consumes is the RELAXATION-LAGGED force
 * (see relaxationLength), whose slope within a step is ~zero, and the
 * viscous term is capped (k·r²·dt/I < 2). An earlier revision tried a
 * linearized-implicit Newton coupling instead; it developed spurious
 * slide-side attractors (counter-rotating wheels at idle) and was
 * removed in favor of the lag architecture.
 *
 * Inertia: configured wheel mass is 25 kg per corner (translational,
 * unsprung assembly: wheel + tire + brake — kept OUT of the rigid-body
 * mass, so no double counting with the 1650 kg chassis). Rotational
 * inertia is estimated as a solid disc, I = 1/2·m·r² = 0.5·25·0.33² ≈
 * 1.36 kg·m². A real tire concentrates mass at the tread (toward hoop,
 * 1.0·m·r²) while hub/brake mass sits near the axis; 1/2 is the documented
 * middle estimate until a measured value exists. Translational unsprung
 * mass (4×25 kg pressing on the ground) remains unmodelled — normal-load
 * totals still reflect the chassis only (see Suspension.ts); flagged for
 * review, not silently absorbed here.
 */

export interface WheelSpinState {
  /** Angular velocity, rad/s. + = forward rolling. */
  omega: number
  /** Rotational inertia, kg·m². */
  inertia: number
  /** Wheel radius, m. */
  radius: number
  /** Signed drive torque applied this step, N·m. */
  driveTorque: number
  /** Brake torque magnitude applied this step, N·m (>= 0). */
  brakeTorque: number
  /** Ground reaction torque from the previous step, N·m. */
  tireTorque: number
  /** Viscous slip-loss torque applied this step, N·m (0 when airborne). */
  slipDampTorque: number
  /** Net torque actually integrated this step, N·m. */
  netTorque: number
  /** Angular acceleration this step, rad/s². */
  alpha: number
}

export function estimateWheelInertia(massKg: number, radiusM: number): number {
  return 0.5 * massKg * radiusM * radiusM
}

export class WheelDynamics {
  readonly wheels: WheelSpinState[] = []
  /** Viscous loss rate, N per m/s of slip velocity (temporary adapter). */
  readonly slipDampRate: number

  constructor(
    radius: number,
    inertia: number,
    slipDampRate = 0,
    count = 4,
  ) {
    this.slipDampRate = slipDampRate
    for (let i = 0; i < count; i++) {
      this.wheels.push({
        omega: 0,
        inertia,
        radius,
        driveTorque: 0,
        brakeTorque: 0,
        tireTorque: 0,
        slipDampTorque: 0,
        netTorque: 0,
        alpha: 0,
      })
    }
  }

  reset(): void {
    for (const w of this.wheels) {
      w.omega = 0
      w.driveTorque = 0
      w.brakeTorque = 0
      w.tireTorque = 0
      w.slipDampTorque = 0
      w.netTorque = 0
      w.alpha = 0
    }
  }

  /**
   * Integrate one wheel for dt seconds. Drive, tire-reaction and brake
   * torques are explicit; the stiff viscous slip damper is integrated
   * IMPLICITLY (backward Euler on that term only), which is
   * unconditionally stable for any k at this timestep — an explicit
   * damper would need k*r²*dt/I < 2 and explode. Brake torque opposes
   * rotation; when the brake impulse would reverse the wheel within this
   * step the wheel stops exactly at rest (locked) instead of oscillating.
   * Pass roadSpeed only for a grounded wheel; omit (airborne) to disable
   * both the tire reaction path and the slip damper.
   */
  step(
    wi: number,
    dt: number,
    driveTorque: number,
    brakeTorqueMag: number,
    tireTorque: number,
    roadSpeed?: number,
  ): WheelSpinState {
    const w = this.wheels[wi]
    const brake = Math.max(0, brakeTorqueMag)
    w.driveTorque = driveTorque
    w.brakeTorque = brake
    w.tireTorque = tireTorque

    // Implicit viscous damper: solve
    //   ω' = ω + dt*(T_drive - T_tire)/I - dt*k*r*(ω'*r - v)/I
    // for ω'. Same equilibrium as the explicit form, stable for any k.
    const stiff =
      roadSpeed === undefined
        ? 0
        : (dt * this.slipDampRate * w.radius * w.radius) / w.inertia
    let omega =
      (w.omega +
        ((driveTorque - tireTorque) / w.inertia) * dt +
        (roadSpeed === undefined
          ? 0
          : ((dt * this.slipDampRate * w.radius) / w.inertia) * roadSpeed)) /
      (1 + stiff)
    w.slipDampTorque =
      roadSpeed === undefined
        ? 0
        : this.slipDampRate * (omega * w.radius - roadSpeed) * w.radius

    // Brake as an opposing impulse with a zero-crossing clamp. Applied
    // after the damper solve so the clamp stays exact: the brake can only
    // remove motion, never create it.
    const brakeStep = (brake / w.inertia) * dt
    if (Math.abs(omega) <= brakeStep) omega = 0
    else omega -= Math.sign(omega) * brakeStep

    w.alpha = (omega - w.omega) / dt
    w.netTorque = w.alpha * w.inertia
    w.omega = omega
    return w
  }

  omegas(): [number, number, number, number] {
    return [
      this.wheels[0]?.omega ?? 0,
      this.wheels[1]?.omega ?? 0,
      this.wheels[2]?.omega ?? 0,
      this.wheels[3]?.omega ?? 0,
    ]
  }
}
