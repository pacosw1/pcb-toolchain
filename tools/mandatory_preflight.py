"""Shared read-only invocation check and strict compaction immutable proof.

Only locked source layer faults are global placement blockers. Retained but
unlocked copper, pair-count faults and generic failures remain candidate-local.
"""
import fnmatch
import json
import os

import board_route_rules


class ImmutableInputFailure(Exception):
    def __init__(self, receipt, path):
        self.receipt = receipt
        self.path = path
        super().__init__('immutable input mandatory rules: ' + path)


class SelectionError(ValueError):
    """CLI selection rejects retain the existing wrapper SystemExit contract."""


def records(board):
    out = []
    for t in board.GetTracks():
        kind = t.GetClass()
        via = kind == 'PCB_VIA'
        points = [t.GetPosition()] if via else [t.GetStart(), t.GetEnd()]
        row = dict(uuid=t.m_Uuid.AsString(), net=t.GetNetname(), layer=t.GetLayerName(),
                   via=via, kind=kind, locked=t.IsLocked(), geometry=[[p.x, p.y] for p in points],
                   width=t.GetWidth(t.TopLayer()) if via else t.GetWidth())
        if via:
            # KiCad vias have layer-specific padstacks; GetWidth() without a
            # layer is undefined/deprecated. Keep width as the top diameter for
            # legacy readers, with all spanned enabled copper layers explicit.
            row.update(drill=t.GetDrillValue(), span=[t.TopLayer(), t.BottomLayer()],
                       via_diameters={board.GetLayerName(layer): t.GetWidth(layer)
                                      for layer in board.GetEnabledLayers().CuStack() if t.IsOnLayer(layer)})
        out.append(row)
    return out


def inspect(a, board_dir, declared_board, load_board, digest, rule_root, rules=None):
    """Identical selection/policy check used by wrapper and pre-search driver.

    RULES is the board route-rule plugin; default: the gate.json "route_rules" of BOARD_DIR."""
    if rules is None:
        rules = board_route_rules.load_dir(rule_root, board_dir)
    if rules is None:
        raise SelectionError('no route_rules plugin in the gate.json of ' + str(board_dir))
    stem = os.path.splitext(a.board)[0]
    identity = rules.invocation_identity(board_dir, a.board, declared_board)
    cfg = rules.evidence(board_dir, stem + '.kicad_pro')
    source = load_board(a.board)
    if source is None:
        raise SelectionError(getattr(rules, 'LABEL', os.path.basename(str(board_dir))) +
                             ' cannot read source board for preserved-copper preflight')
    planes = [n for n in a.plane_nets.split(',') if n]
    if a.gnd_vias and 'GND' not in planes:
        planes.insert(0, 'GND')
    skip = [n for n in a.skip_net.split(',') if n] + ([] if a.route_planes else planes)
    if a.route_planes:
        skip = [n for n in skip if not any(fnmatch.fnmatchcase(p, n) for p in planes)]
    nets = {str(n) for n in source.GetNetsByName().keys() if str(n)}
    routed = {n for n in nets if not any(fnmatch.fnmatchcase(n, pat) for pat in skip)}
    if a.only_nets:
        routed = {n for n in a.only_nets.split(',') if n}
        if routed - nets:
            raise SelectionError('no such net: ' + str(sorted(routed - nets)))
    unlock = [n for n in a.unlock_nets.split(',') if n]
    if set(unlock) - routed:
        raise SelectionError('skipped nets cannot have unlocked copper')
    rows = records(source)
    with open(os.path.join(board_dir, 'diff-pairs.json')) as fh:
        pairs = json.load(fh)['pairs']
    profile = rules.preserved_usb_profile(board_dir, identity['board'], pairs, routed)
    faults = rules.preserved_input_faults(rows, cfg, pairs, routed, unlock, profile)
    sources = [rules.__file__, __file__, stem + '.kicad_pro', identity['owner_project']] + [os.path.join(board_dir, n) for n in
        ('current-paths.json', 'reference-planes.json', 'rp001-fast-nets.json', 'diff-pairs.json', 'preserved-usb-policy.json')]
    if profile:
        sources += [os.path.join(rule_root, s['path']) for s in profile['sources']]
    receipt = dict(board_sha256=digest(a.board), faults=faults, qualified=False,
                   policy_sources={p: digest(p) for p in sources}, preserved_pair_profile=profile,
                   board_identity=identity, routed_nets=sorted(routed), unlock_nets=a.unlock_nets,
                   source_records=rows,
                   note='only immutable invocation faults block; repairable copper remains subject to final checks')
    return cfg, receipt


def locked_faults(receipt, candidate_sha, candidate_rows, seed, policy_hashes):
    """Validate an actual iteration receipt against authoritative seed and CAD.

    The caller obtains current rows read-only from the actual candidate, never
    from the child receipt. Unknown/malformed/stale records cannot mint a stop.
    """
    try:
        if not isinstance(receipt, dict) or not isinstance(seed, dict) or not isinstance(candidate_rows, list):
            return []
        for collection in (receipt.get('faults'), receipt.get('source_records'), seed.get('faults'), seed.get('source_records'), candidate_rows):
            if not isinstance(collection, list) or any(not isinstance(row, dict) for row in collection):
                return []
        if receipt['board_sha256'] != candidate_sha or receipt['qualified'] is not False:
            return []
        if receipt['policy_sources'] != policy_hashes:
            return []
        def binding(r):
            source = r['board_identity']['source_project']
            return {('<input-project>' if p == source else p): h for p, h in r['policy_sources'].items()}
        if binding(receipt) != binding(seed):
            return []
        if receipt['preserved_pair_profile'] != seed['preserved_pair_profile']:
            return []
        if (receipt['routed_nets'], receipt['unlock_nets']) != (seed['routed_nets'], seed['unlock_nets']):
            return []
        if {k:v for k,v in receipt['board_identity'].items() if k != 'source_project'} != {k:v for k,v in seed['board_identity'].items() if k != 'source_project'}:
            return []
        originals = {r['uuid']: r for r in seed['source_records']}
        actual = {r['uuid']: r for r in candidate_rows}
        reported = {r['uuid']: r for r in receipt['source_records']}
        if len(originals) != len(seed['source_records']) or len(actual) != len(candidate_rows) or len(reported) != len(receipt['source_records']):
            return []
        accepted = []
        for fault in receipt['faults']:
            uid = fault.get('uuid')
            if not uid or fault.get('source_locked') is not True or fault.get('preservation') != 'locked or retained by this invocation':
                continue
            original = originals.get(uid)
            if not original or original['locked'] is not True or original['via'] or original.get('kind') != 'PCB_TRACK':
                continue
            if actual.get(uid) != original or reported.get(uid) != original:
                continue
            if fault.get('net') != original['net'] or fault.get('layer') != original['layer']:
                continue
            # The current checker, not arbitrary child text, minted this exact
            # layer fault on the authoritative seed under the same policy.
            if fault not in seed['faults']:
                continue
            accepted.append(fault)
        return accepted
    except (KeyError, TypeError, ValueError):
        return []
