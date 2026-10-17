import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js"
import * as THREE from "three"

const buf = await Bun.file("src/mainview/models/bmw_m3.glb").arrayBuffer()
const glb: any = await new GLTFLoader().parseAsync(buf, "")
let meshes = 0,
  verts = 0,
  skinned = 0,
  multiMat = 0,
  morph = 0
const mats = new Set<string>()
glb.scene.traverse((o: any) => {
  if (!o.isMesh) return
  meshes++
  const g = o.geometry as THREE.BufferGeometry
  verts += g.getAttribute("position")?.count ?? 0
  if (o.isSkinnedMesh) skinned++
  if (Array.isArray(o.material)) multiMat++
  else if (o.material) mats.add(o.material.uuid + ":" + o.material.type)
  if (Object.keys(g.morphAttributes ?? {}).length > 0) morph++
  const names = Object.keys(g.attributes)
  if (!g.getAttribute("uv")) console.log("no-uv mesh:", o.name)
  if (!g.getAttribute("normal")) console.log("no-normal mesh:", o.name)
  if ((o.material as any)?.vertexColors) console.log("vcolor mesh:", o.name)
})
console.log({ meshes, verts, skinned, multiMat, morph, materials: mats.size })
