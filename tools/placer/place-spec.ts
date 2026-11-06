// The difference between a board and its placed copy, as a spec for `tools/pcb edit --kind place`.
import { canonical, type Footprint } from '../lib/native-board.ts';

export type PlaceSpec = { place: Record<string, [number, number, number]> };

function byReference(rows: Footprint[]): Map<string, Footprint> {
  const found = new Map<string, Footprint>();
  for (const row of rows) {
    const ref = row.props.get('Reference');
    if (!ref) continue;
    if (found.has(ref)) throw new Error(`duplicate reference ${ref}`);
    found.set(ref, row);
  }
  return found;
}

/** Only the parts that moved, sorted by reference, with absolute poses. */
export function placementSpec(source: Footprint[], candidate: Footprint[]): PlaceSpec {
  const before = byReference(source), place: PlaceSpec['place'] = {};
  for (const [ref, row] of [...byReference(candidate)].sort(([a], [b]) => a.localeCompare(b))) {
    const old = before.get(ref);
    if (!old) throw new Error(`placed board has a part that the source does not have: ${ref}`);
    const pose = row.pose.map(canonical), same = pose.every((value, i) => value === canonical(old.pose[i]!));
    if (!same) place[ref] = [Number(pose[0]), Number(pose[1]), Number(pose[2])];
  }
  return { place };
}
