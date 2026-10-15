import { useEffect, useRef, useState } from "react"
import {
  RACE_COUNTS,
  RACE_DISTANCES_KM,
  type RaceSnapshot,
  type RaceStanding,
} from "../systems/RaceTypes"
import type { CarDefinition } from "../constants/cars"
import { roadGapM } from "../systems/WorldManager"
import { ChevronLeft, ChevronRight } from "lucide-react"

function formatTime(seconds: number | null) {
  if (seconds == null) return "—"
  const m = Math.floor(seconds / 60)
  const s = seconds - m * 60
  return `${m}:${s.toFixed(2).padStart(5, "0")}`
}

function placeLabel(n: number) {
  if (n === 1) return "1st"
  if (n === 2) return "2nd"
  if (n === 3) return "3rd"
  return `${n}th`
}

const stripe = (
  <div className="flex h-[5px]">
    <div className="flex-1 bg-[#51a7d5]" />
    <div className="flex-1 bg-[#1c3d7c]" />
    <div className="flex-1 bg-[#e30613]" />
  </div>
)

const PAINTS: { name: string; value: number | null }[] = [
  { name: "Stock", value: null },
  { name: "Black", value: 0x000000 },
  { name: "White", value: 0xf5f5f5 },
  { name: "Silver", value: 0x9aa0a6 },
  { name: "Red", value: 0xe30613 },
  { name: "Blue", value: 0x1f6feb },
  { name: "Orange", value: 0xf97316 },
  { name: "Green", value: 0x1f8a4c },
  { name: "Yellow", value: 0xf5c518 },
]

export function RaceMenu({
  rivals,
  distanceKm,
  onRivals,
  onDistance,
  cars,
  carId,
  onPrevCar,
  onNextCar,
  paint,
  onPaint,
  pool,
  onTogglePool,
  onFreeDrive,
  onStartRace,
  onOpenMultiplayer,
}: {
  rivals: number
  distanceKm: number
  onRivals: (n: (typeof RACE_COUNTS)[number]) => void
  onDistance: (km: (typeof RACE_DISTANCES_KM)[number]) => void
  cars: CarDefinition[]
  carId: string
  onPrevCar: () => void
  onNextCar: () => void
  /** Effective paint (explicit pick, else the car's default). */
  paint: number | null
  /** null = stock GLB paint (full reload); color = live recolor. */
  onPaint: (color: number | null) => void
  pool: string[]
  onTogglePool: (id: string) => void
  onFreeDrive: () => void
  onStartRace: () => void
  onOpenMultiplayer?: () => void
}) {
  const idx = Math.max(
    0,
    cars.findIndex((c) => c.id === carId),
  )
  const selected = cars[idx] ?? cars[0]
  const specRows: [string, string][] = selected
    ? [
        ["POWER", `${selected.physics.engine.maxPowerHP} HP`],
        ["TORQUE", `${selected.physics.engine.maxTorqueNm} Nm`],
        ["0–100 KM/H", `${selected.tested.zeroToHundredS.toFixed(1)} s`],
        ["TOP SPEED", `${selected.tested.topSpeedKmh} km/h`],
        ["DRIVE", selected.physics.drivetrain.type.toUpperCase()],
        ["WEIGHT", `${selected.physics.mass.chassis} kg`],
        ["REDLINE", `${selected.physics.engine.redlineRPM} rpm`],
        [
          "GEARBOX",
          `${selected.physics.transmission.gearRatios.length}-speed auto`,
        ],
      ]
    : []
  return (
    <div className="pointer-events-none absolute inset-0 flex flex-col md:flex-row">
      {/* 3D stage is the live scene behind (showroom orbit cam). The
          carousel arrows float over it, flanking the car. */}
      <div className="relative min-h-[30vh] flex-1">
        <button
          onClick={onPrevCar}
          aria-label="Previous car"
          className="pointer-events-auto absolute top-1/2 left-3 -translate-y-1/2 rounded-full border border-white/15 bg-black/55 p-3 text-2xl font-bold text-white backdrop-blur transition hover:bg-black/80 active:scale-95 md:left-6"
        >
          <ChevronLeft />
        </button>
        <button
          onClick={onNextCar}
          aria-label="Next car"
          className="pointer-events-auto absolute top-1/2 right-3 -translate-y-1/2 rounded-full border border-white/15 bg-black/55 p-3 text-2xl font-bold text-white backdrop-blur transition hover:bg-black/80 active:scale-95 md:right-6"
        >
          <ChevronRight />
        </button>
        <div className="pointer-events-auto absolute bottom-3 left-1/2 -translate-x-1/2 rounded-full border border-white/10 bg-black/55 px-4 py-1 text-[12px] tracking-widest text-gray-200 backdrop-blur">
          {idx + 1} / {cars.length}
        </div>
      </div>
      <div className="pointer-events-auto relative max-h-[62vh] w-full overflow-y-auto border-white/10 bg-[#0b0e14]/92 shadow-[0_30px_100px_rgba(0,0,0,0.7)] backdrop-blur-md no-scrollbar md:max-h-none md:h-full md:w-[400px] md:border-l">
        <div className="p-6">
          <h1 className="mt-1 text-3xl font-bold tracking-tight text-white">
            {selected?.name ?? "Choose your car"}
          </h1>
          <p className="mt-1 text-[13px] leading-5 text-gray-300">
            {selected?.blurb}
          </p>

          <div className="mt-4 grid grid-cols-2 gap-1.5">
            {specRows.map(([k, v]) => (
              <div key={k} className="rounded-xl bg-white/[0.05] px-3 py-2">
                <div className="text-[10px] font-semibold tracking-[0.18em] text-[#8f99a8]">
                  {k}
                </div>
                <div className="text-[15px] font-bold text-white tabular-nums">
                  {v}
                </div>
              </div>
            ))}
          </div>

          <div className="mt-4 text-left">
            <div className="text-[11px] font-semibold tracking-[0.22em] text-[#8f99a8]">
              PAINT
            </div>
            <div className="mt-2 flex flex-wrap gap-2">
              {PAINTS.map((p) => {
                const active = (paint ?? null) === p.value
                return (
                  <button
                    key={p.name}
                    onClick={() => onPaint(p.value)}
                    title={p.name === "Stock" ? "Stock GLB paint" : p.name}
                    aria-label={p.name}
                    className={`flex h-9 w-9 items-center justify-center rounded-full border-2 transition active:scale-95 ${
                      active
                        ? "border-white"
                        : "border-white/20 hover:border-white/50"
                    }`}
                    style={
                      p.value === null
                        ? {
                            background:
                              "conic-gradient(#e30613,#f5c518,#1f8a4c,#1f6feb,#000)",
                          }
                        : {
                            background: `#${p.value.toString(16).padStart(6, "0")}`,
                          }
                    }
                  />
                )
              })}
            </div>
          </div>

          <div className="mt-5 text-left">
            <div className="text-[11px] font-semibold tracking-[0.22em] text-[#8f99a8]">
              RIVALS (AI)
            </div>
            <div className="mt-2 flex flex-wrap gap-1.5">
              {RACE_COUNTS.map((n) => (
                <button
                  key={n}
                  onClick={() => onRivals(n)}
                  className={`min-w-[44px] flex-1 rounded-xl py-2 text-[13px] font-semibold transition ${
                    rivals === n
                      ? "bg-white text-[#0b0e14]"
                      : "bg-white/8 text-gray-300 hover:bg-white/14"
                  }`}
                >
                  {n}
                </button>
              ))}
            </div>
            <div className="mt-4 text-[11px] font-semibold tracking-[0.22em] text-[#8f99a8]">
              AI FIELD — RIVALS DRAW RANDOMLY FROM THESE
            </div>
            {pool.length === 0 && (
              <div className="mt-1 text-[12px] text-gray-400">
                None selected — the full roster will show up.
              </div>
            )}
            <div className="mt-2 flex flex-wrap gap-1.5">
              {cars.map((c) => {
                const on = pool.includes(c.id)
                return (
                  <button
                    key={c.id}
                    onClick={() => onTogglePool(c.id)}
                    title={on ? "Exclude from AI grid" : "Include in AI grid"}
                    className={`rounded-xl px-3 py-2 text-[12px] font-semibold transition ${
                      on
                        ? "bg-white/12 text-white hover:bg-white/18"
                        : "bg-white/[0.03] text-gray-500 line-through hover:bg-white/8"
                    }`}
                  >
                    {c.shortName}
                  </button>
                )
              })}
            </div>
            <div className="mt-4 text-[11px] font-semibold tracking-[0.22em] text-[#8f99a8]">
              DISTANCE
            </div>
            <div className="mt-2 flex gap-1.5">
              {RACE_DISTANCES_KM.map((km) => (
                <button
                  key={km}
                  onClick={() => onDistance(km)}
                  className={`flex-1 rounded-xl py-2 text-[13px] font-semibold transition ${
                    distanceKm === km
                      ? "bg-white text-[#0b0e14]"
                      : "bg-white/8 text-gray-300 hover:bg-white/14"
                  }`}
                >
                  {km} km
                </button>
              ))}
            </div>
          </div>

          <button
            onClick={onStartRace}
            className="mt-6 w-full rounded-2xl bg-[#e30613] px-10 py-3.5 text-[15px] font-semibold tracking-wide text-white shadow-[0_10px_40px_rgba(227,6,19,0.45)] transition hover:bg-[#f01422] active:scale-[0.98]"
          >
            Start Singleplayer Race
          </button>
          {onOpenMultiplayer && (
            <button
              onClick={onOpenMultiplayer}
              className="mt-2.5 w-full rounded-2xl border border-[#51a7d5]/40 bg-[#51a7d5]/15 px-6 py-3 text-[14px] font-semibold text-[#6ec2f0] transition hover:bg-[#51a7d5]/25 active:scale-[0.98] flex items-center justify-center gap-2"
            >
              <span className="h-2 w-2 rounded-full bg-[#51a7d5] animate-pulse" />
              Multiplayer Lobby (P2P)
            </button>
          )}
          <button
            onClick={onFreeDrive}
            className="mt-2.5 w-full rounded-2xl border border-white/12 bg-white/5 px-6 py-3 text-[14px] font-medium text-gray-100 transition hover:bg-white/10 active:scale-[0.98]"
          >
            Just drive (Free Roam)
          </button>
          <div className="mt-3 text-center text-[12px] text-gray-500">
            Enter starts a free drive · P toggles the parking brake
          </div>
        </div>
      </div>
    </div>
  )
}

export function RaceHud({ race }: { race: RaceSnapshot }) {
  if (!race.active || race.finished) return null
  const kmLeft = Math.max(
    0,
    (race.distanceM -
      (race.standings.find((s) => s.isPlayer)?.progressM ?? 0)) /
      1000,
  )
  return (
    <>
      <div className="pointer-events-none absolute top-5 left-1/2 flex -translate-x-1/2 items-center gap-3 rounded-full border border-white/12 bg-black/55 px-4 py-2 text-white backdrop-blur">
        <span className="text-[18px] font-bold tabular-nums">
          {placeLabel(race.playerPlace)}
        </span>
        <span className="text-[12px] text-gray-300">of {race.total}</span>
        <span className="h-4 w-px bg-white/20" />
        <span className="text-[13px] tabular-nums text-gray-200">
          {kmLeft.toFixed(2)} km left
        </span>
        <span className="h-4 w-px bg-white/20" />
        <span className="text-[13px] tabular-nums">
          {formatTime(race.elapsed)}
        </span>
      </div>
      {race.phase === "heads" && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <div className="rounded-3xl border border-white/10 bg-black/65 px-10 py-6 text-center backdrop-blur">
            <div className="text-[11px] font-semibold tracking-[0.4em] text-[#8f99a8]">
              ON THE GRID
            </div>
            <div className="mt-1 text-3xl font-bold text-white">
              {race.total - 1} rival{race.total - 1 === 1 ? "" : "s"} ·{" "}
              {(race.distanceM / 1000).toFixed(0)} km
            </div>
            <div className="mt-1 text-[14px] text-gray-300">
              Lights out in {Math.max(1, Math.ceil(race.readyIn))}…
            </div>
          </div>
        </div>
      )}
      {race.phase === "count" && race.countdown > 0 && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <div className="text-center">
            <div className="text-[120px] font-bold leading-none text-white drop-shadow-[0_8px_30px_rgba(0,0,0,0.6)]">
              {race.countdown}
            </div>
            <div className="mt-2 text-[14px] tracking-wide text-gray-200">
              Hold W + S to arm launch
            </div>
          </div>
        </div>
      )}
      {race.phase === "go" && race.elapsed < 1.2 && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <div className="text-[100px] font-bold leading-none text-[#4ade80] drop-shadow-[0_8px_30px_rgba(0,0,0,0.6)]">
            GO!
          </div>
        </div>
      )}
    </>
  )
}

const BOARD_ROW_H = 34

function gapText(s: RaceStanding, playerS: number): string {
  if (s.isPlayer) return "YOU"
  if (s.finished) return formatTime(s.finishTime)
  const gap = roadGapM(s.progressM, playerS)
  const a = Math.abs(gap)
  const v = a >= 1000 ? `${(a / 1000).toFixed(1)} km` : `${Math.round(a)} m`
  return gap >= 0 ? `+${v}` : `-${v}`
}

/**
 * Live tower, right side: the whole field, scrollable, auto-following
 * your row. Rows are absolutely positioned by place with a top
 * transition, so overtakes glide instead of snapping. Snapshot refreshes
 * at ~2.5 Hz — cheap, and slow enough that fights read clearly.
 */
export function RaceLiveBoard({ race }: { race: RaceSnapshot }) {
  const [snap, setSnap] = useState<RaceStanding[]>([])
  const lastRef = useRef(0)
  const scrollRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    const now = performance.now()
    if (now - lastRef.current > 400) {
      lastRef.current = now
      setSnap(race.standings)
    }
  }, [race])
  const meIdx = snap.findIndex((s) => s.isPlayer)
  useEffect(() => {
    const el = scrollRef.current
    if (!el || meIdx < 0) return
    el.scrollTo({
      top: Math.max(0, meIdx * BOARD_ROW_H - el.clientHeight / 2),
      behavior: "smooth",
    })
  }, [snap, meIdx])
  if (!race.active || race.finished || snap.length === 0) return null
  const playerS = race.standings.find((s) => s.isPlayer)?.progressM ?? 0
  return (
    <div className="pointer-events-none absolute top-20 right-4 w-[212px]">
      <div className="mb-1.5 text-right text-[10px] font-semibold tracking-[0.3em] text-white/60">
        LIVE · {snap.length}
      </div>
      <div
        ref={scrollRef}
        className="pointer-events-auto max-h-[46vh] overflow-y-auto rounded-xl pr-0.5 no-scrollbar"
      >
        <div className="relative" style={{ height: snap.length * BOARD_ROW_H }}>
          {snap.map((s, i) => (
            <div
              key={s.id}
              className={`absolute right-0 left-0 flex items-center gap-2 rounded-lg px-2 backdrop-blur transition-[top] duration-500 ease-out ${
                s.isPlayer
                  ? "border border-white/25 bg-white/15"
                  : "border border-transparent bg-black/45"
              }`}
              style={{ top: i * BOARD_ROW_H, height: BOARD_ROW_H - 4 }}
            >
              <span
                className={`w-4 text-[12px] font-bold tabular-nums ${
                  i === 0 ? "text-amber-300" : "text-white/80"
                }`}
              >
                {i + 1}
              </span>
              <span
                className="h-2.5 w-2.5 shrink-0 rounded-full"
                style={{ background: s.color }}
              />
              <span className="flex-1 truncate text-[12px] font-medium text-white">
                {s.name}
              </span>
              <span className="text-[11px] tabular-nums text-gray-300">
                {gapText(s, playerS)}
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

export function RaceResults({
  race,
  onAgain,
  onMenu,
}: {
  race: RaceSnapshot
  onAgain: () => void
  onMenu: () => void
}) {
  const player = race.standings.find((s) => s.isPlayer)
  return (
    <div className="absolute inset-0 flex items-center justify-center bg-black/60 backdrop-blur-[3px]">
      <div className="relative w-[440px] overflow-hidden rounded-3xl border border-white/10 bg-[#0b0e14]/95 text-left shadow-[0_30px_100px_rgba(0,0,0,0.7)]">
        {stripe}
        <div className="px-8 pt-7 pb-7">
          <div className="text-[11px] font-semibold tracking-[0.4em] text-[#8f99a8]">
            CHEQUERED FLAG
          </div>
          <h2 className="mt-1 text-4xl font-bold tracking-tight text-white">
            {placeLabel(race.playerPlace)}
            <span className="ml-2 text-[18px] font-medium text-gray-400">
              of {race.total}
            </span>
          </h2>
          <p className="mt-1 text-[13px] text-gray-400">
            {(race.distanceM / 1000).toFixed(0)} km
            {player?.finishTime != null
              ? ` · ${formatTime(player.finishTime)}`
              : ""}
          </p>
          <ol className="mt-5 max-h-[38vh] space-y-1.5 overflow-y-auto pr-1 no-scrollbar">
            {race.standings.map((row, i) => (
              <li
                key={row.id}
                className={`flex items-center gap-3 rounded-xl px-3 py-2 ${
                  row.isPlayer ? "bg-white/10" : "bg-white/[0.03]"
                }`}
              >
                <span className="w-6 text-[13px] font-semibold tabular-nums text-gray-400">
                  {i + 1}
                </span>
                <span
                  className="h-3 w-3 rounded-full"
                  style={{ background: row.color }}
                />
                <span className="flex-1 text-[14px] font-medium text-white">
                  {row.name}
                </span>
                <span className="text-[13px] tabular-nums text-gray-300">
                  {row.finished
                    ? formatTime(row.finishTime)
                    : `${Math.max(0, row.progressM / 1000).toFixed(2)} km`}
                </span>
              </li>
            ))}
          </ol>
          <div className="mt-6 space-y-2.5">
            <button
              onClick={onAgain}
              className="w-full rounded-2xl bg-[#e30613] px-6 py-3 text-[15px] font-semibold text-white shadow-[0_10px_40px_rgba(227,6,19,0.4)] transition hover:bg-[#f01422] active:scale-[0.98]"
            >
              Race again
            </button>
            <button
              onClick={onMenu}
              className="w-full rounded-2xl border border-white/12 bg-white/5 px-6 py-3 text-[14px] font-medium text-gray-100 transition hover:bg-white/10 active:scale-[0.98]"
            >
              Back to the start
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
