import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import type { Project } from './project.ts'
import type { SpecDocument } from '../shared/inspector.ts'

export function specification(project: Project, pcb: string): SpecDocument {
  const selected = project.revisionForPcb(pcb)
  if (!selected) throw new Error('Select a board revision')
  const [board, revision] = selected
  if (!revision.spec) throw new Error('No specification document is assigned to this board revision.')
  const file = project.resolve(revision.spec), extension = path.extname(file).toLowerCase(), stat = fs.statSync(file)
  if (!stat.isFile() || stat.size > 20 * 1024 * 1024) throw new Error('Specification document is too large or is not a file')
  if (!['.md', '.markdown', '.pdf'].includes(extension)) throw new Error('Specification must be Markdown or PDF')
  const bytes = fs.readFileSync(file)
  return { board: board.id, revision: revision.revision, state: revision.state ?? board.lifecycle,
    source: revision.spec, path: file, format: extension === '.pdf' ? 'pdf' : 'markdown',
    text: extension === '.pdf' ? null : bytes.toString('utf8'), sha256: createHash('sha256').update(bytes).digest('hex'), updatedAt: stat.mtime.toISOString() }
}
