// The colours of a board's (stackup ...) form: what KiCad renders and what the fab notes say. Only colours JLC makes.

const JLC_MASK = ['Green', 'Red', 'Yellow', 'Blue', 'White', 'Black', 'Purple'];
const JLC_SILK = ['White', 'Black'];
const JLC_FINISH = ['HAL lead-free', 'ENIG'];
const LAYER = /^\s*\(layer "([^"]+)"/;
/** KiCad draws the named 'Black' mask semi-transparent (brown over FR4). For renders only, a near-opaque hex. */
const RENDER_COLOR: Record<string, string> = { Black: '#0E0E10F5' };

export function applyColors(board: string, mask: string, silk: string, finish: string, render = false): string {
  if (!JLC_MASK.includes(mask) || !JLC_SILK.includes(silk) || !JLC_FINISH.includes(finish)) {
    throw new Error(`not a JLC option: mask ${mask}, silk ${silk}, finish ${finish}`);
  }
  const shown = render ? RENDER_COLOR[mask] ?? mask : mask;
  const wanted = new Map([['F.Mask', shown], ['B.Mask', shown], ['F.SilkS', silk], ['B.SilkS', silk]]);
  const out: string[] = [];
  let current: string | null = null;
  let inside = false;
  for (const line of board.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.startsWith('(stackup')) inside = true;
    else if (inside && trimmed.startsWith('(copper_finish')) inside = false;
    current = line.match(LAYER)?.[1] ?? current;
    if (!inside) current = null;
    const colour = current === null ? undefined : wanted.get(current);
    if (colour !== undefined && trimmed.startsWith('(color ')) continue;
    out.push(line);
    if (colour !== undefined && trimmed.startsWith('(type ')) out.push(`${line.slice(0, line.length - line.trimStart().length)}(color "${colour}")`);
  }
  return out.join('\n').replace(/\(copper_finish "[^"]*"\)/g, () => `(copper_finish "${finish}")`);
}
