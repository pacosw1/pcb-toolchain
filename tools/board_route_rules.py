"""Board route-rule plugins. A board names its plugin in gate.json: "route_rules": "tools/<module>.py".

Shared routing code loads the plugin by path, so it does not import board code. A board without the key
behaves as before (no board rules). gate.pending.json is read when the board has no gate.json.
"""
import importlib.util
import json
import os
import re
import sys


def config(root, board):
    """The gate configuration of BOARD (gate.json, else gate.pending.json), or None."""
    if not board or not re.fullmatch(r'[A-Z0-9][A-Z0-9-]*', board):
        return None
    return config_dir(os.path.join(str(root), 'hardware-design', 'boards', board))


def config_dir(board_dir):
    for name in ('gate.json', 'gate.pending.json'):
        path = os.path.join(str(board_dir), name)
        if os.path.isfile(path):
            with open(path) as fh:
                return json.load(fh)
    return None


def load_path(path):
    """Import a plugin by file path. A module already imported from the same file is used again."""
    path = os.path.abspath(path)
    name = os.path.splitext(os.path.basename(path))[0]
    known = sys.modules.get(name)
    if known is not None and getattr(known, '__file__', None) and os.path.abspath(known.__file__) == path:
        return known
    spec = importlib.util.spec_from_file_location(name, path)
    if spec is None or spec.loader is None:
        raise ImportError('route_rules plugin cannot be loaded: ' + path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    try:
        spec.loader.exec_module(module)
    except BaseException:
        sys.modules.pop(name, None)
        raise
    return module


def _load(root, cfg):
    rel = (cfg or {}).get('route_rules')
    if not rel:
        return None
    if not isinstance(rel, str):
        raise ValueError('gate.json route_rules must be a path such as tools/<module>.py')
    return load_path(os.path.join(str(root), rel))


def load(root, board):
    """The route-rule plugin module of BOARD, or None when its gate.json names none."""
    return _load(root, config(root, board))


def load_dir(root, board_dir):
    return _load(root, config_dir(board_dir))


def mandatory(root, candidates):
    """The first candidate board whose plugin has mandatory preserved-copper rules: (board, module), else (None, None)."""
    for board in candidates:
        rules = load(root, board)
        if rules is not None and hasattr(rules, 'preserved_input_faults'):
            return board, rules
    return None, None
