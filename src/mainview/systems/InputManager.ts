/** True when the key event comes from a text field — game keys must not fire. */
function isTypingTarget(e: KeyboardEvent): boolean {
  const t = e.target as HTMLElement | null
  if (!t) return false
  const tag = (t.tagName || "").toUpperCase()
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true
  if (t.isContentEditable) return true
  return false
}

export interface DriveInput {
  throttle: number
  brake: number
  steer: number
  handbrake: boolean
  upshiftPressed: boolean
  downshiftPressed: boolean
  toggleModePressed: boolean
  toggleLaunchPressed: boolean
  toggleParkPressed: boolean
  resetPressed: boolean
  toggleCameraPressed: boolean
  startPressed: boolean
  pausePressed: boolean
}

export class InputManager {
  private keys = new Set<string>()
  private edgeQueue = new Set<string>()

  throttle = 0
  brake = 0
  steer = 0

  constructor() {
    this.onKeyDown = this.onKeyDown.bind(this)
    this.onKeyUp = this.onKeyUp.bind(this)
  }

  attach() {
    window.addEventListener("keydown", this.onKeyDown)
    window.addEventListener("keyup", this.onKeyUp)
  }

  detach() {
    window.removeEventListener("keydown", this.onKeyDown)
    window.removeEventListener("keyup", this.onKeyUp)
  }

  private normalize(e: KeyboardEvent): string {
    return e.code
  }

  private onKeyDown(e: KeyboardEvent) {
    // Never hijack keystrokes typed into form fields (lobby name/room inputs).
    if (isTypingTarget(e)) return
    const c = this.normalize(e)
    if (
      c === "Space" ||
      c.startsWith("Arrow") ||
      c === "KeyW" ||
      c === "KeyA" ||
      c === "KeyS" ||
      c === "KeyD" ||
      c === "KeyQ" ||
      c === "KeyE" ||
      c === "KeyM" ||
      c === "KeyL" ||
      c === "KeyP" ||
      c === "KeyO" ||
      c === "KeyR" ||
      c === "KeyC"
    ) {
      e.preventDefault()
    }
    if (!e.repeat) this.edgeQueue.add(c)
    this.keys.add(c)
  }

  private onKeyUp(e: KeyboardEvent) {
    if (isTypingTarget(e)) return
    this.keys.delete(this.normalize(e))
  }

  clear() {
    this.keys.clear()
    this.edgeQueue.clear()
    this.throttle = 0
    this.brake = 0
    this.steer = 0
  }

  update(dt: number): DriveInput {
    const k = this.keys
    const has = (c: string) => k.has(c)

    const throttleTarget = has("KeyW") || has("ArrowUp") ? 1 : 0
    const brakeTarget = has("KeyS") || has("ArrowDown") ? 1 : 0
    const steerTarget =
      (has("KeyA") || has("ArrowLeft") ? 1 : 0) -
      (has("KeyD") || has("ArrowRight") ? 1 : 0)

    const pedalSpeed = 6
    this.throttle +=
      Math.sign(throttleTarget - this.throttle) *
      Math.min(Math.abs(throttleTarget - this.throttle), pedalSpeed * dt)
    this.brake +=
      Math.sign(brakeTarget - this.brake) *
      Math.min(Math.abs(brakeTarget - this.brake), pedalSpeed * dt)

    const steerSpeed = steerTarget !== 0 ? 4.5 : 7.0
    this.steer +=
      Math.sign(steerTarget - this.steer) *
      Math.min(Math.abs(steerTarget - this.steer), steerSpeed * dt)

    const edge = (c: string) => {
      if (this.edgeQueue.has(c)) {
        this.edgeQueue.delete(c)
        return true
      }
      return false
    }

    const out: DriveInput = {
      throttle: this.throttle,
      brake: this.brake,
      steer: this.steer,
      handbrake: has("Space"),
      upshiftPressed: edge("KeyE"),
      downshiftPressed: edge("KeyQ"),
      toggleModePressed: edge("KeyM"),
      toggleLaunchPressed: edge("KeyL"),
      toggleParkPressed: edge("KeyO"),
      resetPressed: edge("KeyR"),
      toggleCameraPressed: edge("KeyC"),
      startPressed: edge("Enter"),
      pausePressed: edge("KeyP"),
    }

    this.edgeQueue.clear()
    return out
  }
}
