// `migrate --project ROOT --out DIR`: one board.yaml per board from the legacy derivation (registry + gate configs +
// folders), a conflict report, and a round-trip check (re-read DIR -> the same boards). Port of
// engine/src/pcbstudio/migrate.py.
//
// DIR gets `<BOARD-DIR>/board.yaml` and `migrate-report.json`. With `--out <ROOT>/<boards_dir>` the files land in the
// project itself; the default flow writes elsewhere first and checks the round trip.
import { isDeepStrictEqual } from 'node:util'
import fs from 'node:fs'
import path from 'node:path'
import type { Board, IdentityConflict } from '../shared/generated'
import { Project, boardFileFor, dumpBoardFile, resolveReal } from './project.ts'

export interface MigrateReport {
  root: string, out: string, boards: number, revisions: number, gates: number, written: string[],
  conflicts: IdentityConflict[], round_trip: boolean
}

const identityFree = (boards: Board[]): unknown[] => boards.map(({ identity: _identity, ...rest }) => rest)

export function migrate(root: string, outDir: string): MigrateReport {
  const src = new Project(root), boards = src.boards(), conflicts = [...src.conflicts]
  const out = resolveReal(path.resolve(outDir))
  const written: string[] = []
  for (const b of boards) {
    const f = path.join(out, b.directory, src.layout.board_file)
    fs.mkdirSync(path.dirname(f), { recursive: true })
    fs.writeFileSync(f, dumpBoardFile(boardFileFor(src, b)))
    written.push(path.relative(out, f))
  }
  const again = new Project(root, {}, out).boards()
  const report: MigrateReport = {
    root: src.root, out, boards: boards.length, revisions: boards.reduce((n, b) => n + b.revisions.length, 0),
    gates: boards.flatMap(b => b.revisions).reduce((n, r) => n + r.gates.length, 0), written, conflicts,
    round_trip: isDeepStrictEqual(identityFree(again), identityFree(boards)) && again.every(b => b.identity === 'board.yaml')
  }
  fs.writeFileSync(path.join(out, 'migrate-report.json'), JSON.stringify(report, null, 2) + '\n')
  return report
}
