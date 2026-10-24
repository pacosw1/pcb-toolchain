// Board selector: one button for the current board; a searchable popover grouped by lifecycle.
import { useEffect, useMemo, useRef, useState } from 'react'
import type { Board } from './types'

const GROUP_ORDER = ['active', 'planned', 'unregistered', 'historical']

function bestRevision(b: Board): string | null {
  const withPcb = b.revisions.filter((r) => r.pcb)
  const current = withPcb.filter((r) => r.state !== 'superseded')
  return (current[current.length - 1] ?? withPcb[withPcb.length - 1])?.pcb ?? null
}

export function BoardPicker({
  boards,
  current,
  onPick
}: {
  boards: Board[]
  current: Board | null
  onPick: (board: Board, pcb: string | null) => void
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [q, setQ] = useState('')
  const box = useRef<HTMLDivElement>(null)
  const input = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!open) return
    input.current?.focus()
    const close = (e: MouseEvent): void => {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false)
    }
    window.addEventListener('mousedown', close)
    return () => window.removeEventListener('mousedown', close)
  }, [open])

  const groups = useMemo(() => {
    const k = q.trim().toLowerCase()
    const hit = boards.filter((b) => !k || b.id.toLowerCase().includes(k) || b.lifecycle.toLowerCase().includes(k))
    const by = new Map<string, Board[]>()
    for (const b of hit) by.set(b.lifecycle, [...(by.get(b.lifecycle) ?? []), b])
    return [...by.entries()].sort(
      (a, b) => (GROUP_ORDER.indexOf(a[0]) + 99) % 99 - ((GROUP_ORDER.indexOf(b[0]) + 99) % 99) || a[0].localeCompare(b[0])
    )
  }, [boards, q])

  const pick = (b: Board): void => {
    onPick(b, bestRevision(b))
    setOpen(false)
    setQ('')
  }

  return (
    <div className="picker" ref={box}>
      <button
        type="button"
        className="picker-button"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label="Choose board"
        onClick={() => setOpen((o) => !o)}
      >
        <span className="picker-name">{current?.id ?? 'Choose a board'}</span>
        <span className="picker-sub">
          {current
            ? `${current.lifecycle} · ${current.revisions.filter((r) => r.pcb).length} revision${current.revisions.filter((r) => r.pcb).length === 1 ? '' : 's'}`
            : `${boards.length} boards`}
        </span>
        <span aria-hidden="true" className="chev">
          ▾
        </span>
      </button>
      {open ? (
        <div className="picker-pop" role="dialog" aria-label="Boards">
          <input
            ref={input}
            type="search"
            placeholder="Search boards…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') setOpen(false)
              if (e.key === 'Enter') {
                const first = groups[0]?.[1][0]
                if (first) pick(first)
              }
            }}
          />
          <div className="picker-list" role="listbox" aria-label="Board list">
            {groups.map(([life, bs]) => (
              <div key={life}>
                <div className="picker-group">{life}</div>
                {bs.map((b) => (
                  <button
                    key={b.directory}
                    type="button"
                    role="option"
                    aria-selected={b === current}
                    className={b === current ? 'picker-item on' : 'picker-item'}
                    onClick={() => pick(b)}
                  >
                    <span>{b.id}</span>
                    <span className="picker-revs">
                      {b.revisions.filter((r) => r.pcb).length || 'no'} rev
                    </span>
                  </button>
                ))}
              </div>
            ))}
            {groups.length === 0 ? <div className="picker-group">No match</div> : null}
          </div>
        </div>
      ) : null}
    </div>
  )
}
