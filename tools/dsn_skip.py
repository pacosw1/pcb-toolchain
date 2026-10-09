"""Fastroute exclusions without deleting electrical pin membership.

Apply after all rule/layer/padstack transformations. Ignored subclasses inherit
every class property and class_class rule; the original DSN outside network is
byte preserved. Unsupported network forms fail before the router starts.
"""
import re


def exclude(text, routed):
    start = text.index('(network')
    # Only parse network: KiCad's parser section has a bare string_quote token.
    tokens = list(re.finditer(r'"(?:[^"\\]|\\.)*"|[()]|[^\s()"]+', text[start:]))
    stack, root = [], None
    for token in tokens:
        value = token.group()
        pos = start + token.start()
        if value == '(':
            node = [pos, None, []]
            if stack:
                stack[-1][2].append(node)
            stack.append(node)
        elif value == ')':
            if not stack:
                raise ValueError('unbalanced DSN network')
            node = stack.pop()
            node[1] = start + token.end()
            if not stack:
                root = node
                break
        else:
            if not stack:
                raise ValueError('invalid DSN network')
            stack[-1][2].append((pos, start + token.end(), value))
    if root is None:
        raise ValueError('unterminated DSN network')
    def atoms(node):
        return [x for x in node[2] if isinstance(x, tuple)]
    def name(atom):
        return atom[2][1:-1] if atom[2].startswith('"') else atom[2]
    def kind(node):
        return atoms(node)[0][2]
    children = [x for x in root[2] if isinstance(x, list)]
    classes = [x for x in children if kind(x) == 'class']
    declared = {name(atoms(x)[1]) for x in children if kind(x) == 'net'}
    missing = set(routed) - declared
    if missing:
        raise ValueError(f'routed nets absent from DSN: {sorted(missing)}')
    skipped = declared - set(routed)
    covered, replacements, additions, aliases = set(), [], [], {}
    existing = {name(atoms(x)[1]) for x in classes}
    for index, node in enumerate(classes):
        aa = atoms(node)
        old = name(aa[1])
        members = aa[2:]
        ignored = [x for x in members if name(x) in skipped]
        if not ignored:
            continue
        assigned = {name(x) for x in ignored}
        if assigned & covered:
            raise ValueError('skipped net belongs to multiple DSN classes')
        covered |= assigned
        alias = f'IOT_SKIP_{index}'
        if alias.casefold() in {x.casefold() for x in existing}:
            raise ValueError('reserved ignored class name already present')
        aliases[old] = alias
        # Preserve nested circuit/rule properties verbatim in the dedicated class.
        nested = [x for x in node[2] if isinstance(x, list)]
        tail_start = nested[0][0] if nested else node[1] - 1
        tail = text[tail_start:node[1]]
        additions.append('(class ' + alias + ' ' + ' '.join(x[2] for x in ignored) + '\n' + tail)
        for atom in ignored:
            replacements.append((atom[0], atom[1], ''))
    if covered != skipped:
        raise ValueError(f'skipped nets lack explicit DSN class: {sorted(skipped - covered)}')
    # Copy pairwise rules to every original/ignored combination, keeping values.
    for node in children:
        if kind(node) != 'class_class':
            continue
        nested = [x for x in node[2] if isinstance(x, list)]
        groups = [x for x in nested if kind(x) == 'classes']
        if len(groups) != 1 or len(atoms(groups[0])) != 3:
            raise ValueError('unsupported DSN class_class form')
        left, right = atoms(groups[0])[1:]
        for x in (left[2], aliases.get(name(left))):
            for y in (right[2], aliases.get(name(right))):
                if x is None or y is None or (x == left[2] and y == right[2]):
                    continue
                raw = text[node[0]:node[1]]
                for atom, value in sorted(((left, x), (right, y)), reverse=True):
                    a, b = atom[0] - node[0], atom[1] - node[0]
                    raw = raw[:a] + value + raw[b:]
                additions.append(raw)
    if additions:
        replacements.append((root[1] - 1, root[1] - 1, '\n' + '\n'.join(additions) + '\n'))
    for a, b, value in sorted(replacements, reverse=True):
        text = text[:a] + value + text[b:]
    return text, sorted(aliases.values())


def routable_open(report):
    stats = report.get('stats', {})
    total, ignored = stats.get('unrouted'), stats.get('unrouted_ignored_classes')
    if type(total) is not int or type(ignored) is not int or not 0 <= ignored <= total:
        raise ValueError('invalid router ignored-net accounting')
    return total - ignored
