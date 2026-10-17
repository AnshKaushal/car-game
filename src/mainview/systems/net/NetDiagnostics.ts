
export interface PeerDiag {
  recv: number
  gaps: number
  ooo: number
  dups: number
  invalid: number
  lastSeq: number
  lastArrivalLocalMs: number
  lastPktT: number
  ageMs: number
  rttMs: number
  jitterMs: number
  posErrM: number
  linSpeed: number
  angSpeed: number
  snaps: number
  lastSnapCause: string
  lastSnapDistM: number
  interpMode: string
  bufSize: number
  extrapMs: number
  underruns: number
  interpResets: number
  lastResetReason: string
  corrMode: string
  inContact: boolean
  contactImpulse: number
  hasSupport: boolean
  corrCmd: number
  corrDv: number
  suppressMs: number
  recoverT: number
  contactTransitions: number
}

export interface NetDiagSnapshot {
  now: number
  sendTotal: number
  sendHz: number
  recvTotal: number
  recvHz: number
  invalidTotal: number
  invalidByReason: Record<string, number>
  physicsTicks: number
  physicsTickHz: number
  physicsDroppedS: number
  remoteBodies: number
  contactSampleMs: number
  peers: Record<string, PeerDiag>
  events: Array<{ t: number; msg: string }>
}

function newPeerDiag(): PeerDiag {
  return {
    recv: 0,
    gaps: 0,
    ooo: 0,
    dups: 0,
    invalid: 0,
    lastSeq: -1,
    lastArrivalLocalMs: 0,
    lastPktT: 0,
    ageMs: 0,
    rttMs: 0,
    jitterMs: 0,
    posErrM: 0,
    linSpeed: 0,
    angSpeed: 0,
    snaps: 0,
    lastSnapCause: "",
    lastSnapDistM: 0,
    interpMode: "empty",
    bufSize: 0,
    extrapMs: 0,
    underruns: 0,
    interpResets: 0,
    lastResetReason: "",
    corrMode: "follow",
    inContact: false,
    contactImpulse: 0,
    hasSupport: false,
    corrCmd: 0,
    corrDv: 0,
    suppressMs: 0,
    recoverT: 1,
    contactTransitions: 0,
  }
}

const peers = new Map<string, PeerDiag>()
const invalidByReason: Record<string, number> = {}
const events: Array<{ t: number; msg: string }> = []

let sendTotal = 0
let recvTotal = 0
let invalidTotal = 0
let physicsTicks = 0
let physicsDroppedS = 0
let remoteBodies = 0

let winStart = 0
let winSend = 0
let winRecv = 0
let sendHz = 0
let recvHz = 0
let physWinStart = 0
let physWinTicks = 0
let physicsTickHz = 0

function peer(id: string): PeerDiag {
  let p = peers.get(id)
  if (!p) {
    p = newPeerDiag()
    peers.set(id, p)
  }
  return p
}

function rollWindow(now: number) {
  if (winStart === 0) winStart = now
  if (now - winStart >= 1000) {
    sendHz = (winSend * 1000) / Math.max(1, now - winStart)
    recvHz = (winRecv * 1000) / Math.max(1, now - winStart)
    winStart = now
    winSend = 0
    winRecv = 0
  }
  if (physWinStart === 0) physWinStart = now
  if (now - physWinStart >= 1000) {
    physicsTickHz = (physWinTicks * 1000) / Math.max(1, now - physWinStart)
    physWinStart = now
    physWinTicks = 0
  }
}

function pushEvent(msg: string) {
  events.push({ t: Date.now(), msg })
  if (events.length > 60) events.splice(0, events.length - 60)
}

export function netDiagSend() {
  const now = performance.now()
  sendTotal++
  winSend++
  rollWindow(now)
}

export function netDiagRecv(peerId: string, senderT: number) {
  const now = performance.now()
  const p = peer(peerId)
  p.recv++
  recvTotal++
  winRecv++
  p.lastArrivalLocalMs = now
  if (Number.isFinite(senderT)) p.lastPktT = senderT
  rollWindow(now)
}

export function netDiagSeqAccept(peerId: string, seq: number, initial = false) {
  const p = peer(peerId)
  if (initial || p.lastSeq < 0) {
    p.lastSeq = seq
    return
  }
  if (seq > p.lastSeq + 1) {
    p.gaps += seq - p.lastSeq - 1
  }
  if (seq > p.lastSeq) p.lastSeq = seq
}

export function netDiagSeqReject(
  peerId: string,
  kind: "duplicate" | "stale" | "stale-session",
) {
  const p = peer(peerId)
  if (kind === "duplicate") p.dups++
  else p.ooo++
}

export function netDiagInvalid(peerId: string, reason: string) {
  invalidTotal++
  invalidByReason[reason] = (invalidByReason[reason] ?? 0) + 1
  peer(peerId).invalid++
  pushEvent(`invalid pkt from ${peerId.slice(0, 4)}: ${reason}`)
}

export function netDiagPeerEvent(peerId: string, kind: string) {
  if (kind === "cleanup" || kind === "disconnect" || kind === "timeout") {
  }
  pushEvent(`${kind} ${peerId.slice(0, 6)}`)
}

export function netDiagForgetPeer(peerId: string) {
  peers.delete(peerId)
}

export function netDiagSnap(peerId: string, cause: string, distM: number) {
  const p = peer(peerId)
  p.snaps++
  p.lastSnapCause = cause
  p.lastSnapDistM = distM
  pushEvent(`snap ${peerId.slice(0, 4)} cause=${cause} d=${distM.toFixed(1)}m`)
}

export function netDiagInterpSample(
  peerId: string,
  mode: string,
  bufSize: number,
  extrapMs: number,
  underruns: number,
) {
  const p = peer(peerId)
  p.interpMode = mode
  p.bufSize = bufSize
  p.extrapMs = extrapMs
  p.underruns = underruns
}

export function netDiagBufferReset(peerId: string, reason: string) {
  const p = peer(peerId)
  p.interpResets++
  p.lastResetReason = reason
  pushEvent(`interp-reset ${peerId.slice(0, 4)} reason=${reason}`)
}

export function netDiagContact(
  peerId: string,
  touching: boolean,
  impulse: number,
  mode: string,
  support?: boolean,
) {
  const p = peer(peerId)
  const was = p.corrMode
  p.inContact = touching
  p.contactImpulse = impulse
  p.corrMode = mode
  if (support !== undefined) p.hasSupport = support
  if (was !== mode && (was === "contact" || mode === "contact")) {
    pushEvent(`contact ${peerId.slice(0, 4)} ${was}->${mode}`)
  }
}

export function netDiagCorrection(
  peerId: string,
  mode: string,
  errM: number,
  corrCmd: number,
  corrDv: number,
  suppressedSubsteps: number,
  contactTransitions: number,
  recoverT: number,
) {
  const p = peer(peerId)
  p.corrMode = mode
  p.posErrM = errM
  p.corrCmd = corrCmd
  p.corrDv = corrDv
  p.suppressMs = Math.round((suppressedSubsteps / 120) * 1000)
  p.contactTransitions = contactTransitions
  p.recoverT = recoverT
}

let contactSampleMs = 0
export function netDiagContactCost(ms: number) {
  contactSampleMs = ms
}

export function netDiagRemoteSample(
  peerId: string,
  posErrM: number,
  linSpeed: number,
  angSpeed: number,
  ageMs: number,
) {
  const p = peer(peerId)
  p.posErrM = posErrM
  p.linSpeed = linSpeed
  p.angSpeed = angSpeed
  p.ageMs = ageMs
}

export function netDiagRtt(peerId: string, rttMs: number) {
  const p = peer(peerId)
  const prev = p.rttMs
  p.rttMs = rttMs
  if (prev > 0) p.jitterMs = p.jitterMs * 0.8 + Math.abs(rttMs - prev) * 0.2
}

export function netDiagPhysicsTick(steps: number, droppedTotalS: number) {
  const now = performance.now()
  physicsTicks += steps
  physWinTicks += steps
  physicsDroppedS = droppedTotalS
  rollWindow(now)
}

export function netDiagRemoteCount(n: number) {
  remoteBodies = n
}

export function getNetDiagSnapshot(): NetDiagSnapshot {
  const out: Record<string, PeerDiag> = {}
  for (const [k, v] of peers.entries()) out[k] = { ...v }
  return {
    now: Date.now(),
    sendTotal,
    sendHz: Math.round(sendHz * 10) / 10,
    recvTotal,
    recvHz: Math.round(recvHz * 10) / 10,
    invalidTotal,
    invalidByReason: { ...invalidByReason },
    physicsTicks,
    physicsTickHz: Math.round(physicsTickHz * 10) / 10,
    physicsDroppedS: Math.round(physicsDroppedS * 1000) / 1000,
    remoteBodies,
    contactSampleMs: Math.round(contactSampleMs * 1000) / 1000,
    peers: out,
    events: [...events].slice(-12),
  }
}

export function netDiagEnabled(): boolean {
  try {
    if (typeof localStorage !== "undefined") {
      if (localStorage.getItem("oversteer_netdiag") === "1") return true
    }
  } catch {}
  try {
    if (typeof location !== "undefined" && location.search.includes("netdiag"))
      return true
  } catch {}
  return false
}

let lastLogAt = 0
export function maybeLogNetDiag() {
  if (!netDiagEnabled()) return
  try {
    if (import.meta.env.PROD) return
  } catch {}
  const now = performance.now()
  if (now - lastLogAt < 5000) return
  lastLogAt = now
  const s = getNetDiagSnapshot()
  const peerIds = Object.keys(s.peers)
  console.log(
    `[NetDiag] send ${s.sendHz}/s (total ${s.sendTotal}) | recv ${s.recvHz}/s (total ${s.recvTotal}) | ` +
      `invalid ${s.invalidTotal} | phys ${s.physicsTickHz} ticks/s dropped ${s.physicsDroppedS}s | ` +
      `remotes ${s.remoteBodies} | peers ${peerIds.length}`,
  )
  for (const id of peerIds) {
    const p = s.peers[id]
    console.log(
      `[NetDiag] peer ${id.slice(0, 6)}: recv=${p.recv} gaps=${p.gaps} ooo=${p.ooo} dups=${p.dups} ` +
        `age=${Math.round(p.ageMs)}ms rtt=${Math.round(p.rttMs)}ms jit=${Math.round(p.jitterMs)}ms ` +
        `err=${p.posErrM.toFixed(2)}m v=${p.linSpeed.toFixed(1)}m/s w=${p.angSpeed.toFixed(2)}rad/s ` +
        `snaps=${p.snaps}${p.lastSnapCause ? ` last=${p.lastSnapCause}` : ""} ` +
        `interp=${p.interpMode} buf=${p.bufSize} extrap=${Math.round(p.extrapMs)}ms ` +
        `under=${p.underruns} resets=${p.interpResets}${p.lastResetReason ? ` (${p.lastResetReason})` : ""} ` +
        `corr=${p.corrMode}${p.inContact ? "(touch)" : ""}${p.hasSupport ? "[sup]" : ""} err=${p.posErrM.toFixed(2)}m ` +
        `cmd=${p.corrCmd.toFixed(2)}m/s dv=${p.corrDv.toFixed(3)}m/s ` +
        `supp=${p.suppressMs}ms rec=${p.recoverT.toFixed(2)} trans=${p.contactTransitions}`,
    )
  }
}

try {
  (window as any).__netDiag = getNetDiagSnapshot
} catch {}
