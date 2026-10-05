import React, { useEffect, useRef } from 'react';
import type { CarTelemetry } from '../systems/CarController';
import { CAR_PHYSICS } from '../constants/physics';

const REDLINE = CAR_PHYSICS.engine.redlineRPM;
const MAX_RPM = 8000;
const MAX_KMH = 340;

function angleFor(frac: number) {
  return -120 + Math.max(0, Math.min(1, frac)) * 240;
}
function polar(cx: number, cy: number, r: number, deg: number) {
  const a = ((deg - 90) * Math.PI) / 180;
  return { x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) };
}

interface GaugeRefs {
  needleRef: { current: SVGGElement | null };
  numRef: { current: SVGTextElement | null };
}

function Dial({ title, unit, maxLabel, redFrom, children, refs }: {
  title: string;
  unit: string;
  maxLabel: number;
  redFrom: number; // fraction where red zone starts
  children: React.ReactNode;
  refs: GaugeRefs;
}) {
  const CX = 100, CY = 96, CR = 74;
  const ticks: React.ReactNode[] = [];
  const steps = maxLabel <= 10 ? maxLabel * 2 : 34;
  for (let i = 0; i <= steps; i++) {
    const frac = i / steps;
    const a = angleFor(frac);
    const major = maxLabel <= 10 ? i % 2 === 0 : i % 4 === 0;
    const p1 = polar(CX, CY, CR, a);
    const p2 = polar(CX, CY, CR - (major ? 13 : 7), a);
    const red = frac >= redFrom;
    ticks.push(
      <line key={i} x1={p1.x} y1={p1.y} x2={p2.x} y2={p2.y}
        stroke={red ? '#ef2b2b' : 'rgba(255,255,255,0.75)'} strokeWidth={major ? 3 : 1.4} />
    );
    if (major) {
      const pt = polar(CX, CY, CR - 24, a);
      const val = Math.round(frac * maxLabel);
      ticks.push(
        <text key={'t' + i} x={pt.x} y={pt.y + 4} textAnchor="middle" fontSize="10.5"
          fill={red ? '#ff6b6b' : '#d4d9e0'} fontFamily="monospace" fontWeight="bold">{val}</text>
      );
    }
  }
  const r0 = polar(CX, CY, CR - 2, angleFor(redFrom));
  const r1 = polar(CX, CY, CR - 2, angleFor(1));
  const tip = polar(CX, CY, CR - 8, 0);
  const tail = polar(CX, CY, 11, 180);
  return (
    <svg width="158" height="111" viewBox="0 0 200 140">
      <path d={`M ${r0.x} ${r0.y} A ${CR - 2} ${CR - 2} 0 0 1 ${r1.x} ${r1.y}`} fill="none"
        stroke="#ef2b2b" strokeWidth="5" opacity="0.9" />
      {ticks}
      <text x={CX} y={CY - 4} textAnchor="middle" fontSize="9.5" fill="#8b93a1" fontFamily="monospace" letterSpacing="2">{title}</text>
      <text ref={refs.numRef} x={CX} y={CY + 32} textAnchor="middle" fontSize="21" fill="#fff"
        fontFamily="monospace" fontWeight="bold">0</text>
      <text x={CX} y={CY + 44} textAnchor="middle" fontSize="8.5" fill="#8b93a1" fontFamily="monospace" letterSpacing="2">{unit}</text>
      <g ref={refs.needleRef}>
        <line x1={tail.x} y1={tail.y} x2={tip.x} y2={tip.y} stroke="#ffcf3b"
          strokeWidth="3.5" strokeLinecap="round" />
        <circle cx={CX} cy={CY} r="7.5" fill="#1a1d23" stroke="#4a5160" strokeWidth="2" />
        {children}
      </g>
    </svg>
  );
}

export default function Dashboard({ tele }: { tele: CarTelemetry }) {
  const teleRef = useRef(tele);
  teleRef.current = tele;
  const spdNeedle = useRef<SVGGElement | null>(null);
  const spdNum = useRef<SVGTextElement | null>(null);
  const rpmNeedle = useRef<SVGGElement | null>(null);
  const rpmNum = useRef<SVGTextElement | null>(null);

  // 60fps gauge smoothing: lerp displayed values toward the 20Hz telemetry,
  // write straight to the DOM (no re-renders) for butter-smooth needles.
  useEffect(() => {
    let raf = 0;
    let last = performance.now();
    let dRpm = 0, dKmh = 0;
    const loop = (now: number) => {
      raf = requestAnimationFrame(loop);
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      const t = teleRef.current;
      dRpm += (t.rpm - dRpm) * (1 - Math.exp(-dt * 14));
      dKmh += (Math.abs(t.speedKmh) - dKmh) * (1 - Math.exp(-dt * 10));
      if (rpmNeedle.current) {
        rpmNeedle.current.setAttribute('transform', `rotate(${angleFor(dRpm / MAX_RPM)} 100 96)`);
        const line = rpmNeedle.current.querySelector('line');
        if (line) line.setAttribute('stroke', dRpm >= REDLINE ? '#ff3b3b' : '#ffcf3b');
      }
      if (spdNeedle.current) {
        spdNeedle.current.setAttribute('transform', `rotate(${angleFor(dKmh / MAX_KMH)} 100 96)`);
      }
      if (rpmNum.current) {
        rpmNum.current.textContent = (dRpm / 1000).toFixed(1);
        rpmNum.current.setAttribute('fill', dRpm >= REDLINE ? '#ff5b5b' : '#fff');
      }
      if (spdNum.current) spdNum.current.textContent = String(Math.round(dKmh));
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, []);

  const launching = tele.launchArmed || tele.launching;

  return (
    <div className="pointer-events-none absolute inset-0 select-none" style={{ fontFamily: 'monospace' }}>
      {/* launch banner */}
      {launching && (
        <div className="absolute top-8 left-1/2 -translate-x-1/2 animate-pulse rounded-xl border-2 border-red-500 bg-red-950/85 px-8 py-2 shadow-[0_0_40px_rgba(239,43,43,0.7)]">
          <div className="text-center text-2xl font-black tracking-[0.25em] text-red-400">
            {tele.launching ? 'LAUNCH!' : 'LAUNCH CONTROL'}
          </div>
          {!tele.launching && (
            <div className="text-center text-[11px] tracking-widest text-red-200">RELEASE S TO LAUNCH</div>
          )}
        </div>
      )}

      {/* bottom-center cluster: speed | gear | tacho.
          Kept deliberately small and pushed into the corners: at full size it
          overlapped the car and hid the lower half of the body. */}
      <div className="absolute bottom-3 left-1/2 -translate-x-1/2 flex items-stretch gap-2">
        <div className="rounded-2xl bg-zinc-950/70 backdrop-blur border border-white/10 px-1.5 py-1 shadow-2xl">
          <Dial title="SPEED" unit="KM/H" maxLabel={MAX_KMH} redFrom={2} refs={{ needleRef: spdNeedle, numRef: spdNum }}>
            <></>
          </Dial>
        </div>

        {/* center: current gear only */}
        <div className="flex w-[74px] flex-col items-center justify-center gap-1 rounded-2xl bg-zinc-950/70 backdrop-blur border border-white/10 px-1.5 py-1.5 shadow-2xl">
          <div
            className={`flex h-14 w-14 items-center justify-center rounded-lg border-2 text-4xl font-black
              ${tele.gearLabel === 'R' ? 'border-red-500 bg-red-950/60 text-red-400'
                : tele.gearLabel === 'N' ? 'border-amber-500 bg-amber-950/60 text-amber-400'
                : 'border-emerald-500/70 bg-emerald-950/60 text-emerald-300'}`}
            style={{ textShadow: '0 0 18px currentColor' }}
          >
            {tele.gearLabel}
          </div>
          <div className={`rounded px-2 py-0.5 text-[10px] font-bold tracking-widest border
            ${tele.autoMode ? 'bg-sky-600 border-sky-400 text-white' : 'bg-zinc-800 border-white/20 text-gray-300'}`}>
            {tele.autoMode ? 'AUTO' : 'MANUAL'}
          </div>
          <div className="flex gap-1 text-[9px] font-bold">
            {tele.parkingBrake && <span className="rounded border border-orange-400/70 bg-orange-950/70 px-1.5 py-0.5 text-orange-300">PARK</span>}
            {tele.drift && <span className="rounded border border-purple-400 bg-purple-900/80 px-1.5 py-0.5 text-purple-200">DRIFT</span>}
          </div>
        </div>

        <div className="rounded-2xl bg-zinc-950/70 backdrop-blur border border-white/10 px-1.5 py-1 shadow-2xl">
          <Dial title="RPM" unit="X1000" maxLabel={8} redFrom={REDLINE / MAX_RPM} refs={{ needleRef: rpmNeedle, numRef: rpmNum }}>
            <></>
          </Dial>
        </div>
      </div>
    </div>
  );
}
