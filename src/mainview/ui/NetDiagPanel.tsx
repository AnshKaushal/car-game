import { useEffect, useState } from "react"
import {
  getNetDiagSnapshot,
  type NetDiagSnapshot,
} from "../systems/net/NetDiagnostics"

export function NetDiagPanel() {
  const [snap, setSnap] = useState<NetDiagSnapshot | null>(null)
  useEffect(() => {
    const id = window.setInterval(() => {
      try {
        setSnap(getNetDiagSnapshot())
      } catch {}
    }, 500)
    return () => window.clearInterval(id)
  }, [])
  if (!snap) return null
  const peers = Object.entries(snap.peers)
  return (
    <div className="pointer-events-none absolute bottom-3 left-3 z-50 max-w-[340px] rounded-xl border border-white/15 bg-black/75 px-3 py-2 font-mono text-[10px] leading-4 text-gray-200 backdrop-blur">
      <div className="font-bold tracking-widest text-[#8fb8d8]">NET DIAG (dev)</div>
      <div>
        send {snap.sendHz}/s ({snap.sendTotal}) · recv {snap.recvHz}/s (
        {snap.recvTotal}) · invalid {snap.invalidTotal}
      </div>
      <div>
        phys {snap.physicsTickHz} ticks/s · dropped {snap.physicsDroppedS}s ·
        remotes {snap.remoteBodies} · csample {snap.contactSampleMs}ms
      </div>
      {peers.length === 0 && <div className="text-gray-500">no peers yet</div>}
      {peers.map(([id, p]) => (
        <div key={id} className="mt-1 border-t border-white/10 pt-1">
          <div className="font-bold text-white">{id.slice(0, 6)}</div>
          <div>
            recv={p.recv} gaps={p.gaps} ooo={p.ooo} dups={p.dups} age=
            {Math.round(p.ageMs)}ms
          </div>
          <div>
            rtt={Math.round(p.rttMs)}ms jit={Math.round(p.jitterMs)}ms err=
            {p.posErrM.toFixed(2)}m v={p.linSpeed.toFixed(1)}m/s w=
            {p.angSpeed.toFixed(2)} snaps={p.snaps}
            {p.lastSnapCause ? ` (${p.lastSnapCause})` : ""}
          </div>
          <div>
            {p.interpMode} buf={p.bufSize} extrap={Math.round(p.extrapMs)}ms
            under={p.underruns} resets={p.interpResets}
            {p.lastResetReason ? ` (${p.lastResetReason})` : ""}
          </div>
          <div>
            {p.corrMode}
            {p.inContact ? "(touch)" : ""}
            {p.hasSupport ? "[sup]" : ""} err={p.posErrM.toFixed(2)}m cmd=
            {p.corrCmd.toFixed(2)} dv={p.corrDv.toFixed(3)} supp={p.suppressMs}
            ms rec={p.recoverT.toFixed(2)}
          </div>
        </div>
      ))}
      {snap.events.length > 0 && (
        <div className="mt-1 border-t border-white/10 pt-1 text-gray-400">
          {snap.events.slice(-4).map((e, i) => (
            <div key={i}>{e.msg}</div>
          ))}
        </div>
      )}
    </div>
  )
}
