export const CAR_PHYSICS = {
  dimensions: {
    width: 1.85,
    height: 1.43,
    length: 4.71,
    wheelbase: 2.85,
    trackWidth: 1.58,
    groundClearance: 0.12,
    centerOfMassHeight: 0.5,
  },

  mass: {
    chassis: 1650,
    frontWheel: 25,
    rearWheel: 25,
    total: 1750,
  },

  engine: {
    maxPowerHP: 800,
    maxTorqueNm: 1000,
    maxPowerRPM: 7200,
    maxTorqueRPM: 3500,
    redlineRPM: 7500,
    idleRPM: 800,
    revLimiterRPM: 7500,
    torqueCurve: [
      [0, 0.3],
      [800, 0.42],
      [1500, 0.62],
      [2500, 0.85],
      [3500, 1.0],
      [4500, 0.97],
      [5500, 0.93],
      [6500, 0.88],
      [7200, 0.82],
      [7500, 0.55],
      [7700, 0.0],
    ],
    engineInertia: 0.3,
    frictionTorqueBase: 50,
    frictionTorqueRPMFactor: 0.015,
  },

  transmission: {
    gearRatios: [4.71, 3.14, 2.1, 1.67, 1.29, 1.0, 0.84, 0.67],
    finalDriveRatio: 3.15,
    shiftTimeAuto: 0.15,
    shiftTimeManual: 0.08,
    clutchEngagementRPM: 1500,
    clutchSlipTime: 0.3,
    launchControlRPM: 4500,
    launchControlActive: true,
    torqueConverter: {
      stallMultiplication: 1.7,
      lockupSpeedKmh: 25,
      creepForce: 1200,
      creepForceReverse: 700,
    },
    autoUpshiftRPM: 7200,
    autoDownshiftRPM: 2100,
  },

  differential: {
    type: "lsd",
    lsdAccelLock: 0.4,
    lsdDecelLock: 0.3,
    preloadTorque: 50,
  },

  wheels: {
    radius: 0.33,
    width: 0.265,
    frictionMu: 1.4,
    referenceLoad: 4000,
    rollingResist: 0.012,
    relaxationLength: 0.18,
    slipDampRate: 100,
    pacejka: {
      longitudinal: {
        B: 10.0,
        C: 1.65,
        D: 1.0,
        E: 0.97,
        Sh: 0.0,
        Sv: 0.0,
        loadSensitivity: 0.9,
      },
      lateral: {
        B: 9.0,
        C: 1.45,
        D: 1.0,
        E: 0.97,
        Sh: 0.0,
        Sv: 0.0,
        loadSensitivity: 0.85,
      },
      aligning: {
        B: 8.0,
        C: 1.2,
        D: 1.0,
        E: 0.97,
        Sh: 0.0,
        Sv: 0.0,
      },
    },
    suspension: {
      springRate: 65000,
      damperRate: 4500,
      travel: 0.12,
      targetDampingRatio: 0.85,
      antiRollBarFront: 15000,
      antiRollBarRear: 12000,
    },
    brakeForce: {
      front: 1800,
      rear: 1400,
    },
    handbrakeForce: 3500,
    steering: {
      maxAngle: 0.6,
      speedSensitivity: 0.6,
      speedFalloffKmh: 190,
      minAngleAtSpeed: 0.05,
      ackermannFactor: 0.3,
      returnSpeed: 3.0,
    },
  },

  aero: {
    dragCoefficient: 0.32,
    frontalArea: 2.2,
    liftCoefficient: 0.15,
    downforceAt100kmh: 150,
    airDensity: 1.225,
  },

  assists: {
    tractionControl: 0.3,
    stabilityControl: 0.2,
    countersteerAssist: 4500,
    speedFeel: {
      fovBase: 60,
      fovMax: 104,
      fovAtMaxSpeedKmh: 330,
      linesStrength: 0.85,
      linesFromKmh: 120,
      shakeAmp: 0.0016,
      shakeFromKmh: 140,
    },
    absEnabled: true,
    absSlipThreshold: 0.15,
  },

  simulation: {
    subSteps: 8,
    maxSubStep: 1 / 60,
    maxFrameDt: 1 / 30,
    raycastDistance: 0.4,
    chassisRaycastDistance: 0.5,
  },
} as const

export type CarPhysicsConfig = typeof CAR_PHYSICS

export const DEFAULT_PHYSICS_CONFIG = CAR_PHYSICS

export function createPhysicsConfig(
  overrides: Partial<CarPhysicsConfig>,
): CarPhysicsConfig {
  return {
    ...CAR_PHYSICS,
    ...overrides,
    dimensions: { ...CAR_PHYSICS.dimensions, ...overrides.dimensions },
    mass: { ...CAR_PHYSICS.mass, ...overrides.mass },
    engine: { ...CAR_PHYSICS.engine, ...overrides.engine },
    transmission: { ...CAR_PHYSICS.transmission, ...overrides.transmission },
    differential: { ...CAR_PHYSICS.differential, ...overrides.differential },
    wheels: { ...CAR_PHYSICS.wheels, ...overrides.wheels },
    aero: { ...CAR_PHYSICS.aero, ...overrides.aero },
    assists: { ...CAR_PHYSICS.assists, ...overrides.assists },
    simulation: { ...CAR_PHYSICS.simulation, ...overrides.simulation },
  }
}
