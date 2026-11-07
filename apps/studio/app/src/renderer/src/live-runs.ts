/** The daemon lists the runs of all boards. A run names its PCB file, so the selected file picks its runs. */
export function runsOfBoard<T extends { summary: { run: { board?: string } | null } }>(runs: T[], pcb: string | null): T[] {
  const file = pcb?.split('/').pop()
  return file ? runs.filter((r) => r.summary.run?.board === file) : []
}
