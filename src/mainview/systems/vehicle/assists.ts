/**
 * Driver aids. Each aid is a small stateful controller acting ONLY on physical
 * quantities (brake pressures, engine torque request). All aids are isolated
 * here — disabling them exposes the raw physical car.
 */
import { CAR_PHYSICS } from '../../constants/physics';

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/** Per-wheel ABS pressure controller. */
export class AbsController {
  /** 0..1 estimated pressure multiplier per wheel (persists between steps). */
  pressure = [1, 1, 1, 1];

  reset() {
    this.pressure = [1, 1, 1, 1];
  }

  /**
   * Update one wheel. slip = signed slip ratio (negative under braking).
   * Returns the pressure multiplier to apply to brake torque.
   */
  updateWheel(i: number, slip: number, braking: boolean, dt: number): number {
    if (!CAR_PHYSICS.assists.absEnabled || !braking) {
      this.pressure[i] = Math.min(1, this.pressure[i] + dt * 6);
      return this.pressure[i];
    }
    const target = CAR_PHYSICS.assists.absSlipTarget;
    const over = -slip - target; // > 0 means locked past target
    if (over > 0.02) {
      // dumping pressure fast while over target (solenoid rates ~15 Hz)
      this.pressure[i] = Math.max(0.1, this.pressure[i] - dt * (10 + over * 40));
    } else if (over < -0.02) {
      // re-apply pressure when the wheel recovered
      this.pressure[i] = Math.min(1, this.pressure[i] + dt * 8);
    }
    return this.pressure[i];
  }
}

/** Traction-control torque governor with attack/recovery rates. */
export class TractionController {
  /** 0..1 current torque-cut fraction. */
  cut = 0;

  reset() {
    this.cut = 0;
  }

  /**
   * slipL/slipR = rear signed slip ratios. Returns torque multiplier 0..1.
   * authority scales with assists.tractionControl.
   */
  update(slipL: number, slipR: number, authority: number, dt: number): number {
    const target = CAR_PHYSICS.assists.tcSlipTarget;
    const worst = Math.max(slipL, slipR);
    const over = worst - target;
    if (over > 0) {
      const want = clamp(over / 0.35, 0, 0.9) * clamp(authority * 2.2, 0, 1);
      // fast attack...
      const rate = 6;
      this.cut += clamp(want - this.cut, -dt * 2.5, dt * rate);
    } else {
      // ...slow recovery so power comes back progressively, never a snap
      this.cut = Math.max(0, this.cut - dt * 1.8);
    }
    return 1 - this.cut;
  }
}

/**
 * ESC: bicycle-model yaw-rate reference vs actual yaw rate.
 * Returns { brakeFL, brakeFR, brakeRL, brakeRR } extra brake torques (Nm)
 * plus engineCut 0..1. Authority scales with assists.stabilityControl.
 */
export class EscController {
  engineCut = 0;

  reset() {
    this.engineCut = 0;
  }

  update(
    speed: number, // m/s signed forward
    steerAvg: number, // rad average front road-wheel angle
    yawRate: number, // rad/s actual
    dt: number,
  ): { brakes: [number, number, number, number]; engineCut: number } {
    const out: { brakes: [number, number, number, number]; engineCut: number } = {
      brakes: [0, 0, 0, 0],
      engineCut: 0,
    };
    const authority = CAR_PHYSICS.assists.stabilityControl;
    if (authority <= 0 || Math.abs(speed) < 3) return out;

    const wb = CAR_PHYSICS.geometry.wheelbase;
    // Kinematic bicycle reference with understeer-gradient saturation.
    const raw = (speed / wb) * Math.tan(steerAvg);
    // saturate at ~0.9g lateral capability
    const maxYaw = (0.9 * 9.81) / Math.max(4, Math.abs(speed));
    const target = clamp(raw, -maxYaw, maxYaw);
    const err = target - yawRate; // + = need more left yaw

    const dead = 0.06 + 0.1 * (1 - authority);
    if (Math.abs(err) < dead) {
      this.engineCut = Math.max(0, this.engineCut - dt * 2);
      out.engineCut = this.engineCut;
      return out;
    }
    const active = Math.min(1, (Math.abs(err) - dead) / 0.5);
    const brakeTotal = 2600 * authority * active;
    // Brake the wheels that create a correcting yaw moment:
    // need left yaw (err>0): brake left-side wheels (drag left side back... )
    // braking the inside-rear is the classic ESC move; blend front/rear.
    if (err > 0) {
      out.brakes[0] = brakeTotal * 0.35; // FL
      out.brakes[2] = brakeTotal * 0.65; // RL
    } else {
      out.brakes[1] = brakeTotal * 0.35; // FR
      out.brakes[3] = brakeTotal * 0.65; // RR
    }
    this.engineCut = Math.min(0.5 * authority, active * 0.4 * authority);
    out.engineCut = this.engineCut;
    return out;
  }
}
