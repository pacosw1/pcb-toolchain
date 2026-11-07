// The board shape: the parts of a .kicad_pcb that placement and routing may not change.
// The hash takes the layer table, the stackup, the board thickness and the top-level outline on Edge.Cuts, with ids and line style left out.
// The list is an allow list, so a part, a track, a via, a pour, silk or a plot setting does not change it. An outline cut inside a footprint moves with the part: it is not here.
// The .kicad_dru file joins the hash as a whole. Rules files and the schematic have hashes of their own.
import { existsSync, readFileSync } from 'node:fs';
import { sha256Text } from './fingerprint.ts';
import { sha256File } from './json-file.ts';
import { clean } from './pcb-identity.ts';
import { compare, jsonCanonical, PyError } from './py-compat.mjs';
import { boardConfig } from './pcb-workflow.ts';
import { field, forms, type SExpr, type SList } from './sexpr.ts';

const OUTLINE = new Set(['gr_line', 'gr_arc', 'gr_circle', 'gr_rect', 'gr_poly', 'gr_curve', 'bezier']);
const NOT_SHAPE = new Set(['uuid', 'tstamp', 'stroke', 'fill', 'width']);

const shapeOf = (form: SList): SExpr => clean(form.filter(item => !(Array.isArray(item) && NOT_SHAPE.has(item[0] as string))));
const onEdge = (form: SList): boolean => { const layer = field(form, 'layer'); return layer?.[0] === 'Edge.Cuts'; };

/** The shape forms of a board text. A text that is not one kicad_pcb form is an error. */
export function boardShape(text: string): unknown {
  const roots = forms(text), top = roots[0];
  if (roots.length !== 1 || !Array.isArray(top) || top[0] !== 'kicad_pcb') throw new PyError('ValueError', 'invalid native PCB root');
  const rows = top.slice(1).filter((form): form is SList => Array.isArray(form));
  const one = (name: string): SList | null => rows.find(form => form[0] === name) ?? null;
  const setup = one('setup'), general = one('general');
  const outline = rows.filter(form => OUTLINE.has(form[0] as string) && onEdge(form)).map(shapeOf).sort((a, b) => compare(jsonCanonical(a), jsonCanonical(b)));
  return { layers: one('layers'), stackup: setup ? field(setup, 'stackup') ?? null : null, thickness: general ? field(general, 'thickness') ?? null : null, outline };
}

/** One hash of the board shape and the design rules of BOARD. A missing .kicad_dru is a value, and a board that cannot be read is an error. */
export function boardShapeSha256(root: string, board: string): string {
  const { project } = boardConfig(root, board), dru = `${project}.kicad_dru`;
  return sha256Text(JSON.stringify({ shape: boardShape(readFileSync(`${project}.kicad_pcb`, 'utf8')), rules: existsSync(dru) ? sha256File(dru) : null }));
}
