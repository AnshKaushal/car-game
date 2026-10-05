/**
 * Loads bmw_m3.glb, auto-scales to ~4.7m length, finds wheels by name,
 * and poses the visual each frame from the physics body.
 */
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import type * as RAPIER from '@dimforge/rapier3d-compat';

/** If the car appears to drive backwards (nose pointing at the camera), set to Math.PI */
export const CAR_MODEL_YAW = Math.PI;

export class CarVisual {
  group = new THREE.Group();
  wheels: { mesh: THREE.Object3D; front: boolean; left: boolean }[] = [];
  private spinFront = 0; // rolling wheels (steered axle)
  private spinRear = 0; // driven wheels (includes slip so burnouts visibly spin)
  private loader = new GLTFLoader();

  async load(baseUrl: string): Promise<void> {
    const glb = await this.loader.loadAsync(`${baseUrl}models/bmw_m3.glb`);
    const model = glb.scene;
    model.traverse((o: any) => {
      if (o.isMesh) {
        o.castShadow = true;
        o.receiveShadow = false;
      }
    });

    // auto-scale to target length
    const box = new THREE.Box3().setFromObject(model);
    const size = box.getSize(new THREE.Vector3());
    const targetLen = 4.71;
    const longest = Math.max(size.x, size.y, size.z);
    const s = longest > 0 ? targetLen / longest : 1;
    model.scale.multiplyScalar(s);

    // Center the model on the physics body in X/Z (Sketchfab GLBs are often
    // offset from their own origin — without this the body renders meters away
    // from the wheels, exactly like a detached shell) and sit its base at y=0
    // (physics holds body center at ~0.72m and App offsets the group by that).
    // Also auto-align: the longest horizontal extent must be the car's length (Z).
    // This BMW is built facing +X, so rotate it onto -Z (physics forward).
    let boxA = new THREE.Box3().setFromObject(model);
    const sx0 = boxA.max.x - boxA.min.x;
    const sz0 = boxA.max.z - boxA.min.z;
    let alignYaw = 0;
    if (sx0 > sz0) alignYaw = Math.PI / 2; // built facing ±X -> rotate onto Z
    model.rotation.y = alignYaw + CAR_MODEL_YAW;
    // re-measure after rotation, then center
    boxA = new THREE.Box3().setFromObject(model);
    model.position.x -= (boxA.min.x + boxA.max.x) / 2;
    model.position.z -= (boxA.min.z + boxA.max.z) / 2;
    model.position.y -= boxA.min.y;
    // model forward: assume +Z or -Z; we drive forward = -Z. Rotate if needed by checking? keep as-is, yaw offset fix below.
    this.group.add(model);

    // wheels: use the GLB's OWN wheel groups.
    // (verified in bmw_m3.glb: Plane003..Plane006 — three.js sanitizes the
    // dots — each = tire mesh + rim mesh, 0.33 wide, 0.67 diameter)
    this.group.updateMatrixWorld(true);
    const wheelGroups: THREE.Object3D[] = [];
    model.traverse((o: any) => {
      if (!o.isMesh && o.children.length > 0 && /^Plane00[3-6]$/i.test(o.name)) {
        wheelGroups.push(o);
      }
    });

    if (wheelGroups.length === 4) {
      // NOTE: the Plane00x GROUP origins sit at the model origin — the pivot
      // must go at the wheel's GEOMETRIC (bbox) center, else wheels orbit
      // the car instead of spinning in their arches
      const wbox = new THREE.Box3();
      const center = new THREE.Vector3();
      for (const wg of wheelGroups) {
        // bbox center in car-group space (model already centered above)
        wbox.setFromObject(wg);
        wbox.getCenter(center);
        this.group.worldToLocal(center);
        const pivot = new THREE.Group();
        pivot.position.copy(center);
        pivot.rotation.order = 'YXZ'; // steer (Y) wraps spin (X)
        this.group.add(pivot);
        pivot.attach(wg); // keep visual transform, spin around wheel center
        const front = center.z < 0; // physics forward is -Z
        this.wheels.push({ mesh: pivot, front, left: center.x < 0 });
      }
    }

    if (this.wheels.length !== 4) {
      // fallback wheels (only if the GLB layout ever changes)
      this.wheels = [];
      const geo = new THREE.CylinderGeometry(0.33, 0.33, 0.26, 18);
      geo.rotateZ(Math.PI / 2);
      const mat = new THREE.MeshStandardMaterial({ color: 0x141414, roughness: 0.9 });
      const rimG = new THREE.CylinderGeometry(0.19, 0.19, 0.27, 8);
      rimG.rotateZ(Math.PI / 2);
      const rimM = new THREE.MeshStandardMaterial({ color: 0x9aa0a6, metalness: 0.8, roughness: 0.3 });
      const spots = [
        { x: -0.76, z: -1.51, front: true, left: true },
        { x: 0.76, z: -1.51, front: true, left: false },
        { x: -0.76, z: 1.31, front: false, left: true },
        { x: 0.76, z: 1.31, front: false, left: false },
      ];
      for (const sp of spots) {
        const pivot = new THREE.Group();
        pivot.position.set(sp.x, 0.33, sp.z);
        pivot.rotation.order = 'YXZ';
        const w = new THREE.Mesh(geo, mat);
        w.castShadow = true;
        const rim = new THREE.Mesh(rimG, rimM);
        pivot.add(w, rim);
        this.group.add(pivot);
        this.wheels.push({ mesh: pivot, front: sp.front, left: sp.left });
      }
    }
  }

  /** world positions of wheel contact patches (for tire smoke spawn) */
  wheelContactPositions(includeFront: boolean, out: THREE.Vector3[]): THREE.Vector3[] {
    out.length = 0;
    const p = new THREE.Vector3();
    for (const w of this.wheels) {
      if (!includeFront && w.front) continue;
      w.mesh.getWorldPosition(p);
      out.push(new THREE.Vector3(p.x, 0.12, p.z));
    }
    return out;
  }
  /** Pose from physics body. rollOmega = free-rolling speed, spinOmega = driven
   *  axle speed incl. wheelspin (so burnouts visibly smoke the rears).
   *  Sign: forward driving rotates wheels NEGATIVELY about +X (top of the
   *  tire moves forward, -Z), so omegas are negated into rotation.x. */
  syncFromBody(body: RAPIER.RigidBody, steerAngle: number, rollOmega: number, spinOmega: number, dt: number) {
    const t = body.translation();
    const r = body.rotation();
    // physics body center rides at ~0.72m; model base sits at group y=0
    this.group.position.set(t.x, t.y - 0.72, t.z);
    this.group.quaternion.set(r.x, r.y, r.z, r.w);

    this.spinFront -= rollOmega * dt;
    this.spinRear -= spinOmega * dt;
    for (const w of this.wheels) {
      const pivot = w.mesh;
      // order YXZ: steer first, spin inside the steered frame — correct look
      pivot.rotation.y = w.front ? steerAngle : 0;
      pivot.rotation.x = w.front ? this.spinFront : this.spinRear;
    }
  }
}
