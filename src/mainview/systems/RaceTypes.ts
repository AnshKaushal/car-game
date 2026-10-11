export const RACE_COUNTS = [1, 2, 3, 4, 6, 8, 12, 20, 32, 50] as const
export const RACE_DISTANCES_KM = [1, 2, 5, 10] as const

export interface RaceSetup {
  rivals: number
  distanceM: number
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
}
