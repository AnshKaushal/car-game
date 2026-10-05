import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { initPhysics, createWorld, createChassisBody, stepWorld, moveGroundBody } from './systems/PhysicsSystem';
import { CarController, type CarTelemetry } from './systems/CarController';
import { WorldManager, roadCenterX, roadYaw } from './systems/WorldManager';
import { CarVisual } from './systems/CarVisual';
import { TireSmoke } from './systems/TireSmoke';
import { InputManager } from './systems/InputManager';
import Dashboard from './ui/Dashboard';
import { SpeedLines } from './ui/SpeedLines';
import { CAR_PHYSICS } from './constants/physics';

const initialTele: CarTelemetry = {
  speedKmh: 0, rpm: 800, gear: 1, gearLabel: '1', autoMode: true,
  throttle: 0, brake: 0, steer: 0, shifting: false,
  launchArmed: false, launching: false, parkingBrake: true,
  slipRatio: 0, drift: false,
};

export default function App() {
  const mountRef = useRef<HTMLDivElement>(null);
  const [tele, setTele] = useState<CarTelemetry>(initialTele);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [started, setStarted] = useState(false);
  const [lockHint, setLockHint] = useState(false);
  // speed-lines strength 0..1, written every frame from the render loop via a
  // ref (no re-render) so it stays perfectly smooth at 60fps
  const speedLinesRef = useRef<HTMLDivElement | null>(null);
  const lastSpreadRef = useRef(-1);
  const setSpeedLines = (v: number) => {
    const el = speedLinesRef.current;
    if (!el) return;
    if (v <= 0.001) {
      if (lastSpreadRef.current !== -1) {
        lastSpreadRef.current = -1;
        el.style.opacity = '0';
        // park the layer: stops the compositor ticking 20 animations while idle
        el.classList.add('sl-off');
      }
      return;
    }
    if (el.classList.contains('sl-off')) el.classList.remove('sl-off');
    el.style.opacity = String(Math.min(1, v) * CAR_PHYSICS.assists.speedFeel.linesStrength);
    // push streaks outward from the vanishing point as speed builds.
    // Quantized: rewriting a custom property every frame forces a style
    // recalc down the whole overlay subtree for no visible gain.
    const spread = 1.06 - v * 0.32;
    if (Math.abs(spread - lastSpreadRef.current) > 0.02) {
      lastSpreadRef.current = spread;
      el.style.setProperty('--sl-spread', String(spread));
    }
  };
  const startedRef = useRef(false);
  const rendererRef = useRef<THREE.WebGLRenderer | null>(null);
  const startGame = () => {
    startedRef.current = true;
    setStarted(true);
    // hide the cursor immediately (must happen inside the click gesture).
    // requestPointerLock is only honored inside a user gesture, so this is the
    // one reliable moment to acquire it — it is what confines the cursor to
    // the window on every OS.
    document.documentElement.style.cursor = 'none';
    document.body.style.cursor = 'none';
    const el = rendererRef.current?.domElement;
    try { el?.requestPointerLock?.(); } catch { /* unsupported -> CSS hide only */ }
  };

  useEffect(() => {
    let disposed = false;
    let renderer: THREE.WebGLRenderer | null = null;
    let raf = 0;
    const teleRef = { last: 0 };

    (async () => {
      try {
        const mount = mountRef.current!;
        renderer = new THREE.WebGLRenderer({ antialias: true });
        renderer.setSize(mount.clientWidth, mount.clientHeight);
        renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.75));
        renderer.shadowMap.enabled = true;
        renderer.shadowMap.type = THREE.PCFSoftShadowMap;
        mount.appendChild(renderer.domElement);
        rendererRef.current = renderer;

        const scene = new THREE.Scene();
        scene.background = new THREE.Color(0x87ceeb);
        const camera = new THREE.PerspectiveCamera(68, mount.clientWidth / mount.clientHeight, 0.1, 2500);

        const R = await initPhysics();
        const world = createWorld();

        // world visuals + physics ground
        const wm = new WorldManager();
        const base = import.meta.env.BASE_URL || './';
        const baseUrl = base.endsWith('/') ? base : base + '/';
        await wm.init(scene, baseUrl);
        const groundBody = wm.createPhysicsGround(R, world);

        // car
        const startX = roadCenterX(0);
        const body = createChassisBody(world, startX, 0.72, 0);
        // face along road direction (-Z rotated by yaw)
        const yaw0 = roadYaw(0);
        const q0 = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, yaw0, 0));
        body.setRotation({ x: q0.x, y: q0.y, z: q0.z, w: q0.w }, true);
        const car = new CarController(world, body, R);

        const visual = new CarVisual();
        try {
          await visual.load(baseUrl);
        } catch (e) {
          console.warn('bmw model failed, continuing with fallback wheels', e);
        }
        scene.add(visual.group);

        const smoke = new TireSmoke();
        scene.add(smoke.points);
        const smokeSpots: THREE.Vector3[] = [];
        let smokeAcc = 0;

        const input = new InputManager();
        input.attach();

        const onResize = () => {
          camera.aspect = mount.clientWidth / mount.clientHeight;
          camera.updateProjectionMatrix();
          renderer!.setSize(mount.clientWidth, mount.clientHeight);
        };
        window.addEventListener('resize', onResize);

        let chaseFar = true;
        let last = performance.now();
        const camPos = new THREE.Vector3(startX, 3, 8);
        const camLook = new THREE.Vector3();
        const smoothFwd = new THREE.Vector3(0, 0, -1);

        // GTA-style free camera. The camera follows the CAR'S HEADING only,
        // never the cursor position or the direction of travel — moving the
        // mouse can never spin the camera on its own. Mouse movement is
        // consumed as an explicit delta (works locked or not), and after 2.5s
        // of no mouse input it eases back behind the car.
        let camYaw = 0; // 0 = directly behind, radians, + = look from the left
        let camPitch = 0; // -0.15..0.5, added height factor
        let lastOrbit = -10000;
        let orbiting = false; // fallback drag if pointer lock unavailable
        let lastPX = 0, lastPY = 0;
        // accumulated mouse movement since the last frame
        const e0 = { lastMovementX: 0, lastMovementY: 0 };
        let mouseLocked = false;
        let cursorHidden = false;
        const dom = renderer!.domElement;

        /**
         * Hide the system cursor for good, in every mode.
         * Layered: (1) CSS cursor:none on html/body + a body-level rule that
         * overrides any nested override, (2) DOM pointer lock — the ONLY thing
         * that truly confines the cursor to the window on macOS/Windows/Linux,
         * (3) re-hide/re-request if the browser drops the lock. Esc releases
         * it; a click anywhere re-hides and re-locks.
         */
        const hideCursor = () => {
          cursorHidden = true;
          document.documentElement.style.cursor = 'none';
          document.body.style.cursor = 'none';
          // Only DOM pointer lock can actually stop the OS cursor from
          // reaching the title bar. requestPointerLock is always called from
          // inside a user-gesture handler (click / Enter / START button) —
          // never from a plain pointermove, which browsers reject.
          try { dom.requestPointerLock?.(); } catch { /* unsupported */ }
        };
        const showCursor = () => {
          cursorHidden = false;
          document.documentElement.style.cursor = '';
          document.body.style.cursor = '';
          if (document.pointerLockElement) document.exitPointerLock?.();
        };
        // If the browser drops the lock (Esc, focus loss, tab switch) or the
        // cursor is ever restored, re-hide + re-request on the next move.
        const onForceHide = () => {
          if (startedRef.current && !cursorHidden && !document.pointerLockElement) hideCursor();
        };
        document.addEventListener('pointermove', onForceHide);
        document.addEventListener('pointerlockerror', onForceHide);
        const onPointerDown = (e: PointerEvent) => {
          // click = re-hide the cursor and recapture (after Esc, after focus loss)
          if (startedRef.current) hideCursor();
          orbiting = true;
          lastPX = e.clientX; lastPY = e.clientY;
          lastOrbit = performance.now() / 1000;
        };
        const onPointerMove = (e: PointerEvent) => {
          // Explicit mouse DELTA only — never the cursor's absolute position.
          // (Using position is what made the camera drift on its own.)
          if (document.pointerLockElement === dom) {
            e0.lastMovementX += e.movementX || 0;
            e0.lastMovementY += e.movementY || 0;
          } else if (e.movementX !== undefined && (e.movementX !== 0 || e.movementY !== 0)) {
            // unlocked: movementX/Y still report the step between events
            e0.lastMovementX += e.movementX || 0;
            e0.lastMovementY += e.movementY || 0;
          }
          if (!startedRef.current) {
            // pre-start fallback: drag to look around the menu backdrop
            if (!orbiting) return;
            const dx = e.clientX - lastPX;
            const dy = e.clientY - lastPY;
            lastPX = e.clientX; lastPY = e.clientY;
            camYaw -= dx * 0.0052;
            camPitch = Math.max(-0.15, Math.min(0.5, camPitch + dy * 0.0032));
            lastOrbit = performance.now() / 1000;
          }
        };
        const onPointerUp = () => { orbiting = false; };
        const onLockChange = () => {
          mouseLocked = document.pointerLockElement === dom;
          setLockHint(startedRef.current && !mouseLocked);
        };
        dom.addEventListener('pointerdown', onPointerDown);
        dom.addEventListener('pointermove', onPointerMove);
        dom.addEventListener('pointerup', onPointerUp);
        dom.addEventListener('pointercancel', onPointerUp);
        document.addEventListener('pointerlockchange', onLockChange);

        if (disposed) return;
        setLoading(false);

        const loop = (now: number) => {
          if (disposed) return;
          raf = requestAnimationFrame(loop);
          let dt = (now - last) / 1000;
          last = now;
          dt = Math.min(dt, 1 / 20);

          const inp = input.update(dt);
          if (!startedRef.current && inp.startPressed) startGame();
          // Esc releases the mouse; a click anywhere re-hides it
          if (inp.escapePressed && startedRef.current) showCursor();
          if (inp.toggleCameraPressed) chaseFar = !chaseFar;
          if (inp.resetPressed) {
            const p = body.translation();
            const s = -p.z;
            car.reset(new THREE.Vector3(roadCenterX(s), 0.72, p.z), roadYaw(s));
          }

          const t = startedRef.current ? car.update(dt, inp) : null;
          if (startedRef.current) stepWorld(world, dt);

          // sync visuals — front axle rolls at road speed, rear axle spins
          // from measured slip so burnouts visibly smoke the tires
          const bp = body.translation();
          const carPos = new THREE.Vector3(bp.x, bp.y, bp.z);
          moveGroundBody(groundBody, bp.x, bp.z); // keep physics ground under the car (endless world)
          visual.syncFromBody(body, car.steerAngle, car.forwardSpeed / CAR_PHYSICS.wheels.radius, car.spinOmega, dt);
          wm.update(-bp.z, carPos);

          // tire smoke: rear wheels on wheelspin/launch, all four while drifting
          if (startedRef.current) {
            const intensity = Math.max(car.slipRatioAvg, car.drifting ? 0.55 : 0, car.launching ? 0.7 : 0);
            if (intensity > 0.28) {
              visual.wheelContactPositions(car.drifting, smokeSpots);
              smokeAcc += dt * intensity * 90;
              while (smokeAcc >= 1) {
                smokeAcc -= 1;
                smoke.spawn(smokeSpots[(Math.random() * smokeSpots.length) | 0], Math.min(1, intensity));
              }
            }
          }
          smoke.update(dt);

          // chase camera: RIGID follow at a fixed distance (never drifts away).
          // Free look via explicit mouse movement deltas; eases back behind
          // the car after 2.5s idle, GTA-style.
          const nowS = now / 1000;
          {
            // clamp deltas so one fast flick can't throw the camera around
            const MAXD = 120; // px per frame (~2.4x a normal fast swipe)
            const mx = Math.max(-MAXD, Math.min(MAXD, e0.lastMovementX));
            const my = Math.max(-MAXD, Math.min(MAXD, e0.lastMovementY));
            if (mx !== 0 || my !== 0) {
              camYaw -= mx * 0.0022;
              camPitch = Math.max(-0.15, Math.min(0.5, camPitch + my * 0.0022));
              lastOrbit = nowS;
            }
          }
          e0.lastMovementX = 0;
          e0.lastMovementY = 0;
          if (!orbiting && nowS - lastOrbit > 2.5) {
            const ck = 1 - Math.exp(-dt * 2.2);
            // ease yaw to nearest multiple of 2π (= behind), pitch to level
            camYaw += (Math.round(camYaw / (Math.PI * 2)) * Math.PI * 2 - camYaw) * ck;
            if (Math.abs(camYaw) < 0.002) camYaw = 0;
            camPitch += (0 - camPitch) * ck;
            if (Math.abs(camPitch) < 0.002) camPitch = 0;
          }
          const bq = body.rotation();
          const quat = new THREE.Quaternion(bq.x, bq.y, bq.z, bq.w);
          const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(quat);
          // smooth the heading used for the camera (fast follow, kills the
          // physics micro-jitter that made orbited views wiggle at speed)
          smoothFwd.lerp(fwd, 1 - Math.exp(-dt * 10)).normalize();
          const orbitQ = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), camYaw);
          const viewDir = smoothFwd.clone().applyQuaternion(orbitQ);
          viewDir.y = 0; viewDir.normalize();
          const dist = chaseFar ? 6.5 : 4.2;
          const height = (chaseFar ? 2.6 : 1.9) + camPitch * 5;
          const desired = carPos.clone().addScaledVector(viewDir, -dist).add(new THREE.Vector3(0, height, 0));
          camPos.copy(desired);

          // --- speed sensation (lens + shake only, never moves the car) ---
          // Widen the FOV with speed: the classic "things rush past harder"
          // trick. Camera POSITION is untouched (rigid follow).
          const SF = CAR_PHYSICS.assists.speedFeel;
          const vAbs = Math.abs(car.forwardSpeed) * 3.6;
          const sfFov = Math.min(1, vAbs / SF.fovAtMaxSpeedKmh);
          const targetFov = SF.fovBase + (SF.fovMax - SF.fovBase) * sfFov * sfFov;
          if (Math.abs(camera.fov - targetFov) > 0.02) {
            camera.fov += (targetFov - camera.fov) * Math.min(1, dt * 3.5);
            camera.updateProjectionMatrix();
          }
          setSpeedLines(Math.min(1, Math.max(0, (vAbs - SF.linesFromKmh) / (SF.fovAtMaxSpeedKmh - SF.linesFromKmh))));
          // look AT the car when orbited to the side/front (full 6m ahead only
          // directly behind) — otherwise the car slides out of frame
          const lookAhead = 6 * Math.max(0, Math.cos(camYaw));
          camLook.lerp(carPos.clone().addScaledVector(smoothFwd, lookAhead).add(new THREE.Vector3(0, 1.1, 0)), 1 - Math.exp(-dt * 25));
          camera.position.copy(camPos);
          camera.lookAt(camLook);

          // fine jitter (road texture + suspension noise), applied AFTER
          // lookAt so it isn't overwritten. Deterministic time-based wobble,
          // so it never random-spikes or fights the rig.
          const sfShake = Math.min(1, Math.max(0, (vAbs - SF.shakeFromKmh) / (SF.fovAtMaxSpeedKmh - SF.shakeFromKmh)));
          if (sfShake > 0.001) {
            const t2 = nowS * 34;
            camera.rotation.z += Math.sin(t2 * 1.7) * SF.shakeAmp * sfShake;
            camera.position.x += Math.sin(t2 * 2.3) * 0.014 * sfShake;
            camera.position.y += Math.sin(t2 * 3.1) * 0.012 * sfShake;
          }

          renderer!.render(scene, camera);

          // HUD at ~20Hz
          if (t && now - teleRef.last > 50) { teleRef.last = now; setTele({ ...t }); }
        };
        raf = requestAnimationFrame(loop);

        // cleanup capture
        (mount as any)._cleanup = () => {
          window.removeEventListener('resize', onResize);
          dom.removeEventListener('pointerdown', onPointerDown);
          dom.removeEventListener('pointermove', onPointerMove);
          dom.removeEventListener('pointerup', onPointerUp);
          dom.removeEventListener('pointercancel', onPointerUp);
          document.removeEventListener('pointermove', onForceHide);
          document.removeEventListener('pointerlockerror', onForceHide);
          document.removeEventListener('pointerlockchange', onLockChange);
          input.detach();
          world.free();
        };
      } catch (e: any) {
        console.error(e);
        if (!disposed) {
          setError(e?.message ?? String(e));
          setLoading(false);
        }
      }
    })();

    return () => {
      disposed = true;
      cancelAnimationFrame(raf);
      const mount: any = mountRef.current;
      mount?._cleanup?.();
      if (renderer) {
        renderer.dispose();
        renderer.domElement.remove();
      }
    };
  }, []);

  return (
    <div className={`relative w-screen h-screen overflow-hidden bg-black ${started ? 'cursor-none' : ''}`}>
      <div ref={mountRef} className="absolute inset-0" />
      {/* peripheral speed streaks — opacity driven every frame from the loop */}
      <SpeedLines ref={speedLinesRef} />
      {!loading && !error && started && <Dashboard tele={tele} />}
      {!loading && !error && started && lockHint && (
        <div className="absolute bottom-28 left-1/2 -translate-x-1/2 rounded-lg border border-white/15 bg-black/60 px-4 py-1.5 text-[12px] tracking-widest text-gray-200" style={{ fontFamily: 'monospace' }}>
          CLICK TO CAPTURE MOUSE · ESC TO RELEASE
        </div>
      )}
      {!loading && !error && !started && (
        <div className="absolute inset-0 flex items-center justify-center bg-black/60 backdrop-blur-[2px]">
          <div className="rounded-2xl border border-white/15 bg-zinc-950/80 px-10 py-8 text-center shadow-2xl" style={{ fontFamily: 'monospace' }}>
            <div className="text-4xl font-black tracking-wide text-white">BMW M3</div>
            <div className="mt-1 text-sm tracking-[0.3em] text-red-500 font-bold">800 HP · 8-SPEED AUTO</div>
            <div className="mx-auto mt-5 grid max-w-md grid-cols-2 gap-x-8 gap-y-1.5 text-left text-[12px] leading-5 text-gray-300">
              <div><b className="text-white">W / S</b> — throttle / brake</div>
              <div><b className="text-white">A / D</b> — steer</div>
              <div><b className="text-white">Q / E</b> — shift down / up</div>
              <div><b className="text-white">M</b> — auto / manual</div>
              <div><b className="text-white">Space</b> — handbrake (TC off)</div>
              <div><b className="text-white">W + S</b> — arm launch control</div>
              <div><b className="text-white">R</b> — reset car</div>
              <div><b className="text-white">C</b> — camera</div>
              <div><b className="text-white">Move mouse</b> — look around (auto-centers)</div>
            </div>
            <div className="mt-3 text-[11px] text-gray-400">Handbrake starts ON — press <b className="text-white">W</b> to release and creep away.</div>
            <button
              onClick={startGame}
              className="mt-5 rounded-xl bg-red-600 px-10 py-3 text-lg font-black tracking-widest text-white shadow-[0_0_30px_rgba(220,38,38,0.5)] transition hover:bg-red-500 active:scale-95"
            >
              START ENGINE
            </button>
            <div className="mt-2 text-[11px] text-gray-500">or press Enter</div>
          </div>
        </div>
      )}
      {loading && (
        <div className="absolute inset-0 flex items-center justify-center text-white" style={{ fontFamily: 'monospace' }}>
          <div className="text-center">
            <div className="text-2xl font-bold mb-2">BMW M3 · warming up…</div>
            <div className="text-sm text-gray-300">loading physics + models</div>
          </div>
        </div>
      )}
      {error && (
        <div className="absolute inset-0 flex items-center justify-center text-white p-6">
          <div className="max-w-lg rounded-xl bg-red-950/80 border border-red-500/40 p-5" style={{ fontFamily: 'monospace' }}>
            <div className="font-bold text-lg mb-2">Failed to start</div>
            <div className="text-sm whitespace-pre-wrap">{error}</div>
            <div className="text-xs mt-3 text-gray-300">
              If models 404: ensure <b>src/mainview/models/bmw_m3.glb</b> and <b>tree_pack.glb</b> are
              served (copied to Vite public dir or imported as assets).
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
