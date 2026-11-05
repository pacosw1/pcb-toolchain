import { useEffect, useRef, useState } from 'react'
import type { SchematicExport } from '../../shared/inspector'

export function SchematicView({ pcb }: { pcb: string }): React.JSX.Element {
  const [data, setData] = useState<SchematicExport | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(true)
  const [refresh, setRefresh] = useState(0)
  const [sheet, setSheet] = useState(0)
  const viewport = useRef<HTMLDivElement>(null), picture = useRef<HTMLImageElement>(null), zoomLabel = useRef<HTMLSpanElement>(null)
  const pose = useRef({ scale: 1, x: 0, y: 0 })
  const frame = useRef(0), settle = useRef<ReturnType<typeof setTimeout> | null>(null)
  const drag = useRef<{ x: number; y: number; ox: number; oy: number } | null>(null)
  // Keep pointer/wheel traffic out of React reconciliation. One compositor transform per frame.
  const paint = (): void => {
    if (picture.current) picture.current.style.willChange = 'transform'
    if (!frame.current) frame.current = requestAnimationFrame(() => {
      frame.current = 0
      const p = pose.current
      if (picture.current) picture.current.style.transform = `translate3d(${p.x}px, ${p.y}px, 0) scale(${p.scale})`
      if (zoomLabel.current) zoomLabel.current.textContent = `${Math.round(p.scale * 100)}%`
    })
    if (settle.current) clearTimeout(settle.current)
    // Let Chromium rasterize SVG at the final scale once the gesture settles.
    settle.current = setTimeout(() => { if (picture.current) picture.current.style.willChange = 'auto' }, 180)
  }
  const fit = (): void => { pose.current = { scale: 1, x: 0, y: 0 }; drag.current = null; paint() }
  const zoom = (factor: number, x = 0, y = 0): void => {
    const p = pose.current, next = Math.min(16, Math.max(0.25, p.scale * factor)), ratio = next / p.scale
    pose.current = { scale: next, x: x - (x - p.x) * ratio, y: y - (y - p.y) * ratio }; paint()
  }
  useEffect(() => {
    let active = true
    setBusy(true); setError(null); setData(null); setSheet(0); fit()
    window.api.boardSchematic(pcb).then(result => { if (active) setData(result) })
      .catch(e => { if (active) setError(String(e)) }).finally(() => { if (active) setBusy(false) })
    return () => { active = false }
  }, [pcb, refresh]) // eslint-disable-line react-hooks/exhaustive-deps
  const current = data?.sheets[sheet]
  useEffect(() => {
    const el = viewport.current
    if (!el || !current) return
    const wheel = (event: WheelEvent): void => {
      event.preventDefault()
      const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? el.clientHeight : 1
      if (event.ctrlKey || event.metaKey) {
        const box = el.getBoundingClientRect()
        zoom(Math.exp(-Math.max(-120, Math.min(120, event.deltaY * unit)) * 0.007), event.clientX - box.left - box.width / 2, event.clientY - box.top - box.height / 2)
      } else {
        pose.current.x -= event.deltaX * unit; pose.current.y -= event.deltaY * unit; paint()
      }
    }
    el.addEventListener('wheel', wheel, { passive: false })
    return () => el.removeEventListener('wheel', wheel)
  }, [current?.path]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => { cancelAnimationFrame(frame.current); if (settle.current) clearTimeout(settle.current) }, [])
  return <section className="boardview schematic-view" aria-label="Schematic viewer">
    <div className="boardview-bar">
      <label htmlFor="schematic-sheet">Sheet</label>
      <select id="schematic-sheet" value={sheet} disabled={!data} onChange={e => { setSheet(Number(e.target.value)); fit() }}>
        {data?.sheets.map((item, i) => <option value={i} key={item.path}>{item.name}</option>)}
      </select>
      <button type="button" onClick={() => zoom(1 / 1.25)} aria-label="Zoom out schematic" disabled={!current}>−</button>
      <span ref={zoomLabel} aria-label="Schematic zoom" className="schematic-zoom">100%</span>
      <button type="button" onClick={() => zoom(1.25)} aria-label="Zoom in schematic" disabled={!current}>+</button>
      <button type="button" onClick={fit} disabled={!current}>Fit sheet</button>
      <button type="button" onClick={() => setRefresh(n => n + 1)} disabled={busy}>Refresh schematic</button>
      <span style={{ flex: '1 1 auto' }} />
      <span className="schematic-hint">Scroll to pan · Pinch or Ctrl+scroll to zoom</span>
    </div>
    <div ref={viewport} className="schematic-canvas" tabIndex={0} aria-label="Schematic pan and zoom"
      onPointerDown={event => {
        if (!current || event.button !== 0) return
        event.preventDefault(); event.currentTarget.focus({ preventScroll: true }); event.currentTarget.setPointerCapture(event.pointerId)
        drag.current = { x: event.clientX, y: event.clientY, ox: pose.current.x, oy: pose.current.y }
      }}
      onPointerMove={event => { const start = drag.current; if (start) { pose.current.x = start.ox + event.clientX - start.x; pose.current.y = start.oy + event.clientY - start.y; paint() } }}
      onPointerUp={() => { drag.current = null }} onPointerCancel={() => { drag.current = null }} onLostPointerCapture={() => { drag.current = null }}
      onKeyDown={event => {
        if (event.key === '+' || event.key === '=') { event.preventDefault(); zoom(1.25) }
        else if (event.key === '-') { event.preventDefault(); zoom(1 / 1.25) }
        else if (event.key.toLowerCase() === 'f') fit()
        else if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) {
          event.preventDefault(); pose.current.x += event.key === 'ArrowLeft' ? 40 : event.key === 'ArrowRight' ? -40 : 0
          pose.current.y += event.key === 'ArrowUp' ? 40 : event.key === 'ArrowDown' ? -40 : 0; paint()
        }
      }}>
      {busy ? <p role="status" className="schematic-message">Rendering schematic with KiCad…</p> : null}
      {error ? <p role="alert" className="schematic-message">{error}</p> : null}
      {current ? <img ref={picture} key={current.path} src={window.api.fileUrl(current.path)} alt={`Schematic ${current.name}`} draggable={false}
        className="schematic-sheet" onLoad={paint} /> : null}
    </div>
    {data ? <div className="schematic-source">{data.source} · {data.sheets.length} sheet(s) · Saved schematic</div> : null}
  </section>
}
