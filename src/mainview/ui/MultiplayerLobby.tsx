import { useState } from "react"
import { RIVAL_COLORS, colorHex } from "../systems/carTint"
import type { PeerPlayer } from "../systems/net/types"

export type MultiplayerMode = "p2p" | "lan"

interface MultiplayerLobbyProps {
  playerName: string
  carColor: number
  roomId: string
  isConnected: boolean
  peers: PeerPlayer[]
  joinError?: string | null
  initialMode?: MultiplayerMode
  onUpdateProfile: (name: string, color: number) => void
  onJoinRoom: (target: string, mode: MultiplayerMode) => void
  onLeaveRoom: () => void
  onStartMultiplayerRace: (distanceKm: number) => void
  onStartFreeDrive: () => void
  onBack: () => void
}

const stripe = (
  <div className="flex h-[5px]">
    <div className="flex-1 bg-[#51a7d5]" />
    <div className="flex-1 bg-[#1c3d7c]" />
    <div className="flex-1 bg-[#e30613]" />
  </div>
)

// Short unambiguous room codes (no 0/O, 1/I/L). Uppercase so typed codes
// always match regardless of caps lock.
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
  onBack,
}: MultiplayerLobbyProps) {
  const [netMode, setNetMode] = useState<MultiplayerMode>(initialMode)
  const [nameInput, setNameInput] = useState(playerName)
  const [p2pRoomInput, setP2pRoomInput] = useState(
    initialMode === "p2p" && roomId ? roomId : "paddock-1",
  )
  const [lanAddressInput, setLanAddressInput] = useState(
    initialMode === "lan" && roomId ? roomId : "localhost:9876",
  )
  const [selectedColor, setSelectedColor] = useState(carColor)
  const [distanceKm, setDistanceKm] = useState<number>(5)
  const [copied, setCopied] = useState(false)

  const handleApplyProfile = (newColor: number) => {
    setSelectedColor(newColor)
    onUpdateProfile(nameInput.trim() || playerName, newColor)
  }

  const normalizeP2PCode = (raw: string) =>
    raw.trim().toUpperCase().replace(/\s+/g, "")

  const handleCreateRoom = () => {
    const code = generateRoomCode()
    onUpdateProfile(nameInput.trim() || playerName, selectedColor)
    setP2pRoomInput(code)
    onJoinRoom(code, "p2p")
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
    onUpdateProfile(nameInput.trim() || playerName, selectedColor)
    if (netMode === "p2p") {
      const code = normalizeP2PCode(p2pRoomInput)
      if (!code) return
      setP2pRoomInput(code)
      onJoinRoom(code, "p2p")
    } else {
      if (!lanAddressInput.trim()) return
      onJoinRoom(lanAddressInput.trim(), "lan")
    }
  }

  return (
    <div className="absolute inset-0 flex items-center justify-center bg-gradient-to-b from-black/80 via-black/60 to-black/85 backdrop-blur-sm z-50">
      <div className="relative w-[520px] max-w-[92vw] overflow-hidden rounded-3xl border border-white/10 bg-[#0b0e14]/95 text-center shadow-[0_30px_100px_rgba(0,0,0,0.8)]">
        {stripe}
        <div className="px-8 pt-7 pb-8 text-left">
          {/* Header */}
          <div className="flex items-center justify-between">
            <div>
              <div className="text-[11px] font-semibold tracking-[0.4em] text-[#8f99a8]">
                ELECTROBUN MULTIPLAYER
              </div>
              <h2 className="mt-1 text-3xl font-bold tracking-tight text-white">
                Multiplayer Lobby
              </h2>
            </div>
            <button
              onClick={onBack}
              className="rounded-xl border border-white/10 bg-white/5 px-3 py-1.5 text-xs font-semibold text-gray-300 hover:bg-white/10"
            >
              Back
            </button>
          </div>

          {/* Network Mode Tabs */}
          {!isConnected && (
            <div className="mt-4 flex rounded-xl bg-white/5 p-1 border border-white/10">
              <button
                type="button"
                onClick={() => setNetMode("p2p")}
                className={`flex-1 rounded-lg py-1.5 text-xs font-semibold transition ${
                  netMode === "p2p"
                    ? "bg-[#51a7d5] text-white shadow"
                    : "text-gray-400 hover:text-white"
                }`}
              >
                🌐 Internet P2P (WebRTC)
              </button>
              <button
                type="button"
                onClick={() => setNetMode("lan")}
                className={`flex-1 rounded-lg py-1.5 text-xs font-semibold transition ${
                  netMode === "lan"
                    ? "bg-[#51a7d5] text-white shadow"
                    : "text-gray-400 hover:text-white"
                }`}
              >
                ⚡ LAN / Direct IP (0ms)
              </button>
            </div>
          )}

          {/* Profile Setup: Name & Car Paint */}
          <div className="mt-5 space-y-4">
            <div>
              <label className="text-[11px] font-semibold tracking-[0.2em] text-[#8f99a8]">
                DRIVER CALLSIGN
              </label>
              <input
                type="text"
                value={nameInput}
                onChange={(e) => {
                  setNameInput(e.target.value)
                  onUpdateProfile(e.target.value, selectedColor)
                }}
                // Keep game shortcuts (WASD/Enter/Esc) out of text fields.
                onKeyDown={(e) => e.stopPropagation()}
                onKeyUp={(e) => e.stopPropagation()}
                maxLength={18}
                placeholder="Enter callsign"
                autoComplete="off"
                autoCorrect="off"
                autoCapitalize="off"
                spellCheck={false}
                className="mt-1.5 w-full rounded-xl border border-white/12 bg-white/5 px-3.5 py-2 text-sm text-white placeholder-gray-500 focus:border-[#51a7d5] focus:outline-none"
              />
            </div>

            <div>
              <label className="text-[11px] font-semibold tracking-[0.2em] text-[#8f99a8]">
                M3 BODY PAINT
              </label>
              <div className="mt-2 flex flex-wrap gap-2">
                {RIVAL_COLORS.slice(0, 10).map((col) => {
                  const hex = colorHex(col)
                  const isSel = selectedColor === col
                  return (
                    <button
                      key={col}
                      type="button"
                      onClick={() => handleApplyProfile(col)}
                      className={`h-7 w-7 rounded-full border-2 transition-transform ${
                        isSel
                          ? "scale-110 border-white shadow-[0_0_12px_rgba(255,255,255,0.7)]"
                          : "border-transparent opacity-75 hover:opacity-100"
                      }`}
                      style={{ backgroundColor: hex }}
                      title={hex}
                    />
                  )
                })}
              </div>
            </div>
          </div>

          {/* Room / Connection Form */}
          <div className="mt-5 pt-4 border-t border-white/10">
            <label className="text-[11px] font-semibold tracking-[0.2em] text-[#8f99a8]">
              {netMode === "p2p" ? "INTERNET ROOM" : "HOST ADDRESS / DIRECT IP"}
            </label>
            {!isConnected && joinError && (
              <div className="mt-2 rounded-xl border border-red-500/30 bg-red-500/10 px-3.5 py-2 text-[12px] text-red-200">
                {joinError}
              </div>
            )}
            {!isConnected ? (
              netMode === "p2p" ? (
                <div className="mt-1.5 space-y-2">
                  <button
                    type="button"
                    onClick={handleCreateRoom}
                    className="w-full rounded-xl bg-[#51a7d5] px-5 py-2.5 text-sm font-semibold text-white shadow-[0_4px_20px_rgba(81,167,213,0.35)] transition hover:bg-[#63b8e8]"
                  >
                    ＋ Create New Room
                  </button>
                  <form onSubmit={handleJoin} className="space-y-2">
                    <div className="flex gap-2">
                      <input
                        type="text"
                        value={p2pRoomInput}
                        onChange={(e) => setP2pRoomInput(e.target.value)}
                        // Game keys must type here, not drive the car.
                        onKeyDown={(e) => e.stopPropagation()}
                        onKeyUp={(e) => e.stopPropagation()}
                        autoComplete="off"
                        autoCorrect="off"
                        autoCapitalize="characters"
                        spellCheck={false}
                        placeholder="Enter room code, e.g. X7Q2-MA9D"
                        className="flex-1 rounded-xl border border-white/12 bg-white/5 px-3.5 py-2 font-mono text-sm uppercase text-white placeholder-gray-500 placeholder:font-sans placeholder:normal-case focus:border-[#51a7d5] focus:outline-none"
                      />
                      <button
                        type="submit"
                        className="rounded-xl border border-white/15 bg-white/5 px-5 py-2 text-sm font-semibold text-white transition hover:bg-white/10"
                      >
                        Join
                      </button>
                    </div>
                  </form>
                  <div className="text-[11px] text-gray-400">
                    Create a room and share the code, or enter a friend&apos;s
                    code to join. Same code, both press — allow ~10s for the
                    WebRTC mesh.
                  </div>
                </div>
              ) : (
                <form onSubmit={handleJoin} className="mt-1.5 space-y-2">
                  <div className="flex gap-2">
                    <input
                      type="text"
                      value={lanAddressInput}
                      onChange={(e) => setLanAddressInput(e.target.value)}
                      // Game keys must type here, not drive the car.
                      onKeyDown={(e) => e.stopPropagation()}
                      onKeyUp={(e) => e.stopPropagation()}
                      autoComplete="off"
                      autoCorrect="off"
                      autoCapitalize="off"
                      spellCheck={false}
                      placeholder="localhost:9876 or 192.168.1.x:9876"
                      className="flex-1 rounded-xl border border-white/12 bg-white/5 px-3.5 py-2 text-sm text-white placeholder-gray-500 focus:border-[#51a7d5] focus:outline-none"
                    />
                    <button
                      type="submit"
                      className="rounded-xl bg-[#51a7d5] px-5 py-2 text-sm font-semibold text-white shadow-[0_4px_20px_rgba(81,167,213,0.35)] transition hover:bg-[#63b8e8]"
                    >
                      Connect
                    </button>
                  </div>
                  <div className="text-[11px] text-gray-400">
                    Zero-latency local connection. Host auto-runs on port 9876.
                  </div>
                </form>
              )
            ) : (
              <div className="mt-2 space-y-2">
                {netMode === "p2p" && (
                  <div className="flex items-center justify-between rounded-xl border border-[#51a7d5]/30 bg-[#51a7d5]/10 px-3.5 py-2.5">
                    <div>
                      <div className="text-[10px] font-semibold tracking-[0.25em] text-[#8fb8d8]">
                        SHARE THIS ROOM CODE
                      </div>
                      <div className="font-mono text-xl font-bold tracking-[0.15em] text-white">
                        {roomId}
                      </div>
                    </div>
                    <button
                      onClick={handleCopyCode}
                      className="rounded-lg border border-white/15 bg-white/5 px-3 py-1.5 text-xs font-semibold text-gray-200 hover:bg-white/10"
                    >
                      {copied ? "Copied ✓" : "Copy"}
                    </button>
                  </div>
                )}
                <div className="flex items-center justify-between rounded-xl border border-green-500/20 bg-green-500/10 px-3.5 py-2 text-sm">
                  <div className="flex items-center gap-2">
                    <span className="h-2 w-2 rounded-full bg-green-400 animate-pulse" />
                    <span className="font-semibold text-green-300">
                      Connected ({netMode.toUpperCase()}): &quot;{roomId}&quot;
                    </span>
                  </div>
                  <button
                    onClick={onLeaveRoom}
                    className="rounded-lg border border-red-500/30 bg-red-500/10 px-2.5 py-1 text-xs font-semibold text-red-300 hover:bg-red-500/20"
                  >
                    Disconnect
                  </button>
                </div>
              </div>
            )}
          </div>

          {/* Connected Players in Room */}
          {isConnected && (
            <div className="mt-5 space-y-3">
              <div className="flex items-center justify-between text-[11px] font-semibold tracking-[0.2em] text-[#8f99a8]">
                <span>PADDOCK ROSTER ({peers.length + 1} PLAYERS)</span>
                <span className="text-gray-400 font-mono text-[10px]">
                  {netMode === "p2p" ? "WebRTC UDP" : "LAN WS"}
                </span>
              </div>
              <div className="max-h-32 overflow-y-auto space-y-1.5 pr-1 no-scrollbar">
                {peers.length === 0 && (
                  <div className="rounded-xl border border-amber-400/25 bg-amber-400/10 px-3 py-2 text-[12px] text-amber-200">
                    Waiting for rivals — share{" "}
                    <span className="font-mono font-semibold">
                      &quot;{roomId}&quot;
                    </span>{" "}
                    and have them press Connect.
                  </div>
                )}
                {/* Local player */}
                <div className="flex items-center justify-between rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-sm">
                  <div className="flex items-center gap-2.5">
                    <span
                      className="h-3 w-3 rounded-full"
                      style={{ backgroundColor: colorHex(selectedColor) }}
                    />
                    <span className="font-semibold text-white">
                      {nameInput || playerName}
                    </span>
                    <span className="rounded bg-white/10 px-1.5 py-0.5 text-[10px] text-gray-300">
                      YOU
                    </span>
                  </div>
                  <span className="text-xs text-green-400 font-mono">0 ms</span>
                </div>

                {/* Remote peers */}
                {peers.map((p) => (
                  <div
                    key={p.id}
                    className="flex items-center justify-between rounded-xl border border-white/5 bg-white/[0.02] px-3 py-2 text-sm"
                  >
                    <div className="flex items-center gap-2.5">
                      <span
                        className="h-3 w-3 rounded-full"
                        style={{ backgroundColor: p.colorHex }}
                      />
                      <span className="text-gray-200">{p.name}</span>
                    </div>
                    <span className="text-xs text-gray-400 font-mono">
                      {p.pingMs > 0 ? `${p.pingMs} ms` : "connected"}
                    </span>
                  </div>
                ))}
              </div>

              {/* Race Distance Selection */}
              <div className="pt-2">
                <div className="text-[11px] font-semibold tracking-[0.2em] text-[#8f99a8]">
                  RACE DISTANCE
                </div>
                <div className="mt-1.5 flex gap-1.5">
                  {[1, 2, 5, 10].map((km) => (
                    <button
                      key={km}
                      onClick={() => setDistanceKm(km)}
                      className={`flex-1 rounded-xl py-1.5 text-xs font-semibold transition ${
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

              {/* Launch Action Buttons */}
              <div className="mt-5 space-y-2">
                <button
                  onClick={() => onStartMultiplayerRace(distanceKm)}
                  className="w-full rounded-2xl bg-[#e30613] px-6 py-3 text-sm font-semibold tracking-wide text-white shadow-[0_10px_35px_rgba(227,6,19,0.4)] transition hover:bg-[#f01422] active:scale-[0.98]"
                >
                  Start Grid Race ({distanceKm} km)
                </button>
                <button
                  onClick={onStartFreeDrive}
                  className="w-full rounded-2xl border border-white/12 bg-white/5 px-6 py-2.5 text-sm font-medium text-gray-200 transition hover:bg-white/10 active:scale-[0.98]"
                >
                  Enter Free Drive Together
                </button>
              </div>
            </div>
          )}

        </div>
      </div>
    </div>
  )
}

export function MultiplayerHudBadge({
  roomId,
  playerCount,
  pingMs,
  onLeave,
}: {
  roomId: string
  playerCount: number
  pingMs: number
  onLeave: () => void
}) {
  return (
    <div className="pointer-events-auto absolute top-5 right-5 flex items-center gap-2.5 rounded-full border border-white/15 bg-black/60 px-3.5 py-1.5 text-xs text-white backdrop-blur shadow-md">
      <span className="h-2 w-2 rounded-full bg-green-400 animate-pulse" />
      <span className="font-semibold text-gray-200">Online: {roomId}</span>
      <span className="h-3 w-px bg-white/20" />
      <span className="text-gray-300">{playerCount} players</span>
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
