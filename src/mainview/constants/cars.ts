import {
  CAR_PHYSICS,
  createPhysicsConfig,
  type CarPhysicsConfig,
} from "./physics"
import type { PaintTextureRule } from "../systems/carTint"
import type { WheelDef } from "../systems/Suspension"

export interface CarDashConfig {
  maxRpm: number
  redFromRpm: number
  maxKmh: number
}

export interface CarTested {
  zeroToHundredS: number
  topSpeedKmh: number
}

export interface CarDefinition {
  id: string
  name: string
  shortName: string
  modelFile: string
  physics: CarPhysicsConfig
  wheels: [WheelDef, WheelDef, WheelDef, WheelDef]
  pivots: { pattern?: string; names?: string[] }
  dash: CarDashConfig
  tested: CarTested
  defaultTint: number | null
  paintMatch?: string[]
  paintTexture?: PaintTextureRule
}

const M3_WHEELS: CarDefinition["wheels"] = [
  { x: -0.76, z: -1.51, front: true, left: true },
  { x: 0.76, z: -1.51, front: true, left: false },
  { x: -0.76, z: 1.31, front: false, left: true },
  { x: 0.76, z: 1.31, front: false, left: false },
]

const M3_DASH: CarDashConfig = { maxRpm: 8000, redFromRpm: 6750, maxKmh: 340 }

const m3: CarDefinition = {
  id: "bmw-m3",
  name: "BMW M3",
  shortName: "M3",
  modelFile: "models/bmw_m3.glb",
  physics: createPhysicsConfig({}),
  wheels: M3_WHEELS,
  pivots: { pattern: "^Plane00[3-6]$" },
  dash: M3_DASH,
  defaultTint: 0x000000,
  tested: { zeroToHundredS: 4.3, topSpeedKmh: 360 },
}

const r8: CarDefinition = {
  id: "audi-r8",
  name: "Audi R8 V10",
  shortName: "R8",
  modelFile: "models/audi_r8.glb",
  physics: createPhysicsConfig({
    mass: { chassis: 1595, frontWheel: 25, rearWheel: 25, total: 1695 },
    dimensions: {
      width: 1.94,
      height: 1.21,
      length: 4.43,
      wheelbase: 2.65,
      trackWidth: 1.65,
      groundClearance: 0.11,
      centerOfMassHeight: 0.45,
    },
    engine: {
      ...CAR_PHYSICS.engine,
      maxPowerHP: 640,
      maxTorqueNm: 600,
      maxPowerRPM: 8200,
      maxTorqueRPM: 6500,
      redlineRPM: 8700,
      revLimiterRPM: 8700,
      idleRPM: 900,
      torqueCurve: [
        [0, 0.25],
        [1000, 0.4],
        [2000, 0.6],
        [3500, 0.78],
        [5000, 0.9],
        [6500, 1.0],
        [7500, 0.98],
        [8200, 0.93],
        [8700, 0.78],
        [8900, 0.0],
      ],
    },
    transmission: {
      ...CAR_PHYSICS.transmission,
      gearRatios: [3.893, 2.588, 1.88, 1.416, 1.115, 0.884, 0.653],
      finalDriveRatio: 3.588,
      reverseRatio: 2.647,
      launchControlRPM: 5000,
      autoUpshiftRPM: 8500,
      torqueConverter: {
        ...CAR_PHYSICS.transmission.torqueConverter,
        creepForce: 1400,
      },
    },
    drivetrain: {
      type: "awd",
      frontTorqueSplit: 0.3,
      torqueCapGear1: 2500,
      torqueCapGear2: 4000,
    },
    wheels: {
      ...CAR_PHYSICS.wheels,
      radius: 0.345,
      frictionMu: 1.5,
      referenceLoad: 3950,
      suspension: {
        ...CAR_PHYSICS.wheels.suspension,
        springRate: 68000,
        damperRate: 4800,
        travel: 0.11,
        antiRollBarFront: 17000,
        antiRollBarRear: 15000,
      },
      brakeForce: { front: 1800, rear: 1400 },
      steering: {
        ...CAR_PHYSICS.wheels.steering,
        maxAngle: 0.58,
        speedFalloffKmh: 200,
      },
    },
    aero: {
      ...CAR_PHYSICS.aero,
      dragCoefficient: 0.32,
      frontalArea: 1.95,
      downforceAt100kmh: 260,
    },
    assists: { ...CAR_PHYSICS.assists, tractionControl: 0.35 },
  }),
  wheels: [
    { x: -0.82, z: -1.22, front: true, left: true },
    { x: 0.82, z: -1.22, front: true, left: false },
    { x: -0.82, z: 1.42, front: false, left: true },
    { x: 0.82, z: 1.42, front: false, left: false },
  ],
  pivots: { names: ["Plane003", "Plane006", "Plane009", "Plane012"] },
  dash: { maxRpm: 9000, redFromRpm: 8000, maxKmh: 360 },
  defaultTint: null,
  paintMatch: ["^body$"],
  tested: { zeroToHundredS: 3.4, topSpeedKmh: 342 },
}

const gwagon: CarDefinition = {
  id: "g-wagon",
  name: "Mercedes G 63",
  shortName: "G 63",
  modelFile: "models/g_wagon.glb",
  physics: createPhysicsConfig({
    mass: { chassis: 2570, frontWheel: 32, rearWheel: 32, total: 2700 },
    dimensions: {
      width: 1.98,
      height: 1.97,
      length: 4.87,
      wheelbase: 2.89,
      trackWidth: 1.68,
      groundClearance: 0.22,
      centerOfMassHeight: 0.75,
    },
    engine: {
      ...CAR_PHYSICS.engine,
      maxPowerHP: 850,
      maxTorqueNm: 1000,
      maxPowerRPM: 6000,
      maxTorqueRPM: 3000,
      redlineRPM: 6500,
      revLimiterRPM: 6800,
      idleRPM: 700,
      torqueCurve: [
        [0, 0.35],
        [700, 0.5],
        [1500, 0.8],
        [2500, 1.0],
        [3500, 0.97],
        [4500, 0.96],
        [5500, 0.95],
        [6000, 0.95],
        [6500, 0.78],
        [6700, 0.0],
      ],
    },
    transmission: {
      ...CAR_PHYSICS.transmission,
      gearRatios: [5.354, 3.243, 2.252, 1.636, 1.211, 1.0, 0.865, 0.717, 0.601],
      finalDriveRatio: 4.5,
      reverseRatio: 4.798,
      launchControlRPM: 3500,
      autoUpshiftRPM: 6000,
      torqueConverter: {
        ...CAR_PHYSICS.transmission.torqueConverter,
        creepForce: 2200,
      },
    },
    drivetrain: {
      type: "awd",
      frontTorqueSplit: 0.4,
      torqueCapGear1: 3200,
      torqueCapGear2: 5000,
    },
    wheels: {
      ...CAR_PHYSICS.wheels,
      radius: 0.39,
      frictionMu: 1.25,
      referenceLoad: 6300,
      suspension: {
        ...CAR_PHYSICS.wheels.suspension,
        springRate: 98000,
        damperRate: 5600,
        travel: 0.16,
        antiRollBarFront: 9000,
        antiRollBarRear: 7000,
      },
      brakeForce: { front: 2600, rear: 2100 },
      handbrakeForce: 4500,
      steering: {
        ...CAR_PHYSICS.wheels.steering,
        maxAngle: 0.55,
        speedFalloffKmh: 170,
        minAngleAtSpeed: 0.06,
      },
    },
    aero: {
      ...CAR_PHYSICS.aero,
      dragCoefficient: 0.38,
      frontalArea: 2.6,
      downforceAt100kmh: 60,
    },
    assists: {
      ...CAR_PHYSICS.assists,
      tractionControl: 0.55,
      countersteerAssist: 5500,
    },
  }),
  wheels: [
    { x: -0.81, z: -1.41, front: true, left: true },
    { x: 0.81, z: -1.41, front: true, left: false },
    { x: -0.81, z: 1.45, front: false, left: true },
    { x: 0.81, z: 1.45, front: false, left: false },
  ],
  pivots: { pattern: "^wheel[FB][LR]$" },
  dash: { maxRpm: 7000, redFromRpm: 6000, maxKmh: 260 },
  defaultTint: null,
  paintMatch: ["^body$"],
  paintTexture: { keepMap: true, neutralize: { color: [255, 0, 0], tol: 60 } },
  tested: { zeroToHundredS: 4.3, topSpeedKmh: 319 },
}

const urus: CarDefinition = {
  id: "lambo-urus",
  name: "Lamborghini Urus",
  shortName: "Urus",
  modelFile: "models/lamborghini_urus.glb",
  physics: createPhysicsConfig({
    mass: { chassis: 2200, frontWheel: 30, rearWheel: 30, total: 2320 },
    dimensions: {
      width: 2.02,
      height: 1.64,
      length: 5.11,
      wheelbase: 3.0,
      trackWidth: 1.7,
      groundClearance: 0.18,
      centerOfMassHeight: 0.65,
    },
    engine: {
      ...CAR_PHYSICS.engine,
      maxPowerHP: 700,
      maxTorqueNm: 1000,
      maxPowerRPM: 6200,
      maxTorqueRPM: 3500,
      redlineRPM: 6800,
      revLimiterRPM: 6800,
      idleRPM: 750,
      torqueCurve: [
        [0, 0.32],
        [800, 0.48],
        [1500, 0.75],
        [2250, 0.92],
        [3500, 1.0],
        [4500, 0.96],
        [5500, 0.94],
        [6200, 0.9],
        [6800, 0.72],
        [7000, 0.0],
      ],
    },
    transmission: {
      ...CAR_PHYSICS.transmission,
      gearRatios: [5.0, 3.2, 2.143, 1.72, 1.313, 1.0, 0.823, 0.64],
      finalDriveRatio: 3.5,
      reverseRatio: 3.478,
      launchControlRPM: 4000,
      autoUpshiftRPM: 6700,
      torqueConverter: {
        ...CAR_PHYSICS.transmission.torqueConverter,
        creepForce: 1900,
      },
    },
    drivetrain: {
      type: "awd",
      frontTorqueSplit: 0.38,
      torqueCapGear1: 3000,
      torqueCapGear2: 4600,
    },
    wheels: {
      ...CAR_PHYSICS.wheels,
      radius: 0.41,
      frictionMu: 1.35,
      referenceLoad: 5400,
      suspension: {
        ...CAR_PHYSICS.wheels.suspension,
        springRate: 88000,
        damperRate: 5300,
        travel: 0.14,
        antiRollBarFront: 13000,
        antiRollBarRear: 11000,
      },
      brakeForce: { front: 2300, rear: 1800 },
      handbrakeForce: 4000,
      steering: {
        ...CAR_PHYSICS.wheels.steering,
        maxAngle: 0.57,
        speedFalloffKmh: 185,
      },
    },
    aero: {
      ...CAR_PHYSICS.aero,
      dragCoefficient: 0.33,
      frontalArea: 2.7,
      downforceAt100kmh: 180,
    },
    assists: {
      ...CAR_PHYSICS.assists,
      tractionControl: 0.45,
      countersteerAssist: 5000,
    },
  }),
  wheels: [
    { x: -0.82, z: -1.51, front: true, left: true },
    { x: 0.82, z: -1.51, front: true, left: false },
    { x: -0.82, z: 1.52, front: false, left: true },
    { x: 0.82, z: 1.52, front: false, left: false },
  ],
  pivots: { names: ["Plane030", "Plane031", "Plane032", "Plane035"] },
  dash: { maxRpm: 8000, redFromRpm: 6200, maxKmh: 320 },
  defaultTint: null,
  paintMatch: ["^Material\\.001$"],
  tested: { zeroToHundredS: 3.9, topSpeedKmh: 316 },
}

const aventador: CarDefinition = {
  id: "lambo-aventador",
  name: "Lamborghini Aventador LP 700-4",
  shortName: "Aventador",
  modelFile: "models/lamborghini_aventador.glb",
  physics: createPhysicsConfig({
    mass: { chassis: 1500, frontWheel: 22, rearWheel: 25, total: 1650 },
    dimensions: {
      width: 2.03,
      height: 1.136,
      length: 4.78,
      wheelbase: 2.7,
      trackWidth: 1.72,
      groundClearance: 0.11,
      centerOfMassHeight: 0.38,
    },
    engine: {
      ...CAR_PHYSICS.engine,
      maxPowerHP: 700,
      maxTorqueNm: 690,
      maxPowerRPM: 8250,
      maxTorqueRPM: 5500,
      redlineRPM: 8500,
      revLimiterRPM: 8500,
      idleRPM: 950,
      // V12 naturally aspirated — broad torque, rises steadily to peak at 5500 rpm,
      // stays high through the rev range then falls into the limiter
      torqueCurve: [
        [0, 0.28],
        [1000, 0.42],
        [2000, 0.62],
        [3000, 0.78],
        [4000, 0.9],
        [5500, 1.0],
        [6500, 0.97],
        [7500, 0.93],
        [8250, 0.87],
        [8500, 0.65],
        [8700, 0.0],
      ],
    },
    transmission: {
      ...CAR_PHYSICS.transmission,
      // ISR 7-speed (Car and Driver / Motormatchup confirmed)
      gearRatios: [3.91, 2.44, 1.81, 1.46, 1.19, 0.97, 0.89],
      finalDriveRatio: 2.86,
      reverseRatio: 2.93,
      launchControlRPM: 5500,
      autoUpshiftRPM: 8300,
      torqueConverter: {
        ...CAR_PHYSICS.transmission.torqueConverter,
        creepForce: 1200,
      },
    },
    drivetrain: {
      type: "awd",
      // Haldex gen IV — nominally rear-biased (43/57 weight distribution)
      frontTorqueSplit: 0.3,
      torqueCapGear1: 2200,
      torqueCapGear2: 3500,
    },
    wheels: {
      ...CAR_PHYSICS.wheels,
      // From model: front tyres 0.67 m dia, rear 0.73 m dia → average radius 0.35 m
      radius: 0.35,
      frictionMu: 1.55,
      referenceLoad: 3850, // 1650 kg * 9.81 / 4
      suspension: {
        ...CAR_PHYSICS.wheels.suspension,
        // Push-rod horizontal damper setup — stiff, low CoM sports car
        springRate: 62000,
        damperRate: 4200,
        travel: 0.09,
        antiRollBarFront: 18000,
        antiRollBarRear: 16000,
      },
      brakeForce: { front: 1900, rear: 1500 },
      // CCB: Ø400×38 mm front, Ø380×38 mm rear — strong stopping
      steering: {
        ...CAR_PHYSICS.wheels.steering,
        maxAngle: 0.52,
        speedFalloffKmh: 220,
      },
    },
    aero: {
      ...CAR_PHYSICS.aero,
      // Cd ~0.33 from research; frontal area ≈ width × height × 0.85 ≈ 1.95 m²
      dragCoefficient: 0.33,
      frontalArea: 1.95,
      // Deployable rear spoiler — significant downforce at speed
      downforceAt100kmh: 320,
    },
    assists: {
      ...CAR_PHYSICS.assists,
      tractionControl: 0.3,
    },
  }),
  wheels: [
    { x: -0.86, z: -1.25, front: true, left: true },
    { x: 0.86, z: -1.25, front: true, left: false },
    { x: -0.85, z: 1.45, front: false, left: true },
    { x: 0.85, z: 1.45, front: false, left: false },
  ],
  pivots: { pattern: "^Wheel(FL|FR|BL|BR)$" },
  dash: { maxRpm: 9000, redFromRpm: 8000, maxKmh: 380 },
  defaultTint: null,
  // Explicit match: only carpaint meshes and scissor doors/bumpers carry the body colour.
  // Black plastic, chrome, detail and glass mesh names would otherwise false-positive
  // through the heuristic (chassis/bumper keywords hit PAINT_NAMES).
  paintMatch: ["carpaint", "detach_door", "detach_bumper"],
  tested: { zeroToHundredS: 2.9, topSpeedKmh: 350 },
}

const challenger: CarDefinition = {
  id: "dodge-challenger",
  name: "Dodge Challenger SRT8",
  shortName: "Challenger",
  modelFile: "models/dodge_challenger.glb",
  physics: createPhysicsConfig({
    mass: { chassis: 1790, frontWheel: 28, rearWheel: 28, total: 1878 },
    dimensions: {
      width: 1.923,
      height: 1.448,
      length: 5.023,
      wheelbase: 2.946,
      trackWidth: 1.603,
      groundClearance: 0.14,
      centerOfMassHeight: 0.52,
    },
    engine: {
      ...CAR_PHYSICS.engine,
      maxPowerHP: 425,
      maxTorqueNm: 569, // 420 lb-ft
      maxPowerRPM: 6200,
      maxTorqueRPM: 4800,
      redlineRPM: 6400,
      revLimiterRPM: 6400,
      idleRPM: 700,
      // 6.1L HEMI pushrod V8 — strong low-end, broad flat torque band, falls off near redline
      torqueCurve: [
        [0, 0.38],
        [800, 0.55],
        [1500, 0.75],
        [2500, 0.88],
        [3500, 0.96],
        [4800, 1.0],
        [5500, 0.97],
        [6000, 0.92],
        [6200, 0.86],
        [6400, 0.6],
        [6600, 0.0],
      ],
    },
    transmission: {
      ...CAR_PHYSICS.transmission,
      // W5A580 5-speed automatic (official Stellantis spec sheet)
      gearRatios: [3.59, 2.19, 1.41, 1.0, 0.83],
      finalDriveRatio: 3.06,
      reverseRatio: 3.16,
      launchControlRPM: 3000,
      autoUpshiftRPM: 6200,
      torqueConverter: {
        ...CAR_PHYSICS.transmission.torqueConverter,
        creepForce: 1600,
      },
    },
    drivetrain: {
      type: "rwd",
      frontTorqueSplit: 0,
      torqueCapGear1: 2800,
      torqueCapGear2: 4200,
    },
    wheels: {
      ...CAR_PHYSICS.wheels,
      // From model: wheel pivot y=0.452 m above ground → radius 0.452 m
      radius: 0.452,
      frictionMu: 1.3,
      referenceLoad: 4400, // 1878 kg * 9.81 / 4
      suspension: {
        ...CAR_PHYSICS.wheels.suspension,
        // SLA front coilovers, 5-link independent rear — muscle car tuning, stiffer than stock
        springRate: 52000,
        damperRate: 3800,
        travel: 0.13,
        antiRollBarFront: 14000,
        antiRollBarRear: 16000, // larger rear sway bar per SRT spec
      },
      brakeForce: { front: 2100, rear: 1600 },
      // Brembo 4-piston: 360×32 mm front, 350×26 mm rear
      handbrakeForce: 3500,
      steering: {
        ...CAR_PHYSICS.wheels.steering,
        maxAngle: 0.6,
        speedFalloffKmh: 160,
      },
    },
    aero: {
      ...CAR_PHYSICS.aero,
      // Official Cd 0.353, frontal area 2.35 m² (from Stellantis press release)
      dragCoefficient: 0.353,
      frontalArea: 2.35,
      downforceAt100kmh: 40, // muscle car — minimal aero downforce
    },
    assists: {
      ...CAR_PHYSICS.assists,
      tractionControl: 0.5,
      countersteerAssist: 4500,
    },
  }),
  wheels: [
    { x: -0.907, z: -1.325, front: true, left: true },
    { x: 0.915, z: -1.325, front: true, left: false },
    { x: -1.008, z: 2.355, front: false, left: true },
    { x: 1.017, z: 2.355, front: false, left: false },
  ],
  pivots: { pattern: "^Wheel_[1-4]$" },
  dash: { maxRpm: 7000, redFromRpm: 6000, maxKmh: 280 },
  defaultTint: null,
  // Body colour is on material named "material" (Body_Red_0, Side_Mirror_*_Red_0)
  // Body_Black/Gray/White meshes use named materials that should not be tinted
  paintMatch: ["^material$"],
  tested: { zeroToHundredS: 5.0, topSpeedKmh: 274 },
}

export const CARS: CarDefinition[] = [m3, r8, gwagon, urus, aventador, challenger]

export const DEFAULT_CAR_ID = "bmw-m3"

const byId = new Map<string, CarDefinition>(CARS.map((c) => [c.id, c]))

export function getCar(id: string | undefined | null): CarDefinition {
  if (id) {
    const found = byId.get(id)
    if (found) return found
  }
  return m3
}

export function isKnownCarId(id: string | undefined | null): boolean {
  return !!id && byId.has(id)
}

export function modelFileForCarId(id: string | undefined | null): string {
  return getCar(id).modelFile
}
