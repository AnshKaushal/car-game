/**
 * Screen-edge speed streaks.
 *
 * PERFORMANCE NOTE: this is deliberately NOT an SVG. A masked, blended,
 * non-scaling-stroke SVG re-rasterizes the whole viewport whenever its opacity
 * changes (every frame), which measurably stutters the render loop. Instead
 * each streak is a plain div whose animation touches ONLY `transform` and
 * `opacity`, so it stays on the GPU compositor and never repaints.
 *
 * Driven imperatively at 60fps by writing opacity / a CSS var on the root
 * element (no React re-renders). Only the screen EDGES are affected, so the car
 * and road ahead stay crisp — this is what sells high speed without touching
 * the camera.
 */
import { forwardRef } from 'react';

const RAY_COUNT = 20;
// radius the streak flies from / to, in vh from the screen centre
const TRAVEL_FROM = 28;
const TRAVEL_TO = 92;

interface Ray {
  a: number;
  w: number;
  dur: number;
  delay: number;
}

const RAYS: Ray[] = Array.from({ length: RAY_COUNT }, (_, i) => ({
  // deterministic pseudo-random angle / width / cadence per streak
  a: (i / RAY_COUNT) * 360 + Math.sin(i * 12.9898) * 14,
  w: 2 + (Math.sin(i * 43.7) * 0.5 + 0.5) * 5,
  dur: 0.5 + (Math.sin(i * 21.7) * 0.5 + 0.5) * 0.45,
  delay: -((i * 0.137) % 1),
}));

// one keyframe rule per ray (static, parsed once). Only transform animates,
// so the browser never has to repaint the overlay.
const CSS = `
.sl-root{position:absolute;inset:0;overflow:hidden;pointer-events:none;
  contain:strict;opacity:0;will-change:opacity;
  transform:scale(var(--sl-spread,1));transform-origin:50% 50%;}
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
100%{transform:rotate(${r.a}deg) translateY(${TRAVEL_TO}vh) scaleY(1.15)}}`
).join('\n')}
`;

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
                '--w': `${r.w}px`,
                '--dur': `${r.dur}s`,
                '--delay': `${r.delay}s`,
                animationName: `sl-${i}`,
              } as React.CSSProperties
            }
          />
        ))}
        {/* subtle edge vignette to reinforce peripheral motion */}
        <div className="sl-vig" />
      </div>
    </>
  );
});

SpeedLines.displayName = 'SpeedLines';