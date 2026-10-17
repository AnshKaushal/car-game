import * as THREE from "three"

/** One brake-light material owned by a single car. */
export interface BrakeLight {
  mat: THREE.MeshStandardMaterial
  /** Running-light intensity, already scaled into display range. */
  idle: number
  /** Authored emissive color, kept so the glow can be reheated from it. */
  glow: THREE.Color
}

/** Where a lamp sits at full brake: a hot LED red, not white. */
export const BRAKE_HEAT = new THREE.Color(0xff3d38)

/* The GLBs author their lamps at 6.8-10 for an HDR pipeline with bloom.
 * This renderer has neither, so that raw value clips to flat red — and
 * anything added on top of it (heat, or just more intensity) lands on
 * white immediately, which reads as reverse lights rather than brakes.
 * Scaling into range at clone time is what makes the difference visible:
 * red at rest, hot red under load. Proportional, so the R8's deliberately
 * dimmer brake strip still reads as a strip that switches on instead of
 * one that matches its tail lights. */
const LAMP_RANGE = 0.16
const LAMP_IDLE = 0.62
/** How much brighter than running lights a fully-lit lamp gets. */
const LAMP_BRAKE = 3.4
/** How far toward BRAKE_HEAT a fully-lit lamp goes. 0.8 pushes the red
 *  channel's saturation down hard without clipping the green/blue
 *  channels to white — see applyBrakeHeat. */
const HEAT_MIX = 0.8

/**
 * Write a lamp's emissive for a given `heat` (0 = running lights, 1 = full
 * brake). Called every frame while the value is changing, so a settled lamp
 * costs nothing.
 */
export function applyBrakeHeat(l: BrakeLight, heat: number) {
  l.mat.emissiveIntensity = l.idle * (1 + LAMP_BRAKE * heat)
  l.mat.emissive.copy(l.glow).lerp(BRAKE_HEAT, heat * HEAT_MIX)
}

/** True when a lamp is so hot it has clipped to white — reverse lights,
 *  not brake lights. Guards the HEAT_MIX/LAMP_BRAKE pairing: they are the
 *  only two knobs standing between "brighter" and "blown out". */
export function brakeGlowIsBlown(l: BrakeLight): boolean {
  const c = l.mat.emissive.clone().multiplyScalar(l.mat.emissiveIntensity)
  return c.g > c.r * 0.6
}

/** Red-ish test on a linear-space color (Color channels are linear, so the
 *  usual sRGB 0.21 luma cutoff would miss deep reds). */
function isRed(c: THREE.Color): boolean {
  return c.r > 0.12 && c.r > c.g * 1.7 && c.r > c.b * 1.7
}

/**
 * Tail/brake lamps, told apart by glowing red rather than by name: the GLBs
 * name their materials "Material.018" and their meshes "Plane002_...", so
 * there is nothing in the names to match on.
 *
 * Red shows up in two different places across the fleet — the M3 (#ff4c4c)
 * and Urus (#ff0000) tint the lamp body red, the R8's lamps are white
 * plastic with a red emissive — so either channel counts. Requiring an
 * emissive color is what keeps matte red PAINT out of the set (a red car is
 * not a brake light).
 *
 * Cars whose lamps are baked into a texture behind one shared material
 * (G-Wagen: a single "body" material for shell, glass and lights alike) have
 * nothing separable to clone and are correctly left out.
 */
function isBrakeLamp(mat: THREE.Material): boolean {
  const std = mat as THREE.MeshStandardMaterial
  if (!std.emissive || !std.color) return false
  if (std.emissive.r + std.emissive.g + std.emissive.b <= 0.02) return false
  return isRed(std.emissive) || isRed(std.color)
}

/**
 * Clone this car's red lamp materials and hand them back so it can light
 * them on its own. Materials MUST be cloned: `Object3D.clone()` shares them
 * with the cached source GLB, so writing emissiveIntensity on the source
 * would light up every other copy of the same model in the world. Mirrors
 * what whitenRims does for rims.
 *
 * Call before any geometry merging — mergeStatic buckets by material, so a
 * merged lamp mesh keeps pointing at the clone and the originals hide.
 */
export function collectBrakeLights(root: THREE.Object3D): BrakeLight[] {
  const bySource = new Map<string, BrakeLight>()
  root.traverse((o) => {
    const mesh = o as THREE.Mesh
    if (!mesh.isMesh || !mesh.material) return
    const src = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
    let changed = false
    const next = src.map((mat) => {
      if (!isBrakeLamp(mat)) return mat
      changed = true
      const key = mat.uuid
      let entry = bySource.get(key)
      if (!entry) {
        const clone = (mat as THREE.MeshStandardMaterial).clone()
        const idle = (clone.emissiveIntensity ?? 1) * LAMP_RANGE * LAMP_IDLE
        clone.emissiveIntensity = idle
        entry = { mat: clone, idle, glow: clone.emissive.clone() }
        bySource.set(key, entry)
      }
      return entry.mat
    })
    if (!changed) return
    mesh.material = Array.isArray(mesh.material) ? next : next[0]
  })
  return [...bySource.values()]
}