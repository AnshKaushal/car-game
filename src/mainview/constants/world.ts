export const WORLD_CONFIG = {
  road: {
    width: 12,
    laneWidth: 3.5,
    shoulderWidth: 2.5,
    segmentLength: 50,
    segmentsAhead: 30,
    segmentsBehind: 5,
    textureScale: 10,
    maxCurvature: 0.008,
    curvatureChangeRate: 0.0003,
    maxBanking: 0.15,
    maxElevationChange: 0.5,
    elevationFrequency: 0.02,
  },

  terrain: {
    tileSize: 200,
    tilesAhead: 3,
    tilesBehind: 1,
    tilesSide: 2,
    noiseScale: 0.005,
    noiseOctaves: 4,
    noisePersistence: 0.5,
    noiseLacunarity: 2.0,
    heightScale: 15,
    roadClearanceDistance: 30,
    roadClearanceWidth: 50,
  },

  vegetation: {
    minDistanceFromRoad: 15,
    maxDistanceFromRoad: 80,
    spacing: 8,
    spacingVariance: 0.4,
    clusterChance: 0.15,
    clusterSize: { min: 3, max: 8 },
    clusterRadius: 15,
    scaleRange: { min: 0.8, max: 1.4 },
    treeTypes: [0, 1, 2, 3, 4, 5],
    maxTreesPerSegment: 50,
    lodDistances: [50, 150, 300],
    frustumCulling: true,
  },

  environment: {
    skyColor: 0x87ceeb,
    horizonColor: 0xe0f0ff,
    groundColor: 0x3d5a2a,
    fogNear: 100,
    fogFar: 800,
    fogColor: 0x87ceeb,
    sunPosition: { x: 100, y: 150, z: 50 },
    sunColor: 0xffffee,
    sunIntensity: 1.2,
    ambientColor: 0x444466,
    ambientIntensity: 0.4,
    shadowMapSize: 2048,
    shadowCameraNear: 10,
    shadowCameraFar: 300,
    shadowCameraLeft: -100,
    shadowCameraRight: 100,
    shadowCameraTop: 100,
    shadowCameraBottom: -100,
    shadowBias: -0.001,
    shadowNormalBias: 0.02,
  },

  performance: {
    useInstancing: true,
    maxInstancesPerMesh: 1000,
    enableFrustumCulling: true,
    enableLOD: true,
    worldUpdateRate: 10,
  },

  startPosition: {
    x: 0,
    y: 0.5,
    z: 0,
  },
} as const

export type WorldConfig = typeof WORLD_CONFIG

export const DEFAULT_WORLD_CONFIG = WORLD_CONFIG

export function createWorldConfig(
  overrides: Partial<WorldConfig>,
): WorldConfig {
  return {
    ...WORLD_CONFIG,
    ...overrides,
    road: { ...WORLD_CONFIG.road, ...overrides.road },
    terrain: { ...WORLD_CONFIG.terrain, ...overrides.terrain },
    vegetation: { ...WORLD_CONFIG.vegetation, ...overrides.vegetation },
    environment: { ...WORLD_CONFIG.environment, ...overrides.environment },
    performance: { ...WORLD_CONFIG.performance, ...overrides.performance },
    startPosition: {
      ...WORLD_CONFIG.startPosition,
      ...overrides.startPosition,
    },
  }
}
