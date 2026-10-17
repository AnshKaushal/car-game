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

export function roadDirYaw(s: number): number {
  return -roadYaw(s)
}

const ARC_STEP = 5
const ARC_MIN = -500
const ARC_MAX = 12500
let arcTable: Float64Array | null = null

function roadSlope(s: number): number {
  return (roadCenterX(s + 2) - roadCenterX(s - 2)) / 4
}

function buildArcTable(): Float64Array {
  const n = Math.floor((ARC_MAX - ARC_MIN) / ARC_STEP) + 1
  const t = new Float64Array(n)
  let acc = 0
  for (let i = 1; i < n; i++) {
    const sMid = ARC_MIN + (i - 0.5) * ARC_STEP
    const fp = roadSlope(sMid)
    acc += Math.sqrt(1 + fp * fp) * ARC_STEP
    t[i] = acc
  }
  return t
}

export function roadArcLength(s: number): number {
  if (!arcTable) arcTable = buildArcTable()
  const c = Math.max(ARC_MIN, Math.min(ARC_MAX, s))
  const f = (c - ARC_MIN) / ARC_STEP
  const i = Math.floor(f)
  const t = f - i
  const a = arcTable[i]
  const b = arcTable[Math.min(i + 1, arcTable.length - 1)]
  return a + (b - a) * t
}

export function roadGapM(a: number, b: number): number {
  return roadArcLength(a) - roadArcLength(b)
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

type PropCategory = "tree" | "rock" | "cloud" | "grass" | "barrel" | "log"

interface PropVariant {
  im: THREE.InstancedMesh
  category: PropCategory
  targetH: number
}

interface PropEntry {
  pos: THREE.Vector3
  rot: number
  scale: number
  variantIdx: number
}

interface CloudEntry {
  pos: THREE.Vector3
  rot: number
  variantIdx: number
}

interface Hill {
  mesh: THREE.Mesh
  seg: number
  rotY: number
  radius: number
  body?: RAPIER.RigidBody
}

const TREE_NODES = [
  "ARVORE_SEM",
  "Branches01",
  "Componen12",
  "Group23",
  "Group27",
  "Group4",
  "Group5",
  "Group6",
  "skp3703_1",
  "skp4847_1",
  "skp5771_1",
  "skp665F1",
  "skp7EEA1",
  "skp7EEA_1_",
  "skpC133_1",
  "skpEFB7_1",
]
const CLOUD_NODES = [
  "NUVEM1",
  "NUVEM_0201",
  "NUVEM_02_1",
  "NUVEM_1_1",
  "NUVEM_2_1",
]

export class WorldManager {
  group = new THREE.Group()
  private roadSegs: RoadSeg[] = []
  private segLen = WORLD_CONFIG.road.segmentLength
  private ground!: THREE.Mesh
  private propVariants: PropVariant[] = []
  private cloudVariants: PropVariant[] = []
  private segProps = new Map<number, PropEntry[]>()
  private segMin = 0
  private segMax = -1
  private maxProps = 18000
  private slotFree = new Map<number, number[]>()
  private slotHigh = new Map<number, number>()
  private segSlots = new Map<number, { vi: number; idx: number }[]>()
  private touchedVariants = new Set<number>()
  private grassDensity = 1
  private propShadows = true
  private readonly SHADOW_FADE_RADIUS = 110
  private shadowFadeMat: THREE.MeshDepthMaterial | null = null

  setPropShadows(on: boolean) {
    if (on === this.propShadows) return
    this.propShadows = on
    for (const pv of this.propVariants) {
      if (pv.category === "grass" || pv.category === "cloud") continue
      pv.im.castShadow = on
    }
  }

  private shadowFadeMaterial(): THREE.MeshDepthMaterial {
    if (this.shadowFadeMat) return this.shadowFadeMat
    const mat = new THREE.MeshDepthMaterial({
      depthPacking: THREE.RGBADepthPacking,
    })
    const center = this.carPos
    const radius = this.SHADOW_FADE_RADIUS
    mat.onBeforeCompile = (sh) => {
      sh.uniforms.uShadowCenter = { value: center }
      sh.uniforms.uShadowRadius = { value: radius }
      sh.vertexShader = sh.vertexShader
        .replace(
          "#include <common>",
          "#include <common>\nvarying vec3 vShadowWpos;",
        )
        .replace(
          "#include <project_vertex>",
          `#include <project_vertex>
          #ifdef USE_INSTANCING
            vShadowWpos = (modelMatrix * instanceMatrix * vec4(transformed, 1.0)).xyz;
          #else
            vShadowWpos = (modelMatrix * vec4(transformed, 1.0)).xyz;
          #endif`,
        )
      sh.fragmentShader = sh.fragmentShader
        .replace(
          "#include <common>",
          `#include <common>
          varying vec3 vShadowWpos;
          uniform vec3 uShadowCenter;
          uniform float uShadowRadius;`,
        )
        .replace(
          "#include <clipping_planes_fragment>",
          `#include <clipping_planes_fragment>
          if (distance(vShadowWpos, uShadowCenter) > uShadowRadius) discard;`,
        )
    }
    mat.customProgramCacheKey = () => "propShadowFade"
    this.shadowFadeMat = mat
    return mat
  }

  private applyShadowFade(im: THREE.InstancedMesh) {
    im.customDepthMaterial = this.shadowFadeMaterial()
  }
  private readonly SEGS_PER_FRAME = 2
  private primed = false
  private readonly scratchM = new THREE.Matrix4()
  private readonly scratchQ = new THREE.Quaternion()
  private readonly scratchE = new THREE.Euler()
  private readonly scratchS = new THREE.Vector3()
  private static readonly ZERO_M = new THREE.Matrix4().makeScale(0, 0, 0)
  private R?: typeof RAPIER
  private physWorld?: RAPIER.World
  private segColliders = new Map<number, RAPIER.Collider[]>()
  private carPos = new THREE.Vector3()
  private hills: Hill[] = []
  private readonly SEG_BEHIND = 12
  private readonly SEG_AHEAD = 24
  private readonly ROAD_RIB = RIB_DIV
  private loader = new GLTFLoader()

  private readonly NUM_CLOUDS = 40
  private cloudEntries: CloudEntry[] = []
  private cloudLastCarS = -999999
  private readonly GRASS_ENABLED = true

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
      vertexColors: true,
      roughness: 1,
      flatShading: true,
    })
    for (let i = 0; i < 22; i++) {
      const far = i % 3 === 2
      const radius = far
        ? 120 + this.rand(i * 613 + 7) * 100
        : 35 + this.rand(i * 613 + 7) * 35
      const height = far
        ? 80 + this.rand(i * 977 + 13) * 80
        : 15 + this.rand(i * 977 + 13) * 30
      const seed = i * 311 + 3
      const hill = new THREE.Mesh(
        this.makeHillGeometry(radius, height, seed),
        hillMat,
      )
      const rotY = this.rand(seed) * Math.PI * 2
      hill.rotation.y = rotY
      hill.castShadow = true
      hill.receiveShadow = true
      this.group.add(hill)
      const seg = -2 + i * 2
      this.hills.push({ mesh: hill, seg: -999999, rotY, radius })
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
      m.frustumCulled = true
      this.group.add(m)
      this.roadSegs.push({ mesh: m, s0: -999999 })
    }

    let glbRoot: THREE.Object3D | null = null
    try {
      const glb = await this.loader.loadAsync(
        `${baseUrl}models/low_poly_tree_pack.glb`,
      )
      glbRoot = glb.scene
      glbRoot.updateMatrixWorld(true)
    } catch (e) {
      console.warn("low_poly_tree_pack.glb failed to load, using fallback", e)
    }

    if (glbRoot) {
      const nodeByName = new Map<string, THREE.Object3D>()
      glbRoot.traverse((o) => {
        nodeByName.set(o.name, o)
      })

      const buildVariant = (
        category: PropCategory,
        names: string[],
        targetH: number,
        maxInstances: number,
        opts?: { uniformScale?: number },
      ) => {
        for (const name of names) {
          const node = nodeByName.get(name)
          if (!node) {
            console.warn(`prop node not found: ${name}`)
            continue
          }
          node.updateMatrixWorld(true)
          const im = bakeInstanced(node, maxInstances, targetH, opts)
          if (im) {
            im.castShadow = category !== "cloud" && category !== "grass"
            im.receiveShadow = category === "grass"
            im.frustumCulled = false
            if (category === "tree") this.applyShadowFade(im)
            this.group.add(im)
            if (category === "cloud") {
              this.cloudVariants.push({ im, category, targetH })
            } else {
              this.propVariants.push({ im, category, targetH })
            }
          }
        }
      }

      buildVariant("tree", TREE_NODES, 6.5, 150)
      buildVariant("cloud", CLOUD_NODES, 14.0, this.NUM_CLOUDS)

      const bakeNodes = (names: string[]): THREE.Group | null => {
        const g = new THREE.Group()
        let found = false
        for (const nm of names) {
          const n = nodeByName.get(nm)
          if (n) {
            g.add(n.clone())
            found = true
          } else console.warn(`prop node not found: ${nm}`)
        }
        if (!found) return null
        g.updateMatrixWorld(true)
        return g
      }
      const pushIM = (
        im: THREE.InstancedMesh | null,
        category: PropCategory,
        targetH: number,
        shadow: boolean,
      ) => {
        if (!im) return
        im.castShadow = shadow
        im.receiveShadow = category === "grass"
        im.frustumCulled = false
        if (category !== "grass") this.applyShadowFade(im)
        this.group.add(im)
        this.propVariants.push({ im, category, targetH })
      }

      {
        const grassGeo = new THREE.PlaneGeometry(7, 7)
        grassGeo.rotateX(-Math.PI / 2)
        const grassMat = new THREE.MeshStandardMaterial({
          color: 0x4d7a33,
          roughness: 1,
        })
        const grassIM = new THREE.InstancedMesh(grassGeo, grassMat, 12000)
        grassIM.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
        grassIM.count = 0
        grassIM.castShadow = false
        grassIM.receiveShadow = true
        grassIM.frustumCulled = false
        this.group.add(grassIM)
        this.propVariants.push({
          im: grassIM,
          category: "grass",
          targetH: 0.3,
        })
      }
      const g111 = bakeNodes(["Object_111"])
      if (g111) {
        for (const im of bakeSplit(g111, 6, 150, { uniformScale: 0.012 }))
          pushIM(im, "rock", 0.8, true)
      }
      const barrel = bakeNodes(["Object_113", "Object_114"])
      if (barrel) {
        pushIM(bakeInstanced(barrel, 100, 1.5), "barrel", 1.5, true)
      }
      const log = bakeNodes(["Object_111", "Object_112"])
      if (log) {
        pushIM(
          bakeInstanced(log, 100, 0, { uniformScale: 0.006 }),
          "log",
          0.4,
          true,
        )
      }
    } else {
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
      const fallback = new THREE.Group()
      fallback.add(trunk, top)
      fallback.updateMatrixWorld(true)
      const im = bakeInstanced(fallback, this.maxProps, 6.5)
      if (im) {
        im.castShadow = true
        im.frustumCulled = false
        this.applyShadowFade(im)
        this.group.add(im)
        this.propVariants.push({ im, category: "tree", targetH: 6.5 })
      }
    }

    this.hills.forEach((h, i) =>
      this.dressHill(h, i * 311 + 3, h.radius > 90 ? 10 : 20),
    )

    this.initClouds()
    this.update(0, new THREE.Vector3(0, 0, 0))
  }

  private initClouds() {
    if (this.cloudVariants.length === 0) return
    const nV = this.cloudVariants.length
    for (let i = 0; i < this.NUM_CLOUDS; i++) {
      const seed = i * 3571 + 9973
      this.cloudEntries.push({
        pos: new THREE.Vector3(
          (this.rand(seed) - 0.5) * 600,
          60 + this.rand(seed * 7) * 60,
          -(i * 80 + (this.rand(seed * 3) - 0.5) * 60),
        ),
        rot: this.rand(seed * 11) * Math.PI * 2,
        variantIdx: i % nV,
      })
    }
    this.flushClouds()
  }

  private flushClouds() {
    if (this.cloudVariants.length === 0) return
    const m = new THREE.Matrix4()
    const q = new THREE.Quaternion()
    const e = new THREE.Euler()
    const sc = new THREE.Vector3()
    const counters = this.cloudVariants.map(() => 0)
    for (const c of this.cloudEntries) {
      const vi = c.variantIdx % this.cloudVariants.length
      const pv = this.cloudVariants[vi]
      const idx = counters[vi]++
      if (idx >= pv.im.instanceMatrix.count) continue
      e.set(0, c.rot, 0)
      q.setFromEuler(e)
      sc.set(1, 1, 1)
      m.compose(c.pos, q, sc)
      pv.im.setMatrixAt(idx, m)
    }
    this.cloudVariants.forEach((pv, vi) => {
      pv.im.count = counters[vi]
      pv.im.instanceMatrix.needsUpdate = true
    })
  }

  private updateClouds(carS: number, carPos: THREE.Vector3) {
    if (this.cloudVariants.length === 0) return
    const behindZ = -(carS - 600)
    const aheadZ = -(carS - 2000)
    let dirty = false
    for (let i = 0; i < this.cloudEntries.length; i++) {
      const c = this.cloudEntries[i]
      if (c.pos.z > behindZ) {
        const seed = i * 4001 + Math.floor(carS) * 13
        c.pos.set(
          carPos.x + (this.rand(seed) - 0.5) * 700,
          60 + this.rand(seed * 7) * 60,
          aheadZ - this.rand(seed * 3) * 400,
        )
        c.rot = this.rand(seed * 11) * Math.PI * 2
        dirty = true
      }
    }
    if (dirty || Math.abs(carS - this.cloudLastCarS) > 50) {
      this.cloudLastCarS = carS
      this.flushClouds()
    }
  }

  createPhysicsGround(R: typeof RAPIER, world: RAPIER.World) {
    const g = R.RigidBodyDesc.fixed()
    const body = world.createRigidBody(g)
    const col = R.ColliderDesc.cuboid(3000, 5, 3000)
      .setTranslation(0, -5.05, 0)
      .setFriction(1.0)
      .setRestitution(0)
    world.createCollider(col, body)
    this.R = R
    this.physWorld = world
    for (const hill of this.hills) {
      const hb = world.createRigidBody(R.RigidBodyDesc.fixed())
      const hg = hill.mesh.geometry as THREE.BufferGeometry
      const hp = hg.getAttribute("position") as THREE.BufferAttribute
      const verts = new Float32Array(hp.array)
      const hidx = hg.getIndex()!
      const indices = new Uint32Array(hidx.array as Uint32Array)
      world.createCollider(
        R.ColliderDesc.trimesh(verts, indices)
          .setFriction(0.9)
          .setRestitution(0),
        hb,
      )
      hill.body = hb
      this.syncHillBody(hill)
    }
    return body
  }

  private syncHillBody(hill: Hill) {
    if (!hill.body) return
    const p = hill.mesh.position
    hill.body.setTranslation({ x: p.x, y: p.y, z: p.z }, true)
    const q = new THREE.Quaternion().setFromAxisAngle(
      new THREE.Vector3(0, 1, 0),
      hill.rotY,
    )
    hill.body.setRotation({ x: q.x, y: q.y, z: q.z, w: q.w }, true)
  }

  private syncPropColliders() {
    if (!this.R || !this.physWorld) return
    const R = this.R
    const world = this.physWorld
    for (const [seg, cols] of [...this.segColliders]) {
      if (this.segProps.has(seg)) continue
      for (const c of cols) world.removeCollider(c, false)
      this.segColliders.delete(seg)
    }
    for (const [seg, props] of this.segProps) {
      if (this.segColliders.has(seg)) continue
      const cols: RAPIER.Collider[] = []
      for (const t of props) {
        const pv = this.propVariants[t.variantIdx]
        if (!pv || pv.category === "grass" || pv.category === "log") continue
        const dx = t.pos.x - this.carPos.x
        const dz = t.pos.z - this.carPos.z
        if (dx * dx + dz * dz < 16) continue
        const isRock = pv.category === "rock"
        const isBarrel = pv.category === "barrel"
        const hh = isRock ? 0.6 : isBarrel ? 0.75 : 1.8
        const hw = isRock ? 1.2 : isBarrel ? 1.5 : 0.4
        const col = R.ColliderDesc.cuboid(hw, hh, hw)
          .setTranslation(t.pos.x, hh, t.pos.z)
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
    const sMid = seg * this.segLen + this.segLen / 2
    const cx = roadCenterX(sMid)
    const side = this.rand(seg * 71 + 5) > 0.5 ? 1 : -1
    const far = hill.radius > 90
    const clearance = hill.radius * 1.4 + 12
    const lateral = clearance + this.rand(seg * 131 + 29) * (far ? 450 : 130)
    const nx = cx + side * lateral
    const nz = -(sMid + (this.rand(seg * 17 + 3) - 0.5) * this.segLen)
    const dx = nx - this.carPos.x
    const dz = nz - this.carPos.z
    const keepOut = hill.radius + 15
    if (hill.seg !== -999999 && dx * dx + dz * dz < keepOut * keepOut) return
    hill.seg = seg
    hill.mesh.position.set(nx, -0.3, nz)
    this.syncHillBody(hill)
  }

  private hillNoise(seed: number, x: number, z: number): number {
    const h2 = (ix: number, iz: number) => {
      let h = Math.imul(
        seed + Math.imul(ix, 374761393) + Math.imul(iz, 668265263),
        1274126177,
      )
      h ^= h >>> 13
      return (((h ^ (h >>> 16)) >>> 0) / 4294967296) * 2 - 1
    }
    const smooth = (t: number) => t * t * (3 - 2 * t)
    const oct = (fx: number, fz: number) => {
      const ix = Math.floor(fx),
        iz = Math.floor(fz)
      const tx = smooth(fx - ix),
        tz = smooth(fz - iz)
      const a = h2(ix, iz),
        b = h2(ix + 1, iz)
      const c = h2(ix, iz + 1),
        d = h2(ix + 1, iz + 1)
      return a + (b - a) * tx + (c - a) * tz + (a - b - c + d) * tx * tz
    }
    return (
      oct(x * 0.02, z * 0.02) * 0.65 +
      oct(x * 0.06 + 13.7, z * 0.06 + 7.1) * 0.35
    )
  }

  private makeHillGeometry(
    radius: number,
    height: number,
    seed: number,
  ): THREE.BufferGeometry {
    const NR = 12
    const NS = 36
    const positions: number[] = []
    const colors: number[] = []
    const index: number[] = []
    const green = new THREE.Color(0x44602f)
    const dark = new THREE.Color(0x2f4a24)
    const rock = new THREE.Color(0x6e6e68)
    const snow = new THREE.Color(0xdfe8ee)
    const c = new THREE.Color()
    const smooth = (t: number) => {
      const x = Math.min(1, Math.max(0, t))
      return x * x * (3 - 2 * x)
    }

    const nTop = this.hillNoise(seed, 0, 0)
    positions.push(0, height + nTop * height * 0.05, 0)
    c.copy(green).lerp(rock, 0.55)
    colors.push(c.r, c.g, c.b)

    for (let i = 1; i <= NR; i++) {
      const rho = i / NR
      const prof = Math.pow(1 - smooth(rho), 1.25)
      const apron = 1 + (1 - smooth(Math.min(1, rho / 0.35))) * 0.35
      for (let j = 0; j < NS; j++) {
        const th = (j / NS) * Math.PI * 2
        const dx = Math.cos(th)
        const dz = Math.sin(th)
        const env = Math.sin(Math.PI * Math.min(1, Math.max(0.02, rho)))
        const n = this.hillNoise(seed, dx * rho * radius, dz * rho * radius)
        const rr = radius * rho * apron * (1 + 0.22 * n * env)
        const h = Math.max(0, height * prof + n * height * 0.1 * env)
        positions.push(dx * rr, h, dz * rr)
        const rockiness = Math.min(
          1,
          Math.max(0, (prof - 0.35) * 1.5 + Math.max(0, n) * 0.3),
        )
        c.copy(green)
          .lerp(dark, Math.max(0, -n) * 0.5)
          .lerp(rock, rockiness)
        if (height > 60) {
          const t = Math.min(1, Math.max(0, (h / height - 0.62) / 0.2))
          const s = t * t * (3 - 2 * t)
          c.lerp(snow, s)
        }
        colors.push(c.r, c.g, c.b)
      }
    }
    const ring = (i: number, j: number) =>
      1 + (i - 1) * NS + (((j % NS) + NS) % NS)
    for (let j = 0; j < NS; j++) index.push(0, ring(1, j + 1), ring(1, j))
    for (let i = 1; i < NR; i++) {
      for (let j = 0; j < NS; j++) {
        index.push(ring(i, j), ring(i, j + 1), ring(i + 1, j + 1))
        index.push(ring(i, j), ring(i + 1, j + 1), ring(i + 1, j))
      }
    }
    const geo = new THREE.BufferGeometry()
    geo.setAttribute(
      "position",
      new THREE.BufferAttribute(new Float32Array(positions), 3),
    )
    geo.setAttribute(
      "color",
      new THREE.BufferAttribute(new Float32Array(colors), 3),
    )
    geo.setIndex(index)
    geo.computeVertexNormals()
    return geo
  }

  private sampleHillSurface(
    geo: THREE.BufferGeometry,
    seed: number,
    count: number,
  ): { pos: THREE.Vector3; nrm: THREE.Vector3 }[] {
    const out: { pos: THREE.Vector3; nrm: THREE.Vector3 }[] = []
    const posA = geo.getAttribute("position") as THREE.BufferAttribute
    const idx = geo.getIndex()
    if (!idx) return out
    const triCount = Math.floor(idx.count / 3)
    const areas = new Float32Array(triCount)
    const a = new THREE.Vector3(),
      b = new THREE.Vector3(),
      cc = new THREE.Vector3()
    let total = 0
    for (let t = 0; t < triCount; t++) {
      a.fromBufferAttribute(posA, idx.getX(t * 3))
      b.fromBufferAttribute(posA, idx.getX(t * 3 + 1))
      cc.fromBufferAttribute(posA, idx.getX(t * 3 + 2))
      const ar = b.clone().sub(a).cross(cc.clone().sub(a)).length() / 2
      areas[t] = ar
      total += ar
    }
    if (total <= 0) return out
    const e1 = new THREE.Vector3(),
      e2 = new THREE.Vector3(),
      n = new THREE.Vector3()
    for (let k = 0; k < count; k++) {
      let r = this.rand(seed + k * 101) * total
      let t = 0
      while (t < triCount - 1 && (r -= areas[t]) > 0) t++
      a.fromBufferAttribute(posA, idx.getX(t * 3))
      b.fromBufferAttribute(posA, idx.getX(t * 3 + 1))
      cc.fromBufferAttribute(posA, idx.getX(t * 3 + 2))
      let u = this.rand(seed + k * 103 + 1)
      let w = this.rand(seed + k * 107 + 2)
      if (u + w > 1) {
        u = 1 - u
        w = 1 - w
      }
      const p = a
        .clone()
        .multiplyScalar(1 - u - w)
        .addScaledVector(b, u)
        .addScaledVector(cc, w)
      e1.copy(b).sub(a)
      e2.copy(cc).sub(a)
      n.copy(e1.cross(e2))
      if (n.lengthSq() < 1e-10) continue
      n.normalize()
      if (n.y < 0) n.negate()
      out.push({ pos: p, nrm: n.clone() })
    }
    return out
  }

  private dressHill(hill: Hill, seed: number, count: number) {
    const treeVars = this.propVariants.filter((p) => p.category === "tree")
    const rockVars = this.propVariants.filter((p) => p.category === "rock")
    const grassVars = this.propVariants.filter((p) => p.category === "grass")
    if (treeVars.length === 0) return
    const spots = this.sampleHillSurface(
      hill.mesh.geometry as THREE.BufferGeometry,
      seed,
      count,
    )
    const yAxis = new THREE.Vector3(0, 1, 0)
    const q = new THREE.Quaternion()
    const qy = new THREE.Quaternion()
    spots.forEach((s, k) => {
      const r = this.rand(seed + k * 13)
      const steep = s.nrm.y < 0.55
      let pv: PropVariant | undefined
      let sc: number
      let sink: number
      if (!steep && r < 0.5) {
        pv =
          treeVars[
            Math.floor(this.rand(seed + k * 17) * treeVars.length) %
              treeVars.length
          ]
        sc = 1.6 + this.rand(seed + k * 19) * 1.2
        sink = 0.15
      } else if (r < 0.75 && rockVars.length > 0) {
        pv =
          rockVars[
            Math.floor(this.rand(seed + k * 29) * rockVars.length) %
              rockVars.length
          ]
        sc = 1.2 + this.rand(seed + k * 31) * 1.0
        sink = 0.1
      } else if (grassVars.length > 0) {
        pv =
          grassVars[
            Math.floor(this.rand(seed + k * 37) * grassVars.length) %
              grassVars.length
          ]
        sc = 1.0 + this.rand(seed + k * 41) * 0.8
        sink = 0.05
      } else {
        return
      }
      const m = new THREE.Mesh(
        pv.im.geometry as THREE.BufferGeometry,
        pv.im.material as THREE.Material | THREE.Material[],
      )
      m.castShadow = pv.im.castShadow
      m.receiveShadow = false
      q.setFromUnitVectors(yAxis, s.nrm)
      qy.setFromAxisAngle(yAxis, this.rand(seed + k * 43) * Math.PI * 2)
      q.premultiply(qy)
      m.quaternion.copy(q)
      m.position.copy(s.pos).addScaledVector(s.nrm, -sink)
      m.scale.setScalar(sc)
      hill.mesh.add(m)
    })
  }

  private genSegProps(seg: number): PropEntry[] {
    const out: PropEntry[] = []
    if (this.propVariants.length === 0) return out
    const W = WORLD_CONFIG.vegetation
    const treeIdxs = this.propVariants
      .map((p, i) => (p.category === "tree" ? i : -1))
      .filter((i) => i >= 0)
    const rockIdxs = this.propVariants
      .map((p, i) => (p.category === "rock" ? i : -1))
      .filter((i) => i >= 0)
    const grassIdxs = this.propVariants
      .map((p, i) => (p.category === "grass" ? i : -1))
      .filter((i) => i >= 0)
    const barrelIdxs = this.propVariants
      .map((p, i) => (p.category === "barrel" ? i : -1))
      .filter((i) => i >= 0)
    const logIdxs = this.propVariants
      .map((p, i) => (p.category === "log" ? i : -1))
      .filter((i) => i >= 0)
    const s0 = seg * this.segLen
    const ROAD_CLEAR = 9.5

    const pushProp = (
      s: number,
      seed: number,
      i: number,
      minDist: number,
      maxDist: number,
      pool: number[],
      baseScale: number,
      y = 0,
    ) => {
      if (pool.length === 0) return
      const cx = roadCenterX(s)
      const side = this.rand(seed * 7 + i * 131) > 0.5 ? 1 : -1
      const dist = Math.max(
        ROAD_CLEAR,
        minDist + this.rand(seed + i * 17) * (maxDist - minDist),
      )
      const variantIdx =
        pool[
          Math.floor(this.rand(seed * 29 + i * 5) * pool.length) % pool.length
        ]
      const scaleVar =
        W.scaleRange.min +
        this.rand(seed * 3 + i * 7) * (W.scaleRange.max - W.scaleRange.min)
      out.push({
        pos: new THREE.Vector3(
          cx + side * dist,
          y,
          -(s + (this.rand(seed * 13 + i) - 0.5) * 8),
        ),
        rot: this.rand(seed + i) * Math.PI * 2,
        scale: scaleVar * baseScale,
        variantIdx,
      })
    }

    for (let s = s0; s < s0 + this.segLen; s += 8) {
      const seed = Math.floor(s) * 7 + seg * 10007
      const n = 2 + Math.floor(this.rand(seed) * 2)
      for (let i = 0; i < n; i++) {
        const roll = this.rand(seed * 31 + i * 53)
        let pool: number[] = treeIdxs
        let base = 1.4
        let minD: number = W.minDistanceFromRoad
        let maxD: number = W.maxDistanceFromRoad
        if (roll > 0.75 && rockIdxs.length > 0) {
          pool = rockIdxs
          base = 1.0
        } else if (roll > 0.9 && barrelIdxs.length > 0) {
          pool = barrelIdxs
          base = 1.0
          minD = 10
          maxD = 50
        } else if (roll > 0.95 && logIdxs.length > 0) {
          pool = logIdxs
          base = 1.0
          minD = 12
          maxD = 50
        }
        if (pool.length === 0) {
          pool = treeIdxs
          base = 1.4
          minD = W.minDistanceFromRoad
          maxD = W.maxDistanceFromRoad
        }
        pushProp(s, seed, i, minD, maxD, pool, base, -0.15)
        if (out.length > 60) return out
      }
    }

    if (this.GRASS_ENABLED) {
      const bands = [
        { step: 2.0, nMin: 4, nMax: 8, minD: 8, maxD: 45, base: 1.0 },
        { step: 4, nMin: 3, nMax: 6, minD: 45, maxD: 120, base: 1.6 },
        { step: 10, nMin: 2, nMax: 4, minD: 120, maxD: 300, base: 2.8 },
      ]
      let gi = 0
      for (const b of bands) {
        for (let s = s0; s < s0 + this.segLen; s += b.step) {
          const seed = Math.floor(s * 4) * 13 + seg * 30011 + 777 + gi * 7919
          const n = b.nMin + Math.floor(this.rand(seed) * (b.nMax - b.nMin + 1))
          for (let i = 0; i < n; i++) {
            pushProp(
              s,
              seed,
              i + 1000 + gi * 500,
              b.minD,
              b.maxD,
              grassIdxs,
              b.base,
              -0.04,
            )
            if (out.length > 900) return out
          }
        }
        gi++
      }
    }
    return out
  }

  private ensureSegs(minSeg: number, maxSeg: number) {
    if (this.primed && this.segMax >= minSeg && this.segMin <= maxSeg) {
      let complete = true
      for (let s = minSeg; s <= maxSeg; s++) {
        if (!this.segProps.has(s)) {
          complete = false
          break
        }
      }
      if (complete) return
    }
    for (const k of [...this.segProps.keys()]) {
      if (k < minSeg || k > maxSeg) {
        this.freeSeg(k)
        this.segProps.delete(k)
      }
    }
    let total = 0
    for (const arr of this.segProps.values()) total += arr.length
    const missing: number[] = []
    for (let s = maxSeg; s >= minSeg; s--) {
      if (!this.segProps.has(s)) missing.push(s)
    }
    const budget = this.primed ? this.SEGS_PER_FRAME : missing.length
    for (let i = 0; i < Math.min(budget, missing.length); i++) {
      const s = missing[i]
      const arr = this.genSegProps(s)
      if (total + arr.length > this.maxProps) break
      total += arr.length
      this.segProps.set(s, arr)
      this.integrateSeg(s, arr)
    }
    this.primed = true
    this.segMin = minSeg
    this.segMax = maxSeg
    if (this.touchedVariants.size === 0) return
    this.syncPropColliders()
    for (const vi of this.touchedVariants) {
      const pv = this.propVariants[vi]
      if (pv) pv.im.instanceMatrix.needsUpdate = true
    }
    this.touchedVariants.clear()
  }

  private integrateSeg(seg: number, arr: PropEntry[]) {
    const slots: { vi: number; idx: number }[] = []
    for (const t of arr) {
      const vi = t.variantIdx
      const pv = this.propVariants[vi]
      if (!pv) continue
      const im = pv.im
      const cap = im.instanceMatrix.count
      const free = this.slotFree.get(vi)
      let idx: number
      if (free && free.length > 0) {
        idx = free.pop()!
      } else {
        idx = this.slotHigh.get(vi) ?? 0
        if (idx >= cap) continue
        this.slotHigh.set(vi, idx + 1)
        im.count = idx + 1
      }
      this.scratchE.set(0, t.rot, 0)
      this.scratchQ.setFromEuler(this.scratchE)
      this.scratchS.set(t.scale, t.scale, t.scale)
      this.scratchM.compose(t.pos, this.scratchQ, this.scratchS)
      im.setMatrixAt(idx, this.scratchM)
      slots.push({ vi, idx })
      this.touchedVariants.add(vi)
    }
    this.segSlots.set(seg, slots)
  }

  private freeSeg(seg: number) {
    const slots = this.segSlots.get(seg)
    this.segSlots.delete(seg)
    if (!slots) return
    for (const { vi, idx } of slots) {
      const pv = this.propVariants[vi]
      if (!pv) continue
      pv.im.setMatrixAt(idx, WorldManager.ZERO_M)
      let free = this.slotFree.get(vi)
      if (!free) {
        free = []
        this.slotFree.set(vi, free)
      }
      free.push(idx)
      this.touchedVariants.add(vi)
    }
  }

  update(carS: number, carPos: THREE.Vector3, grassTarget = 1) {
    const W = WORLD_CONFIG
    this.carPos.copy(carPos)
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
    this.updateClouds(carS, carPos)
    this.grassDensity += (grassTarget - this.grassDensity) * 0.08
    if (Math.abs(grassTarget - this.grassDensity) < 0.005) {
      this.grassDensity = grassTarget
    }
    if (this.grassDensity < 0.999) {
      for (let vi = 0; vi < this.propVariants.length; vi++) {
        const pv = this.propVariants[vi]
        if (pv.category !== "grass") continue
        const high = this.slotHigh.get(vi) ?? pv.im.count
        pv.im.count = Math.floor(high * this.grassDensity)
      }
    } else {
      for (let vi = 0; vi < this.propVariants.length; vi++) {
        const pv = this.propVariants[vi]
        if (pv.category !== "grass") continue
        const high = this.slotHigh.get(vi)
        if (high !== undefined && pv.im.count !== high) pv.im.count = high
      }
    }
  }

  static sFromPos(p: THREE.Vector3) {
    return -p.z
  }
}

function bakeInstanced(
  node: THREE.Object3D,
  maxInstances: number,
  targetH: number,
  opts?: { uniformScale?: number },
): THREE.InstancedMesh | null {
  const clone = node.clone()
  clone.rotation.x = -Math.PI / 2
  clone.updateMatrixWorld(true)

  const cbox0 = new THREE.Box3().setFromObject(clone)
  const size0 = cbox0.getSize(new THREE.Vector3())
  if (size0.y < 0.001 && opts?.uniformScale === undefined) return null
  const norm = opts?.uniformScale ?? targetH / size0.y
  clone.scale.multiplyScalar(norm)
  clone.updateMatrixWorld(true)

  const cbox = new THREE.Box3().setFromObject(clone)
  const cx = (cbox.min.x + cbox.max.x) / 2
  const cz = (cbox.min.z + cbox.max.z) / 2

  const geos: THREE.BufferGeometry[] = []
  const mats: THREE.Material[] = []
  clone.traverse((o: any) => {
    if (!o.isMesh) return
    const src = o.geometry as THREE.BufferGeometry
    const pos = src.getAttribute("position") as
      THREE.BufferAttribute | undefined
    if (!pos || pos.count < 24) return
    src.computeBoundingBox()
    const bb = src.boundingBox!
    const sz = new THREE.Vector3()
    bb.getSize(sz)
    const longest = Math.max(sz.x, sz.y, sz.z)
    if (longest < 1e-6) return
    const g = src.clone().applyMatrix4(o.matrixWorld)
    g.translate(-cx, -cbox.min.y, -cz)
    geos.push(g)
    const m = Array.isArray(o.material) ? o.material[0] : o.material
    mats.push(
      m ?? new THREE.MeshStandardMaterial({ color: 0x2d5a22, roughness: 1 }),
    )
  })

  if (geos.length === 0) return null

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
  } else {
    geo = geos[0]
    mat = mats[0]
  }

  const im = new THREE.InstancedMesh(geo, mat, maxInstances)
  im.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
  im.count = 0
  return im
}

function bakeSplit(
  node: THREE.Object3D,
  chunks: number,
  maxInstances: number,
  opts: { uniformScale?: number; targetH?: number; flattenY?: number },
): THREE.InstancedMesh[] {
  const out: THREE.InstancedMesh[] = []
  const clone = node.clone()
  clone.rotation.x = -Math.PI / 2
  clone.updateMatrixWorld(true)

  const parts: THREE.BufferGeometry[] = []
  let mat: THREE.Material | null = null
  clone.traverse((o: any) => {
    if (!o.isMesh) return
    const src = o.geometry as THREE.BufferGeometry
    const pos = src.getAttribute("position") as
      THREE.BufferAttribute | undefined
    if (!pos || pos.count < 24) return
    if (!mat)
      mat = (Array.isArray(o.material) ? o.material[0] : o.material) ?? null
    const g = src.clone().applyMatrix4(o.matrixWorld)
    parts.push(g.index ? g.toNonIndexed() : g)
  })
  if (parts.length === 0) return out
  const merged = mergeGeometries(parts, false)
  if (!merged) return out
  const material =
    mat ?? new THREE.MeshStandardMaterial({ color: 0x4d7a2e, roughness: 1 })

  merged.computeBoundingBox()
  const bb = merged.boundingBox!
  const spanX = Math.max(1e-6, bb.max.x - bb.min.x)

  const posA = merged.getAttribute("position") as THREE.BufferAttribute
  const normA = merged.getAttribute("normal") as
    THREE.BufferAttribute | undefined
  const uvA = merged.getAttribute("uv") as THREE.BufferAttribute | undefined
  const triCount = Math.floor(posA.count / 3)
  const bins: number[][] = Array.from({ length: chunks }, () => [])

  const cx = new THREE.Vector3()
  for (let t = 0; t < triCount; t++) {
    cx.fromBufferAttribute(posA, t * 3)
      .add(new THREE.Vector3().fromBufferAttribute(posA, t * 3 + 1))
      .add(new THREE.Vector3().fromBufferAttribute(posA, t * 3 + 2))
      .multiplyScalar(1 / 3)
    const b = Math.min(
      chunks - 1,
      Math.floor(((cx.x - bb.min.x) / spanX) * chunks),
    )
    bins[b].push(t)
  }

  for (const bin of bins) {
    if (bin.length === 0) continue
    const n = bin.length * 3
    const pArr = new Float32Array(n * 3)
    const nArr = normA ? new Float32Array(n * 3) : null
    const uArr = uvA ? new Float32Array(n * 2) : null
    let k = 0
    let minY = Infinity
    let minX = Infinity,
      maxX = -Infinity,
      minZ = Infinity,
      maxZ = -Infinity
    for (const t of bin) {
      for (let v = 0; v < 3; v++) {
        const vi = t * 3 + v
        const x = posA.getX(vi),
          y = posA.getY(vi),
          z = posA.getZ(vi)
        if (y < minY) minY = y
        if (x < minX) minX = x
        if (x > maxX) maxX = x
        if (z < minZ) minZ = z
        if (z > maxZ) maxZ = z
      }
    }
    const ccx = (minX + maxX) / 2
    const ccz = (minZ + maxZ) / 2
    const fy = opts.flattenY ?? 1
    for (const t of bin) {
      for (let v = 0; v < 3; v++) {
        const vi = t * 3 + v
        pArr[k * 3 + 0] = posA.getX(vi) - ccx
        pArr[k * 3 + 1] = (posA.getY(vi) - minY) * fy
        pArr[k * 3 + 2] = posA.getZ(vi) - ccz
        if (nArr && normA) {
          nArr[k * 3 + 0] = normA.getX(vi)
          nArr[k * 3 + 1] = normA.getY(vi)
          nArr[k * 3 + 2] = normA.getZ(vi)
        }
        if (uArr && uvA) {
          uArr[k * 2 + 0] = uvA.getX(vi)
          uArr[k * 2 + 1] = uvA.getY(vi)
        }
        k++
      }
    }
    const g = new THREE.BufferGeometry()
    g.setAttribute("position", new THREE.BufferAttribute(pArr, 3))
    if (nArr) g.setAttribute("normal", new THREE.BufferAttribute(nArr, 3))
    if (uArr) g.setAttribute("uv", new THREE.BufferAttribute(uArr, 2))
    if (opts.uniformScale !== undefined)
      g.scale(opts.uniformScale, opts.uniformScale, opts.uniformScale)
    else if (opts.targetH !== undefined) {
      g.computeBoundingBox()
      const h = Math.max(1e-6, g.boundingBox!.max.y - g.boundingBox!.min.y)
      const s = opts.targetH / h
      g.scale(s, s, s)
    }
    const im = new THREE.InstancedMesh(g, material, maxInstances)
    im.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
    im.count = 0
    out.push(im)
  }
  return out
}
