// What a silk label must keep clear of, on one side of a board, and the labels placed so far. Used by tools/board_labels.ts.
import { boxProbes, courtyardOf, graphicBox, grow, hit, insideBoard, rectBox, unionBox, type Box, type Silk, type Xy } from './board-silk.ts';
import { toMm, vias, type Board } from './board-types.ts';
import { round } from './py-numbers.ts';
import { inkBox, type HAlign, type VAlign } from './stroke-text.ts';

export const GROUP = 'board-labels';
export const GROUP_BACK = 'board-labels-back'; // the B.SilkS copy ("back": true), user request 2026-10-07
export const GROUP_INFO = 'board-info-back'; // reference blocks on B.SilkS ("info_back"), user request 2026-10-11
const MARKS_GROUP = 'silk-marks';
const LABEL_GROUPS = [GROUP, MARKS_GROUP, GROUP_BACK];

const PAD_GAP = 0.2;
const NPTH_GAP = 0.3;
const VIA_GAP = 0.15;
const SILK_GAP = 0.1;
const EDGE_GAP = 0.5;
const BODY_GAP = -0.2; // a label may reach this far into a courtyard
const SCREW_DRILL_MM = 3.0;
const SCREW_HEAD_R = 3.0; // M3 pan head 5.5 mm + margin: silk under the head is hidden
const PIN_GAP_X = 0.5;
const PIN_GAP_Y = 0.08; // between two pin labels: side by side / one over the other (1.25 mm pitch columns)
export const TITLE_GAP = 0.6; // between a title and any other label

export type LabelKind = 'pin' | 'title';
export interface Just { h: HAlign; v: VAlign; angle: number }
export interface Obstacle { box: Box; why: string }
interface Placed { box: Box; text: string; kind: LabelKind }

/** Stroke of a label: 0.15 mm per mm of height, 0.15 mm minimum. */
export const strokeOf = (height: number): number => Math.max(0.15, round(0.15 * height, 3));

/** Glyph box of a label relative to its anchor. */
export function labelExtent(text: string, height: number, width: number, { h, v, angle }: Just, back: boolean): Box {
  return inkBox(text, { height, width, thickness: strokeOf(height), h, v, angle, mirrored: back });
}

const isVia = (obstacle: Obstacle): boolean => obstacle.why.startsWith('via ');

export class LabelBoard {
  readonly board: Board;
  readonly back: boolean;
  readonly obstacles: Obstacle[] = [];
  readonly screws: Xy[] = [];
  /** Back side: the courtyard of each connector with no through-hole pin; labels go under it. */
  readonly smd = new Map<string, Box>();
  readonly placed: Placed[] = [];
  pinGapX = PIN_GAP_X;

  constructor(board: Board, silk: Silk, back = false) {
    this.board = board;
    this.back = back;
    const layer = back ? 'B.SilkS' : 'F.SilkS';
    const add = (box: Box, why: string): void => { this.obstacles.push({ box, why }); };
    for (const footprint of board.footprints) {
      const reference = footprint.reference;
      for (const pad of footprint.pads) {
        const onSide = !back || pad.drill.x > 0 || pad.layers.includes('B.Cu') || pad.layers.includes('B.Mask');
        if (onSide) add(grow(rectBox(pad.bbox), pad.kind === 'NpThroughHole' ? NPTH_GAP : PAD_GAP), `pad ${reference}.${pad.number}`);
        if (toMm(pad.drill.x) >= SCREW_DRILL_MM) this.screws.push([toMm(pad.position.x), toMm(pad.position.y)]);
      }
      const courtyard = courtyardOf(footprint);
      if (courtyard && back && !footprint.pads.some(pad => pad.drill.x > 0)) this.smd.set(reference, courtyard);
      if (courtyard && !back && !footprint.pads.some(pad => toMm(pad.drill.x) >= SCREW_DRILL_MM)) add(grow(courtyard, BODY_GAP), `body ${reference}`);
      for (const item of footprint.graphics) {
        const box = item.layer === layer ? graphicBox(item) : null;
        if (box) add(grow(box, SILK_GAP), `silk ${reference}`);
      }
    }
    for (const text of silk.footprintTexts) if (text.layer === layer && text.visible) add(grow(text.box, SILK_GAP), `field ${text.reference}`);
    for (const via of vias(board)) {
      const [x, y, r] = [toMm(via.at.x), toMm(via.at.y), toMm(via.size) / 2];
      add(grow([x - r, y - r, x + r, y + r], VIA_GAP), `via ${via.net}`);
    }
    const drawn = (group?: string): boolean => group === undefined || !LABEL_GROUPS.includes(group);
    for (const text of silk.texts) if (text.layer === layer && drawn(text.group)) add(grow(text.box, SILK_GAP), `board silk ${text.text}`);
    for (const shape of silk.shapes) if (shape.layer === layer && drawn(shape.group)) add(grow(shape.box, SILK_GAP), 'board silk shape');
    // The brand block is one obstacle: no label in the gaps between its letters.
    const brand = [...silk.texts, ...silk.shapes].filter(item => item.layer === layer && item.group?.startsWith('brand '));
    if (brand.length) add(grow(brand.map(item => item.box).reduce(unionBox), SILK_GAP), 'brand block');
  }

  /** Obstacles in the window; vias false leaves out the vias (tented: the silk prints over them). The back keeps them. */
  local(window: Box, keepVias = true): Box[] {
    const all = keepVias || this.back;
    return this.obstacles.filter(obstacle => hit(obstacle.box, window) && (all || !isVia(obstacle))).map(obstacle => obstacle.box);
  }

  /** Obstacles in the window apart from any via: for a panel that prints over tented vias. */
  localOverVias(window: Box): Box[] {
    return this.obstacles.filter(obstacle => hit(obstacle.box, window) && !isVia(obstacle)).map(obstacle => obstacle.box);
  }

  /** What stands in the box, for a report. */
  blockers(box: Box): string[] {
    return this.obstacles.filter(obstacle => hit(box, obstacle.box)).map(obstacle => obstacle.why);
  }

  inside(box: Box): boolean {
    return boxProbes(box).every(point => insideBoard(this.board, point, EDGE_GAP));
  }

  overScrew([x0, y0, x1, y1]: Box): boolean {
    return this.screws.some(([x, y]) => Math.hypot(Math.max(x0 - x, 0, x - x1), Math.max(y0 - y, 0, y - y1)) < SCREW_HEAD_R);
  }

  clash(box: Box, kind: LabelKind): string[] {
    return this.placed.filter(other => {
      const [gapX, gapY] = kind === 'pin' && other.kind === 'pin' ? [this.pinGapX, PIN_GAP_Y] : [TITLE_GAP, TITLE_GAP];
      return hit([box[0] - gapX, box[1] - gapY, box[2] + gapX, box[3] + gapY], other.box);
    }).map(other => other.text);
  }

  free(box: Box, local: Box[], kind: LabelKind = 'pin'): boolean {
    return !local.some(obstacle => hit(box, obstacle)) && !this.clash(box, kind).length && this.inside(box) && !this.overScrew(box);
  }

  place(box: Box, text: string, kind: LabelKind): void {
    this.placed.push({ box, text, kind });
  }

  resetPinGap(gap = PIN_GAP_X): void {
    this.pinGapX = gap;
  }
}
