export interface InspectorSection<T> {
  state: 'ready' | 'unavailable' | 'error'
  data: T | null
  message: string | null
}
export interface BoardInspection {
  pcb: string
  sourceSha256: string
  runtime: string | null
  capturedAt: string
  stats: InspectorSection<Record<string, unknown>>
  stackup: InspectorSection<Record<string, unknown>>
  bom: InspectorSection<string[][]>
}

export interface NativeInventory {
  capturedAt: string
  sources: { path: string; sha256: string }[]
  documents: { kind: 'pcb' | 'schematic'; path: string; version: string; documents: number; counts: Record<string, number> }[]
}

export interface SchematicExport {
  source: string
  revision: string
  runtime: string | null
  sheets: { name: string; path: string; viewBox?: [number, number, number, number]; targets?: { ref?: string; net?: string; x: number; y: number }[] }[]
}

export interface SpecDocument {
  board: string
  revision: string | null
  state: string | null
  source: string
  path: string
  format: 'markdown' | 'pdf'
  text: string | null
  sha256: string
  updatedAt: string
}
