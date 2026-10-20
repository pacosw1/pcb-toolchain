"""Find the workflow test's local runtime sources without importing native tools.

Discovery is cached for one immutable test-process source tree. Every fixture
still receives ordinary, independent files; neither CAD nor tools are shared.
"""
import ast
from functools import lru_cache
from pathlib import Path


@lru_cache(maxsize=1)
def workflow_runtime_files(source):
    source = Path(source).resolve()
    queue = [source / name for name in ('pcb_cli.py', 'pcb_operations.py')]
    found = {source / 'pcb_snapshot_inputs.mjs'}
    # Retain the existing conservative JS library boundary, excluding tests.
    # The synthetic gate never executes its Python checkers: PcbCliTests owns
    # that fake executable and this fixture supplies its own pcbtool writer.
    found.update(p for p in (source / 'lib').glob('*.mjs') if not p.name.endswith('.test.mjs'))

    def module(name):
        parts = name.split('.')
        for count in range(1, len(parts) + 1):
            base = source.joinpath(*parts[:count])
            for candidate in (base.with_suffix('.py'), base / '__init__.py'):
                if candidate.is_file():
                    queue.append(candidate)

    while queue:
        path = queue.pop().resolve()
        if path in found or path == source / 'pcbtool.py':
            continue  # The controlled writer is created inside each fixture.
        if not path.is_relative_to(source):
            raise ValueError('fixture runtime source escapes tools: ' + str(path))
        found.add(path)
        package = list(path.relative_to(source).parts[:-1])
        for node in ast.walk(ast.parse(path.read_text(), filename=str(path))):
            if isinstance(node, ast.Import):
                for alias in node.names:
                    module(alias.name)
            elif isinstance(node, ast.ImportFrom):
                if node.level:
                    if node.level > len(package):
                        raise ValueError('fixture relative import escapes its package: ' + str(path))
                    base = package[:len(package) - node.level + 1]
                    name = '.'.join(base + (node.module.split('.') if node.module else []))
                else:
                    name = node.module or ''
                if name:
                    module(name)
                for alias in node.names:
                    if alias.name != '*':
                        module('.'.join(filter(None, (name, alias.name))))
            elif (isinstance(node, ast.Constant) and isinstance(node.value, str)
                  and '\n' not in node.value and node.value.endswith(('.py', '.mjs', '.json'))):
                # Include named subprocess/hash-policy sources and JSON assets,
                # including implementation/escape lists, as well as imports.
                target = (source / node.value.removeprefix('tools/')).resolve()
                if target.is_relative_to(source) and target.is_file():
                    if target.suffix == '.py':
                        queue.append(target)
                    else:
                        found.add(target)
    return tuple(sorted(found))
