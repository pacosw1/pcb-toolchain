import gerberParser from 'gerber-parser';
import gerberPlotter from 'gerber-plotter';
import { pathGeometry, toolGeometry, type Primitive } from './geometry.ts';
import type { Draw, Geometry, Hole, Point } from './types.ts';

type Chunk = Exclude<gerberPlotter.Chunk, gerberPlotter.ChunkShape> | { type: 'shape'; tool: string; shape: Primitive[] };

/** Read without X2 net/pad attributes. All parser or plotter warnings fail the check: never silently drop geometry. */
export async function layerGeometry(source: string): Promise<Draw[]> {
  const text = source.replace(/%T[FAOD][^%]*%\s*/g, '');
  if (!/%FS[LT]A/.test(text) || !/%MO(?:MM|IN)\*%/.test(text) || !/M0?2\*/.test(text)) {
    throw new Error('Gerber needs explicit coordinate format, units and M02 end marker');
  }
  const parser = gerberParser({ filetype: 'gerber' });
  const plotter = gerberPlotter({ optimizePaths: false });
  const tools = new Map<string, Geometry>();
  const operations: Draw[] = [];
  let dark = true;
  let offsets: Point[] = [[0, 0]];
  let block: Draw[] = [];
  let units: 'mm' | 'in' | undefined;
  let failure: Error | undefined;
  const flushBlock = () => {
    // Gerber repeats in offset order. A later clear object may erase an earlier repeated block.
    for (const offset of offsets) for (const op of block) operations.push({ dark: op.dark,
      geometry: { kind: 'translate', offset, geometry: op.geometry } });
    block = [];
  };
  const draw = (geometry: Geometry) => block.push({ dark, geometry });
  const warning = (w: { message: string; line?: number }) => { failure ??= new Error(`Gerber line ${w.line ?? '?'}: ${w.message}`); };
  await new Promise<void>((resolve, reject) => {
    parser.on('error', reject);
    plotter.on('error', reject);
    parser.on('warning', warning);
    plotter.on('warning', warning);
    plotter.on('data', (chunk: Chunk) => {
      try {
        switch (chunk.type) {
          case 'shape': tools.set(chunk.tool, toolGeometry(chunk.shape)); break;
          case 'pad': {
            const tool = tools.get(chunk.tool);
            if (!tool) throw new Error(`Gerber uses undefined aperture ${chunk.tool}`);
            draw({ kind: 'translate', offset: [chunk.x, chunk.y], geometry: tool }); break;
          }
          case 'stroke': draw(pathGeometry(chunk.path, chunk.width)); break;
          case 'fill': draw(pathGeometry(chunk.path)); break;
          case 'polarity': dark = chunk.polarity === 'dark'; break;
          case 'repeat': flushBlock(); offsets = chunk.offsets.length ? chunk.offsets : [[0, 0]]; break;
          case 'size': units = chunk.units; break;
          default: throw new Error('unknown Gerber plot operation');
        }
      } catch (error) { failure ??= error instanceof Error ? error : new Error(String(error)); }
    });
    plotter.on('end', resolve);
    parser.pipe(plotter);
    parser.end(text);
  });
  if (failure) throw failure;
  flushBlock();
  if (!units) throw new Error('Gerber produced no unit declaration');
  return units === 'mm' ? operations : operations.map(op => ({ dark: op.dark, geometry: scaleGeometry(op.geometry, 25.4) }));
}

function scaleGeometry(g: Geometry, factor: number): Geometry {
  const point = ([x, y]: Point): Point => [factor * x, factor * y];
  switch (g.kind) {
    case 'polygon': return { ...g, points: g.points.map(point) };
    case 'region': return { ...g, rings: g.rings.map(r => r.map(point)) };
    case 'circle': return { ...g, center: point(g.center), radius: factor * g.radius };
    case 'stroke': return { ...g, points: g.points.map(point), width: factor * g.width };
    case 'union': return { ...g, items: g.items.map(i => scaleGeometry(i, factor)) };
    case 'difference': case 'intersection': return { ...g, a: scaleGeometry(g.a, factor), b: scaleGeometry(g.b, factor) };
    case 'translate': return { ...g, offset: point(g.offset), geometry: scaleGeometry(g.geometry, factor) };
  }
}

/** KiCad's metric decimal drill output: plated holes and G85 slots. Reject unhandled coordinate formats. */
export function excellonHoles(source: string): Hole[] {
  const tools = new Map<string, number>();
  const holes: Hole[] = [];
  let diameter: number | undefined;
  let metric = false;
  for (const raw of source.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith('INCH') || line === 'M72') throw new Error('inch drill file not handled');
    if (line.startsWith('METRIC') || line === 'M71') { metric = true; continue; }
    if (line === '%' || !line || line.startsWith(';') || line === 'FMAT,2' || /^(?:M(?:30|48|95)|G(?:0?5|90))$/.test(line)) continue;
    let match = /^T(\d+)C([\d.]+)$/.exec(line);
    if (match) { tools.set(match[1], Number(match[2])); continue; }
    match = /^T(\d+)$/.exec(line);
    if (match) {
      if (Number(match[1]) === 0) { diameter = undefined; continue; }
      diameter = tools.get(match[1]);
      if (diameter === undefined) throw new Error(`undefined drill tool T${match[1]}`);
      continue;
    }
    match = /^X([-\d.]+)Y([-\d.]+)(?:G85X([-\d.]+)Y([-\d.]+))?$/.exec(line);
    if (!match) throw new Error(`unsupported drill command: ${line}`);
    if (!metric || diameter === undefined || !Number.isFinite(diameter) || diameter <= 0) throw new Error('drill coordinates need metric units and a positive tool diameter');
    const coords = match.slice(1).filter((v): v is string => v !== undefined);
    if (coords.some(v => !v.includes('.') || !Number.isFinite(Number(v)))) throw new Error('drill coordinates must be explicit decimal millimetres');
    const start: Point = [Number(match[1]), Number(match[2])];
    const end: Point = match[3] === undefined ? [...start] : [Number(match[3]), Number(match[4])];
    holes.push({ start, end, diameter });
  }
  if (!metric) throw new Error('drill file has no metric unit declaration');
  return holes;
}
