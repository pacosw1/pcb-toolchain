import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { creditOwnHoles, markGroundVias, plainJson, returnRadius, takeExemptTransitions, takeReturnStitched, type Pad, type Sample, type Tree } from './kicad-happy-board.ts';
import { applyExemptions, evaluate, filterFindings, formatFinding, loadExemptFile, parseExemptArgs, type Finding } from './kicad-happy-findings.ts';
import { jsonDumps, jsonLoads } from './py-compat.mjs';

const TOOLS = dirname(dirname(fileURLToPath(import.meta.url)));
const PROGRAM = join(TOOLS, 'kicad_happy_gate.ts');

// Set before the import: env.mjs otherwise looks for a Python by running it.
process.env.PYTHON_MODERN = 'not-run';
const { checkPinned, checkReport, resolveBoard } = await import('../kicad_happy_gate.ts');

const RULES = ['GP-001', 'RP-001', 'VP-001', 'DC-002', 'UC-001'];
const fixture = (name: string) => JSON.parse(readFileSync(join(TOOLS, 'fixtures', name), 'utf8')) as { findings: Finding[] };
const sampleFindings = () => filterFindings(
  ['sch', 'pcb', 'emc'].flatMap(kind => fixture(`kicad_happy_${kind}_sample.json`).findings), RULES);
const tree = (doc: unknown) => jsonLoads(JSON.stringify(doc)) as Tree;
const folder = () => mkdtempSync(join(tmpdir(), 'kicad-happy-'));

test('filter keeps the allowed rules and clears the severity floor', () => {
  const findings: Finding[] = [{ rule_id: 'A', severity: 'info' }, { rule_id: 'A', severity: 'error' }, { rule_id: 'B', severity: 'critical' }, { rule_id: 'A', severity: 'odd' }];
  assert.deepEqual(filterFindings(findings, ['A']).length, 3);
  assert.deepEqual(filterFindings(findings, ['A'], 'warning'), [{ rule_id: 'A', severity: 'error' }]);
  assert.deepEqual(filterFindings([], ['A']), []);
});

test('a finding line uses the summary, then the description', () => {
  assert.equal(formatFinding({ rule_id: 'A', summary: 's', description: 'd' }), 'FAIL A s');
  assert.equal(formatFinding({ rule_id: 'A', summary: '', description: 'd' }), 'FAIL A d');
  assert.equal(formatFinding({ rule_id: 'A' }), 'FAIL A ');
});

test('--exempt takes RULE:NET', () => {
  assert.deepEqual(parseExemptArgs(['GP-001:/PS1_24V']), [{ rule: 'GP-001', net: '/PS1_24V', reason: '--exempt on the command line' }]);
  assert.throws(() => parseExemptArgs(['GP-001']), /^Error: --exempt 'GP-001': use RULE:NET$/);
});

test('an exempt file entry needs a reason and exactly one of net, ref', () => {
  assert.throws(() => loadExemptFile({}), /must be a JSON list/);
  assert.throws(() => loadExemptFile([{ rule: 'R', net: '/A' }]), /exempt entry 0: reason is required/);
  assert.throws(() => loadExemptFile([{ rule: 'R', net: '/A', reason: ' ' }]), /reason is required/);
  assert.throws(() => loadExemptFile([{ rule: 'R', reason: 'x' }]), /give exactly one of net, ref/);
  assert.throws(() => loadExemptFile([{ rule: 'R', net: '/A', ref: 'C4', reason: 'x' }]), /give exactly one of net, ref/);
  assert.throws(() => loadExemptFile([{ rule: 'R', net: '/A', reason: 'x', extra: 1 }]), /use only the keys/);
});

test('an exemption drops findings of its rule that name its net or ref', () => {
  const findings = sampleFindings();
  const byNet = applyExemptions(findings, [{ rule: 'GP-001', net: '/PS1_24V', reason: 'x' }]);
  assert.deepEqual(byNet.stale, []);
  assert.ok(!byNet.kept.some(finding => finding.rule_id === 'GP-001'));
  assert.equal(byNet.kept.length, findings.length - 1);
  const byRef = applyExemptions(findings, [{ rule: 'VP-001', ref: 'C4', reason: 'x' }]);
  assert.equal(byRef.kept.length, findings.length - 1);
  const otherRule = [{ rule: 'RP-001', net: '/PS1_24V', reason: 'x' }];
  assert.deepEqual(applyExemptions(findings, otherRule), { kept: findings, stale: otherRule });
});

test('a stale exemption gives exit 2 and names its target; findings give exit 1', () => {
  const findings = sampleFindings();
  const stale = evaluate(findings, RULES, undefined, [{ rule: 'VP-001', ref: 'U4', reason: 'x' }]);
  assert.equal(stale.code, 2);
  assert.ok(stale.lines.some(line => line.startsWith('STALE exempt VP-001 U4: no finding matched (x)')));
  const plain = evaluate(findings, RULES, undefined, []);
  assert.equal(plain.code, 1);
  assert.deepEqual(plain.lines.slice(0, -1), findings.map(formatFinding));
  assert.equal(plain.lines.at(-1), `${findings.length} kicad-happy findings (rules ${RULES.join(',')})`);
  assert.equal(evaluate([], RULES, undefined, []).code, 0);
});

const groundDoc = () => tree({ nets: { 1: 'FIELD_0V', 2: '/SIG', 3: 'GND' },
  vias: { vias: [{ x: 0, y: 0, net: 1 }, { x: 1, y: 0, net: 2 }, { x: 2, y: 0, net: 3 }] } });

test('named ground vias are marked GND; an unknown ground is an error', () => {
  const doc = groundDoc();
  markGroundVias(doc, ['FIELD_0V']);
  const { vias } = plainJson(doc.get('vias')) as { vias: { net_name?: string }[] };
  assert.deepEqual(vias.map(via => via.net_name), ['GND', undefined, undefined]);
  assert.throws(() => markGroundVias(groundDoc(), ['FIELD_GND']), /^Error: --ground: no such net on the board: \['FIELD_GND'\]$/);
});

const transitionDoc = () => tree({ nets: { 1: 'GND', 2: '/A', 3: '/B' },
  vias: { vias: [{ x: 0, y: 0, net: 2 }, { x: 5, y: 0, net: 3 }, { x: 5.9, y: 0, net: 1 }] },
  layer_transitions: [{ net: '/A', via_positions: [{ x: 0, y: 0 }] }, { net: '/B', via_positions: [{ x: 5, y: 0 }] }] });
const transitionNets = (doc: Tree) => (plainJson(doc.get('layer_transitions')) as { net: string }[]).map(item => item.net);

test('an unstitched exempt net becomes a gate finding; a stitched one stays for kicad-happy', () => {
  const open = transitionDoc();
  assert.deepEqual(takeExemptTransitions(open, new Set(['/A'])).map(finding => [finding.rule_id, finding.nets]), [['RP-001', ['/A']]]);
  assert.deepEqual(transitionNets(open), ['/B']);
  const stitched = transitionDoc();
  assert.deepEqual(takeExemptTransitions(stitched, new Set(['/B'])), []);
  assert.deepEqual(transitionNets(stitched), ['/A', '/B']);
  const untouched = jsonDumps(transitionDoc());
  const none = transitionDoc();
  assert.deepEqual(takeExemptTransitions(none, new Set()), []);
  assert.equal(jsonDumps(none), untouched);
});

const creditDoc = () => tree({ nets: { 1: 'GND', 2: '/A', 3: '/B' }, zones: [{ net_name: 'GND', clearance: 0.3 }],
  net_classes: [{ name: 'Default', clearance: 0.2 }], vias: { vias: [] },
  return_path_continuity: [{ net: '/A', samples_checked: 2, samples_with_reference_plane: 1, reference_plane_coverage_pct: 50.5 }] });
const HOLES: Pad[] = [
  { net_name: '/A', type: 'thru_hole', shape: 'circle', abs_x: 0, abs_y: 0, width: 3, height: 3 },
  { net_name: '/B', type: 'thru_hole', shape: 'circle', abs_x: 10, abs_y: 0, width: 3, height: 3 },
];
const samples = (x: number, y: number): Sample[] => [{ net: '/A', x: 5, y: 0, hit: true }, { net: '/A', x, y, hit: false }];
const credit = (doc: Tree, list: Sample[], pads: Pad[]) =>
  creditOwnHoles(doc, list, pads).map(({ net, pct }) => [net, pct]);

test('a miss in the antipad of the own through-hole pad is covered', () => {
  const doc = creditDoc();
  assert.deepEqual(credit(doc, samples(0.5, 0), HOLES), [['/A', 100]]);
  assert.deepEqual(plainJson(doc.get('return_path_continuity')), []);
});

test('a miss at another hole, in a void or past the clearance stays a gap', () => {
  for (const [x, y] of [[10.5, 0], [20, 0], [1.85, 0]] as const) {
    const doc = creditDoc();
    assert.deepEqual(credit(doc, samples(x, y), HOLES), []);
    assert.equal(jsonDumps(doc), jsonDumps(creditDoc()));
  }
});

test('a rectangular pad corner is measured to the rectangle', () => {
  const pads: Pad[] = [{ net_name: '/A', type: 'thru_hole', shape: 'rect', abs_x: 0, abs_y: 0, width: 1, height: 1 }];
  assert.deepEqual(credit(creditDoc(), samples(0.75, 0), pads), [['/A', 100]]);
  assert.deepEqual(credit(creditDoc(), samples(0.75, 0.75), pads), []);
});

test('an SMD pad gets no credit; a via uses the net class clearance', () => {
  assert.deepEqual(credit(creditDoc(), samples(0.5, 0), [{ ...HOLES[0]!, type: 'smd' }]), []);
  const doc = tree({ ...(plainJson(creditDoc()) as object),
    net_classes: [{ name: 'Default', clearance: 0.2 }, { name: 'CELL', clearance: 0.5, nets: ['/A'] }],
    vias: { vias: [{ x: 0, y: 0, size: 1.4, net: 2 }] } });
  assert.deepEqual(credit(doc, samples(1.1, 0), []), [['/A', 100]]);
});

test('a partial credit updates the coverage, as a float', () => {
  const doc = tree({ ...(plainJson(creditDoc()) as object),
    return_path_continuity: [{ net: '/A', samples_checked: 4, samples_with_reference_plane: 2, reference_plane_coverage_pct: 50.5 }] });
  const list = [...samples(0.5, 0), { net: '/A', x: 5, y: 1, hit: true }, { net: '/A', x: 20, y: 0, hit: false }];
  assert.deepEqual(credit(doc, list, HOLES), [['/A', 75]]);
  assert.ok(jsonDumps(doc.get('return_path_continuity')).includes('"samples_with_reference_plane": 3, "reference_plane_coverage_pct": 75.0'));
});

test('the document goes back to kicad-happy with its floats and key order', () => {
  const text = '{"nets": {"10": "A", "2": "B"}, "width": 1.0, "n": 1, "vias": {"vias": []}}';
  const doc = jsonLoads(text) as Tree;
  takeReturnStitched(doc, 2, []);
  assert.equal(jsonDumps(doc), '{"nets": {"10": "A", "2": "B"}, "width": 1.0, "n": 1, "vias": {"vias": []}, "layer_transitions": []}');
});

const STACK = '(kicad_pcb (setup (stackup (layer "F.Cu" (type "copper") (thickness 0.035))'
  + ' (layer "dielectric 1" (type "prepreg") (thickness 0.2104)) (layer "In1.Cu" (type "copper") (thickness 0.0152))'
  + ' (layer "dielectric 2" (type "core") (thickness 1.065)) (layer "In2.Cu" (type "copper") (thickness 0.0152))'
  + ' (layer "dielectric 3" (type "prepreg") (thickness 0.2104)) (layer "B.Cu" (type "copper") (thickness 0.035))'
  + ' (copper_finish "ENIG"))))';

function radiusFiles(adjacent: Record<string, string>) {
  const dir = folder();
  writeFileSync(join(dir, 'b.kicad_pcb'), STACK);
  writeFileSync(join(dir, 'p.json'), JSON.stringify({ adjacent }));
  return [join(dir, 'b.kicad_pcb'), join(dir, 'p.json')] as const;
}

test('the return radius comes from the core between the planes (D-138)', () => {
  assert.equal(returnRadius(...radiusFiles({ 'F.Cu': 'In1.Cu', 'B.Cu': 'In2.Cu' })), 2.13);
});

test('one plane or a missing spec gives no radius', () => {
  const [pcb, planes] = radiusFiles({ 'F.Cu': 'In1.Cu', 'B.Cu': 'In1.Cu' });
  assert.equal(returnRadius(pcb, planes), null);
  assert.equal(returnRadius(pcb, `${planes}.missing`), null);
});

test('a transition drops only when every via is stitched; a ground through-hole pad counts', () => {
  const doc = tree({ nets: { 1: 'GND', 2: 'S' }, vias: { vias: [{ x: 0, y: 0, net: 1 }] },
    layer_transitions: [{ net: 'S', via_positions: [{ x: 2, y: 0 }] }, { net: 'S', via_positions: [{ x: 2, y: 0 }, { x: 5, y: 0 }] }] });
  const pads: Pad[] = [{ type: 'thru_hole', net_name: 'GND', abs_x: 9, abs_y: 0 }];
  assert.equal(takeReturnStitched(doc, 2.13, []), 1);
  assert.equal(takeReturnStitched(doc, 2.13, pads), 0);
  assert.equal(takeReturnStitched(doc, 4.1, pads), 1);
});

test('resolveBoard takes a file or a folder with one board, and finds the root schematic', () => {
  const dir = folder();
  writeFileSync(join(dir, 'x.kicad_pcb'), '');
  writeFileSync(join(dir, 'x.kicad_sch'), '');
  writeFileSync(join(dir, 'sheet.kicad_sch'), '');
  assert.deepEqual(resolveBoard(join(dir, 'x.kicad_pcb')), { pcb: join(dir, 'x.kicad_pcb'), sch: join(dir, 'x.kicad_sch') });
  assert.deepEqual(resolveBoard(dir).sch, join(dir, 'x.kicad_sch'));
  writeFileSync(join(dir, 'y.kicad_pcb'), '');
  assert.throws(() => resolveBoard(dir), /Expected exactly one \.kicad_pcb in .*, found 2\./);
  assert.throws(() => resolveBoard(folder()), /found 0\./);
  assert.throws(() => resolveBoard('/no/such'), /is not a \.kicad_pcb file or a directory/);
});

test('an empty or error report is refused; an empty error field is not an error', () => {
  for (const doc of [{}, { findings: [], error: 'internal failure' }, { findings: [null] }, null, []]) {
    assert.throws(() => checkReport('analyze.py', doc), /analyze\.py produced an incomplete or error report/);
  }
  assert.deepEqual(checkReport('analyze.py', { findings: [], error: '', errors: [] }).findings, []);
});

test('a missing clone is reported', () => {
  assert.match(checkPinned('/no/such/clone') ?? '', /kicad-happy clone not found at \/no\/such\/clone/);
});

// Whole runs with a fake python and a fake git: nothing of kicad-happy, and no Python, runs here.
const FAKE_PYTHON = `#!/bin/sh
echo "$@" >> "$FAKE_DIR/calls"
if [ "$1" = -c ]; then printf '[]' > "$5"; exit 0; fi
script=$(basename "$1")
[ "$FAKE_CRASH" = "$script" ] && { echo crashed >&2; exit 3; }
board=$2
while [ $# -gt 1 ]; do [ "$1" = -o ] && out=$2; shift; done
case "$script" in
  analyze_pcb.py) printf '{"samples": []}' > "$(dirname "$board")/gp001_debug.json"; printf '{"findings": [], "nets": {}}' > "$out";;
  analyze_emc.py) cp "$FAKE_DIR/emc.json" "$out";;
  *) printf '{"findings": []}' > "$out";;
esac
`;

function fakeRun(emc: Finding[], args: string[] = [], env: Record<string, string> = {}) {
  const dir = folder();
  mkdirSync(join(dir, 'bin'));
  mkdirSync(join(dir, 'happy'));
  mkdirSync(join(dir, 'board'));
  writeFileSync(join(dir, 'board/x.kicad_pcb'), '(kicad_pcb)\n');
  writeFileSync(join(dir, 'emc.json'), JSON.stringify({ findings: emc }));
  writeFileSync(join(dir, 'bin/python'), FAKE_PYTHON);
  writeFileSync(join(dir, 'bin/git'), '#!/bin/sh\necho a6bba1a0000000000000000000000000000000\n');
  chmodSync(join(dir, 'bin/python'), 0o755);
  chmodSync(join(dir, 'bin/git'), 0o755);
  const result = join(dir, 'result.json');
  const run = spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', PROGRAM, join(dir, 'board'), '--result', result, ...args], {
    encoding: 'utf8',
    env: { ...process.env, PATH: `${join(dir, 'bin')}:${process.env.PATH}`, PYTHON_MODERN: join(dir, 'bin/python'),
      KICAD_HAPPY_DIR: join(dir, 'happy'), FAKE_DIR: dir, ...env },
  });
  return { run, dir, result };
}

test('a clean run exits 0 and writes the completion report', () => {
  const { run, result, dir } = fakeRun([]);
  assert.equal(run.stderr, '');
  assert.equal(run.status, 0);
  assert.equal(run.stdout, '0 kicad-happy findings (rules RP-001,DC-002,UC-001)\n');
  assert.equal(readFileSync(result, 'utf8'), '{"schema_version": 1, "completed": true, "findings": 0, "stale_exemptions": 0, "exit": 0}');
  assert.match(readFileSync(join(dir, 'calls'), 'utf8'), /^.*analyze_pcb\.py .*--full --gp001-debug -o .*\n-c import json, sys\n/m);
});

test('a finding of a gated rule exits 1 and an ignored rule does not', () => {
  const found = fakeRun([{ rule_id: 'RP-001', summary: 'no via' }, { rule_id: 'KO-001', summary: 'ignored' }]);
  assert.equal(found.run.status, 1);
  assert.equal(found.run.stdout, 'FAIL RP-001 no via\n1 kicad-happy findings (rules RP-001,DC-002,UC-001)\n');
  assert.equal(fakeRun([{ rule_id: 'KO-001', summary: 'ignored' }]).run.status, 0);
});

test('an analyzer crash exits 2 and writes no completion report', () => {
  const { run, result } = fakeRun([], [], { FAKE_CRASH: 'analyze_emc.py' });
  assert.equal(run.status, 2);
  assert.match(run.stderr, /^ERROR: skills\/emc\/scripts\/analyze_emc\.py failed \(exit 3\): crashed\n$/);
  assert.throws(() => readFileSync(result));
});

test('a bad exempt file exits 2 before any analysis', () => {
  const bad = join(folder(), 'exempt.json');
  writeFileSync(bad, JSON.stringify([{ rule: 'GP-001', net: '/A' }]));
  const { run, dir } = fakeRun([], ['--exempt-file', bad]);
  assert.equal(run.status, 2);
  assert.match(run.stderr, /^ERROR: exempt entry 0: reason is required\n$/);
  assert.throws(() => readFileSync(join(dir, 'calls')));
});

test('a bad severity is a usage error', () => {
  assert.equal(fakeRun([], ['--min-severity', 'loud']).run.status, 2);
});
