import { useEffect, useRef, useState } from 'react'
import { BoardView } from './BoardView'
import { interpolatePlacement, placementGeometry, type Placement } from './livePlacement'
import type { Geometry } from './types'

/** Smoothly show changes between actual candidate snapshots; intermediate copper is hidden during movement. */
export function LiveBoard({ geo, identity, animate }: { geo: Geometry; identity: string; animate: boolean }): React.JSX.Element {
  const [shown, setShown] = useState(geo)
  const shownRef = useRef(geo)
  const identityRef = useRef(identity)
  useEffect(() => {
    const before = shownRef.current
    if (!animate || identityRef.current !== identity || window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
      identityRef.current = identity; shownRef.current = geo; setShown(geo); return
    }
    const nextByRef = new Map(geo.footprints.map(fp => [fp.ref, fp]))
    const units = before.footprints.flatMap(fp => {
      const next = nextByRef.get(fp.ref)
      if (!next) return []
      return [{ refs: [fp.ref], origin: [fp.x, fp.y] as [number, number], position: [next.x, next.y] as [number, number], turn: (next.rot - fp.rot) / 90 }]
    })
    if (!units.some(u => Math.abs(u.origin[0] - u.position[0]) > 0.001 || Math.abs(u.origin[1] - u.position[1]) > 0.001 || Math.abs(u.turn) > 0.001)) {
      shownRef.current = geo; setShown(geo); return
    }
    const target: Placement = { board_sha256: identity, epoch: 0, epochs: 0, cost: 0, units }
    let frame = 0
    const timer = setInterval(() => {
      frame++
      const display = frame >= 5 ? geo : placementGeometry(before, interpolatePlacement(null, target, frame / 5))
      shownRef.current = display; setShown(display)
      if (frame >= 5) clearInterval(timer)
    }, 50)
    return () => clearInterval(timer)
  }, [geo, identity, animate])
  return <BoardView geo={identityRef.current === identity ? shown : geo} liveRefresh />
}
