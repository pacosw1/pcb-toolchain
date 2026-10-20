"""Audited parts-observation code boundary, with explicit conservative fallback.

This is not a generic execution tracer. Exact reviewed producers cover their
known subprocess/inline-JavaScript mechanisms; changing them removes the audit.
Other local Python imports are closed recursively, including dormant branches.
"""
import ast
import hashlib
import os
from pathlib import Path
import shutil
import sys
import sysconfig


SCHEMA = 'iot-lab.observation-input-policy.v1'
PARTS_ACTIONS = {'inspect', 'selection', 'verify', 'status'}
COMMON = ('pcb_cli.py', 'pcb_operations.py', 'pcb_evidence.py', 'pcb_workflow.py',
          'pcb_timing.py', 'lean_workflow.py', 'lean_owned.py', 'lean_owned_exec.py')
# These exact sources were reviewed for the parts branch and its known external
# commands. A changed producer still runs, using the previous broad boundary.
# Refresh only after reviewing its execution/dependency changes.
AUDITED = {
    "part_evidence.py": "9177b0ac5c3e038f69e38f144e0795fae485b87c1fb9338b2bf1b03ac227fca0",
    "part_native.py": "9a21ded435da26ccedcb6da845bd9c7cc87b959d5d0a848d325e177b4a400287",
    "pcb_cli.py": "099b7991af3df3169e4ec2b871bbe5fb976fc37a7e56bc6f1da27ee6efec663a",
    # 2026-10-18 review: only pcb_identity keepout ordering changed;
    # parts execution, imports and external input boundaries are unchanged.
    "pcb_operations.py": "75ec69fc815e84a7427bf5cf37dd70ba395c7c78f97c03329445a9c49195c600",
    "pcb_evidence.py": "9d929244915407bddefd096f8a981113652e2706ea8785cf5ddb70061330687f",
    "pcb_workflow.py": "befb1e2b7660acc3a3422913c1df2e16b4a9673f1a8fa629bc315102aaf9135c",
    "pcb_timing.py": "07ed104072e56166625ffc36e774892c3761832cf00fe72b6abef2d967f05ddd",
    "lean_workflow.py": "926caceb8697718d86e279e114a7c9a57b5f78f20afa635109460601c27f1bb8",
    "lean_owned.py": "9034a7b33d37fb78a0e3f6cd3efe0f9ce95ae29b411ea38ae2bc47f242a1d78e",
    "lean_owned_exec.py": "dbee0c764a174ea3bae49f429d836d50b0d632bf828f20469a785d8268bc83ba",
    "lib/kicad-population.mjs": "0aebb28a1409de93200b081dc2226dede1225db367f72abdb156822e2de95040",
    "run_record.py": "015c92d8eb27ae21b98cc19e9ad9e7d48d83127618c31091978aff42c81031a6"
}
def _sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def _environment():
    return {key: value for key, value in sorted(os.environ.items())
            if key in ('PATH', 'HOME', 'VIRTUAL_ENV', 'CONDA_PREFIX',
                       'PDFINFO', 'PDFTOTEXT', 'PDFTOPPM', 'NODE_OPTIONS', 'NODE_PATH')
            or key.startswith(('PYTHON', 'LD_', 'DYLD_'))}


def _stdlib_names():
    names = getattr(sys, 'stdlib_module_names', None)
    if names is not None:
        return names
    # Python 3.9 has no stdlib_module_names. Inspect only its standard-library
    # directory and extension directory; never import modules or site-packages.
    directory = Path(sysconfig.get_paths()['stdlib'])
    result = set(sys.builtin_module_names)
    result.update(path.stem for path in directory.glob('*.py'))
    result.update(path.name for path in directory.iterdir()
                  if path.name not in ('site-packages', 'dist-packages', '__pycache__')
                  and (path / '__init__.py').is_file())
    result.update(path.name.split('.')[0] for path in (directory / 'lib-dynload').glob('*')
                  if path.suffix in ('.so', '.pyd'))
    return result


def _launcher(command):
    if not isinstance(command, str) or not command:
        return None
    name = shutil.which(command)
    return str(Path(name).resolve()) if name else None


def _selected_tools():
    selected = {'node': _launcher('node')}
    for name in ('pdfinfo', 'pdftotext', 'pdftoppm'):
        bundled = Path.home() / '.cache/codex-runtimes/codex-primary-runtime/dependencies/native/poppler/poppler/bin' / name
        candidate = os.environ.get(name.upper()) or (str(bundled) if bundled.is_file() else shutil.which(name))
        selected[name] = str(Path(candidate).resolve()) if candidate else None
    return selected


def _module_layout(root):
    """Detect new module/shadow names without hashing unrelated source bytes."""
    tools = Path(root) / 'tools'
    names = []
    for base, dirs, files in os.walk(tools, followlinks=False):
        dirs[:] = sorted(name for name in dirs if name not in ('__pycache__', 'node_modules', '.git', '.gate'))
        for name in files:
            if name.startswith('test_') or Path(name).suffix not in ('.py', '.so', '.pyd', '.pyc'):
                continue
            names.append((Path(base) / name).relative_to(tools).as_posix())
    return hashlib.sha256('\n'.join(sorted(names)).encode()).hexdigest()


def current(policy):
    """Check execution context; callers also check files and lexical absences."""
    try:
        if not isinstance(policy, dict) or policy.get('schema') != SCHEMA:
            return False
        if policy.get('mode') not in ('audited_parts', 'conservative'):
            return False
        context = policy['context']
        python = context['python']
        return (isinstance(context['root'], str) and Path(context['root']).is_dir()
                and context['environment'] == _environment()
                and context['selected_tools'] == _selected_tools()
                and context['module_layout_sha256'] == _module_layout(context['root'])
                and isinstance(python['requested'], str)
                and python['resolved'] is not None
                and _launcher(python['requested']) == python['resolved'])
    except (OSError, KeyError, TypeError, ValueError):
        return False


class Uncertified(ValueError):
    pass


def _reject_compiled_shadows(base, files, absent):
    """Compiled and sourceless imports have no audited source certificate."""
    candidates = set()
    for stem in (base, base / '__init__'):
        candidates.add(Path(str(stem) + '.pyc'))
        for suffix in ('.so', '.pyd'):
            candidates.add(Path(str(stem) + suffix))
            candidates.update(stem.parent.glob(stem.name + '.*' + suffix))
    found = []
    for path in sorted(candidates):
        name = str(path.absolute())
        if path.is_file():
            files[name] = _sha(path)
            found.append(name)
        elif path.exists() or path.is_symlink():
            absent.add(name)
            found.append(name)
        else:
            absent.add(name)
    if found:
        raise Uncertified('compiled or sourceless local import: ' + found[0])


def _imports(tools, entries, files, absent):
    """Close local Python imports without importing or executing any checker."""
    queue = list(entries)
    visited = set()
    stdlib = _stdlib_names()

    def add(path):
        # Missing candidates remain lexical: resolving a dangling symlink would
        # lose the name whose later appearance changes module resolution.
        path = Path(path).absolute()
        if path.is_symlink():
            raise Uncertified('symlinked local Python dependency: ' + str(path))
        if path.is_file():
            files[str(path)] = _sha(path)
            if path.suffix == '.py' and path not in visited:
                queue.append(path)
            return True
        absent.add(str(path))
        return False

    def module(name):
        parts = name.split('.') if name else []
        present = False
        for count in range(1, len(parts) + 1):
            base = tools.joinpath(*parts[:count])
            _reject_compiled_shadows(base, files, absent)
            # Both choices matter: a newly added package may shadow a module.
            candidates = (base.with_suffix('.py'), base / '__init__.py')
            found = [add(candidate) for candidate in candidates]
            if count == len(parts):
                present = any(found)
        return present

    for entry in entries:
        if not add(entry):
            raise Uncertified('missing Python entry: ' + str(entry))
    while queue:
        path = queue.pop()
        if path in visited:
            continue
        visited.add(path)
        text = path.read_text()
        tree = ast.parse(text, filename=str(path))
        package = list(path.relative_to(tools).parts[:-1])
        for node in ast.walk(tree):
            if isinstance(node, ast.Import):
                for alias in node.names:
                    local = module(alias.name)
                    if not local and alias.name.split('.')[0] not in stdlib:
                        raise Uncertified('unresolved Python import: ' + alias.name)
            elif isinstance(node, ast.ImportFrom):
                if node.level:
                    if node.level > len(package):
                        raise Uncertified('relative import escapes tools package')
                    prefix = package[:len(package) - node.level + 1]
                    name = '.'.join(prefix + ([node.module] if node.module else []))
                else:
                    name = node.module or ''
                local = module(name) if name else False
                if not local and name and name.split('.')[0] not in stdlib:
                    raise Uncertified('unresolved Python import: ' + name)
                for alias in node.names:
                    if alias.name == '*':
                        if not local:
                            raise Uncertified('unresolved star import')
                        continue
                    if local:
                        module('.'.join(filter(None, (name, alias.name))))
        certified = path.relative_to(tools).as_posix() in AUDITED and files[str(path)] == AUDITED[path.relative_to(tools).as_posix()]
        if not certified:
            # Static imports prove code discovery, not an unknown module's
            # file, environment, dynamic-loader or subprocess input closure.
            raise Uncertified('unreviewed local Python module: ' + str(path))
    return visited


def collect(root, operation, arguments, python_command):
    """Return source hashes, lexical absent candidates, and compact policy."""
    root = Path(root).resolve()
    tools = root / 'tools'
    action = arguments[0] if isinstance(arguments, (list, tuple)) and arguments else None
    resolved = _launcher(python_command)
    policy = dict(schema=SCHEMA, mode='conservative',
                  entry='part_evidence.py' if operation == 'parts' else str(operation),
                  reason='operation/action has no audited narrow boundary',
                  context=dict(root=str(root), operation=operation, action=action,
                               python=dict(requested=python_command, resolved=resolved),
                               environment=_environment(), selected_tools=_selected_tools(),
                               module_layout_sha256=_module_layout(root)))
    files, absent = {}, set()

    def bind(path):
        path = Path(path).absolute()
        if path.is_file():
            files[str(path)] = _sha(path)
        else:
            absent.add(str(path))

    bind(Path(__file__).resolve())
    if resolved:
        bind(resolved)
    if operation == 'parts' and action in PARTS_ACTIONS:
        try:
            if not resolved:
                raise Uncertified('Python launcher is unavailable')
            if os.environ.get('NODE_OPTIONS') or os.environ.get('NODE_PATH'):
                raise Uncertified('unreviewed Node startup override')
            allowed_python = {'PYTHON_MODERN', 'PYTHONPATH', 'PYTHONDONTWRITEBYTECODE',
                              'PYTHONUNBUFFERED', 'PYTHONHASHSEED', 'PYTHONUTF8',
                              'PYTHONIOENCODING', 'PYTHONNOUSERSITE', 'PYTHONSAFEPATH'}
            if any(name.startswith('PYTHON') and value and name not in allowed_python
                   for name, value in os.environ.items()):
                raise Uncertified('unreviewed Python startup override')
            # Native reader JavaScript has only builtin Node imports in this
            # reviewed version. Its original hash is part of the certificate.
            for name, expected in AUDITED.items():
                path = tools / name
                bind(path)
                if path.is_symlink() or not path.is_file() or _sha(path) != expected:
                    raise Uncertified('audited producer changed: ' + name)
            # Common-envelope imports are fixed by the certificate. Still
            # reject existing local stdlib shadows, not only newly added names.
            stdlib = _stdlib_names()
            for name in COMMON:
                for node in ast.walk(ast.parse((tools / name).read_text())):
                    imports = ([alias.name for alias in node.names] if isinstance(node, ast.Import)
                               else [node.module] if isinstance(node, ast.ImportFrom) and not node.level else [])
                    for imported in imports:
                        top = (imported or '').split('.')[0]
                        if top not in stdlib:
                            continue
                        _reject_compiled_shadows(tools / top, files, absent)
                        for candidate in (tools / (top + '.py'), tools / top / '__init__.py'):
                            bind(candidate)
                            if candidate.exists() or candidate.is_symlink():
                                raise Uncertified('local shadow of common stdlib import: ' + top)
            # The common envelope has a fixed, reviewed parts dispatch path.
            # Follow backend/helper imports, not every dormant command branch.
            _imports(tools, [tools / 'part_evidence.py'], files, absent)
            helper = tools / 'run_record.py'
            if helper.is_file():
                _imports(tools, [helper], files, absent)
            else:
                bind(helper)
            for name in ('sitecustomize.py', 'usercustomize.py'):
                path = tools / name
                if path.exists() or path.is_symlink():
                    raise Uncertified('local Python startup customization')
                absent.add(str(path.absolute()))
            for value in os.environ.get('PYTHONPATH', '').split(os.pathsep):
                if value and Path(value if Path(value).is_absolute() else root / value).resolve() != tools:
                    raise Uncertified('external PYTHONPATH requires conservative boundary')
            policy.update(mode='audited_parts', reason='exact audited producers plus static local import closure')
        except (OSError, SyntaxError, UnicodeError, Uncertified) as error:
            policy['reason'] = str(error)
    if policy['mode'] == 'conservative':
        # Preserve the original boundary for uncertified actions; do not label
        # it a complete dynamic execution closure or invent reuse eligibility.
        for directory, pattern in ((tools, '*.py'), (tools/'lib', '*.mjs'),
                                   (tools/'placer', '*.py'), (tools/'pcb_search', '*.py')):
            for path in directory.glob(pattern):
                if path.is_file():
                    bind(path)
    absent.difference_update(files)
    return dict(files=dict(sorted(files.items())), absent=sorted(absent), policy=policy)

