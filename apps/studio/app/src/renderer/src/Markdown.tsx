// Small, safe Markdown renderer for chat answers: paragraphs, headings, lists, code blocks, inline code, bold,
// italic and links. Builds React elements (no innerHTML), so model output cannot inject markup.
import { Fragment, type ReactNode } from 'react'

function inline(text: string, key: string): ReactNode[] {
  const out: ReactNode[] = []
  const rx = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\*[^*\s][^*]*\*)|(\[[^\]]+\]\((https?:\/\/[^)\s]+)\))/g
  let last = 0
  let m: RegExpExecArray | null
  let i = 0
  while ((m = rx.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index))
    const k = `${key}-${i++}`
    if (m[1]) out.push(<code key={k}>{m[1].slice(1, -1)}</code>)
    else if (m[2]) out.push(<strong key={k}>{inline(m[2].slice(2, -2), k)}</strong>)
    else if (m[3]) out.push(<em key={k}>{inline(m[3].slice(1, -1), k)}</em>)
    else if (m[4]) {
      const label = m[4].slice(1, m[4].indexOf(']'))
      const href = m[5]
      out.push(
        <a key={k} href={href} onClick={(e) => (e.preventDefault(), void window.api.openExternal(href))}>
          {label}
        </a>
      )
    }
    last = m.index + m[0].length
  }
  if (last < text.length) out.push(text.slice(last))
  return out
}

export function Markdown({ text }: { text: string }): React.JSX.Element {
  const lines = text.replace(/\r\n/g, '\n').split('\n')
  const blocks: ReactNode[] = []
  let i = 0
  let n = 0
  while (i < lines.length) {
    const line = lines[i]
    const k = `b${n++}`
    if (/^```/.test(line)) {
      const body: string[] = []
      i++
      while (i < lines.length && !/^```/.test(lines[i])) body.push(lines[i++])
      i++
      blocks.push(<pre key={k} className="md-pre">{body.join('\n')}</pre>)
    } else if (/^#{1,4}\s/.test(line)) {
      blocks.push(<div key={k} className="md-h">{inline(line.replace(/^#+\s*/, ''), k)}</div>)
      i++
    } else if (/^\s*([-*]|\d+\.)\s+/.test(line)) {
      const ordered = /^\s*\d+\./.test(line)
      const items: ReactNode[] = []
      while (i < lines.length && /^\s*([-*]|\d+\.)\s+/.test(lines[i])) {
        items.push(<li key={`${k}-${items.length}`}>{inline(lines[i].replace(/^\s*([-*]|\d+\.)\s+/, ''), `${k}-${items.length}`)}</li>)
        i++
      }
      blocks.push(ordered ? <ol key={k}>{items}</ol> : <ul key={k}>{items}</ul>)
    } else if (!line.trim()) {
      i++
    } else {
      const para: string[] = []
      while (i < lines.length && lines[i].trim() && !/^(```|#{1,4}\s|\s*([-*]|\d+\.)\s+)/.test(lines[i])) para.push(lines[i++])
      blocks.push(
        <p key={k}>
          {para.map((p, j) => (
            <Fragment key={j}>
              {j ? <br /> : null}
              {inline(p, `${k}-${j}`)}
            </Fragment>
          ))}
        </p>
      )
    }
  }
  return <div className="md">{blocks}</div>
}
