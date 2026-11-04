// Read well-formed XML into {tag, attributes: Map, text, children}, for the netlists kicad-cli writes.
// Like ElementTree, text is what comes before the first child. No DTD, no namespaces.
import {PyError} from './py-compat.mjs';

const ENTITIES = {amp: '&', lt: '<', gt: '>', quot: '"', apos: "'"};
const entities = text => text.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|\w+);/g, (whole, name) => {
  if (name[0] !== '#') {
    if (name in ENTITIES) return ENTITIES[name];
    throw new PyError('xml.etree.ElementTree.ParseError', `undefined entity ${whole}`);
  }
  return String.fromCodePoint(Number(name[1] === 'x' ? '0x' + name.slice(2) : name.slice(1)));
});

export function parseXml(text) {
  const bad = message => new PyError('xml.etree.ElementTree.ParseError', message);
  const stack = [];
  let root = null, at = 0;
  const addText = raw => {
    const top = stack.at(-1);
    if (top && !top.children.length) top.text += raw;
  };
  while (at < text.length) {
    const open = text.indexOf('<', at);
    if (open < 0) { addText(entities(text.slice(at))); break; }
    if (open > at) addText(entities(text.slice(at, open)));
    if (text.startsWith('<!--', open)) { at = text.indexOf('-->', open) + 3; if (at < 3) throw bad('unclosed comment'); continue; }
    if (text.startsWith('<?', open)) { at = text.indexOf('?>', open) + 2; if (at < 2) throw bad('unclosed declaration'); continue; }
    if (text.startsWith('<![CDATA[', open)) {
      const end = text.indexOf(']]>', open);
      if (end < 0) throw bad('unclosed CDATA');
      addText(text.slice(open + 9, end)); at = end + 3; continue;
    }
    if (text.startsWith('<!', open)) { at = text.indexOf('>', open) + 1; if (at < 1) throw bad('unclosed declaration'); continue; }
    const tag = /^<(\/?)([^\s/>]+)((?:\s+[^\s=]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>/.exec(text.slice(open));
    if (!tag) throw bad('not well-formed (invalid token)');
    at = open + tag[0].length;
    if (tag[1]) {
      if (stack.pop()?.tag !== tag[2]) throw bad('mismatched tag');
      continue;
    }
    const attributes = new Map([...tag[3].matchAll(/([^\s=]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)].map(m => [m[1], entities(m[2] ?? m[3])]));
    const element = {tag: tag[2], attributes, text: '', children: []};
    if (stack.length) stack.at(-1).children.push(element);
    else if (root) throw bad('junk after document element');
    else root = element;
    if (!tag[4]) stack.push(element);
  }
  if (!root) throw bad('no element found');
  if (stack.length) throw bad('no element found');
  return root;
}
// Element.iter(tag): the element and all below it, in document order.
export function* iter(element, tag) {
  if (element.tag === tag) yield element;
  for (const child of element.children) yield* iter(child, tag);
}
// Element.findtext(tag): the text of the first direct child, else null.
export const findText = (element, tag) => element.children.find(child => child.tag === tag)?.text ?? null;
