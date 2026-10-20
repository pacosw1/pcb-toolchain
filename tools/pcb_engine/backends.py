"""Adapters for existing controlled routing, native placement and fresh gates."""
import copy
import json
import os
from pathlib import Path
import shutil
import subprocess
import time
from decimal import Decimal

from .model import Finding, file_digest
from .session import atomic_copy, atomic_json


class Blocked(RuntimeError):
    """An unsupported or unavailable operation, never evidence of unroutability."""


def verify_movement(origin, candidate, policy, *, baseline=None):
    """Bind continued moves to canonical origin; unchanged inherited poses stay."""
    from pcb_search.block_bindings import footprints
    def poses(path):
        rows = footprints(path)
        result = {row['props'].get('Reference'): row['pose'] for row in rows}
        if len(result) != len(rows) or None in result:
            raise Blocked('ambiguous footprint identity in movement guard')
        return result
    original, after = poses(origin), poses(candidate)
    initial = poses(baseline or origin)
    if set(original) != set(after) or set(initial) != set(after):
        raise Blocked('movement changed footprint membership')
    radius = Decimal(str(policy.movement.max_displacement_mm))
    allowed = set(policy.movement.refs)
    for ref, pose in after.items():
        if ref not in allowed:
            if pose != initial[ref]:
                raise Blocked('component moved outside declared scope: ' + ref)
            continue
        source = original[ref]
        if (pose[2]-source[2]) % 360:
            raise Blocked('rotation is not authorized by the translation-only movement policy')
        if sum((pose[i]-source[i])**2 for i in (0, 1)) > radius**2:
            raise Blocked('component exceeds original movement envelope: ' + ref)
    return True


class NativeBackend:
    def __init__(self, folder, workspace, board, policy, timeout_s, node='node', env=None, emit=None, execute=None):
        from pcb_workflow import board_config, python_native
        self.folder, self.workspace = Path(folder), Path(workspace)
        self.board, self.policy = board, policy
        self.native = board_config(self.workspace, board)[2].with_suffix('.kicad_pcb')
        self.python, self.node = python_native(), node
        self.env = dict(os.environ, **(env or {}))
        self.env['PYTHONPATH'] = str(self.workspace / 'tools')
        self.emit = emit or (lambda *a, **k: None)
        self.execute = execute
        self.deadline = time.monotonic() + timeout_s

    def remaining(self):
        remaining = self.deadline - time.monotonic()
        if remaining <= 0:
            raise Blocked('engine deadline exhausted')
        return remaining

    def command(self, stage, command):
        remaining = self.remaining()
        # Existing supervisor propagates cancellation. The local runner also has
        # a per-command deadline so direct callers do not create unbounded jobs.
        log = self.folder / (stage.replace('/', '_') + '.log')
        self.emit('engine.tool', stage=stage, command=command)
        with log.open('wb') as stream:
            try:
                import lean_workflow
                run = lean_workflow.run_stage(command, stage=stage, deadline=lean_workflow.deadline_after(remaining),
                    event_file=str(self.folder / 'stages.jsonl'), cwd=self.workspace, env=self.env,
                    stdin=subprocess.DEVNULL, stdout=stream, stderr=subprocess.STDOUT)
            except subprocess.TimeoutExpired as error:
                raise Blocked('engine deadline exhausted during ' + stage) from error
        self.emit('engine.tool_complete', stage=stage, returncode=run.returncode, log=str(log))
        return run.returncode

    def route(self, directory):
        from pcb_routing_trial import prepare, finalize
        from pcb_search.block_bindings import footprints
        poses = {row['props'].get('Reference'): row['pose'] for row in footprints(self.native)}
        directory = Path(directory)
        try:
            prepared = prepare(self.workspace, self.native, directory, self.policy.routing,
                               self.remaining(), board=self.board, runtime=self.policy.runtime)
        except (ValueError, OSError) as error:
            raise Blocked('controlled routing admission: ' + str(error)) from error
        prior_env = self.env
        try:
            self.env = dict(self.env, **prepared['env'])
            code = self.command('route-' + directory.parent.name, prepared['command'])
        finally:
            self.env = prior_env
        report = finalize(prepared, returncode=code)
        atomic_json(directory.parent / 'router-summary.json', report)
        if not report.get('controls_verified'):
            raise Blocked('routing execution controls were not verified: ' + str(report.get('cause', 'unknown')))
        from route_decision import observe_route
        observation = observe_route(self.native, directory)
        atomic_json(directory.parent / 'diagnosis.json', observation)
        findings = tuple(Finding.from_dict(row) for row in observation.get('findings', []))
        path = report.get('candidate')
        if not path or not Path(path).is_file():
            return None, findings + (Finding('search_incomplete', report.get('cause', 'no native candidate')),)
        if {row['props'].get('Reference'): row['pose'] for row in footprints(path)} != poses:
            raise Blocked('routing backend changed component placement outside the declared move transaction')
        atomic_copy(path, self.native)
        return report, findings

    def verify(self, directory):
        directory = Path(directory)
        code = self.command('gate-' + directory.parent.name, [self.node, str(self.workspace / 'tools/gate.mjs'),
                           self.board, '--fresh', '--evidence-dir', str(directory)])
        result = directory / 'result.json'
        if not result.is_file():
            return False, {}, {}
        report = json.loads(result.read_text())
        passed = code == 0 and report.get('exit') == 0 and not report.get('changedDuringRun')
        evidence = {str(p): file_digest(p) for p in directory.rglob('*') if p.is_file()}
        return passed, report.get('metrics') or {}, evidence

    def export_placement(self, output):
        output = Path(output)
        if output.exists():
            from pcb_search.native_srj import source_set
            manifest = json.loads((output / 'record.json').read_text())
            if (manifest.get('inputs') != source_set(self.native)
                    or manifest.get('placement_sha256') != file_digest(output / 'placement.json')
                    or manifest.get('status') not in ('candidate', 'needs_native_check')
                    or manifest.get('source_mutated') is not False):
                raise Blocked('existing placement export is stale or incomplete')
            return json.loads((output / 'placement.json').read_text())
        args = [self.python, '-m', 'pcb_search.native_export', str(self.native), str(output),
                '--drc-seconds', str(min(60., self.remaining())), '--no-rotate',
                '--max-displacement-mm', str(self.policy.movement.max_displacement_mm)]
        for ref in self.policy.movement.refs:
            args += ['--movable-ref', ref]
        self.command('placement-export', args)
        record = Path(output) / 'record.json'
        if not record.is_file():
            raise Blocked('native placement export produced no receipt')
        manifest = json.loads(record.read_text())
        if manifest.get('status') not in ('candidate', 'needs_native_check'):
            raise Blocked('native placement model: ' + manifest.get('reason', manifest.get('status', 'unknown')))
        return json.loads((Path(output) / 'placement.json').read_text())

    def diagnose(self, evidence):
        from route_decision import diagnose_evidence
        try:
            return diagnose_evidence(self.workspace, self.board, evidence)
        except (ValueError, OSError) as error:
            self.emit('engine.diagnosis_unavailable', reason=str(error))
            return None

    def cheap_repair(self, plan, output):
        """Reuse the guarded repair service in a nested isolated transaction."""
        from pcb_operations import snapshot
        from pcb_workflow import board_config
        from route_decision import apply_plan
        choice = plan.get('choice') or {}
        if choice.get('net') not in self.policy.routing['only_nets']:
            raise Blocked('diagnosed repair net is outside routing authority')
        if choice.get('layer') and choice['layer'] not in self.policy.routing['layers']:
            raise Blocked('diagnosed repair layer is outside routing authority')
        if choice.get('strategy') == 'via_shift_bridge' and not {'F.Cu', 'B.Cu'} <= set(self.policy.routing['layers']):
            raise Blocked('via bridge repair requires authority for both copper layers')
        output = Path(output)
        candidate_workspace = output / 'workspace'
        snapshot(self.workspace, candidate_workspace, self.board)
        self.remaining()
        report = apply_plan(candidate_workspace, self.board, plan, output / 'repair')
        candidate = board_config(candidate_workspace, self.board)[2].with_suffix('.kicad_pcb')
        if report.get('status') != 'proposed' or file_digest(candidate) != report.get('candidate_sha256'):
            raise Blocked('guarded local repair did not return a source-bound candidate')
        atomic_copy(candidate, self.native)
        return tuple(Finding.from_dict(row) for row in plan.get('findings', []))

    def apply_move(self, export, proposal, output):
        proposal_path = Path(output).parent / 'placement-proposal.json'
        atomic_json(proposal_path, proposal)
        code = self.command('placement-import-' + Path(output).parent.name,
            [self.python, '-m', 'pcb_search.native_placement', str(export), str(proposal_path), str(output)])
        path = Path(output) / 'proposal.kicad_pcb'
        if code or not path.is_file():
            raise Blocked('native placement importer rejected bounded move')
        atomic_copy(path, self.native)
        if hasattr(self, 'movement_origin'):
            verify_movement(self.movement_origin, self.native, self.policy, baseline=self.movement_baseline)
        # Every incident net must be included before detaching a moved pad.
        strip_moved_nets(self.native, proposal['moved_refs'], self.policy.routing['only_nets'],
                        allowed_layers=self.policy.routing['layers'])

    def proposals(self, raw, findings, output):
        from dataclasses import asdict
        output = Path(output)
        request = output.with_name('placement-request.json')
        atomic_json(request, dict(raw=raw, findings=[asdict(f) for f in findings],
                                 policy=self.policy.to_dict(), timeout_s=self.remaining()))
        code = self.command('placement-score', [self.python, '-m', 'pcb_engine.placement_worker',
                                                str(request), str(output)])
        if code or not output.is_file():
            raise Blocked('production placement scorer failed; no reduced objective substituted')
        proposals = json.loads(output.read_text())
        if hasattr(self, 'movement_origin'):
            from pcb_search.block_bindings import footprints
            origin = {f['props']['Reference']: f['pose'] for f in footprints(self.movement_origin)}
            current = {f['props']['Reference']: f['pose'] for f in footprints(self.native)}
            radius = Decimal(str(self.policy.movement.max_displacement_mm))
            proposals = [p for p in proposals if all(
                sum((current[ref][i] + Decimal(str(p['strategy'][('dx', 'dy')[i]])) - origin[ref][i])**2
                    for i in (0, 1)) <= radius**2 for ref in p['moved_refs'])]
        return proposals

    def local_repair(self, directory, compute):
        from .local_router import route_srj
        from pcb_search.block_bindings import footprints
        poses = {row['props'].get('Reference'): row['pose'] for row in footprints(self.native)}
        directory = Path(directory)
        export = directory / 'export'
        args = [self.python, '-m', 'pcb_search.native_srj', 'export', str(self.native), str(export),
                '--retain-selected-copper']
        for net in self.policy.routing['only_nets']:
            args += ['--net', net]
        if self.command('local-export-' + directory.name, args):
            raise Blocked('bounded local router cannot represent this board; inspect native export log')
        srj = json.loads((export / 'srj.json').read_text())
        proposal = route_srj(srj, compute=compute, backend=self.policy.compute,
                             budget_s=self.remaining(), emit=self.emit,
                             allowed_layers=[{'F.Cu': 'top', 'B.Cu': 'bottom'}[layer]
                                             for layer in self.policy.routing['layers']
                                             if layer in ('F.Cu', 'B.Cu')])
        atomic_json(directory / 'local-proposal.json', proposal)
        if proposal['status'] != 'candidate':
            raise Blocked(proposal['reason'])
        output = directory / 'import'
        code = self.command('local-import-' + directory.name,
            [self.python, '-m', 'pcb_search.native_srj', 'import', str(export),
             str(directory / 'local-proposal.json'), str(output)])
        if code:
            raise Blocked('bounded local copper proposal rejected by native importer')
        if {row['props'].get('Reference'): row['pose'] for row in footprints(output / 'candidate.kicad_pcb')} != poses:
            raise Blocked('local routing importer changed component placement')
        atomic_copy(output / 'candidate.kicad_pcb', self.native)
        return proposal


def strip_moved_nets(native, refs, allowed_nets, *, allowed_layers):
    """Remove whole affected unlocked nets; preserve every unrelated native form."""
    from pcb_search.block_bindings import footprints, child
    from pcb_search.native_candidate import copper_items
    from pcb_search.native_eco import locked
    from placer.dru import _tree, _tokens
    text, copper = copper_items(native)
    roots = _tree(_tokens(text))[0]
    table = {f[1]: f[2] for f in roots if isinstance(f, list) and f[:1] == ['net'] and len(f) == 3}
    nets, seen = set(), set()
    for fp in footprints(native):
        ref = fp['props'].get('Reference')
        if ref not in refs:
            continue
        seen.add(ref)
        if locked(fp['form']):
            raise Blocked('locked footprint: ' + ref)
        for pad in fp['form']:
            if not isinstance(pad, list) or pad[:1] != ['pad']:
                continue
            value = child(pad, 'net', [])
            if value:
                net = value[-1]
                if net.isdecimal():
                    if net not in table:
                        raise Blocked('unresolved native pad net')
                    net = table[net]
                if net:
                    nets.add(net)
    if seen != set(refs):
        raise Blocked('moved reference is absent from board')
    if not nets <= set(allowed_nets):
        raise Blocked('movement incident nets are outside routing authority: ' + ', '.join(sorted(nets-set(allowed_nets))))
    remove = []
    for row in copper.values():
        if row['net'] in nets:
            a, b = row['span']
            if locked(_tree(_tokens(text[a:b]))[0]):
                raise Blocked('movement would detach locked incident copper')
            form = _tree(_tokens(text[a:b]))[0]
            layers = child(form, 'layer', []) if row['kind'] != 'via' else child(form, 'layers', [])
            if row['kind'] == 'via' and layers == ['F.Cu', 'B.Cu']:
                # A through via can connect every intervening copper layer.
                layers = [r[1] for r in child(roots, 'layers', []) if isinstance(r, list) and r[1].endswith('.Cu')] or layers
            if not layers or not set(layers) <= set(allowed_layers):
                raise Blocked('movement incident copper is outside routing layer authority')
            remove.append((a, b))
    for a, b in sorted(remove, reverse=True):
        text = text[:a] + text[b:]
    temporary = Path(native).with_suffix('.engine-move')
    temporary.write_text(text)
    atomic_copy(temporary, native)
    temporary.unlink()
    return sorted(nets)


def move_proposals(raw, findings, policy):
    """Complete CPU scoring remains authoritative; only diagnosed units move."""
    from placer import cost
    from pcb_search.placement import screen_pose
    from pcb_search.contracts import fingerprint
    implicated = {ref for finding in findings for ref in finding.refs}
    problem = raw['problem']
    initial = [list(p) for p in cost.initial_pose(problem)]
    result = []
    for index, unit in enumerate(problem['units']):
        if unit['fixed'] or not set(unit['refs']) & implicated:
            continue
        if not set(unit['refs']) <= set(policy.movement.refs):
            continue
        if any(unit.get(key) for key in ('borders', 'cuts', 'zones')):
            continue
        step = policy.movement.step_mm
        # One-step proposals preserve the original displacement origin. Repeated
        # search cannot accumulate unbounded motion across candidate restarts.
        for dx, dy in ((step, 0), (0, step), (-step, 0), (0, -step)):
            pose = copy.deepcopy(initial)
            pose[index][0] += dx
            pose[index][1] += dy
            screen = screen_pose(problem, pose, raw['params'], attachments=raw.get('attachments', ()))
            if screen['status'] not in ('candidate', 'needs_native_check'):
                continue
            # cost.total uses the production objective and all active terms.
            score = cost.total(problem, pose, raw['params'])
            result.append(dict(schema='iot-lab.placement-quench.v1', source_sha256=fingerprint(raw),
                qualified=False, status=screen['status'], pose=pose, moved_refs=list(unit['refs']),
                production_score=score, screen=screen, strategy=dict(kind='move', refs=list(unit['refs']), dx=dx, dy=dy)))
    return sorted(result, key=lambda row: (row['production_score'], fingerprint(row['strategy'])))
