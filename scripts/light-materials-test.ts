/**
 * Guards the two lamp regressions:
 *  1. Painting a car must NOT repaint its headlights. The M3's lamp strip
 *     is a white emissive material with useless names, so the generic
 *     paint heuristic used to swallow it — black car, black lights.
 *  2. Brake lights must be per-instance clones that brighten under load.
 *     Materials are shared with the cached source GLB, so writing
 *     emissiveIntensity in place would light every copy of the car.
 *
 * Run: bun scripts/light-materials-test.ts
 */
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js"
import * as THREE from "three"
import { tintCar, whitenRims } from "../src/mainview/systems/carTint"
import {
  brakeGlowIsBlown,
  collectBrakeLights,
} from "../src/mainview/systems/carLights"
import { CarVisual } from "../src/mainview/systems/CarVisual"
import type { BrakeLight } from "../src/mainview/systems/carLights"

let failures = 0
function check(ok: boolean, label: string, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"} ${label}${detail ? ` — ${detail}` : ""}`)
  if (!ok) failures++
}

async function loadScene(file: string): Promise<THREE.Object3D> {
  const buf = await Bun.file(`src/mainview/models/${file}`).arrayBuffer()
  const glb: any = await new GLTFLoader().parseAsync(buf, "")
  return glb.scene as THREE.Object3D
}

/** Materials in the scene by name, after any tint pass rewired them. */
function materialsByName(root: THREE.Object3D): Map<string, THREE.Material> {
  const out = new Map<string, THREE.Material>()
  root.traverse((o: any) => {
    if (!o.isMesh) return
    const mats = Array.isArray(o.material) ? o.material : [o.material]
    for (const m of mats) if (m?.name) out.set(m.name, m)
  })
  return out
}

// 1. Painting the M3 black must leave its white headlight strip alone.
{
  const model = (await loadScene("bmw_m3.glb")).clone(true)
  const painted = tintCar(model, 0x000000)
  whitenRims(model)
  check(
    !painted.some((m) => m.name === "Material.019"),
    "M3 headlight is left out of the tint pass",
  )
  const lamp = materialsByName(model).get(
    "Material.019",
  ) as THREE.MeshStandardMaterial
  check(
    lamp.color.getHexString() === "e7e7e7",
    "M3 headlight keeps its white base color under black paint",
    `got #${lamp.color.getHexString()}`,
  )
  check(
    Math.abs((lamp.emissiveIntensity ?? 0) - 6.81) < 0.01,
    "M3 headlight keeps its authored glow",
    `emissiveIntensity=${lamp.emissiveIntensity}`,
  )
  const body = materialsByName(model).get(
    "Material.015",
  ) as THREE.MeshStandardMaterial
  check(
    body.color.getHexString() === "000000",
    "M3 body still takes the paint",
    `got #${body.color.getHexString()}`,
  )
}

// 2. Brake lights: detected, cloned, and driven by setBrake.
{
  const model = (await loadScene("bmw_m3.glb")).clone(true)
  tintCar(model, 0x000000)
  const lights = collectBrakeLights(model)
  check(lights.length === 1, "M3 red tail lamp found", `found ${lights.length}`)
  const idle0 = lights[0]?.idle ?? -1
  check(
    idle0 > 0.5 && idle0 < 1.5,
    "tail lamp is scaled into display range at rest",
    `idle=${idle0.toFixed(2)} (authored 10)`,
  )

  // CarVisual.load() needs a fetchable baseUrl; hand the already-collected
  // lamps to the instance so this still drives the real setBrake code.
  const visual = new CarVisual()
  ;(visual as unknown as { brakeLights: BrakeLight[] }).brakeLights = lights
  // Drive the same smoothing the game uses, through the real API.
  const lamp = lights[0]!.mat
  const drive = (level: number, times: number) => {
    for (let i = 0; i < times; i++) visual.setBrake(level)
  }
  drive(0, 60)
  const idle = lamp.emissiveIntensity ?? -1
  drive(1, 1)
  const on = lamp.emissiveIntensity ?? -1
  // LEDs: one frame is full brightness, and one frame back is off. Any
  // ramp here would read as a filament warming up.
  check(on > idle * 1.5, "brake glow brightens under load", `${idle} -> ${on}`)
  check(
    on === lights[0]!.idle * (1 + 3.4),
    "single frame reaches full brake brightness (no fade-in)",
    `${on}`,
  )
  // No tone mapping or bloom: pushing the heat far enough clips the green
  // and blue channels too, and the lamp reads as a reverse light. Captured
  // while braked — after release the colour is back to plain red.
  const lit = lamp.emissive.clone().multiplyScalar(on)
  check(
    lit.g > 0.05 && !brakeGlowIsBlown(lights[0]!),
    "brake glow is red-hot, not blown to white",
    `rgb ${lit.r.toFixed(2)}/${lit.g.toFixed(2)}/${lit.b.toFixed(2)}`,
  )
  drive(0, 1)
  const released = lamp.emissiveIntensity ?? -1
  check(
    released === idle,
    "single frame returns to running lights (no afterglow)",
    `${released} vs ${idle}`,
  )
  const authored = lights[0]!.glow.clone()
  check(
    lamp.emissive.getHex() === authored.getHex(),
    "lamp colour returns to its authored red",
    `#${lamp.emissive.getHexString()}`,
  )

  // Clone isolation: a second car of the same model must not share them.
  const other = collectBrakeLights((await loadScene("bmw_m3.glb")).clone(true))
  check(
    other[0]?.mat !== lights[0]?.mat,
    "each car owns its own lamp materials",
  )
}

// 3. Fleet coverage: every car that CAN show lamps must find them, and the
//    one that bakes lamps into a shared texture must find none.
{
  const EXPECTED: Record<string, number> = {
    "bmw_m3.glb": 1,
    "audi_r8.glb": 2, // rear strip + its own dimmer brake strip
    "lamborghini_urus.glb": 1,
    "g_wagon.glb": 0, // shell, glass and lights share one textured material
  }
  for (const [file, want] of Object.entries(EXPECTED)) {
    const found = collectBrakeLights(await loadScene(file))
    check(
      found.length === want,
      `${file} lamp count`,
      `want ${want}, found ${found.length}`,
    )
  }
}

console.log(failures ? `\n${failures} check(s) failed` : "\nall checks passed")
if (failures) process.exit(1)
