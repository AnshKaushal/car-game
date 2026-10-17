export const RACE_COUNTS = [1, 2, 3, 4, 6, 8, 12, 20, 32, 50] as const
export const RACE_DISTANCES_KM = [1, 2, 5, 10] as const
/** AI bot counts offered in the multiplayer lobby (0 = humans only). */
export const MULTIPLAYER_AI_COUNTS = [
  0, 1, 2, 3, 4, 6, 8, 12, 20, 32, 50,
] as const

/** Ambient traffic density for free roam (BeamNG-style). */
export const TRAFFIC_OPTIONS = [
  { id: "off", label: "Off", count: 0 },
  { id: "low", label: "Low", count: 15 },
  { id: "medium", label: "Med", count: 35 },
  { id: "high", label: "High", count: 50 },
] as const
export type TrafficLevel = (typeof TRAFFIC_OPTIONS)[number]["id"]
export function trafficCountFor(level: TrafficLevel): number {
  return TRAFFIC_OPTIONS.find((o) => o.id === level)?.count ?? 0
}

export interface RaceSetup {
  rivals: number
  distanceM: number
  /**
   * Shared grid seed so every client in a multiplayer room shuffles the
   * same AI field into the same slots. Omitted in singleplayer (which
   * keeps its unseeded shuffle + personal car pool).
   */
  seed?: number
}

export interface RaceStanding {
  id: string
  name: string
  color: string
  isPlayer: boolean
  progressM: number
  finished: boolean
  finishTime: number | null
}

export interface RaceSnapshot {
  active: boolean
  finished: boolean
  distanceM: number
  elapsed: number
  playerPlace: number
  total: number
  standings: RaceStanding[]
  countdown: number
  phase: "heads" | "count" | "go"
  readyIn: number
  /**
   * Multiplayer rematch staging: true while parked on the grid waiting for
   * every driver to hit "Race again". The countdown only runs once staged
   * flips false (see MultiplayerManager.areAllReady).
   */
  staged: boolean
  /** Remote driver names we are still waiting on (one → named, many → generic). */
  waitingFor: string[]
}

export const emptyRace: RaceSnapshot = {
  active: false,
  finished: false,
  distanceM: 0,
  elapsed: 0,
  playerPlace: 1,
  total: 1,
  standings: [],
  countdown: 0,
  phase: "go",
  readyIn: 0,
  staged: false,
  waitingFor: [],
}
