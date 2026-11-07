// Inline stroke icons (no icon font, no network).
const PATHS: Record<string, string> = {
  board: 'M4 4h16v16H4zM9 9h6v6H9zM9 2v2M15 2v2M9 20v2M15 20v2M2 9h2M2 15h2M20 9h2M20 15h2',
  cube: 'M12 2l9 5v10l-9 5-9-5V7zM12 22V12M3 7l9 5 9-5',
  list: 'M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01',
  doc: 'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8zM14 2v6h6M8 13h8M8 17h6',
  check: 'M9 12l2 2 4-4M12 22a10 10 0 1 1 0-20 10 10 0 0 1 0 20z',
  // Stages: a vertical trace, one node per stage.
  stages: 'M6 3v18M6 6h.01M6 12h.01M6 18h.01M11 6h9M11 12h9M11 18h9',
  // Candidate runs: a branch off the main line (the candidate) with its merge point (adopt).
  runs: 'M6 3v12M6 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM18 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM18 9a9 9 0 0 1-9 9'
}

export function Icon({ name, size = 16 }: { name: keyof typeof PATHS | string; size?: number }): React.JSX.Element {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={PATHS[name] ?? PATHS.board} />
    </svg>
  )
}
