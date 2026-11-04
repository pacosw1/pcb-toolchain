// The one KiCad s-expression reader/writer of the engine. Port of engine/src/pcbstudio/kicad/sexpr.py.
//
// Model: a list is an array; a quoted string is a JS string; an unquoted token (keyword, number, yes/no) is a Sym,
// which keeps its exact text so numbers round-trip unchanged. `.kicad_dru` files hold several top-level forms and
// `#` comments; parseMany returns all forms.
//
// Format preserving: parse returns SList nodes that remember their source text. dumps writes every part of the tree
// that was not changed as the original text (whitespace, comments, string escapes, number text), so
// dumps(parse(t)) === t and dumpsMany(parseMany(t)) === t. Edit the tree as plain arrays: only the changed tokens are
// written new. A new array (not from a parse) gets KiCad-like layout, indented to fit where it goes. Numbers may be
// set as JS numbers; they are written in KiCad's short form.

export class Sym {
  readonly text: string
  constructor(text: string) { this.text = text }
  toString(): string { return this.text }
}

export type Atom = string | Sym | number | boolean
export type Node = Atom | Node[]

export class SexprError extends Error {}

/** A parsed list. spans holds the (start, end) offsets of each original child, flat; orig the original children. */
export class SList extends Array<Node> {
  static get [Symbol.species](): ArrayConstructor { return Array }
  src = ''
  open = -1
  close = 0
  spans: number[] = []
  orig: Node[] | undefined = undefined
  lead: string | undefined = undefined              // text before and after a top-level form from parse
  trail: string | undefined = undefined
}

/** The result of parseMany: top-level forms and the text between them (comments in rule files). */
export class Forms extends SList {}

const isList = (x: Node | undefined): x is Node[] => Array.isArray(x)

// Python's str whitespace, not JS \s: the two differ on U+FEFF and U+001C-1F, U+0085.
function isSpace(c: number): boolean {
  if (c < 0x80) return c === 32 || (c >= 9 && c <= 13) || (c >= 28 && c <= 31)
  return c === 0x85 || c === 0xa0 || c === 0x1680 || (c >= 0x2000 && c <= 0x200a) || c === 0x2028 || c === 0x2029 ||
         c === 0x202f || c === 0x205f || c === 0x3000
}

const UNESCAPE: Record<string, string> = { n: '\n', t: '\t', r: '\r', '"': '"', '\\': '\\' }

function unquote(s: string): string {
  const body = s.slice(1, -1)
  if (!body.includes('\\')) return body
  return body.replace(/\\(.)/gs, (_, c: string) => UNESCAPE[c] ?? '\\' + c)
}

const OPEN = 40, CLOSE = 41, QUOTE = 34, BACKSLASH = 92, HASH = 35, NEWLINE = 10

/** `#` starts a comment only in rule files (comments=true); elsewhere it is ordinary token text. */
export function parseMany(text: string, comments = true): Forms {
  const top = new Forms()
  top.src = text
  const stack: [SList, number[]][] = [[top, []]]
  const n = text.length
  let pos = 0
  while (pos < n) {
    const c = text.charCodeAt(pos)
    const [list, spans] = stack[stack.length - 1]
    if (isSpace(c)) { pos += 1; continue }
    if (comments && c === HASH) {
      while (pos < n && text.charCodeAt(pos) !== NEWLINE) pos += 1
    } else if (c === OPEN) {
      const node = new SList()
      node.src = text
      node.open = pos
      spans.push(pos)
      stack.push([node, []])
      pos += 1
    } else if (c === CLOSE) {
      if (stack.length === 1) throw new SexprError(`unbalanced ) at offset ${pos}`)
      const [node, own] = stack.pop()!
      node.close = pos
      node.spans = own
      node.orig = Array.from(node)
      const [parent, parentSpans] = stack[stack.length - 1]
      parent.push(node)
      pos += 1
      parentSpans.push(pos)
    } else if (c === QUOTE) {
      let end = pos + 1
      while (end < n && text.charCodeAt(end) !== QUOTE) end += text.charCodeAt(end) === BACKSLASH ? 2 : 1
      if (end >= n) throw new SexprError(`unexpected character '"' at offset ${pos}`)
      end += 1
      list.push(unquote(text.slice(pos, end)))
      spans.push(pos, end)
      pos = end
    } else {
      let end = pos + 1
      while (end < n) {
        const d = text.charCodeAt(end)
        if (d === OPEN || d === CLOSE || d === QUOTE || isSpace(d)) break
        end += 1
      }
      list.push(new Sym(text.slice(pos, end)))
      spans.push(pos, end)
      pos = end
    }
  }
  if (stack.length !== 1) throw new SexprError('unbalanced (: missing ) at end of input')
  top.close = n
  top.spans = stack[0][1]
  top.orig = Array.from(top)
  return top
}

/** One top-level form (a .kicad_pcb / .kicad_sch / .kicad_sym / .kicad_mod file). '#' is ordinary text here. */
export function parse(text: string): SList {
  const forms = parseMany(text, false)
  const root = forms[0]
  if (forms.length !== 1 || !(root instanceof SList)) {
    throw new SexprError(`expected one top-level list, got ${forms.length} forms`)
  }
  root.lead = text.slice(0, root.open)
  root.trail = text.slice(root.close + 1)
  return root
}

// ---------------------------------------------------------------- writer
const quote = (s: string): string => '"' + s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n') + '"'

/** toFixed(6), except that an exact tie rounds to even as Python does (toFixed rounds it away from zero). */
export function fixed6(v: number): string {
  const exact = v.toFixed(30)
  const dot = exact.indexOf('.')
  if (/^50*$/.test(exact.slice(dot + 7))) {
    const down = exact.slice(0, dot + 7)
    if (Number(down[down.length - 1]) % 2 === 0) return down
  }
  return v.toFixed(6)
}

/** KiCad's number form: at most 6 decimals, no trailing zeros, no '-0'. */
export function fmtNum(v: number | boolean): string {
  if (typeof v === 'boolean') return v ? 'yes' : 'no'
  if (Number.isInteger(v)) return String(v)
  const s = fixed6(v).replace(/0+$/, '').replace(/\.$/, '')
  return s === '-0' || s === '' ? '0' : s
}

function atom(x: Atom): string {
  if (x instanceof Sym) return x.text
  if (typeof x === 'string') return quote(x)
  return fmtNum(x)
}

/** Output pieces; adjacent source ranges merge, so an unchanged subtree costs one slice. */
class Out {
  parts: string[] = []
  src: string | null = null
  a = 0
  b = 0

  span(src: string, a: number, b: number): void {
    if (a >= b) return
    if (this.src === src && this.b === a) { this.b = b; return }
    this.flush()
    this.src = src
    this.a = a
    this.b = b
  }

  text(s: string): void {
    if (s) { this.flush(); this.parts.push(s) }
  }

  flush(): void {
    if (this.src !== null) { this.parts.push(this.src.slice(this.a, this.b)); this.src = null }
  }

  value(): string {
    this.flush()
    return this.parts.join('')
  }
}

function indentOf(gap: string, fallback: number): number {
  const at = gap.lastIndexOf('\n')
  return at < 0 ? fallback : gap.slice(at + 1).split('\t').length - 1
}

/** Same list object, or the same atom of the same kind (quoted and unquoted stay apart). */
function sameItem(a: Node | undefined, b: Node | undefined): boolean {
  if (a === b) return true
  return a instanceof Sym && b instanceof Sym && a.text === b.text
}

function write(node: Node, indent: number, out: Out): void {
  if (!isList(node)) out.text(atom(node))
  else if (node instanceof SList && node.orig) writeSrc(node, indent, out)
  else writeNew(node, indent, out)
}

/** KiCad-like layout: a list whose children are all atoms stays on one line; otherwise each child list goes on its
 *  own line, indented by one tab. */
function writeNew(node: Node[], indent: number, out: Out): void {
  if (!node.some(isList)) {
    out.text('(' + (node as Atom[]).map(atom).join(' ') + ')')
    return
  }
  let i = 0
  const head: string[] = []
  while (i < node.length && !isList(node[i])) head.push(atom(node[i++] as Atom))
  out.text('(' + head.join(' '))
  const pad = '\n' + '\t'.repeat(indent + 1)
  for (const c of node.slice(i)) {
    out.text(pad)
    write(c, indent + 1, out)
  }
  out.text('\n' + '\t'.repeat(indent) + ')')
}

function writeSrc(node: SList, indent: number, out: Out): void {
  const { src, spans, open: o, close: c } = node
  const orig = node.orig!
  const doc = node instanceof Forms
  if (node.length === orig.length && node.every((x, k) => sameItem(x, orig[k]))) {
    // the same children in the same places: source text, recursing only into child lists
    if (!node.some(isList)) {
      out.span(src, doc ? o + 1 : o, doc ? c : c + 1)
      return
    }
    if (!doc) out.span(src, o, o + 1)
    let prev = o + 1
    for (let k = 0; k < node.length; k++) {
      const x = node[k], start = spans[2 * k], end = spans[2 * k + 1]
      if (isList(x)) {
        out.span(src, prev, start)
        write(x, indentOf(src.slice(prev, start), indent + 1), out)
      } else {
        out.span(src, prev, end)
      }
      prev = end
    }
    out.span(src, prev, doc ? c : c + 1)
    return
  }
  // structure changed: match each child to an original one (lists by identity, atoms by position)
  const starts = spans.filter((_, k) => k % 2 === 0), ends = spans.filter((_, k) => k % 2 === 1)
  const gaps = orig.map((_, j) => src.slice(j ? ends[j - 1] : o + 1, starts[j]))
  const byId = new Map<Node, number>()
  orig.forEach((x, j) => { if (isList(x)) byId.set(x, j) })
  const firstList = orig.findIndex(isList)
  let lastListGap: string | null = firstList >= 0 ? gaps[firstList] : null
  if (!doc) out.text('(')
  node.forEach((x, i) => {
    if (isList(x)) {
      const j = byId.get(x)
      let gap: string
      if (j !== undefined) gap = lastListGap = gaps[j]
      else gap = lastListGap ?? (doc ? '\n' : ' ')
      out.text(gap)
      write(x, indentOf(gap, indent + 1), out)
    } else if (i < orig.length && !isList(orig[i])) {
      out.text(gaps[i])
      if (sameItem(orig[i], x)) out.span(src, starts[i], ends[i])
      else out.text(atom(x))
    } else {
      out.text(i === 0 && !doc ? '' : ' ')
      out.text(atom(x))
    }
  })
  out.text(src.slice(orig.length ? ends[ends.length - 1] : o + 1, c))
  if (!doc) out.text(')')
}

/** Text of a node. A top-level form from parse also gets back the text around it in its file, so
 *  dumps(parse(t)) === t. */
export function dumps(node: Node, indent = 0): string {
  const out = new Out()
  const whole = node instanceof SList && node.lead !== undefined
  if (whole) out.text(node.lead!)
  write(node, indent, out)
  if (whole) out.text(node.trail!)
  return out.value()
}

export function dumpsMany(forms: Node[]): string {
  if (forms instanceof Forms) return dumps(forms)
  return forms.map(f => dumps(f)).join('\n') + '\n'
}

// ---------------------------------------------------------------- queries
const name = (x: Node | undefined): string | undefined =>
  x instanceof Sym ? x.text : typeof x === 'string' ? x : undefined

export function head(node: Node): string | undefined {
  return isList(node) ? name(node[0]) : undefined
}

export function children(node: Node[], key: string): Node[][] {
  return node.filter((c): c is Node[] => isList(c) && name(c[0]) === key)
}

export function child(node: Node[], key: string): Node[] | undefined {
  return node.find((c): c is Node[] => isList(c) && name(c[0]) === key)
}

/** (name v) -> v. */
export function value(node: Node[], key: string, fallback?: Node): Node | undefined {
  const c = child(node, key)
  return c !== undefined && c.length > 1 ? c[1] : fallback
}
