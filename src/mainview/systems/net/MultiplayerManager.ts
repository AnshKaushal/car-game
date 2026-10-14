import * as THREE from "three"
import type * as RAPIER from "@dimforge/rapier3d-compat"
import { joinRoom, selfId } from "@trystero-p2p/torrent"
import type { CarController } from "../CarController"
import type { CarTelemetry } from "../CarController"
import type { TireSmoke } from "../TireSmoke"
import { colorHex, rivalColor } from "../carTint"
import { RemoteCar } from "./RemoteCar"
import type {
  CarStatePacket,
  NetworkEventPacket,
  PeerPlayer,
} from "./types"

const BROADCAST_INTERVAL_MS = 33 // ~30 Hz update rate
const PING_INTERVAL_MS = 2000

export type MultiplayerMode = "p2p" | "lan"

export interface MultiplayerCallbacks {
  onPeersUpdated?: (peers: PeerPlayer[]) => void
  onRaceStartSignal?: (startTimeMs: number, distanceM: number) => void
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
  public roomId: string | null = null
  public mode: MultiplayerMode = "p2p"

  private room: any = null
  private lanWs: WebSocket | null = null
  private sendStateAction: ((data: CarStatePacket) => void) | null = null
  private sendEventAction: ((data: NetworkEventPacket) => void) | null = null

  public peers = new Map<string, PeerPlayer>()
  public remoteCars = new Map<string, RemoteCar>()

  private callbacks: MultiplayerCallbacks = {}
  private lastBroadcast = 0
  private lastPing = 0
  private packetSeq = 0

  private activeScene: THREE.Scene | null = null
  private activeWorld: RAPIER.World | null = null
  private activeRapier: typeof RAPIER | null = null
  private baseUrl = ""

  constructor(name?: string, color?: number) {
    this.localId = selfId
    this.localName = name || `Racer-${selfId.slice(0, 4)}`
    this.localColor = color ?? rivalColor(Math.floor(Math.random() * 10))
    this.localColorHex = colorHex(this.localColor)
  }

  setCallbacks(cbs: MultiplayerCallbacks) {
    this.callbacks = cbs
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

    // Instantiate RemoteCar for any existing peers
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
        )
        this.remoteCars.set(id, remote)
      }
    }
  }

  /**
   * Drop scene/world refs WITHOUT clearing the roster. Must be called
   * whenever the Rapier world is torn down: after that point any RemoteCar
   * created from these refs would own bodies in a freed world, and the
   * next dispose/update on them throws inside Rapier ("borrowed" error)
   * and blanks the window. Cars are re-created on the next attachScene.
   */
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
  ): boolean {
    // Idempotent: mashing Connect must not tear down the room and restart
    // signaling (that orphaned peers mid-handshake).
    const cleanTarget = (target || "").trim()
    if (mode === "p2p") {
      const key = cleanTarget || "paddock-1"
      if (this.mode === "p2p" && this.roomId === key) {
        console.log(`[Multiplayer P2P] Already in room "${key}" — ignoring duplicate join`)
        this.applyProfile(playerName, carColor)
        this.notifyPeersChanged()
        return true
      }
      try {
        this.joinP2P(key, playerName, carColor)
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
        this.joinLAN(key, playerName, carColor)
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

  private joinP2P(roomId: string, playerName?: string, carColor?: number) {
    this.leave()
    this.mode = "p2p"
    this.applyProfile(playerName, carColor)

    this.roomId = roomId
    console.log(`[Multiplayer P2P] Joining room "${roomId}" as ${this.localName} (${this.localId})`)

    this.room = joinRoom(
      {
        appId: "oversteer-racer-v1",
      },
      roomId,
    )

    // trystero 0.26: makeAction returns an { send, onMessage } object
    // (not the old [send, receive] tuple) and onPeerJoin/onPeerLeave are
    // assignable properties. Handlers receive (data, { peerId }).
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

    // High frequency peer state handler
    stateAction.onMessage = (pkt: CarStatePacket, { peerId }: { peerId: string }) => {
      this.handleStatePacket(pkt, peerId)
    }

    // Reliable event handler
    eventAction.onMessage = (evt: NetworkEventPacket, { peerId }: { peerId: string }) => {
      this.handleNetworkEvent(evt, peerId)
    }

    this.room.onPeerJoin = (peerId: string) => {
      console.log(`[Multiplayer P2P] Peer connected: ${peerId}`)
      this.registerPeer(peerId)

      // Announce identity to newcomer
      this.sendEvent({
        type: "HELLO",
        senderId: this.localId,
        t: Date.now(),
        payload: {
          name: this.localName,
          color: this.localColor,
        },
      })
    }

    this.room.onPeerLeave = (peerId: string) => {
      console.log(`[Multiplayer P2P] Peer disconnected: ${peerId}`)
      this.unregisterPeer(peerId)
    }

    // Greet any peers already present
    this.sendEvent({
      type: "HELLO",
      senderId: this.localId,
      t: Date.now(),
      payload: {
        name: this.localName,
        color: this.localColor,
      },
    })

    // Show "connected / waiting for peers" immediately — onPeerJoin only
    // fires once a second peer arrives, otherwise the UI looks dead.
    this.notifyPeersChanged()
  }

  private joinLAN(serverAddress: string, playerName?: string, carColor?: number) {
    this.leave()
    this.mode = "lan"
    this.applyProfile(playerName, carColor)

    let url = serverAddress.trim() || "localhost:9876"
    if (!url.startsWith("ws://") && !url.startsWith("wss://")) {
      url = `ws://${url}`
    }
    // If no port specified, default to 9876
    try {
      const parsed = new URL(url)
      if (!parsed.port) {
        url = `${parsed.protocol}//${parsed.hostname}:9876`
      }
    } catch {}

    this.roomId = serverAddress || "localhost:9876"
    console.log(`[Multiplayer LAN] Connecting to ${url} as ${this.localName}`)

    // Throws (bad URL etc.) are caught by join() and surfaced via onJoinError.
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
        payload: {
          name: this.localName,
          color: this.localColor,
        },
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
          // Respond with our info so newcomer knows who we are
          this.sendEvent({
            type: "HELLO",
            senderId: this.localId,
            t: Date.now(),
            payload: {
              name: this.localName,
              color: this.localColor,
            },
          })
        }

        if (msg.type === "state" && msg.pkt) {
          this.handleStatePacket(msg.pkt, senderId)
        } else if (msg.type === "event" && msg.evt) {
          this.handleNetworkEvent(msg.evt, senderId)
        }
      } catch (err) {
        console.warn("[Multiplayer LAN] Parse error:", err)
      }
    }

    ws.onclose = () => {
      // Never opened = wrong address / host not running: say so instead
      // of silently dropping back to the lobby.
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

      // Only with a live world: after teardown activeWorld is detached and
      // any body created here would live in a freed world (Rapier crash).
      if (this.activeScene && this.activeWorld && !this.remoteCars.has(peerId)) {
        const remote = new RemoteCar(
          peerId,
          peer.name,
          peer.color,
          this.activeScene,
          this.baseUrl,
          this.activeWorld ?? undefined,
          this.activeRapier ?? undefined,
        )
        this.remoteCars.set(peerId, remote)
      }

      this.callbacks.onPlayerJoined?.(peer)
      this.notifyPeersChanged()
    }
    return peer
  }

  private unregisterPeer(peerId: string) {
    this.peers.delete(peerId)
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
  }

  private handleStatePacket(pkt: CarStatePacket, senderId: string) {
    // State can arrive before onPeerJoin/HELLO — register on demand so the
    // roster and progress tracking never miss a peer.
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
      )
      this.remoteCars.set(senderId, car)
    }
    if (car) car.onPacket(pkt)

    const peer = this.peers.get(senderId)
    if (peer) {
      peer.progress = pkt.progress
      peer.lastSeen = Date.now()
    }
  }

  private handleNetworkEvent(evt: NetworkEventPacket, senderId: string) {
    switch (evt.type) {
      case "HELLO": {
        // HELLO can win the race with onPeerJoin — register on demand.
        const peer = this.registerPeer(senderId)
        peer.name = evt.payload?.name || peer.name
        peer.color = evt.payload?.color ?? peer.color
        peer.colorHex = colorHex(peer.color)
        // Retint the live 3D model, not just the roster dot: paint picked
        // after joining (or a HELLO arriving after the visual loaded)
        // must show up on the ghost immediately.
        const car = this.remoteCars.get(senderId)
        if (car) {
          car.name = peer.name
          if (evt.payload?.color !== undefined) {
            car.setColor(evt.payload.color)
          }
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
          this.notifyPeersChanged()
        }
        break
      }
      case "START_RACE": {
        console.log("[Multiplayer] Received START_RACE signal from host")
        this.callbacks.onRaceStartSignal?.(
          evt.payload?.startTimeMs ?? Date.now(),
          evt.payload?.distanceM ?? 5000,
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

  /** Re-broadcast name + paint (lobby picks after joining must propagate). */
  public announceIdentity() {
    if (!this.roomId) return
    this.sendEvent({
      type: "HELLO",
      senderId: this.localId,
      t: Date.now(),
      payload: {
        name: this.localName,
        color: this.localColor,
      },
    })
  }

  private helloTimer: ReturnType<typeof setTimeout> | null = null

  /** Debounced announceIdentity for per-keystroke name edits. */
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
    // t is null while the lobby is open (game not started) — nothing to send.
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
    } catch {}

    // Periodic ping check
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

  public startMultiplayerRace(distanceM: number) {
    const startTimeMs = Date.now() + 3200 // 3.2s countdown for all peers
    this.sendEvent({
      type: "START_RACE",
      senderId: this.localId,
      t: Date.now(),
      payload: {
        startTimeMs,
        distanceM,
      },
    })
    this.callbacks.onRaceStartSignal?.(startTimeMs, distanceM)
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
    for (const remote of this.remoteCars.values()) {
      remote.update(dt, smokeSystem)
    }
  }

  /** Per-physics-substep ghost drive — call before every world.step(). */
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
    if (this.room) {
      try {
        // 0.26 leave() is async — never let it reject unhandled.
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
    this.detachScene()
    this.roomId = null
    this.notifyPeersChanged()
  }
}
