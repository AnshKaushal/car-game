/**
 * Single source of truth for vehicle physics (SI units everywhere).
 *
 * Conventions:
 * - distances: metres, masses: kg, time: seconds, forces: N, torques: Nm
 * - angles: radians, angular velocity: rad/s
 * - km/h and RPM appear ONLY at the UI/input boundary (Dashboard, telemetry)
 * - physics forward is -Z, up is +Y
 *
 * Every property here is consumed by the simulation. Dead properties were
 * removed during the physics overhaul — if you add one, wire it up or delete it.
 */

export interface TorqueCurvePoint {
  rpm: number;
  mult: number; // 0..1 multiplier on peak torque
}

export const CAR_PHYSICS = {
  // ---------------------------------------------------------------- mass ---
  mass: {
    /** Total vehicle mass incl. fluids + driver (kg). THE one mass value. */
    total: 1700,
    /** Unsprung mass per corner (kg) — used for wheel inertia bookkeeping. */
    cornerUnsprung: 32,
    /** CG height above ground at static ride height (m). */
    cgHeight: 0.52,
    /**
     * Static front weight share. 0.52 = 52% front / 48% rear.
     * Axle loads derive from this: FzF = m*g*rearShare etc.
     */
    frontShare: 0.52,
    /** Yaw inertia (kg m^2). ~ m * (0.45 * wheelbase)^2 scaled for a sedan. */
    yawInertia: 2600,
    /** Roll inertia (kg m^2). */
    rollInertia: 620,
    /** Pitch inertia (kg m^2). */
    pitchInertia: 2400,
  },

  // ------------------------------------------------------------- geometry ---
  geometry: {
    /** Body shell width / length for the chassis collider (m). */
    width: 1.85,
    length: 4.71,
    height: 1.43,
    /** Distance front axle -> rear axle (m). Matches visual hardpoints. */
    wheelbase: 2.82,
    /** Front axle z in body space (m). Forward is -Z. */
    frontAxleZ: -1.51,
    /** Rear axle z in body space (m). */
    rearAxleZ: 1.31,
    /** Track width (m). */
    trackWidth: 1.52,
    /** Half track (m). */
    halfTrack: 0.76,
    /** Static ride height: body-origin height above ground at rest (m). */
    rideHeight: 0.72,
    /** Roll center heights (m above ground). */
    rollCenterFront: 0.09,
    rollCenterRear: 0.11,
    /** Anti-dive (front) / anti-squat (rear) as force-path fractions 0..1. */
    antiDive: 0.25,
    antiSquat: 0.35,
    /** Camber gain: rad of extra negative camber per metre of compression. */
    camberGain: 0.35,
    staticCamberFront: -0.017, // ~-1 deg
    staticCamberRear: -0.026, // ~-1.5 deg
  },

  // --------------------------------------------------------------- engine ---
  engine: {
    peakTorqueNm: 1000,
    peakPowerHp: 800,
    idleRPM: 800,
    redlineRPM: 7500,
    revLimiterRPM: 7500,
    /** Flywheel + crank inertia (kg m^2). */
    inertia: 0.4,
    /** Internal friction: Tf = base + k * rpm (Nm). Also gives engine braking. */
    frictionBase: 25,
    frictionPerRpm: 0.004,
    /** Throttle response lag (1/s). Higher = snappier. */
    throttleResponse: 8,
    torqueCurve: [
      { rpm: 0, mult: 0.3 },
      { rpm: 800, mult: 0.42 },
      { rpm: 1500, mult: 0.62 },
      { rpm: 2500, mult: 0.85 },
      { rpm: 3500, mult: 1.0 },
      { rpm: 4500, mult: 0.97 },
      { rpm: 5500, mult: 0.93 },
      { rpm: 6500, mult: 0.88 },
      { rpm: 7200, mult: 0.82 },
      { rpm: 7500, mult: 0.55 },
      { rpm: 7700, mult: 0.0 },
    ] as TorqueCurvePoint[],
  },

  // --------------------------------------------------------- transmission ---
  transmission: {
    gearRatios: [4.71, 3.14, 2.1, 1.67, 1.29, 1.0, 0.84, 0.67],
    finalDriveRatio: 3.15,
    reverseRatio: 3.2,
    efficiency: 0.86,
    /** Torque interruption during a shift (s of ~zero drive). */
    shiftTimeAuto: 0.22,
    shiftTimeManual: 0.15,
    autoUpshiftRPM: 7200,
    /** Downshift only when rpm would stay above this (hysteresis vs lugging). */
    autoDownshiftRPM: 2100,
    /** Kickdown: WOT below this rpm in auto triggers a downshift. */
    kickdownRPM: 3800,
    launchControlRPM: 5000,
    launchControlEnabled: true,
    torqueConverter: {
      /** Stall torque multiplication at zero turbine speed. */
      stallMultiplication: 1.9,
      /** Coupling point: speed ratio where multiplication fades to 1.0. */
      couplingPoint: 0.85,
      /** Turbine rpm at which the lockup clutch engages in gears >= 3. */
      lockupTurbineRPM: 2200,
      /** Idle-speed controller: foot off both pedals, the converter feeds up
       *  to creepMaxTorque (Nm at the axle) to seek creepTargetMps. This is
       *  what a real ECU + converter does (idle-speed control); without it a
       *  pinned-idle pump would either stall or run away. */
      creepTargetMps: 2.5,
      creepGain: 300, // axle Nm per m/s of speed error
      creepMaxTorque: 600,
    },
    /** Clutch pack capacity (Nm) at full engagement. */
    clutchCapacity: 1400,
  },

  // --------------------------------------------------------- differential ---
  differential: {
    type: 'lsd' as 'open' | 'lsd' | 'locked',
    /** Preload torque resisting any speed difference (Nm). */
    preload: 60,
    /** Extra locking torque per Nm of INPUT torque under power (0..1). */
    accelRamp: 0.45,
    /** Extra locking torque per Nm of input torque on coast (0..1). */
    decelRamp: 0.3,
  },

  // ----------------------------------------------------------------- tire ---
  tire: {
    radius: 0.33,
    width: 0.265,
    /** Wheel + tire spin inertia per corner (kg m^2). */
    spinInertia: 1.1,
    rollingResistance: 0.012,
    /** Reference load for load-sensitivity normalisation (N). */
    refLoad: 4200,
    front: {
      peakMu: 1.35,
      longB: 7.5, longC: 1.55, longD: 1.0, longE: 0.4,
      latB: 7.0, latC: 1.35, latD: 1.0, latE: 0.5,
      /** Load sensitivity exponent: muEff = peakMu * (Fz/Fz0)^(-sens). */
      loadSensitivity: 0.12,
      corneringStiffness: 1.0,
    },
    rear: {
      peakMu: 1.38,
      longB: 7.5, longC: 1.55, longD: 1.0, longE: 0.4,
      latB: 7.2, latC: 1.35, latD: 1.0, latE: 0.5,
      loadSensitivity: 0.12,
      corneringStiffness: 1.04,
    },
    /** Aligning torque: Mz = trail * Fy, trail shrinks with slip. */
    pneumaticTrail: 0.045,
  },

  // ----------------------------------------------------------- suspension ---
  suspension: {
    travelBump: 0.09,
    travelDroop: 0.11,
    front: {
      springRate: 52000,
      bumpDamping: 3800,
      reboundDamping: 5200,
      /** Progressive bump-stop rate engaging in last 25mm (N/m^2-ish curve k). */
      bumpStopRate: 220000,
      bumpStopGap: 0.065,
      antiRollRate: 9500, // N/m of left-right compression difference
    },
    rear: {
      springRate: 58000,
      bumpDamping: 4200,
      reboundDamping: 5800,
      bumpStopRate: 240000,
      bumpStopGap: 0.065,
      antiRollRate: 7500,
    },
  },

  // -------------------------------------------------------------- steering ---
  steering: {
    /** Steering-wheel : road-wheel ratio. */
    ratio: 14.5,
    /** Max average road-wheel angle at the rack limit (rad). */
    maxRoadAngle: 0.58,
    /** Steering shaft speed limit (rad/s at the road wheels). */
    maxSpeed: 7.0,
    /** Speed-sensitive ratio: effective ratio *= 1 + gain*(v/vRef)^2. */
    speedGain: 0.9,
    speedRefKmh: 120,
    /** Ackermann blend: 0 = parallel, 1 = geometric Ackermann. */
    ackermann: 0.85,
  },

  // ---------------------------------------------------------------- brakes ---
  brakes: {
    /** Max brake torque per wheel at full pedal (Nm). Bias emerges from this. */
    frontTorque: 5200,
    rearTorque: 3400,
    /** Pedal response (1/s). */
    response: 10,
    handbrakeTorque: 4200, // rear only
  },

  // ------------------------------------------------------------------ aero ---
  aero: {
    airDensity: 1.225,
    dragCoefficient: 0.34,
    frontalArea: 2.25,
    /** Lift coefficients split per axle (positive = downforce here). */
    downforceFront: 0.28,
    downforceRear: 0.36,
    referenceArea: 2.25,
    /** Ride-height sensitivity: downforce *= 1 + k*(refH - h). */
    rideSensitivity: 0.6,
    referenceRideHeight: 0.72,
  },

  // ---------------------------------------------------------------- assists ---
  assists: {
    /** 0 = off, 1 = full. Scales TC torque-cut authority. */
    tractionControl: 0.35,
    /** Target longitudinal slip for TC (0.08 = 8% slip). */
    tcSlipTarget: 0.1,
    /** 0 = off, 1 = full. Scales ESC brake/yaw authority. */
    stabilityControl: 0.25,
    /** Optional extra yaw help while countersteering. Weak by design. */
    countersteerAssist: 900,
    absEnabled: true,
    /** Target braking slip for ABS. */
    absSlipTarget: 0.13,
    // Speed sensation: FOV widening with speed, screen-edge speed lines,
    // and camera shake. Presentation only — never touches handling.
    speedFeel: {
      fovBase: 68,
      fovMax: 104,
      fovAtMaxSpeedKmh: 330,
      linesStrength: 0.85,
      linesFromKmh: 110,
      shakeAmp: 0.0016,
      shakeFromKmh: 140,
    },
  },

  // ------------------------------------------------------------- simulation ---
  simulation: {
    /** Fixed physics timestep (s). 120 Hz. */
    fixedDt: 1 / 120,
    /** Max physics substeps per render frame (anti spiral-of-death). */
    maxSteps: 4,
    /** Frame dt clamp (s). */
    maxFrameDt: 1 / 20,
    /** Gravity (m/s^2). */
    gravity: 9.81,
    /** Residual numerical damping only — NOT stability control. */
    numericalRollDamping: 60,
    numericalPitchDamping: 120,
    numericalYawDamping: 90,
  },
} as const;

export type CarPhysicsConfig = typeof CAR_PHYSICS;
export const DEFAULT_PHYSICS_CONFIG = CAR_PHYSICS;

/** Gravitational acceleration. */
export const G = CAR_PHYSICS.simulation.gravity;

/** Static axle loads from CG position. FzF = m g (rearDist/wb). */
export function staticAxleLoads(massKg = CAR_PHYSICS.mass.total) {
  const wb = CAR_PHYSICS.geometry.wheelbase;
  const frontShare = CAR_PHYSICS.mass.frontShare;
  const rearDist = frontShare * wb; // CG closer to front => more front load
  const frontDist = wb - rearDist;
  const W = massKg * G;
  return {
    front: (W * rearDist) / wb,
    rear: (W * frontDist) / wb,
    frontDist,
    rearDist,
  };
}

/** Static per-corner loads (N), order FL, FR, RL, RR. */
export function staticCornerLoads(massKg = CAR_PHYSICS.mass.total): [number, number, number, number] {
  const { front, rear } = staticAxleLoads(massKg);
  return [front / 2, front / 2, rear / 2, rear / 2];
}
