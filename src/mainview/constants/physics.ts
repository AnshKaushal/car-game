/**
 * Physics constants for the BMW M3 car simulation
 * All values are tuned for realistic driving feel
 * Adjust these to modify car behavior
 */

export const CAR_PHYSICS = {
  // Vehicle dimensions (meters)
  dimensions: {
    width: 1.85,
    height: 1.43,
    length: 4.71,
    wheelbase: 2.85,
    trackWidth: 1.58,
    groundClearance: 0.12,
    centerOfMassHeight: 0.5,
  },

  // Mass properties (kg)
  mass: {
    chassis: 1650, // BMW M3 curb weight ~1650kg
    frontWheel: 25,
    rearWheel: 25,
    total: 1750,
  },

  // Engine specifications
  engine: {
    maxPowerHP: 800, // 800 HP
    maxTorqueNm: 1000, // 1000 Nm
    maxPowerRPM: 7200,
    maxTorqueRPM: 3500,
    redlineRPM: 7500,
    idleRPM: 800,
    revLimiterRPM: 7500,
    // Torque curve: [RPM, torque multiplier 0-1]
    // Built around: peak torque 3500, peak power 7200, redline/limiter 7500.
    // Power = torque x rpm, so the multiplier falls after 3500 just slowly
    // enough that power still climbs until 7200, then drops off a cliff.
    torqueCurve: [
      [0, 0.3],
      [800, 0.42],
      [1500, 0.62],
      [2500, 0.85],
      [3500, 1.0], // Peak torque
      [4500, 0.97],
      [5500, 0.93],
      [6500, 0.88],
      [7200, 0.82], // Peak power (~830hp)
      [7500, 0.55], // Redline — falling fast
      [7700, 0.0], // Limiter cut zone
    ],
    // Inertia of rotating engine components (kg*m^2)
    engineInertia: 0.3,
    // Internal friction torque (Nm) - increases with RPM
    frictionTorqueBase: 50,
    frictionTorqueRPMFactor: 0.015,
  },

  // Transmission (ZF 8HP-style torque-converter 8-speed)
  transmission: {
    // Gear ratios (final drive applied separately)
    gearRatios: [
      4.71, // 1st
      3.14, // 2nd
      2.10, // 3rd
      1.67, // 4th
      1.29, // 5th
      1.00, // 6th
      0.84, // 7th
      0.67, // 8th
    ],
    finalDriveRatio: 3.15,
    // Shift timing (seconds)
    shiftTimeAuto: 0.15,
    shiftTimeManual: 0.08,
    // Clutch
    clutchEngagementRPM: 1500,
    clutchSlipTime: 0.3,
    // Launch control
    launchControlRPM: 5000,
    launchControlActive: true,
    // Torque converter: stall multiplication at 0 speed, fading out by lockup speed
    torqueConverter: {
      stallMultiplication: 1.7,
      lockupSpeedKmh: 25,
      // Idle creep in D (N) when no pedal is pressed — like a real automatic.
      // Settles ~8-9kmh / ~1k rpm against rolling resistance.
      creepForce: 1200,
      creepForceReverse: 700,
    },
    // Auto shift points (fixed rpm — no throttle mapping)
    autoUpshiftRPM: 7200, // shift at peak power
    autoDownshiftRPM: 2100,
  },

  // Differential
  differential: {
    type: 'lsd', // 'open', 'lsd', 'locked'
    lsdAccelLock: 0.4, // 0-1, acceleration lock
    lsdDecelLock: 0.3, // 0-1, deceleration lock
    preloadTorque: 50, // Nm
  },

  // Wheels and tires
  wheels: {
    radius: 0.33, // ~19 inch wheels
    width: 0.265,
    // Pacejka tire model coefficients (simplified)
    // Fz0 = nominal load (N), Cx = shape factor, Dx = peak factor, Bx = stiffness factor
    pacejka: {
      // Longitudinal (acceleration/braking)
      longitudinal: {
        B: 10.0, // Stiffness
        C: 1.65, // Shape
        D: 1.0, // Peak (scaled by load)
        E: 0.97, // Curvature
        Sh: 0.0, // Horizontal shift
        Sv: 0.0, // Vertical shift
        // Load sensitivity
        loadSensitivity: 0.9,
      },
      // Lateral (cornering)
      lateral: {
        B: 9.0,
        C: 1.45,
        D: 1.0,
        E: 0.97,
        Sh: 0.0,
        Sv: 0.0,
        loadSensitivity: 0.85,
      },
      // Aligning torque (self-aligning torque)
      aligning: {
        B: 8.0,
        C: 1.2,
        D: 1.0,
        E: 0.97,
        Sh: 0.0,
        Sv: 0.0,
      },
    },
    // Suspension
    suspension: {
      springRate: 55000, // N/m
      damperRate: 4500, // N*s/m
      travel: 0.12, // meters
      targetDampingRatio: 0.85,
      // Anti-roll bars
      antiRollBarFront: 15000, // Nm/rad
      antiRollBarRear: 12000, // Nm/rad
    },
    // Brake force (Nm per wheel at max pressure)
    brakeForce: {
      front: 1800,
      rear: 1400,
    },
    // Handbrake force (rear only)
    handbrakeForce: 3500,
    // Steering
    steering: {
      maxAngle: 0.6, // radians (~34 degrees)
      speedSensitivity: 0.6, // Reduce steering at high speed
      // Speed (km/h) at which speedSensitivity bites hardest. Raising this
      // keeps meaningful steering lock well past 200km/h.
      speedFalloffKmh: 190,
      // Floor on usable steering lock (radians) regardless of speed. ~0.05
      // rad = 2.9 degrees, so the car always reacts to countersteer instead
      // of going numb at high speed.
      minAngleAtSpeed: 0.05,
      ackermannFactor: 0.3, // 0 = parallel, 1 = perfect ackermann
      returnSpeed: 3.0, // rad/s steering return to center
    },
  },

  // Aerodynamics
  aero: {
    dragCoefficient: 0.32, // Cd
    frontalArea: 2.2, // m^2
    liftCoefficient: 0.15, // Cl (positive = lift)
    // Downforce from splitter/diffuser/wing (N at 100 km/h)
    downforceAt100kmh: 150,
    airDensity: 1.225, // kg/m^3
  },

  // Driving assists
  assists: {
    // Traction control (0 = off, 1 = full)
    tractionControl: 0.3,
    // Stability control (0 = off, 1 = full)
    stabilityControl: 0.2,
    // How hard the ESC chases the yaw moment the driver is asking for while
    // the car is sideways. Without this, countersteering into a slide only
    // unwound the angle slowly and the car felt like it had locked into the
    // slide. 0 disables it.
    countersteerAssist: 4500,
    // Speed sensation: FOV widening with speed, screen-edge speed lines,
    // and camera shake. Only affects presentation, never handling.
    speedFeel: {
      fovBase: 68,
      fovMax: 104,
      fovAtMaxSpeedKmh: 330,
      linesStrength: 0.85, // screen-edge streak opacity at full effect
      linesFromKmh: 110,
      shakeAmp: 0.0016, // radians of camera jitter at full effect
      shakeFromKmh: 140,
    },
    // ABS
    absEnabled: true,
    absSlipThreshold: 0.15,
  },

  // Physics simulation
  simulation: {
    subSteps: 8, // Physics sub-steps per frame
    maxSubStep: 1 / 60,
    // Longest frame the physics is allowed to integrate in one go. The render
    // loop and CarController MUST agree on this: if the loop advances the
    // world further than the tire forces were integrated for, grip silently
    // drops on a slow machine (the car goes vague and unresponsive under load
    // exactly when the frame rate dips). One shared value, no drift.
    maxFrameDt: 1 / 30,
    // Wheel raycast distance
    raycastDistance: 0.4,
    // Chassis raycast for ground detection
    chassisRaycastDistance: 0.5,
  },
} as const;

export type CarPhysicsConfig = typeof CAR_PHYSICS;

/**
 * Default physics configuration - can be overridden by user
 */
export const DEFAULT_PHYSICS_CONFIG = CAR_PHYSICS;

/**
 * Helper to create modified physics config
 */
export function createPhysicsConfig(overrides: Partial<CarPhysicsConfig>): CarPhysicsConfig {
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
  };
}