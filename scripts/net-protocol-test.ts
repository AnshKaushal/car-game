/**
 * Phase 2 regression tests: packet validation, ordering, sessions, clocks.
 *
 * Run: `bun scripts/net-protocol-test.ts` (exit 1 on any failure).
 * Follows the repo's scripts/ convention — plain bun, zero new dependencies.
 */
import * as THREE from "three"
import { initPhysics, createWorld } from "../src/mainview/systems/PhysicsSystem"
import {
  validateStatePacket,
  PeerSessionTracker,
  isAccept,
} from "../src/mainview/systems/net/stateProtocol"
import {
  getNetDiagSnapshot,
  netDiagSeqAccept,
  netDiagSeqReject,
} from "../src/mainview/systems/net/NetDiagnostics"
import { RemoteCar } from "../src/mainview/systems/net/RemoteCar"
import { MultiplayerManager } from "../src/mainview/systems/net/MultiplayerManager"

let failures = 0
let passes = 0
function check(name: string, cond: boolean, extra?: unknown) {
  if (cond) {
    passes++
    console.log(`ok - ${name}`)
  } else {
    failures++
    console.error(`FAIL - ${name}`, extra ?? "")
  }
}

function makePkt(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "peerA",
    t: 1234.5,
    seq: 0,
    sess: "sessA",
    x: 10,
    y: 0.72,
    z: -20,
    qx: 0,
    qy: 0,
    qz: 0,
    qw: 1,
    vx: 5,
    vy: 0,
    vz: -12,
    steer: 0.1,
    speed: 60,
    rpm: 3200,
    gear: 3,
    drift: false,
    smoke: false,
    progress: 120,
    ...over,
  }
}

// ---------- 1. valid initial packet ----------
{
  const r = validateStatePacket(makePkt())
  check("1 valid packet ok", r.ok === true)
  const tr = new PeerSessionTracker()
  if (r.ok)
    check(
      "1 tracker accept-initial",
      tr.evaluate("p", r.state.sess, r.state.seq) === "accept-initial",
    )
}

// ---------- 2. increasing sequence numbers ----------
{
  const tr = new PeerSessionTracker()
  check("2 seq0 initial", tr.evaluate("p", "s", 0) === "accept-initial")
  check("2 seq1 accept", tr.evaluate("p", "s", 1) === "accept")
  check("2 seq2 accept", tr.evaluate("p", "s", 2) === "accept")
}

// ---------- 3. duplicates ----------
{
  const tr = new PeerSessionTracker()
  tr.evaluate("p", "s", 4)
  check("3 dup rejected", tr.evaluate("p", "s", 4) === "reject-duplicate")
  check("3 lastSeq unmoved", tr.lastSeq("p") === 4)
}

// ---------- 4. older after newer ----------
{
  const tr = new PeerSessionTracker()
  tr.evaluate("p", "s", 10)
  check("4 stale rejected", tr.evaluate("p", "s", 7) === "reject-stale")
  check("4 lastSeq unmoved", tr.lastSeq("p") === 10)
}

// ---------- 5. sequence gaps accepted + counted ----------
{
  const tr = new PeerSessionTracker()
  tr.evaluate("gp", "s", 5)
  check("5 gap accept", tr.evaluate("gp", "s", 10) === "accept")
  netDiagSeqAccept("gp-diag", 5)
  const before = getNetDiagSnapshot().peers["gp-diag"]?.gaps ?? 0
  netDiagSeqAccept("gp-diag", 10)
  const after = getNetDiagSnapshot().peers["gp-diag"]?.gaps ?? -1
  check("5 diag gaps counted", after - before === 4, { before, after })
  netDiagSeqReject("gd-diag", "duplicate")
  netDiagSeqReject("gd-diag", "stale")
  const d = getNetDiagSnapshot().peers["gd-diag"]
  check("5 diag dup/stale counted", d?.dups === 1 && d?.ooo === 1, d)
}

// ---------- 6. invalid pos / quat / vel ----------
{
  check(
    "6 NaN x",
    validateStatePacket(makePkt({ x: NaN })).reason === "bad-pos",
  )
  check(
    "6 Inf z",
    validateStatePacket(makePkt({ z: Infinity })).reason === "bad-pos",
  )
  check(
    "6 vel too big",
    validateStatePacket(makePkt({ vx: 1000 })).reason === "bad-vel",
  )
  check(
    "6 NaN quat",
    validateStatePacket(makePkt({ qw: NaN })).reason === "bad-quat",
  )
  check(
    "6 zero quat",
    validateStatePacket(makePkt({ qx: 0, qy: 0, qz: 0, qw: 0 })).reason ===
      "bad-quat",
  )
}

// ---------- 7. null packets and missing fields ----------
{
  check("7 null", validateStatePacket(null).reason === "malformed-envelope")
  check(
    "7 undefined",
    validateStatePacket(undefined).reason === "malformed-envelope",
  )
  check("7 string", validateStatePacket("hi").reason === "malformed-envelope")
  check("7 array", validateStatePacket([]).reason === "malformed-envelope")
  const missing = makePkt()
  delete missing.x
  const r = validateStatePacket(missing)
  check("7 missing x rejected", r.ok === false)
  const noroot = makePkt()
  delete noroot.seq
  check("7 missing seq rejected", validateStatePacket(noroot).ok === false)
}

// ---------- 8. NaN/Infinity across numeric categories ----------
{
  const cases: Array<[string, string]> = [
    ["steer", "bad-steer"],
    ["speed", "bad-speed"],
    ["rpm", "bad-rpm"],
    ["progress", "bad-progress"],
    ["t", "bad-t"],
    ["seq", "bad-seq"],
  ]
  for (const [field, reason] of cases) {
    const a = validateStatePacket(makePkt({ [field]: NaN }))
    const b = validateStatePacket(makePkt({ [field]: Infinity }))
    check(`8 NaN ${field}`, !a.ok && a.reason === reason, a)
    check(`8 Inf ${field}`, !b.ok && b.reason === reason, b)
  }
  check(
    "8 gear 9 rejected",
    validateStatePacket(makePkt({ gear: 9 })).ok === false,
  )
  check(
    "8 gear 1.5 rejected",
    validateStatePacket(makePkt({ gear: 1.5 })).ok === false,
  )
  check(
    "8 string drift rejected",
    validateStatePacket(makePkt({ drift: 1 as unknown as boolean })).reason ===
      "bad-flags",
  )
  check(
    "8 neg seq rejected",
    validateStatePacket(makePkt({ seq: -1 })).reason === "bad-seq",
  )
  check(
    "8 bad sess rejected",
    validateStatePacket(makePkt({ sess: "" })).reason === "bad-sess",
  )
}

// ---------- 9. malformed packets don't advance sequence state ----------
{
  const tr = new PeerSessionTracker()
  tr.evaluate("p", "s", 3)
  check("9 invalid vel", validateStatePacket(makePkt({ vy: NaN })).ok === false)
  check("9 tracker untouched", tr.lastSeq("p") === 3)
  // A later valid packet with the SAME next seq is still accepted.
  const r = validateStatePacket(makePkt({ sess: "s", seq: 4 }))
  check("9 next valid ok", r.ok === true)
  if (r.ok)
    check(
      "9 next accepted",
      tr.evaluate("p", r.state.sess, r.state.seq) === "accept",
    )
}

// ---------- 10. legitimate extremes accepted ----------
{
  const legs: Record<string, unknown>[] = [
    { vx: 140, vz: -140 }, // fast but under 150/comp cap
    { steer: 1.5 },
    { steer: -1.5 },
    { speed: 350 },
    { speed: -120 }, // reverse
    { rpm: 7400 },
    { rpm: 800 },
    { gear: -1 },
    { gear: 0 },
    { gear: 8 },
    { progress: -50 }, // behind start line (grid rows)
    { drift: true, smoke: true },
  ]
  legs.forEach((o, i) => {
    const r = validateStatePacket(makePkt(o))
    check(`10 legit #${i} accepted`, r.ok === true, r)
  })
  // Unnormalized quat is normalized on accept WITHOUT mutating input.
  const input = makePkt({ qx: 2, qy: 0, qz: 0, qw: 0 })
  const r = validateStatePacket(input)
  check(
    "10 quat normalized",
    r.ok === true &&
      Math.abs((r as { ok: true; state: { qx: number } }).state.qx - 1) < 1e-9,
    r,
  )
  check("10 input untouched", (input.qx as number) === 2)
}

// ---------- 11. reconnect with seq restart ----------
{
  const tr = new PeerSessionTracker()
  for (let i = 0; i <= 5; i++) tr.evaluate("p", "sessA", i)
  tr.noteSession("p", "sessB") // HELLO of the rejoined session
  const d = tr.evaluate("p", "sessB", 0)
  check("11 rejoin seq0 accepted", d === "accept-initial", d)
  check("11 continues", tr.evaluate("p", "sessB", 1) === "accept")
  // Duplicate HELLO is idempotent: no reset, live seq survives.
  tr.noteSession("p", "sessB")
  check(
    "11 dup HELLO keeps seq",
    tr.evaluate("p", "sessB", 1) === "reject-duplicate",
  )
}

// ---------- 12. delayed packets from previous session ----------
{
  const tr = new PeerSessionTracker()
  for (let i = 0; i <= 5; i++) tr.evaluate("p", "sessA", i)
  tr.noteSession("p", "sessB")
  tr.evaluate("p", "sessB", 0)
  tr.evaluate("p", "sessB", 1)
  check(
    "12 old session rejected",
    tr.evaluate("p", "sessA", 99) === "reject-stale-session",
  )
  check("12 lastSeq intact", tr.lastSeq("p") === 1)
  check("12 current still flows", tr.evaluate("p", "sessB", 2) === "accept")
}

// ---------- 13. alien sender timestamps ----------
{
  for (const t of [9e12, -5e8, 0, 0.001]) {
    check(
      `13 t=${t} validates`,
      validateStatePacket(makePkt({ t })).ok === true,
    )
  }
}

// ---------- 14. P2P + LAN payload compatibility ----------
{
  const pkt = makePkt({
    extraFutureField: "ignored",
    seq: 7,
  }) as unknown as Record<string, unknown>
  const viaP2P = validateStatePacket(structuredClone(pkt))
  check("14 P2P clone ok", viaP2P.ok === true, viaP2P)
  const viaLAN = validateStatePacket(JSON.parse(JSON.stringify(pkt)))
  check("14 LAN JSON ok", viaLAN.ok === true, viaLAN)
  // LAN turns NaN into null — still rejected, never applied.
  const nanPkt = makePkt({ x: NaN })
  check(
    "14 LAN NaN rejected",
    validateStatePacket(JSON.parse(JSON.stringify(nanPkt))).ok === false,
  )
  // Legacy senders (no sess) still interoperate via seq ordering.
  const legacy = makePkt({ seq: 3 })
  delete legacy.sess
  const tr = new PeerSessionTracker()
  const lr = validateStatePacket(legacy)
  check(
    "14 legacy ok",
    lr.ok === true &&
      (lr as { ok: true; state: { sess: null } }).state.sess === null,
    lr,
  )
  if (lr.ok) {
    check(
      "14 legacy initial",
      tr.evaluate("p", lr.state.sess, lr.state.seq) === "accept-initial",
    )
    check("14 legacy dup", tr.evaluate("p", null, 3) === "reject-duplicate")
  }
}

// ---------- integration: real manager accept/reject flow ----------
{
  const mgr = new MultiplayerManager("tester", 0xffffff)
  const H = (m: unknown) =>
    (
      mgr as unknown as { handleStatePacket(p: unknown, id: string): void }
    ).handleStatePacket(m, "peerX")
  const E = (m: unknown) =>
    (
      mgr as unknown as { handleNetworkEvent(p: unknown, id: string): void }
    ).handleNetworkEvent(m, "peerX")
  const prog = () => mgr.peers.get("peerX")?.progress

  H(makePkt({ id: "peerX", sess: "A", seq: 0, progress: 100 }))
  check("I seq0 applied", prog() === 100, prog())
  H(makePkt({ id: "peerX", sess: "A", seq: 0, progress: 500 }))
  check("I dup cannot move state", prog() === 100, prog())
  H(makePkt({ id: "peerX", sess: "A", seq: 5, progress: 200 }))
  check("I seq5 applied", prog() === 200, prog())
  H(makePkt({ id: "peerX", sess: "A", seq: 3, progress: 999 }))
  check("I stale cannot move state back", prog() === 200, prog())
  H(makePkt({ id: "peerX", sess: "A", seq: 6, x: NaN, progress: 777 }))
  check("I invalid cannot move state", prog() === 200, prog())
  // Rejoin: HELLO(B) then seq restarts at 0.
  E({
    type: "HELLO",
    senderId: "peerX",
    t: Date.now(),
    payload: { name: "X", color: 1, session: "B" },
  })
  H(makePkt({ id: "peerX", sess: "B", seq: 0, progress: 10 }))
  check("I rejoin accepted", prog() === 10, prog())
  H(makePkt({ id: "peerX", sess: "A", seq: 99, progress: 31337 }))
  check("I old session cannot resurrect", prog() === 10, prog())
  // LAN wire format through the same path.
  H(
    JSON.parse(
      JSON.stringify(makePkt({ id: "peerX", sess: "B", seq: 1, progress: 11 })),
    ),
  )
  check("I LAN format accepted", prog() === 11, prog())
  const snap = getNetDiagSnapshot().peers["peerX"]
  check(
    "I diag tracked",
    !!snap &&
      snap.recv === 7 &&
      snap.dups === 1 &&
      snap.ooo === 2 &&
      snap.gaps === 4 &&
      snap.invalid === 1 &&
      snap.lastSeq === 1,
    snap,
  )
  mgr.leave()
}

// ---------- integration: real RemoteCar applies atomically, arrival clock ----------
{
  const R = await initPhysics()
  const world = createWorld()
  const scene = new THREE.Scene()
  const car = new RemoteCar("p", "n", 0xffffff, scene, "./", world, R)
  const r = validateStatePacket(
    makePkt({ qx: 2, qy: 0, qz: 0, qw: 0, t: 9e12, x: 33 }),
  )
  check("R validates", r.ok === true)
  if (r.ok) {
    // Phase 3: onPacket buffers; the target materializes in drive().
    const arrival = performance.now()
    car.onPacket(r.state, arrival)
    check(
      "R arrival clock wins",
      car.lastPacketTime === arrival,
      car.lastPacketTime,
    )
    check("R target pending until drive", car.hasReceivedPacket === true)
    car.drive(1 / 120)
    check("R pos applied", car.targetPos.x === 33, car.targetPos.x)
    check(
      "R quat normalized",
      Math.abs(car.targetQuat.x - 1) < 1e-9,
      car.targetQuat,
    )
    check("R received flag", car.hasReceivedPacket === true)
  }
  car.dispose(scene, world)
  world.free()
}

console.log(`\n${passes} passed, ${failures} failed`)
process.exit(failures ? 1 : 0)
