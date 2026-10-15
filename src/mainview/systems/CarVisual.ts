import * as THREE from "three"
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js"
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js"
import type * as RAPIER from "@dimforge/rapier3d-compat"
import { CAR_PHYSICS } from "../constants/physics"
import type { WheelDef } from "./Suspension"
import { tintCar, whitenRims } from "./carTint"

export const CAR_MODEL_YAW = Math.PI

export const SUSP_VISUAL_REF = 0.074

export interface CarVisualOptions {
  /** GLB path under baseUrl. Defaults to the M3 (legacy behaviour). */
  modelFile?: string
  /** Real-world length the model auto-scales to. */
  targetLength?: number
  /** Wheel pivot lookup — explicit names win, else regex. */
  pivots?: { pattern?: string; names?: string[] }
  /** Fallback/imposter wheel positions (used when != 4 pivots found). */
  wheelSpots?: readonly WheelDef[]
  /** Wheel radius for fallback cylinders + imposter. */
  wheelRadius?: number
}

/** Pivot candidates thinner than this fraction of the body length are
 *  brake hardware, not wheels (R8 calipers are ~1.4%, tires ~7%).
 *  Exported so the headless car-matrix script enforces the same rule. */
export const MIN_PIVOT_FRAC = 0.025

const DEFAULT_MODEL = "models/bmw_m3.glb"
const DEFAULT_PIVOT_PATTERN = "^Plane00[3-6]$"

const modelCache = new Map<
  string,
  THREE.Object3D | Promise<THREE.Object3D | null>
>()

// Scratch vector for the body-space origin drop in syncFromPose.
const _poseOff = new THREE.Vector3()

// Low-poly imposter kit: shared per wheel radius (~200 tris total).
// Distant rivals render this (2 draw calls) instead of the full GLB.
let loBodyGeo: THREE.BufferGeometry | null = null
let loCabinGeo: THREE.BufferGeometry | null = null
const loWheelGeos = new Map<number, THREE.BufferGeometry>()
const loWheelMat = new THREE.MeshStandardMaterial({
  color: 0x141414,
  roughness: 0.9,
})

function loGeos(wheelRadius: number): {
  body: THREE.BufferGeometry
  cabin: THREE.BufferGeometry
  wheel: THREE.BufferGeometry
} {
  if (!loBodyGeo || !loCabinGeo) {
    loBodyGeo = new THREE.BoxGeometry(1.8, 0.55, 4.7)
    loCabinGeo = new THREE.BoxGeometry(1.6, 0.5, 2.1)
  }
  let wheel = loWheelGeos.get(wheelRadius)
  if (!wheel) {
    const w = new THREE.CylinderGeometry(wheelRadius, wheelRadius, 0.26, 8)
    w.rotateZ(Math.PI / 2)
    wheel = w
    loWheelGeos.set(wheelRadius, wheel)
  }
  return { body: loBodyGeo, cabin: loCabinGeo, wheel }
}

async function loadSharedModel(
  baseUrl: string,
  modelFile: string,
): Promise<THREE.Object3D | null> {
  const key = `${baseUrl}${modelFile}`
  const hit = modelCache.get(key)
  if (hit) return hit
  const load = new GLTFLoader()
    .loadAsync(key)
    .then((glb) => {
      const scene = glb.scene
      modelCache.set(key, scene)
      return scene as THREE.Object3D | null
    })
    .catch((e) => {
      modelCache.delete(key)
      throw e
    })
  modelCache.set(key, load)
  return load
}

export function pivotMatches(
  name: string,
  pivots?: { pattern?: string; names?: string[] },
): boolean {
  if (pivots?.names) return pivots.names.includes(name)
  return new RegExp(pivots?.pattern ?? DEFAULT_PIVOT_PATTERN, "i").test(name)
}

export class CarVisual {
  group = new THREE.Group()
  wheels: {
    mesh: THREE.Object3D
    front: boolean
    left: boolean
    baseY: number
  }[] = []
  private spinAngles = [0, 0, 0, 0]
  castShadow = true
  private hiBody: THREE.Object3D | null = null
  private loGroup: THREE.Group | null = null
  private hiDetail = true
  /** Paint material clones created by tintCar — recolored live by setTint. */
  private tintedMats: THREE.MeshStandardMaterial[] = []
  /** Imposter body paint, kept in sync with the hi-detail tint. */
  private loPaint: THREE.MeshStandardMaterial | null = null
  /** Newest requested tint; applied at load end if it landed mid-load. */
  private lastTint: number | undefined = undefined
  /** Merged static meshes (body + per-wheel) shown in hi detail. */
  private hiMerged: THREE.Object3D[] = []

  async load(
    baseUrl: string,
    tint?: number,
    opts?: CarVisualOptions,
  ): Promise<void> {
    const modelFile = opts?.modelFile ?? DEFAULT_MODEL
    const source = await loadSharedModel(baseUrl, modelFile)
    if (!source) throw new Error("Model not loaded")
    // A setTint() may have landed while the model was loading — newest wins.
    const effective = this.lastTint ?? tint
    const model = source.clone(true)
    this.tintedMats = effective !== undefined ? tintCar(model, effective) : []
    whitenRims(model)
    model.traverse((o: any) => {
      if (o.isMesh) {
        o.castShadow = this.castShadow
        o.receiveShadow = false
      }
    })

    const box = new THREE.Box3().setFromObject(model)
    const size = box.getSize(new THREE.Vector3())
    const targetLen = opts?.targetLength ?? CAR_PHYSICS.dimensions.length
    const longest = Math.max(size.x, size.y, size.z)
    const s = longest > 0 ? targetLen / longest : 1
    model.scale.multiplyScalar(s)

    let boxA = new THREE.Box3().setFromObject(model)
    const sx0 = boxA.max.x - boxA.min.x
    const sz0 = boxA.max.z - boxA.min.z
    let alignYaw = 0
    if (sx0 > sz0) alignYaw = Math.PI / 2
    model.rotation.y = alignYaw + CAR_MODEL_YAW
    boxA = new THREE.Box3().setFromObject(model)
    model.position.x -= (boxA.min.x + boxA.max.x) / 2
    model.position.z -= (boxA.min.z + boxA.max.z) / 2
    model.position.y -= boxA.min.y
    this.group.add(model)
    this.hiBody = model
    this.buildImposter(
      this.lastTint ?? tint,
      opts?.wheelSpots,
      opts?.wheelRadius ?? CAR_PHYSICS.wheels.radius,
    )

    this.group.updateMatrixWorld(true)
    const wheelGroups: THREE.Object3D[] = []
    // Pivot = non-mesh node with children whose name matches the car's
    // pivot spec. Thinner-than-a-tire matches (brake discs, calipers)
    // are dropped by the min-size filter.
    const pivotBox = new THREE.Box3()
    const pivotSize = new THREE.Vector3()
    const minPivot = longest * s * MIN_PIVOT_FRAC
    model.traverse((o: any) => {
      if (
        !o.isMesh &&
        o.children.length > 0 &&
        pivotMatches(o.name, opts?.pivots)
      ) {
        pivotBox.setFromObject(o)
        pivotBox.getSize(pivotSize)
        if (
          pivotSize.x < minPivot ||
          pivotSize.y < minPivot ||
          pivotSize.z < minPivot
        ) {
          return
        }
        wheelGroups.push(o)
      }
    })

    if (wheelGroups.length === 4) {
      const wbox = new THREE.Box3()
      const center = new THREE.Vector3()
      for (const wg of wheelGroups) {
        wbox.setFromObject(wg)
        wbox.getCenter(center)
        this.group.worldToLocal(center)
        const pivot = new THREE.Group()
        pivot.position.copy(center)
        pivot.rotation.order = "YXZ"
        this.group.add(pivot)
        pivot.attach(wg)
        const front = center.z < 0
        this.wheels.push({
          mesh: pivot,
          front,
          left: center.x < 0,
          baseY: pivot.position.y,
        })
      }
    }

    if (this.wheels.length !== 4) {
      this.wheels = []
      const wr = opts?.wheelRadius ?? CAR_PHYSICS.wheels.radius
      const geo = new THREE.CylinderGeometry(wr, wr, 0.26, 18)
      geo.rotateZ(Math.PI / 2)
      const mat = new THREE.MeshStandardMaterial({
        color: 0x141414,
        roughness: 0.9,
      })
      const rimG = new THREE.CylinderGeometry(wr * 0.58, wr * 0.58, 0.27, 8)
      rimG.rotateZ(Math.PI / 2)
      const rimM = new THREE.MeshStandardMaterial({
        color: 0xffffff,
        metalness: 0,
        roughness: 0.4,
      })
      const spots: readonly WheelDef[] = opts?.wheelSpots ?? [
        { x: -0.76, z: -1.51, front: true, left: true },
        { x: 0.76, z: -1.51, front: true, left: false },
        { x: -0.76, z: 1.31, front: false, left: true },
        { x: 0.76, z: 1.31, front: false, left: false },
      ]
      for (const sp of spots) {
        const pivot = new THREE.Group()
        pivot.position.set(sp.x, wr, sp.z)
        pivot.rotation.order = "YXZ"
        const w = new THREE.Mesh(geo, mat)
        w.castShadow = this.castShadow
        const rim = new THREE.Mesh(rimG, rimM)
        pivot.add(w, rim)
        this.group.add(pivot)
        this.wheels.push({
          mesh: pivot,
          front: sp.front,
          left: sp.left,
          baseY: pivot.position.y,
        })
      }
    }
    this.wheels.sort(
      (a, b) =>
        (a.front ? 0 : 2) + (a.left ? 0 : 1) - ((b.front ? 0 : 2) + (b.left ? 0 : 1)),
    )
    // Merge each car's GLB into a handful of meshes (one per material):
    // a 50-car pack goes from thousands of draw calls to ~10 per car.
    // Wheels merge per-pivot so steer/spin keeps working. Any bucket that
    // can't merge cleanly is left as original meshes (safe fallback).
    this.mergeStatic()
  }

  /** Cheap stand-in body (~200 tris, 2 draw calls) for distant cars. */
  private buildImposter(
    tint?: number,
    wheelSpots?: readonly WheelDef[],
    wheelRadius?: number,
  ) {
    const wr = wheelRadius ?? CAR_PHYSICS.wheels.radius
    const g = loGeos(wr)
    const lo = new THREE.Group()
    const paint = new THREE.MeshStandardMaterial({
      color: tint ?? 0x8a8f96,
      roughness: 0.6,
      metalness: 0.3,
    })
    this.loPaint = paint
    const glass = new THREE.MeshStandardMaterial({
      color: 0x101418,
      roughness: 0.25,
      metalness: 0.6,
    })
    const bodyM = new THREE.Mesh(g.body, paint)
    bodyM.position.y = 0.55
    const cabinM = new THREE.Mesh(g.cabin, glass)
    cabinM.position.set(0, 1.05, 0.25)
    lo.add(bodyM, cabinM)
    const spots = (wheelSpots ?? [
      { x: -0.76, z: -1.51 },
      { x: 0.76, z: -1.51 },
      { x: -0.76, z: 1.31 },
      { x: 0.76, z: 1.31 },
    ]) as readonly { x: number; z: number }[]
    for (const { x, z } of spots) {
      const w = new THREE.Mesh(g.wheel, loWheelMat)
      w.position.set(x, wr, z)
      lo.add(w)
    }
    lo.visible = false
    this.group.add(lo)
    this.loGroup = lo
  }

  /**
   * Swap full model <-> imposter. Far cars cost 2 draw calls instead of
   * the whole GLB, which is what makes 50-car fields affordable.
   */
  setDetail(hi: boolean) {
    if (hi === this.hiDetail) return
    if (!this.hiBody || !this.loGroup) return
    this.hiDetail = hi
    this.hiBody.visible = hi
    for (const w of this.wheels) w.mesh.visible = hi
    for (const m of this.hiMerged) m.visible = hi
    this.loGroup.visible = !hi
  }

  private mergeStatic() {
    if (!this.hiBody) return
    this.group.updateMatrixWorld(true)
    const skip = new Set<THREE.Object3D>()
    if (this.loGroup) skip.add(this.loGroup)
    for (const w of this.wheels) {
      w.mesh.traverse((o) => skip.add(o))
    }
    // Body: merge everything except wheels/lo into per-material meshes.
    this.mergeInto([this.hiBody], this.group, null, skip)
    // Wheels: merge each pivot's meshes into itself (keeps steer/spin).
    for (const w of this.wheels) {
      const inv = w.mesh.matrixWorld.clone().invert()
      this.mergeInto([w.mesh], w.mesh, inv, new Set())
    }
  }

  /**
   * Merge descendant meshes of `roots` by material into `target`. Meshes
   * in `exclude` are untouched. Originals hide only on success, and the
   * merged meshes are tracked for detail swaps.
   */
  private mergeInto(
    roots: THREE.Object3D[],
    target: THREE.Object3D,
    toLocal: THREE.Matrix4 | null,
    exclude: Set<THREE.Object3D>,
  ) {
    const buckets = new Map<
      string,
      { mat: THREE.Material; geos: THREE.BufferGeometry[]; src: THREE.Mesh[] }
    >()
    const visit = (o: THREE.Object3D) => {
      if (exclude.has(o)) return
      const mesh = o as THREE.Mesh
      if (mesh.isMesh && !(mesh as any).isSkinnedMesh) {
        const mat = mesh.material as THREE.Material | THREE.Material[]
        const g = mesh.geometry as THREE.BufferGeometry | undefined
        if (
          mat && !Array.isArray(mat) && g && g.getAttribute("position") &&
          Object.keys(g.morphAttributes ?? {}).length === 0 &&
          !(mat as any).vertexColors
        ) {
          const needsUv = !!(mat as any).map
          if (!needsUv || g.getAttribute("uv")) {
            let b = buckets.get(mat.uuid)
            if (!b) {
              b = { mat, geos: [], src: [] }
              buckets.set(mat.uuid, b)
            }
            b.geos.push(g)
            b.src.push(mesh)
          }
        }
      }
      for (const c of o.children) visit(c)
    }
    for (const r of roots) visit(r)
    for (const { mat, geos, src } of buckets.values()) {
      if (geos.length < 2) continue
      const hasUv = geos.every((g) => !!g.getAttribute("uv"))
      const prepped: THREE.BufferGeometry[] = []
      for (let i = 0; i < geos.length; i++) {
        const g = geos[i].clone()
        if (toLocal) g.applyMatrix4(toLocal.clone().multiply(src[i].matrixWorld))
        else g.applyMatrix4(src[i].matrixWorld)
        const ng = g.index ? g.toNonIndexed() : g
        if (!hasUv) ng.deleteAttribute("uv")
        ng.deleteAttribute("tangent")
        ng.deleteAttribute("uv1")
        ng.deleteAttribute("uv2")
        ng.deleteAttribute("uv3")
        ng.deleteAttribute("color")
        prepped.push(ng)
      }
      let merged: THREE.BufferGeometry | null = null
      try {
        merged = mergeGeometries(prepped, false)
      } catch {
        merged = null
      }
      for (const g of prepped) g.dispose()
      if (!merged) continue
      for (const m of src) m.visible = false
      const out = new THREE.Mesh(merged, mat)
      out.castShadow = this.castShadow
      out.receiveShadow = false
      target.add(out)
      this.hiMerged.push(out)
    }
  }

  /** Runtime shadow toggle — far cars skip the depth pass entirely. */
  setCastShadow(on: boolean) {
    if (on === this.castShadow) return
    this.castShadow = on
    this.group.traverse((o: any) => {
      if (o.isMesh) o.castShadow = on
    })
  }

  /**
   * Recolor body paint live (hi-detail clones, merged meshes sharing them,
   * and the imposter). Safe to call before load finishes — the newest tint
   * is applied when loading completes.
   */
  setTint(color: number) {
    this.lastTint = color
    const c = new THREE.Color(color)
    for (const m of this.tintedMats) m.color.copy(c)
    this.loPaint?.color.copy(c)
  }

  /**
   * True when a tint pass ran at load (stock-paint cars have no tinted
   * clones, so setTint would silently do nothing — callers reload instead).
   */
  hasTint(): boolean {
    return this.tintedMats.length > 0
  }

  wheelContactPositions(    includeFront: boolean,
    out: THREE.Vector3[],
  ): THREE.Vector3[] {
    out.length = 0
    const p = new THREE.Vector3()
    for (const w of this.wheels) {
      if (!includeFront && w.front) continue
      w.mesh.getWorldPosition(p)
      out.push(new THREE.Vector3(p.x, 0.12, p.z))
    }
    return out
  }
  syncFromBody(
    body: RAPIER.RigidBody,
    steerAngle: number,
    wheelOmegas: readonly number[],
    dt: number,
    compressions?: readonly number[],
  ) {
    const t = body.translation()
    const r = body.rotation()
    this.syncFromPose(t, r, steerAngle, wheelOmegas, dt, compressions)
  }

  syncFromPose(
    pos: { x: number; y: number; z: number },
    rot: { x: number; y: number; z: number; w: number },
    steerAngle: number,
    wheelOmegas: readonly number[],
    dt: number,
    compressions?: readonly number[],
  ) {
    // The -0.72 origin drop must ride in BODY space, not world space:
    // applied in world Y it stays correct only while upright. Rolled or
    // flipped, a world-space drop shoves the whole model down through
    // the ground while the physics body correctly rests on its roof.
    this.group.quaternion.set(rot.x, rot.y, rot.z, rot.w)
    _poseOff.set(0, -0.72, 0).applyQuaternion(this.group.quaternion)
    this.group.position.set(pos.x + _poseOff.x, pos.y + _poseOff.y, pos.z + _poseOff.z)

    for (let i = 0; i < this.wheels.length; i++) {
      const w = this.wheels[i]
      const pivot = w.mesh
      pivot.rotation.y = w.front ? steerAngle : 0
      this.spinAngles[i] -= (wheelOmegas[i] ?? 0) * dt
      pivot.rotation.x = this.spinAngles[i]
      if (compressions && i < compressions.length) {
        const c = compressions[i] ?? SUSP_VISUAL_REF
        pivot.position.y =
          w.baseY +
          Math.max(-0.06, Math.min(0.18, c - SUSP_VISUAL_REF))
      }
    }
  }
}
