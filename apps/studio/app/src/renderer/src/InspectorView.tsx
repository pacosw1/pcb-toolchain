import { useEffect, useRef, useState } from 'react'
import type { BoardInspection, InspectorSection, NativeInventory } from '../../shared/inspector'

const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
const label = (key: string): string => key.replaceAll('_', ' ').replace(/^./, c => c.toUpperCase())
const display = (value: unknown): string => typeof value === 'string' || typeof value === 'number' ? String(value) : typeof value === 'boolean' ? value ? 'Yes' : 'No' : 'Not specified'
function Status({ section }: { section: InspectorSection<unknown> }): React.JSX.Element | null {
  return section.state === 'ready' ? null : <p role={section.state === 'error' ? 'alert' : 'status'}>{section.message}</p>
}

export function InspectorView({ pcb }: { pcb: string }): React.JSX.Element {
  const inventorySeq = useRef(0)
  const [inventory, setInventory] = useState<NativeInventory | null>(null)
  const [inventoryError, setInventoryError] = useState<string | null>(null)
  const [readingInventory, setReadingInventory] = useState(false)
  const [data, setData] = useState<BoardInspection | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [refresh, setRefresh] = useState(0)
  const [busy, setBusy] = useState(true)
  useEffect(() => {
    inventorySeq.current++
    setInventory(null); setInventoryError(null); setReadingInventory(false)
    let active = true
    setBusy(true); setError(null); setData(null)
    window.api.engine.call('board.inspect', { pcb }).then(value => { if (active) setData(value as BoardInspection) })
      .catch(e => { if (active) setError(String(e)) }).finally(() => { if (active) setBusy(false) })
    return () => { active = false; inventorySeq.current++ }
  }, [pcb, refresh])
  const stats = object(data?.stats.data?.board)
  const layers = data?.stackup.data?.layers
  const rows = data?.bom.data ?? []
  return <section className="panel inspector" aria-label="Board specifications">
    <div className="inspector-heading"><div><h2>Board specifications</h2><p>Native KiCad data from a copy of the saved board.</p></div>
      <button type="button" disabled={busy} onClick={() => setRefresh(n => n + 1)}>Refresh specifications</button></div>
    {busy ? <p role="status">Reading board specifications…</p> : null}
    {error ? <p role="alert">{error}</p> : null}
    {data ? <>
      <p className="inspector-source">KiCad {data.runtime ?? 'unavailable'} · Captured {new Date(data.capturedAt).toLocaleTimeString()}<br />Board revision <code>{data.sourceSha256.slice(0, 16)}</code></p>
      <h3>Physical specifications</h3><Status section={data.stats} />
      {Object.keys(stats).length ? <dl className="inspector-facts">{Object.entries(stats).map(([key, value]) => <div key={key}><dt>{label(key)}</dt><dd>{display(value)}</dd></div>)}</dl> : null}
      <h3>Layer stackup</h3><Status section={data.stackup} />
      {Array.isArray(layers) ? <div className="inspector-table"><table><thead><tr><th>Layer</th><th>Material</th><th>Thickness (mm)</th></tr></thead><tbody>{layers.map((raw, i) => {
        const layer = object(raw), dielectric = object(layer.dielectric).layer
        const sub = Array.isArray(dielectric) ? object(dielectric[0]) : {}
        const nm = object(layer.thickness).valueNm
        const thickness = (typeof nm === 'string' && /^\d+$/.test(nm)) || typeof nm === 'number' ? Number(nm) / 1e6 : null
        return <tr key={i}><td>{display(layer.userName ?? (layer.type === 'BSLT_DIELECTRIC' ? 'Dielectric' : layer.layer))}</td><td>{display(layer.materialName ?? sub.materialName ?? object(layer.soldermask).materialName ?? object(layer.silkscreen).materialName)}</td><td>{thickness !== null && Number.isFinite(thickness) ? thickness : 'Not specified'}</td></tr>
      })}</tbody></table></div> : null}
      <h3>Native board BOM</h3><p>Saved footprint fields. Supplier evidence and datasheets are available in Parts / BOM. Prices are not included in this export.</p><Status section={data.bom} />
      {rows.length ? <div className="inspector-table"><table><thead><tr>{rows[0].map((cell, i) => <th key={i}>{cell}</th>)}</tr></thead><tbody>{rows.slice(1).filter(row => row.some(Boolean)).map((row, i) => <tr key={i}>{rows[0].map((_, j) => <td key={j}>{row[j] ?? ''}</td>)}</tr>)}</tbody></table></div> : null}
      <h3>Native document objects</h3><p>Read the saved PCB and its assigned schematic through KiCad's headless API. Counts include graphical and power symbols, not just purchasable parts.</p>
      <button type="button" disabled={readingInventory} onClick={() => {
        const seq = ++inventorySeq.current
        setReadingInventory(true); setInventoryError(null); setInventory(null)
        window.api.engine.call('board.inventory', { pcb }).then(result => { if (seq === inventorySeq.current) setInventory(result as NativeInventory) })
          .catch(error => { if (seq === inventorySeq.current) setInventoryError(String(error)) }).finally(() => { if (seq === inventorySeq.current) setReadingInventory(false) })
      }}>{readingInventory ? 'Reading native objects…' : 'Inspect native objects'}</button>
      {inventoryError ? <p role="alert">{inventoryError}</p> : null}
      {inventory ? <>{inventory.documents.map(doc => <div key={doc.path}><h4>{doc.kind === 'pcb' ? 'PCB' : 'Schematic'} · {doc.documents} document(s)</h4><p>{doc.path}<br />KiCad {doc.version}</p><dl className="inspector-facts">{Object.entries(doc.counts).map(([type, count]) => <div key={type}><dt>{type.replace(/([a-z])([A-Z])/g, '$1 $2')}</dt><dd>{count}</dd></div>)}</dl></div>)}<details><summary>Inspected source revisions</summary><pre>{JSON.stringify(inventory.sources, null, 2)}</pre></details></> : null}
      <details><summary>Structured source data</summary><pre>{JSON.stringify({ stats: data.stats.data, stackup: data.stackup.data }, null, 2)}</pre></details>
    </> : null}
  </section>
}
