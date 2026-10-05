/**
 * Input mapping: WASD drive, QE shift, M auto/manual, Space handbrake, L launch, R reset, C camera
 */

export interface DriveInput {
  throttle: number; // W / Up: 0..1
  brake: number; // S / Down: 0..1
  steer: number; // A/D or Left/Right: -1..1 (left positive)
  handbrake: boolean; // Space
  upshiftPressed: boolean; // E edge
  downshiftPressed: boolean; // Q edge
  toggleModePressed: boolean; // M edge
  toggleLaunchPressed: boolean; // L edge
  resetPressed: boolean; // R edge
  toggleCameraPressed: boolean; // C edge
  startPressed: boolean; // Enter edge
  escapePressed: boolean; // Esc edge (release mouse)
}

export class InputManager {
  private keys = new Set<string>();
  private edgeQueue = new Set<string>();

  throttle = 0;
  brake = 0;
  steer = 0;

  constructor() {
    this.onKeyDown = this.onKeyDown.bind(this);
    this.onKeyUp = this.onKeyUp.bind(this);
  }

  attach() {
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
  }

  detach() {
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('keyup', this.onKeyUp);
  }

  private normalize(e: KeyboardEvent): string {
    return e.code; // KeyW, KeyA, KeyS, KeyD, KeyQ, KeyE, KeyM, KeyL, KeyR, KeyC, Space, ArrowUp...
  }

  private onKeyDown(e: KeyboardEvent) {
    const c = this.normalize(e);
    // preventDefault on game keys: stops page scroll on Space/arrows AND the
    // macOS "funk" alert sound some hosts play for unhandled key input.
    if (
      c === 'Space' || c.startsWith('Arrow') ||
      c === 'KeyW' || c === 'KeyA' || c === 'KeyS' || c === 'KeyD' ||
      c === 'KeyQ' || c === 'KeyE' || c === 'KeyM' || c === 'KeyL' ||
      c === 'KeyR' || c === 'KeyC'
    ) {
      e.preventDefault();
    }
    if (!e.repeat) this.edgeQueue.add(c);
    this.keys.add(c);
  }

  private onKeyUp(e: KeyboardEvent) {
    this.keys.delete(this.normalize(e));
  }

  /** Call once per frame to smooth analog inputs */
  update(dt: number): DriveInput {
    const k = this.keys;
    const has = (c: string) => k.has(c);

    const throttleTarget = has('KeyW') || has('ArrowUp') ? 1 : 0;
    const brakeTarget = has('KeyS') || has('ArrowDown') ? 1 : 0;
    const steerTarget = (has('KeyA') || has('ArrowLeft') ? 1 : 0) - (has('KeyD') || has('ArrowRight') ? 1 : 0);

    // Fast attack, medium release for pedals; smooth steering
    const pedalSpeed = 6;
    this.throttle += Math.sign(throttleTarget - this.throttle) * Math.min(Math.abs(throttleTarget - this.throttle), pedalSpeed * dt);
    this.brake += Math.sign(brakeTarget - this.brake) * Math.min(Math.abs(brakeTarget - this.brake), pedalSpeed * dt);

    const steerSpeed = steerTarget !== 0 ? 4.5 : 7.0;
    this.steer += Math.sign(steerTarget - this.steer) * Math.min(Math.abs(steerTarget - this.steer), steerSpeed * dt);

    const edge = (c: string) => {
      if (this.edgeQueue.has(c)) {
        this.edgeQueue.delete(c);
        return true;
      }
      return false;
    };

    const out: DriveInput = {
      throttle: this.throttle,
      brake: this.brake,
      steer: this.steer,
      handbrake: has('Space'),
      upshiftPressed: edge('KeyE'),
      downshiftPressed: edge('KeyQ'),
      toggleModePressed: edge('KeyM'),
      toggleLaunchPressed: edge('KeyL'),
      resetPressed: edge('KeyR'),
      toggleCameraPressed: edge('KeyC'),
      startPressed: edge('Enter'),
      escapePressed: edge('Escape'),
    };

    // clear stale edges (keys pressed but not consumed — keep only 1 frame)
    this.edgeQueue.clear();
    return out;
  }
}
