import { useEffect, useRef, useState } from "react"
import { createPortal } from "react-dom"
import { HexColorPicker } from "react-colorful"
import { PAINT_SWATCHES, hexToNumber, numberToHex } from "../systems/carTint"

export function PaintPicker({
  value,
  showStock,
  onPick,
}: {
  value: number | null
  showStock?: boolean
  onPick: (color: number | null) => void
}) {
  const [draft, setDraft] = useState<string | null>(null)
  const [open, setOpen] = useState(false)
  const [pos, setPos] = useState({ x: 0, y: 0, above: true })
  const dotRef = useRef<HTMLButtonElement | null>(null)
  useEffect(() => {
    setDraft(null)
  }, [value])
  useEffect(() => {
    if (draft === null) return
    const t = window.setTimeout(() => onPick(hexToNumber(draft)), 150)
    return () => window.clearTimeout(t)
  }, [draft])

  useEffect(() => {
    if (!open) return
    const close = () => setOpen(false)
    const onDown = (e: PointerEvent) => {
      const el = (e.target as HTMLElement).closest?.("[data-paint-pop]")
      if (!el) close()
    }
    window.addEventListener("pointerdown", onDown, true)
    window.addEventListener("scroll", close, true)
    window.addEventListener("resize", close)
    return () => {
      window.removeEventListener("pointerdown", onDown, true)
      window.removeEventListener("scroll", close, true)
      window.removeEventListener("resize", close)
    }
  }, [open])

  const swatches = showStock
    ? PAINT_SWATCHES
    : PAINT_SWATCHES.filter((p) => p.value !== null)
  const shown = draft ?? numberToHex(value ?? 0x000000)
  const isCustom = value !== null && !swatches.some((p) => p.value === value)

  const toggle = () => {
    if (open) {
      setOpen(false)
      return
    }
    const r = dotRef.current?.getBoundingClientRect()
    const w = 224
    const h = 268
    const vw = window.innerWidth
    const vh = window.innerHeight
    const x = Math.min(Math.max(8, (r?.left ?? vw / 2) - w / 2), vw - w - 8)
    const above = (r?.top ?? vh / 2) > h + 16
    const y = above
      ? Math.max(8, (r?.top ?? 0) - h - 10)
      : Math.min(vh - h - 8, (r?.bottom ?? 0) + 10)
    setPos({ x, y, above })
    setOpen(true)
  }

  return (
    <div>
      <div className="flex flex-wrap items-center gap-2">
        {swatches.map((p) => {
          const active = (value ?? null) === p.value
          return (
            <button
              key={p.name}
              type="button"
              onClick={() => {
                setDraft(null)
                setOpen(false)
                onPick(p.value)
              }}
              title={p.name === "Stock" ? "Stock GLB paint" : p.name}
              aria-label={p.name}
              className={`flex h-9 w-9 items-center justify-center border-2 transition active:scale-95 ${
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
                      background: numberToHex(p.value),
                    }
              }
            />
          )
        })}
        {}
        <button
          key="__custom"
          ref={dotRef}
          type="button"
          onClick={toggle}
          title="Custom color"
          aria-label="Custom color"
          aria-expanded={open}
          data-paint-pop
          className={`flex h-9 w-9 items-center justify-center border-2 border-dashed transition active:scale-95 ${
            open || isCustom || draft !== null
              ? "border-white"
              : "border-white/40 hover:border-white/70"
          }`}
          style={{ background: shown }}
        >
          <span className="text-[16px] leading-none text-white drop-shadow-[0_1px_2px_rgba(0,0,0,0.9)]">
            +
          </span>
        </button>
      </div>

      {}
      {open &&
        typeof document !== "undefined" &&
        createPortal(
          <div
            data-paint-pop
            className="paint-pop-in fixed z-[100]"
            style={{
              left: pos.x,
              top: pos.y,
              transformOrigin: pos.above ? "50% 100%" : "50% 0%",
            }}
          >
            <div className="rounded-2xl border border-white/15 bg-[#0b0e14]/95 p-3 shadow-[0_20px_60px_rgba(0,0,0,0.7)] backdrop-blur-md">
              <HexColorPicker color={shown} onChange={setDraft} />
              <div className="mt-2 flex items-center gap-2">
                <div
                  className="h-6 w-6 shrink-0 rounded-full border border-white/25"
                  style={{ background: shown }}
                />
                <div className="font-mono text-[12px] text-gray-200">
                  {shown.toUpperCase()}
                </div>
              </div>
            </div>
          </div>,
          document.body,
        )}
    </div>
  )
}
