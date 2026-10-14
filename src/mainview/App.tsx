import { useEffect, useRef, useState } from "react"
import * as THREE from "three"
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
import { CarController, type CarTelemetry } from "./systems/CarController"
import { WorldManager, roadCenterX, roadDirYaw, roadYaw } from "./systems/WorldManager"
import { CarVisual } from "./systems/CarVisual"
import { TireSmoke } from "./systems/TireSmoke"
import { InputManager, type DriveInput } from "./systems/InputManager"
import { AIDriver, carProgress, holdInput, makeProfile, stripEdges, type TrafficEntry } from "./systems/AIDriver"
import { colorHex, rivalColor } from "./systems/carTint"
import {
  RACE_COUNTS,
  RACE_DISTANCES_KM,
  emptyRace,
  type RaceSetup,
  type RaceSnapshot,
  type RaceStanding,
} from "./systems/RaceTypes"
import Dashboard from "./ui/Dashboard"
import { RaceHud, RaceLiveBoard, RaceMenu, RaceResults } from "./ui/RaceOverlay"
import { SpeedLines } from "./ui/SpeedLines"
import { MultiplayerManager } from "./systems/net/MultiplayerManager"
import { MultiplayerLobby, MultiplayerHudBadge } from "./ui/MultiplayerLobby"
import type { PeerPlayer } from "./systems/net/types"
import { CAR_PHYSICS } from "./constants/physics"
import { WORLD_CONFIG } from "./constants/world"

const clamp = (v: number, lo: number, hi: number) =>
  Math.max(lo, Math.min(hi, v))

// Race-only grass thinning: at 270+ the verges are a blur, so draw a
// fraction of the grass and spend the vertex budget on the road. Free
// drive keeps full scenery. Set per frame; WorldManager eases toward it.
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
  // Previous finishing order (ai index, -1 = player). Seeds next grid.
  const prevOrderRef = useRef<number[] | null>(null)
  const [race, setRace] = useState<RaceSnapshot>(emptyRace)
  const [rivals, setRivals] = useState<(typeof RACE_COUNTS)[number]>(3)
  const [distanceKm, setDistanceKm] =
    useState<(typeof RACE_DISTANCES_KM)[number]>(5)
  const [session, setSession] = useState(0)

  const [showMultiplayerLobby, setShowMultiplayerLobby] = useState(false)
  const [netPeers, setNetPeers] = useState<PeerPlayer[]>([])
  const [netConnected, setNetConnected] = useState(false)
  const [joinError, setJoinError] = useState<string | null>(null)
  const [netRoomId, setNetRoomId] = useState("paddock-1")
  const [driverName, setDriverName] = useState(
    () => localStorage.getItem("oversteer_name") || "Racer",
  )
  const [driverColor, setDriverColor] = useState<number>(0x1f6feb)
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
      onRaceStartSignal: (_startTimeMs, distanceM) => {
        const next = {
          rivals: 0,
          distanceM,
        }
        lastRaceRef.current = next
        raceSetupRef.current = next
        startedRef.current = true
        pausedRef.current = false
        setStarted(true)
        setPaused(false)
        setShowMultiplayerLobby(false)
        setRace(emptyRace)
        lockCanvas()
        setSession((n) => n + 1)
      },
    })
  }, [])

  const handleStartMultiplayerRace = (distKm: number) => {
    const distM = distKm * 1000
    multiplayerRef.current?.startMultiplayerRace(distM)
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
    const handleGlobalKey = (e: KeyboardEvent) => {
      if (
        (e.metaKey || e.ctrlKey) &&
        e.shiftKey &&
        (e.key === "N" || e.key === "n")
      ) {
        fetch("http://localhost:9876/open-window", { method: "POST" }).catch(
          () => {},
        )
      }
    }
    window.addEventListener("keydown", handleGlobalKey)
    return () => window.removeEventListener("keydown", handleGlobalKey)
  }, [])

  // Menus need a usable mouse: the moment the race is decided, drop
  // pointer lock and bring the cursor back so the results buttons work.
  useEffect(() => {
    if (race.finished) {
      document.documentElement.style.cursor = ""
      document.body.style.cursor = ""
      if (document.pointerLockElement) document.exitPointerLock?.()
    }
  }, [race.finished])

  const lockCanvas = () => {
    document.documentElement.style.cursor = "none"
    document.body.style.cursor = "none"
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
    lockCanvas()
    // Rebuild the world so a previous race grid is cleared.
    setSession((n) => n + 1)
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
    lockCanvas()
    // The grid is built inside the world effect — it only re-runs when
    // `session` changes, so starting a race must bump it. Without this
    // the race runs on the pre-built empty world and no rivals appear.
    setSession((n) => n + 1)
  }

  const pauseGame = () => {
    if (!startedRef.current || pausedRef.current) return
    pausedRef.current = true
    setPaused(true)
    inputRef.current?.clear()
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
    pausedRef.current = false
    startedRef.current = true
    setPaused(false)
    setRace(emptyRace)
    inputRef.current?.clear()
    document.documentElement.style.cursor = ""
    document.body.style.cursor = ""
    if (document.pointerLockElement) document.exitPointerLock?.()
    raceSetupRef.current = last
    setSession((n) => n + 1)
  }

  const quitToMenu = () => {
    pausedRef.current = false
    startedRef.current = false
    raceSetupRef.current = null
    setPaused(false)
    setStarted(false)
    setLockHint(false)
    setRace(emptyRace)
    inputRef.current?.clear()
    document.documentElement.style.cursor = ""
    document.body.style.cursor = ""
    if (document.pointerLockElement) document.exitPointerLock?.()
    // Rebuild a clean free-drive world behind the menu.
    setSession((n) => n + 1)
  }

  pauseFnRef.current = pauseGame
  resumeFnRef.current = resumeGame

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
        // Aborted while models loaded (StrictMode remount / HMR / session
        // switch): never attach this dead-end world — a late attach would
        // leave net peers owning bodies in a world that is about to leak,
        // and their teardown throws inside Rapier and blanks the window.
        if (disposed) {
          try {
            world.free()
          } catch {}
          return
        }
        const groundBody = wm.createPhysicsGround(R, world)

        const net = multiplayerRef.current
        if (net) {
          net.attachScene(scene, baseUrl, world, R)
        }

        const setup = raceSetupRef.current
        const rivalCount = setup?.rivals ?? 0
        const raceDistance = setup?.distanceM ?? 0
        const isNetRace = !!(net && net.roomId && raceDistance > 0)
        const netPeerCount = net?.peers.size ?? 0
        // Deterministic spawn order shared by every window in the room:
        // sorted ids give each peer a unique index with no host required.
        // Used for races AND free drive — without it all locals spawn at
        // the exact same spot and the physics solver launches one of them.
        const netIds =
          net && net.roomId
            ? [net.localId, ...Array.from(net.peers.keys())].sort()
            : null
        const netIndex =
          net && netIds ? Math.max(0, netIds.indexOf(net.localId)) : 0
        const netTotal = netIds ? netIds.length : 1
        const gridCount = 1 + rivalCount + (isNetRace ? netPeerCount : 0)
        const raceActiveInit = rivalCount > 0 || isNetRace
        // Big fields are GPU-bound (20 car models): drop render scale
        // rather than physics rate when the grid grows.
        const prCap = rivalCount > 8 ? 1.2 : 1.75
        renderer!.setPixelRatio(Math.min(window.devicePixelRatio, prCap))
        if (raceActiveInit) {
          // Chequered finish strip across the road at the race distance.
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
          const stripGeo = new THREE.PlaneGeometry(
            WORLD_CONFIG.road.width,
            3,
          )
          stripGeo.rotateX(-Math.PI / 2)
          const strip = new THREE.Mesh(
            stripGeo,
            new THREE.MeshBasicMaterial({ map: finishTex }),
          )
          strip.position.set(roadCenterX(raceDistance), 0.04, -raceDistance)
          strip.rotation.y = roadDirYaw(raceDistance)
          scene.add(strip)
        }
        // Grid slot -> row/lane. Slot 0 is front-left, rivals fill the rest
        // front-to-back, two per row; a lone last car is centred. Row 0 is
        // at s=0, each row back is 7.5 m behind.
        const gridSlot = (slot: number, total: number) => {
          const row = Math.floor(slot / 2)
          const loneLast = total % 2 === 1 && slot === total - 1
          const left = slot % 2 === 0
          return { s: -row * 7.5, lateral: loneLast ? 0 : left ? -2.15 : 2.15 }
        }
        // Grid order: first race is player on pole; after that, rivals
        // line up by the previous finishing order and the player draws a
        // random slot among them.
        const prev = prevOrderRef.current
        let playerSlotIdx = 0
        let aiSlotOf: (ai: number) => number = (ai) => ai + 1
        if (isNetRace && net) {
          playerSlotIdx = netIndex
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
        // Lateral offset basis stays on roadYaw: (cos, sin) of roadYaw is
        // perpendicular to the road direction, which roadDirYaw is not.
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
        const playerZ = spawned
          ? -playerSlot.s + nz0 * playerSlot.lateral
          : 0
        const startX = playerX
        const body = createChassisBody(world, playerX, 0.72, playerZ)
        const q0 = new THREE.Quaternion().setFromEuler(
          new THREE.Euler(0, yaw0, 0),
        )
        body.setRotation({ x: q0.x, y: q0.y, z: q0.z, w: q0.w }, true)
        const car = new CarController(world, body, R)

        interface Rival {
          car: CarController
          visual: CarVisual
          ai: AIDriver
          name: string
          color: string
          progress: number
          finished: boolean
          finishTime: number | null
          /** Seconds provably going nowhere (for last-resort teleport). */
          stuckT: number
          /** Input computed once per frame and reused across substeps. */
          cached: DriveInput
          /** Full physics every stride-th substep (1 = every substep). */
          stride: number
          /** One-shot edges in cached may be applied on the next tick only. */
          edgeArmed: boolean
          /** Currently showing the full model (false = imposter). */
          hi: boolean
        }
        const rivals: Rival[] = []
        for (let i = 0; i < rivalCount; i++) {
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
          )
          const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, yaw, 0))
          rb.setRotation({ x: q.x, y: q.y, z: q.z, w: q.w }, true)
          const rc = new CarController(world, rb, R)
          const color = rivalColor(i)
          const vis = new CarVisual()
          vis.castShadow = i < 2
          try {
            await vis.load(baseUrl, color)
          } catch (e) {
            console.warn("rival model failed", e)
          }
          scene.add(vis.group)
          rivals.push({
            car: rc,
            visual: vis,
            ai: new AIDriver(makeProfile(i)),
            name: `M3 ${i + 1}`,
            color: colorHex(color),
            progress: s0,
            finished: false,
            finishTime: null,
            stuckT: 0,
            cached: holdInput(),
            stride: 1,
            edgeArmed: false,
            hi: true,
          })
        }
        // Model loads above can outlive this setup (see wm.init guard).
        if (disposed) {
          try {
            world.free()
          } catch {}
          return
        }

        {
          const zeroInput = {
            throttle: 0, brake: 0, steer: 0, handbrake: false,
            upshiftPressed: false, downshiftPressed: false,
            toggleModePressed: false, toggleLaunchPressed: false,
            toggleParkPressed: false,
            resetPressed: false, toggleCameraPressed: false,
            startPressed: false, escapePressed: false,
          }
          const allCars = [car, ...rivals.map((r) => r.car)]
          for (let i = 0; i < 120; i++) {
            for (const c of allCars) c.update(FIXED_DT, zeroInput)
            world.step()
          }
        }

        // Every chassis in the fight — passed to the AI so it can see
        // (and hit) the cars around it instead of only the road.
        const allBodies = [body, ...rivals.map((r) => r.car.body)]

        const visual = new CarVisual()
        try {
          await visual.load(baseUrl, net?.roomId ? net.localColor : undefined)
        } catch (e) {
          console.warn("bmw model failed, continuing with fallback wheels", e)
        }
        if (disposed) {
          try {
            world.free()
          } catch {}
          return
        }
        scene.add(visual.group)

        let raceActive = rivalCount > 0 || isNetRace
        let raceFinished = false
        let raceElapsed = 0
        // Heads-up on the grid first (cars + banner visible), then the
        // 3-2-1 countdown, then green. Cars stay parked until green.
        let headsUp = raceActive ? 2.6 : 0
        let countdown = raceActive ? 3.0 : 0
        let playerFinished = false
        let playerFinishTime: number | null = null
        let playerProgress = 0
        let raceUiAcc = 0
        let shadowAcc = 0
        let playerDoneT = 0

        const smoke = new TireSmoke()
        scene.add(smoke.points)
        const smokeSpots: THREE.Vector3[] = []
        let smokeAcc = 0

        const input = new InputManager()
        input.attach()
        inputRef.current = input
        // Blur (clicking the other window) sends keyup there — without this
        // a held key sticks forever and the unfocused car drives itself.
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
        // Time spent inverted below terrain level — over 2 s means buried.
        let buriedTimer = 0
        // Consecutive frames the chassis centre ray starts inside solid.
        let buriedFrames = 0
        const stepper = createFixedStepper()
        let substepTick = 0
        let fpsFrames = 0
        let fpsLast = -1
        let frameMsAcc = 0
        let frameMsLast = -1
        // Dynamic resolution: float pixel ratio to hold frame budget.
        let dynPR = prCap
        let dynCooldown = 0
        const camPos = new THREE.Vector3(startX, 3, 8)
        const camLook = new THREE.Vector3()
        const smoothFwd = new THREE.Vector3(0, 0, -1)
        let lookAheadSm = 6

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
          if (!startedRef.current || lockWanted) return
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
        const onGesture = () => {
          if (startedRef.current && !document.pointerLockElement) tryLock()
        }
        document.addEventListener("pointermove", onForceHide)
        document.addEventListener("pointerdown", onGesture)
        document.addEventListener("keydown", onGesture)
        document.addEventListener("pointerlockerror", onForceHide)
        const onPointerDown = (e: PointerEvent) => {
          if (startedRef.current) hideCursor()
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
            camPitch = Math.max(-0.15, Math.min(0.5, camPitch + dy * 0.0032))
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
              // Multiplayer: losing the lock because the window blurred
              // (side-by-side testing, alt-tab) must NOT freeze the car — a
              // paused client stops broadcasting and becomes a concrete
              // pillar on everyone else's screen. Coast with cleared inputs
              // instead. Esc keeps focus, so it still pauses as usual.
              if (multiplayerRef.current?.roomId && !document.hasFocus()) {
                input.clear()
              } else {
                pauseFnRef.current()
              }
            }
          }
          // Shown whenever driving without the mouse (post-blur coast as
          // well as a denied lock request), not just after a lost lock.
          setLockHint(
            startedRef.current && !pausedRef.current && !mouseLocked,
          )
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
        // Pre-warm: compile every program in the finished scene (all cars
        // start full-detail) during load, so the first imposter→real swap
        // mid-race is just draw calls, never a compile hitch.
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
            const emaMs = frameMsAcc / Math.max(1, fpsFrames)
            // Dynamic resolution: spend pixels only while under budget.
            // Dips soften the image for a moment instead of dropping
            // frames; open road crisps back up. Cooldown avoids hunting.
            dynCooldown -= 1
            if (startedRef.current && !pausedRef.current && dynCooldown <= 0) {
              if (emaMs > 17.5 && dynPR > 0.7) {
                dynPR = Math.max(0.7, dynPR - 0.2)
                renderer!.setPixelRatio(Math.min(window.devicePixelRatio, dynPR))
                dynCooldown = 2
              } else if (emaMs < 13 && dynPR < prCap) {
                dynPR = Math.min(prCap, dynPR + 0.1)
                renderer!.setPixelRatio(Math.min(window.devicePixelRatio, dynPR))
                dynCooldown = 4
              }
            }
            fpsFrames = 0
            frameMsAcc = 0
            fpsLast = now
          }
          let dt = (now - last) / 1000
          last = now
          dt = Math.min(dt, CAR_PHYSICS.simulation.maxFrameDt)

          const inp = input.update(dt)
          if (!startedRef.current && inp.startPressed) startGame()
          if (startedRef.current && inp.escapePressed) {
            if (pausedRef.current) resumeFnRef.current()
            else pauseFnRef.current()
          }
          if (pausedRef.current && inp.startPressed) resumeFnRef.current()
          if (inp.toggleCameraPressed) chaseFar = !chaseFar
          const doReset = inp.resetPressed || resetRef.current
          // Failsafe: below-terrain (tunneled through something) can never
          // be driven out of — beam the car back onto the road instead of
          // soft-locking under the world.
          const fellOut = body.translation().y < -3
          // Buried-but-shallow: inverted with the roof below terrain level
          // (y<0.1; a legit roof-rest sits at ~0.17). Throttle roll can
          // still self-right, so this only fires after 5 s — genuinely
          // stuck, not mid-recovery.
          const bq0 = body.rotation()
          const upY0 = 1 - 2 * (bq0.x * bq0.x + bq0.z * bq0.z)
          if (startedRef.current && !pausedRef.current && body.translation().y < 0.1 && upY0 < 0.3) {
            buriedTimer += dt
          } else {
            buriedTimer = 0
          }
          if (doReset || fellOut || buriedTimer > 5) {
            buriedTimer = 0
            resetRef.current = false
            const p = body.translation()
            const s = -p.z
            car.reset(new THREE.Vector3(roadCenterX(s), 0.72, p.z), roadDirYaw(s))
            stepper.acc = 0
          }

          if (pausedRef.current) {
            stepper.acc = 0
            setSpeedLines(0)
            smoke.update(dt)
            renderer!.render(scene, camera)
            return
          }

          let t = null as null | ReturnType<typeof car.update>
          if (startedRef.current) {
            if (raceActive && headsUp > 0) headsUp = Math.max(0, headsUp - dt)
            else if (raceActive && countdown > 0)
              countdown = Math.max(0, countdown - dt)
            const racing =
              !raceActive || (headsUp <= 0 && countdown <= 0)
            if (raceActive && racing && !raceFinished) raceElapsed += dt
            const steps = pushFrameTime(stepper, dt)
            // AI thinks once per frame (not per substep), and physics LOD
            // follows distance: near cars step every substep, mid-field
            // every 2nd, distant cars every 4th. Suspension raycasts are
            // the dominant per-car cost, so this is where 20-car fields
            // get their headroom back.
            if (raceActive) {
              const pp = body.translation()
              // All chassis positions, once per frame — the AI shares this
              // instead of each car re-reading every other body (N² wasm
              // calls + object churn at 50 cars).
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
                      escapePressed: false,
                    }
              // Live pedals pre-green so launch control can arm — but the
              // car itself is padlocked to its grid slot until the flag
              // drops. Revs build, LC arms, nothing moves. No jumping.
              const playerInp = !playerFinished ? subInp : holdInput()
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
                  rival.car.update(FIXED_DT, aiInp)
                }
              }
              // Shared-physics ghosts: velocity-drive remotes toward their
              // authoritative poses BEFORE stepping, so car-vs-car contacts
              // resolve dynamic-vs-dynamic and shoves land on both cars.
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
              ;(window as any).__physicsDroppedTotal =
                stepper.droppedTotal
            }
          }

          const bp = body.translation()
          const carPos = new THREE.Vector3(bp.x, bp.y, bp.z)
          moveGroundBody(groundBody, bp.x, bp.z)
          // Burial snap: one downward ray from the chassis centre. If it
          // starts inside solid (toi≈0) for 3 straight frames, the car is
          // inside terrain/a prop — ratchet it up until free. Never fires
          // in legit play (centre rides ≥0.7 above surfaces, 0.17 on roof).
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
              !!bhit && (bhit as unknown as { timeOfImpact: number }).timeOfImpact < 0.05
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
          // Broadcast local state and update remote peer cars.
          // t is null while the lobby is open (not started) — remotes must
          // still animate, so update them even when there is nothing to send.
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
            // Mercy rule: 45 s after you finish, stragglers are scored by
            // position (DNF). Without this one lost AI blocks the results
            // — and the next grid — forever.
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
              // Last-resort teleport only: the AI first tries to drive out
              // (reverse maneuver) on its own. stuckT proves it is truly
              // going nowhere — 8 s covers multiple failed recoveries.
              // Fell through the world (y < -3) is unrecoverable: instant.
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
                // Finishing order drives the next grid: rivals line up by
                // merit, the player draws a random slot.
                prevOrderRef.current = order.map((o) => o.ai)
              }
            }
            // Distance-based shadow casters + model detail (2 Hz): you
            // plus the 3 nearest rivals render shadows. Imposter swaps
            // use hysteresis (out past 140, back under 100) and upgrades
            // are staggered — at most 2 cars go imposter→real per eval —
            // so a pack crossing the band never flips N models in one
            // frame. Downgrades apply immediately (they only shed cost).
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
                if (r.hi && d > 140 * 140) {
                  r.hi = false
                  r.visual.setDetail(false)
                } else if (!r.hi && d < 100 * 100 && upgrades < 2) {
                  upgrades++
                  r.hi = true
                  r.visual.setDetail(true)
                }
              }
            }
            raceUiAcc += dt
            if (raceUiAcc > 0.05 || raceFinished || headsUp > 0 || countdown > 0) {
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
                  color: colorHex(net?.roomId ? net.localColor : 0xe8e8e8),
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
              })
            }
          }
          wm.update(-bp.z, carPos, grassTargetFor(car.forwardSpeed, raceActive))
          // Scenery shadows go off past ~210 in a race (invisible at that
          // speed, expensive over thousands of instances), back on below
          // ~190 so the toggle never flickers at the boundary.
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
          {
            const MAXD = 120
            const mx = Math.max(-MAXD, Math.min(MAXD, e0.lastMovementX))
            const my = Math.max(-MAXD, Math.min(MAXD, e0.lastMovementY))
            if (mx !== 0 || my !== 0) {
              camYaw -= mx * 0.0022
              camPitch = Math.max(-0.15, Math.min(0.5, camPitch + my * 0.0022))
              lastOrbit = nowS
            }
          }
          e0.lastMovementX = 0
          e0.lastMovementY = 0
          // Auto-recenter only once the car is rolling — when parked, a
          // moved camera stays where the driver left it.
          const rolling = Math.abs(car.forwardSpeed) > 1.0
          if (!orbiting && rolling && nowS - lastOrbit > 2.5) {
            const ck = 1 - Math.exp(-dt * 2.2)
            camYaw +=
              (Math.round(camYaw / (Math.PI * 2)) * Math.PI * 2 - camYaw) * ck
            if (Math.abs(camYaw) < 0.002) camYaw = 0
            camPitch += (0 - camPitch) * ck
            if (Math.abs(camPitch) < 0.002) camPitch = 0
          }
          const bq = body.rotation()
          const quat = new THREE.Quaternion(bq.x, bq.y, bq.z, bq.w)
          const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(quat)
          smoothFwd.lerp(fwd, 1 - Math.exp(-dt * 10)).normalize()
          const orbitQ = new THREE.Quaternion().setFromAxisAngle(
            new THREE.Vector3(0, 1, 0),
            camYaw,
          )
          const viewDir = smoothFwd.clone().applyQuaternion(orbitQ)
          viewDir.y = 0
          viewDir.normalize()
          const dist = chaseFar ? 6.4 : 5.2
          const height = (chaseFar ? 1.08 : 0.92) + camPitch * 5
          const desired = carPos
            .clone()
            .addScaledVector(viewDir, -dist)
            .add(new THREE.Vector3(0, height, 0))
          if (raceActive && headsUp > 0) {
            // Pre-start wide shot: park the camera ahead-side of the player
            // looking back down the grid so the whole field is visible.
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
          const targetFov = SF.fovBase + (fovCeil - SF.fovBase) * sfFov * sfFov
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

          const tgtLookAhead = 6 * Math.max(0, Math.cos(camYaw))
          lookAheadSm += (tgtLookAhead - lookAheadSm) * (1 - Math.exp(-dt * 8))
          camLook.copy(carPos).addScaledVector(smoothFwd, lookAheadSm)
          camLook.y += 0.92 + Math.max(0, camPitch) * 1.8
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

          renderer!.render(scene, camera)

          if (t && now - teleRef.last > 50) {
            teleRef.last = now
            setTele({ ...t })
          }
        }
        raf = requestAnimationFrame(loop)

        ;(mount as any)._cleanup = () => {
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
              // Detach BEFORE world.free(): packets arriving during the next
              // setup's model loads must not create bodies in a dead world.
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
          // The error overlay must be clickable: drop the hidden cursor and
          // release pointer lock (the root div hides the cursor while driving).
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

  return (
    <div
      className={`relative w-screen h-screen overflow-hidden bg-black ${started && !paused && !race.finished ? "cursor-none" : ""}`}
    >
      <div ref={mountRef} className="absolute inset-0" />
      {}
      <SpeedLines ref={speedLinesRef} />
      {!loading && !error && started && !race.finished && <Dashboard tele={tele} />}
      {!loading && !error && started && !paused && !race.finished && (
        <RaceHud race={race} />
      )}
      {!loading && !error && started && !paused && !race.finished && (
        <RaceLiveBoard race={race} />
      )}
      {!loading && !error && started && !paused && !race.finished && lockHint && (
        <div className="absolute bottom-32 left-1/2 -translate-x-1/2 rounded-full border border-white/15 bg-black/70 px-5 py-2 text-[12px] tracking-wide text-gray-200 backdrop-blur">
          Click anywhere to get the mouse back
        </div>
      )}
      {netConnected && started && !race.finished && (
        <MultiplayerHudBadge
          roomId={netRoomId}
          playerCount={netPeers.length + 1}
          pingMs={netPeers[0]?.pingMs ?? 0}
          onLeave={handleLeaveRoom}
        />
      )}
      {!loading && !error && !started && !showMultiplayerLobby && (
        <RaceMenu
          rivals={rivals}
          distanceKm={distanceKm}
          onRivals={setRivals}
          onDistance={setDistanceKm}
          onFreeDrive={startGame}
          onStartRace={startRace}
          onOpenMultiplayer={() => setShowMultiplayerLobby(true)}
        />
      )}
      {showMultiplayerLobby && (
        <MultiplayerLobby
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
              // Paint/name picked after joining must reach peers: the ghost
              // otherwise keeps the color from the join-time HELLO forever.
              multiplayerRef.current.announceIdentitySoon()
            }
          }}
          onJoinRoom={(target, mode) => {
            setJoinError(null)
            setNetRoomId(target)
            // join() reports false when the connection can't even start —
            // don't strand the UI on the form with no explanation.
            const ok =
              multiplayerRef.current?.join(target, mode, driverName, driverColor) ?? false
            setNetConnected(ok)
          }}
          onLeaveRoom={handleLeaveRoom}
          onStartMultiplayerRace={handleStartMultiplayerRace}
          onStartFreeDrive={handleStartFreeDrive}
          joinError={joinError}
          onBack={() => {
            setJoinError(null)
            setShowMultiplayerLobby(false)
          }}
        />
      )}
      {!loading && !error && started && race.finished && (
        <RaceResults
          race={race}
          onAgain={raceAgain}
          onMenu={quitToMenu}
        />
      )}
      {!loading && !error && started && paused && !race.finished && (
        <div className="absolute inset-0 flex items-center justify-center bg-black/55 backdrop-blur-[3px]">
          <div className="relative w-[380px] overflow-hidden rounded-3xl border border-white/10 bg-[#0b0e14]/95 text-center shadow-[0_30px_100px_rgba(0,0,0,0.7)]">
            <div className="flex h-[5px]">
              <div className="flex-1 bg-[#51a7d5]" />
              <div className="flex-1 bg-[#1c3d7c]" />
              <div className="flex-1 bg-[#e30613]" />
            </div>
            <div className="px-9 pt-8 pb-7">
              <div className="text-[11px] font-semibold tracking-[0.4em] text-[#8f99a8]">
                TAKING A BREAK
              </div>
              <h2 className="mt-2 text-4xl font-bold tracking-tight text-white">
                Paused
              </h2>
              <p className="mt-2.5 text-[14px] leading-6 text-gray-300">
                No rush. Your car is holding right where you left it.
              </p>
              <div className="mt-6 space-y-2.5">
                <button
                  onClick={resumeGame}
                  className="w-full rounded-2xl bg-[#e30613] px-6 py-3 text-[15px] font-semibold text-white shadow-[0_10px_40px_rgba(227,6,19,0.4)] transition hover:bg-[#f01422] active:scale-[0.98]"
                >
                  Keep driving
                </button>
                <button
                  onClick={() => {
                    resetRef.current = true
                    resumeGame()
                  }}
                  className="w-full rounded-2xl border border-white/12 bg-white/5 px-6 py-3 text-[14px] font-medium text-gray-100 transition hover:bg-white/10 active:scale-[0.98]"
                >
                  Put me back on the road
                </button>
                <button
                  onClick={quitToMenu}
                  className="w-full rounded-2xl border border-transparent px-6 py-2.5 text-[13px] font-medium text-gray-400 transition hover:text-white"
                >
                  Back to the start
                </button>
              </div>
              <div className="mt-4 text-[12px] text-gray-500">
                press Esc to keep driving
              </div>
            </div>
          </div>
        </div>
      )}
      {loading && (
        <div className="absolute inset-0 flex items-center justify-center bg-[#0b0e14] text-white">
          <div className="text-center">
            <div className="text-[11px] font-semibold tracking-[0.4em] text-[#8f99a8]">
              M PERFORMANCE
            </div>
            <div className="mt-2 text-2xl font-bold">Getting your M3 ready</div>
            <div className="mt-1 text-sm text-gray-400">
              Warming up physics and loading the world
            </div>
          </div>
        </div>
      )}
      {error && (
        <div
          className="absolute inset-0 flex items-center justify-center text-white p-6 cursor-auto [&_*]:cursor-auto"
          style={{ cursor: "auto" }}
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
        </div>
      )}
    </div>
  )
}
