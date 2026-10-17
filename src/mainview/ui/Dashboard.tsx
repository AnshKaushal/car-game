import { useEffect, useMemo, useRef } from "react"
import type { CarTelemetry } from "../systems/CarController"

const RED_FROM_RPM = 6750
const MAX_RPM = 8000
const MAX_KMH = 340

type Side = "left" | "right"
type Kind = "speed" | "rpm"

const S = 200
const R_RIM = 190
const R_PROG = 185
const R_BAND = 180
const R_TICK = 180
const R_LABEL = 150
const R_HUB = 135
const START = 6
const END = 84
const N_BASE = R_HUB - 20
const N_SPLIT = R_TICK - 40
const N_END = R_TICK - 2

const SANS = 'Inter, -apple-system, "Segoe UI", Helvetica, Arial, sans-serif'

const BLUE = "#5fb4ff"
const AMBER = "#ffb020"
const RED = "#ff3b30"
const OFF = "#3a4350"

const ang = (frac: number) =>
  START + Math.max(0, Math.min(1, frac)) * (END - START)

function pt(side: Side, r: number, deg: number) {
  const a = (deg * Math.PI) / 180
  const dx = r * Math.cos(a)
  return { x: side === "left" ? dx : S - dx, y: S - r * Math.sin(a) }
}

function arc(side: Side, r: number, d0: number, d1: number) {
  const p0 = pt(side, r, d0)
  const p1 = pt(side, r, d1)
  const sweep = side === "left" ? 0 : 1
  return `M ${p0.x} ${p0.y} A ${r} ${r} 0 0 ${sweep} ${p1.x} ${p1.y}`
}

function sector(side: Side, r: number) {
  const cx = side === "left" ? 0 : S
  const p0 = pt(side, r, 0)
  const p1 = pt(side, r, 90)
  const sweep = side === "left" ? 0 : 1
  return `M ${cx} ${S} L ${p0.x} ${p0.y} A ${r} ${r} 0 0 ${sweep} ${p1.x} ${p1.y} Z`
}

const ease = (x: number) => x * x * (3 - 2 * x)

interface DialRefs {
  needle: { current: SVGGElement | null }
  progress: { current: SVGPathElement | null }
  num: { current: SVGTextElement | null }
  icon: { current: SVGGElement | null }
  rim: { current: SVGPathElement | null }
}

function useDialRefs(): DialRefs {
  return {
    needle: useRef<SVGGElement | null>(null),
    progress: useRef<SVGPathElement | null>(null),
    num: useRef<SVGTextElement | null>(null),
    icon: useRef<SVGGElement | null>(null),
    rim: useRef<SVGPathElement | null>(null),
  }
}

function buildScale(
  side: Side,
  kind: Kind,
  maxValue: number,
  redFrom: number,
  yellowFrom: number,
) {
  const out: React.ReactNode[] = []
  const isRpm = kind === "rpm"
  const unitMax = isRpm ? maxValue : maxValue
  const major = isRpm ? 1000 : maxValue <= 100 ? 10 : maxValue <= 200 ? 20 : 40
  const minor = isRpm ? 200 : major === 10 ? 5 : major / 4
  const n = Math.floor(unitMax / minor + 1e-6)

  for (let i = 0; i <= n; i++) {
    const v = i * minor
    const frac = v / maxValue
    const a = ang(frac)
    const isMajor = Math.abs(v / major - Math.round(v / major)) < 1e-6
    const red = isRpm && v >= redFrom
    const yellow = isRpm && v >= yellowFrom && !red
    const p1 = pt(side, R_TICK, a)
    const p2 = pt(side, R_TICK - (isMajor ? 21 : 10), a)
    out.push(
      <line
        key={"k" + i}
        x1={p1.x}
        y1={p1.y}
        x2={p2.x}
        y2={p2.y}
        stroke={
          red
            ? "#ff3b30"
            : yellow
              ? "#facc15"
              : isMajor
                ? "#f1f3f6"
                : "rgba(255,222,212,0.5)"
        }
        strokeWidth={isMajor ? 2.4 : 1.1}
        strokeLinecap="round"
      />,
    )
    if (isMajor) {
      const lp = pt(side, R_LABEL, a)
      const label = isRpm ? Math.round(v / 1000) : Math.round(v)
      out.push(
        <text
          key={"l" + i}
          x={lp.x}
          y={lp.y + 4.6}
          textAnchor="middle"
          fontSize="13"
          fontWeight={600}
          fontFamily={SANS}
          fill={red ? "#ff6a60" : yellow ? "#facc15" : "#d9dee6"}
        >
          {label}
        </text>,
      )
    }
  }

  if (isRpm && redFrom < maxValue) {
    out.push(
      <path
        key="band"
        d={arc(side, R_BAND, ang(redFrom / maxValue), ang(1))}
        fill="none"
        stroke="#e30613"
        strokeWidth="4"
      />,
    )
  }
  return out
}

function ParkIcon() {
  return (
    <g
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
    >
      <path d="M4.6 6.2a8.5 8.5 0 0 0 0 11.6" />
      <path d="M19.4 6.2a8.5 8.5 0 0 1 0 11.6" />
      <circle cx="12" cy="12" r="6.6" />
      <path
        d="M10.1 15.6V8.4h2.4a2.1 2.1 0 0 1 0 4.2h-2.4"
        strokeLinejoin="round"
      />
    </g>
  )
}

function DriftIcon() {
  return (
    <g
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M3 14V11.6l2.2-3.2h7.6l3.2 3.2h3.4V14z" />
      <circle cx="7.2" cy="14.6" r="1.5" fill="currentColor" stroke="none" />
      <circle cx="16.6" cy="14.6" r="1.5" fill="currentColor" stroke="none" />
      <path d="M3 18.6c2-1.8 4 1.8 6 0s4 1.8 6 0 4 1.8 6 0" />
      <path d="M3 22c2-1.8 4 1.8 6 0s4 1.8 6 0 4 1.8 6 0" />
    </g>
  )
}

interface DialProps {
  side: Side
  kind: Kind
  id: string
  maxValue: number
  redFrom?: number
  yellowFrom?: number
  caption: string
  captionColor: string
  refs: DialRefs
}

function Dial({
  side,
  kind,
  id,
  maxValue,
  redFrom = Infinity,
  yellowFrom = Infinity,
  caption,
  captionColor,
  refs,
}: DialProps) {
  const cx = side === "left" ? 0 : S
  const dir = side === "left" ? 1 : -1
  const sign = side === "left" ? -1 : 1
  const X = (u: number) => (side === "left" ? u : S - u)
  const Y = (v: number) => S - v
  const nx = (u: number) => cx + dir * u

  const scale = useMemo(
    () => buildScale(side, kind, maxValue, redFrom, yellowFrom),
    [side, kind, maxValue, redFrom, yellowFrom],
  )

  const bar = (u0: number, w0: number, u1: number, w1: number) =>
    [
      [u0, -w0],
      [u1, -w1],
      [u1, w1],
      [u0, w0],
    ]
      .map(([u, d]) => `${nx(u)},${S + d}`)
      .join(" ")

  const body = bar(N_BASE, 3.4, N_SPLIT + 6, 2.2)
  const tip = bar(N_SPLIT, 2.2, N_END, 1.0)

  const iconPos = { x: X(34) - 12, y: Y(86) - 12 }

  return (
    <svg viewBox={`0 0 ${S} ${S}`} className="block h-auto w-full">
      <defs>
        <radialGradient
          id={`${id}-face`}
          gradientUnits="userSpaceOnUse"
          cx={cx}
          cy={S}
          r={R_RIM}
        >
          <stop offset="0%" stopColor="#1c222c" />
          <stop offset="55%" stopColor="#10141a" />
          <stop offset="100%" stopColor="#07090d" />
        </radialGradient>
        <radialGradient
          id={`${id}-hub`}
          gradientUnits="userSpaceOnUse"
          cx={cx}
          cy={S}
          r={R_HUB}
        >
          <stop offset="0%" stopColor="#04060a" />
          <stop offset="70%" stopColor="#0b0e14" />
          <stop offset="100%" stopColor="#171c25" />
        </radialGradient>
        <linearGradient
          id={`${id}-chrome`}
          gradientUnits="userSpaceOnUse"
          x1="0"
          y1="0"
          x2={S}
          y2={S}
        >
          <stop offset="0%" stopColor="#f4f6f9" />
          <stop offset="25%" stopColor="#9aa1ab" />
          <stop offset="50%" stopColor="#e8ecf1" />
          <stop offset="75%" stopColor="#6b7280" />
          <stop offset="100%" stopColor="#dfe4ea" />
        </linearGradient>
      </defs>

      {}
      <path
        d={sector(side, R_RIM + 3)}
        fill={`url(#${id}-face)`}
        opacity="0.95"
      />
      <path
        ref={refs.rim}
        d={arc(side, R_RIM, 0, 90)}
        fill="none"
        stroke={`url(#${id}-chrome)`}
        strokeWidth="6"
      />
      <path
        d={arc(side, R_RIM - 4.5, 0, 90)}
        fill="none"
        stroke="#04060a"
        strokeWidth="1.5"
        opacity="0.9"
      />
      <path
        d={arc(side, 176, START - 4, END + 4)}
        fill="none"
        stroke="rgba(255,255,255,0.07)"
        strokeWidth="1"
      />

      {}
      {scale}

      {}
      <path
        ref={refs.progress}
        d={arc(side, R_PROG, START, START)}
        fill="none"
        strokeWidth="3"
      />

      {}
      <g
        ref={refs.needle}
        transform={`rotate(${sign * START} ${cx} ${S})`}
        style={{ filter: "drop-shadow(0 0 3px rgba(0,0,0,0.7))" }}
      >
        <polygon points={body} fill="#eef1f5" />
        <polygon points={tip} fill="#ff3b30" />
      </g>

      {}
      <path d={sector(side, R_HUB)} fill={`url(#${id}-hub)`} />
      <path
        d={arc(side, R_HUB, 0, 90)}
        fill="none"
        stroke={`url(#${id}-chrome)`}
        strokeWidth="3.5"
      />
      <path
        d={arc(side, R_HUB - 3.5, 0, 90)}
        fill="none"
        stroke="#000"
        strokeWidth="1"
        opacity="0.8"
      />

      {}
      <text
        ref={refs.num}
        x={X(52)}
        y={Y(34)}
        textAnchor="middle"
        fontSize={kind === "rpm" ? 40 : 32}
        fontWeight={700}
        fill="#ffffff"
        fontFamily={SANS}
        style={{
          fontVariantNumeric: "tabular-nums",
          transformBox: "fill-box",
          transformOrigin: "center",
        }}
      />
      <text
        x={X(52)}
        y={Y(17)}
        textAnchor="middle"
        fontSize="8.5"
        fontWeight={600}
        letterSpacing="2"
        fill={captionColor}
        fontFamily={SANS}
      >
        {caption}
      </text>

      {}
      <g transform={`translate(${iconPos.x} ${iconPos.y})`}>
        <g ref={refs.icon} style={{ color: OFF, opacity: 0.85 }}>
          {kind === "speed" ? <ParkIcon /> : <DriftIcon />}
        </g>
      </g>
    </svg>
  )
}

function paintDial(
  refs: DialRefs,
  side: Side,
  frac: number,
  color: string,
  opacity: number,
) {
  const cx = side === "left" ? 0 : S
  const sign = side === "left" ? -1 : 1
  const a = ang(frac)
  refs.needle.current?.setAttribute(
    "transform",
    `rotate(${sign * a} ${cx} ${S})`,
  )
  const p = refs.progress.current
  if (p) {
    p.setAttribute("d", arc(side, R_PROG, START, a))
    p.style.opacity = String(opacity)
    if (p.dataset.c !== color) {
      p.dataset.c = color
      p.setAttribute("stroke", color)
      p.style.filter = `drop-shadow(0 0 4px ${color})`
    }
  }
}

function paintTelltale(
  el: SVGGElement | null,
  on: boolean,
  color: string,
  lit: boolean,
) {
  if (!el) return
  el.style.color = on ? color : OFF
  el.style.opacity = on ? (lit ? "1" : "0.12") : "0.85"
  el.style.filter = on && lit ? `drop-shadow(0 0 4px ${color})` : "none"
}

export default function Dashboard({ tele }: { tele: CarTelemetry }) {
  const teleRef = useRef(tele)
  teleRef.current = tele

  const dashMaxRpm = tele.dash?.maxRpm ?? MAX_RPM
  const dashRedFrom = tele.dash?.redFromRpm ?? RED_FROM_RPM
  const dashYellowFrom = dashRedFrom - 1000
  const dashMaxKmh = tele.dash?.maxKmh ?? MAX_KMH
  const dashRef = useRef({
    maxRpm: dashMaxRpm,
    red: dashRedFrom,
    yellow: dashYellowFrom,
    kmh: dashMaxKmh,
  })
  dashRef.current = {
    maxRpm: dashMaxRpm,
    red: dashRedFrom,
    yellow: dashYellowFrom,
    kmh: dashMaxKmh,
  }

  const spd = useDialRefs()
  const rpm = useDialRefs()

  useEffect(() => {
    let raf = 0
    const start = performance.now()
    let last = start
    let dRpm = 0
    let dKmh = 0
    let lastNumT = -1e9
    let lastGear = ""
    let popT = -1e9
    const BOOT = 1500

    const loop = (now: number) => {
      raf = requestAnimationFrame(loop)
      const dt = Math.min(0.05, (now - last) / 1000)
      last = now
      const t = teleRef.current as CarTelemetry
      const dash = dashRef.current

      const boot = now - start
      const booting = boot < BOOT
      let tRpm = t.rpm
      let tKmh = Math.abs(t.speedKmh)
      if (booting) {
        const k = boot / BOOT
        const f = k < 0.5 ? ease(k * 2) : 1 - ease((k - 0.5) * 2)
        tRpm = f * dash.maxRpm
        tKmh = f * dash.kmh
      }

      dRpm += (tRpm - dRpm) * (1 - Math.exp(-dt * 14))
      dKmh += (tKmh - dKmh) * (1 - Math.exp(-dt * 10))

      paintDial(spd, "left", dKmh / dash.kmh, BLUE, 0.9)
      if (spd.num.current && (booting || now - lastNumT >= 500)) {
        lastNumT = now
        spd.num.current.textContent = String(Math.round(dKmh))
      }

      const limiter = !booting && dRpm >= dash.red
      const warning = !booting && dRpm >= dash.yellow
      const flash = limiter ? (Math.sin(now * 0.045) > 0 ? 1 : 0.1) : 1
      paintDial(
        rpm,
        "right",
        dRpm / dash.maxRpm,
        limiter ? "#ff2d2d" : warning ? "#facc15" : BLUE,
        limiter ? flash : 0.9,
      )

      const rim = rpm.rim.current
      if (rim) {
        rim.setAttribute(
          "stroke",
          limiter ? `rgba(227,6,19,${flash})` : "url(#bmw-rpm-chrome)",
        )
        rim.setAttribute(
          "stroke-width",
          limiter ? String(6 + flash * 2) : warning ? "7" : "6",
        )
        rim.style.filter = limiter
          ? flash > 0.5
            ? "drop-shadow(0 0 5px rgba(227,6,19,0.95))"
            : "none"
          : warning
            ? "drop-shadow(0 0 5px rgba(250,204,21,0.85))"
            : "none"
      }

      const gear = t.gearLabel
      const g = rpm.num.current
      if (g) {
        if (g.textContent !== gear) g.textContent = gear
        if (gear !== lastGear) {
          lastGear = gear
          popT = now
        }
        const k = Math.max(0, 1 - (now - popT) / 260)
        g.style.transform = `scale(${1 + 0.28 * k * k})`
        g.setAttribute(
          "fill",
          gear === "R" ? "#ff5a5a" : gear === "N" ? "#f5b942" : "#ffffff",
        )
      }

      const blink = Math.floor(now / 170) % 2 === 0
      paintTelltale(spd.icon.current, booting || t.parkingBrake, RED, true)
      paintTelltale(
        rpm.icon.current,
        booting || !!t.drift,
        AMBER,
        booting || blink,
      )
    }

    raf = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(raf)
  }, [])

  const launching = tele.launchArmed || tele.launching
  return (
    <div
      className="pointer-events-none absolute inset-0 select-none"
      style={{ fontFamily: SANS }}
    >
      {launching && (
        <div className="absolute top-8 left-1/2 -translate-x-1/2 rounded-xl border-4 border-red-500 bg-[#14090b] px-8 py-2">
          <div className="text-center text-xl font-bold tracking-[0.2em] text-red-500">
            {tele.launching ? "Launch" : "Launch control ready"}
          </div>
          {!tele.launching && (
            <div className="mt-0.5 text-center text-[11px] tracking-[0.18em] text-red-200/80">
              Let go of S to take off
            </div>
          )}
        </div>
      )}

      <div className="absolute inset-x-0 bottom-0 flex items-end justify-between">
        <div className="w-[clamp(190px,25vw,340px)]">
          <Dial
            side="left"
            kind="speed"
            id="bmw-spd"
            maxValue={dashMaxKmh}
            caption="KM/H"
            captionColor="#8f99a8"
            refs={spd}
          />
        </div>
        <div className="w-[clamp(190px,25vw,340px)]">
          <Dial
            side="right"
            kind="rpm"
            id="bmw-rpm"
            maxValue={dashMaxRpm}
            redFrom={dashRedFrom}
            yellowFrom={dashYellowFrom}
            caption={tele.autoMode ? "AUTO" : "MANUAL"}
            captionColor={tele.autoMode ? "#7db8ec" : "#cbd5e1"}
            refs={rpm}
          />
        </div>
      </div>
    </div>
  )
}
