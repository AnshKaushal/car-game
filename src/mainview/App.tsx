import { useEffect, useRef, useState } from "react"
import * as THREE from "three"
import {
  initPhysics,
  createWorld,
  createChassisBody,
  stepWorld,
  moveGroundBody,
} from "./systems/PhysicsSystem"
import { CarController, type CarTelemetry } from "./systems/CarController"
import { WorldManager, roadCenterX, roadYaw } from "./systems/WorldManager"
import { CarVisual } from "./systems/CarVisual"
import { TireSmoke } from "./systems/TireSmoke"
import { InputManager } from "./systems/InputManager"
import Dashboard from "./ui/Dashboard"
import { SpeedLines } from "./ui/SpeedLines"
import { CAR_PHYSICS } from "./constants/physics"

const clamp = (v: number, lo: number, hi: number) =>
  Math.max(lo, Math.min(hi, v))

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
    startedRef.current = true
    pausedRef.current = false
    setStarted(true)
    setPaused(false)
    setLockHint(false)
    lockCanvas()
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

  const quitToMenu = () => {
    pausedRef.current = false
    startedRef.current = false
    setPaused(false)
    setStarted(false)
    setLockHint(false)
    inputRef.current?.clear()
    document.documentElement.style.cursor = ""
    document.body.style.cursor = ""
    if (document.pointerLockElement) document.exitPointerLock?.()
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
        const groundBody = wm.createPhysicsGround(R, world)

        const startX = roadCenterX(0)
        const body = createChassisBody(world, startX, 0.72, 0)
        const yaw0 = roadYaw(0)
        const q0 = new THREE.Quaternion().setFromEuler(
          new THREE.Euler(0, yaw0, 0),
        )
        body.setRotation({ x: q0.x, y: q0.y, z: q0.z, w: q0.w }, true)
        const car = new CarController(world, body, R)

        const visual = new CarVisual()
        try {
          await visual.load(baseUrl)
        } catch (e) {
          console.warn("bmw model failed, continuing with fallback wheels", e)
        }
        scene.add(visual.group)

        const smoke = new TireSmoke()
        scene.add(smoke.points)
        const smokeSpots: THREE.Vector3[] = []
        let smokeAcc = 0

        const input = new InputManager()
        input.attach()
        inputRef.current = input
        let hadLock = false

        const onResize = () => {
          camera.aspect = mount.clientWidth / mount.clientHeight
          camera.updateProjectionMatrix()
          renderer!.setSize(mount.clientWidth, mount.clientHeight)
        }
        window.addEventListener("resize", onResize)

        let chaseFar = true
        let last = performance.now()
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
              pauseFnRef.current()
            }
          }
          setLockHint(
            startedRef.current && !pausedRef.current && !mouseLocked && hadLock,
          )
        }
        dom.addEventListener("pointerdown", onPointerDown)
        dom.addEventListener("pointermove", onPointerMove)
        dom.addEventListener("pointerup", onPointerUp)
        dom.addEventListener("pointercancel", onPointerUp)
        document.addEventListener("pointerlockchange", onLockChange)

        if (disposed) return
        setLoading(false)

        const loop = (now: number) => {
          if (disposed) return
          raf = requestAnimationFrame(loop)
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
          if (doReset) {
            resetRef.current = false
            const p = body.translation()
            const s = -p.z
            car.reset(new THREE.Vector3(roadCenterX(s), 0.72, p.z), roadYaw(s))
          }

          if (pausedRef.current) {
            setSpeedLines(0)
            smoke.update(dt)
            renderer!.render(scene, camera)
            return
          }

          const t = startedRef.current ? car.update(dt, inp) : null
          if (startedRef.current) stepWorld(world, dt)

          const bp = body.translation()
          const carPos = new THREE.Vector3(bp.x, bp.y, bp.z)
          moveGroundBody(groundBody, bp.x, bp.z)
          visual.syncFromBody(
            body,
            car.steerAngle,
            car.forwardSpeed / CAR_PHYSICS.wheels.radius,
            car.spinOmega,
            dt,
          )
          wm.update(-bp.z, carPos)

          if (startedRef.current) {
            const intensity = Math.max(
              car.slipRatioAvg,
              car.drifting ? 0.55 : 0,
              car.launching ? 0.7 : 0,
            )
            if (intensity > 0.28) {
              visual.wheelContactPositions(car.drifting, smokeSpots)
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
          if (!orbiting && nowS - lastOrbit > 2.5) {
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

          renderer!.render(scene, camera)

          if (t && now - teleRef.last > 50) {
            teleRef.last = now
            setTele({ ...t })
          }
        }
        raf = requestAnimationFrame(loop)

        ;(mount as any)._cleanup = () => {
          window.removeEventListener("resize", onResize)
          dom.removeEventListener("pointerdown", onPointerDown)
          dom.removeEventListener("pointermove", onPointerMove)
          dom.removeEventListener("pointerup", onPointerUp)
          dom.removeEventListener("pointercancel", onPointerUp)
          document.removeEventListener("pointermove", onForceHide)
          document.removeEventListener("pointerlockerror", onForceHide)
          document.removeEventListener("pointerlockchange", onLockChange)
          input.detach()
          if (lockRetry) window.clearTimeout(lockRetry)
          document.removeEventListener("pointermove", onForceHide)
          document.removeEventListener("pointerdown", onGesture)
          document.removeEventListener("keydown", onGesture)
          document.removeEventListener("pointerlockerror", onForceHide)
          document.removeEventListener("pointerlockchange", onLockChange)
          world.free()
        }
      } catch (e: any) {
        console.error(e)
        if (!disposed) {
          setError(e?.message ?? String(e))
          setLoading(false)
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
  }, [])

  return (
    <div
      className={`relative w-screen h-screen overflow-hidden bg-black ${started && !paused ? "cursor-none" : ""}`}
    >
      <div ref={mountRef} className="absolute inset-0" />
      {}
      <SpeedLines ref={speedLinesRef} />
      {!loading && !error && started && <Dashboard tele={tele} />}
      {!loading && !error && started && !paused && lockHint && (
        <div className="absolute bottom-32 left-1/2 -translate-x-1/2 rounded-full border border-white/15 bg-black/70 px-5 py-2 text-[12px] tracking-wide text-gray-200 backdrop-blur">
          Click anywhere to get the mouse back
        </div>
      )}
      {!loading && !error && !started && (
        <div className="absolute inset-0 flex items-center justify-center bg-gradient-to-b from-black/70 via-black/55 to-black/75">
          <div className="relative w-[420px] overflow-hidden rounded-3xl border border-white/10 bg-[#0b0e14]/90 text-center shadow-[0_30px_100px_rgba(0,0,0,0.7)] backdrop-blur-md">
            <div className="flex h-[5px]">
              <div className="flex-1 bg-[#51a7d5]" />
              <div className="flex-1 bg-[#1c3d7c]" />
              <div className="flex-1 bg-[#e30613]" />
            </div>
            <div className="px-10 pt-9 pb-8">
              <div className="text-[11px] font-semibold tracking-[0.4em] text-[#8f99a8]">
                M PERFORMANCE
              </div>
              <h1 className="mt-2 text-5xl font-bold tracking-tight text-white">
                BMW M3
              </h1>
              <p className="mt-3 text-[14px] leading-6 text-gray-300">
                She is warmed up and waiting outside.
                <br />
                Hop in and enjoy the road.
              </p>
              <button
                onClick={startGame}
                className="mt-7 w-full rounded-2xl bg-[#e30613] px-10 py-3.5 text-[15px] font-semibold tracking-wide text-white shadow-[0_10px_40px_rgba(227,6,19,0.45)] transition hover:bg-[#f01422] active:scale-[0.98]"
              >
                Start the engine
              </button>
              <div className="mt-3 text-[12px] text-gray-500">
                or press Enter
              </div>
            </div>
          </div>
        </div>
      )}
      {!loading && !error && started && paused && (
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
        <div className="absolute inset-0 flex items-center justify-center text-white p-6">
          <div className="max-w-lg rounded-2xl bg-red-950/80 border border-red-500/40 p-5">
            <div className="font-bold text-lg mb-2">Something went wrong</div>
            <div className="text-sm whitespace-pre-wrap">{error}</div>
            <div className="text-xs mt-3 text-gray-300">
              If models 404, make sure <b>src/mainview/models/bmw_m3.glb</b> and{" "}
              <b>tree_pack.glb</b> are served (copied to the Vite public dir or
              imported as assets).
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
