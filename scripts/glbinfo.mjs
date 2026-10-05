import * as THREE from "three"
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js"
import fs from "node:fs"
globalThis.ProgressEvent = class {
  constructor(t, i) {
    this.type = t
  }
}
const loader = new GLTFLoader()
const buf = fs.readFileSync(
  "/Users/anshhkaushal/Documents/Projects/car-game/src/mainview/models/bmw_m3.glb",
)
const base64 = buf.toString("base64")
const glb = await loader.loadAsync("data:model/gltf-binary;base64," + base64)
const scene = glb.scene
scene.updateMatrixWorld(true)
const box = new THREE.Box3().setFromObject(scene)
const size = box.getSize(new THREE.Vector3())
console.log(
  "SCENE bbox min",
  box.min.toArray().map((v) => v.toFixed(2)),
  "max",
  box.max.toArray().map((v) => v.toFixed(2)),
  "size",
  size.toArray().map((v) => v.toFixed(2)),
)
scene.traverse((o) => {
  if (/^Plane00[3-6]$/.test(o.name)) {
    const b = new THREE.Box3().setFromObject(o)
    const c = b.getCenter(new THREE.Vector3())
    const s = b.getSize(new THREE.Vector3())
    console.log(
      o.name,
      "center",
      c.toArray().map((v) => v.toFixed(2)),
      "size",
      s.toArray().map((v) => v.toFixed(2)),
    )
  }
})
// replicate pivot.attach + spin: do wheel meshes stay concentric?
{
  const b0 = new THREE.Box3().setFromObject(scene)
  const sz0 = b0.getSize(new THREE.Vector3())
  const sc = 4.71 / Math.max(sz0.x, sz0.y, sz0.z)
  scene.scale.multiplyScalar(sc)
  let boxA = new THREE.Box3().setFromObject(scene)
  scene.rotation.y = ((boxA.max.x - boxA.min.x) > (boxA.max.z - boxA.min.z) ? Math.PI / 2 : 0) + Math.PI
  boxA = new THREE.Box3().setFromObject(scene)
  scene.position.x -= (boxA.min.x + boxA.max.x) / 2
  scene.position.z -= (boxA.min.z + boxA.max.z) / 2
  scene.position.y -= boxA.min.y
  const group = new THREE.Group()
  group.add(scene)
  group.updateMatrixWorld(true)
  // NOTE: collect first, attach after (attaching inside traverse corrupts it)
  const found = []
  scene.traverse((o) => {
    if (!o.isMesh && o.children.length > 0 && /^Plane00[3-6]$/i.test(o.name)) found.push(o)
  })
  console.log('found wheel groups:', found.map((o) => o.name).join(','))
  const pivots = []
  const wbox = new THREE.Box3()
  for (const o of found) {
    wbox.setFromObject(o)
    const center = wbox.getCenter(new THREE.Vector3())
    console.log(o.name, 'BBOX CENTER in car space', center.toArray().map((v) => v.toFixed(3)))
    group.worldToLocal(center)
    const pivot = new THREE.Group()
    pivot.position.copy(center)
    group.add(pivot)
    pivot.attach(o)
    pivots.push(pivot)
  }
  const before = []
  scene.traverse((o) => {
    if (/Material016_0$/.test(o.name) && o.isMesh) {
      const b = new THREE.Box3().setFromObject(o)
      before.push(o.name + '=' + b.getCenter(new THREE.Vector3()).toArray().map((v) => v.toFixed(3)).join(','))
    }
  })
  // spin like 3s of driving, then measure tire-mesh world centers
  // (traverse group: attach() moved wheels out from under scene)
  for (const p of pivots) p.rotation.x = 30.0
  group.updateMatrixWorld(true)
  group.traverse((o) => {
    if (/Material016_0$/.test(o.name) && o.isMesh && o.name !== 'Plane002_Material016_0') {
      const b = new THREE.Box3().setFromObject(o)
      const c = b.getCenter(new THREE.Vector3()).toArray().map((v) => v.toFixed(3)).join(',')
      const ok = before.find((s) => s.startsWith(o.name + '='))
      console.log(o.name, 'tire center after spin', c, ok === o.name + '=' + c ? 'STABLE' : 'MOVED (was ' + ok + ')')
    }
  })
}
