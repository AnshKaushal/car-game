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

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

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
  const speedLinesOn = useRef(false);
  const setSpeedLines = (v: number) => {
    const el = speedLinesRef.current;
    if (!el) return;
    if (v <= 0.001) {
      if (speedLinesOn.current) {
        speedLinesOn.current = false;
        el.style.opacity = '0';
        // park the layer: stops the compositor ticking 20 animations while idle
        el.classList.add('sl-off');
      }
      return;
    }
    if (!speedLinesOn.current) {
      speedLinesOn.current = true;
      el.classList.remove('sl-off');
    }
    // Opacity only. The overlay is a FIXED size — scaling it with speed made
    // the whole thing visibly shrink as you went faster, which read as the
    // effect powering down rather than intensifying. The streaks already fly
    // outward on their own animation; nothing else needs to change.
    el.style.opacity = String(Math.min(1, v) * CAR_PHYSICS.assists.speedFeel.linesStrength);
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
        // Smoothed look-ahead distance (metres along the car's heading). This
        // is a SCALAR, which is the whole point — see the camLook build below.
        let lookAheadSm = 6;

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
        // pointer-lock bookkeeping: "want it" / "asked for it" / retry timer
        let lockWanted = false;
        let lockRetry = 0;
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
          document.documentElement.style.cursor = 'none';
          document.body.style.cursor = 'none';
          tryLock();
        };
        /**
         * Request pointer lock, robustly.
         *
         * The old code called requestPointerLock() inside a try/catch and
         * nothing else, which silently loses two distinct failure modes:
         *  - the modern API returns a PROMISE that REJECTS (rather than
         *    throwing) when the browser refuses — e.g. because the call came
         *    from a plain pointermove instead of a real gesture. Nothing
         *    observed the rejection, so the game ran on with the CSS cursor
         *    hidden while the OS cursor was still free to leave the window.
         *  - re-locking immediately after Esc is rate-limited by the browser
         *    for about a second, which needs a delayed retry, not one shot.
         * So: observe the promise, and retry on a backoff until the lock is
         * genuinely held. lockWanted separates "we want it" from "we have it"
         * so the retry chain stops the moment it succeeds.
         */
        const tryLock = () => {
          if (!startedRef.current || lockWanted) return;
          lockWanted = true;
          const el = dom as any;
          if (!el.requestPointerLock) { lockWanted = false; return; }
          let p: unknown;
          try {
            // unadjustedMovement bypasses OS mouse acceleration, which is what
            // makes a locked camera feel inconsistent between machines. Not
            // universally supported, hence the fallback.
            try { p = el.requestPointerLock({ unadjustedMovement: true }); }
            catch { p = el.requestPointerLock(); }
          } catch {
            lockWanted = false;
            return;
          }
          const fail = () => {
            lockWanted = false;
            if (lockRetry) return;
            lockRetry = window.setTimeout(() => { lockRetry = 0; tryLock(); }, 350);
          };
          if (p && typeof (p as Promise<void>).catch === 'function') {
            (p as Promise<void>).catch(fail);
          } else {
            // Legacy void-returning API: verify on the next tick instead.
            window.setTimeout(() => {
              if (lockWanted && document.pointerLockElement !== dom) fail();
            }, 120);
          }
        };
        const showCursor = () => {
          document.documentElement.style.cursor = '';
          document.body.style.cursor = '';
          if (lockRetry) { window.clearTimeout(lockRetry); lockRetry = 0; }
          lockWanted = false;
          if (document.pointerLockElement) document.exitPointerLock?.();
        };
        /**
         * Re-acquire the lock if the browser dropped it (Esc, focus loss, tab
         * switch) or if it was never granted in the first place.
         *
         * CSS cursor:none alone is NOT enough — it only hides the cursor drawn
         * inside the page. The OS cursor can still travel out of the window and
         * onto the title bar, which is what "mouse moves out of the screen"
         * means. Only pointer lock prevents that.
         *
         * NOTE: we deliberately do NOT retry from inside this handler. A
         * pointermove is not a user gesture, so the request would be rejected
         * and, worse, could burn the browser's rate-limit budget. We flag that
         * a retry is needed and let the next genuine gesture (pointerdown /
         * keydown) perform it.
         */
        const onForceHide = () => {
          if (startedRef.current && !document.pointerLockElement) lockWanted = false;
        };
        // Any real gesture is a valid moment to (re)request the lock.
        const onGesture = () => {
          if (startedRef.current && !document.pointerLockElement) tryLock();
        };
        document.addEventListener('pointermove', onForceHide);
        document.addEventListener('pointerdown', onGesture);
        document.addEventListener('keydown', onGesture);
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
          // Holding the lock satisfies the pending request — stop retrying.
          if (mouseLocked) {
            lockWanted = false;
            if (lockRetry) { window.clearTimeout(lockRetry); lockRetry = 0; }
          } else {
            // Dropped (Esc / focus loss). Allow a fresh request from the next
            // genuine gesture rather than hammering a rate-limited API.
            lockWanted = false;
          }
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
          // Cap the frame the same way CarController caps its own integration window.
          // If the loop advanced the world further than the tire forces were
          // integrated for, grip silently dropped on a slow machine — which
          // reads as "the car won't respond" and gets worse the worse the
          // framerate gets.
          dt = Math.min(dt, CAR_PHYSICS.simulation.maxFrameDt);

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
          // Ride height. Was 6.5m back / 2.6m up, which looked down on the roof and
          // pushed the car down into the dashboard. Lowered to just above roof
          // height and pulled slightly closer, so the horizon sits high and the
          // car reads against the road ahead instead of the cluster.
          const dist = chaseFar ? 5.5 : 4.3;
          const height = (chaseFar ? 1.62 : 1.42) + camPitch * 5;
          const desired = carPos.clone().addScaledVector(viewDir, -dist).add(new THREE.Vector3(0, height, 0));
          camPos.copy(desired);

          // --- speed sensation (lens + shake only, never moves the car) ---
          // Widen the FOV with speed: the classic "things rush past harder"
          // trick. Camera POSITION is untouched (rigid follow).
          const SF = CAR_PHYSICS.assists.speedFeel;
          const vAbs = Math.abs(car.forwardSpeed) * 3.6;
          const sfFov = Math.min(1, vAbs / SF.fovAtMaxSpeedKmh);
          // The FOV widening is a *behind-the-car* effect. Held all the way
          // open while orbited to the side, 104deg turns the scene into a
          // fisheye that swims horribly at speed, so ease the widening back
          // toward the base FOV as you swing off the tail.
          const offAxis = clamp(Math.abs(camYaw) / (Math.PI / 2), 0, 1);
          const fovCeil = SF.fovBase + (SF.fovMax - SF.fovBase) * (1 - offAxis * 0.55);
          const targetFov = SF.fovBase + (fovCeil - SF.fovBase) * sfFov * sfFov;
          if (Math.abs(camera.fov - targetFov) > 0.02) {
            camera.fov += (targetFov - camera.fov) * Math.min(1, dt * 3.5);
            camera.updateProjectionMatrix();
          }
          setSpeedLines(Math.min(1, Math.max(0, (vAbs - SF.linesFromKmh) / (SF.fovAtMaxSpeedKmh - SF.linesFromKmh))));

          // Look point is rebuilt EXACTLY from the car's current position every
          // frame — zero positional lag. It used to be lerped in world space,
          // which trails by v * (1/rate): at 320km/h that is ~3m of lag, so
          // the camera aimed at empty road BEHIND the car and the car visibly
          // slid out of frame the moment you orbited to the side at speed.
          // Only the scalar look-ahead is smoothed, which kills jitter without
          // introducing any lag at any velocity.
          const tgtLookAhead = 6 * Math.max(0, Math.cos(camYaw));
          lookAheadSm += (tgtLookAhead - lookAheadSm) * (1 - Math.exp(-dt * 8));
          camLook.copy(carPos).addScaledVector(smoothFwd, lookAheadSm);
          // raise the aim point as the camera rises, so a high side-on view
          // doesn't drop the car to the bottom of the frame
          // Aim at roughly the car's roof height. Aiming any lower tips the camera down
          // and slides the car further down the frame, into the cluster.
          camLook.y += 1.02 + Math.max(0, camPitch) * 1.8;
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
          if (lockRetry) window.clearTimeout(lockRetry);
          document.removeEventListener('pointermove', onForceHide);
          document.removeEventListener('pointerdown', onGesture);
          document.removeEventListener('keydown', onGesture);
          document.removeEventListener('pointerlockerror', onForceHide);
          document.removeEventListener('pointerlockchange', onLockChange);
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
