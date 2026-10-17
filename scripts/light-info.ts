/**
 * Per-material report for a car's GLB — the lamps in particular. Use it
 * while adding a car (see cars.ts) to see what the paint heuristic will and
 * won't catch: `PAINT`-column materials get tinted, `LAMP` materials stay
 * stock and can glow as brake lights.
 *
 * Run: bun scripts/light-info.ts bmw-m3
 *      bun scripts/light-info.ts models/audi_r8.glb
 */
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js"
import * as THREE from "three"
import { CARS, getCar } from "../src/mainview/constants/cars"

const arg = process.argv[2] ?? "bmw-m3"
const file = arg.includes("/")
  ? arg
  : getCar(arg).modelFile.replace(/^models\//, "")

const car = CARS.find((c) => c.modelFile.endsWith(file))
if (!car) console.log(`(no registry entry for ${file} — reporting anyway)`)

const buf = await Bun.file(`src/mainview/models/${file}`).arrayBuffer()
const glb: any = await new GLTFLoader().parseAsync(buf, "")

const hex = (c?: THREE.Color) => (c ? "#" + c.getHexString() : "-")
const isRed = (c: THREE.Color) =>
  c.r > 0.12 && c.r > c.g * 1.7 && c.r > c.b * 1.7
const lit = (s: THREE.MeshStandardMaterial) =>
  s.emissive.r + s.emissive.g + s.emissive.b > 0.02

const rows: string[] = []
glb.scene.traverse((o: any) => {
  if (!o.isMesh) return
  const size = new THREE.Box3().setFromObject(o).getSize(new THREE.Vector3())
  const mats = Array.isArray(o.material) ? o.material : [o.material]
  for (const m of mats) {
    const s = m as THREE.MeshStandardMaterial
    const tag = lit(s)
      ? isRed(s.emissive) || isRed(s.color)
        ? "LAMP"
        : "lit"
      : ""
    rows.push(
      [
        (o.name || "-").padEnd(26).slice(0, 26),
        (m.name || "-").padEnd(14).slice(0, 14),
        `col=${hex(s.color)}`.padEnd(15),
        `emi=${hex(s.emissive)}`.padEnd(16),
        `ei=${(s.emissiveIntensity ?? 1).toFixed(2)}`.padEnd(9),
        `met=${(s.metalness ?? -1).toFixed(2)}`.padEnd(10),
        `rgh=${(s.roughness ?? -1).toFixed(2)}`.padEnd(9),
        `size=${size.x.toFixed(2)}x${size.y.toFixed(2)}x${size.z.toFixed(2)}`,
        tag,
      ].join(" "),
    )
  }
})
console.log(
  `${file}${car ? ` (${car.name})` : ""} — paintMatch=${car?.paintMatch ?? "heuristic"}`,
)
console.log(rows.join("\n"))
