// fnmatch.fnmatchcase: shell patterns over the whole name. Part numbers and net names hold '/', which * also matches.
const compiled = new Map<string, RegExp>();

/** A [...] set at `start`, as regular expression text and the index after it; null when it never closes. */
function charSet(pattern: string, start: number): [string, number] | null {
  let end = start;
  if (pattern[end] === '!') end += 1;
  if (pattern[end] === ']') end += 1;
  while (end < pattern.length && pattern[end] !== ']') end += 1;
  if (end >= pattern.length) return null;
  const set = pattern.slice(start, end).replaceAll('\\', '\\\\');
  const body = set.startsWith('!') ? `^${set.slice(1)}` : set.startsWith('^') || set.startsWith('[') ? `\\${set}` : set;
  return [`[${body}]`, end + 1];
}

function translate(pattern: string): RegExp {
  let text = '';
  for (let at = 0; at < pattern.length;) {
    const c = pattern[at] as string;
    at += 1;
    const set = c === '[' ? charSet(pattern, at) : null;
    if (c === '*') text += '[\\s\\S]*';
    else if (c === '?') text += '[\\s\\S]';
    else if (set) [text, at] = [text + set[0], set[1]];
    else text += c.replace(/[.*+?^${}()|[\]\\/-]/g, '\\$&');
  }
  return new RegExp(`^${text}$`);
}

export function fnmatchCase(name: string, pattern: string): boolean {
  let regex = compiled.get(pattern);
  if (!regex) {
    regex = translate(pattern);
    compiled.set(pattern, regex);
  }
  return regex.test(name);
}
