import { useRef, useState } from "react"
import { colorHex } from "../systems/carTint"
import {
  MULTIPLAYER_AI_COUNTS,
  RACE_DISTANCES_KM,
  TRAFFIC_OPTIONS,
  trafficCountFor,
  type TrafficLevel,
} from "../systems/RaceTypes"
import type { PeerPlayer } from "../systems/net/types"
import { EASE, Screen, useStaggerIn } from "./anim"
import {
  ArrowLeft,
  ArrowUpRight,
  Bot,
  Check,
  Copy,
  Globe,
  Lock,
  Users,
  Zap,
} from "lucide-react"

export type MultiplayerMode = "p2p" | "lan"

interface MultiplayerLobbyProps {
  open: boolean
  playerName: string
  carColor: number
  roomId: string
  isConnected: boolean
  peers: PeerPlayer[]
  joinError?: string | null
  initialMode?: MultiplayerMode
  onUpdateProfile: (name: string, color: number) => void
  onJoinRoom: (target: string, mode: MultiplayerMode, password?: string) => void
  onLeaveRoom: () => void
  onStartMultiplayerRace: (distanceKm: number, aiCount: number) => void
  onStartFreeDrive: () => void
  traffic: TrafficLevel
  onTraffic: (level: TrafficLevel) => void
  onBack: () => void
}

function generateRoomCode(): string {
  const chars = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"
  const pick = (n: number) =>
    Array.from(
      { length: n },
      () => chars[(Math.random() * chars.length) | 0],
    ).join("")
  return `${pick(4)}-${pick(4)}`
}

export function MultiplayerLobby({
  open,
  playerName,
  carColor,
  roomId,
  isConnected,
  peers,
  joinError,
  initialMode = "p2p",
  onUpdateProfile,
  onJoinRoom,
  onLeaveRoom,
  onStartMultiplayerRace,
  onStartFreeDrive,
  traffic,
  onTraffic,
  onBack,
}: MultiplayerLobbyProps) {
  const [netMode, setNetMode] = useState<MultiplayerMode>(initialMode)
  const [nameInput, setNameInput] = useState(playerName)
  const [p2pRoomInput, setP2pRoomInput] = useState(
    initialMode === "p2p" && roomId ? roomId : "",
  )
  const [passwordInput, setPasswordInput] = useState("")
  const [lanAddressInput, setLanAddressInput] = useState(
    initialMode === "lan" && roomId ? roomId : "localhost:9876",
  )
  const [distanceKm, setDistanceKm] = useState<number>(5)
  const [aiCount, setAiCount] =
    useState<(typeof MULTIPLAYER_AI_COUNTS)[number]>(0)
  const [copied, setCopied] = useState(false)
  const gridRef = useRef<HTMLDivElement>(null)
  useStaggerIn(
    gridRef,
    "[data-lobby-in], [data-lobby-row]",
    [isConnected, peers.length],
    !isConnected,
  )

  const normalizeP2PCode = (raw: string) =>
    raw.trim().toUpperCase().replace(/\s+/g, "")

  const handleCreateRoom = () => {
    const code = generateRoomCode()
    onUpdateProfile(nameInput.trim() || playerName, carColor)
    setP2pRoomInput(code)
    onJoinRoom(code, "p2p", passwordInput.trim() || undefined)
  }

  const handleCopyCode = async () => {
    try {
      await navigator.clipboard.writeText(roomId)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1500)
    } catch {}
  }

  const handleJoin = (e: React.FormEvent) => {
    e.preventDefault()
    onUpdateProfile(nameInput.trim() || playerName, carColor)
    if (netMode === "p2p") {
      const code = normalizeP2PCode(p2pRoomInput)
      if (!code) return
      setP2pRoomInput(code)
      onJoinRoom(code, "p2p", passwordInput.trim() || undefined)
    } else {
      if (!lanAddressInput.trim()) return
      onJoinRoom(lanAddressInput.trim(), "lan")
    }
  }

  return (
    <Screen
      open={open}
      className="pointer-events-auto absolute inset-0 z-50 overflow-y-auto bg-black/60 backdrop-blur-[2px]"
      from={{ autoAlpha: 0 }}
      to={{ duration: 0.4, ease: EASE.out }}
      exit={{ duration: 0.26, ease: EASE.in }}
      stagger={[
        {
          selector: "[data-lobby-head]",
          from: { autoAlpha: 0 },
          to: { duration: 0.65, ease: EASE.soft },
        },
        { selector: "[data-lobby-acts]", from: { autoAlpha: 0 } },
        { selector: "[data-lobby-grid]", from: { autoAlpha: 0 } },
        {
          selector: "[data-lobby-row]",
          from: { autoAlpha: 0 },
          each: 0.05,
          delay: 0.12,
        },
      ]}
    >
      <div className="flex min-h-full flex-col p-5 md:p-8">
        {}
        <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-4">
          <div data-lobby-head>
            <div
              className="mb-2 h-2.5 w-20"
              style={{
                backgroundImage:
                  "repeating-conic-gradient(#51a7d5 0% 25%, #0b0e14 0% 50%)",
                backgroundSize: "12px 12px",
              }}
            />
            <h1 className="text-[64px] font-bold leading-[0.9] tracking-tight text-white drop-shadow-[0_8px_30px_rgba(0,0,0,0.6)] md:text-[96px]">
              Multiplayer
            </h1>
            <p className="mt-2 text-[13px] tracking-wide text-gray-300">
              {isConnected
                ? `${netMode === "p2p" ? "Internet P2P" : "LAN Direct"} · ${peers.length + 1} player${peers.length === 0 ? "" : "s"}`
                : "Not connected"}
            </p>
          </div>
          <div
            data-lobby-acts
            className="flex w-full flex-col gap-2 sm:w-[220px]"
          >
            {isConnected && (
              <button
                onClick={onLeaveRoom}
                className="w-full border border-[#51a7d5] bg-[#51a7d5]/15 px-6 py-3 text-[14px] font-semibold text-[#6ec2f0] transition hover:bg-[#51a7d5]/25 active:scale-[0.98]"
              >
                Disconnect
              </button>
            )}
            <button
              onClick={onBack}
              className="w-full border border-white/12 bg-white/5 px-6 py-3 text-[14px] font-medium text-gray-100 transition hover:bg-white/10 active:scale-[0.98] inline-flex items-center justify-center gap-2"
            >
              <ArrowLeft size={16} />
              Back to garage
            </button>
          </div>
        </div>

        {!isConnected && joinError && (
          <div
            data-lobby-grid
            className="mx-auto mt-4 w-full max-w-[1040px] border border-red-500/40 bg-red-500/10 px-3 py-2 text-[13px] font-medium text-red-200"
          >
            {joinError}
          </div>
        )}

        {}
        <div
          data-lobby-grid
          ref={gridRef}
          className={`mx-auto mt-8 grid items-start gap-x-10 gap-y-6 ${
            isConnected
              ? "w-full max-w-[1040px] lg:grid-cols-2"
              : "w-full max-w-[560px]"
          }`}
        >
          <div className="space-y-3">
            {!isConnected && (
              <>
                <div>
                  <div className="text-[11px] font-semibold tracking-[0.22em] text-[#8f99a8]">
                    NAME
                  </div>
                  <input
                    type="text"
                    value={nameInput}
                    onChange={(e) => {
                      setNameInput(e.target.value)
                      onUpdateProfile(e.target.value, carColor)
                    }}
                    onKeyDown={(e) => e.stopPropagation()}
                    onKeyUp={(e) => e.stopPropagation()}
                    maxLength={18}
                    placeholder="Enter name"
                    autoComplete="off"
                    autoCorrect="off"
                    autoCapitalize="off"
                    spellCheck={false}
                    className="mt-2 w-full border border-[#51a7d5] bg-[#51a7d5]/15 px-3 py-2 text-[13px] font-semibold text-white placeholder:font-normal placeholder:text-gray-400 focus:border-white focus:outline-none"
                  />
                </div>

                <div className="flex gap-1.5">
                  <button
                    type="button"
                    onClick={() => setNetMode("p2p")}
                    className={`flex-1 border border-[#51a7d5] py-2 text-[13px] font-semibold transition inline-flex items-center justify-center gap-1.5 ${
                      netMode === "p2p"
                        ? "bg-white text-[#0b0e14]"
                        : "bg-[#51a7d5]/15 text-gray-300 hover:bg-[#51a7d5]/25"
                    }`}
                  >
                    <Globe size={15} />
                    Internet
                  </button>
                  <button
                    type="button"
                    onClick={() => setNetMode("lan")}
                    className={`flex-1 border border-[#51a7d5] py-2 text-[13px] font-semibold transition inline-flex items-center justify-center gap-1.5 ${
                      netMode === "lan"
                        ? "bg-white text-[#0b0e14]"
                        : "bg-[#51a7d5]/15 text-gray-300 hover:bg-[#51a7d5]/25"
                    }`}
                  >
                    <Zap size={15} />
                    LAN / Direct
                  </button>
                </div>

                {netMode === "p2p" ? (
                  <div className="space-y-2">
                    <form onSubmit={handleJoin} className="flex gap-1.5">
                      <input
                        type="text"
                        value={p2pRoomInput}
                        onChange={(e) => setP2pRoomInput(e.target.value)}
                        onKeyDown={(e) => e.stopPropagation()}
                        onKeyUp={(e) => e.stopPropagation()}
                        autoComplete="off"
                        autoCorrect="off"
                        autoCapitalize="characters"
                        spellCheck={false}
                        placeholder="Room code, e.g. X7Q2-MA9D"
                        className="min-w-0 flex-1 border border-[#51a7d5] bg-[#51a7d5]/15 px-3 py-2 font-mono text-[13px] font-semibold tracking-widest text-white placeholder:font-sans placeholder:font-normal placeholder:tracking-normal placeholder:text-gray-400 focus:border-white focus:outline-none uppercase"
                      />
                      <button
                        type="submit"
                        className="shrink-0 border border-[#51a7d5] bg-[#51a7d5]/15 px-5 py-2 text-[13px] font-semibold text-[#6ec2f0] transition hover:bg-[#51a7d5]/25 active:scale-[0.98] inline-flex items-center justify-center gap-1"
                      >
                        Join
                        <ArrowUpRight size={16} />
                      </button>
                    </form>
                    {}
                    <input
                      type="password"
                      value={passwordInput}
                      onChange={(e) => setPasswordInput(e.target.value)}
                      onKeyDown={(e) => {
                        e.stopPropagation()
                        if (e.key === "Enter") handleJoin(e)
                      }}
                      onKeyUp={(e) => e.stopPropagation()}
                      maxLength={32}
                      autoComplete="off"
                      spellCheck={false}
                      placeholder="Password (optional, locks the room)"
                      className="w-full border border-[#51a7d5] bg-[#51a7d5]/15 px-3 py-2 text-[13px] font-semibold text-white placeholder:font-normal placeholder:text-gray-400 focus:border-white focus:outline-none"
                    />
                    <button
                      type="button"
                      onClick={handleCreateRoom}
                      className="w-full border border-white/12 bg-white/5 px-6 py-3 text-[14px] font-medium text-gray-100 transition hover:bg-white/10 active:scale-[0.98] inline-flex items-center justify-center gap-1"
                    >
                      <Lock size={15} />
                      Create new room
                    </button>
                    <div className="text-[12px] text-gray-400">
                      Create a room and share the code, or enter a friend&apos;s
                      code to join. A password here locks your new room (and
                      gets you into a locked one). Allow ~10s for the WebRTC
                      mesh.
                    </div>
                  </div>
                ) : (
                  <form onSubmit={handleJoin} className="space-y-2">
                    <div className="flex gap-1.5">
                      <input
                        type="text"
                        value={lanAddressInput}
                        onChange={(e) => setLanAddressInput(e.target.value)}
                        onKeyDown={(e) => e.stopPropagation()}
                        onKeyUp={(e) => e.stopPropagation()}
                        autoComplete="off"
                        autoCorrect="off"
                        autoCapitalize="off"
                        spellCheck={false}
                        placeholder="localhost:9876 or 192.168.1.x:9876"
                        className="min-w-0 flex-1 border border-[#51a7d5] bg-[#51a7d5]/15 px-3 py-2 text-[13px] font-semibold text-white placeholder:font-normal placeholder:text-gray-400 focus:border-white focus:outline-none"
                      />
                      <button
                        type="submit"
                        className="shrink-0 border border-[#51a7d5] bg-[#51a7d5]/15 px-5 py-2 text-[13px] font-semibold text-[#6ec2f0] transition hover:bg-[#51a7d5]/25 active:scale-[0.98] inline-flex items-center justify-center gap-1"
                      >
                        Connect
                        <ArrowUpRight size={16} />
                      </button>
                    </div>
                    <div className="text-[12px] text-gray-400">
                      Zero-latency local connection. Host auto-runs on port
                      9876.
                    </div>
                  </form>
                )}
              </>
            )}
            {isConnected && (
              <>
                <div
                  data-lobby-in
                  className="border border-[#51a7d5] bg-[#51a7d5]/15 px-3 py-2"
                >
                  <div className="text-[11px] font-semibold tracking-[0.22em] text-[#8f99a8]">
                    {netMode === "p2p"
                      ? "SHARE THIS ROOM CODE"
                      : "CONNECTED TO"}
                  </div>
                  <div className="mt-1 flex items-center justify-between gap-2">
                    <div className="min-w-0 flex-1 truncate font-mono text-[18px] font-bold tracking-[0.12em] text-white">
                      {roomId}
                    </div>
                    {netMode === "p2p" && (
                      <button
                        onClick={handleCopyCode}
                        className="inline-flex shrink-0 items-center gap-1 border border-[#51a7d5] bg-[#51a7d5]/15 px-3 py-1.5 text-[12px] font-semibold text-[#6ec2f0] transition hover:bg-[#51a7d5]/25"
                      >
                        {copied ? <Check size={14} /> : <Copy size={14} />}
                        {copied ? "Copied" : "Copy"}
                      </button>
                    )}
                  </div>
                </div>

                {peers.length === 0 && (
                  <div className="border border-amber-400/30 bg-amber-400/10 px-3 py-2 text-[12px] font-medium text-amber-200">
                    Waiting for rivals. Share{" "}
                    <span className="font-mono font-semibold">
                      &quot;{roomId}&quot;
                    </span>{" "}
                    and have them press Connect.
                  </div>
                )}

                {}
                <div className="border-t border-white/10">
                  {[
                    {
                      id: "you",
                      name: nameInput || playerName,
                      colorHex: colorHex(carColor),
                      pingMs: 0,
                      isYou: true,
                    },
                    ...peers.map((p) => ({ ...p, isYou: false })),
                  ].map((row, i) => (
                    <div
                      key={row.id}
                      data-lobby-row
                      className={`grid h-10 grid-cols-[44px_1fr_auto] items-center border-b border-white/5 ${
                        row.isYou ? "bg-[#51a7d5]/20" : "bg-black/30"
                      }`}
                    >
                      <div
                        className={`grid h-full place-items-center border-r border-white/5 text-[13px] font-bold tabular-nums ${
                          row.isYou
                            ? "bg-[#51a7d5] text-[#0b0e14]"
                            : "bg-white/[0.04] text-gray-400"
                        }`}
                      >
                        {i + 1}
                      </div>
                      <div className="flex min-w-0 items-center gap-2 px-3">
                        <span
                          className="h-2.5 w-2.5 shrink-0 rounded-full"
                          style={{ backgroundColor: row.colorHex }}
                        />
                        <span
                          className={`truncate text-[14px] ${
                            row.isYou
                              ? "font-semibold text-white"
                              : "text-gray-200"
                          }`}
                        >
                          {row.name}
                        </span>
                        {row.isYou && (
                          <span className="bg-white px-1.5 py-0.5 text-[10px] font-bold text-[#0b0e14]">
                            YOU
                          </span>
                        )}
                      </div>
                      <span className="mr-4 text-[12px] tabular-nums text-gray-300">
                        {row.isYou
                          ? "0 ms"
                          : row.pingMs > 0
                            ? `${row.pingMs} ms`
                            : "connected"}
                      </span>
                    </div>
                  ))}
                </div>
              </>
            )}
          </div>

          {isConnected && (
            <div data-lobby-in className="space-y-3">
              <div>
                <div className="text-[11px] font-semibold tracking-[0.22em] text-[#8f99a8]">
                  RACE DISTANCE
                </div>
                <div className="mt-2 flex gap-1.5">
                  {RACE_DISTANCES_KM.map((km) => (
                    <button
                      key={km}
                      onClick={() => setDistanceKm(km)}
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
              </div>

              <div>
                <div className="flex items-center justify-between text-[11px] font-semibold tracking-[0.22em] text-[#8f99a8]">
                  <span className="inline-flex items-center gap-1.5">
                    <Bot size={14} />
                    AI RIVALS (BOTS)
                  </span>
                  <span className="font-mono text-[10px] tracking-normal text-gray-400">
                    GRID: {peers.length + 1}+{aiCount}
                  </span>
                </div>
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {MULTIPLAYER_AI_COUNTS.map((n) => (
                    <button
                      key={n}
                      onClick={() => setAiCount(n)}
                      className={`min-w-[44px] flex-1 border border-[#51a7d5] py-2 text-[13px] font-semibold transition ${
                        aiCount === n
                          ? "bg-white text-[#0b0e14]"
                          : "bg-[#51a7d5]/15 text-gray-300 hover:bg-[#51a7d5]/25"
                      }`}
                    >
                      {n === 0 ? "Off" : n}
                    </button>
                  ))}
                </div>
                <div className="mt-1 text-[12px] text-gray-400">
                  {aiCount === 0
                    ? "Humans only: the drivers in this room."
                    : `${aiCount} bot${aiCount === 1 ? "" : "s"} join the grid behind the drivers. Whoever hits Start decides for the room.`}
                </div>
              </div>

              <div>
                <div className="text-[11px] font-semibold tracking-[0.22em] text-[#8f99a8]">
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
                    ? "Empty roads when free roaming together."
                    : `${trafficCountFor(traffic)} AI cruisers on your road in free roam (local only, not synced).`}
                </div>
              </div>

              <div className="space-y-2 pt-2">
                <button
                  onClick={() => onStartMultiplayerRace(distanceKm, aiCount)}
                  className="w-full bg-[#51a7d5] px-6 py-3.5 text-[15px] font-semibold text-white transition hover:bg-[#51a7d5]/90 inline-flex gap-1 items-center justify-center"
                >
                  {aiCount === 0
                    ? `Start Grid Race (${distanceKm} km)`
                    : `Start Mixed Race (${distanceKm} km · +${aiCount} bots)`}
                  <ArrowUpRight size={20} />
                </button>
                <button
                  onClick={onStartFreeDrive}
                  className="w-full border border-[#51a7d5] bg-[#51a7d5]/15 px-6 py-3 text-[14px] font-semibold text-[#6ec2f0] transition hover:bg-[#51a7d5]/25 active:scale-[0.98] inline-flex items-center justify-center gap-1"
                >
                  <Users size={18} />
                  {traffic === "off"
                    ? "Free Roam Together"
                    : `Free Roam Together · ${TRAFFIC_OPTIONS.find((o) => o.id === traffic)?.label} traffic`}
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </Screen>
  )
}

export function MultiplayerHudBadge({
  playerCount,
  pingMs,
  onLeave,
}: {
  playerCount: number
  pingMs: number
  onLeave: () => void
}) {
  return (
    <div className="pointer-events-auto absolute top-5 right-5 flex items-center gap-2.5 rounded-full border border-white/15 bg-black/60 px-3.5 py-1.5 text-xs text-white backdrop-blur shadow-md">
      <span className="h-2 w-2 rounded-full bg-green-400 animate-pulse" />
      <span className="font-semibold text-gray-200">
        Online · {playerCount} player{playerCount === 1 ? "" : "s"}
      </span>
      {pingMs > 0 && (
        <>
          <span className="h-3 w-px bg-white/20" />
          <span className="font-mono text-green-400">{pingMs}ms</span>
        </>
      )}
      <button
        onClick={onLeave}
        className="ml-1 text-gray-400 hover:text-red-400 text-[11px] font-bold"
        title="Leave multiplayer"
      >
        ✕
      </button>
    </div>
  )
}
