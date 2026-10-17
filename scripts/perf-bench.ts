import * as RAPIER_ from "@dimforge/rapier3d-compat"
import { CarController } from "../src/mainview/systems/CarController"
import {
  createChassisBody,
  initPhysics,
  FIXED_DT,
} from "../src/mainview/systems/PhysicsSystem"
import type { DriveInput } from "../src/mainview/systems/InputManager"

const RAPIER = await initPhysics()

const input: DriveInput = {
  throttle: 1,
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
  escapePressed: false,
}

async function bench(cars: number) {
  const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 })
  world.timestep = FIXED_DT
  const gb = world.createRigidBody(RAPIER.RigidBodyDesc.fixed())
  world.createCollider(
    RAPIER.ColliderDesc.cuboid(3000, 0.5, 3000)
      .setTranslation(0, -0.55, 0)
      .setFriction(1.0),
    gb,
  )
  const controllers: CarController[] = []
  for (let i = 0; i < cars; i++) {
    const body = createChassisBody(
      world,
      (i % 2) * 4 - 2,
      0.72,
      -Math.floor(i / 2) * 8,
    )
    controllers.push(new CarController(world, body, RAPIER))
  }
  // Warmup (settle suspension, JIT).
  for (let i = 0; i < 240; i++) {
    for (const c of controllers) c.update(FIXED_DT, input)
    world.step()
  }
  const STEPS = 600 // 5 s of sim
  const t0 = performance.now()
  for (let i = 0; i < STEPS; i++) {
    for (const c of controllers) c.update(FIXED_DT, input)
    world.step()
  }
  const t1 = performance.now()
  const msPerStep = (t1 - t0) / STEPS
  console.log(
    `${cars} cars: ${msPerStep.toFixed(2)} ms/sim-step | ` +
      `${(msPerStep * 120).toFixed(0)} ms sim-work per real second @120Hz | ` +
      `headroom x${(1000 / 120 / msPerStep).toFixed(1)}`,
  )
}

for (const n of [1, 5, 10, 20, 30]) await bench(n)
