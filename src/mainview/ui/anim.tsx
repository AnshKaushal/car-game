import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
  type RefObject,
} from "react"
import gsap from "gsap"

// GSAP's default lag smoothing rewrites any frame longer than 500ms as a
// 33ms step. This app drops frames like that on purpose and by accident —
// world rebuilds, model uploads, shader compiles — and every one of those
// frames then advances animations by a third of a frame, so transitions
// crawl in slow motion instead of skipping ahead. Wall-clock accuracy is
// what we want here: an animation that lands late reads as a dropped
// frame, an animation that runs at a tenth of speed reads as broken.
gsap.ticker.lagSmoothing(0)

/**
 * Screen transitions. Every full-bleed overlay in the game (intro, garage,
 * lobby, pause, results, loading, error) is wrapped in <Screen>, which
 * owns the entrance timeline and — the part React can't do on its own —
 * the exit timeline: the subtree stays mounted while it plays out, then
 * unmounts. Without that, an exit "animation" is just a cutoff.
 *
 * Elements inside a screen opt into a staggered entrance with a
 * `data-a` / `data-row` attribute; the stagger selectors below pick them
 * up, so per-element animation stays declarative in the markup.
 */

/** Shared easing vocabulary. Screens enter soft and quick, exits are
 *  faster still — a resume should feel instant. */
export const EASE = {
  out: "expo.out",
  soft: "power3.out",
  in: "power2.in",
  inOut: "power3.inOut",
} as const

/** What GSAP is allowed to clean up when an entrance finishes.
 *
 *  Deliberately NOT `transform`: Tailwind v4 expresses `-translate-x-1/2`
 *  and friends as the standalone `translate` property, and asking GSAP to
 *  clear `transform` makes it bake that translate into its own
 *  `transform` value — so the offset is applied twice and the element
 *  jumps at the end of the animation. Leaving a plain
 *  `translate3d(0,0,0)` inline is harmless: hover/active scale and
 *  translate utilities ride on `scale`/`translate`, which compose with
 *  it instead of replacing it. */
const CLEAN = "opacity,visibility,will-change"

/** Opacity is the only property these animations are allowed to touch.
 *  Anything that moves or scales an element is dropped here rather than
 *  left to fight Tailwind v4's `translate`/`scale` utilities at runtime —
 *  two systems writing the same channel is what makes an element render
 *  in one place and land in another. */
const MOTION_KEYS = [
  "x",
  "y",
  "z",
  "xPercent",
  "yPercent",
  "scale",
  "scaleX",
  "scaleY",
  "rotation",
  "rotate",
  "skewX",
  "skewY",
  "transformOrigin",
  "transformPerspective",
]
const still = (v?: gsap.TweenVars) => {
  if (!v) return v
  const out = { ...v }
  for (const k of MOTION_KEYS) delete out[k]
  return out
}

export type StaggerSpec = {
  /** Selector text, scoped to the screen root by gsap.context. */
  selector: string
  from?: gsap.TweenVars
  to?: gsap.TweenVars
  /** Delay between each matched element. */
  each?: number
  /** Delay before the first element starts. */
  delay?: number
}

export type ScreenProps = {
  /** Rendered while true. False starts the exit, then unmounts. */
  open: boolean
  children: ReactNode
  className?: string
  style?: CSSProperties
  /** Root entrance (defaults to a plain fade). */
  from?: gsap.TweenVars
  to?: gsap.TweenVars
  /** Exit; usually just a faster fade. */
  exit?: gsap.TweenVars
  stagger?: StaggerSpec | StaggerSpec[]
  /** Fired after the exit timeline finishes. */
  onClosed?: () => void
  /** Click-to-dismiss on the screen root (the intro title card). */
  onClick?: () => void
}

export function Screen({
  open,
  children,
  className = "",
  style,
  from,
  to,
  exit,
  stagger,
  onClosed,
  onClick,
}: ScreenProps) {
  const ref = useRef<HTMLDivElement>(null)
  const [mounted, setMounted] = useState(open)
  const exitTl = useRef<gsap.core.Timeline | null>(null)

  useLayoutEffect(() => {
    if (open) setMounted(true)
  }, [open])

  // Entrance. Runs when `open` flips on and again once the subtree has
  // actually mounted (the ref is empty on the first pass).
  useLayoutEffect(() => {
    if (!open || !mounted) return
    const el = ref.current
    if (!el) return
    el.style.pointerEvents = ""
    const ctx = gsap.context(() => {
      gsap.fromTo(
        el,
        { autoAlpha: 0, ...still(from) },
        {
          autoAlpha: 1,
          duration: 0.45,
          ease: EASE.soft,
          clearProps: CLEAN,
          ...still(to),
        },
      )
      const specs = stagger
        ? Array.isArray(stagger)
          ? stagger
          : [stagger]
        : []
      for (const s of specs) {
        gsap.fromTo(
          s.selector,
          { autoAlpha: 0, ...still(s.from) },
          {
            autoAlpha: 1,
            duration: 0.55,
            ease: EASE.out,
            stagger: s.each ?? 0.05,
            delay: s.delay ?? 0.04,
            clearProps: CLEAN,
            ...still(s.to),
          },
        )
      }
    }, el)
    return () => ctx.revert()
  }, [open, mounted])

  // Exit. The subtree stays mounted (and non-interactive) until the
  // timeline completes, then drops.
  useLayoutEffect(() => {
    if (open || !mounted) return
    const el = ref.current
    if (!el) {
      setMounted(false)
      onClosed?.()
      return
    }
    exitTl.current?.kill()
    el.style.pointerEvents = "none"
    const tl = gsap.timeline({
      onComplete: () => {
        exitTl.current = null
        setMounted(false)
        onClosed?.()
      },
    })
    // No clearProps here: stripping the inline opacity at the end of the
    // fade would snap the screen back to full opacity for a frame
    // between the timeline finishing and the unmount landing.
    tl.to(el, { autoAlpha: 0, duration: 0.3, ease: EASE.in, ...still(exit) })
    exitTl.current = tl
    return () => {
      tl.kill()
    }
  }, [open, mounted])

  if (!mounted) return null
  return (
    <div ref={ref} className={className} style={style} onClick={onClick}>
      {children}
    </div>
  )
}

/**
 * Keeps a subtree rendered for `ms` after `open` goes false, so a
 * <Screen> inside it can finish its exit timeline before React tears the
 * whole thing down. Pair the duration with the screen's exit length.
 */
export function usePresence(open: boolean, ms = 320) {
  const [shown, setShown] = useState(open)
  useEffect(() => {
    if (open) {
      setShown(true)
      return
    }
    const t = window.setTimeout(() => setShown(false), ms)
    return () => window.clearTimeout(t)
  }, [open, ms])
  return shown
}

/**
 * Full-screen wipe used when the session changes: rolling onto the grid,
 * dropping into free roam, heading back to the garage. A colour field
 * sweeps in, the label snaps in on top of it, then it sweeps away. Bump
 * `token` to fire it again; 0 means idle.
 */
export function Wipe({
  token,
  label,
  tone = "blue",
}: {
  token: number
  label: string
  tone?: "blue" | "red"
}) {
  const ref = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el || !token) return
    const ctx = gsap.context(() => {
      // Opacity only: the colour field and the label fade rather than
      // scaling or sliding. Nothing here moves an element, so nothing
      // can fight Tailwind's translate/scale utilities.
      gsap
        .timeline()
        .set(el, { autoAlpha: 1 })
        .set(".wipe-bar", { autoAlpha: 0 })
        .set(".wipe-label", { autoAlpha: 0 })
        .to(".wipe-bar", { autoAlpha: 1, duration: 0.3, ease: EASE.inOut })
        .to(".wipe-label", { autoAlpha: 1, duration: 0.34, ease: EASE.soft }, "-=0.12")
        .to({}, { duration: 0.34 })
        .to(".wipe-label", { autoAlpha: 0, duration: 0.22 })
        .to(".wipe-bar", { autoAlpha: 0, duration: 0.36, ease: EASE.inOut }, "-=0.14")
        .set(el, { autoAlpha: 0 })
        .set(".wipe-bar, .wipe-label", { clearProps: CLEAN })
    }, el)
    return () => ctx.revert()
  }, [token])

  return (
    <div
      ref={ref}
      className="pointer-events-none absolute inset-0 z-[80] overflow-hidden opacity-0"
    >
      <div
        className="wipe-bar absolute inset-0"
        style={{ background: tone === "red" ? "#e30613" : "#51a7d5" }}
      />
      <div className="wipe-label absolute inset-0 grid place-items-center">
        <span className="px-6 text-center text-[52px] font-bold leading-[0.9] tracking-tight text-white drop-shadow-[0_10px_40px_rgba(0,0,0,0.6)] md:text-[104px]">
          {label}
        </span>
      </div>
    </div>
  )
}

/**
 * Pop-in for elements that appear on their own schedule — the countdown
 * digits, "GO!", the position pill. Pass the values that should retrigger
 * it; the pop fires on mount too.
 */
export function usePop<T extends HTMLElement = HTMLDivElement>(
  deps: unknown[] = [],
) {
  const ref = useRef<T>(null)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    gsap.fromTo(
      el,
      { autoAlpha: 0 },
      { autoAlpha: 1, duration: 0.42, ease: EASE.soft, clearProps: CLEAN },
    )
  }, deps)
  return ref
}

/**
 * Re-runs a stagger on every `deps` change, for blocks that swap in after
 * their screen is already open — the lobby's roster once the room
 * connects, plus every player who joins after that.
 */
export function useStaggerIn<T extends HTMLElement>(
  ref: RefObject<T>,
  selector: string,
  deps: unknown[],
  skip = false,
) {
  useLayoutEffect(() => {
    const el = ref.current
    if (!el || skip) return
    const nodes = el.querySelectorAll(selector)
    if (nodes.length === 0) return
    const tween = gsap.fromTo(
      nodes,
      { autoAlpha: 0 },
      {
        autoAlpha: 1,
        duration: 0.5,
        ease: EASE.out,
        stagger: 0.05,
        clearProps: CLEAN,
      },
    )
    return () => {
      tween.kill()
    }
  }, deps)
}