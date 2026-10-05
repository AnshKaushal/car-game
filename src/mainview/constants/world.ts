/**
 * World generation constants for the endless driving environment
 */

export const WORLD_CONFIG = {
  // Road properties
  road: {
    width: 12, // meters (2 lanes each direction + shoulders)
    laneWidth: 3.5,
    shoulderWidth: 2.5,
    segmentLength: 50, // Length of each road segment
    segmentsAhead: 30, // Number of segments to generate ahead
    segmentsBehind: 5, // Number of segments to keep behind
    // Road surface
    textureScale: 10,
    // Curvature
    maxCurvature: 0.008, // Max curvature per segment (1/m)
    curvatureChangeRate: 0.0003, // How fast curvature can change
    // Banking
    maxBanking: 0.15, // radians (~8.5 degrees)
    // Elevation
    maxElevationChange: 0.5, // meters per segment
    elevationFrequency: 0.02, // Frequency of elevation changes
  },

  // Terrain properties
  terrain: {
    tileSize: 200, // Size of each terrain tile
    tilesAhead: 3,
    tilesBehind: 1,
    tilesSide: 2,
    // Noise parameters
    noiseScale: 0.005,
    noiseOctaves: 4,
    noisePersistence: 0.5,
    noiseLacunarity: 2.0,
    heightScale: 15, // Max height variation
    // Road clearance - terrain is lowered near road
    roadClearanceDistance: 30, // Distance from road center to start terrain
    roadClearanceWidth: 50, // Width over which terrain blends to road level
  },

  // Trees and vegetation
  vegetation: {
    // Tree placement
    minDistanceFromRoad: 15, // Minimum distance from road edge
    maxDistanceFromRoad: 80, // Maximum distance from road
    spacing: 8, // Base spacing between trees
    spacingVariance: 0.4, // Random variance in spacing
    // Tree clusters
    clusterChance: 0.15,
    clusterSize: { min: 3, max: 8 },
    clusterRadius: 15,
    // Tree scaling
    scaleRange: { min: 0.8, max: 1.4 },
    // Tree types (indices into tree_pack.glb)
    treeTypes: [0, 1, 2, 3, 4, 5], // Will be mapped to actual models
    // Performance
    maxTreesPerSegment: 50,
    lodDistances: [50, 150, 300], // LOD switch distances
    frustumCulling: true,
  },

  // Environment
  environment: {
    // Sky
    skyColor: 0x87ceeb,
    horizonColor: 0xe0f0ff,
    groundColor: 0x3d5a2a,
    // Fog
    fogNear: 100,
    fogFar: 800,
    fogColor: 0x87ceeb,
    // Sun
    sunPosition: { x: 100, y: 150, z: 50 },
    sunColor: 0xffffee,
    sunIntensity: 1.2,
    ambientColor: 0x444466,
    ambientIntensity: 0.4,
    // Shadows
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

  // Performance
  performance: {
    // Instanced rendering for trees
    useInstancing: true,
    maxInstancesPerMesh: 1000,
    // Frustum culling
    enableFrustumCulling: true,
    // Level of detail
    enableLOD: true,
    // Update frequency (Hz)
    worldUpdateRate: 10,
  },

  // Starting position
  startPosition: {
    x: 0,
    y: 0.5,
    z: 0,
  },
} as const;

export type WorldConfig = typeof WORLD_CONFIG;

export const DEFAULT_WORLD_CONFIG = WORLD_CONFIG;

export function createWorldConfig(overrides: Partial<WorldConfig>): WorldConfig {
  return {
    ...WORLD_CONFIG,
    ...overrides,
    road: { ...WORLD_CONFIG.road, ...overrides.road },
    terrain: { ...WORLD_CONFIG.terrain, ...overrides.terrain },
    vegetation: { ...WORLD_CONFIG.vegetation, ...overrides.vegetation },
    environment: { ...WORLD_CONFIG.environment, ...overrides.environment },
    performance: { ...WORLD_CONFIG.performance, ...overrides.performance },
    startPosition: { ...WORLD_CONFIG.startPosition, ...overrides.startPosition },
  };
}