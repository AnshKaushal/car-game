import * as THREE from "three"
import type * as RAPIER from "@dimforge/rapier3d-compat"
import { joinRoom, selfId } from "@trystero-p2p/torrent"
import type { CarController } from "../CarController"
import type { CarTelemetry } from "../CarController"
import type { TireSmoke } from "../TireSmoke"
import { DEFAULT_PLAYER_COLOR, colorHex } from "../carTint"
import {
  DEFAULT_CAR_ID,
  getCar,
  modelFileForCarId,
} from "../../constants/cars"
import { RemoteCar } from "./RemoteCar"
import {
  maybeLogNetDiag,
  netDiagContactCost,
  netDiagForgetPeer,
  netDiagInvalid,
  netDiagPeerEvent,
  netDiagRecv,
  netDiagRemoteCount,
  netDiagRtt,
  netDiagSend,
  netDiagSeqAccept,
  netDiagSeqReject,
} from "./NetDiagnostics"
import {
  isAccept,
  newSessionId,
  PeerSessionTracker,
  validateStatePacket,
} from "./stateProtocol"
import type {
  CarStatePacket,
  NetworkEventPacket,
  PeerPlayer,
} from "./types"

const BROADCAST_INTERVAL_MS = 33
const PING_INTERVAL_MS = 2000

export function roomPasswordHash(roomId: string, password: string): string {
  const text = `oversteer:${roomId}:${password}`
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h.toString(16).padStart(8, "0")
}

export type MultiplayerMode = "p2p" | "lan"

export interface MultiplayerCallbacks {
  onPeersUpdated?: (peers: PeerPlayer[]) => void
  onRaceStartSignal?: (
    startTimeMs: number,
    distanceM: number,
    rivals?: number,
  ) => void
  onRaceFinishSignal?: (peerId: string, time: number) => void
  onPlayerJoined?: (peer: PeerPlayer) => void
  onPlayerLeft?: (peerId: string) => void
  onJoinError?: (msg: string) => void
}

export class MultiplayerManager {
  public localId: string
  public localName: string
  public localColor: number
  public localColorHex: string
  public localCarId: string = DEFAULT_CAR_ID
  public roomId: string | null = null
  public roomPasswordHashV: string | null = null
  public mode: MultiplayerMode = "p2p"

  private room: any = null
  private lanWs: WebSocket | null = null
  private sendStateAction: ((data: CarStatePacket) => void) | null = null
  private sendEventAction: ((data: NetworkEventPacket) => void) | null = null
  private deniedIds = new Set<string>()

  public peers = new Map<string, PeerPlayer>()
  public remoteCars = new Map<string, RemoteCar>()

  private callbacks: MultiplayerCallbacks = {}
  private lastBroadcast = 0
  private lastPing = 0
  private packetSeq = 0
  private localSession = ""
  private sessions = new PeerSessionTracker()

  private activeScene: THREE.Scene | null = null
  private activeWorld: RAPIER.World | null = null
  private activeRapier: typeof RAPIER | null = null
  private baseUrl = ""

  constructor(name?: string, color?: number) {
    this.localId = selfId
    this.localName = name || `Racer-${selfId.slice(0, 4)}`
    this.localColor = color ?? DEFAULT_PLAYER_COLOR
    this.localColorHex = colorHex(this.localColor)
  }

  setCallbacks(cbs: MultiplayerCallbacks) {
    this.callbacks = cbs
  }

  public setLocalCarId(carId: string) {
    if (carId === this.localCarId) return
    this.localCarId = carId
    this.announceIdentitySoon()
  }

  private helloPayload() {
    return {
      name: this.localName,
      color: this.localColor,
      session: this.localSession,
      carId: this.localCarId,
      passHash: this.roomPasswordHashV,
    }
  }
  private remoteOptsFor(peer: PeerPlayer | undefined) {
    const def = getCar(peer?.carId)
    return {
      modelFile: def.modelFile,
      dims: def.physics.dimensions,
      mass: def.physics.mass.chassis,
      paintMatch: def.paintMatch,
      paintTexture: def.paintTexture,
    }
  }

  public localReady = false
  private localReadyDistanceM: number | null = null

  public setLocalReady(ready: boolean, distanceM?: number) {
    this.localReady = ready
    if (distanceM !== undefined) this.localReadyDistanceM = distanceM
    if (!this.roomId) return
    this.sendEvent({
      type: "READY",
      senderId: this.localId,
      t: Date.now(),
      payload: { ready, distanceM: this.localReadyDistanceM ?? null },
    })
    this.notifyPeersChanged()
  }

  public areAllReady(): boolean {
    if (!this.roomId) return true
    if (!this.localReady) return false
    for (const p of this.peers.values()) {
      if (!p.ready) return false
    }
    return true
  }

  public waitingForNames(): string[] {
    if (!this.roomId || !this.localReady) return []
    const out: string[] = []
    for (const p of this.peers.values()) {
      if (!p.ready) out.push(p.name)
    }
    return out
  }

  private markRaceStarted() {
    this.localReady = true
    this.localReadyDistanceM = null
    for (const p of this.peers.values()) p.ready = true
  }

  private resetReadySilent() {
    this.localReady = false
    this.localReadyDistanceM = null
    for (const p of this.peers.values()) p.ready = false
  }

  attachScene(
    scene: THREE.Scene,
    baseUrl: string,
    world?: RAPIER.World,
    rapier?: typeof RAPIER,
  ) {
    this.activeScene = scene
    this.baseUrl = baseUrl
    this.activeWorld = world ?? null
    this.activeRapier = rapier ?? null

    for (const [id, peer] of this.peers.entries()) {
      if (!this.remoteCars.has(id)) {
        const remote = new RemoteCar(
          id,
          peer.name,
          peer.color,
          this.activeScene,
          this.baseUrl,
          this.activeWorld ?? undefined,
          this.activeRapier ?? undefined,
          this.remoteOptsFor(peer),
        )
        this.remoteCars.set(id, remote)
      }
    }
  }

  detachScene() {
    this.activeScene = null
    this.activeWorld = null
    this.activeRapier = null
  }

  join(
    target: string,
    mode: MultiplayerMode = "p2p",
    playerName?: string,
    carColor?: number,
    password?: string,
  ): boolean {
    const passHash = password ? roomPasswordHash(target.trim(), password) : null
    const cleanTarget = (target || "").trim()
    if (mode === "p2p") {
      if (!cleanTarget) {
        this.failJoin("P2P", new Error("enter a room code or create a new room"))
        return false
      }
      if (this.mode === "p2p" && this.roomId === cleanTarget && this.roomPasswordHashV === passHash) {
        console.log(`[Multiplayer P2P] Already in room "${cleanTarget}" — ignoring duplicate join`)
        this.applyProfile(playerName, carColor)
        this.notifyPeersChanged()
        return true
      }
      try {
        this.joinP2P(cleanTarget, playerName, carColor, passHash)
        return true
      } catch (e) {
        return this.failJoin("P2P", e)
      }
    } else {
      const key = cleanTarget || "localhost:9876"
      if (this.mode === "lan" && this.roomId === key) {
        console.log(`[Multiplayer LAN] Already connected to "${key}" — ignoring duplicate join`)
        this.applyProfile(playerName, carColor)
        this.notifyPeersChanged()
        return true
      }
      try {
        this.joinLAN(key, playerName, carColor, passHash)
        return true
      } catch (e) {
        return this.failJoin("LAN", e)
      }
    }
  }

  private failJoin(kind: string, e: unknown): boolean {
    const msg = e instanceof Error ? e.message : String(e)
    console.warn(`[Multiplayer ${kind}] Join failed:`, msg)
    try {
      this.leave()
    } catch {}
    this.callbacks.onJoinError?.(
      `Could not start ${kind} connection (${msg}). Check your internet and try again.`,
    )
    return false
  }

  private applyProfile(playerName?: string, carColor?: number) {
    if (playerName) this.localName = playerName
    if (carColor !== undefined) {
      this.localColor = carColor
      this.localColorHex = colorHex(carColor)
    }
  }

  private joinP2P(
    roomId: string,
    playerName?: string,
    carColor?: number,
    passHash: string | null = null,
  ) {
    this.leave()
    this.mode = "p2p"
    this.roomPasswordHashV = passHash
    this.applyProfile(playerName, carColor)
    this.packetSeq = 0
    this.localSession = newSessionId()

    this.roomId = roomId
    console.log(`[Multiplayer P2P] Joining room "${roomId}" as ${this.localName} (${this.localId})`)

    this.room = joinRoom(
      {
        appId: "oversteer-racer-v1",
      },
      roomId,
    )

    const stateAction = this.room.makeAction("state")
    const eventAction = this.room.makeAction("event")

    this.sendStateAction = (pkt: CarStatePacket) => {
      stateAction.send(pkt).catch((e: unknown) => {
        console.warn("[Multiplayer P2P] State send failed:", e)
      })
    }
    this.sendEventAction = (evt: NetworkEventPacket) => {
      eventAction.send(evt).catch((e: unknown) => {
        console.warn("[Multiplayer P2P] Event send failed:", e)
      })
    }

    stateAction.onMessage = (pkt: CarStatePacket, { peerId }: { peerId: string }) => {
      this.handleStatePacket(pkt, peerId)
    }

    eventAction.onMessage = (evt: NetworkEventPacket, { peerId }: { peerId: string }) => {
      this.handleNetworkEvent(evt, peerId)
    }

    this.room.onPeerJoin = (peerId: string) => {
      console.log(`[Multiplayer P2P] Peer connected: ${peerId}`)
      if (this.deniedIds.has(peerId)) return
      this.registerPeer(peerId)

      this.sendEvent({
        type: "HELLO",
        senderId: this.localId,
        t: Date.now(),
        payload: this.helloPayload(),
      })
    }

    this.room.onPeerLeave = (peerId: string) => {
      console.log(`[Multiplayer P2P] Peer disconnected: ${peerId}`)
      this.unregisterPeer(peerId)
    }

    this.sendEvent({
      type: "HELLO",
      senderId: this.localId,
      t: Date.now(),
      payload: this.helloPayload(),
    })

    this.notifyPeersChanged()
  }

  private joinLAN(
    serverAddress: string,
    playerName?: string,
    carColor?: number,
    passHash: string | null = null,
  ) {
    this.leave()
    this.mode = "lan"
    this.roomPasswordHashV = passHash
    this.applyProfile(playerName, carColor)
    this.packetSeq = 0
    this.localSession = newSessionId()

    let url = serverAddress.trim() || "localhost:9876"
    if (!url.startsWith("ws://") && !url.startsWith("wss://")) {
      url = `ws://${url}`
    }
    try {
      const parsed = new URL(url)
      if (!parsed.port) {
        url = `${parsed.protocol}//${parsed.hostname}:9876`
      }
    } catch {}

    this.roomId = serverAddress || "localhost:9876"
    console.log(`[Multiplayer LAN] Connecting to ${url} as ${this.localName}`)

    const ws = new WebSocket(url)
    this.lanWs = ws
    let opened = false

    this.sendStateAction = (pkt: CarStatePacket) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "state", senderId: this.localId, pkt }))
      }
    }

    this.sendEventAction = (evt: NetworkEventPacket) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "event", senderId: this.localId, evt }))
      }
    }

    ws.onopen = () => {
      opened = true
      console.log(`[Multiplayer LAN] Connected to ${url}`)
      this.sendEvent({
        type: "HELLO",
        senderId: this.localId,
        t: Date.now(),
        payload: this.helloPayload(),
      })
      this.notifyPeersChanged()
    }

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data)
        const senderId = msg.senderId
        if (!senderId || senderId === this.localId) return

        if (!this.peers.has(senderId)) {
          this.registerPeer(senderId)
          this.sendEvent({
            type: "HELLO",
            senderId: this.localId,
            t: Date.now(),
            payload: this.helloPayload(),
          })
        }

        if (msg.type === "state" && msg.pkt) {
          this.handleStatePacket(msg.pkt, senderId)
        } else if (msg.type === "event" && msg.evt) {
          this.handleNetworkEvent(msg.evt, senderId)
        }
      } catch (err) {
        netDiagInvalid("lan", "parse-error")
        console.warn("[Multiplayer LAN] Parse error:", err)
      }
    }

    ws.onclose = () => {
      if (!opened && this.lanWs === ws) {
        console.warn(`[Multiplayer LAN] Could not reach ${url}`)
        const addr = url.replace(/^wss?:\/\//, "")
        try {
          this.leave()
        } catch {}
        this.callbacks.onJoinError?.(
          `Could not reach ${addr}. Is the host running and the address correct?`,
        )
        return
      }
      console.log("[Multiplayer LAN] Connection closed")
      if (this.lanWs === ws) this.leave()
    }

    ws.onerror = (e) => {
      console.warn("[Multiplayer LAN] WebSocket error:", e)
    }
  }

  private registerPeer(peerId: string): PeerPlayer {
    let peer = this.peers.get(peerId)
    if (!peer) {
      peer = {
        id: peerId,
        name: `Racer-${peerId.slice(0, 4)}`,
        color: 0xffffff,
        colorHex: "#ffffff",
        pingMs: 0,
        ready: false,
        isHost: false,
        lastSeen: Date.now(),
        progress: 0,
        finished: false,
        finishTime: null,
      }
      this.peers.set(peerId, peer)

      if (this.activeScene && this.activeWorld && !this.remoteCars.has(peerId)) {
        const remote = new RemoteCar(
          peerId,
          peer.name,
          peer.color,
          this.activeScene,
          this.baseUrl,
          this.activeWorld ?? undefined,
          this.activeRapier ?? undefined,
          this.remoteOptsFor(peer),
        )
        this.remoteCars.set(peerId, remote)
      }

      this.callbacks.onPlayerJoined?.(peer)
      this.notifyPeersChanged()
      netDiagPeerEvent(peerId, "connect")
      netDiagRemoteCount(this.remoteCars.size)
    }
    return peer
  }

  private unregisterPeer(peerId: string) {
    this.peers.delete(peerId)
    this.sessions.reset(peerId)
    netDiagPeerEvent(peerId, "disconnect")
    const remote = this.remoteCars.get(peerId)
    if (remote) {
      if (this.activeScene) {
        try {
          remote.dispose(this.activeScene, this.activeWorld ?? undefined)
        } catch (e) {
          console.warn("[Multiplayer] Remote dispose failed:", e)
        }
      }
      this.remoteCars.delete(peerId)
    }
    this.callbacks.onPlayerLeft?.(peerId)
    this.notifyPeersChanged()
    netDiagForgetPeer(peerId)
    netDiagRemoteCount(this.remoteCars.size)
  }

  private handleStatePacket(pkt: CarStatePacket, senderId: string) {
    if (this.deniedIds.has(senderId)) return
    if (!pkt || typeof pkt !== "object") {
      netDiagInvalid(senderId, "malformed-envelope")
      return
    }
    const arrivalMs = performance.now()
    const checked = validateStatePacket(pkt)
    if (!checked.ok) {
      netDiagInvalid(senderId, checked.reason)
      return
    }
    netDiagRecv(senderId, checked.state.senderT)
    const decision = this.sessions.evaluate(
      senderId,
      checked.state.sess,
      checked.state.seq,
    )
    if (!isAccept(decision)) {
      netDiagSeqReject(
        senderId,
        decision === "reject-duplicate"
          ? "duplicate"
          : decision === "reject-stale"
            ? "stale"
            : "stale-session",
      )
      return
    }
    netDiagSeqAccept(senderId, checked.state.seq, decision === "accept-initial")
    if (decision === "accept-initial") {
      this.remoteCars.get(senderId)?.resetInterpolation("session-start")
    }

    if (!this.peers.has(senderId)) {
      this.registerPeer(senderId)
    }
    let car = this.remoteCars.get(senderId)
    if (!car && this.activeScene && this.activeWorld) {
      const peer = this.peers.get(senderId)
      const name = peer?.name ?? `Racer-${senderId.slice(0, 4)}`
      const color = peer?.color ?? 0xffffff
      car = new RemoteCar(
        senderId,
        name,
        color,
        this.activeScene,
        this.baseUrl,
        this.activeWorld ?? undefined,
        this.activeRapier ?? undefined,
        this.remoteOptsFor(peer),
      )
      this.remoteCars.set(senderId, car)
      netDiagRemoteCount(this.remoteCars.size)
    }
    if (car) car.onPacket(checked.state, arrivalMs)

    const peer = this.peers.get(senderId)
    if (peer) {
      peer.progress = checked.state.progress
      peer.lastSeen = Date.now()
    }
  }

  private handleNetworkEvent(evt: NetworkEventPacket, senderId: string) {
    switch (evt.type) {
      case "HELLO": {
        if (
          this.roomPasswordHashV !== null &&
          evt.payload?.passHash !== this.roomPasswordHashV
        ) {
          console.warn(
            `[Multiplayer] Peer ${senderId} failed the room password check`,
          )
          this.deniedIds.add(senderId)
          if (this.peers.has(senderId)) this.unregisterPeer(senderId)
          this.sendEvent({
            type: "DENY",
            senderId: this.localId,
            t: Date.now(),
          })
          return
        }
        const peer = this.registerPeer(senderId)
        this.sessions.noteSession(senderId, evt.payload?.session)
        peer.name = evt.payload?.name || peer.name
        peer.color = evt.payload?.color ?? peer.color
        peer.colorHex = colorHex(peer.color)
        if (typeof evt.payload?.carId === "string") {
          peer.carId = evt.payload.carId
        }
        const car = this.remoteCars.get(senderId)
        if (car) {
          car.name = peer.name
          if (evt.payload?.color !== undefined) {
            car.setColor(evt.payload.color)
          }
          car.setModel(modelFileForCarId(peer.carId), {
            paintMatch: getCar(peer.carId).paintMatch,
            paintTexture: getCar(peer.carId).paintTexture,
          })
        }
        this.notifyPeersChanged()
        break
      }
      case "PING": {
        this.sendEvent({
          type: "PONG",
          senderId: this.localId,
          t: evt.t,
        })
        break
      }
      case "PONG": {
        const peer = this.peers.get(senderId)
        if (peer) {
          const rtt = Math.max(1, Date.now() - evt.t)
          peer.pingMs = Math.round(rtt / 2)
          netDiagRtt(senderId, rtt)
          this.notifyPeersChanged()
        }
        break
      }
      case "START_RACE": {
        console.log("[Multiplayer] Received START_RACE signal from host")
        this.markRaceStarted()
        this.callbacks.onRaceStartSignal?.(
          evt.payload?.startTimeMs ?? Date.now(),
          evt.payload?.distanceM ?? 5000,
          evt.payload?.rivals ?? 0,
        )
        break
      }
      case "FINISH_RACE": {
        const peer = this.peers.get(senderId)
        if (peer) {
          peer.finished = true
          peer.finishTime = evt.payload?.time ?? null
        }
        const car = this.remoteCars.get(senderId)
        if (car) {
          car.finished = true
          car.finishTime = evt.payload?.time ?? null
        }
        this.callbacks.onRaceFinishSignal?.(senderId, evt.payload?.time)
        this.notifyPeersChanged()
        break
      }
      case "DENY": {
        console.warn("[Multiplayer] Denied by the room (wrong password)")
        this.leave()
        this.callbacks.onJoinError?.(
          "Room is password-protected: wrong or missing password.",
        )
        break
      }
      case "READY": {
        const peer = this.peers.get(senderId) ?? this.registerPeer(senderId)
        peer.ready = !!evt.payload?.ready
        this.notifyPeersChanged()
        break
      }
    }
  }

  public sendEvent(evt: NetworkEventPacket) {
    if (this.sendEventAction) {
      try {
        this.sendEventAction(evt)
      } catch (e) {
        console.warn("[Multiplayer] Failed to send event:", e)
      }
    }
  }

  public announceIdentity() {
    if (!this.roomId) return
    this.sendEvent({
      type: "HELLO",
      senderId: this.localId,
      t: Date.now(),
      payload: this.helloPayload(),
    })
  }

  private helloTimer: ReturnType<typeof setTimeout> | null = null

  public announceIdentitySoon() {
    if (!this.roomId) return
    if (this.helloTimer) clearTimeout(this.helloTimer)
    this.helloTimer = setTimeout(() => {
      this.helloTimer = null
      this.announceIdentity()
    }, 400)
  }

  public broadcastLocalState(
    car: CarController,
    tele: CarTelemetry | null,
    progress: number,
  ) {
    if (!this.sendStateAction) return
    if (!tele) return

    const now = performance.now()
    if (now - this.lastBroadcast < BROADCAST_INTERVAL_MS) return
    this.lastBroadcast = now

    const body = car.body
    const p = body.translation()
    const q = body.rotation()
    const v = body.linvel()

    const pkt: CarStatePacket = {
      id: this.localId,
      t: now,
      seq: this.packetSeq++,
      sess: this.localSession,
      x: p.x,
      y: p.y,
      z: p.z,
      qx: q.x,
      qy: q.y,
      qz: q.z,
      qw: q.w,
      vx: v.x,
      vy: v.y,
      vz: v.z,
      steer: car.steerAngle,
      speed: Number.isFinite(tele.speedKmh) ? tele.speedKmh : 0,
      rpm: tele.rpm,
      gear: tele.gear,
      drift: tele.drift,
      smoke: tele.slipRatio > 0.4 || tele.drift,
      progress,
    }

    try {
      this.sendStateAction(pkt)
      netDiagSend()
    } catch {}

    const wallNow = Date.now()
    if (wallNow - this.lastPing > PING_INTERVAL_MS) {
      this.lastPing = wallNow
      this.sendEvent({
        type: "PING",
        senderId: this.localId,
        t: wallNow,
      })
    }
  }

  public startMultiplayerRace(distanceM: number, rivals = 0) {
    this.markRaceStarted()
    this.notifyPeersChanged()
    const startTimeMs = Date.now() + 3200
    this.sendEvent({
      type: "START_RACE",
      senderId: this.localId,
      t: Date.now(),
      payload: {
        startTimeMs,
        distanceM,
        rivals,
      },
    })
    this.callbacks.onRaceStartSignal?.(startTimeMs, distanceM, rivals)
  }

  public notifyFinish(timeSeconds: number) {
    this.sendEvent({
      type: "FINISH_RACE",
      senderId: this.localId,
      t: Date.now(),
      payload: { time: timeSeconds },
    })
  }

  public updateRemoteCars(dt: number, smokeSystem?: TireSmoke) {
    const cs0 = performance.now()
    for (const remote of this.remoteCars.values()) {
      remote.sampleContacts(cs0)
    }
    netDiagContactCost(performance.now() - cs0)
    for (const remote of this.remoteCars.values()) {
      remote.update(dt, smokeSystem)
    }
    netDiagRemoteCount(this.remoteCars.size)
    maybeLogNetDiag()
  }

  public driveRemoteBodies(dt: number) {
    for (const remote of this.remoteCars.values()) {
      remote.drive(dt)
    }
  }

  public getConnectedPeersList(): PeerPlayer[] {
    return Array.from(this.peers.values())
  }

  private notifyPeersChanged() {
    this.callbacks.onPeersUpdated?.(this.getConnectedPeersList())
  }

  public leave() {
    this.resetReadySilent()
    if (this.room) {
      try {
        Promise.resolve(this.room.leave()).catch(() => {})
      } catch {}
      this.room = null
    }
    if (this.lanWs) {
      try {
        this.lanWs.close()
      } catch {}
      this.lanWs = null
    }
    this.sendStateAction = null
    this.sendEventAction = null
    this.sessions.clear()
    this.localSession = ""
    for (const id of this.peers.keys()) {
      netDiagPeerEvent(id, "cleanup")
      netDiagForgetPeer(id)
    }
    this.peers.clear()

    if (this.activeScene) {
      for (const remote of this.remoteCars.values()) {
        try {
          remote.dispose(this.activeScene, this.activeWorld ?? undefined)
        } catch (e) {
          console.warn("[Multiplayer] Remote dispose failed:", e)
        }
      }
    }
    this.remoteCars.clear()
    netDiagRemoteCount(0)
    this.deniedIds.clear()
    this.detachScene()
    this.roomId = null
    this.roomPasswordHashV = null
    this.notifyPeersChanged()
  }
}
