
export interface WheelSpinState {
  omega: number
  inertia: number
  radius: number
  driveTorque: number
  brakeTorque: number
  tireTorque: number
  slipDampTorque: number
  netTorque: number
  alpha: number
}

export function estimateWheelInertia(massKg: number, radiusM: number): number {
  return 0.5 * massKg * radiusM * radiusM
}

export class WheelDynamics {
  readonly wheels: WheelSpinState[] = []
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
