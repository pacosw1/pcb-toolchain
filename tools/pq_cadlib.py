"""Small KiCad s-expression reader used for verified library imports, not symbol drawing."""
import copy
import json
import re


class Atom(str):
    pass


def parse(text):
    tokens = re.findall(r'\(|\)|"(?:\\.|[^"\\])*"|[^\s()]+', text)
    stack, root = [], None
    for token in tokens:
        if token == '(':
            node = []
            if stack:
                stack[-1].append(node)
            else:
                if root is not None:
                    raise ValueError('Multiple root expressions')
                root = node
            stack.append(node)
        elif token == ')':
            stack.pop()
        elif stack:
            stack[-1].append(json.loads(token) if token.startswith('"') else Atom(token))
    if stack or root is None:
        raise ValueError('Unbalanced expression')
    return root


def dump(node, depth=0):
    if not isinstance(node, list):
        return str(node) if isinstance(node, Atom) else json.dumps(node, ensure_ascii=False)
    if not any(isinstance(x, list) for x in node):
        return '(' + ' '.join(dump(x) for x in node) + ')'
    lead, tail = [], []
    for item in node:
        (tail if isinstance(item, list) or tail else lead).append(item)
    return '(' + ' '.join(dump(x) for x in lead) + ''.join('\n' + '  ' * (depth + 1) + dump(x, depth + 1) for x in tail) + ')'


def items(node, kind):
    return [n for n in node if isinstance(n, list) and n and n[0] == kind]


def item(node, kind, default=None):
    return next(iter(items(node, kind)), default)


def walk(node, kind):
    if isinstance(node, list):
        if node and node[0] == kind:
            yield node
        for child in node:
            yield from walk(child, kind)


def library_symbol(path, name=None):
    root = parse(path.read_text())
    candidates = items(root, 'symbol')
    node = next(n for n in candidates if name is None or n[1] == name)
    if item(node, 'extends'):
        base = library_symbol(path, item(node, 'extends')[1])
        base_name = base[1]
        for sub in items(base, 'symbol'):
            sub[1] = sub[1].replace(base_name + '_', node[1] + '_', 1)
        props = {n[1]: n for n in items(base, 'property')}
        props.update({n[1]: n for n in items(node, 'property')})
        base[:] = [n for n in base if not (isinstance(n, list) and n and n[0] == 'property')]
        base[1] = node[1]
        base.extend(props.values())
        node = base
    return copy.deepcopy(node)


def pin_map(symbol):
    result = {}
    for pin in walk(symbol, 'pin'):
        number = item(pin, 'number')[1]
        at = item(pin, 'at')
        result[number] = {'name': item(pin, 'name')[1], 'type': pin[1],
                          'x': float(at[1]), 'y': float(at[2]), 'angle': int(at[3])}
    return result
