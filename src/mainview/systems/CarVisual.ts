import * as THREE from "three"
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js"
import type * as RAPIER from "@dimforge/rapier3d-compat"

export const CAR_MODEL_YAW = Math.PI

export const SUSP_VISUAL_REF = 0.074

export class CarVisual {
  group = new THREE.Group()
  wheels: {
    mesh: THREE.Object3D
    front: boolean
    left: boolean
    baseY: number
  }[] = []
  private spinAngles = [0, 0, 0, 0]
  private loader = new GLTFLoader()

  async load(baseUrl: string): Promise<void> {
    const glb = await this.loader.loadAsync(`${baseUrl}models/bmw_m3.glb`)
    const model = glb.scene
    model.traverse((o: any) => {
      if (o.isMesh) {
        o.castShadow = true
        o.receiveShadow = false
      }
    })

    const box = new THREE.Box3().setFromObject(model)
    const size = box.getSize(new THREE.Vector3())
    const targetLen = 4.71
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

    this.group.updateMatrixWorld(true)
    const wheelGroups: THREE.Object3D[] = []
    model.traverse((o: any) => {
      if (
        !o.isMesh &&
        o.children.length > 0 &&
        /^Plane00[3-6]$/i.test(o.name)
      ) {
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
      const geo = new THREE.CylinderGeometry(0.33, 0.33, 0.26, 18)
      geo.rotateZ(Math.PI / 2)
      const mat = new THREE.MeshStandardMaterial({
        color: 0x141414,
        roughness: 0.9,
      })
      const rimG = new THREE.CylinderGeometry(0.19, 0.19, 0.27, 8)
      rimG.rotateZ(Math.PI / 2)
      const rimM = new THREE.MeshStandardMaterial({
        color: 0x9aa0a6,
        metalness: 0.8,
        roughness: 0.3,
      })
      const spots = [
        { x: -0.76, z: -1.51, front: true, left: true },
        { x: 0.76, z: -1.51, front: true, left: false },
        { x: -0.76, z: 1.31, front: false, left: true },
        { x: 0.76, z: 1.31, front: false, left: false },
      ]
      for (const sp of spots) {
        const pivot = new THREE.Group()
        pivot.position.set(sp.x, 0.33, sp.z)
        pivot.rotation.order = "YXZ"
        const w = new THREE.Mesh(geo, mat)
        w.castShadow = true
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
  }

  wheelContactPositions(
    includeFront: boolean,
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
    this.group.position.set(t.x, t.y - 0.72, t.z)
    this.group.quaternion.set(r.x, r.y, r.z, r.w)

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
