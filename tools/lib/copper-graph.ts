// Copper connectivity of one layer without polygon booleans. All copper of a board is dark (gerber.ts refuses clear
// polarity), so a copper piece is a connected component of the shapes that overlap, and no union has to be built.
//
// Two shapes join when they share more than a point, which is when a polygon union merges them. A shape hits a piece as
// shapely's intersects does: any contact counts, a single point too.

export type Xy = readonly [number, number];

/** Relation of two shapes, or two edges: 0 apart, 1 touching at points only, 2 sharing a length or an area. */
type Relation = 0 | 1 | 2;

const EDGES_PER_BAND = 8;

const cross = (a: Xy, b: Xy, c: Xy) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);

function onSegment(a: Xy, b: Xy, p: Xy): boolean {
  return Math.min(a[0], b[0]) <= p[0] && p[0] <= Math.max(a[0], b[0]) && Math.min(a[1], b[1]) <= p[1] && p[1] <= Math.max(a[1], b[1]);
}

function collinearRelation(p1: Xy, p2: Xy, q1: Xy, q2: Xy): Relation {
  const axis = Math.abs(p2[0] - p1[0]) >= Math.abs(p2[1] - p1[1]) ? 0 : 1;
  const start = Math.max(Math.min(p1[axis], p2[axis]), Math.min(q1[axis], q2[axis]));
  const end = Math.min(Math.max(p1[axis], p2[axis]), Math.max(q1[axis], q2[axis]));
  return end > start ? 2 : end === start ? 1 : 0;
}

function edgeRelation(p1: Xy, p2: Xy, q1: Xy, q2: Xy): Relation {
  const d1 = Math.sign(cross(q1, q2, p1));
  const d2 = Math.sign(cross(q1, q2, p2));
  const d3 = Math.sign(cross(p1, p2, q1));
  const d4 = Math.sign(cross(p1, p2, q2));
  if (d1 * d2 < 0 && d3 * d4 < 0) return 2;
  if (d1 === 0 && d2 === 0 && d3 === 0 && d4 === 0) return collinearRelation(p1, p2, q1, q2);
  const touches = (d1 === 0 && onSegment(q1, q2, p1)) || (d2 === 0 && onSegment(q1, q2, p2))
    || (d3 === 0 && onSegment(p1, p2, q1)) || (d4 === 0 && onSegment(p1, p2, q2));
  return touches ? 1 : 0;
}

/** A closed polygon, its edges sorted into horizontal bands: a zone has thousands of edges and most queries are small. */
export class Outline {
  readonly points: readonly Xy[];
  readonly minX: number;
  readonly minY: number;
  readonly maxX: number;
  readonly maxY: number;
  private readonly bands: number[][];
  private readonly bandHeight: number;

  constructor(points: readonly Xy[]) {
    this.points = points;
    const xs = points.map(point => point[0]);
    const ys = points.map(point => point[1]);
    this.minX = xs.reduce((a, b) => Math.min(a, b));
    this.maxX = xs.reduce((a, b) => Math.max(a, b));
    this.minY = ys.reduce((a, b) => Math.min(a, b));
    this.maxY = ys.reduce((a, b) => Math.max(a, b));
    const count = Math.max(1, Math.ceil(points.length / EDGES_PER_BAND));
    this.bandHeight = (this.maxY - this.minY) / count || 1;
    this.bands = Array.from({ length: count }, () => []);
    points.forEach((_, index) => {
      const [a, b] = this.edge(index);
      for (let band = this.band(Math.min(a[1], b[1])); band <= this.band(Math.max(a[1], b[1])); band++) this.bands[band]!.push(index);
    });
  }

  private band(y: number): number {
    return Math.min(this.bands.length - 1, Math.max(0, Math.floor((y - this.minY) / this.bandHeight)));
  }

  edge(index: number): readonly [Xy, Xy] {
    return [this.points[index]!, this.points[(index + 1) % this.points.length]!];
  }

  /** The indexes of the edges that may reach between two heights. An edge can appear twice. */
  edgesBetween(minY: number, maxY: number): number[] {
    return this.bands.slice(this.band(minY), this.band(maxY) + 1).flat();
  }

  /** 1 inside, 0 on the outline, -1 outside. Even-odd, so a keyholed zone outline reads as its copper. */
  locate(point: Xy): 1 | 0 | -1 {
    if (point[0] < this.minX || point[0] > this.maxX || point[1] < this.minY || point[1] > this.maxY) return -1;
    let inside = false;
    for (const index of this.bands[this.band(point[1])]!) {
      const [a, b] = this.edge(index);
      if (cross(a, b, point) === 0 && onSegment(a, b, point)) return 0;
      const spans = (a[1] > point[1]) !== (b[1] > point[1]);
      if (spans && point[0] < a[0] + (point[1] - a[1]) * (b[0] - a[0]) / (b[1] - a[1])) inside = !inside;
    }
    return inside ? 1 : -1;
  }
}

function boxesMeet(a: Outline, b: Outline): boolean {
  return a.minX <= b.maxX && b.minX <= a.maxX && a.minY <= b.maxY && b.minY <= a.maxY;
}

function edgesRelation(a: Outline, b: Outline): Relation {
  const [few, many] = a.points.length <= b.points.length ? [a, b] : [b, a];
  let relation: Relation = 0;
  for (let i = 0; i < few.points.length; i++) {
    const [p1, p2] = few.edge(i);
    for (const j of many.edgesBetween(Math.min(p1[1], p2[1]), Math.max(p1[1], p2[1]))) {
      const [q1, q2] = many.edge(j);
      const found = edgeRelation(p1, p2, q1, q2);
      if (found === 2) return 2;
      if (found === 1) relation = 1;
    }
  }
  return relation;
}

/** A vertex or edge midpoint of `a` strictly inside `b`: edges that only touch can still enter through a vertex. */
function reachesInside(a: Outline, b: Outline): boolean {
  return a.points.some((point, index) => {
    const [from, to] = a.edge(index);
    return b.locate(point) === 1 || b.locate([(from[0] + to[0]) / 2, (from[1] + to[1]) / 2]) === 1;
  });
}

export function relate(a: Outline, b: Outline): Relation {
  if (!boxesMeet(a, b)) return 0;
  const edges = edgesRelation(a, b);
  if (edges === 2) return 2;
  // With no contact one shape is inside the other or they are apart, and one vertex tells which.
  if (edges === 0) return b.locate(a.points[0]!) === 1 || a.locate(b.points[0]!) === 1 ? 2 : 0;
  return reachesInside(a, b) || reachesInside(b, a) ? 2 : 1;
}

export class UnionFind {
  private readonly parent = new Map<number, number>();

  find(item: number): number {
    let root = item;
    while ((this.parent.get(root) ?? root) !== root) root = this.parent.get(root)!;
    for (let next = item; next !== root;) {
      const up = this.parent.get(next) ?? next;
      this.parent.set(next, root);
      next = up;
    }
    return root;
  }

  union(a: number, b: number): void {
    this.parent.set(this.find(a), this.find(b));
  }
}

/** The shapes of a layer in a uniform grid of their boxes, with the pieces they form. */
export class CopperLayer {
  readonly pieces: number;
  private readonly shapes: readonly Outline[];
  private readonly groups = new UnionFind();
  private readonly cells = new Map<string, number[]>();
  private readonly cellSize: number;
  private readonly pieceOfRoot = new Map<number, number>();

  constructor(shapes: readonly Outline[]) {
    this.shapes = shapes;
    const span = shapes.length ? Math.max(...shapes.map(shape => Math.max(shape.maxX - shape.minX, shape.maxY - shape.minY))) : 1;
    this.cellSize = Math.max(span / 64, 0.5);
    shapes.forEach((shape, index) => {
      for (const key of this.cellsOf(shape.minX, shape.minY, shape.maxX, shape.maxY)) {
        const cell = this.cells.get(key);
        if (cell) cell.push(index);
        else this.cells.set(key, [index]);
      }
    });
    this.joinOverlaps();
    shapes.forEach((_, index) => {
      const root = this.groups.find(index);
      if (!this.pieceOfRoot.has(root)) this.pieceOfRoot.set(root, this.pieceOfRoot.size);
    });
    this.pieces = this.pieceOfRoot.size;
  }

  private *cellsOf(minX: number, minY: number, maxX: number, maxY: number): Generator<string> {
    const size = this.cellSize;
    for (let x = Math.floor(minX / size); x <= Math.floor(maxX / size); x++) {
      for (let y = Math.floor(minY / size); y <= Math.floor(maxY / size); y++) yield `${x},${y}`;
    }
  }

  private joinOverlaps(): void {
    const tested = new Set<number>();
    for (const cell of this.cells.values()) {
      for (let i = 0; i < cell.length; i++) {
        for (let j = i + 1; j < cell.length; j++) {
          const a = cell[i]!;
          const b = cell[j]!;
          const pair = a * this.shapes.length + b;
          if (tested.has(pair) || this.groups.find(a) === this.groups.find(b)) continue;
          tested.add(pair);
          if (relate(this.shapes[a]!, this.shapes[b]!) === 2) this.groups.union(a, b);
        }
      }
    }
  }

  private candidates(minX: number, minY: number, maxX: number, maxY: number): Set<number> {
    const found = new Set<number>();
    for (const key of this.cellsOf(minX, minY, maxX, maxY)) for (const index of this.cells.get(key) ?? []) found.add(index);
    return found;
  }

  private pieceOf(shape: number): number {
    return this.pieceOfRoot.get(this.groups.find(shape))!;
  }

  /** The pieces under a point, its outline counting as copper. */
  piecesAt(point: Xy): number[] {
    const hits = [...this.candidates(point[0], point[1], point[0], point[1])].filter(index => this.shapes[index]!.locate(point) >= 0);
    return [...new Set(hits.map(index => this.pieceOf(index)))];
  }

  /** The pieces that an outline touches or overlaps. */
  piecesHit(outline: Outline): number[] {
    const hits = [...this.candidates(outline.minX, outline.minY, outline.maxX, outline.maxY)].filter(index => relate(outline, this.shapes[index]!) > 0);
    return [...new Set(hits.map(index => this.pieceOf(index)))];
  }
}
