import { forwardRef } from "react"

const RAY_COUNT = 20
const TRAVEL_FROM = 28
const TRAVEL_TO = 92

interface Ray {
  a: number
  w: number
  dur: number
  delay: number
}

const RAYS: Ray[] = Array.from({ length: RAY_COUNT }, (_, i) => ({
  a: (i / RAY_COUNT) * 360 + Math.sin(i * 12.9898) * 14,
  w: 2 + (Math.sin(i * 43.7) * 0.5 + 0.5) * 5,
  dur: 0.5 + (Math.sin(i * 21.7) * 0.5 + 0.5) * 0.45,
  delay: -((i * 0.137) % 1),
}))

const CSS = `
.sl-root{position:absolute;inset:0;overflow:hidden;pointer-events:none;
  contain:strict;opacity:0;will-change:opacity;}
.sl-ray{position:absolute;left:50%;top:50%;height:${TRAVEL_TO + 8}vh;
  margin-left:calc(var(--w) / -2);width:var(--w);transform-origin:50% 0;
  background:linear-gradient(to bottom,rgba(255,255,255,0) 0%,rgba(255,255,255,.42) 42%,rgba(255,255,255,0) 100%);
  will-change:transform,opacity;backface-visibility:hidden;
  animation-name:sl-fade;animation-duration:var(--dur);animation-delay:var(--delay);
  animation-iteration-count:infinite;animation-timing-function:linear;}
.sl-off .sl-ray{animation-play-state:paused;}
.sl-off{visibility:hidden;}
.sl-vig{position:absolute;inset:0;pointer-events:none;
  box-shadow:inset 0 0 130px 40px rgba(255,255,255,.07);}
@keyframes sl-fade{0%{opacity:0}8%{opacity:.85}70%{opacity:.5}100%{opacity:0}}
${RAYS.map(
  (r, i) =>
    `@keyframes sl-${i}{0%{transform:rotate(${r.a}deg) translateY(${TRAVEL_FROM}vh) scaleY(.5)}
100%{transform:rotate(${r.a}deg) translateY(${TRAVEL_TO}vh) scaleY(1.15)}}`,
).join("\n")}
`

export const SpeedLines = forwardRef<HTMLDivElement>((_props, ref) => {
  return (
    <>
      <style>{CSS}</style>
      <div ref={ref} aria-hidden className="sl-root sl-off">
        {RAYS.map((r, i) => (
          <span
            key={i}
            className="sl-ray"
            style={
              {
                "--w": `${r.w}px`,
                "--dur": `${r.dur}s`,
                "--delay": `${r.delay}s`,
                animationName: `sl-${i}`,
              } as React.CSSProperties
            }
          />
        ))}
        {}
        <div className="sl-vig" />
      </div>
    </>
  )
})

SpeedLines.displayName = "SpeedLines"
