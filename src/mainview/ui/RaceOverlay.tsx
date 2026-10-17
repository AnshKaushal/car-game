import { useEffect, useRef, useState } from "react"
import {
  RACE_COUNTS,
  RACE_DISTANCES_KM,
  TRAFFIC_OPTIONS,
  trafficCountFor,
  type RaceSnapshot,
  type RaceStanding,
  type TrafficLevel,
} from "../systems/RaceTypes"
import type { CarDefinition } from "../constants/cars"
import { PaintPicker } from "./PaintPicker"
import { EASE, Screen, usePop } from "./anim"
import { roadGapM } from "../systems/WorldManager"
import {
  ArrowUpRight,
  ChevronLeft,
  ChevronRight,
  LoaderPinwheel,
  Swords,
} from "lucide-react"

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

export function RaceMenu({
  open,
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
  traffic,
  onTraffic,
  onFreeDrive,
  onStartRace,
  onOpenMultiplayer,
}: {
  open: boolean
  rivals: number
  distanceKm: number
  onRivals: (n: (typeof RACE_COUNTS)[number]) => void
  onDistance: (km: (typeof RACE_DISTANCES_KM)[number]) => void
  cars: CarDefinition[]
  carId: string
  onPrevCar: () => void
  onNextCar: () => void
  paint: number | null
  onPaint: (color: number | null) => void
  pool: string[]
  onTogglePool: (id: string) => void
  traffic: TrafficLevel
  onTraffic: (level: TrafficLevel) => void
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
    <Screen
      open={open}
      className="pointer-events-none absolute inset-0 flex flex-col md:flex-row"
      from={{ autoAlpha: 0 }}
      exit={{ duration: 0.26, ease: EASE.in }}
      stagger={[
        { selector: "[data-panel]", from: { autoAlpha: 0 }, delay: 0.05 },
        {
          selector: "[data-fade]",
          from: { autoAlpha: 0 },
          each: 0.07,
          delay: 0.12,
        },
      ]}
    >
      {}
      <div className="relative min-h-[30vh] flex-1">
        <button
          data-fade
          onClick={onPrevCar}
          aria-label="Previous car"
          className="pointer-events-auto absolute top-1/2 left-3 -translate-y-1/2 border border-[#51a7d5] bg-[#51a7d5]/15 p-3 text-2xl font-bold text-white backdrop-blur transition-colors hover:bg-[#51a7d5]/25 active:scale-95 md:left-6"
        >
          <ChevronLeft />
        </button>
        <button
          data-fade
          onClick={onNextCar}
          aria-label="Next car"
          className="pointer-events-auto absolute top-1/2 right-3 -translate-y-1/2 border border-[#51a7d5] bg-[#51a7d5]/15 p-3 text-2xl font-bold text-white backdrop-blur transition-colors hover:bg-[#51a7d5]/25 active:scale-95 md:right-6"
        >
          <ChevronRight />
        </button>
        <div
          data-fade
          className="pointer-events-auto absolute bottom-3 left-1/2 -translate-x-1/2 rounded-full border border-white/10 bg-black/55 px-4 py-1 text-[12px] tracking-widest text-gray-200 backdrop-blur"
        >
          {idx + 1} / {cars.length}
        </div>
      </div>
      <div
        data-panel
        className="pointer-events-auto relative max-h-[62vh] w-full overflow-y-auto border-white/10 bg-[#0b0e14]/94 shadow-[0_30px_100px_rgba(0,0,0,0.7)] no-scrollbar md:max-h-none md:h-full md:w-[400px] md:border-l"
      >
        <div className="p-6">
          <h1 className="mt-1 text-3xl font-bold tracking-tight text-white">
            {selected?.name ?? "Choose your car"}
          </h1>

          <div className="mt-4 grid grid-cols-2 gap-1.5">
            {specRows.map(([k, v]) => (
              <div
                key={k}
                className="bg-[#51a7d5]/15 border border-[#51a7d5] px-3 py-2"
              >
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
            <div className="mt-2">
              <PaintPicker value={paint} showStock onPick={(c) => onPaint(c)} />
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
                  className={`min-w-[44px] flex-1 border border-[#51a7d5] py-2 text-[13px] font-semibold transition ${
                    rivals === n
                      ? "bg-white text-[#0b0e14]"
                      : "bg-[#51a7d5]/15 text-gray-300 hover:bg-[#51a7d5]/25"
                  }`}
                >
                  {n}
                </button>
              ))}
            </div>
            <div className="mt-4 text-[11px] uppercase font-semibold tracking-[0.22em] text-[#8f99a8]">
              Cars To Include / Exclude
            </div>
            {pool.length === 0 && (
              <div className="mt-1 text-[12px] text-gray-400">
                None selected. Every car shows up.
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
                    className={`border border-[#51a7d5] px-3 py-2 text-[12px] font-semibold transition ${
                      on
                        ? "bg-[#51a7d5]/15 text-white hover:bg-[#51a7d5]/25"
                        : "bg-red-500/30 text-gray-300 line-through hover:bg-red-500/50"
                    }`}
                  >
                    {c.shortName}
                  </button>
                )
              })}
            </div>
            <div className="mt-4 text-[11px] font-semibold tracking-[0.22em] text-[#8f99a8]">
              RACE DISTANCE
            </div>
            <div className="mt-2 flex gap-1.5">
              {RACE_DISTANCES_KM.map((km) => (
                <button
                  key={km}
                  onClick={() => onDistance(km)}
                  className={`flex-1 border border-[#51a7d5] py-2 text-[13px] font-semibold transition ${
                    distanceKm === km
                      ? "bg-white text-[#0b0e14]"
                      : "bg-[#51a7d5]/15 text-gray-300 hover:bg-[#51a7d5]/25"
                  }`}
                >
                  {km} km
                </button>
              ))}
            </div>
            <div className="mt-4 text-[11px] font-semibold tracking-[0.22em] text-[#8f99a8]">
              FREE-ROAM TRAFFIC
            </div>
            <div className="mt-2 flex gap-1.5">
              {TRAFFIC_OPTIONS.map((o) => (
                <button
                  key={o.id}
                  onClick={() => onTraffic(o.id)}
                  className={`flex-1 border border-[#51a7d5] py-2 text-[13px] font-semibold transition ${
                    traffic === o.id
                      ? "bg-white text-[#0b0e14]"
                      : "bg-[#51a7d5]/15 text-gray-300 hover:bg-[#51a7d5]/25"
                  }`}
                >
                  {o.label}
                </button>
              ))}
            </div>
            <div className="mt-1 text-[12px] text-gray-400">
              {traffic === "off"
                ? "Empty roads when free roaming."
                : `${trafficCountFor(traffic)} AI cruisers share the road in free roam.`}
            </div>
          </div>

          <button
            onClick={onStartRace}
            className="mt-6 w-full bg-[#51a7d5] px-10 py-3.5 text-[15px] font-semibold tracking-wide text-white transition hover:bg-[#51a7d5]/90 inline-flex gap-1 items-center justify-center"
          >
            Start Race (Singleplayer)
            <ArrowUpRight size={20} />
          </button>
          {onOpenMultiplayer && (
            <button
              onClick={onOpenMultiplayer}
              className="mt-2.5 w-full border border-[#51a7d5] bg-[#51a7d5]/15 px-6 py-3 text-[14px] font-semibold text-[#6ec2f0] transition hover:bg-[#51a7d5]/25 active:scale-[0.98] inline-flex items-center justify-center gap-1"
            >
              Multiplayer Lobby
              <Swords size={20} />
            </button>
          )}
          <button
            onClick={onFreeDrive}
            className="mt-2.5 w-full border border-white/12 bg-white/5 px-6 py-3 text-[14px] font-medium text-gray-100 transition hover:bg-white/10 active:scale-[0.98]  inline-flex items-center justify-center gap-1"
          >
            {traffic === "off"
              ? "Free Roam"
              : `Free Roam · ${TRAFFIC_OPTIONS.find((o) => o.id === traffic)?.label} traffic`}
            <LoaderPinwheel size={20} />
          </button>
        </div>
      </div>
    </Screen>
  )
}

export function RaceHud({ race }: { race: RaceSnapshot }) {
  const pillRef = usePop<HTMLDivElement>([race.playerPlace])
  const stagedRef = usePop<HTMLDivElement>([race.staged])
  const countRef = usePop<HTMLDivElement>([race.countdown])
  const goRef = usePop<HTMLDivElement>([race.phase === "go"])
  if (!race.active || race.finished) return null
  const kmLeft = Math.max(
    0,
    (race.distanceM -
      (race.standings.find((s) => s.isPlayer)?.progressM ?? 0)) /
      1000,
  )
  const waitingLabel =
    race.waitingFor.length === 1
      ? `Waiting for ${race.waitingFor[0]}`
      : "Waiting for other players"
  return (
    <>
      <div className="pointer-events-none absolute top-5 left-1/2 flex -translate-x-1/2 items-center gap-3 rounded-full border border-white/12 bg-black/55 px-4 py-2 text-white backdrop-blur">
        {}
        <div ref={pillRef} className="flex items-center gap-3">
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
      </div>
      {race.staged && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <div
            ref={stagedRef}
            className="rounded-3xl border border-amber-400/25 bg-black/65 px-10 py-6 text-center backdrop-blur"
          >
            <div className="text-[11px] font-semibold tracking-[0.4em] text-amber-300/90">
              ON THE GRID
            </div>
            <div className="mt-1 text-3xl font-bold text-white">
              {waitingLabel}…
            </div>
            <div className="mt-1 text-[14px] text-gray-300">
              Your car is on the start line. The countdown starts once
              everyone&apos;s ready.
            </div>
          </div>
        </div>
      )}
      {!race.staged && race.phase === "heads" && (
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
      {!race.staged && race.phase === "count" && race.countdown > 0 && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <div className="text-center">
            <div
              ref={countRef}
              className="text-[120px] font-bold leading-none text-white drop-shadow-[0_8px_30px_rgba(0,0,0,0.6)]"
            >
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
          <div
            ref={goRef}
            className="text-[100px] font-bold leading-none text-[#4ade80] drop-shadow-[0_8px_30px_rgba(0,0,0,0.6)]"
          >
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

export function RaceLiveBoard({ race }: { race: RaceSnapshot }) {
  const [snap, setSnap] = useState<RaceStanding[]>([])
  const rootRef = usePop<HTMLDivElement>([])
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
    <div
      ref={rootRef}
      className="pointer-events-none absolute top-20 right-4 w-[212px]"
    >
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
  open,
  race,
  onAgain,
  onMenu,
  readyNotice,
}: {
  open: boolean
  race: RaceSnapshot
  onAgain: () => void
  onMenu: () => void
  readyNotice?: string | null
}) {
  const player = race.standings.find((s) => s.isPlayer)
  const winner = race.standings[0]
  const winnerTime = winner?.finishTime ?? null
  const playerTime = player?.finishTime ?? null
  const km = (race.distanceM / 1000).toFixed(0)

  let summary = `${km} km`
  if (playerTime != null) {
    summary += ` · ${formatTime(playerTime)}`
    if (race.playerPlace === 1) {
      const second = race.standings[1]?.finishTime ?? null
      if (second != null) {
        summary += ` · ${(second - playerTime).toFixed(2)}s clear`
      }
    } else if (winnerTime != null) {
      summary += ` · ${(playerTime - winnerTime).toFixed(2)}s behind`
    }
  } else if (player) {
    summary += ` · ${(Math.max(0, player.progressM) / 1000).toFixed(
      2,
    )} km covered`
  }

  return (
    <Screen
      open={open}
      className="absolute inset-0 overflow-y-auto bg-black/55 backdrop-blur-[2px]"
      from={{ autoAlpha: 0 }}
      to={{ duration: 0.4, ease: EASE.out }}
      exit={{ duration: 0.28, ease: EASE.in }}
      stagger={[
        {
          selector: "[data-res-head]",
          from: { autoAlpha: 0 },
          to: { duration: 0.7, ease: EASE.soft },
        },
        { selector: "[data-res-acts]", from: { autoAlpha: 0 } },
        {
          selector: "[data-res-row]",
          from: { autoAlpha: 0 },
          each: 0.05,
          delay: 0.18,
        },
        { selector: "[data-res-note]", from: { autoAlpha: 0 } },
      ]}
    >
      <div className="flex min-h-full flex-col p-5 md:p-8">
        {}
        <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-4">
          <div data-res-head>
            <div
              className="mb-2 h-2.5 w-20"
              style={{
                backgroundImage:
                  "repeating-conic-gradient(#f5f5f5 0% 25%, #0b0e14 0% 50%)",
                backgroundSize: "12px 12px",
              }}
            />
            <div className="flex items-baseline gap-3">
              <span className="text-[72px] font-bold leading-[0.9] tracking-tight text-white drop-shadow-[0_8px_30px_rgba(0,0,0,0.6)] md:text-[104px]">
                {placeLabel(race.playerPlace)}
              </span>
              <span className="text-[14px] font-medium text-gray-400">
                of {race.total}
              </span>
            </div>
            <p className="mt-2 text-[13px] tracking-wide text-gray-300">
              {summary}
            </p>
          </div>
          <div
            data-res-acts
            className="flex w-full flex-col gap-2 sm:w-[212px]"
          >
            <button
              onClick={onAgain}
              className="w-full bg-[#51a7d5] px-6 py-3 text-[14px] font-semibold text-white transition hover:bg-[#51a7d5]/90 active:scale-[0.98]"
            >
              Race again
            </button>
            <button
              onClick={onMenu}
              className="w-full border border-white/12 bg-white/5 px-6 py-3 text-[14px] font-medium text-gray-100 transition hover:bg-white/10 active:scale-[0.98]"
            >
              Back to the start
            </button>
          </div>
        </div>

        {readyNotice && (
          <div
            data-res-note
            className="mt-4 w-full max-w-[420px] border border-amber-400/25 bg-amber-400/10 px-4 py-2 text-[13px] font-medium text-amber-200 sm:w-auto"
          >
            {readyNotice}
          </div>
        )}

        {}
        <div className="no-scrollbar mt-auto max-h-[46vh] overflow-y-auto border-t border-white/10">
          {race.standings.map((row, i) => (
            <div
              key={row.id}
              data-res-row
              className={`grid h-10 grid-cols-[44px_1fr_auto] items-center border-b border-white/5 ${
                row.isPlayer ? "bg-[#51a7d5]/20" : "bg-black/30"
              }`}
            >
              <div
                className={`grid h-full w-11 place-items-center border-r border-white/5 text-[13px] font-bold tabular-nums ${
                  i === 0
                    ? "bg-[#e30613] text-white"
                    : row.isPlayer
                      ? "bg-[#51a7d5] text-[#0b0e14]"
                      : "bg-white/[0.04] text-gray-400"
                }`}
              >
                {i + 1}
              </div>
              <div className="flex min-w-0 items-center gap-2.5 px-3">
                <span
                  className="h-2.5 w-2.5 shrink-0 rounded-full"
                  style={{ background: row.color }}
                />
                <span
                  className={`truncate text-[14px] ${
                    row.isPlayer ? "font-semibold text-white" : "text-gray-200"
                  }`}
                >
                  {row.name}
                </span>
                {row.isPlayer && (
                  <span className="bg-white px-1.5 py-0.5 text-[10px] font-bold text-[#0b0e14]">
                    YOU
                  </span>
                )}
              </div>
              <span
                className={`mr-4 text-[13px] tabular-nums md:mr-6 ${
                  row.finished ? "text-gray-200" : "text-gray-500"
                }`}
              >
                {row.finished
                  ? i === 0
                    ? formatTime(row.finishTime)
                    : winnerTime != null
                      ? `+${(row.finishTime! - winnerTime).toFixed(2)}s`
                      : formatTime(row.finishTime)
                  : `${Math.max(0, row.progressM / 1000).toFixed(2)} km`}
              </span>
            </div>
          ))}
        </div>
      </div>
    </Screen>
  )
}
