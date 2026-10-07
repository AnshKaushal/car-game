/**
 * Endless world: recycled road segments + following ground + instanced trees.
 * - Road center is an analytic function of distance s (deterministic, no storage).
 * - Physics ground is a single flat Rapier plane at y=0 (stable at 300km/h).
 * - Visuals: pooled road meshes, canvas asphalt texture, instanced trees from tree_pack.glb.
 */
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import type * as RAPIER from '@dimforge/rapier3d-compat';
import { WORLD_CONFIG } from '../constants/world';

export function roadCenterX(s: number): number {
  // gentle endless curves: sum of sines (deterministic)
  return Math.sin(s * 0.004) * 60 + Math.sin(s * 0.0013 + 1.7) * 120;
}
export function roadYaw(s: number): number {
  const dx = (roadCenterX(s + 4) - roadCenterX(s - 4)) / 8; // dx/ds
  // forward is -Z... path direction: (dx, -1) in xz; yaw = atan2(dx, 1)? three yaw around Y, 0 = -Z
  return Math.atan2(dx, 1);
}

/** Number of cross-sections sampled along each road ribbon. */
const RIB_DIV = 16;

/**
 * Build a ribbon mesh whose spine is the road centerline.
 *
 * Topology is fixed (RIB_DIV cross-sections x 2 edge vertices) so the pooled
 * segments can be rewritten in place as they recycle, without reallocating.
 * Positions are left at zero until writeRibbon() fills them in.
 */
function makeRibbonGeometry(len: number, div: number, width: number, vRepeat: number): THREE.BufferGeometry {
  const rows = div + 1;
  const verts = rows * 2;
  const pos = new Float32Array(verts * 3);
  const uv = new Float32Array(verts * 2);
  for (let j = 0; j < rows; j++) {
    const v = (j / div) * vRepeat;
    // left / right edge of this cross-section
    uv[(j * 2) * 2 + 0] = 0; uv[(j * 2) * 2 + 1] = v;
    uv[(j * 2 + 1) * 2 + 0] = 1; uv[(j * 2 + 1) * 2 + 1] = v;
  }
  const idx: number[] = [];
  for (let j = 0; j < div; j++) {
    const a = j * 2, b = j * 2 + 1, c = (j + 1) * 2, d = (j + 1) * 2 + 1;
    // Counter-clockwise seen from ABOVE (+Y). The mirror ordering of this
    // (a,c,b / b,c,d) makes every face normal point straight DOWN, which
    // lights the road from underneath and renders it black.
    idx.push(a, b, c, b, d, c);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  void len; void width;
  return geo;
}

/**
 * Rewrite a ribbon's vertices to follow roadCenterX over [s0, s0+len].
 *
 * The edges are offset along the true normal of the centerline, so the road
 * keeps a constant width through curves instead of pinching. y is left at 0;
 * the mesh's own position supplies the 0.02 lift off the physics ground.
 */
function writeRibbon(geo: THREE.BufferGeometry, s0: number, len: number, div: number, width: number) {
  const pos = geo.getAttribute('position') as THREE.BufferAttribute;
  const half = width / 2;
  for (let j = 0; j <= div; j++) {
    const s = s0 + (len * j) / div;
    const cx = roadCenterX(s);
    // numerical tangent of the centerline at s
    const h = 0.5;
    const tx = (roadCenterX(s + h) - roadCenterX(s - h)) / (2 * h);
    // forward is (tx, -1) in xz; its right-hand normal in the xz plane is
    // perpendicular, pointing to the driver's right
    const inv = 1 / Math.hypot(tx, 1);
    const nx = inv;      // normal.x
    const nz = -tx * inv; // normal.z
    const z = -s;
    const l = j * 2, r = j * 2 + 1;
    pos.setXYZ(l, cx - nx * half, 0, z - nz * half);
    pos.setXYZ(r, cx + nx * half, 0, z + nz * half);
  }
  pos.needsUpdate = true;
  geo.computeVertexNormals();
  geo.computeBoundingSphere();
}

function makeAsphaltTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 256; c.height = 256;
  const g = c.getContext('2d')!;
  g.fillStyle = '#33363b';
  g.fillRect(0, 0, 256, 256);
  // noise
  for (let i = 0; i < 2500; i++) {
    const v = 40 + Math.random() * 25;
    g.fillStyle = `rgb(${v},${v},${v + 4})`;
    g.fillRect(Math.random() * 256, Math.random() * 256, 2, 2);
  }
  // edge lines
  g.fillStyle = '#e8e8e8';
  g.fillRect(8, 0, 5, 256);
  g.fillRect(243, 0, 5, 256);
  // center dashes (two lanes each dir -> center double yellow + lane dashes)
  g.fillStyle = '#d8b93a';
  g.fillRect(124, 0, 4, 256);
  g.fillRect(132, 0, 4, 256);
  g.fillStyle = '#cfcfcf';
  for (let y = 0; y < 256; y += 64) {
    g.fillRect(70, y, 4, 32);
    g.fillRect(182, y, 4, 32);
  }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 4;
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

interface RoadSeg {
  mesh: THREE.Mesh;
  s0: number; // start distance
}

interface TreeEntry {
  pos: THREE.Vector3;
  rot: number;
  scale: number;
  variant: number;
}

interface Hill {
  mesh: THREE.Mesh;
  seg: number; // road segment it sits beside
}

export class WorldManager {
  group = new THREE.Group();
  private roadSegs: RoadSeg[] = [];
  private segLen = WORLD_CONFIG.road.segmentLength;
  private ground!: THREE.Mesh;
  private treeMeshes: THREE.InstancedMesh[] = [];
  private treeVariants: THREE.Object3D[] = [];
  // trees indexed by road segment: segs near the car are NEVER touched,
  // only passed segs are dropped and new ones generated ahead (no visible pop)
  private segTrees = new Map<number, TreeEntry[]>();
  private segMin = 0;
  private segMax = -1;
  private maxTrees = 900;
  private hills: Hill[] = [];
  private readonly SEG_BEHIND = 4; // 200m behind
  private readonly SEG_AHEAD = 24; // 1200m ahead (past fog far — spawns hidden)
  private readonly ROAD_RIB = RIB_DIV;
  private loader = new GLTFLoader();

  async init(scene: THREE.Scene, baseUrl: string) {
    const W = WORLD_CONFIG;
    scene.add(this.group);
    scene.fog = new THREE.Fog(W.environment.fogColor, W.environment.fogNear, W.environment.fogFar);

    // lights
    const sun = new THREE.DirectionalLight(W.environment.sunColor, 2.2);
    sun.position.set(120, 180, 60);
    sun.castShadow = true;
    sun.shadow.mapSize.set(1024, 1024);
    sun.shadow.camera.left = -80; sun.shadow.camera.right = 80;
    sun.shadow.camera.top = 80; sun.shadow.camera.bottom = -80;
    sun.shadow.camera.far = 500;
    this.group.add(sun);
    this.group.add(new THREE.HemisphereLight(0xbdd7ff, 0x3d5a2a, 0.9));
    (this.group as any)._sun = sun;

    // ground (follows car, snapped)
    const gGeo = new THREE.PlaneGeometry(1200, 1200, 1, 1);
    const gMat = new THREE.MeshStandardMaterial({ color: 0x44602f, roughness: 1 });
    this.ground = new THREE.Mesh(gGeo, gMat);
    this.ground.rotation.x = -Math.PI / 2;
    this.ground.position.y = -0.08;
    this.ground.receiveShadow = true;
    this.group.add(this.ground);

    // distant hills: pooled cones recycled with road segments, always placed
    // 150-700m OFF the road center (never on the asphalt) and respawned in
    // full fog ahead, so they never visibly pop
    const hillMat = new THREE.MeshStandardMaterial({ color: 0x3a5a28, roughness: 1, flatShading: true });
    for (let i = 0; i < 14; i++) {
      const h = 40 + this.rand(i * 977 + 13) * 80;
      const hill = new THREE.Mesh(
        new THREE.ConeGeometry(70 + this.rand(i * 613 + 7) * 110, h, 5),
        hillMat
      );
      hill.rotation.y = this.rand(i * 311 + 3) * Math.PI;
      this.group.add(hill);
      const seg = -2 + i * 2;
      this.hills.push({ mesh: hill, seg: -999999 });
      this.placeHill(this.hills[i], seg);
    }

    // road pool
    const tex = makeAsphaltTexture();
    const count = W.road.segmentsAhead + W.road.segmentsBehind;
    // Each segment is a CURVED ribbon that follows roadCenterX() exactly.
    //
    // These used to be flat PlaneGeometry tiles positioned at roadCenterX(mid)
    // and rotated to roadYaw(mid). On a curve the tangent at the midpoint is
    // not the tangent at the ends, so neighbouring tiles met at a slight angle
    // and opened a visible wedge of bare ground across the carriageway every
    // segmentLength. Sampling the centerline per vertex removes the seams
    // entirely, and neighbouring segments share the boundary samples so they
    // are watertight rather than merely overlapping.
    const roadMat = new THREE.MeshStandardMaterial({ map: tex.clone(), roughness: 0.95 });
    this.roadSegs = [];
    for (let i = 0; i < count; i++) {
      const geo = makeRibbonGeometry(this.segLen, this.ROAD_RIB, W.road.width, this.segLen / 14);
      const m = new THREE.Mesh(geo, roadMat.clone());
      m.material.map = tex.clone();
      m.material.map!.repeat.set(1, 1);
      m.material.map!.needsUpdate = true;
      m.receiveShadow = true;
      // geometry is written in world space per recycle, so the mesh itself
      // sits at the origin and culling has to be done off the bounding volume
      m.frustumCulled = false;
      this.group.add(m);
      this.roadSegs.push({ mesh: m, s0: -999999 });
    }

    // trees: load pack, split into per-tree variants.
    // tree_pack.glb nests trees (Sketchfab_model > RootNode > Circle, Circle.001, ...),
    // so descend to the first node with multiple mesh-bearing children.
    try {
      const glb = await this.loader.loadAsync(`${baseUrl}models/tree_pack.glb`);
      const root = glb.scene;
      root.updateMatrixWorld(true);
      this.treeVariants = extractVariants(root).slice(0, 6);
      if (this.treeVariants.length === 0) this.treeVariants = [root];
    } catch (e) {
      console.warn('tree_pack.glb failed to load, using cone fallback', e);
      // fallback: procedural pine
      const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.25, 0.4, 2.4, 6), new THREE.MeshStandardMaterial({ color: 0x5a3a22 }));
      trunk.position.y = 1.2;
      const top = new THREE.Mesh(new THREE.ConeGeometry(2.2, 5.5, 7), new THREE.MeshStandardMaterial({ color: 0x2d5a22, flatShading: true }));
      top.position.y = 5;
      const pine = new THREE.Group();
      pine.add(trunk, top);
      this.treeVariants.push(pine);
    }

    // normalize variant height (~4-9m) and bake each variant's meshes into
    // ONE merged geometry (with groups + material array) for InstancedMesh
    const perVariant = Math.ceil(this.maxTrees / Math.max(1, this.treeVariants.length));
    this.treeVariants.forEach((variant) => {
      variant.updateMatrixWorld(true);
      const box = new THREE.Box3().setFromObject(variant);
      const size = box.getSize(new THREE.Vector3());
      const norm = size.y > 0.01 ? 6.5 / size.y : 1;
      variant.scale.multiplyScalar(norm);
      variant.updateMatrixWorld(true);
      const nbox = new THREE.Box3().setFromObject(variant);
      const ncx = (nbox.min.x + nbox.max.x) / 2;
      const ncz = (nbox.min.z + nbox.max.z) / 2;

      const geos: THREE.BufferGeometry[] = [];
      const mats: THREE.Material[] = [];
      variant.traverse((o: any) => {
        if (o.isMesh) {
          const g = (o.geometry as THREE.BufferGeometry).clone().applyMatrix4(o.matrixWorld);
          // recenter to origin, base at y=0
          g.translate(-ncx, -nbox.min.y, -ncz);
          geos.push(g);
          const m = Array.isArray(o.material) ? o.material[0] : o.material;
          mats.push(m ?? new THREE.MeshStandardMaterial({ color: 0x2d5a22, roughness: 1 }));
        }
      });
      let geo: THREE.BufferGeometry;
      let mat: THREE.Material | THREE.Material[];
      if (geos.length > 1) {
        const merged = mergeGeometries(geos.map((g) => g.index ? g.toNonIndexed() : g), true);
        if (merged) {
          geo = merged;
          mat = mats;
        } else {
          geo = geos[0];
          mat = mats[0];
        }
      } else if (geos.length === 1) {
        geo = geos[0];
        mat = mats[0];
      } else {
        geo = new THREE.ConeGeometry(2, 6, 6);
        mat = new THREE.MeshStandardMaterial({ color: 0x2d5a22, roughness: 1 });
      }
      const im = new THREE.InstancedMesh(geo, mat, perVariant);
      im.castShadow = true;
      im.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      im.frustumCulled = false; // we manage visibility by placement
      im.count = 0;
      this.group.add(im);
      this.treeMeshes.push(im);
    });

    // pregenerate trees around s=0
    this.update(0, new THREE.Vector3(0, 0, 0));
  }

  /** Flat physics ground — stable at speed */
  createPhysicsGround(R: typeof RAPIER, world: RAPIER.World) {
    const g = R.RigidBodyDesc.fixed();
    const body = world.createRigidBody(g);
    const col = R.ColliderDesc.cuboid(3000, 0.5, 3000).setTranslation(0, -0.55, 0).setFriction(1.0).setRestitution(0);
    world.createCollider(col, body);
    return body;
  }

  /** Deterministic pseudo-random */
  private rand(seed: number) {
    let t = seed + 0x6d2b79f5;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** Place a hill beside the given road segment (seeded: stable across visits) */
  private placeHill(hill: Hill, seg: number) {
    hill.seg = seg;
    const sMid = seg * this.segLen + this.segLen / 2;
    const cx = roadCenterX(sMid);
    const side = this.rand(seg * 71 + 5) > 0.5 ? 1 : -1;
    const lateral = 150 + this.rand(seg * 131 + 29) * 550;
    const h = (hill.mesh.geometry as THREE.ConeGeometry).parameters.height;
    hill.mesh.position.set(
      cx + side * lateral,
      h / 2 - 4,
      -(sMid + (this.rand(seg * 17 + 3) - 0.5) * this.segLen)
    );
  }

  /** Generate all trees for one road segment (seeded: identical every visit) */
  private genSegTrees(seg: number): TreeEntry[] {
    const out: TreeEntry[] = [];
    const W = WORLD_CONFIG.vegetation;
    const nVar = Math.max(1, this.treeVariants.length);
    const s0 = seg * this.segLen;
    for (let s = s0; s < s0 + this.segLen; s += 10) {
      const seed = Math.floor(s) + seg * 10007;
      const cx = roadCenterX(s);
      const n = 1 + Math.floor(this.rand(seed) * 2);
      for (let i = 0; i < n; i++) {
        const side = this.rand(seed * 7 + i * 131) > 0.5 ? 1 : -1;
        const dist = W.minDistanceFromRoad + this.rand(seed + i * 17) * (W.maxDistanceFromRoad - W.minDistanceFromRoad);
        out.push({
          pos: new THREE.Vector3(cx + side * dist, 0, -(s + (this.rand(seed * 13 + i) - 0.5) * 10)),
          rot: this.rand(seed + i) * Math.PI * 2,
          scale: (W.scaleRange.min + this.rand(seed * 3 + i * 7) * (W.scaleRange.max - W.scaleRange.min)) * 1.6,
          variant: Math.floor(this.rand(seed * 29 + i * 5) * nVar) % nVar,
        });
        if (out.length > 40) break;
      }
    }
    return out;
  }

  /** Drop passed segments, generate new ones ahead, rewrite instance buffers */
  private ensureSegs(minSeg: number, maxSeg: number) {
    if (this.segMax >= minSeg && this.segMin <= maxSeg && this.segMin === minSeg && this.segMax === maxSeg) return;
    let dirty = this.segMax < 0;
    for (const k of [...this.segTrees.keys()]) {
      if (k < minSeg || k > maxSeg) { this.segTrees.delete(k); dirty = true; }
    }
    // cap total in case variant counts explode
    let total = 0;
    for (const arr of this.segTrees.values()) total += arr.length;
    for (let s = minSeg; s <= maxSeg; s++) {
      if (!this.segTrees.has(s)) {
        const arr = this.genSegTrees(s);
        if (total + arr.length > this.maxTrees) break;
        total += arr.length;
        this.segTrees.set(s, arr);
        dirty = true;
      }
    }
    this.segMin = minSeg;
    this.segMax = maxSeg;
    if (!dirty) return;
    // flatten into instanced meshes (only runs when the seg window changed)
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const e = new THREE.Euler();
    const sc = new THREE.Vector3();
    const counters = this.treeMeshes.map(() => 0);
    const ordered = [...this.segTrees.keys()].sort((a, b) => a - b);
    for (const k of ordered) {
      for (const t of this.segTrees.get(k)!) {
        const idx = counters[t.variant]++;
        const im = this.treeMeshes[t.variant];
        if (!im || idx >= im.instanceMatrix.count) continue;
        e.set(0, t.rot, 0);
        q.setFromEuler(e);
        sc.set(t.scale, t.scale, t.scale);
        m.compose(t.pos, q, sc);
        im.setMatrixAt(idx, m);
      }
    }
    this.treeMeshes.forEach((im, vi) => {
      im.count = counters[vi];
      im.instanceMatrix.needsUpdate = true;
    });
  }

  update(carS: number, carPos: THREE.Vector3) {
    const W = WORLD_CONFIG;
    // recycle road segs to cover [carS - behind*len, carS + ahead*len]
    const startS = Math.floor((carS - W.road.segmentsBehind * this.segLen) / this.segLen) * this.segLen;
    for (let i = 0; i < this.roadSegs.length; i++) {
      const s0 = startS + i * this.segLen;
      const seg = this.roadSegs[i];
      if (seg.s0 === s0) continue;
      seg.s0 = s0;
      writeRibbon(seg.mesh.geometry as THREE.BufferGeometry, s0, this.segLen, this.ROAD_RIB, W.road.width);
      seg.mesh.position.set(0, 0.02, 0);
    }
    // ground follows (snapped to reduce shimmer)
    this.ground.position.x = Math.round(carPos.x / 8) * 8;
    this.ground.position.z = Math.round(carPos.z / 8) * 8;
    // sun follows for stable shadows
    const sun = (this.group as any)._sun as THREE.DirectionalLight | undefined;
    if (sun) {
      sun.position.set(carPos.x + 120, 180, carPos.z + 60);
      sun.target.position.set(carPos.x, 0, carPos.z);
      sun.target.updateMatrixWorld();
    }
    // regen trees when moved far
    const carSeg = Math.floor(carS / this.segLen);
    this.ensureSegs(carSeg - this.SEG_BEHIND, carSeg + this.SEG_AHEAD);
    // recycle hills that fell behind: jump them ahead into full fog
    for (const h of this.hills) {
      if (h.seg < carSeg - this.SEG_BEHIND) this.placeHill(h, carSeg + this.SEG_AHEAD + (h.seg % 3));
    }
  }

  /** distance-along-road s from world pos (approx: s = -z since road runs along -Z) */
  static sFromPos(p: THREE.Vector3) { return -p.z; }
}

/**
 * Descend through single-child wrapper nodes (Sketchfab_model > RootNode ...)
 * to the first level with multiple mesh-bearing children — those are the variants.
 */
function extractVariants(root: THREE.Object3D): THREE.Object3D[] {
  const hasMesh = (o: THREE.Object3D) => {
    let f = false;
    o.traverse((c: any) => { if (c.isMesh) f = true; });
    return f;
  };
  let node = root;
  for (let i = 0; i < 8; i++) {
    const kids = node.children.filter(hasMesh);
    if (kids.length > 1) return kids;
    if (kids.length === 1) { node = kids[0]; continue; }
    return [];
  }
  return [];
}
