import { useEffect, useRef, useState } from 'react'
import type { SchematicExport } from '../../shared/inspector'

export function SchematicView({ pcb }: { pcb: string }): React.JSX.Element {
  const [data, setData] = useState<SchematicExport | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(true)
  const [refresh, setRefresh] = useState(0)
  const [sheet, setSheet] = useState(0)
  const [scale, setScale] = useState(1)
  const [offset, setOffset] = useState({ x: 0, y: 0 })
  const drag = useRef<{ x: number; y: number; ox: number; oy: number } | null>(null)
  const fit = (): void => { setScale(1); setOffset({ x: 0, y: 0 }) }
  useEffect(() => {
    let active = true
    setBusy(true); setError(null); setData(null); setSheet(0); fit()
    window.api.boardSchematic(pcb).then(result => { if (active) setData(result) })
      .catch(e => { if (active) setError(String(e)) }).finally(() => { if (active) setBusy(false) })
    return () => { active = false }
  }, [pcb, refresh])
  const current = data?.sheets[sheet]
  const zoom = (factor: number): void => setScale(s => Math.min(12, Math.max(0.5, s * factor)))
  return <section className="boardview schematic-view" aria-label="Schematic viewer">
    <div className="boardview-bar">
      <label htmlFor="schematic-sheet">Sheet</label>
      <select id="schematic-sheet" value={sheet} disabled={!data} onChange={e => { setSheet(Number(e.target.value)); fit() }}>
        {data?.sheets.map((item, i) => <option value={i} key={item.path}>{item.name}</option>)}
      </select>
      <button type="button" onClick={() => zoom(1 / 1.25)} aria-label="Zoom out schematic" disabled={!current}>−</button>
      <span aria-label="Schematic zoom">{Math.round(scale * 100)}%</span>
      <button type="button" onClick={() => zoom(1.25)} aria-label="Zoom in schematic" disabled={!current}>+</button>
      <button type="button" onClick={fit} disabled={!current}>Fit sheet</button>
      <button type="button" onClick={() => setRefresh(n => n + 1)} disabled={busy}>Refresh schematic</button>
      <span style={{ flex: '1 1 auto' }} />
      <span style={{ color: 'var(--dim)', fontSize: 12 }}>Saved schematic · view only</span>
    </div>
    <div className="schematic-canvas" tabIndex={0} aria-label="Schematic pan and zoom"
      onWheel={event => {
        if (!current) return
        const factor = event.deltaY < 0 ? 1.12 : 1 / 1.12
        const box = event.currentTarget.getBoundingClientRect()
        const x = event.clientX - box.left - box.width / 2, y = event.clientY - box.top - box.height / 2
        const next = Math.min(12, Math.max(0.5, scale * factor)), ratio = next / scale
        setOffset(o => ({ x: x - (x - o.x) * ratio, y: y - (y - o.y) * ratio })); setScale(next)
      }}
      onPointerDown={event => {
        if (!current || event.button !== 0) return
        event.currentTarget.setPointerCapture(event.pointerId)
        drag.current = { x: event.clientX, y: event.clientY, ox: offset.x, oy: offset.y }
      }}
      onPointerMove={event => { const start = drag.current; if (start) setOffset({ x: start.ox + event.clientX - start.x, y: start.oy + event.clientY - start.y }) }}
      onPointerUp={() => { drag.current = null }} onPointerCancel={() => { drag.current = null }}
      onKeyDown={event => {
        if (event.key === '+' || event.key === '=') zoom(1.25)
        else if (event.key === '-') zoom(1 / 1.25)
        else if (event.key.toLowerCase() === 'f') fit()
        else if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) {
          event.preventDefault(); setOffset(o => ({ x: o.x + (event.key === 'ArrowLeft' ? 40 : event.key === 'ArrowRight' ? -40 : 0), y: o.y + (event.key === 'ArrowUp' ? 40 : event.key === 'ArrowDown' ? -40 : 0) }))
        }
      }}>
      {busy ? <p role="status" className="schematic-message">Rendering schematic with KiCad…</p> : null}
      {error ? <p role="alert" className="schematic-message">{error}</p> : null}
      {current ? <img key={current.path} src={window.api.fileUrl(current.path)} alt={`Schematic ${current.name}`} draggable={false}
        className="schematic-sheet" style={{ transform: `translate(${offset.x}px, ${offset.y}px) scale(${scale})` }} /> : null}
    </div>
    {data ? <div className="schematic-source">{data.source} · {data.sheets.length} sheet(s) · KiCad {data.runtime ?? 'unknown'}</div> : null}
  </section>
}
