// Parts / BOM for the open board: one line per part, joined with datasheet, CAD asset and verified-BOM status.
import { useMemo, useState } from 'react'
import type { Bom, BomLine } from './types'

const yes = <span style={{ color: 'var(--ok)' }}>✓</span>
const no = <span style={{ color: 'var(--warn)' }}>—</span>

export function PartsView({
  bom,
  onDatasheet,
  onShowRef
}: {
  bom: Bom
  onDatasheet: (line: BomLine) => void
  onShowRef: (ref: string) => void
}): React.JSX.Element {
  const [q, setQ] = useState('')
  const [sel, setSel] = useState<BomLine | null>(null)
  const rows = useMemo(() => {
    const k = q.trim().toLowerCase()
    if (!k) return bom.lines
    return bom.lines.filter((l) =>
      [l.refs.join(' '), l.value, l.lcsc, l.mpn, l.manufacturer, l.footprint].join(' ').toLowerCase().includes(k)
    )
  }, [bom, q])
  const s = bom.summary

  return (
    <div className="partsview">
      <div className="parts-head">
        <span>
          <strong>{s.refs}</strong> parts · <strong>{s.lines}</strong> lines
          {s.dnp_refs ? ` · ${s.dnp_refs} DNP` : ''}
        </span>
        <span className={s.missing_lcsc ? 'warn' : 'okc'}>{s.missing_lcsc} without C-number</span>
        <span className={s.missing_datasheet ? 'warn' : 'okc'}>{s.missing_datasheet} without local datasheet</span>
        <span className={s.missing_cad_asset ? 'warn' : 'okc'}>{s.missing_cad_asset} without CAD asset</span>
        <span style={{ flex: '1 1 auto' }} />
        <label htmlFor="parts-filter" style={{ color: 'var(--dim)', fontSize: 12 }}>
          Filter
        </label>
        <input id="parts-filter" type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="ref, value, C-number" />
      </div>
      <div className="parts-body">
        <div className="tablewrap">
          <table>
            <thead>
              <tr>
                <th scope="col">Refs</th>
                <th scope="col">Qty</th>
                <th scope="col">Value</th>
                <th scope="col">C-number</th>
                <th scope="col">MPN</th>
                <th scope="col">Asm</th>
                <th scope="col">Datasheet</th>
                <th scope="col">CAD</th>
                <th scope="col">Stock / assembly</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((l) => (
                <tr
                  key={l.refs[0]}
                  className={sel === l ? 'on' : l.dnp ? 'dnp' : ''}
                  onClick={() => setSel(l)}
                  aria-selected={sel === l}
                >
                  <td className="mono">
                    <button type="button" className="linkish" onClick={() => setSel(l)}>
                      {l.refs.length > 4 ? `${l.refs.slice(0, 4).join(', ')} +${l.refs.length - 4}` : l.refs.join(', ')}
                    </button>
                  </td>
                  <td>{l.qty}</td>
                  <td>
                    {l.value}
                    {l.dnp ? <span className="tag">DNP</span> : null}
                  </td>
                  <td className="mono">{l.lcsc ?? no}</td>
                  <td>{l.mpn ?? '—'}</td>
                  <td>{l.assembly}</td>
                  <td>{l.datasheet ? yes : l.datasheet_url ? <span style={{ color: 'var(--dim)' }}>web</span> : no}</td>
                  <td>{l.cad_asset ? yes : no}</td>
                  <td style={{ color: 'var(--muted)' }}>
                    {[l.stock_status, l.assembly_status].filter(Boolean).join(' · ') || '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {sel ? (
          <aside className="panel partdetail" aria-label="Part details">
            <h3 className="mono">{sel.refs.join(', ')}</h3>
            <div style={{ color: 'var(--muted)' }}>{sel.description ?? sel.value}</div>
            <dl className="kv">
              <dt>Value</dt>
              <dd>{sel.value}</dd>
              <dt>C-number</dt>
              <dd>{sel.lcsc ?? '—'}</dd>
              <dt>MPN</dt>
              <dd>{sel.mpn ?? '—'}</dd>
              <dt>Manufacturer</dt>
              <dd>{sel.manufacturer ?? '—'}</dd>
              <dt>Footprint</dt>
              <dd>{sel.footprint}</dd>
              <dt>Assembly</dt>
              <dd>{sel.assembly}</dd>
            </dl>
            <div className="row">
              <button type="button" disabled={!sel.datasheet && !sel.datasheet_url} onClick={() => onDatasheet(sel)}>
                Open datasheet
              </button>
              <button type="button" onClick={() => onShowRef(sel.refs[0])}>
                Show on board
              </button>
            </div>
          </aside>
        ) : null}
      </div>
    </div>
  )
}
