// Datasheets of the open board's parts, shown in Chromium's PDF viewer through pcbfile:// (project files only).
import { useEffect, useState } from 'react'
import type { Bom, BomLine } from './types'

export function DatasheetView({ bom, initial }: { bom: Bom; initial: BomLine | null }): React.JSX.Element {
  const docs = bom.lines.filter((l) => l.datasheet || l.datasheet_url)
  const [cur, setCur] = useState<BomLine | null>(initial ?? docs[0] ?? null)
  const [url, setUrl] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => setCur(initial ?? docs[0] ?? null), [initial]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    setUrl(null)
    setErr(null)
    if (!cur?.datasheet) return
    window.api.engine
      .call('file.resolve', { path: cur.datasheet })
      .then((r) => setUrl('pcbfile://local' + encodeURI((r as { path: string }).path)))
      .catch((e) => setErr(String(e)))
  }, [cur])

  return (
    <div className="dsview">
      <nav className="panel dslist" aria-label="Datasheets">
        <h2>Datasheets ({docs.length})</h2>
        {docs.map((l) => (
          <button key={l.refs[0]} type="button" className={cur === l ? 'rev on' : 'rev'} onClick={() => setCur(l)}>
            <span>{l.mpn ?? l.value}</span>
            <span style={{ color: 'var(--dim)', fontSize: 11 }}>
              {l.refs.slice(0, 3).join(', ')}
              {l.refs.length > 3 ? '…' : ''} · {l.lcsc ?? '—'}
              {l.datasheet ? '' : ' · web'}
            </span>
          </button>
        ))}
      </nav>
      <section className="dsdoc" aria-label="Datasheet">
        {!cur ? (
          <div className="placeholder">No datasheets for this board.</div>
        ) : cur.datasheet ? (
          url ? (
            <iframe title={`Datasheet ${cur.mpn ?? cur.value}`} src={url} />
          ) : (
            <div className="placeholder">{err ?? 'Loading…'}</div>
          )
        ) : (
          <div className="placeholder" style={{ flexDirection: 'column', gap: 12 }}>
            <span>No local PDF in the registry for {cur.lcsc ?? cur.value}.</span>
            {cur.datasheet_url ? (
              <button type="button" onClick={() => window.api.openExternal(cur.datasheet_url!)}>
                Open the web datasheet
              </button>
            ) : null}
          </div>
        )}
      </section>
    </div>
  )
}
