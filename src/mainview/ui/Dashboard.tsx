import { useEffect, useRef } from "react"
import type { CarTelemetry } from "../systems/CarController"

const RED_FROM_RPM = 6750
const YELLOW_FROM_RPM = 5750
const MAX_RPM = 8000
const MAX_KMH = 340

function angleFor(frac: number) {
  return -120 + Math.max(0, Math.min(1, frac)) * 240
}
function polar(cx: number, cy: number, r: number, deg: number) {
  const a = ((deg - 90) * Math.PI) / 180
  return { x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) }
}

interface GaugeRefs {
  needleRef: { current: SVGGElement | null }
  numRef: { current: SVGTextElement | null }
  rimRef?: { current: SVGCircleElement | null }
}

const SANS = 'Inter, -apple-system, "Segoe UI", Helvetica, Arial, sans-serif'

function BmwDial({
  title,
  unit,
  maxLabel,
  redFrom,
  refs,
  id,
  modeLabel,
}: {
  title: string
  unit: string
  maxLabel: number
  redFrom: number
  refs: GaugeRefs
  id: string
  modeLabel?: string
}) {
  const CX = 100,
    CY = 100,
    CR = 78
  const ticks: React.ReactNode[] = []
  const isRpm = maxLabel <= 10
  const steps = isRpm ? 40 : 68
  const labelEvery = isRpm ? 5 : 8

  for (let i = 0; i <= steps; i++) {
    const frac = i / steps
    const a = angleFor(frac)
    const labelled = i % labelEvery === 0 || i === steps
    const p1 = polar(CX, CY, CR, a)
    const p2 = polar(CX, CY, CR - (labelled ? 12 : 6), a)
    const rpm = frac * maxLabel * 1000
    const red = isRpm && rpm >= RED_FROM_RPM
    const yellow = isRpm && rpm >= YELLOW_FROM_RPM && !red
    ticks.push(
      <line
        key={i}
        x1={p1.x}
        y1={p1.y}
        x2={p2.x}
        y2={p2.y}
        stroke={
          red
            ? "#e30613"
            : yellow
              ? "#facc15"
              : labelled
                ? "#f2f4f7"
                : "rgba(242,244,247,0.45)"
        }
        strokeWidth={labelled ? 2.6 : 1.2}
        strokeLinecap="round"
      />,
    )
    if (labelled) {
      const pt = polar(CX, CY, CR - 25, a)
      const val = isRpm
        ? Math.round(frac * maxLabel)
        : Math.round((frac * maxLabel) / 10) * 10
      ticks.push(
        <text
          key={"t" + i}
          x={pt.x}
          y={pt.y + 5}
          textAnchor="middle"
          fontSize="12.5"
          fill={red ? "#ff5a5a" : yellow ? "#facc15" : "#e8ebef"}
          fontFamily={SANS}
          fontWeight={600}
        >
          {val}
        </text>,
      )
    }
  }

  const r0 = polar(CX, CY, CR - 1, angleFor(redFrom))
  const r1 = polar(CX, CY, CR - 1, angleFor(1))
  const largeArc = (1 - redFrom) * 240 > 180 ? 1 : 0
  const tip = polar(CX, CY, CR - 6, 0)
  const tail = polar(CX, CY, 14, 180)

  return (
    <svg viewBox="0 0 200 200" className="h-auto w-full">
      <defs>
        <radialGradient id={`${id}-face`} cx="50%" cy="38%" r="75%">
          <stop offset="0%" stopColor="#1b2029" />
          <stop offset="55%" stopColor="#101319" />
          <stop offset="100%" stopColor="#07090c" />
        </radialGradient>
        <linearGradient id={`${id}-chrome`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#f4f6f9" />
          <stop offset="25%" stopColor="#9aa1ab" />
          <stop offset="50%" stopColor="#e8ecf1" />
          <stop offset="75%" stopColor="#6b7280" />
          <stop offset="100%" stopColor="#dfe4ea" />
        </linearGradient>
      </defs>

      <circle
        ref={refs.rimRef}
        cx={CX}
        cy={CY}
        r={CR + 9}
        fill="none"
        stroke={`url(#${id}-chrome)`}
        strokeWidth="6"
      />
      <circle
        cx={CX}
        cy={CY}
        r={CR + 5.5}
        fill="none"
        stroke="#04060a"
        strokeWidth="1.5"
        opacity="0.9"
      />
      <circle
        cx={CX}
        cy={CY}
        r={CR + 4}
        fill={`url(#${id}-face)`}
        stroke="#232a35"
        strokeWidth="1"
      />

      {redFrom < 1 && (
        <path
          d={`M ${r0.x} ${r0.y} A ${CR - 1} ${CR - 1} 0 ${largeArc} 1 ${r1.x} ${r1.y}`}
          fill="none"
          stroke="#e30613"
          strokeWidth="4"
          opacity="0.95"
          strokeLinecap="round"
        />
      )}
      {ticks}

      <text
        x={CX}
        y={CY - 18}
        textAnchor="middle"
        fontSize="9"
        fill="#8f99a8"
        fontFamily={SANS}
        letterSpacing="3"
        fontWeight={600}
      >
        {title}
      </text>
      <text
        ref={refs.numRef}
        x={CX}
        y={CY + 42}
        textAnchor="middle"
        fontSize="30"
        fill="#ffffff"
        fontFamily={SANS}
        fontWeight={700}
        style={{ fontVariantNumeric: "tabular-nums" }}
      >
        0
      </text>
      <text
        x={CX}
        y={CY + 56}
        textAnchor="middle"
        fontSize={modeLabel ? "8" : "8.5"}
        fill={
          modeLabel ? (modeLabel === "AUTO" ? "#7db8ec" : "#cbd5e1") : "#8f99a8"
        }
        fontFamily={SANS}
        letterSpacing={modeLabel ? "1.5" : "2.5"}
        fontWeight={600}
      >
        {modeLabel ?? unit}
      </text>

      <g ref={refs.needleRef}>
        <line
          x1={tail.x}
          y1={tail.y}
          x2={tip.x}
          y2={tip.y}
          stroke="#e30613"
          strokeWidth="4.5"
          strokeLinecap="round"
        />
        <circle
          cx={CX}
          cy={CY}
          r="10"
          fill="#14181f"
          stroke="#c7ced8"
          strokeWidth="1.6"
        />
        <circle cx={CX} cy={CY} r="5.2" fill="#1c69b4" />
        <path
          d={`M ${CX} ${CY - 5.2} A 5.2 5.2 0 0 1 ${CX + 5.2} ${CY} L ${CX} ${CY} Z`}
          fill="#ffffff"
          opacity="0.92"
        />
        <path
          d={`M ${CX} ${CY + 5.2} A 5.2 5.2 0 0 1 ${CX - 5.2} ${CY} L ${CX} ${CY} Z`}
          fill="#ffffff"
          opacity="0.92"
        />
        <circle cx={CX} cy={CY} r="1.6" fill="#0b0e13" />
      </g>
    </svg>
  )
}

export default function Dashboard({ tele }: { tele: CarTelemetry }) {
  const teleRef = useRef(tele)
  teleRef.current = tele
  const spdNeedle = useRef<SVGGElement | null>(null)
  const spdNum = useRef<SVGTextElement | null>(null)
  const rpmNeedle = useRef<SVGGElement | null>(null)
  const rpmNum = useRef<SVGTextElement | null>(null)
  const rpmRim = useRef<SVGCircleElement | null>(null)

  useEffect(() => {
    let raf = 0
    let last = performance.now()
    let dRpm = 0,
      dKmh = 0
    const loop = (now: number) => {
      raf = requestAnimationFrame(loop)
      const dt = Math.min(0.05, (now - last) / 1000)
      last = now
      const t = teleRef.current
      dRpm += (t.rpm - dRpm) * (1 - Math.exp(-dt * 14))
      dKmh += (Math.abs(t.speedKmh) - dKmh) * (1 - Math.exp(-dt * 10))

      if (rpmNeedle.current) {
        rpmNeedle.current.setAttribute(
          "transform",
          `rotate(${angleFor(dRpm / MAX_RPM)} 100 100)`,
        )
      }

      if (spdNeedle.current) {
        spdNeedle.current.setAttribute(
          "transform",
          `rotate(${angleFor(dKmh / MAX_KMH)} 100 100)`,
        )
      }

      if (rpmNum.current) {
        rpmNum.current.textContent = teleRef.current.gearLabel
        rpmNum.current.setAttribute(
          "fill",
          teleRef.current.gearLabel === "R"
            ? "#ff5a5a"
            : teleRef.current.gearLabel === "N"
              ? "#f5b942"
              : "#ffffff",
        )
      }

      if (rpmRim.current) {
        const limiter = dRpm >= RED_FROM_RPM
        const warning = dRpm >= YELLOW_FROM_RPM
        const flash = limiter ? (Math.sin(now * 0.045) > 0 ? 1 : 0.10) : 1

        rpmRim.current.setAttribute(
          "stroke",
          limiter ? `rgba(227,6,19,${flash})` : "url(#bmw-rpm-chrome)",
        )

        rpmRim.current.setAttribute(
          "stroke-width",
          limiter ? String(6 + flash * 2) : warning ? "7" : "6",
        )

        rpmRim.current.style.filter = limiter
          ? flash > 0.5
            ? "drop-shadow(0 0 5px rgba(227,6,19,0.95))"
            : "none"
          : warning
            ? "drop-shadow(0 0 5px rgba(250,204,21,0.85))"
            : "none"
      }

      if (spdNum.current) spdNum.current.textContent = String(Math.round(dKmh))
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

      {}
      <div className="absolute inset-x-0 bottom-0 flex items-end justify-between px-4 pb-4 sm:px-6 sm:pb-5">
        <div className="w-[clamp(150px,20vw,250px)]">
          <BmwDial
            title="SPEED"
            unit="KM/H"
            maxLabel={MAX_KMH}
            redFrom={2}
            refs={{ needleRef: spdNeedle, numRef: spdNum }}
            id="bmw-spd"
          />
        </div>

        <div className="w-[clamp(150px,20vw,250px)]">
          <BmwDial
            title="POWER"
            unit=""
            maxLabel={8}
            redFrom={RED_FROM_RPM / MAX_RPM}
            refs={{ needleRef: rpmNeedle, numRef: rpmNum, rimRef: rpmRim }}
            id="bmw-rpm"
            modeLabel={tele.autoMode ? "AUTO" : "MANUAL"}
          />
        </div>
      </div>
    </div>
  )
}
