"""Deterministic bounded placement/routing search behind the existing CLI."""
from contextlib import ExitStack
from dataclasses import asdict
import json
import math
from pathlib import Path

from .backends import Blocked, NativeBackend, move_proposals, verify_movement
from .model import BoardState, Candidate, Finding, Outcome, RuleContext, file_digest, fingerprint
from .policy import JobPolicy, dependencies
from .session import Session, atomic_copy, atomic_json


def _rules(workspace, native, policy, folder):
    sources = folder / 'operation/source.json'
    if sources.is_file():
        original = json.loads(sources.read_text())['files']
        files = {str(workspace / name): digest for name, digest in original.items()
                 if workspace / name != native}
    else:
        files = {str(path): file_digest(path) for path in (
            native.with_suffix('.kicad_pro'), native.with_suffix('.kicad_dru'),
            native.with_suffix('.kicad_sch')) if path.is_file()}
        # Direct API callers still bind all engine/runtime/rule implementations.
        for pattern in ('tools/*.py', 'tools/pcb_engine/**/*.py', 'tools/pcb_engine/**/*.mm',
                        'tools/pcb_engine/**/*.metal', 'hardware-design/boards/*/gate.json'):
            files.update({str(p): file_digest(p) for p in workspace.glob(pattern) if p.is_file()})
    return RuleContext(files, policy.routing, str(workspace))


def copper_metrics(path):
    from pcb_search.native_candidate import copper_items
    from pcb_search.block_bindings import child
    from placer.dru import _tree, _tokens
    text, items = copper_items(path)
    length = 0.
    for row in items.values():
        a, b = row['span']
        form = _tree(_tokens(text[a:b]))[0]
        if row['kind'] == 'segment':
            start, end = child(form, 'start'), child(form, 'end')
            length += math.hypot(float(start[0])-float(end[0]), float(start[1])-float(end[1]))
        elif row['kind'] == 'arc':
            # Preserve honest ranking when an arc implementation is unavailable:
            # do not silently call chord length routed copper length.
            return dict(via_count=sum(v['kind'] == 'via' for v in items.values()))
    return dict(via_count=sum(v['kind'] == 'via' for v in items.values()), track_length_mm=length)


def _placement_compute(raw, proposals, worker, policy, emit):
    """Record batched HPWL without replacing any term of production scoring."""
    if not proposals:
        return
    # Flatten per-net pin centers. This is an advisory primitive, distinct from
    # production's weighted pad-envelope HPWL and all other objective terms.
    pins, nets = [], []
    for net in raw['problem']['nets']:
        indices = []
        for pin in net['pins']:
            indices.append(len(pins))
            pins.append(pin)
        if indices:
            nets.append(indices)
    if not pins or not nets:
        return
    candidates = []
    def rotated_center(pin, pose):
        x, y = (pin[1]+pin[3])/2, (pin[2]+pin[4])/2
        for _ in range(int(pose[2]) % 4):
            x, y = y, -x
        return [pose[0]+x, pose[1]+y]
    for proposal in proposals:
        candidates.append([rotated_center(pin, proposal['pose'][pin[0]]) for pin in pins])
    revision = fingerprint(raw)
    base = candidates[0]
    snapshot = worker.prepare('placement_hpwl', revision=revision, candidates=[base], nets=nets)
    deltas = [[[i, point[0]-base[i][0], point[1]-base[i][1]]
               for i, point in enumerate(points) if point != base[i]] for points in candidates]
    reply = worker.request('placement_hpwl', revision=revision, backend=policy.compute,
                           snapshot_id=snapshot, candidate_deltas=deltas)
    emit('engine.compute', operation='placement_hpwl', primitive='unweighted_pad_center_hpwl',
         error=reply.get('error'), **reply.get('metrics', {}))
    values = reply.get('result', {}).get('scores', [])
    if len(values) == len(proposals):
        for proposal, score in zip(proposals, values):
            proposal['advisory_hpwl'] = score
        # Full production score is the first key. GPU score breaks exact ties;
        # it never drops overlap, class, clearance or other objective terms.
        proposals.sort(key=lambda p: (p['production_score'], p['advisory_hpwl'], fingerprint(p['strategy'])))


def run_engine(folder, workspace, board, policy, *, timeout_s, node='node', env=None, emit=None, execute=None,
               backend_factory=NativeBackend):
    """Search isolated native candidates; callers must run final semantic gates.

    backend_factory is dependency injection for deterministic engine tests. CLI
    callers use the native adapter; no policy can inject an acceptance provider.
    """
    folder, workspace = Path(folder).resolve(), Path(workspace).resolve()
    policy = JobPolicy.parse(policy, timeout_s)
    output = folder / 'operation/engine'
    output.mkdir(parents=True, exist_ok=True)
    backend = backend_factory(output, workspace, board, policy, timeout_s, node=node,
                              env=env, emit=emit, execute=execute)
    native = Path(backend.native).resolve()
    if not native.is_relative_to(workspace) or not workspace.is_relative_to(folder):
        raise ValueError('engine requires an isolated workspace inside its run directory')
    rules = _rules(workspace, native, policy, folder)
    for name in dependencies(workspace, policy.to_dict()):
        path = workspace / name
        rules.files[str(path)] = file_digest(path)
    findings = ()
    count = 0
    terminal_cause = 'bounded search completed'
    initial_sha = file_digest(native)
    with Session(output, native, rules, policy, emit) as session, ExitStack() as stack:
        count = session.attempt_count
        initial_sha = session.initial_sha256
        # CLI's parent_candidate verifies its source/evidence before copying.
        # Reuse retry fingerprints only when the complete rule/policy binding
        # agrees; differing rules constitute a different experiment.
        manifest_path = folder / 'run.json'
        if manifest_path.is_file():
            parent = json.loads(manifest_path.read_text()).get('from_run')
            if isinstance(parent, dict) and parent.get('folder'):
                state = Path(parent['folder']) / 'operation/engine/state.json'
                if state.is_file():
                    previous = json.loads(state.read_text())
                    if (previous.get('binding', {}).get('rules') == rules.revision and
                            previous['binding'].get('policy') == fingerprint(policy.to_dict())):
                        session.seen.update(previous.get('seen', []))
                        session.persist()
        session.transition('searching')
        initial = output / 'initial.kicad_pcb'
        if not initial.is_file():
            atomic_copy(native, initial)
        elif file_digest(initial) != session.initial_sha256:
            raise ValueError('engine initial rollback input changed')
        # Every independent proposal keeps the same declared movement origin.
        # On restart, return to that origin while retaining checked incumbents.
        atomic_copy(initial, native)
        origin_source = initial
        # The operation snapshot is sealed against canonical sources BEFORE a
        # parent candidate is materialized. Consequently this binding remains
        # the same across --from-run, even if budgets/compute policies change.
        source_receipt = folder / 'operation/source.json'
        if manifest_path.is_file() and source_receipt.is_file():
            manifest = json.loads(manifest_path.read_text())
            relative = str(native.relative_to(workspace))
            sources = json.loads(source_receipt.read_text())
            canonical_root = Path(manifest['root']).resolve()
            origin_source = (canonical_root / relative).resolve()
            expected = sources['files'].get(relative)
            if (not origin_source.is_relative_to(canonical_root) or not expected
                    or file_digest(origin_source) != expected):
                raise ValueError('canonical movement origin differs from admitted source receipt')
        movement_origin = output / 'movement-origin.kicad_pcb'
        expected_origin = file_digest(origin_source)
        if movement_origin.exists():
            if file_digest(movement_origin) != expected_origin:
                raise ValueError('movement origin changed across session recovery')
        else:
            atomic_copy(origin_source, movement_origin)
        session.movement_origin = dict(path=str(movement_origin), sha256=expected_origin,
                                       source_sha256=expected_origin)
        session.persist()
        backend.movement_origin, backend.movement_baseline = movement_origin, initial
        worker = None
        ranker = None

        def compute():
            nonlocal worker
            if worker is None:
                from .compute import ComputeWorker
                worker = stack.enter_context(ComputeWorker(native=policy.compute != 'cpu',
                                                           timeout_s=min(60, backend.remaining())))
            return worker

        def evaluate(attempt, strategy, observed):
            session.transition('verifying')
            from pcb_operations import pcb_identity
            if pcb_identity(initial) != pcb_identity(native):
                raise Blocked('candidate changed protected design identity')
            if file_digest(movement_origin) != expected_origin:
                raise ValueError('sealed movement origin changed')
            verify_movement(movement_origin, native, policy, baseline=initial)
            before = file_digest(native)
            passed, metrics, evidence = backend.verify(attempt / 'gate')
            if file_digest(native) != before:
                raise Blocked('verification changed candidate board bytes')
            rules.assert_current()
            candidate_path = attempt / 'candidate.kicad_pcb'
            atomic_copy(native, candidate_path)
            metrics = dict(metrics, **copper_metrics(candidate_path))
            candidate = Candidate(attempt.name, BoardState.capture(board, candidate_path, rules,
                parent=initial_sha), str(candidate_path), passed, metrics, tuple(observed), evidence, strategy)
            session.record(candidate)
            session.transition('diagnosing')
            return candidate

        def input_receipt(attempt, strategy):
            atomic_copy(native, attempt / 'input.kicad_pcb')
            atomic_json(attempt / 'input.json', dict(schema='iot-lab.engine-input.v1',
                board=board, board_sha256=file_digest(native), rules_revision=rules.revision,
                rules=asdict(rules), policy=policy.to_dict(), strategy=strategy))

        def ranked_moves(proposals):
            nonlocal ranker
            if not policy.ranking or not proposals:
                return proposals
            from .ml import FrozenRanker, CoreMLRanker
            from pcb_ml_features import feature_contract, routing_features
            config = policy.ranking
            try:
                if ranker is None:
                    if config.get('package_path'):
                        ranker = CoreMLRanker(workspace / config['model_path'], workspace / config['package_path'],
                            compute(), root=workspace, compute_units=config['compute_units'],
                            allow_experimental=config['allow_experimental'])
                        stack.callback(ranker.close)
                        session.event('engine.ml_profile', profile=ranker.profile())
                    else:
                        ranker = FrozenRanker(workspace / config['model_path'], root=workspace,
                                              allow_experimental=config['allow_experimental'])
                if not ranker.enabled:
                    session.event('engine.ranking_fallback', reason='model_not_promoted',
                                  model_sha256=ranker.model_sha256)
                    return proposals
                contract = feature_contract('routing')
                rows = []
                by_id = {}
                for proposal in proposals:
                    key = fingerprint(proposal['strategy'])
                    path = output / ('rank-' + key[:16])
                    path.mkdir(exist_ok=False)
                    with session.transaction(path.name):
                        backend.apply_move(placement_export, proposal, path / 'placement')
                        features, reasons = routing_features(native.read_text())
                        input_receipt(path, proposal['strategy'])
                    row = dict(id=key, features=features, production_score=proposal['production_score'])
                    atomic_json(path / 'features.json', dict(feature_contract=contract, features=features,
                                                             reasons=reasons, predecision=True))
                    rows.append(row)
                    by_id[key] = proposal
                ordered = ranker.rank(rows, contract, budget=max(0, policy.max_attempts-count-1))
                atomic_json(output / 'ranking.json', ordered)
                session.event('engine.ranking', model_sha256=ranker.model_sha256,
                    exploration=ordered['deterministic_exploration_ids'], fallback=ordered['fallback'],
                    inference=getattr(ranker, 'last_metrics', {}))
                return [by_id[row['id']] for row in ordered['candidates']]
            except (OSError, ValueError, RuntimeError) as error:
                session.event('engine.ranking_fallback', reason=str(error))
                return proposals

        try:
            # Retain a checked incumbent even if a later strategy fails. This is
            # labelled baseline; returning it is not claimed as an improvement.
            if not session.attempts:
                baseline = output / 'baseline'
                baseline.mkdir(exist_ok=True)
                evaluate(baseline, {'kind': 'baseline'}, ())
                session.transition('searching')
            proposals = None
            placement_export = output / 'placement'
            diagnosis = backend.diagnose(output / 'baseline/gate/result.json') if hasattr(backend, 'diagnose') else None
            if diagnosis:
                atomic_json(output / 'initial-diagnosis.json', diagnosis)
                findings = tuple(Finding.from_dict(row) for row in diagnosis.get('findings', []))
            actions = ([dict(kind='repair', choice=diagnosis.get('choice'))]
                       if diagnosis and diagnosis.get('status') == 'repairable' else [dict(kind='route')])

            def successors(strategy):
                nonlocal proposals, findings
                if strategy['kind'] == 'route':
                    actions.append(dict(kind='local'))
                if strategy['kind'] == 'repair':
                    actions.append(dict(kind='route'))
                if strategy['kind'] != 'repair' and proposals is None and policy.movement.refs and count < policy.max_attempts:
                    try:
                        raw = backend.export_placement(placement_export)
                        proposals = (backend.proposals(raw, findings, output / 'scored-proposals.json')
                                     if hasattr(backend, 'proposals') else move_proposals(raw, findings, policy))
                        _placement_compute(raw, proposals, compute(), policy, session.event)
                        proposals = ranked_moves(proposals)
                        atomic_json(output / 'placement-proposals.json', proposals)
                        actions.extend(p['strategy'] for p in proposals)
                    except (Blocked, ValueError) as error:
                        proposals = []
                        findings += (Finding('placement_unsupported', str(error)),)
                        session.event('engine.placement_blocked', cause=str(error))

            while actions and count < policy.max_attempts:
                backend.remaining()
                strategy = actions.pop(0)
                key = session.admit_attempt(dict(strategy=strategy, policy=policy.to_dict()))
                if key is None:
                    terminal_cause = 'identical board, rules and strategy already attempted'
                    for row in reversed(session.attempts):
                        if row['strategy'] == strategy:
                            findings = tuple(Finding(**f) for f in row['findings'])
                            break
                    successors(strategy)
                    continue
                count += 1
                attempt = output / ('attempt-' + key[:16])
                if attempt.exists():
                    raise Blocked('immutable attempt directory already exists')
                attempt.mkdir()
                atomic_json(attempt / 'strategy.json', strategy)
                try:
                    with session.transaction(attempt.name):
                        if strategy['kind'] == 'repair':
                            input_receipt(attempt, strategy)
                            observed = backend.cheap_repair(diagnosis, attempt)
                        elif strategy['kind'] == 'move':
                            proposal = next(p for p in proposals if p['strategy'] == strategy)
                            backend.apply_move(placement_export, proposal, attempt / 'placement')
                            input_receipt(attempt, strategy)
                            _, observed = backend.route(attempt / 'router')
                        elif strategy['kind'] == 'local':
                            input_receipt(attempt, strategy)
                            backend.local_repair(attempt, compute())
                            observed = findings
                        else:
                            input_receipt(attempt, strategy)
                            _, observed = backend.route(attempt / 'router')
                        findings = tuple(observed)
                        candidate = evaluate(attempt, strategy, findings)
                    if candidate.gate_passed:
                        terminal_cause = 'candidate meets configured gate; final board semantic checks required'
                        break
                except Blocked as error:
                    findings = findings + (Finding('unsupported_or_unavailable', str(error)),)
                    atomic_json(attempt / 'blocked.json', dict(status='blocked', cause=str(error)))
                    session.event('engine.blocked_attempt', attempt_id=attempt.name, cause=str(error))
                    terminal_cause = str(error)
                    # Each alternative performs its own admission. A rejected
                    # Fastroute model does not certify or reject the separately
                    # source-bound local/native model.
                except Exception as error:
                    # The environment may be inconsistent: record, stop searching,
                    # and still select from already checked candidates.
                    cause = 'unexpected engine error in ' + attempt.name + ': ' + type(error).__name__ + ': ' + str(error)
                    findings = findings + (Finding('engine_error', cause),)
                    atomic_json(attempt / 'failed.json', dict(status='failed', cause=cause,
                                                              error_type=type(error).__name__))
                    session.event('engine.failed_attempt', attempt_id=attempt.name, cause=cause)
                    terminal_cause = cause
                    if session.phase in ('diagnosing', 'verifying'):
                        session.transition('searching')
                    break
                if session.phase in ('diagnosing', 'verifying'):
                    session.transition('searching')
                successors(strategy)
        except Blocked as error:
            terminal_cause = str(error)
            findings += (Finding('budget_or_runtime', str(error)),)
        selected = session.best_verified or session.best
        if selected is not None:
            if file_digest(selected.path) != selected.board.sha256:
                raise ValueError('selected candidate changed after verification')
            atomic_copy(selected.path, native)
            # Only a candidate that passed its configured gate is 'candidate'. An
            # unverified best still goes to the outer gate for its failed receipt.
            verified = selected is session.best_verified
            state = Outcome('candidate' if verified else 'unverified', terminal_cause, count, str(native),
                            file_digest(native), session.best_verified.path if session.best_verified else None,
                            findings, candidate_verified=verified)
        else:
            state = Outcome('blocked', terminal_cause, count, findings=findings)
        if session.phase not in ('complete', 'blocked'):
            session.transition('complete' if selected else 'blocked')
        result = state.to_dict()
        result.update(initial_sha256=initial_sha, improved=bool(selected and selected.strategy.get('kind') != 'baseline'
                      and selected.board.sha256 != initial_sha),
                      selected_strategy=selected.strategy if selected else None,
                      state=str(output / 'state.json'), runtime=policy.runtime, compute=policy.compute)
        atomic_json(output / 'result.json', result)
        return result
