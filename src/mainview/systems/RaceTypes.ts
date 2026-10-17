export const RACE_COUNTS = [1, 2, 3, 4, 6, 8, 12, 20, 32, 50] as const
export const RACE_DISTANCES_KM = [1, 2, 5, 10] as const
export const MULTIPLAYER_AI_COUNTS = [
  0, 1, 2, 3, 4, 6, 8, 12, 20, 32, 50,
] as const

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
  staged: boolean
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
