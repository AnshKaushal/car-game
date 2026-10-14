export interface CarStatePacket {
  id: string
  t: number // timestamp performance.now()
  seq: number
  // Position
  x: number
  y: number
  z: number
  // Orientation quaternion
  qx: number
  qy: number
  qz: number
  qw: number
  // Linear velocity for dead-reckoning extrapolation
  vx: number
  vy: number
  vz: number
  // Driving telemetry
  steer: number
  speed: number // km/h or m/s
  rpm: number
  gear: number
  drift: boolean
  smoke: boolean
  progress: number
}

export type NetworkEventType =
  | "HELLO"
  | "READY"
  | "START_RACE"
  | "FINISH_RACE"
  | "PING"
  | "PONG"

export interface NetworkEventPacket {
  type: NetworkEventType
  senderId: string
  t: number
  payload?: any
}

export interface PeerPlayer {
  id: string
  name: string
  color: number
  colorHex: string
  pingMs: number
  ready: boolean
  isHost: boolean
  lastSeen: number
  progress: number
  finished: boolean
  finishTime: number | null
}
