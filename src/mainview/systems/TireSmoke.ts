/**
 * Pooled GPU point-sprite tire smoke for burnouts, donuts and drifts.
 * Zero allocation at runtime: fixed buffers, dead particles parked far away.
 */
import * as THREE from 'three';

const CAP = 260;

export class TireSmoke {
  points: THREE.Points;
  private pos: Float32Array;
  private vel: Float32Array;
  private life: Float32Array; // remaining
  private span: Float32Array; // total lifespan
  private size: Float32Array;
  private alphaAttr: THREE.BufferAttribute;
  private posAttr: THREE.BufferAttribute;
  private sizeAttr: THREE.BufferAttribute;
  private cursor = 0;
  private geo = new THREE.BufferGeometry();

  constructor() {
    this.pos = new Float32Array(CAP * 3);
    this.vel = new Float32Array(CAP * 3);
    this.life = new Float32Array(CAP);
    this.span = new Float32Array(CAP);
    this.size = new Float32Array(CAP);
    const alpha = new Float32Array(CAP);
    for (let i = 0; i < CAP; i++) this.pos[i * 3 + 1] = -100; // park underground

    this.posAttr = new THREE.BufferAttribute(this.pos, 3);
    this.sizeAttr = new THREE.BufferAttribute(this.size, 1);
    this.alphaAttr = new THREE.BufferAttribute(alpha, 1);
    this.posAttr.setUsage(THREE.DynamicDrawUsage);
    this.sizeAttr.setUsage(THREE.DynamicDrawUsage);
    this.alphaAttr.setUsage(THREE.DynamicDrawUsage);
    this.geo.setAttribute('position', this.posAttr);
    this.geo.setAttribute('aSize', this.sizeAttr);
    this.geo.setAttribute('aAlpha', this.alphaAttr);

    const mat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      uniforms: {},
      vertexShader: `
        attribute float aSize;
        attribute float aAlpha;
        varying float vAlpha;
        void main() {
          vAlpha = aAlpha;
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_PointSize = aSize * (240.0 / max(1.0, -mv.z));
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: `
        varying float vAlpha;
        void main() {
          vec2 uv = gl_PointCoord - 0.5;
          float d = length(uv);
          float soft = smoothstep(0.5, 0.12, d);
          gl_FragColor = vec4(vec3(0.82, 0.82, 0.84), soft * vAlpha);
        }`,
    });
    this.points = new THREE.Points(this.geo, mat);
    this.points.frustumCulled = false;
    this.points.renderOrder = 5;
  }

  /** puff at a wheel contact patch; strength 0..1 controls count/size */
  spawn(p: THREE.Vector3, strength: number) {
    const n = 1 + Math.floor(strength * 2.99);
    for (let k = 0; k < n; k++) {
      const i = this.cursor;
      this.cursor = (this.cursor + 1) % CAP;
      const i3 = i * 3;
      this.pos[i3] = p.x + (Math.random() - 0.5) * 0.5;
      this.pos[i3 + 1] = p.y + Math.random() * 0.25;
      this.pos[i3 + 2] = p.z + (Math.random() - 0.5) * 0.5;
      this.vel[i3] = (Math.random() - 0.5) * 1.6;
      this.vel[i3 + 1] = 1.0 + Math.random() * 1.8 + strength * 1.2;
      this.vel[i3 + 2] = (Math.random() - 0.5) * 1.6;
      this.span[i] = 0.9 + Math.random() * 0.8;
      this.life[i] = this.span[i];
      this.size[i] = (0.9 + Math.random() * 0.7) * (0.7 + strength * 0.8);
    }
  }

  update(dt: number) {
    const damp = Math.exp(-dt * 1.6);
    const alpha = this.alphaAttr.array as Float32Array;
    for (let i = 0; i < CAP; i++) {
      if (this.life[i] <= 0) {
        if (alpha[i] !== 0) alpha[i] = 0;
        continue;
      }
      this.life[i] -= dt;
      const i3 = i * 3;
      if (this.life[i] <= 0) {
        this.pos[i3 + 1] = -100;
        alpha[i] = 0;
        continue;
      }
      this.vel[i3] *= damp;
      this.vel[i3 + 2] *= damp;
      this.vel[i3 + 1] = this.vel[i3 + 1] * damp + dt * 1.4; // buoyant rise
      this.pos[i3] += this.vel[i3] * dt;
      this.pos[i3 + 1] += this.vel[i3 + 1] * dt;
      this.pos[i3 + 2] += this.vel[i3 + 2] * dt;
      const f = this.life[i] / this.span[i]; // 1 -> 0
      alpha[i] = 0.5 * f;
      this.size[i] += dt * 1.6; // puff expands
    }
    this.posAttr.needsUpdate = true;
    this.sizeAttr.needsUpdate = true;
    this.alphaAttr.needsUpdate = true;
  }
}
