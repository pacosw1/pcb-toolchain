"""The native s-expression reader the route coverage tools still use. Rule parsing is core/src/dru.rs. TS: lib/sexpr.ts."""
import re


def _tokens(text):
    text = '\n'.join(line for line in text.splitlines() if not line.lstrip().startswith('#'))
    return re.findall(r'"(?:[^"\\]|\\.)*"|\(|\)|[^\s()]+', text)


def _tree(tokens):
    stack = [[]]
    for t in tokens:
        if t == '(':
            stack.append([])
        elif t == ')':
            x = stack.pop()
            stack[-1].append(x)
        else:
            stack[-1].append(t[1:-1] if t.startswith('"') else t)
    return stack[0]
