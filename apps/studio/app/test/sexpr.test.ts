// Port of engine/tests/test_sexpr.py, plus number and whitespace cases. Run: node --test test/
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { Forms, SexprError, Sym, child, dumps, dumpsMany, fmtNum, parse, parseMany, value } from '../src/main/kicad/sexpr.ts'
import type { Node } from '../src/main/kicad/sexpr.ts'

const CORPUS = process.env.PCBSTUDIO_CORPUS ?? path.join(os.homedir(), 'code/iot-lab')
const SKIP = ['node_modules', '/.claude/', '/.gate/']
const S = (x: string): Sym => new Sym(x)

/** Plain data for comparison: Sym -> {sym: text}, so quoted and unquoted stay apart. */
const plain = (x: Node): unknown => Array.isArray(x) ? x.map(plain) : x instanceof Sym ? { sym: x.text } : x
const same = (a: Node, b: Node): void => assert.deepEqual(plain(a), plain(b))
const syms = (x: Node[]): unknown => plain(x)

test('atoms, strings and escapes', () => {
  const t = parse('(kicad_pcb (version 20260101) (net "A \\"q\\" \\\\ b") (at 1.50 -2) (layer F.Cu) (x "#PWR01"))')
  assert.ok(t[0] instanceof Sym && t[0].text === 'kicad_pcb')
  const version = value(t, 'version')
  assert.ok(version instanceof Sym && version.text === '20260101')
  assert.equal(value(t, 'net'), 'A "q" \\ b')
  assert.deepEqual(syms(child(t, 'at')!), [{ sym: 'at' }, { sym: '1.50' }, { sym: '-2' }])   // exact number text
  assert.equal(value(t, 'x'), '#PWR01')
  same(parse(dumps(t)), t)
})

test('# is text outside rule files', () => {
  const t = parse('(lib (sym #PWR (a b)) (c d))')
  assert.deepEqual(syms(t[1] as Node[]), [{ sym: 'sym' }, { sym: '#PWR' }, [{ sym: 'a' }, { sym: 'b' }]])
})

test('rule file comments and many forms', () => {
  const forms = parseMany('(version 1)\n# comment (with parens)\n(rule "x" (condition "A.NetClass == \'USB\'")) # tail\n')
  assert.deepEqual(forms.map(f => String((f as Node[])[0])), ['version', 'rule'])
  same(parseMany(dumpsMany(forms)), forms)
})

for (const bad of ['(a (b)', '(a))', '(a "unterminated)']) {
  test(`error: ${bad}`, () => assert.throws(() => parse(bad), SexprError))
}

const PCB = `(kicad_pcb
\t(version 20260206)
\t(footprint "R_0603"
\t\t(layer "F.Cu")
\t\t(at 10.5 20.25 90)
\t\t(property "Reference" "R1" (at 0 -1.43 90))
\t\t(pad "1" smd roundrect (at -0.79 0 90) (size 0.9 0.95) (layers "F.Cu"))
\t)
\t# not a comment in a board file
)
`

test('an unchanged dump is identical and one edit changes one line', () => {
  const root = parse(PCB)
  assert.equal(dumps(root), PCB)
  const at = child(child(root, 'footprint')!, 'at')!
  at[1] = 12.0
  at[2] = S('21.5')
  const a = PCB.split('\n'), b = dumps(root).split('\n')
  assert.equal(b.length, a.length)
  assert.deepEqual(a.flatMap((x, i) => x === b[i] ? [] : [[x, b[i]]]), [['\t\t(at 10.5 20.25 90)', '\t\t(at 12 21.5 90)']])
})

test('insert and delete keep neighbour formatting', () => {
  const root = parse(PCB)
  const fp = child(root, 'footprint')!
  fp.splice(fp.indexOf(child(fp, 'property')!), 1)
  fp.splice(3, 0, [S('attr'), S('smd')])
  const out = dumps(root)
  assert.ok(out.includes('\t\t(attr smd)\n\t\t(at 10.5 20.25 90)\n\t\t(pad "1"'))
  assert.ok(!out.includes('Reference'))
  same(parse(out), root)
  root.push([S('gr_line'), [S('start'), 0, 0], [S('end'), 1.25, 0]])         // laid out at the depth where it goes
  assert.ok(dumps(root).endsWith('\t# not a comment in a board file\n\t(gr_line\n\t\t(start 0 0)\n\t\t(end 1.25 0)\n\t)\n)\n'))
})

test('a rule file keeps its comments', () => {
  const text = '(version 1)\n# comment (with parens)\n(rule "x"\n  (condition "A.NetClass == \'USB\'")) # tail\n'
  const forms = parseMany(text)
  assert.ok(forms instanceof Forms)
  assert.equal(dumpsMany(forms), text)
  child(forms[1] as Node[], 'condition')![1] = 'B'
  assert.equal(dumpsMany(forms), text.replace('"A.NetClass == \'USB\'"', '"B"'))
})

test('numbers match the Python writer', () => {
  const cases: [number | boolean, string][] = [[12, '12'], [12.0, '12'], [1.25, '1.25'], [-0.0000001, '0'], [-0, '0'],
    [0.1 + 0.2, '0.3'], [100, '100'], [1.5000004, '1.5'], [0.0078125, '0.007812'], [-0.0078125, '-0.007812'],
    [0.0234375, '0.023438'], [true, 'yes'], [false, 'no']]
  for (const [v, want] of cases) assert.equal(fmtNum(v), want, String(v))
})

test('whitespace is the Python set: a BOM is token text, U+001C is space', () => {
  assert.equal(String(parseMany('﻿(a)')[0]), '﻿')
  assert.equal(parse('(a\u001cb)').length, 2)
})

test('array methods on a parsed list return plain arrays', () => {
  assert.ok(!(parse('(a b)').slice(0) instanceof Forms))
  assert.equal(parse('(a b c)').filter(x => String(x) !== 'b').length, 2)
})

function corpus(exts: string[]): string[] {
  const out: string[] = []
  const walk = (dir: string): void => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name)
      if (SKIP.some(s => (p + '/').includes(s))) continue
      if (e.isDirectory()) walk(p)
      else if (exts.includes(path.extname(p))) out.push(p)
    }
  }
  walk(CORPUS)
  return out
}

test('real project files round-trip byte for byte', { skip: !fs.existsSync(CORPUS) }, () => {
  const files = corpus(['.kicad_pcb', '.kicad_sch', '.kicad_sym', '.kicad_mod', '.kicad_dru'])
  assert.ok(files.length > 1500, `${files.length} files`)
  const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })
  const failures: string[] = []
  for (const p of files) {
    const raw = fs.readFileSync(p)
    try {
      const text = decoder.decode(raw)
      const out = p.endsWith('.kicad_dru') ? dumpsMany(parseMany(text)) : dumps(parse(text))
      if (!Buffer.from(out).equals(raw)) failures.push(`${p}: round trip differs`)
    } catch (e) { failures.push(`${p}: ${e}`) }
  }
  assert.equal(failures.length, 0, `${failures.length} of ${files.length} failed:\n${failures.slice(0, 20).join('\n')}`)
  console.log(`corpus: ${files.length} files`)
})
