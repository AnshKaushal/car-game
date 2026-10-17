import * as THREE from "three"

const PAINT_NAMES = /body|paint|chassis|hood|door|bumper|fender|bonnet|shell/i
const SKIP_NAMES =
  /glass|window|light|lamp|wheel|tire|tyre|rim|brake|caliper|interior|chrome|mirror/i

function isLampMaterial(mat: THREE.Material): boolean {
  const emissive = (mat as THREE.MeshStandardMaterial).emissive
  if (!emissive) return false
  return emissive.r + emissive.g + emissive.b > 0.02
}

function isPaintMaterial(mat: THREE.Material, meshName: string): boolean {
  const name = `${mat.name} ${meshName}`
  if (SKIP_NAMES.test(name)) return false
  if (isLampMaterial(mat)) return false
  if (PAINT_NAMES.test(name)) return true
  const std = mat as THREE.MeshStandardMaterial
  if (!std.color) return false
  if (
    std.metalness !== undefined &&
    std.metalness > 0.85 &&
    std.roughness < 0.25
  )
    return false
  const c = std.color
  const max = Math.max(c.r, c.g, c.b)
  const min = Math.min(c.r, c.g, c.b)
  return max > 0.15 && max - min < 0.18 && c.b >= c.r * 0.7
}

export const PAINT_SWATCHES: { name: string; value: number | null }[] = [
  { name: "Stock", value: null },
  { name: "Black", value: 0x000000 },
  { name: "White", value: 0xf5f5f5 },
  { name: "Silver", value: 0x9aa0a6 },
  { name: "Red", value: 0xe30613 },
  { name: "Blue", value: 0x1f6feb },
  { name: "Orange", value: 0xf97316 },
  { name: "Green", value: 0x1f8a4c },
  { name: "Yellow", value: 0xf5c518 },
  { name: "Purple", value: 0xa855f7 },
  { name: "Pink", value: 0xf472b6 },
  { name: "Teal", value: 0x14b8a6 },
]

export function numberToHex(color: number): string {
  return "#" + color.toString(16).padStart(6, "0")
}
export function hexToNumber(hex: string): number {
  const n = parseInt(hex.replace("#", ""), 16)
  return Number.isFinite(n) ? n & 0xffffff : 0x000000
}

export interface PaintTextureRule {
  keepMap?: boolean
  neutralize?: { color: [number, number, number]; tol: number }
}

export interface TintOptions {
  match?: string[]
  texture?: PaintTextureRule
}

const neutralCache = new Map<string, THREE.Texture>()

function neutralizedMap(
  map: THREE.Texture,
  target: [number, number, number],
  tol: number,
): THREE.Texture | null {
  const key = `${map.uuid}|${target.join(",")}|${tol}`
  const hit = neutralCache.get(key)
  if (hit) return hit
  if (typeof document === "undefined") return null
  const img = map.image as
    HTMLImageElement | HTMLCanvasElement | ImageBitmap | null | undefined
  const w = (img as { width?: number } | null)?.width ?? 0
  const h = (img as { height?: number } | null)?.height ?? 0
  if (!img || !w || !h) return null
  try {
    const cv = document.createElement("canvas")
    cv.width = w
    cv.height = h
    const ctx = cv.getContext("2d", { willReadFrequently: true })
    if (!ctx) return null
    ctx.drawImage(img, 0, 0)
    const data = ctx.getImageData(0, 0, w, h)
    const p = data.data
    const [tr, tg, tb] = target
    const limit = tol * 3
    for (let i = 0; i < p.length; i += 4) {
      const d =
        Math.abs(p[i] - tr) + Math.abs(p[i + 1] - tg) + Math.abs(p[i + 2] - tb)
      if (d <= limit) {
        p[i] = 255
        p[i + 1] = 255
        p[i + 2] = 255
      }
    }
    ctx.putImageData(data, 0, 0)
    const out = new THREE.CanvasTexture(cv)
    out.colorSpace = map.colorSpace
    out.wrapS = map.wrapS
    out.wrapT = map.wrapT
    out.repeat.copy(map.repeat)
    out.offset.copy(map.offset)
    out.rotation = map.rotation
    out.center.copy(map.center)
    out.flipY = map.flipY
    neutralCache.set(key, out)
    return out
  } catch {
    return null
  }
}

export function tintCar(
  root: THREE.Object3D,
  color: number,
  opts?: TintOptions,
): THREE.MeshStandardMaterial[] {
  const tint = new THREE.Color(color)
  const regs = (opts?.match ?? []).flatMap((s) => {
    try {
      return [new RegExp(s, "i")]
    } catch {
      return []
    }
  })
  const texRule = opts?.texture
  const tinted: THREE.MeshStandardMaterial[] = []
  root.traverse((o) => {
    const mesh = o as THREE.Mesh
    if (!mesh.isMesh || !mesh.material) return
    const src = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
    let changed = false
    const next = src.map((mat) => {
      const name = `${mat.name} ${mesh.name}`
      if (SKIP_NAMES.test(name)) return mat
      let paint: boolean
      if (regs.length > 0) {
        paint = regs.some((r) => r.test(mat.name) || r.test(mesh.name))
      } else {
        paint = isPaintMaterial(mat, mesh.name)
      }
      if (!paint) return mat
      changed = true
      const clone = mat.clone() as THREE.MeshStandardMaterial
      if (clone.color) {
        clone.color.copy(tint)
      }
      if (texRule?.keepMap) {
        if (texRule.neutralize && clone.map) {
          const neutral = neutralizedMap(
            clone.map,
            texRule.neutralize.color,
            texRule.neutralize.tol,
          )
          if (neutral) clone.map = neutral
        }
      } else {
        if (clone.metalness !== undefined) {
          clone.metalness = Math.max(clone.metalness, 0.45)
          clone.roughness = Math.min(clone.roughness ?? 0.4, 0.45)
        }
        clone.map = null
        clone.emissiveMap = null
        if (clone.emissive) clone.emissive.setRGB(0, 0, 0)
        clone.metalnessMap = null
        clone.roughnessMap = null
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
  0xe30613, 0x1f6feb, 0xf5c518, 0x1f8a4c, 0xf97316, 0xa855f7, 0x14b8a6,
  0xf472b6, 0x94a3b8, 0x84cc16, 0xf8fafc, 0x111827, 0x0ea5e9, 0x92400e,
  0x7f1d1d, 0x14532d, 0xe7d8b7, 0x334155, 0xb45309, 0x67e8f9,
]

export const DEFAULT_PLAYER_COLOR = 0x000000

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
