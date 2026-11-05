import { useEffect, useId, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { InspectorView } from './InspectorView'
import type { SpecDocument } from '../../shared/inspector'

// Brand proportions/layout adapted from iot-lab 2450d95c site/build.mjs specSheet
// and site/src/assets/sheet.css. Content always comes from this project's assigned spec.
function SpecBrand(): React.JSX.Element {
  const id = useId().replaceAll(':', '')
  return <div className="spec-brand" aria-label="SW Industries">
    <svg viewBox="0 0 120 48" aria-hidden="true"><defs><mask id={id}><rect width="120" height="48" fill="white" />
      <text x="65" y="36.5" textAnchor="middle" fontFamily="Impact, sans-serif" fontStyle="italic" fontSize="34" letterSpacing="-1" fill="black" transform="skewX(-12)">SW</text>
    </mask></defs><path d="M24 2H118L98 46H4Z" fill="currentColor" mask={`url(#${id})`} /><path d="M10 2h7L-3 46h-7Z" fill="currentColor" opacity=".45" /></svg><span>INDUSTRIES</span>
  </div>
}

export function SpecView({ pcb }: { pcb: string }): React.JSX.Element {
  const [mode, setMode] = useState<'document' | 'native'>('document')
  const [doc, setDoc] = useState<SpecDocument | null>(null), [error, setError] = useState<string | null>(null)
  const [refresh, setRefresh] = useState(0)
  useEffect(() => {
    let active = true
    setDoc(null); setError(null)
    window.api.engine.call('board.spec', { pcb }).then(result => { if (active) setDoc(result as SpecDocument) }).catch(e => { if (active) setError(String(e)) })
    return () => { active = false }
  }, [pcb, refresh])
  return <section className="spec-view" aria-label="Specification document">
    <div className="boardview-bar spec-toolbar">
      <button type="button" className={mode === 'document' ? 'toggle on' : 'toggle'} aria-pressed={mode === 'document'} onClick={() => setMode('document')}>Spec sheet</button>
      <button type="button" className={mode === 'native' ? 'toggle on' : 'toggle'} aria-pressed={mode === 'native'} onClick={() => setMode('native')}>Native board data</button>
      <span style={{ flex: '1 1 auto' }} />
      {mode === 'document' ? <><button type="button" onClick={() => setRefresh(n => n + 1)}>Refresh document</button>
        <button type="button" disabled={!doc || doc.format !== 'markdown'} onClick={() => window.print()}>Print / Save PDF</button></> : null}
    </div>
    {mode === 'native' ? <InspectorView pcb={pcb} /> : <div className="spec-reader">
      {error ? <div className="panel" role="alert">{error}</div> : !doc ? <p role="status">Loading specification…</p> : doc.format === 'pdf' ?
        <iframe className="spec-pdf" src={window.api.fileUrl(doc.path)} title={`${doc.board} specification PDF`} /> :
        <article className="spec-paper">
          <header className="spec-letterhead"><SpecBrand /><div className="spec-meta">BOARD REV {doc.revision ?? '—'}<br />{doc.state ?? 'Design specification'}</div></header>
          <div className="spec-title"><p className="spec-eyebrow">TECHNICAL SPECIFICATION</p><h1>{doc.board}</h1></div>
          <div className="spec-prose"><ReactMarkdown remarkPlugins={[remarkGfm]} skipHtml
            components={{
              a: ({ href, children }) => href && /^https?:\/\//.test(href) ? <a href={href} onClick={event => { event.preventDefault(); void window.api.openExternal(href) }}>{children}</a> : <span>{children}</span>,
              img: ({ alt }) => <span className="spec-image-note">{alt ? `Figure: ${alt}` : 'Figure referenced in source document'}</span>,
              table: ({ children }) => <div className="spec-table"><table>{children}</table></div>
            }}>{(doc.text ?? '').replace(/^#\s+[^\n]*\n/, '')}</ReactMarkdown></div>
          <footer className="spec-footer"><span>{doc.source}</span><span>Source {doc.sha256.slice(0, 12)}</span></footer>
        </article>}
    </div>}
  </section>
}
