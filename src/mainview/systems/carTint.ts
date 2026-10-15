import * as THREE from "three"

const PAINT_NAMES = /body|paint|chassis|hood|door|bumper|fender|bonnet|shell/i
const SKIP_NAMES =
  /glass|window|light|lamp|wheel|tire|tyre|rim|brake|caliper|interior|chrome|mirror/i

function isPaintMaterial(mat: THREE.Material, meshName: string): boolean {
  const name = `${mat.name} ${meshName}`
  if (SKIP_NAMES.test(name)) return false
  if (PAINT_NAMES.test(name)) return true
  const std = mat as THREE.MeshStandardMaterial
  if (!std.color) return false
  if (std.metalness !== undefined && std.metalness > 0.85 && std.roughness < 0.25)
    return false
  const c = std.color
  const max = Math.max(c.r, c.g, c.b)
  const min = Math.min(c.r, c.g, c.b)
  return max > 0.15 && max - min < 0.18 && c.b >= c.r * 0.7
}

/** Clone materials and recolor body panels so opponents read as different cars.
 * Returns the tinted clones so callers can recolor later (e.g. when a peer
 * changes paint after joining — see RemoteCar.setColor). */
export function tintCar(
  root: THREE.Object3D,
  color: number,
): THREE.MeshStandardMaterial[] {
  const tint = new THREE.Color(color)
  const tinted: THREE.MeshStandardMaterial[] = []
  root.traverse((o) => {
    const mesh = o as THREE.Mesh
    if (!mesh.isMesh || !mesh.material) return
    const src = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
    let changed = false
    const next = src.map((mat) => {
      if (!isPaintMaterial(mat, mesh.name)) return mat
      changed = true
      const clone = mat.clone() as THREE.MeshStandardMaterial
      if (clone.color) {
        clone.color.copy(tint)
        if (clone.metalness !== undefined) {
          clone.metalness = Math.max(clone.metalness, 0.45)
          clone.roughness = Math.min(clone.roughness ?? 0.4, 0.45)
        }
      }
      tinted.push(clone)
      return clone
    })
    if (!changed) return
    mesh.material = Array.isArray(mesh.material) ? next : next[0]
  })
  return tinted
}

export const RIVAL_COLORS = [
  0xe30613,
  0x1f6feb,
  0xf5c518,
  0x1f8a4c,
  0xf97316,
  0xa855f7,
  0x14b8a6,
  0xf472b6,
  0x94a3b8,
  0x84cc16,
  0xf8fafc,
  0x111827,
  0x0ea5e9,
  0x92400e,
  0x7f1d1d,
  0x14532d,
  0xe7d8b7,
  0x334155,
  0xb45309,
  0x67e8f9,
]

/** The player's paint when they haven't picked one: black. */
export const DEFAULT_PLAYER_COLOR = 0x000000

/**
 * Rims render dark against black tires unless forced white. The GLB uses
 * generic material names, but Material.029 is only ever referenced by the
 * four wheel meshes (tires are Material.016, pure black) — so match by
 * name. Materials are cloned, never mutated: the source model is shared
 * across every car. Call before any geometry merging.
 */
const RIM_MATERIAL = /^Material\.029$/i
export function whitenRims(root: THREE.Object3D): void {
  const cache = new Map<string, THREE.MeshStandardMaterial>()
  root.traverse((o) => {
    const mesh = o as THREE.Mesh
    if (!mesh.isMesh || !mesh.material) return
    const src = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
    let changed = false
    const next = src.map((mat) => {
      const std = mat as THREE.MeshStandardMaterial
      if (!std.color || !RIM_MATERIAL.test(std.name ?? "")) return mat
      changed = true
      let white = cache.get(std.uuid)
      if (!white) {
        white = std.clone()
        // Flat white, non-metal: metallic surfaces go dark with no envmap.
        white.color.set(0xffffff)
        white.metalness = 0
        white.roughness = Math.min(white.roughness ?? 0.5, 0.45)
        cache.set(std.uuid, white)
      }
      return white
    })
    if (!changed) return
    mesh.material = Array.isArray(mesh.material) ? next : next[0]
  })
}

export function rivalColor(index: number): number {
  return RIVAL_COLORS[index % RIVAL_COLORS.length]
}

export function colorHex(color: number): string {
  return "#" + color.toString(16).padStart(6, "0")
}
