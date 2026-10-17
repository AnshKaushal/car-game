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

gsap.ticker.lagSmoothing(0)

export const EASE = {
  out: "expo.out",
  soft: "power3.out",
  in: "power2.in",
  inOut: "power3.inOut",
} as const

const CLEAN = "opacity,visibility,will-change"

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
  selector: string
  from?: gsap.TweenVars
  to?: gsap.TweenVars
  each?: number
  delay?: number
}

export type ScreenProps = {
  open: boolean
  children: ReactNode
  className?: string
  style?: CSSProperties
  from?: gsap.TweenVars
  to?: gsap.TweenVars
  exit?: gsap.TweenVars
  stagger?: StaggerSpec | StaggerSpec[]
  onClosed?: () => void
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
      gsap
        .timeline()
        .set(el, { autoAlpha: 1 })
        .set(".wipe-bar", { autoAlpha: 0 })
        .set(".wipe-label", { autoAlpha: 0 })
        .to(".wipe-bar", { autoAlpha: 1, duration: 0.3, ease: EASE.inOut })
        .to(
          ".wipe-label",
          { autoAlpha: 1, duration: 0.34, ease: EASE.soft },
          "-=0.12",
        )
        .to({}, { duration: 0.34 })
        .to(".wipe-label", { autoAlpha: 0, duration: 0.22 })
        .to(
          ".wipe-bar",
          { autoAlpha: 0, duration: 0.36, ease: EASE.inOut },
          "-=0.14",
        )
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
