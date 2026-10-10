import * as THREE from "three"
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js"
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js"
import type * as RAPIER from "@dimforge/rapier3d-compat"
import { WORLD_CONFIG } from "../constants/world"

export function roadCenterX(s: number): number {
  return Math.sin(s * 0.004) * 60 + Math.sin(s * 0.0013 + 1.7) * 120
}
export function roadYaw(s: number): number {
  const dx = (roadCenterX(s + 4) - roadCenterX(s - 4)) / 8
  return Math.atan2(dx, 1)
}

const RIB_DIV = 16

function makeRibbonGeometry(
  len: number,
  div: number,
  width: number,
  vRepeat: number,
): THREE.BufferGeometry {
  const rows = div + 1
  const verts = rows * 2
  const pos = new Float32Array(verts * 3)
  const uv = new Float32Array(verts * 2)
  for (let j = 0; j < rows; j++) {
    const v = (j / div) * vRepeat
    uv[j * 2 * 2 + 0] = 0
    uv[j * 2 * 2 + 1] = v
    uv[(j * 2 + 1) * 2 + 0] = 1
    uv[(j * 2 + 1) * 2 + 1] = v
  }
  const idx: number[] = []
  for (let j = 0; j < div; j++) {
    const a = j * 2,
      b = j * 2 + 1,
      c = (j + 1) * 2,
      d = (j + 1) * 2 + 1
    idx.push(a, b, c, b, d, c)
  }
  const geo = new THREE.BufferGeometry()
  geo.setAttribute("position", new THREE.BufferAttribute(pos, 3))
  geo.setAttribute("uv", new THREE.BufferAttribute(uv, 2))
  geo.setIndex(idx)
  geo.computeVertexNormals()
  void len
  void width
  return geo
}

function writeRibbon(
  geo: THREE.BufferGeometry,
  s0: number,
  len: number,
  div: number,
  width: number,
) {
  const pos = geo.getAttribute("position") as THREE.BufferAttribute
  const half = width / 2
  for (let j = 0; j <= div; j++) {
    const s = s0 + (len * j) / div
    const cx = roadCenterX(s)
    const h = 0.5
    const tx = (roadCenterX(s + h) - roadCenterX(s - h)) / (2 * h)
    const inv = 1 / Math.hypot(tx, 1)
    const nx = inv
    const nz = -tx * inv
    const z = -s
    const l = j * 2,
      r = j * 2 + 1
    pos.setXYZ(l, cx - nx * half, 0, z - nz * half)
    pos.setXYZ(r, cx + nx * half, 0, z + nz * half)
  }
  pos.needsUpdate = true
  geo.computeVertexNormals()
  geo.computeBoundingSphere()
}

function makeAsphaltTexture(): THREE.CanvasTexture {
  const c = document.createElement("canvas")
  c.width = 256
  c.height = 256
  const g = c.getContext("2d")!
  g.fillStyle = "#33363b"
  g.fillRect(0, 0, 256, 256)
  for (let i = 0; i < 2500; i++) {
    const v = 40 + Math.random() * 25
    g.fillStyle = `rgb(${v},${v},${v + 4})`
    g.fillRect(Math.random() * 256, Math.random() * 256, 2, 2)
  }
  g.fillStyle = "#e8e8e8"
  g.fillRect(8, 0, 5, 256)
  g.fillRect(243, 0, 5, 256)
  g.fillStyle = "#d8b93a"
  g.fillRect(124, 0, 4, 256)
  g.fillRect(132, 0, 4, 256)
  g.fillStyle = "#cfcfcf"
  for (let y = 0; y < 256; y += 64) {
    g.fillRect(70, y, 4, 32)
    g.fillRect(182, y, 4, 32)
  }
  const t = new THREE.CanvasTexture(c)
  t.wrapS = t.wrapT = THREE.RepeatWrapping
  t.anisotropy = 4
  t.colorSpace = THREE.SRGBColorSpace
  return t
}

interface RoadSeg {
  mesh: THREE.Mesh
  s0: number
}

interface TreeEntry {
  pos: THREE.Vector3
  rot: number
  scale: number
  variant: number
}

interface Hill {
  mesh: THREE.Mesh
  seg: number
}

export class WorldManager {
  group = new THREE.Group()
  private roadSegs: RoadSeg[] = []
  private segLen = WORLD_CONFIG.road.segmentLength
  private ground!: THREE.Mesh
  private treeMeshes: THREE.InstancedMesh[] = []
  private treeVariants: THREE.Object3D[] = []
  private segTrees = new Map<number, TreeEntry[]>()
  private segMin = 0
  private segMax = -1
  private maxTrees = 900
  private R?: typeof RAPIER
  private physWorld?: RAPIER.World
  private segColliders = new Map<number, RAPIER.Collider[]>()
  private hills: Hill[] = []
  private readonly SEG_BEHIND = 4
  private readonly SEG_AHEAD = 24
  private readonly ROAD_RIB = RIB_DIV
  private loader = new GLTFLoader()

  async init(scene: THREE.Scene, baseUrl: string) {
    const W = WORLD_CONFIG
    scene.add(this.group)
    scene.fog = new THREE.Fog(
      W.environment.fogColor,
      W.environment.fogNear,
      W.environment.fogFar,
    )

    const sun = new THREE.DirectionalLight(W.environment.sunColor, 2.2)
    sun.position.set(120, 180, 60)
    sun.castShadow = true
    sun.shadow.mapSize.set(1024, 1024)
    sun.shadow.camera.left = -80
    sun.shadow.camera.right = 80
    sun.shadow.camera.top = 80
    sun.shadow.camera.bottom = -80
    sun.shadow.camera.far = 500
    this.group.add(sun)
    this.group.add(new THREE.HemisphereLight(0xbdd7ff, 0x3d5a2a, 0.9))
    ;(this.group as any)._sun = sun

    const gGeo = new THREE.PlaneGeometry(1200, 1200, 1, 1)
    const gMat = new THREE.MeshStandardMaterial({
      color: 0x44602f,
      roughness: 1,
    })
    this.ground = new THREE.Mesh(gGeo, gMat)
    this.ground.rotation.x = -Math.PI / 2
    this.ground.position.y = -0.08
    this.ground.receiveShadow = true
    this.group.add(this.ground)

    const hillMat = new THREE.MeshStandardMaterial({
      color: 0x3a5a28,
      roughness: 1,
      flatShading: true,
    })
    for (let i = 0; i < 14; i++) {
      const h = 40 + this.rand(i * 977 + 13) * 80
      const hill = new THREE.Mesh(
        new THREE.ConeGeometry(70 + this.rand(i * 613 + 7) * 110, h, 5),
        hillMat,
      )
      hill.rotation.y = this.rand(i * 311 + 3) * Math.PI
      this.group.add(hill)
      const seg = -2 + i * 2
      this.hills.push({ mesh: hill, seg: -999999 })
      this.placeHill(this.hills[i], seg)
    }

    const tex = makeAsphaltTexture()
    const count = W.road.segmentsAhead + W.road.segmentsBehind
    const roadMat = new THREE.MeshStandardMaterial({
      map: tex.clone(),
      roughness: 0.95,
    })
    this.roadSegs = []
    for (let i = 0; i < count; i++) {
      const geo = makeRibbonGeometry(
        this.segLen,
        this.ROAD_RIB,
        W.road.width,
        this.segLen / 14,
      )
      const m = new THREE.Mesh(geo, roadMat.clone())
      m.material.map = tex.clone()
      m.material.map!.repeat.set(1, 1)
      m.material.map!.needsUpdate = true
      m.receiveShadow = true
      m.frustumCulled = false
      this.group.add(m)
      this.roadSegs.push({ mesh: m, s0: -999999 })
    }

    try {
      const glb = await this.loader.loadAsync(`${baseUrl}models/tree_pack.glb`)
      const root = glb.scene
      root.updateMatrixWorld(true)
      this.treeVariants = extractVariants(root).slice(0, 6)
      if (this.treeVariants.length === 0) this.treeVariants = [root]
    } catch (e) {
      console.warn("tree_pack.glb failed to load, using cone fallback", e)
      const trunk = new THREE.Mesh(
        new THREE.CylinderGeometry(0.25, 0.4, 2.4, 6),
        new THREE.MeshStandardMaterial({ color: 0x5a3a22 }),
      )
      trunk.position.y = 1.2
      const top = new THREE.Mesh(
        new THREE.ConeGeometry(2.2, 5.5, 7),
        new THREE.MeshStandardMaterial({ color: 0x2d5a22, flatShading: true }),
      )
      top.position.y = 5
      const pine = new THREE.Group()
      pine.add(trunk, top)
      this.treeVariants.push(pine)
    }

    const perVariant = Math.ceil(
      this.maxTrees / Math.max(1, this.treeVariants.length),
    )
    this.treeVariants.forEach((variant) => {
      variant.updateMatrixWorld(true)
      const box = new THREE.Box3().setFromObject(variant)
      const size = box.getSize(new THREE.Vector3())
      const norm = size.y > 0.01 ? 6.5 / size.y : 1
      variant.scale.multiplyScalar(norm)
      variant.updateMatrixWorld(true)
      const nbox = new THREE.Box3().setFromObject(variant)
      const ncx = (nbox.min.x + nbox.max.x) / 2
      const ncz = (nbox.min.z + nbox.max.z) / 2

      const geos: THREE.BufferGeometry[] = []
      const mats: THREE.Material[] = []
      variant.traverse((o: any) => {
        if (o.isMesh) {
          const g = (o.geometry as THREE.BufferGeometry)
            .clone()
            .applyMatrix4(o.matrixWorld)
          g.translate(-ncx, -nbox.min.y, -ncz)
          geos.push(g)
          const m = Array.isArray(o.material) ? o.material[0] : o.material
          mats.push(
            m ??
              new THREE.MeshStandardMaterial({ color: 0x2d5a22, roughness: 1 }),
          )
        }
      })
      let geo: THREE.BufferGeometry
      let mat: THREE.Material | THREE.Material[]
      if (geos.length > 1) {
        const merged = mergeGeometries(
          geos.map((g) => (g.index ? g.toNonIndexed() : g)),
          true,
        )
        if (merged) {
          geo = merged
          mat = mats
        } else {
          geo = geos[0]
          mat = mats[0]
        }
      } else if (geos.length === 1) {
        geo = geos[0]
        mat = mats[0]
      } else {
        geo = new THREE.ConeGeometry(2, 6, 6)
        mat = new THREE.MeshStandardMaterial({ color: 0x2d5a22, roughness: 1 })
      }
      const im = new THREE.InstancedMesh(geo, mat, perVariant)
      im.castShadow = true
      im.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
      im.frustumCulled = false
      im.count = 0
      this.group.add(im)
      this.treeMeshes.push(im)
    })

    this.update(0, new THREE.Vector3(0, 0, 0))
  }

  createPhysicsGround(R: typeof RAPIER, world: RAPIER.World) {
    const g = R.RigidBodyDesc.fixed()
    const body = world.createRigidBody(g)
    const col = R.ColliderDesc.cuboid(3000, 0.5, 3000)
      .setTranslation(0, -0.55, 0)
      .setFriction(1.0)
      .setRestitution(0)
    world.createCollider(col, body)
    this.R = R
    this.physWorld = world
    return body
  }

  private syncTreeColliders() {
    if (!this.R || !this.physWorld) return
    const R = this.R
    const world = this.physWorld
    for (const [seg, cols] of [...this.segColliders]) {
      if (this.segTrees.has(seg)) continue
      for (const c of cols) world.removeCollider(c, false)
      this.segColliders.delete(seg)
    }
    for (const [seg, trees] of this.segTrees) {
      if (this.segColliders.has(seg)) continue
      const cols: RAPIER.Collider[] = []
      for (const t of trees) {
        const col = R.ColliderDesc.cuboid(0.4, 1.8, 0.4)
          .setTranslation(t.pos.x, 1.8, t.pos.z)
          .setFriction(0.7)
          .setRestitution(0)
        cols.push(world.createCollider(col))
      }
      this.segColliders.set(seg, cols)
    }
  }

  private rand(seed: number) {
    let t = seed + 0x6d2b79f5
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }

  private placeHill(hill: Hill, seg: number) {
    hill.seg = seg
    const sMid = seg * this.segLen + this.segLen / 2
    const cx = roadCenterX(sMid)
    const side = this.rand(seg * 71 + 5) > 0.5 ? 1 : -1
    const lateral = 150 + this.rand(seg * 131 + 29) * 550
    const h = (hill.mesh.geometry as THREE.ConeGeometry).parameters.height
    hill.mesh.position.set(
      cx + side * lateral,
      h / 2 - 4,
      -(sMid + (this.rand(seg * 17 + 3) - 0.5) * this.segLen),
    )
  }

  private genSegTrees(seg: number): TreeEntry[] {
    const out: TreeEntry[] = []
    const W = WORLD_CONFIG.vegetation
    const nVar = Math.max(1, this.treeVariants.length)
    const s0 = seg * this.segLen
    for (let s = s0; s < s0 + this.segLen; s += 10) {
      const seed = Math.floor(s) + seg * 10007
      const cx = roadCenterX(s)
      const n = 1 + Math.floor(this.rand(seed) * 2)
      for (let i = 0; i < n; i++) {
        const side = this.rand(seed * 7 + i * 131) > 0.5 ? 1 : -1
        const dist =
          W.minDistanceFromRoad +
          this.rand(seed + i * 17) *
            (W.maxDistanceFromRoad - W.minDistanceFromRoad)
        out.push({
          pos: new THREE.Vector3(
            cx + side * dist,
            0,
            -(s + (this.rand(seed * 13 + i) - 0.5) * 10),
          ),
          rot: this.rand(seed + i) * Math.PI * 2,
          scale:
            (W.scaleRange.min +
              this.rand(seed * 3 + i * 7) *
                (W.scaleRange.max - W.scaleRange.min)) *
            1.6,
          variant: Math.floor(this.rand(seed * 29 + i * 5) * nVar) % nVar,
        })
        if (out.length > 40) break
      }
    }
    return out
  }

  private ensureSegs(minSeg: number, maxSeg: number) {
    if (
      this.segMax >= minSeg &&
      this.segMin <= maxSeg &&
      this.segMin === minSeg &&
      this.segMax === maxSeg
    )
      return
    let dirty = this.segMax < 0
    for (const k of [...this.segTrees.keys()]) {
      if (k < minSeg || k > maxSeg) {
        this.segTrees.delete(k)
        dirty = true
      }
    }
    let total = 0
    for (const arr of this.segTrees.values()) total += arr.length
    for (let s = minSeg; s <= maxSeg; s++) {
      if (!this.segTrees.has(s)) {
        const arr = this.genSegTrees(s)
        if (total + arr.length > this.maxTrees) break
        total += arr.length
        this.segTrees.set(s, arr)
        dirty = true
      }
    }
    this.segMin = minSeg
    this.segMax = maxSeg
    if (!dirty) return
    this.syncTreeColliders()
    const m = new THREE.Matrix4()
    const q = new THREE.Quaternion()
    const e = new THREE.Euler()
    const sc = new THREE.Vector3()
    const counters = this.treeMeshes.map(() => 0)
    const ordered = [...this.segTrees.keys()].sort((a, b) => a - b)
    for (const k of ordered) {
      for (const t of this.segTrees.get(k)!) {
        const idx = counters[t.variant]++
        const im = this.treeMeshes[t.variant]
        if (!im || idx >= im.instanceMatrix.count) continue
        e.set(0, t.rot, 0)
        q.setFromEuler(e)
        sc.set(t.scale, t.scale, t.scale)
        m.compose(t.pos, q, sc)
        im.setMatrixAt(idx, m)
      }
    }
    this.treeMeshes.forEach((im, vi) => {
      im.count = counters[vi]
      im.instanceMatrix.needsUpdate = true
    })
  }

  update(carS: number, carPos: THREE.Vector3) {
    const W = WORLD_CONFIG
    const startS =
      Math.floor((carS - W.road.segmentsBehind * this.segLen) / this.segLen) *
      this.segLen
    for (let i = 0; i < this.roadSegs.length; i++) {
      const s0 = startS + i * this.segLen
      const seg = this.roadSegs[i]
      if (seg.s0 === s0) continue
      seg.s0 = s0
      writeRibbon(
        seg.mesh.geometry as THREE.BufferGeometry,
        s0,
        this.segLen,
        this.ROAD_RIB,
        W.road.width,
      )
      seg.mesh.position.set(0, 0.02, 0)
    }
    this.ground.position.x = Math.round(carPos.x / 8) * 8
    this.ground.position.z = Math.round(carPos.z / 8) * 8
    const sun = (this.group as any)._sun as THREE.DirectionalLight | undefined
    if (sun) {
      sun.position.set(carPos.x + 120, 180, carPos.z + 60)
      sun.target.position.set(carPos.x, 0, carPos.z)
      sun.target.updateMatrixWorld()
    }
    const carSeg = Math.floor(carS / this.segLen)
    this.ensureSegs(carSeg - this.SEG_BEHIND, carSeg + this.SEG_AHEAD)
    for (const h of this.hills) {
      if (h.seg < carSeg - this.SEG_BEHIND)
        this.placeHill(h, carSeg + this.SEG_AHEAD + (h.seg % 3))
    }
  }

  static sFromPos(p: THREE.Vector3) {
    return -p.z
  }
}

function extractVariants(root: THREE.Object3D): THREE.Object3D[] {
  const hasMesh = (o: THREE.Object3D) => {
    let f = false
    o.traverse((c: any) => {
      if (c.isMesh) f = true
    })
    return f
  }
  let node = root
  for (let i = 0; i < 8; i++) {
    const kids = node.children.filter(hasMesh)
    if (kids.length > 1) return kids
    if (kids.length === 1) {
      node = kids[0]
      continue
    }
    return []
  }
  return []
}
