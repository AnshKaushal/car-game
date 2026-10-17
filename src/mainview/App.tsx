import { useEffect, useRef, useState } from "react"
import * as THREE from "three"
import { Play, RotateCcw, LogOut } from "lucide-react"
import {
  initPhysics,
  createWorld,
  createChassisBody,
  moveGroundBody,
  FIXED_DT,
  pushFrameTime,
  consumeSubstep,
  createFixedStepper,
} from "./systems/PhysicsSystem"
import {
  CarController,
  DEFAULT_DASH,
  type CarTelemetry,
} from "./systems/CarController"
import {
  WorldManager,
  roadCenterX,
  roadDirYaw,
  roadYaw,
} from "./systems/WorldManager"
import { CarVisual } from "./systems/CarVisual"
import { TireSmoke } from "./systems/TireSmoke"
import { InputManager, type DriveInput } from "./systems/InputManager"
import {
  AIDriver,
  carProgress,
  holdInput,
  makeProfile,
  makeTrafficProfile,
  stripEdges,
  type TrafficEntry,
} from "./systems/AIDriver"
import { DEFAULT_PLAYER_COLOR, colorHex, rivalColor } from "./systems/carTint"
import {
  RACE_COUNTS,
  RACE_DISTANCES_KM,
  emptyRace,
  trafficCountFor,
  TRAFFIC_OPTIONS,
  type RaceSetup,
  type RaceSnapshot,
  type RaceStanding,
  type TrafficLevel,
} from "./systems/RaceTypes"
import Dashboard from "./ui/Dashboard"
import { EASE, Screen, usePresence, Wipe } from "./ui/anim"
import { RaceHud, RaceLiveBoard, RaceMenu, RaceResults } from "./ui/RaceOverlay"
import { SpeedLines } from "./ui/SpeedLines"
import { MultiplayerManager } from "./systems/net/MultiplayerManager"
import { MultiplayerLobby, MultiplayerHudBadge } from "./ui/MultiplayerLobby"
import { NetDiagPanel } from "./ui/NetDiagPanel"
import {
  netDiagEnabled,
  netDiagPhysicsTick,
} from "./systems/net/NetDiagnostics"
import type { PeerPlayer } from "./systems/net/types"
import { CAR_PHYSICS } from "./constants/physics"
import { CARS, DEFAULT_CAR_ID, getCar } from "./constants/cars"
import { WORLD_CONFIG } from "./constants/world"

const clamp = (v: number, lo: number, hi: number) =>
  Math.max(lo, Math.min(hi, v))

function grassTargetFor(forwardSpeed: number, racing: boolean): number {
  if (!racing) return 1
  const kmh = Math.abs(forwardSpeed) * 3.6
  if (kmh > 270) return 0.2
  if (kmh > 200) return 0.5
  if (kmh > 150) return 0.75
  return 1
}

const initialTele: CarTelemetry = {
  speedKmh: 0,
  rpm: 800,
  gear: 1,
  gearLabel: "1",
  autoMode: true,
  throttle: 0,
  brake: 0,
  steer: 0,
  shifting: false,
  launchArmed: false,
  launching: false,
  parkingBrake: true,
  slipRatio: 0,
  drift: false,
  dash: DEFAULT_DASH,
}

export default function App() {
  const mountRef = useRef<HTMLDivElement>(null)
  const [tele, setTele] = useState<CarTelemetry>(initialTele)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [started, setStarted] = useState(false)
  const [paused, setPaused] = useState(false)
  const [lockHint, setLockHint] = useState(false)
  const speedLinesRef = useRef<HTMLDivElement | null>(null)
  const speedLinesOn = useRef(false)
  const setSpeedLines = (v: number) => {
    const el = speedLinesRef.current
    if (!el) return
    if (v <= 0.001) {
      if (speedLinesOn.current) {
        speedLinesOn.current = false
        el.style.opacity = "0"
        el.classList.add("sl-off")
      }
      return
    }
    if (!speedLinesOn.current) {
      speedLinesOn.current = true
      el.classList.remove("sl-off")
    }
    el.style.opacity = String(
      Math.min(1, v) * CAR_PHYSICS.assists.speedFeel.linesStrength,
    )
  }
  const startedRef = useRef(false)
  const pausedRef = useRef(false)
  const rendererRef = useRef<THREE.WebGLRenderer | null>(null)
  const inputRef = useRef<InputManager | null>(null)
  const resetRef = useRef(false)
  const pauseFnRef = useRef(() => {})
  const resumeFnRef = useRef(() => {})
  const raceSetupRef = useRef<RaceSetup | null>(null)
  const lastRaceRef = useRef<RaceSetup | null>(null)
  const prevOrderRef = useRef<number[] | null>(null)
  const [race, setRace] = useState<RaceSnapshot>(emptyRace)
  const [rivals, setRivals] = useState<(typeof RACE_COUNTS)[number]>(3)
  const [distanceKm, setDistanceKm] =
    useState<(typeof RACE_DISTANCES_KM)[number]>(5)
  const [session, setSession] = useState(0)
  const [carId, setCarId] = useState<string>(() => {
    try {
      return localStorage.getItem("oversteer_car") || DEFAULT_CAR_ID
    } catch {
      return DEFAULT_CAR_ID
    }
  })
  const carIdRef = useRef(carId)
  const garageApiRef = useRef<{
    showCar: (id: string, tint?: number) => void
    paint: (color: number | null) => void
  } | null>(null)
  const selectCar = (id: string) => {
    carIdRef.current = id
    setCarId(id)
    try {
      localStorage.setItem("oversteer_car", id)
    } catch {}
    multiplayerRef.current?.setLocalCarId(id)
    garageApiRef.current?.showCar(id)
  }
  const stepCar = (dir: 1 | -1) => {
    const i = CARS.findIndex((c) => c.id === carIdRef.current)
    const next = CARS[(i < 0 ? 0 : i + dir + CARS.length) % CARS.length]
    selectCar(next.id)
  }
  const [paint, setPaint] = useState<Record<string, number | null>>(() => {
    try {
      const raw = localStorage.getItem("oversteer_paint")
      if (raw) {
        const obj = JSON.parse(raw)
        if (obj && typeof obj === "object") return obj
      }
    } catch {}
    return {}
  })
  const paintRef = useRef(paint)
  const paintFor = (id: string): number | undefined => {
    const picked = paintRef.current[id]
    if (picked !== undefined) return picked ?? undefined
    return getCar(id).defaultTint ?? undefined
  }
  const setPaintFor = (id: string, color: number | null) => {
    const next = { ...paintRef.current, [id]: color }
    paintRef.current = next
    setPaint(next)
    try {
      localStorage.setItem("oversteer_paint", JSON.stringify(next))
    } catch {}
    if (id === carIdRef.current) garageApiRef.current?.paint(color)
  }
  const [pool, setPool] = useState<string[]>(() => {
    try {
      const raw = localStorage.getItem("oversteer_pool")
      if (raw) {
        const arr = JSON.parse(raw)
        if (Array.isArray(arr)) {
          const known = arr.filter((id) => CARS.some((c) => c.id === id))
          if (known.length > 0) return known
        }
      }
    } catch {}
    return CARS.map((c) => c.id)
  })
  const poolRef = useRef(pool)
  const togglePool = (id: string) => {
    setPool((prev) => {
      const next = prev.includes(id)
        ? prev.filter((x) => x !== id)
        : [...prev, id]
      poolRef.current = next
      try {
        localStorage.setItem("oversteer_pool", JSON.stringify(next))
      } catch {}
      return next
    })
  }

  const [trafficLevel, setTrafficLevel] = useState<TrafficLevel>(() => {
    try {
      const raw = localStorage.getItem("oversteer_traffic")
      if (raw === "low" || raw === "medium" || raw === "high") return raw
    } catch {}
    return "off"
  })
  const trafficRef = useRef(trafficLevel)
  const selectTraffic = (level: TrafficLevel) => {
    trafficRef.current = level
    setTrafficLevel(level)
    try {
      localStorage.setItem("oversteer_traffic", level)
    } catch {}
  }

  const [showMultiplayerLobby, setShowMultiplayerLobby] = useState(false)
  const [wipe, setWipe] = useState<{
    token: number
    label: string
    red: boolean
  } | null>(null)
  const fireWipe = (label: string, red = false) =>
    setWipe((w) => ({ token: (w?.token ?? 0) + 1, label, red }))
  const sessionTimer = useRef(0)
  const rebuildSession = (delay = 300) => {
    window.clearTimeout(sessionTimer.current)
    sessionTimer.current = window.setTimeout(() => {
      setSession((n) => n + 1)
    }, delay)
  }
  useEffect(() => () => window.clearTimeout(sessionTimer.current), [])
  const [showIntro, setShowIntro] = useState(true)
  const showIntroRef = useRef(true)
  showIntroRef.current = showIntro
  const showLobbyRef = useRef(false)
  showLobbyRef.current = showMultiplayerLobby
  const loadingRef = useRef(true)
  loadingRef.current = loading
  useEffect(() => {
    if (!showIntro) return
    const dismiss = () => setShowIntro(false)
    window.addEventListener("keydown", dismiss)
    return () => window.removeEventListener("keydown", dismiss)
  }, [showIntro])
  const [netPeers, setNetPeers] = useState<PeerPlayer[]>([])
  const [netConnected, setNetConnected] = useState(false)
  const [joinError, setJoinError] = useState<string | null>(null)
  const [netRoomId, setNetRoomId] = useState("")
  const [driverName, setDriverName] = useState(
    () => localStorage.getItem("oversteer_name") || "Racer",
  )
  const [driverColor, setDriverColor] = useState<number>(0x1f6feb)
  const [showNetDiag] = useState(() => netDiagEnabled())
  const multiplayerRef = useRef<MultiplayerManager | null>(null)
  if (!multiplayerRef.current) {
    multiplayerRef.current = new MultiplayerManager(driverName, driverColor)
  }

  useEffect(() => {
    const net = multiplayerRef.current
    if (!net) return
    net.setCallbacks({
      onPeersUpdated: (peers) => {
        setNetPeers([...peers])
        setNetConnected(!!net.roomId)
      },
      onJoinError: (msg) => {
        setJoinError(msg)
        setNetConnected(false)
      },
      onRaceStartSignal: (startTimeMs, distanceM, rivals = 0) => {
        const next = {
          rivals,
          distanceM,
          seed: Math.floor(startTimeMs),
        }
        lastRaceRef.current = next
        raceSetupRef.current = next
        startedRef.current = true
        pausedRef.current = false
        setStarted(true)
        setPaused(false)
        setShowMultiplayerLobby(false)
        setRace(emptyRace)
        fireWipe("ON THE GRID", true)
        lockCanvas()
        rebuildSession()
      },
    })
  }, [])

  const handleStartMultiplayerRace = (distKm: number, aiCount: number) => {
    const distM = distKm * 1000
    multiplayerRef.current?.startMultiplayerRace(distM, aiCount)
  }

  const handleStartFreeDrive = () => {
    setShowMultiplayerLobby(false)
    startGame()
  }

  const handleLeaveRoom = () => {
    multiplayerRef.current?.leave()
    setNetConnected(false)
    setNetRoomId("")
    setNetPeers([])
    setJoinError(null)
  }

  useEffect(() => {
    if (race.finished) {
      document.documentElement.style.cursor = ""
      document.body.style.cursor = ""
      unlockEscapeKey()
      if (document.pointerLockElement) document.exitPointerLock?.()
    }
  }, [race.finished])

  const lockEscapeKey = () => {
    try {
      ;(navigator as any).keyboard?.lock?.(["Escape"])?.catch?.(() => {})
    } catch {}
  }
  const unlockEscapeKey = () => {
    try {
      ;(navigator as any).keyboard?.unlock?.()
    } catch {}
  }

  const lockCanvas = () => {
    document.documentElement.style.cursor = "none"
    document.body.style.cursor = "none"
    lockEscapeKey()
    const el = rendererRef.current?.domElement as any
    try {
      try {
        const p = el?.requestPointerLock?.({ unadjustedMovement: true })
        if (p?.catch) p.catch(() => {})
      } catch {
        el?.requestPointerLock?.()
      }
    } catch {}
  }

  const startGame = () => {
    raceSetupRef.current = null
    startedRef.current = true
    pausedRef.current = false
    setStarted(true)
    setPaused(false)
    setLockHint(false)
    setRace(emptyRace)
    fireWipe("FREE ROAM")
    lockCanvas()
    rebuildSession()
  }

  const startRace = () => {
    const next = {
      rivals,
      distanceM: distanceKm * 1000,
    }
    lastRaceRef.current = next
    raceSetupRef.current = next
    startedRef.current = true
    pausedRef.current = false
    setStarted(true)
    setPaused(false)
    setLockHint(false)
    setRace(emptyRace)
    fireWipe("ON THE GRID", true)
    lockCanvas()
    rebuildSession()
  }

  const pauseGame = () => {
    if (!startedRef.current || pausedRef.current) return
    pausedRef.current = true
    setPaused(true)
    inputRef.current?.clear()
    unlockEscapeKey()
    document.documentElement.style.cursor = ""
    document.body.style.cursor = ""
    if (document.pointerLockElement) document.exitPointerLock?.()
  }

  const resumeGame = () => {
    if (!startedRef.current || !pausedRef.current) return
    pausedRef.current = false
    setPaused(false)
    setLockHint(false)
    inputRef.current?.clear()
    lockCanvas()
  }

  const raceAgain = () => {
    const last = lastRaceRef.current
    if (!last) return
    const net = multiplayerRef.current
    if (net && net.roomId) {
      net.setLocalReady(true, last.distanceM)
    }
    pausedRef.current = false
    startedRef.current = true
    setPaused(false)
    setRace(emptyRace)
    inputRef.current?.clear()
    document.documentElement.style.cursor = ""
    document.body.style.cursor = ""
    if (document.pointerLockElement) document.exitPointerLock?.()
    raceSetupRef.current = last
    fireWipe("ON THE GRID", true)
    rebuildSession()
  }

  const quitToMenu = () => {
    const net = multiplayerRef.current
    if (net && net.roomId && net.localReady) net.setLocalReady(false)
    pausedRef.current = false
    startedRef.current = false
    raceSetupRef.current = null
    setPaused(false)
    setStarted(false)
    setLockHint(false)
    setRace(emptyRace)
    inputRef.current?.clear()
    unlockEscapeKey()
    document.documentElement.style.cursor = ""
    document.body.style.cursor = ""
    if (document.pointerLockElement) document.exitPointerLock?.()
    fireWipe("GARAGE")
    rebuildSession()
  }

  pauseFnRef.current = pauseGame
  resumeFnRef.current = resumeGame

  useEffect(() => {
    if (started || loading || showMultiplayerLobby) return
    const onKey = (e: KeyboardEvent) => {
      if (e.code === "ArrowLeft") stepCar(-1)
      else if (e.code === "ArrowRight") stepCar(1)
      else return
      e.preventDefault()
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [started, loading, showMultiplayerLobby])

  useEffect(() => {
    let disposed = false
    let renderer: THREE.WebGLRenderer | null = null
    let raf = 0
    const teleRef = { last: 0 }

    ;(async () => {
      try {
        const mount = mountRef.current!
        if (disposed) return
        renderer = new THREE.WebGLRenderer({ antialias: true })
        renderer.setSize(mount.clientWidth, mount.clientHeight)
        renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.75))
        renderer.shadowMap.enabled = true
        renderer.shadowMap.type = THREE.PCFSoftShadowMap
        mount.appendChild(renderer.domElement)
        rendererRef.current = renderer

        const scene = new THREE.Scene()
        scene.background = new THREE.Color(0x87ceeb)
        const camera = new THREE.PerspectiveCamera(
          68,
          mount.clientWidth / mount.clientHeight,
          0.1,
          2500,
        )

        const R = await initPhysics()
        const world = createWorld()

        const wm = new WorldManager()
        const base = import.meta.env.BASE_URL || "./"
        const baseUrl = base.endsWith("/") ? base : base + "/"
        await wm.init(scene, baseUrl)
        if (disposed) {
          try {
            world.free()
          } catch {}
          return
        }
        const groundBody = wm.createPhysicsGround(R, world)

        const net = multiplayerRef.current
        if (net) {
          net.setLocalCarId(carIdRef.current)
          net.attachScene(scene, baseUrl, world, R)
        }

        const playerDef = getCar(carIdRef.current)
        const camHeightBoost =
          Math.max(0, playerDef.physics.dimensions.height - 1.43) * 1.35

        const setup = raceSetupRef.current
        const rivalCount = setup?.rivals ?? 0
        const raceDistance = setup?.distanceM ?? 0
        const isNetRace = !!(net && net.roomId && raceDistance > 0)
        const netPeerCount = net?.peers.size ?? 0
        const netIds =
          net && net.roomId
            ? [net.localId, ...Array.from(net.peers.keys())].sort()
            : null
        const netIndex =
          net && netIds ? Math.max(0, netIds.indexOf(net.localId)) : 0
        const netTotal = netIds ? netIds.length : 1
        const gridCount = 1 + rivalCount + (isNetRace ? netPeerCount : 0)
        const raceActiveInit = rivalCount > 0 || isNetRace
        const prCap = 1.75
        renderer!.setPixelRatio(Math.min(window.devicePixelRatio, prCap))
        if (raceActiveInit) {
          const fc = document.createElement("canvas")
          fc.width = 128
          fc.height = 32
          const fg = fc.getContext("2d")!
          for (let y = 0; y < 2; y++) {
            for (let x = 0; x < 8; x++) {
              fg.fillStyle = (x + y) % 2 === 0 ? "#141414" : "#f2f2f2"
              fg.fillRect(x * 16, y * 16, 16, 16)
            }
          }
          const finishTex = new THREE.CanvasTexture(fc)
          finishTex.colorSpace = THREE.SRGBColorSpace
          finishTex.anisotropy = 4
          const stripGeo = new THREE.PlaneGeometry(WORLD_CONFIG.road.width, 3)
          stripGeo.rotateX(-Math.PI / 2)
          const strip = new THREE.Mesh(
            stripGeo,
            new THREE.MeshBasicMaterial({ map: finishTex }),
          )
          strip.position.set(roadCenterX(raceDistance), 0.04, -raceDistance)
          strip.rotation.y = roadDirYaw(raceDistance)
          scene.add(strip)
        }
        const gridSlot = (slot: number, total: number) => {
          const row = Math.floor(slot / 2)
          const loneLast = total % 2 === 1 && slot === total - 1
          const left = slot % 2 === 0
          return { s: -row * 7.5, lateral: loneLast ? 0 : left ? -3.0 : 3.0 }
        }
        const prev = prevOrderRef.current
        let playerSlotIdx = 0
        let aiSlotOf: (ai: number) => number = (ai) => ai + 1
        if (isNetRace && net) {
          playerSlotIdx = netIndex
          aiSlotOf = (ai) => netTotal + ai
        } else if (raceActiveInit && prev && prev.length > 0) {
          const pos = new Map<number, number>()
          prev.forEach((ai, i) => pos.set(ai, i))
          const aiByMerit = [...Array(rivalCount).keys()].sort(
            (a, b) => (pos.get(a) ?? 1e9) - (pos.get(b) ?? 1e9),
          )
          playerSlotIdx = Math.floor(Math.random() * gridCount)
          const free = [...Array(gridCount).keys()].filter(
            (s) => s !== playerSlotIdx,
          )
          const slotMap = new Map<number, number>()
          aiByMerit.forEach((ai, i) => slotMap.set(ai, free[i]))
          aiSlotOf = (ai) => slotMap.get(ai) ?? ai + 1
        }
        const yaw0 = roadDirYaw(0)
        const nx0 = Math.cos(roadYaw(0))
        const nz0 = Math.sin(roadYaw(0))
        const playerSlot = raceActiveInit
          ? gridSlot(playerSlotIdx, gridCount)
          : netIds
            ? gridSlot(netIndex, Math.max(netTotal, 2))
            : { s: 0, lateral: 0 }
        const spawned = raceActiveInit || !!netIds
        const playerX = spawned
          ? roadCenterX(playerSlot.s) + nx0 * playerSlot.lateral
          : roadCenterX(0)
        const playerZ = spawned ? -playerSlot.s + nz0 * playerSlot.lateral : 0
        const startX = playerX
        const body = createChassisBody(
          world,
          playerX,
          0.72,
          playerZ,
          playerDef.physics.dimensions,
          playerDef.physics.mass.chassis,
        )
        const q0 = new THREE.Quaternion().setFromEuler(
          new THREE.Euler(0, yaw0, 0),
        )
        body.setRotation({ x: q0.x, y: q0.y, z: q0.z, w: q0.w }, true)
        const car = new CarController(
          world,
          body,
          R,
          playerDef.physics,
          playerDef.wheels,
          playerDef.dash,
        )

        interface Rival {
          car: CarController
          visual: CarVisual
          ai: AIDriver
          name: string
          color: string
          progress: number
          finished: boolean
          finishTime: number | null
          stuckT: number
          cached: DriveInput
          stride: number
          edgeArmed: boolean
          brake: number
          hi: boolean
        }
        const rivals: Rival[] = []
        const useSharedField = isNetRace && setup?.seed != null
        const poolIds = useSharedField
          ? CARS.map((c) => c.id)
          : poolRef.current.length
            ? poolRef.current
            : CARS.map((c) => c.id)
        const poolDefs = CARS.filter((c) => poolIds.includes(c.id))
        const gridPool = poolDefs.length > 0 ? poolDefs : [...CARS]
        let rand: () => number = Math.random
        if (useSharedField) {
          let s = setup!.seed! | 0 || 1
          rand = () => {
            s |= 0
            s = (s + 0x6d2b79f5) | 0
            let t = Math.imul(s ^ (s >>> 15), 1 | s)
            t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
            return ((t ^ (t >>> 14)) >>> 0) / 4294967296
          }
        }
        for (let i = gridPool.length - 1; i > 0; i--) {
          const j = (rand() * (i + 1)) | 0
          const tmp = gridPool[i]
          gridPool[i] = gridPool[j]
          gridPool[j] = tmp
        }
        const rivalCounts = new Map<string, number>()
        for (let i = 0; i < rivalCount; i++) {
          const rivalDef = gridPool[i % gridPool.length]
          const seen = (rivalCounts.get(rivalDef.id) ?? 0) + 1
          rivalCounts.set(rivalDef.id, seen)
          const slot = aiSlotOf(i)
          const g = gridSlot(slot, gridCount)
          const s0 = g.s
          const yaw = roadDirYaw(s0)
          const nx = Math.cos(roadYaw(s0))
          const nz = Math.sin(roadYaw(s0))
          const rb = createChassisBody(
            world,
            roadCenterX(s0) + nx * g.lateral,
            0.72,
            -s0 + nz * g.lateral,
            rivalDef.physics.dimensions,
            rivalDef.physics.mass.chassis,
          )
          const q = new THREE.Quaternion().setFromEuler(
            new THREE.Euler(0, yaw, 0),
          )
          rb.setRotation({ x: q.x, y: q.y, z: q.z, w: q.w }, true)
          const rc = new CarController(
            world,
            rb,
            R,
            rivalDef.physics,
            rivalDef.wheels,
            rivalDef.dash,
          )
          const color = rivalColor(i)
          const vis = new CarVisual()
          vis.castShadow = i < 2
          try {
            await vis.load(baseUrl, color, {
              modelFile: rivalDef.modelFile,
              targetLength: rivalDef.physics.dimensions.length,
              pivots: rivalDef.pivots,
              wheelSpots: rivalDef.wheels,
              wheelRadius: rivalDef.physics.wheels.radius,
              paintMatch: rivalDef.paintMatch,
              paintTexture: rivalDef.paintTexture,
            })
          } catch (e) {
            console.warn("rival model failed", e)
          }
          scene.add(vis.group)
          rivals.push({
            car: rc,
            visual: vis,
            ai: new AIDriver(makeProfile(i)),
            name: `${rivalDef.shortName} ${seen}`,
            color: colorHex(color),
            progress: s0,
            finished: false,
            finishTime: null,
            stuckT: 0,
            cached: holdInput(),
            stride: 1,
            edgeArmed: false,
            brake: 0,
            hi: true,
          })
        }
        const trafficCars: Rival[] = []
        const trafficTarget =
          startedRef.current && !raceActiveInit
            ? trafficCountFor(trafficRef.current)
            : 0
        const placed: { s: number; half: 1 | -1 }[] = [
          { s: 0, half: 1 },
          { s: 0, half: -1 },
        ]
        for (let i = 0; i < trafficTarget; i++) {
          const def = CARS[(Math.random() * CARS.length) | 0]
          const tdir: 1 | -1 = Math.random() < 0.55 ? 1 : -1
          const thalf: 1 | -1 = tdir === 1 ? 1 : -1
          let ts0 = 0
          for (let attempt = 0; attempt < 8; attempt++) {
            const cand = 250 + Math.random() * 600
            ts0 = cand
            const clash = placed.some(
              (q) => q.half === thalf && Math.abs(q.s - cand) < 18,
            )
            if (!clash) break
          }
          placed.push({ s: ts0, half: thalf })
          const tprof = makeTrafficProfile(Math.random, tdir)
          const tyaw = roadDirYaw(ts0) + (tdir === 1 ? 0 : Math.PI)
          const tnx = Math.cos(roadYaw(ts0))
          const tnz = Math.sin(roadYaw(ts0))
          const tb = createChassisBody(
            world,
            roadCenterX(ts0) + tnx * tprof.laneBias,
            0.72,
            -ts0 + tnz * tprof.laneBias,
            def.physics.dimensions,
            def.physics.mass.chassis,
          )
          const tq = new THREE.Quaternion().setFromEuler(
            new THREE.Euler(0, tyaw, 0),
          )
          tb.setRotation({ x: tq.x, y: tq.y, z: tq.z, w: tq.w }, true)
          const tv0 =
            ((tprof.cruiseKmh ?? 100) / 3.6) * (0.9 + Math.random() * 0.15)
          const tslope = (roadCenterX(ts0 + 4) - roadCenterX(ts0 - 4)) / 8
          const tinv = 1 / Math.hypot(tslope, 1)
          tb.setLinvel(
            { x: tslope * tinv * tv0 * tdir, y: 0, z: -tinv * tv0 * tdir },
            true,
          )
          const tc = new CarController(
            world,
            tb,
            R,
            def.physics,
            def.wheels,
            def.dash,
          )
          const tcolor = rivalColor((Math.random() * 64) | 0)
          const tvis = new CarVisual()
          tvis.castShadow = i < 2
          try {
            await tvis.load(baseUrl, tcolor, {
              modelFile: def.modelFile,
              targetLength: def.physics.dimensions.length,
              pivots: def.pivots,
              wheelSpots: def.wheels,
              wheelRadius: def.physics.wheels.radius,
              paintMatch: def.paintMatch,
              paintTexture: def.paintTexture,
            })
          } catch (e) {
            console.warn("traffic model failed", e)
          }
          scene.add(tvis.group)
          trafficCars.push({
            car: tc,
            visual: tvis,
            ai: new AIDriver(tprof),
            name: def.shortName,
            color: colorHex(tcolor),
            progress: ts0,
            finished: false,
            finishTime: null,
            stuckT: 0,
            cached: holdInput(),
            stride: 1,
            edgeArmed: false,
            brake: 0,
            hi: true,
          })
        }
        if (disposed) {
          try {
            world.free()
          } catch {}
          return
        }

        {
          const zeroInput = {
            throttle: 0,
            brake: 0,
            steer: 0,
            handbrake: false,
            upshiftPressed: false,
            downshiftPressed: false,
            toggleModePressed: false,
            toggleLaunchPressed: false,
            toggleParkPressed: false,
            resetPressed: false,
            toggleCameraPressed: false,
            startPressed: false,
            pausePressed: false,
          }
          const allCars = [car, ...rivals.map((r) => r.car)]
          for (let i = 0; i < 120; i++) {
            for (const c of allCars) c.update(FIXED_DT, zeroInput)
            world.step()
          }
        }

        const allBodies = [
          body,
          ...rivals.map((r) => r.car.body),
          ...trafficCars.map((r) => r.car.body),
        ]

        let visual = new CarVisual()
        const playerPaint = (id: string): number | undefined => {
          if (net?.roomId) return net.localColor
          return paintFor(id)
        }
        try {
          await visual.load(baseUrl, playerPaint(playerDef.id), {
            modelFile: playerDef.modelFile,
            targetLength: playerDef.physics.dimensions.length,
            pivots: playerDef.pivots,
            wheelSpots: playerDef.wheels,
            wheelRadius: playerDef.physics.wheels.radius,
            paintMatch: playerDef.paintMatch,
            paintTexture: playerDef.paintTexture,
          })
        } catch (e) {
          console.warn(
            "player model failed, continuing with fallback wheels",
            e,
          )
        }
        if (disposed) {
          try {
            world.free()
          } catch {}
          return
        }
        scene.add(visual.group)
        {
          let showToken = 0
          garageApiRef.current = {
            showCar: (id: string, tint?: number) => {
              const my = ++showToken
              if (startedRef.current) return
              const def = getCar(id)
              const next = new CarVisual()
              next
                .load(baseUrl, tint ?? playerPaint(id), {
                  modelFile: def.modelFile,
                  targetLength: def.physics.dimensions.length,
                  pivots: def.pivots,
                  wheelSpots: def.wheels,
                  wheelRadius: def.physics.wheels.radius,
                  paintMatch: def.paintMatch,
                  paintTexture: def.paintTexture,
                })
                .then(() => {
                  if (my !== showToken || disposed || startedRef.current) return
                  scene.remove(visual.group)
                  visual = next
                  scene.add(visual.group)
                })
                .catch((e) => {
                  console.warn("garage preview failed", e)
                })
            },
            paint: (color: number | null) => {
              if (startedRef.current || disposed) return
              if (color === null || !visual.hasTint()) {
                garageApiRef.current?.showCar(
                  carIdRef.current,
                  color ?? undefined,
                )
                return
              }
              try {
                visual.setTint(color)
              } catch (e) {
                console.warn("garage paint failed", e)
              }
            },
          }
        }

        let raceActive = rivalCount > 0 || isNetRace
        let raceFinished = false
        let raceElapsed = 0
        let headsUp = raceActive ? 2.6 : 0
        let countdown = raceActive ? 3.0 : 0
        let released = !isNetRace || (net ? net.areAllReady() : true)
        let staged = isNetRace && !released
        let pausedTick = 0
        let playerFinished = false
        let playerFinishTime: number | null = null
        let playerProgress = 0
        let raceUiAcc = 0
        let shadowAcc = 0
        const TRAFFIC_BEHIND = 700
        const TRAFFIC_AHEAD = 1500
        const DETAIL_FAR = 280
        const DETAIL_NEAR = 220
        let trafficShadowAcc = 0
        let playerDoneT = 0

        const smoke = new TireSmoke()
        scene.add(smoke.points)
        const smokeSpots: THREE.Vector3[] = []
        let smokeAcc = 0

        const input = new InputManager()
        input.attach()
        inputRef.current = input
        const onWinBlur = () => {
          input.clear()
        }
        window.addEventListener("blur", onWinBlur)
        let hadLock = false

        const onResize = () => {
          camera.aspect = mount.clientWidth / mount.clientHeight
          camera.updateProjectionMatrix()
          renderer!.setSize(mount.clientWidth, mount.clientHeight)
        }
        window.addEventListener("resize", onResize)

        let chaseFar = true
        let last = performance.now()
        let buriedTimer = 0
        let buriedFrames = 0
        const stepper = createFixedStepper()
        let substepTick = 0
        let fpsFrames = 0
        let fpsLast = -1
        let frameMsAcc = 0
        let frameMsLast = -1
        const camPos = new THREE.Vector3(startX, 3, 8)
        const showDesired = new THREE.Vector3()
        const camLook = new THREE.Vector3()
        const smoothFwd = new THREE.Vector3(0, 0, -1)

        let camYaw = 0
        let camPitch = 0
        let lastOrbit = -10000
        let orbiting = false
        let lastPX = 0,
          lastPY = 0
        const e0 = { lastMovementX: 0, lastMovementY: 0 }
        let mouseLocked = false
        let lockWanted = false
        let lockRetry = 0
        const dom = renderer!.domElement

        const hideCursor = () => {
          document.documentElement.style.cursor = "none"
          document.body.style.cursor = "none"
          tryLock()
        }
        const tryLock = () => {
          if (!startedRef.current || pausedRef.current || lockWanted) return
          lockWanted = true
          const el = dom as any
          if (!el.requestPointerLock) {
            lockWanted = false
            return
          }
          let p: unknown
          try {
            try {
              p = el.requestPointerLock({ unadjustedMovement: true })
            } catch {
              p = el.requestPointerLock()
            }
          } catch {
            lockWanted = false
            return
          }
          const fail = () => {
            lockWanted = false
            if (lockRetry) return
            lockRetry = window.setTimeout(() => {
              lockRetry = 0
              tryLock()
            }, 350)
          }
          if (p && typeof (p as Promise<void>).catch === "function") {
            ;(p as Promise<void>).catch(fail)
          } else {
            window.setTimeout(() => {
              if (lockWanted && document.pointerLockElement !== dom) fail()
            }, 120)
          }
        }
        const onForceHide = () => {
          if (startedRef.current && !document.pointerLockElement)
            lockWanted = false
        }
        const onGesture = (e: Event) => {
          if ((e as KeyboardEvent).key === "Escape") return
          if (startedRef.current && !document.pointerLockElement) tryLock()
        }
        document.addEventListener("pointermove", onForceHide)
        document.addEventListener("pointerdown", onGesture)
        document.addEventListener("keydown", onGesture)
        document.addEventListener("pointerlockerror", onForceHide)
        const onPointerDown = (e: PointerEvent) => {
          if (startedRef.current && !pausedRef.current) hideCursor()
          orbiting = true
          lastPX = e.clientX
          lastPY = e.clientY
          lastOrbit = performance.now() / 1000
        }
        const onPointerMove = (e: PointerEvent) => {
          if (document.pointerLockElement === dom) {
            e0.lastMovementX += e.movementX || 0
            e0.lastMovementY += e.movementY || 0
          } else if (
            e.movementX !== undefined &&
            (e.movementX !== 0 || e.movementY !== 0)
          ) {
            e0.lastMovementX += e.movementX || 0
            e0.lastMovementY += e.movementY || 0
          }
          if (!startedRef.current) {
            if (!orbiting) return
            const dx = e.clientX - lastPX
            const dy = e.clientY - lastPY
            lastPX = e.clientX
            lastPY = e.clientY
            camYaw -= dx * 0.0052
            camPitch = Math.max(-0.5, Math.min(0.5, camPitch + dy * 0.0032))
            lastOrbit = performance.now() / 1000
          }
        }
        const onPointerUp = () => {
          orbiting = false
        }
        const onLockChange = () => {
          mouseLocked = document.pointerLockElement === dom
          if (mouseLocked) {
            hadLock = true
            lockWanted = false
            if (lockRetry) {
              window.clearTimeout(lockRetry)
              lockRetry = 0
            }
          } else {
            lockWanted = false
            if (hadLock && startedRef.current && !pausedRef.current) {
              hadLock = false
              if (multiplayerRef.current?.roomId && !document.hasFocus()) {
                input.clear()
              } else {
                pauseFnRef.current()
              }
            }
          }
          setLockHint(startedRef.current && !pausedRef.current && !mouseLocked)
        }
        dom.addEventListener("pointerdown", onPointerDown)
        dom.addEventListener("pointermove", onPointerMove)
        dom.addEventListener("pointerup", onPointerUp)
        dom.addEventListener("pointercancel", onPointerUp)
        document.addEventListener("pointerlockchange", onLockChange)

        const lockGuard = window.setInterval(() => {
          if (
            startedRef.current &&
            !pausedRef.current &&
            !mouseLocked &&
            !lockWanted &&
            document.pointerLockElement !== dom
          ) {
            tryLock()
          }
        }, 800)

        if (disposed) return
        renderer!.compile(scene, camera)
        setLoading(false)

        const loop = (now: number) => {
          if (disposed) return
          raf = requestAnimationFrame(loop)
          fpsFrames++
          if (fpsLast < 0) fpsLast = now
          if (frameMsLast < 0) frameMsLast = now
          frameMsAcc += now - frameMsLast
          frameMsLast = now
          if (now - fpsLast >= 500) {
            fpsFrames = 0
            frameMsAcc = 0
            fpsLast = now
          }
          let dt = (now - last) / 1000
          last = now
          dt = Math.min(dt, CAR_PHYSICS.simulation.maxFrameDt)

          const inp = input.update(dt)
          if (!startedRef.current && !showIntroRef.current && inp.startPressed)
            startGame()
          if (startedRef.current && inp.pausePressed) {
            if (pausedRef.current) resumeFnRef.current()
            else pauseFnRef.current()
          }
          if (pausedRef.current && inp.startPressed) resumeFnRef.current()
          if (inp.toggleCameraPressed) chaseFar = !chaseFar
          const doReset = inp.resetPressed || resetRef.current
          const fellOut = body.translation().y < -3
          const bq0 = body.rotation()
          const upY0 = 1 - 2 * (bq0.x * bq0.x + bq0.z * bq0.z)
          if (
            startedRef.current &&
            !pausedRef.current &&
            body.translation().y < 0.1 &&
            upY0 < 0.3
          ) {
            buriedTimer += dt
          } else {
            buriedTimer = 0
          }
          if (doReset || fellOut || buriedTimer > 5) {
            buriedTimer = 0
            resetRef.current = false
            const p = body.translation()
            const s = -p.z
            car.reset(
              new THREE.Vector3(roadCenterX(s), 0.72, p.z),
              roadDirYaw(s),
            )
            stepper.acc = 0
          }

          if (pausedRef.current) {
            stepper.acc = 0
            setSpeedLines(0)
            smoke.update(dt)
            pausedTick = (pausedTick + 1) % 3
            if (pausedTick !== 0) return
            renderer!.render(scene, camera)
            return
          }

          let t = null as null | ReturnType<typeof car.update>
          if (startedRef.current) {
            if (isNetRace && !released && !raceFinished) {
              if (net && net.areAllReady()) {
                released = true
                staged = false
              } else {
                staged = true
              }
            }
            if (raceActive && headsUp > 0 && !staged)
              headsUp = Math.max(0, headsUp - dt)
            else if (raceActive && countdown > 0 && !staged)
              countdown = Math.max(0, countdown - dt)
            const racing =
              !raceActive || (released && headsUp <= 0 && countdown <= 0)
            if (raceActive && racing && !raceFinished) raceElapsed += dt
            const steps = pushFrameTime(stepper, dt)
            netDiagPhysicsTick(steps, stepper.droppedTotal)
            if (raceActive) {
              const pp = body.translation()
              const traffic: TrafficEntry[] = allBodies.map((b) => {
                const p = b.translation()
                return { body: b, x: p.x, z: p.z }
              })
              for (const rival of rivals) {
                rival.cached =
                  racing && !rival.finished
                    ? rival.ai.drive(rival.car, traffic, dt)
                    : holdInput()
                rival.edgeArmed = true
                if (rival.ai.recovering) {
                  rival.stride = 1
                } else {
                  const rp0 = rival.car.body.translation()
                  const dx0 = rp0.x - pp.x
                  const dz0 = rp0.z - pp.z
                  const d2 = dx0 * dx0 + dz0 * dz0
                  rival.stride = d2 < 6400 ? 1 : d2 < 40000 ? 2 : 4
                }
              }
            }
            if (trafficCars.length > 0) {
              const tpp = body.translation()
              const tEntries: TrafficEntry[] = allBodies.map((b) => {
                const p = b.translation()
                return { body: b, x: p.x, z: p.z }
              })
              for (const tc of trafficCars) {
                tc.cached = tc.ai.drive(tc.car, tEntries, dt)
                tc.edgeArmed = true
                if (tc.ai.recovering) {
                  tc.stride = 1
                } else {
                  const rp0 = tc.car.body.translation()
                  const dx0 = rp0.x - tpp.x
                  const dz0 = rp0.z - tpp.z
                  const d2 = dx0 * dx0 + dz0 * dz0
                  tc.stride = d2 < 6400 ? 1 : d2 < 40000 ? 2 : 4
                }
              }
            }
            for (let i = 0; i < steps; i++) {
              substepTick++
              const subInp: DriveInput =
                i === 0
                  ? inp
                  : {
                      ...inp,
                      upshiftPressed: false,
                      downshiftPressed: false,
                      toggleModePressed: false,
                      toggleLaunchPressed: false,
                      toggleParkPressed: false,
                      resetPressed: false,
                      toggleCameraPressed: false,
                      startPressed: false,
                      pausePressed: false,
                    }
              const postFinishFree =
                playerFinished && !raceFinished && playerDoneT > 4
              const playerInp =
                !playerFinished || postFinishFree ? subInp : holdInput()
              const preGreen = raceActive && !racing && !playerFinished
              let lockT: { x: number; y: number; z: number } | null = null
              let lockR: { x: number; y: number; z: number; w: number } | null =
                null
              let lockLv: { x: number; y: number; z: number } | null = null
              let lockAv: { x: number; y: number; z: number } | null = null
              if (preGreen) {
                lockT = body.translation()
                lockR = body.rotation()
                lockLv = body.linvel()
                lockAv = body.angvel()
              }
              t = car.update(FIXED_DT, playerInp)
              if (raceActive) {
                for (let ri = 0; ri < rivals.length; ri++) {
                  const rival = rivals[ri]
                  if ((substepTick + ri) % rival.stride !== 0) continue
                  let aiInp = rival.cached
                  if (rival.edgeArmed) {
                    rival.edgeArmed = false
                  } else {
                    aiInp = stripEdges(aiInp)
                  }
                  const rt = rival.car.update(FIXED_DT, aiInp)
                  rival.brake = Math.max(rt.brake, rt.parkingBrake ? 1 : 0)
                }
              }
              for (let ti = 0; ti < trafficCars.length; ti++) {
                const tc = trafficCars[ti]
                if ((substepTick + ti) % tc.stride !== 0) continue
                let taiInp = tc.cached
                if (tc.edgeArmed) {
                  tc.edgeArmed = false
                } else {
                  taiInp = stripEdges(taiInp)
                }
                const tt = tc.car.update(FIXED_DT, taiInp)
                tc.brake = Math.max(tt.brake, tt.parkingBrake ? 1 : 0)
              }
              if (net && net.roomId) net.driveRemoteBodies(FIXED_DT)
              world.step()
              if (preGreen && lockT && lockR && lockLv && lockAv) {
                body.setTranslation(lockT, true)
                body.setRotation(lockR, true)
                body.setLinvel(lockLv, true)
                body.setAngvel(lockAv, true)
              }
              consumeSubstep(stepper)
            }
            if (stepper.droppedTotal > 0) {
              ;(window as any).__physicsDroppedTotal = stepper.droppedTotal
            }
          }

          const bp = body.translation()
          const carPos = new THREE.Vector3(bp.x, bp.y, bp.z)
          moveGroundBody(groundBody, bp.x, bp.z)
          {
            const bray = new R.Ray(
              { x: bp.x, y: bp.y, z: bp.z },
              { x: 0, y: -1, z: 0 },
            )
            const bhit = world.castRay(
              bray as any,
              2.0,
              true,
              undefined,
              undefined,
              undefined,
              body as any,
            )
            const inside =
              !!bhit &&
              (bhit as unknown as { timeOfImpact: number }).timeOfImpact < 0.05
            if (inside) {
              buriedFrames++
            } else {
              buriedFrames = 0
            }
            if (buriedFrames >= 3) {
              const lv = body.linvel()
              body.setTranslation({ x: bp.x, y: bp.y + 0.8, z: bp.z }, true)
              body.setLinvel({ x: lv.x, y: Math.max(lv.y, 0), z: lv.z }, true)
            }
          }
          visual.syncFromBody(
            body,
            car.steerAngle,
            car.getWheelOmegas(),
            dt,
            car.getWheelCompressions(),
          )
          visual.setBrake(Math.max(t?.brake ?? 0, t?.parkingBrake ? 1 : 0))
          if (net && net.roomId) {
            playerProgress = carProgress(body)
            if (t) net.broadcastLocalState(car, t, playerProgress)
            net.updateRemoteCars(dt, smoke)
          }
          if (raceActive) {
            playerProgress = carProgress(body)
            if (!playerFinished && playerProgress >= raceDistance) {
              playerFinished = true
              playerFinishTime = raceElapsed
              net?.notifyFinish(playerFinishTime)
            }
            if (playerFinished && !raceFinished) {
              playerDoneT += dt
              if (playerDoneT > 45) {
                for (const r of rivals) {
                  if (!r.finished) {
                    r.finished = true
                    r.finishTime = null
                  }
                }
              }
            }
            for (const rival of rivals) {
              const rp = rival.car.body.translation()
              rival.progress = carProgress(rival.car.body)
              if (!rival.finished && rival.progress >= raceDistance) {
                rival.finished = true
                rival.finishTime = raceElapsed
              }
              const rsp = rival.car.forwardSpeed
              const greenNow = headsUp <= 0 && countdown <= 0
              if (greenNow && !rival.finished && Math.abs(rsp) < 1.0) {
                rival.stuckT += dt
              } else {
                rival.stuckT = Math.max(0, rival.stuckT - dt * 3)
              }
              if (rp.y < -3 || rival.stuckT > 8) {
                rival.stuckT = 0
                const rs = -rp.z
                rival.car.reset(
                  new THREE.Vector3(roadCenterX(rs), 0.72, rp.z),
                  roadDirYaw(rs),
                )
              }
              rival.visual.syncFromBody(
                rival.car.body,
                rival.car.steerAngle,
                rival.car.getWheelOmegas(),
                dt,
                rival.car.getWheelCompressions(),
              )
              rival.visual.setBrake(rival.brake)
            }
            if (!raceFinished) {
              const netOrders = Array.from(net?.remoteCars.values() ?? []).map(
                (rc) => ({
                  ai: -2,
                  finished: rc.finished,
                  time: rc.finishTime,
                  progress: rc.progress,
                }),
              )
              const order = [
                {
                  ai: -1,
                  finished: playerFinished,
                  time: playerFinishTime,
                  progress: playerProgress,
                },
                ...netOrders,
                ...rivals.map((r, i) => ({
                  ai: i,
                  finished: r.finished,
                  time: r.finishTime,
                  progress: r.progress,
                })),
              ].sort((a, b) => {
                if (a.finished !== b.finished) return a.finished ? -1 : 1
                if (a.finished && b.finished)
                  return (a.time ?? Infinity) - (b.time ?? Infinity)
                return b.progress - a.progress
              })
              if (order.every((p) => p.finished)) {
                raceFinished = true
                prevOrderRef.current = order.map((o) => o.ai)
                if (net && net.roomId && net.localReady) {
                  net.setLocalReady(false)
                }
              }
            }
            shadowAcc += dt
            if (shadowAcc > 0.5) {
              shadowAcc = 0
              const ranked = rivals
                .map((r, i) => {
                  const rp = r.car.body.translation()
                  const dx = rp.x - bp.x
                  const dz = rp.z - bp.z
                  return { i, d: dx * dx + dz * dz }
                })
                .sort((a, b) => a.d - b.d)
              const nearSet = new Set(ranked.slice(0, 3).map((o) => o.i))
              rivals.forEach((r, i) => r.visual.setCastShadow(nearSet.has(i)))
              let upgrades = 0
              for (const { i, d } of ranked) {
                const r = rivals[i]
                if (r.hi && d > DETAIL_FAR * DETAIL_FAR) {
                  r.hi = false
                  r.visual.setDetail(false)
                } else if (
                  !r.hi &&
                  d < DETAIL_NEAR * DETAIL_NEAR &&
                  upgrades < 2
                ) {
                  upgrades++
                  r.hi = true
                  r.visual.setDetail(true)
                }
              }
            }
            raceUiAcc += dt
            if (
              raceUiAcc > 0.05 ||
              raceFinished ||
              headsUp > 0 ||
              countdown > 0
            ) {
              raceUiAcc = 0
              const netStandings: RaceStanding[] = Array.from(
                net?.remoteCars.values() ?? [],
              ).map((rc) => ({
                id: rc.id,
                name: rc.name,
                color: colorHex(rc.color),
                isPlayer: false,
                progressM: rc.progress,
                finished: rc.finished,
                finishTime: rc.finishTime,
              }))
              const standings: RaceStanding[] = [
                {
                  id: "you",
                  name: net?.roomId ? net.localName : "You",
                  color: colorHex(
                    net?.roomId ? net.localColor : DEFAULT_PLAYER_COLOR,
                  ),
                  isPlayer: true,
                  progressM: playerProgress,
                  finished: playerFinished,
                  finishTime: playerFinishTime,
                },
                ...netStandings,
                ...rivals.map((r, i) => ({
                  id: `ai-${i}`,
                  name: r.name,
                  color: r.color,
                  isPlayer: false,
                  progressM: r.progress,
                  finished: r.finished,
                  finishTime: r.finishTime,
                })),
              ].sort((a, b) => {
                if (a.finished !== b.finished) return a.finished ? -1 : 1
                if (a.finished && b.finished)
                  return (a.finishTime ?? Infinity) - (b.finishTime ?? Infinity)
                return b.progressM - a.progressM
              })
              const playerPlace = standings.findIndex((s) => s.isPlayer) + 1
              setRace({
                active: true,
                finished: raceFinished,
                distanceM: raceDistance,
                elapsed: raceElapsed,
                playerPlace,
                total: gridCount,
                standings,
                countdown: Math.ceil(countdown),
                phase: headsUp > 0 ? "heads" : countdown > 0 ? "count" : "go",
                readyIn: headsUp,
                staged,
                waitingFor: staged && net ? net.waitingForNames() : [],
              })
            }
          }
          if (trafficCars.length > 0) {
            const playerS = -bp.z
            for (const tc of trafficCars) {
              const tp = tc.car.body.translation()
              const tS = -tp.z
              const tdir = tc.ai.profile.dir ?? 1
              const trsp = tc.car.forwardSpeed
              if (Math.abs(trsp) < 1.0) tc.stuckT += dt
              else tc.stuckT = Math.max(0, tc.stuckT - dt * 3)
              if (
                tp.y < -3 ||
                tc.stuckT > 12 ||
                tS < playerS - TRAFFIC_BEHIND ||
                tS > playerS + TRAFFIC_AHEAD
              ) {
                tc.stuckT = 0
                let aheadS = playerS + 900
                const myHalf = tdir
                for (let a2 = 0; a2 < 8; a2++) {
                  const cand =
                    tdir === 1
                      ? playerS + 900 + Math.random() * 400
                      : playerS + 500 + Math.random() * 400
                  aheadS = cand
                  const clear = trafficCars.every((o) => {
                    if (o === tc) return true
                    const op = o.car.body.translation()
                    const os = -op.z
                    if ((o.ai.profile.dir ?? 1) !== myHalf) return true
                    return Math.abs(os - cand) >= 35
                  })
                  if (clear) break
                }
                const ntprof = makeTrafficProfile(Math.random, tdir)
                const nyaw = roadDirYaw(aheadS) + (tdir === 1 ? 0 : Math.PI)
                const nnx = Math.cos(roadYaw(aheadS))
                const nnz = Math.sin(roadYaw(aheadS))
                tc.car.reset(
                  new THREE.Vector3(
                    roadCenterX(aheadS) + nnx * ntprof.laneBias,
                    0.72,
                    -aheadS + nnz * ntprof.laneBias,
                  ),
                  nyaw,
                )
                const nv0 =
                  ((ntprof.cruiseKmh ?? 100) / 3.6) *
                  (0.9 + Math.random() * 0.15)
                const nslope =
                  (roadCenterX(aheadS + 4) - roadCenterX(aheadS - 4)) / 8
                const ninv = 1 / Math.hypot(nslope, 1)
                tc.car.body.setLinvel(
                  {
                    x: nslope * ninv * nv0 * tdir,
                    y: 0,
                    z: -ninv * nv0 * tdir,
                  },
                  true,
                )
                tc.ai = new AIDriver(ntprof)
              }
              tc.visual.syncFromBody(
                tc.car.body,
                tc.car.steerAngle,
                tc.car.getWheelOmegas(),
                dt,
                tc.car.getWheelCompressions(),
              )
              tc.visual.setBrake(tc.brake)
            }
            trafficShadowAcc += dt
            if (trafficShadowAcc > 0.5) {
              trafficShadowAcc = 0
              const tranked = trafficCars
                .map((r, i) => {
                  const rp = r.car.body.translation()
                  const dx = rp.x - bp.x
                  const dz = rp.z - bp.z
                  return { i, d: dx * dx + dz * dz }
                })
                .sort((a, b) => a.d - b.d)
              const tnear = new Set(tranked.slice(0, 3).map((o) => o.i))
              trafficCars.forEach((r, i) =>
                r.visual.setCastShadow(tnear.has(i)),
              )
            }
          }
          wm.update(-bp.z, carPos, grassTargetFor(car.forwardSpeed, raceActive))
          const kmhNow = Math.abs(car.forwardSpeed) * 3.6
          if (raceActive && kmhNow > 210) wm.setPropShadows(false)
          else if (!raceActive || kmhNow < 190) wm.setPropShadows(true)

          if (startedRef.current) {
            const intensity = Math.max(
              car.slipRatioAvg,
              car.drifting ? 0.55 : 0,
              car.launching ? 0.7 : 0,
            )
            if (intensity > 0.28) {
              visual.wheelContactPositions(car.drifting, smokeSpots)
              if (smokeSpots.length === 0) {
                smokeAcc = 0
              } else {
                smokeAcc += dt * intensity * 90
                while (smokeAcc >= 1) {
                  smokeAcc -= 1
                  smoke.spawn(
                    smokeSpots[(Math.random() * smokeSpots.length) | 0],
                    Math.min(1, intensity),
                  )
                }
              }
            }
          }
          smoke.update(dt)

          const nowS = now / 1000
          const bq = body.rotation()
          const quat = new THREE.Quaternion(bq.x, bq.y, bq.z, bq.w)
          const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(quat)
          smoothFwd.lerp(fwd, 1 - Math.exp(-dt * 10)).normalize()
          if (!startedRef.current) {
            e0.lastMovementX = 0
            e0.lastMovementY = 0
            const orbitA = nowS * 0.28
            const sr = 7.4
            showDesired.set(
              carPos.x + Math.sin(orbitA) * sr,
              carPos.y + 2.1,
              carPos.z + Math.cos(orbitA) * sr,
            )
            camPos.lerp(showDesired, 1 - Math.exp(-dt * 2.5))
            camera.position.copy(camPos)
            camLook.copy(carPos)
            camLook.y += 0.55 + playerDef.physics.dimensions.height * 0.12
            if (
              window.innerWidth >= 768 &&
              !showIntroRef.current &&
              !showLobbyRef.current &&
              !loadingRef.current
            ) {
              const dx = carPos.x - camPos.x
              const dz = carPos.z - camPos.z
              const plan = Math.hypot(dx, dz) || sr
              const hfovHalf = Math.atan(
                Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) *
                  camera.aspect,
              )
              const shift =
                ((2 * 200) / window.innerWidth) * plan * Math.tan(hfovHalf)
              camLook.x += (-dz / plan) * shift
              camLook.z += (dx / plan) * shift
            }
            camera.lookAt(camLook)
            if (Math.abs(camera.fov - 58) > 0.05) {
              camera.fov += (58 - camera.fov) * Math.min(1, dt * 2)
              camera.updateProjectionMatrix()
            }
            setSpeedLines(0)
          } else {
            {
              const MAXD = 120
              const mx = Math.max(-MAXD, Math.min(MAXD, e0.lastMovementX))
              const my = Math.max(-MAXD, Math.min(MAXD, e0.lastMovementY))
              if (mx !== 0 || my !== 0) {
                camYaw -= mx * 0.0022
                camPitch = Math.max(-0.5, Math.min(0.5, camPitch + my * 0.0022))
                lastOrbit = nowS
              }
            }
            e0.lastMovementX = 0
            e0.lastMovementY = 0
            const rolling = Math.abs(car.forwardSpeed) > 1.0
            if (!orbiting && rolling && nowS - lastOrbit > 2.5) {
              const ck = 1 - Math.exp(-dt * 2.2)
              camYaw +=
                (Math.round(camYaw / (Math.PI * 2)) * Math.PI * 2 - camYaw) * ck
              if (Math.abs(camYaw) < 0.002) camYaw = 0
              camPitch += (0 - camPitch) * ck
              if (Math.abs(camPitch) < 0.002) camPitch = 0
            }
            const orbitQ = new THREE.Quaternion().setFromAxisAngle(
              new THREE.Vector3(0, 1, 0),
              camYaw,
            )
            const viewDir = smoothFwd.clone().applyQuaternion(orbitQ)
            viewDir.y = 0
            viewDir.normalize()
            const dist = chaseFar ? 6.4 : 5.2
            const height =
              (chaseFar ? 1.08 : 0.92) + camPitch * 5 + camHeightBoost
            const desired = carPos
              .clone()
              .addScaledVector(viewDir, -dist)
              .add(new THREE.Vector3(0, height, 0))
            desired.y = Math.max(desired.y, carPos.y - 0.9, 0.3)
            if (raceActive && headsUp > 0) {
              desired
                .copy(carPos)
                .addScaledVector(smoothFwd, 13)
                .add(new THREE.Vector3(7.5, 4.2, 0))
              camLook
                .copy(carPos)
                .addScaledVector(smoothFwd, -9)
                .add(new THREE.Vector3(0, 1.2, 0))
              camera.position.copy(desired)
              camera.lookAt(camLook)
            } else {
              camPos.copy(desired)

              const SF = CAR_PHYSICS.assists.speedFeel
              const vAbs = Math.abs(car.forwardSpeed) * 3.6
              const sfFov = Math.min(1, vAbs / SF.fovAtMaxSpeedKmh)
              const offAxis = clamp(Math.abs(camYaw) / (Math.PI / 2), 0, 1)
              const fovCeil =
                SF.fovBase + (SF.fovMax - SF.fovBase) * (1 - offAxis * 0.55)
              const targetFov = SF.fovBase + (fovCeil - SF.fovBase) * sfFov
              if (Math.abs(camera.fov - targetFov) > 0.02) {
                camera.fov += (targetFov - camera.fov) * Math.min(1, dt * 3.5)
                camera.updateProjectionMatrix()
              }
              setSpeedLines(
                Math.min(
                  1,
                  Math.max(
                    0,
                    (vAbs - SF.linesFromKmh) /
                      (SF.fovAtMaxSpeedKmh - SF.linesFromKmh),
                  ),
                ),
              )

              camLook.copy(carPos)
              camera.position.copy(camPos)
              camera.lookAt(camLook)

              const sfShake = Math.min(
                1,
                Math.max(
                  0,
                  (vAbs - SF.shakeFromKmh) /
                    (SF.fovAtMaxSpeedKmh - SF.shakeFromKmh),
                ),
              )
              if (sfShake > 0.001) {
                const t2 = nowS * 34
                camera.rotation.z += Math.sin(t2 * 1.7) * SF.shakeAmp * sfShake
                camera.position.x += Math.sin(t2 * 2.3) * 0.014 * sfShake
                camera.position.y += Math.sin(t2 * 3.1) * 0.012 * sfShake
              }
            }
          }

          renderer!.render(scene, camera)

          if (t && now - teleRef.last > 50) {
            teleRef.last = now
            setTele({ ...t })
          }
        }
        raf = requestAnimationFrame(loop)
        ;(mount as any)._cleanup = () => {
          garageApiRef.current = null
          window.removeEventListener("resize", onResize)
          window.removeEventListener("blur", onWinBlur)
          dom.removeEventListener("pointerdown", onPointerDown)
          dom.removeEventListener("pointermove", onPointerMove)
          dom.removeEventListener("pointerup", onPointerUp)
          dom.removeEventListener("pointercancel", onPointerUp)
          document.removeEventListener("pointermove", onForceHide)
          document.removeEventListener("pointerlockerror", onForceHide)
          document.removeEventListener("pointerlockchange", onLockChange)
          input.detach()
          if (lockRetry) window.clearTimeout(lockRetry)
          window.clearInterval(lockGuard)
          document.removeEventListener("pointermove", onForceHide)
          document.removeEventListener("pointerdown", onGesture)
          document.removeEventListener("keydown", onGesture)
          document.removeEventListener("pointerlockerror", onForceHide)
          if (net) {
            try {
              net.remoteCars.forEach((rc) => {
                try {
                  rc.dispose(scene, world)
                } catch (e) {
                  console.warn("[Teardown] Remote dispose failed:", e)
                }
              })
            } finally {
              net.remoteCars.clear()
              net.detachScene()
            }
          }
          try {
            world.free()
          } catch (e) {
            console.warn("[Teardown] world.free failed:", e)
          }
        }
      } catch (e: any) {
        console.error(e)
        if (!disposed) {
          setError(e?.message ?? String(e))
          setLoading(false)
          document.documentElement.style.cursor = ""
          document.body.style.cursor = ""
          if (document.pointerLockElement) document.exitPointerLock?.()
        }
      }
    })()

    return () => {
      disposed = true
      cancelAnimationFrame(raf)
      const mount: any = mountRef.current
      mount?._cleanup?.()
      if (renderer) {
        renderer.dispose()
        renderer.domElement.remove()
      }
    }
  }, [session])

  const menuOn =
    !loading && !error && !started && !showMultiplayerLobby && !showIntro
  const pauseOn = !loading && !error && started && paused && !race.finished
  const introOn = showIntro && !started
  const resultsOn = !loading && !error && started && race.finished
  const dashOn = !loading && !error && started && !race.finished
  const hudOn = !loading && !error && started && !paused && !race.finished
  const badgeOn = netConnected && started && !race.finished
  const menuVisible = usePresence(menuOn, 300)
  const pauseVisible = usePresence(pauseOn, 240)
  const introVisible = usePresence(introOn, 480)
  const loadingVisible = usePresence(loading, 320)
  const lobbyVisible = usePresence(showMultiplayerLobby, 300)
  const resultsVisible = usePresence(resultsOn, 340)
  const dashVisible = usePresence(dashOn, 260)
  const hudVisible = usePresence(hudOn, 260)
  const badgeVisible = usePresence(badgeOn, 220)
  const finishedRaceRef = useRef<RaceSnapshot>(emptyRace)
  useEffect(() => {
    if (race.finished) finishedRaceRef.current = race
  }, [race])

  return (
    <div
      className={`relative w-screen h-screen overflow-hidden bg-black ${started && !paused && !race.finished ? "cursor-none" : ""}`}
    >
      <div ref={mountRef} className="absolute inset-0" />
      {}
      <SpeedLines ref={speedLinesRef} />
      {showNetDiag && <NetDiagPanel />}
      {dashVisible && (
        <Screen
          open={dashOn}
          className="pointer-events-none absolute inset-0"
          from={{ autoAlpha: 0 }}
          to={{ duration: 0.6, delay: 0.12 }}
          exit={{ duration: 0.26, ease: EASE.in }}
        >
          <Dashboard tele={tele} />
        </Screen>
      )}
      {hudVisible && (
        <Screen
          open={hudOn}
          className="pointer-events-none absolute inset-0"
          from={{ autoAlpha: 0 }}
          to={{ duration: 0.35, delay: 0.25 }}
          exit={{ duration: 0.24, ease: EASE.in }}
        >
          <RaceHud race={race} />
        </Screen>
      )}
      {hudVisible && (
        <Screen
          open={hudOn}
          className="pointer-events-none absolute inset-0"
          from={{ autoAlpha: 0 }}
          to={{ duration: 0.4, delay: 0.35 }}
          exit={{ duration: 0.24, ease: EASE.in }}
        >
          <RaceLiveBoard race={race} />
        </Screen>
      )}
      {hudVisible &&
        !loading &&
        !error &&
        started &&
        !paused &&
        !race.finished &&
        lockHint && (
          <Screen open from={{ autoAlpha: 0 }} to={{ duration: 0.3 }}>
            <div className="pointer-events-none absolute bottom-32 left-1/2 -translate-x-1/2 rounded-full border border-white/15 bg-black/70 px-5 py-2 text-[12px] tracking-wide text-gray-200 backdrop-blur">
              Click anywhere to get the mouse back
            </div>
          </Screen>
        )}
      {badgeVisible && (
        <Screen
          open={badgeOn}
          from={{ autoAlpha: 0 }}
          to={{ duration: 0.4 }}
          exit={{ duration: 0.2, ease: EASE.in }}
        >
          <MultiplayerHudBadge
            playerCount={netPeers.length + 1}
            pingMs={netPeers[0]?.pingMs ?? 0}
            onLeave={handleLeaveRoom}
          />
        </Screen>
      )}
      {menuVisible && (
        <RaceMenu
          open={menuOn}
          rivals={rivals}
          distanceKm={distanceKm}
          onRivals={setRivals}
          onDistance={setDistanceKm}
          cars={CARS}
          carId={carId}
          onPrevCar={() => stepCar(-1)}
          onNextCar={() => stepCar(1)}
          paint={paintFor(carId) ?? null}
          onPaint={(color) => setPaintFor(carId, color)}
          pool={pool}
          onTogglePool={togglePool}
          traffic={trafficLevel}
          onTraffic={selectTraffic}
          onFreeDrive={startGame}
          onStartRace={startRace}
          onOpenMultiplayer={() => setShowMultiplayerLobby(true)}
        />
      )}
      {lobbyVisible && (
        <MultiplayerLobby
          open={showMultiplayerLobby}
          playerName={driverName}
          carColor={driverColor}
          roomId={netRoomId}
          isConnected={netConnected}
          peers={netPeers}
          onUpdateProfile={(name, col) => {
            setDriverName(name)
            setDriverColor(col)
            try {
              localStorage.setItem("oversteer_name", name)
            } catch {}
            if (multiplayerRef.current) {
              multiplayerRef.current.localName = name
              multiplayerRef.current.localColor = col
              multiplayerRef.current.announceIdentitySoon()
            }
          }}
          onJoinRoom={(target, mode, password) => {
            setJoinError(null)
            setNetRoomId(target)
            const ok =
              multiplayerRef.current?.join(
                target,
                mode,
                driverName,
                driverColor,
                password,
              ) ?? false
            setNetConnected(ok)
          }}
          onLeaveRoom={handleLeaveRoom}
          onStartMultiplayerRace={handleStartMultiplayerRace}
          onStartFreeDrive={handleStartFreeDrive}
          traffic={trafficLevel}
          onTraffic={selectTraffic}
          joinError={joinError}
          onBack={() => {
            setJoinError(null)
            setShowMultiplayerLobby(false)
          }}
        />
      )}
      {resultsVisible && (
        <RaceResults
          open={resultsOn}
          race={finishedRaceRef.current}
          onAgain={raceAgain}
          onMenu={quitToMenu}
          readyNotice={(() => {
            if (!multiplayerRef.current?.roomId) return null
            const ready = netPeers.filter((p) => p.ready).map((p) => p.name)
            if (ready.length === 0) return null
            return ready.length === 1
              ? `${ready[0]} is ready. Hit Race again to join them!`
              : `${ready.join(", ")} are ready. Hit Race again to join them!`
          })()}
        />
      )}
      {pauseVisible && (
        <Screen
          open={pauseOn}
          className="absolute inset-0 overflow-y-auto bg-black/55 backdrop-blur-[2px]"
          from={{ autoAlpha: 0 }}
          to={{ duration: 0.3, ease: EASE.out }}
          exit={{ duration: 0.2, ease: EASE.in }}
          stagger={[
            { selector: "[data-pause-head]", from: { autoAlpha: 0 } },
            { selector: "[data-pause-acts]", from: { autoAlpha: 0 } },
            {
              selector: "[data-pause-row]",
              from: { autoAlpha: 0 },
              each: 0.035,
              delay: 0.1,
            },
          ]}
        >
          <div className="flex min-h-full flex-col p-5 md:p-8">
            <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-4">
              <div data-pause-head>
                <div
                  className="mb-2 h-2.5 w-20"
                  style={{
                    backgroundImage:
                      "repeating-conic-gradient(#51a7d5 0% 25%, #0b0e14 0% 50%)",
                    backgroundSize: "12px 12px",
                  }}
                />
                <span className="text-[64px] font-bold leading-[0.9] tracking-tight text-white drop-shadow-[0_8px_30px_rgba(0,0,0,0.6)] md:text-[96px]">
                  Paused
                </span>
                <p className="mt-2 text-[13px] tracking-wide text-gray-300">
                  {netConnected
                    ? `${getCar(carId).name} · Online · ${netPeers.length + 1} player${netPeers.length === 0 ? "" : "s"}`
                    : race.active
                      ? `${getCar(carId).name} · Race · ${race.total} cars · ${(race.distanceM / 1000).toFixed(1)} km`
                      : `${getCar(carId).name} · Free Roam · ${TRAFFIC_OPTIONS.find((o) => o.id === trafficLevel)?.label} traffic`}
                </p>
              </div>
              <div
                data-pause-acts
                className="flex w-full flex-col gap-2 sm:w-[280px]"
              >
                <button
                  onClick={resumeGame}
                  className="w-full bg-[#51a7d5] px-6 py-3 text-[14px] font-semibold text-white transition hover:bg-[#51a7d5]/90 active:scale-[0.98] inline-flex items-center justify-center gap-2"
                >
                  Keep driving
                  <Play size={16} />
                </button>
                <button
                  onClick={() => {
                    resetRef.current = true
                    resumeGame()
                  }}
                  className="w-full border border-[#51a7d5] bg-[#51a7d5]/15 px-6 py-3 text-[14px] font-semibold text-[#6ec2f0] transition hover:bg-[#51a7d5]/25 active:scale-[0.98] inline-flex items-center justify-center gap-2"
                >
                  <RotateCcw size={16} />
                  Put me back on the road
                </button>
                <button
                  onClick={quitToMenu}
                  className="w-full border border-white/12 bg-white/5 px-6 py-3 text-[14px] font-medium text-gray-100 transition hover:bg-white/10 active:scale-[0.98] inline-flex items-center justify-center gap-2"
                >
                  <LogOut size={16} />
                  Back to the start
                </button>
              </div>
            </div>

            {}
            <div className="no-scrollbar mt-auto border-t border-white/10 max-w-[300px]">
              {(
                [
                  ["P", "Pause"],
                  ["L", "Launch control"],
                  ["E", "Shift up"],
                  ["Q", "Shift down"],
                  ["M", "Transmission mode"],
                  ["O", "Parking brake"],
                  ["R", "Reset car"],
                  ["C", "Camera view"],
                ] as const
              ).map(([key, label]) => (
                <div
                  key={key}
                  data-pause-row
                  className="grid h-10 grid-cols-[44px_1fr] items-center border-b border-white/5 bg-black/30"
                >
                  <div
                    className={`grid h-full place-items-center border-r border-white/5 text-[13px] font-bold ${
                      key === "P"
                        ? "bg-[#51a7d5] text-[#0b0e14]"
                        : "bg-white/[0.04] text-gray-400"
                    }`}
                  >
                    {key}
                  </div>
                  <span className="px-3 text-[14px] text-gray-200">
                    {label}
                  </span>
                </div>
              ))}
              <div
                data-pause-row
                className="py-2 text-center text-[12px] text-gray-500"
              >
                press P to keep driving
              </div>
            </div>
          </div>
        </Screen>
      )}
      {loadingVisible && (
        <Screen
          open={loading}
          className="absolute inset-0 flex items-center justify-center bg-[#0b0e14] text-white"
          from={{ autoAlpha: 0 }}
          stagger={[{ selector: "[data-load]", from: { autoAlpha: 0, y: 16 } }]}
        >
          <div className="text-center">
            <div className="text-[11px] font-semibold tracking-[0.4em] text-[#8f99a8]">
              PADDOCK
            </div>
            <div data-load className="mt-2 text-2xl font-bold">
              Getting your {getCar(carId).name} ready
            </div>
            <div data-load className="mt-1 text-sm text-gray-400">
              Warming up physics and loading the world
            </div>
          </div>
        </Screen>
      )}
      {error && (
        <Screen
          open
          className="absolute inset-0 flex items-center justify-center text-white p-6 cursor-auto [&_*]:cursor-auto"
          style={{ cursor: "auto" }}
          from={{ autoAlpha: 0 }}
        >
          <div className="max-w-lg rounded-2xl bg-red-950/80 border border-red-500/40 p-5">
            <div className="font-bold text-lg mb-2">Something went wrong</div>
            <div className="text-sm whitespace-pre-wrap">{error}</div>
            <div className="text-xs mt-3 text-gray-300">
              If models 404, make sure <b>src/mainview/models/bmw_m3.glb</b> and{" "}
              <b>tree_pack.glb</b> are served (copied to the Vite public dir or
              imported as assets).
            </div>
            <button
              onClick={() => window.location.reload()}
              className="mt-4 w-full rounded-2xl bg-[#e30613] px-6 py-2.5 text-sm font-semibold text-white transition hover:bg-[#f01422] active:scale-[0.98]"
            >
              Reload world
            </button>
          </div>
        </Screen>
      )}
      {introVisible && (
        <Screen
          open={introOn}
          className="absolute inset-0 z-[70] bg-[#0b0e14]/30 p-6 md:p-10 w-full"
          from={{ autoAlpha: 0 }}
          to={{ duration: 0.5 }}
          exit={{ duration: 0.45, ease: EASE.in }}
          stagger={[
            { selector: "[data-intro-chip]", from: { autoAlpha: 0 } },
            {
              selector: "[data-intro-title]",
              from: { autoAlpha: 0 },
              to: { duration: 0.8, ease: EASE.soft },
            },
            { selector: "[data-intro-sub]", from: { autoAlpha: 0 } },
            {
              selector: "[data-intro-cta]",
              from: { autoAlpha: 0 },
              each: 0.08,
              delay: 0.2,
            },
          ]}
          onClick={() => setShowIntro(false)}
        >
          <div className="flex h-full flex-col justify-between w-full">
            <div className="flex flex-1 items-center justify-center">
              <div className="w-full">
                <div
                  data-intro-chip
                  className="mb-4 h-3 w-24"
                  style={{
                    backgroundImage:
                      "repeating-conic-gradient(#f5f5f5 0% 25%, #e30613 0% 50%)",
                    backgroundSize: "14px 14px",
                  }}
                />
                <h1
                  data-intro-title
                  className="text-[80px] font-bold leading-[0.85] tracking-tight text-white md:text-[140px]"
                >
                  OverSteer
                </h1>
                <p
                  data-intro-sub
                  className="mt-4 max-w-[480px] text-[15px] text-gray-400"
                >
                  Pick your car, race rivals, and roam two-way roads.
                </p>
              </div>
            </div>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <button
                data-intro-cta
                onClick={() => setShowIntro(false)}
                className="bg-[#51a7d5] px-8 py-3.5 text-[15px] font-semibold text-white transition-colors hover:bg-[#51a7d5]/90"
              >
                Enter the garage
              </button>
              <div data-intro-cta className="text-[12px] text-gray-500">
                press any key or click anywhere to continue
              </div>
            </div>
          </div>
        </Screen>
      )}
      <Wipe
        token={wipe?.token ?? 0}
        label={wipe?.label ?? ""}
        tone={wipe?.red ? "red" : "blue"}
      />
    </div>
  )
}
