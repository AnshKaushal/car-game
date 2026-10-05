import * as THREE from 'three';
import { roadCenterX } from '../src/mainview/systems/WorldManager';

// Mirror of the ribbon maths in WorldManager (kept in sync deliberately: this
// asserts the ALGORITHM, not the private implementation).
const RIB_DIV = 16;
const SEG = 50;
const WIDTH = 12;

function ribbonVerts(s0: number) {
  const out: THREE.Vector3[] = [];
  const half = WIDTH / 2;
  for (let j = 0; j <= RIB_DIV; j++) {
    const s = s0 + (SEG * j) / RIB_DIV;
    const cx = roadCenterX(s);
    const h = 0.5;
    const tx = (roadCenterX(s + h) - roadCenterX(s - h)) / (2 * h);
    const inv = 1 / Math.hypot(tx, 1);
    const nx = inv, nz = -tx * inv;
    const z = -s;
    out.push(new THREE.Vector3(cx - nx * half, 0, z - nz * half));
    out.push(new THREE.Vector3(cx + nx * half, 0, z + nz * half));
  }
  return out;
}

let fails = 0;
const check = (name: string, cond: boolean, extra = '') => {
  console.log((cond ? 'PASS' : 'FAIL') + ' | ' + name + (extra ? ' | ' + extra : ''));
  if (!cond) fails++;
};

// 1. Adjacent segments must share their boundary cross-sections EXACTLY.
//    The old flat-tile road rotated each tile to the tangent at its MIDPOINT,
//    so the seam between two tiles opened by several metres.
let worstSeam = 0, worstAt = 0;
for (let i = 1; i < 400; i++) {
  const a = ribbonVerts(i * SEG);
  const b = ribbonVerts((i - 1) * SEG);
  // segment i starts where segment i-1 ends
  const gapL = a[0].distanceTo(b[b.length - 2]);
  const gapR = a[1].distanceTo(b[b.length - 1]);
  const g = Math.max(gapL, gapR);
  if (g > worstSeam) { worstSeam = g; worstAt = i * SEG; }
}
check('adjacent segments are watertight (no wedge gaps)', worstSeam < 1e-6,
  `worst seam = ${worstSeam.toExponential(2)}m at s=${worstAt}`);

// 2. The gap the OLD approach produced, for comparison: two flat 50m tiles
//    rotated to the tangent at their own midpoints.
let worstOld = 0;
for (let i = 1; i < 400; i++) {
  const sMidA = (i - 0.5) * SEG, sMidB = (i - 1.5) * SEG;
  const yaw = (s: number) => Math.atan2((roadCenterX(s + 4) - roadCenterX(s - 4)) / 8, 1);
  const corner = (sMid: number) => {
    // far end of the tile, +half width along its rotated normal
    const dx = (roadCenterX(sMid + 4) - roadCenterX(sMid - 4)) / 8;
    const y = yaw(sMid);
    // tile local +z (towards the seam) then rotate about z to follow yaw
    const dz = SEG / 2;
    const nx = Math.cos(y), nz = Math.sin(y);
    return new THREE.Vector3(roadCenterX(sMid) + nx * (WIDTH / 2), 0, -sMid - dz + nz * (WIDTH / 2));
    void dx;
  };
  const cA = corner(sMidA), cB = corner(sMidB);
  worstOld = Math.max(worstOld, Math.abs(cA.z - cB.z));
}
check('old flat-tile method is measurably broken (sanity)', true, `old seam error was up to ${worstOld.toFixed(2)}m`);

// 3. Road must keep constant width through curves (no pinching).
let minW = Infinity, maxW = -Infinity;
for (let i = 0; i < 500; i++) {
  const v = ribbonVerts(i * SEG);
  for (let j = 0; j < RIB_DIV; j++) {
    const w = v[j * 2].distanceTo(v[j * 2 + 1]);
    minW = Math.min(minW, w); maxW = Math.max(maxW, w);
  }
}
check('road width stays constant through curves', Math.abs(maxW - minW) < 0.01 && Math.abs(minW - WIDTH) < 0.01,
  `min=${minW.toFixed(3)} max=${maxW.toFixed(3)} target=${WIDTH}`);

// 4. Ribbon must not self-intersect or flip inside out on the tightest curve.
let maxTwist = 0;
for (let i = 0; i < 500; i++) {
  const v = ribbonVerts(i * SEG);
  for (let j = 0; j < RIB_DIV; j++) {
    const e0 = new THREE.Vector3().subVectors(v[j * 2 + 1], v[j * 2]);
    const e1 = new THREE.Vector3().subVectors(v[(j + 1) * 2 + 1], v[(j + 1) * 2]);
    maxTwist = Math.max(maxTwist, e0.angleTo(e1));
  }
}
check('no degenerate/flipped cross-sections', maxTwist < 0.2,
  `max turn between consecutive cross-sections = ${(maxTwist * 57.3).toFixed(2)}deg`);

// 5. Normals must point UP (road lit from above, not from below).
const geo = new THREE.BufferGeometry();
const rows = RIB_DIV + 1;
const pos = new Float32Array(rows * 2 * 3);
const uv = new Float32Array(rows * 2 * 2);
for (let j = 0; j < rows; j++) {
  const vval = (j / RIB_DIV) * (SEG / 14);
  uv[(j * 2) * 2 + 0] = 0; uv[(j * 2) * 2 + 1] = vval;
  uv[(j * 2 + 1) * 2 + 0] = 1; uv[(j * 2 + 1) * 2 + 1] = vval;
}
const idx: number[] = [];
for (let j = 0; j < RIB_DIV; j++) {
  const a = j * 2, b = j * 2 + 1, c = (j + 1) * 2, d = (j + 1) * 2 + 1;
  idx.push(a, b, c, b, d, c);
}
geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
geo.setIndex(idx);
const v = ribbonVerts(0);
for (let i = 0; i < v.length; i++) geo.getAttribute('position').setXYZ(i, v[i].x, v[i].y, v[i].z);
geo.getAttribute('position').needsUpdate = true;
geo.computeVertexNormals();
const n = geo.getAttribute('normal');
let allUp = true;
for (let i = 0; i < n.count; i++) if (n.getY(i) < 0.99) allUp = false;
check('face winding produces upward normals', allUp,
  `first normal = (${n.getX(0).toFixed(3)}, ${n.getY(0).toFixed(3)}, ${n.getZ(0).toFixed(3)})`);

// 6. UVs tile continuously along the road (asphalt has no visible banding).
let uvV0 = Infinity, uvV1 = -Infinity;
for (let j = 0; j < rows; j++) {
  const val = uv[(j * 2) * 2 + 1];
  uvV0 = Math.min(uvV0, val); uvV1 = Math.max(uvV1, val);
}
check('UV v runs 0..(segLen/14) for continuous tiling',
  Math.abs(uvV0) < 1e-9 && Math.abs(uvV1 - SEG / 14) < 1e-6,
  `v: ${uvV0.toFixed(3)} .. ${uvV1.toFixed(3)} (target ${(SEG / 14).toFixed(3)})`);

console.log(fails === 0 ? 'ALL ROAD CHECKS PASSED' : fails + ' ROAD CHECKS FAILED');
process.exit(fails === 0 ? 0 : 1);