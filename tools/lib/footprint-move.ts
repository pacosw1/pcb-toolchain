// A footprint at a new pose, as text. pcbnew's SetOrientation and SetPosition in the file's terms: the footprint's (at), the
// angle of its pads, fields and texts, and the outline of its zones. Those are the only forms a pose reaches: graphics and pad
// positions are saved relative to the footprint. A rectangle that a rotation can no longer hold as one is KiCad's to turn into a
// polygon, when it loads the board.
import { mmText, type Span } from './board-edit.ts';
import { NM_PER_MM } from './board-types.ts';
import { listEnd } from './sexpr.ts';

export interface Pose { x: number; y: number; rot: number }

const ROTATED_WITH_FOOTPRINT = new Set(['pad', 'property', 'fp_text']);
const FORM_NAME = /[^\s()"]*/y;

/** The direct children of the form that opens at text[0]. */
export function childForms(text: string): Span[] {
  const forms: Span[] = [];
  let at = 1;
  let quoted = false;
  while (at < text.length - 1) {
    const c = text[at]!;
    if (quoted) {
      if (c === '\\') at += 1;
      else if (c === '"') quoted = false;
      at += 1;
    } else if (c === '"') {
      quoted = true;
      at += 1;
    } else if (c === '(') {
      const end = listEnd(text, at);
      FORM_NAME.lastIndex = at + 1;
      forms.push({ kind: FORM_NAME.exec(text)![0], start: at, end });
      at = end;
    } else {
      at += 1;
    }
  }
  return forms;
}

/** Degrees in [0, 360), the range KiCad writes an item angle in. */
const itemAngle = (degrees: number): number => ((degrees % 360) + 360) % 360;
/** Degrees in (-180, 180], the range of a footprint's orientation. */
export function footprintAngle(degrees: number): number {
  const angle = itemAngle(degrees);
  return angle > 180 ? angle - 360 : angle;
}

function replaced(text: string, changes: (Span & { text: string })[]): string {
  let out = '';
  let at = 0;
  for (const change of changes) {
    out += text.slice(at, change.start) + change.text;
    at = change.end;
  }
  return out + text.slice(at);
}

function turnedItem(item: string, delta: number): string {
  const at = childForms(item).find(form => form.kind === 'at');
  if (!at) return item;
  const [, x, y, angle = '0'] = item.slice(at.start + 1, at.end - 1).split(/\s+/) as [string, string, string, string?];
  return replaced(item, [{ ...at, text: `(at ${x} ${y} ${itemAngle(Number(angle) + delta)})` }]);
}

const nanometres = (text: string): number => Math.round(Number(text) * NM_PER_MM);

/** RotatePoint, whole nanometres: exact at a right angle, else rounded. Positive turns as a footprint orientation does. */
function rotated(x: number, y: number, degrees: number): [number, number] {
  switch (itemAngle(degrees)) {
    case 0: return [x, y];
    case 90: return [y, -x];
    case 180: return [-x, -y];
    case 270: return [-y, x];
  }
  const radians = degrees * Math.PI / 180;
  const [sin, cos] = [Math.sin(radians), Math.cos(radians)];
  return [Math.round(y * sin + x * cos), Math.round(y * cos - x * sin)];
}

/** A zone's points are board coordinates, so they follow the footprint: its fill too, until the save refills it. */
function movedZone(zone: string, from: Pose, to: Pose, delta: number): string {
  const [fromX, fromY, toX, toY] = [from.x, from.y, to.x, to.y].map(mm => Math.trunc(mm * NM_PER_MM)) as [number, number, number, number];
  return zone.replace(/\(xy (\S+) (\S+)\)/g, (_, x: string, y: string) => {
    const [dx, dy] = rotated(nanometres(x) - fromX, nanometres(y) - fromY, delta);
    return `(xy ${mmText((toX + dx) / NM_PER_MM)} ${mmText((toY + dy) / NM_PER_MM)})`;
  });
}

/** `footprint` at `to`. `from` is its pose now, from the board document. */
export function movedFootprint(footprint: string, from: Pose, to: Pose): string {
  const delta = to.rot - from.rot;
  const changes = childForms(footprint).flatMap((form): (Span & { text: string })[] => {
    const text = footprint.slice(form.start, form.end);
    if (ROTATED_WITH_FOOTPRINT.has(form.kind)) return [{ ...form, text: turnedItem(text, delta) }];
    if (form.kind === 'zone') return [{ ...form, text: movedZone(text, from, to, delta) }];
    if (form.kind === 'at') return [{ ...form, text: `(at ${mmText(to.x)} ${mmText(to.y)} ${footprintAngle(to.rot)})` }];
    return [];
  });
  return replaced(footprint, changes);
}
