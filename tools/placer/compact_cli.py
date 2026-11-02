#!/usr/bin/env python3
"""Compaction driver: search and Freerouting on Hetzner (tools/remote.sh), writer on the Mac.

  $PY tools/placer/compact_cli.py PROB.json BOARD.kicad_pcb --board-dir hardware-design/boards/X/cad/X \
      --outdir DIR --size W H --wheel numpy-...whl [--s0 4] [--budget 2700] [--routes 3] [--target 0]

PROB.json comes from `cli.py read` on BOARD (a copy with the signal tracks removed). Each step writes
DIR/step-N/ (prob.json, search/, b/<board>.kicad_pcb, route-K/). DIR/run.json holds the problem, every
step (s, k, router runs, epoch history, pose) and the verdict, for the viewer (viewer.py).
"""
import argparse
import copy
import fnmatch
import json
import os
import re
import shlex
import shutil
import subprocess
import sys
import time
import math
from concurrent.futures import ThreadPoolExecutor

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from placer import bench, compact, placement_audit  # noqa: E402
import lean_workflow as lean
import lean_resources as resources
import mandatory_preflight

REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
NO_RESULT = 10 ** 6  # a router job without an UNROUTED line (transport error, timeout) never passes


def engineering_route_check(problem, candidate, output):
    """Screen the actual compact copy under the unchanged reviewed owner's policy."""
    from pathlib import Path
    from engineering_constraints import check_manifest, check_problem
    contract = problem['engineering']
    check_problem(problem)  # Stale sources stop before the native screen.
    evidence = None
    if any(rule['kind']=='escape' for rule in contract['rules']):
        from route_decision import generate_escape_for_candidate
        evidence = Path(output).with_name(Path(output).stem+'-escape.json')
        generate_escape_for_candidate(contract['root'],contract['board'],candidate,evidence)
    checked = check_manifest(contract['root'],contract['board'],contract['manifest'],candidate,escape_evidence=evidence)
    lean.atomic_json(output,checked)
    return checked


def parse_unrouted(text):
    m = re.findall(r'^UNROUTED (\d+)', text, re.M)
    return int(m[-1]) if m else NO_RESULT


def skipped_open_scope(counts, decision, folder, reported_counts):
    """Source-bound skipped-net accounting for a routing step, never a full gate."""
    from pathlib import Path
    names = ('input-manifest.json', 'outcome.json', 'drc.json')
    try:
        if (decision.get('status') != 'diagnosed' or decision.get('action') != 'diagnose_selected_connections'
                or {row.get('classification') for row in decision.get('findings', [])} != {'native_open'}):
            return None
        artifacts = decision['artifacts']
        paths = {name:Path(folder)/'route-0'/name for name in names}
        if any(name not in artifacts or lean.digest(path) != artifacts[name] for name, path in paths.items()):
            return None
        manifest, outcome, drc = (json.loads(paths[name].read_text()) for name in names)
        if manifest['board_sha256'] != decision['source_board_sha256']:
            return None
        config = manifest['configuration']
        if (not isinstance(config['skip_net'], str) or not isinstance(config['plane_nets'], str)
                or type(config['gnd_vias']) is not bool or type(config['route_planes']) is not bool):
            return None
        if (not counts or any(type(count) is not int or count != 0 for count in counts)
                or outcome.get('status') != 'complete'
                or any(type(outcome.get(name)) is not int for name in ('signal_open','ground_open','errors'))
                or outcome['signal_open'] != 0 or outcome['errors'] != 0
                or reported_counts != {name:outcome[name] for name in ('signal_open','ground_open','errors')}
                or any(not isinstance(drc.get(name),list) for name in ('violations','unconnected_items','schematic_parity'))
                or drc['schematic_parity'] or any(row.get('severity')=='error' for row in drc['violations'])
                or not drc['unconnected_items'] or outcome['ground_open'] != len(drc['unconnected_items'])):
            return None
        planes = [net for net in config['plane_nets'].split(',') if net]
        if config['gnd_vias'] and 'GND' not in planes:
            planes.append('GND')
        skip = [pattern for pattern in config['skip_net'].split(',') if pattern]
        if not config['route_planes']:
            skip += planes
        else:
            skip = [pattern for pattern in skip if not any(fnmatch.fnmatchcase(net, pattern) for net in planes)]
        nets = set()
        for row in drc['unconnected_items']:
            if not isinstance(row.get('items'), list) or len(row['items']) < 2:
                return None
            descriptions = [item.get('description','') for item in row['items']]
            if any(not isinstance(text,str) or text.count('[') != 1 or text.count(']') != 1 for text in descriptions):
                return None
            endpoints = [re.findall(r'\[([^\[\]]+)\]', text) for text in descriptions]
            if any(len(matches) != 1 or not matches[0] or matches[0] != matches[0].strip() for matches in endpoints):
                return None
            net = endpoints[0][0]
            if (any(matches[0] != net for matches in endpoints)
                    or not (net in planes or any(fnmatch.fnmatchcase(net, pattern) for pattern in skip))):
                return None
            nets.add(net)
        return dict(scope='explicitly_skipped_or_plane_nets_only', status='routing_step_complete',
            excluded_native_opens=len(drc['unconnected_items']), nets=sorted(nets),
            configuration={key:config[key] for key in ('skip_net','plane_nets','gnd_vias','route_planes')},
            qualified=False, native_verified=False, full_configured_gates_required=True)
    except (OSError, ValueError, KeyError, TypeError, AttributeError):
        return None


def route_handoff(counts, decision, folder, *, feedback=None, prior_hints=None, hints=None, reported_counts=None):
    """Keep routed copper; never infer eligibility for an unconfigured repair."""
    from pathlib import Path
    folder = Path(folder)
    candidate = None
    routed, outcome = folder/'route-0/routed.kicad_pcb', folder/'route-0/outcome.json'
    if decision.get('status') == 'diagnosed':
        try:
            if not decision.get('artifacts') or any(lean.digest(folder/'route-0'/name) != digest
                    for name, digest in decision['artifacts'].items()):
                raise ValueError('route evidence changed after diagnosis')
            digest = lean.digest(routed)
            if json.loads(outcome.read_text()).get('board_sha256') == digest:
                candidate = dict(path=str(routed.resolve()), sha256=digest, qualified=False,
                                 full_configured_gates_required=True, preserve_for_next_step=True)
            else:
                raise ValueError('retained candidate changed after routing diagnosis')
        except (OSError, ValueError, TypeError) as error:
            decision = dict(decision, status='unverified', action='inspect_evidence', reason=str(error))
    changed = sorted(ref for ref, value in (hints or {}).items()
                     if value > (prior_hints or {}).get(ref, 0))
    geometry = bool(feedback and feedback.get('accepted') is True and feedback.get('sources')
                    and feedback.get('source_board_sha256') == decision.get('source_board_sha256') and changed)
    if geometry:
        try:
            geometry = all(lean.digest(path) == digest for path, digest in feedback['sources'].items())
        except OSError:
            geometry = False
    decision = dict(decision, geometry_feedback=dict(accepted=geometry, changed_refs=changed,
                        evidence=str((folder/'feedback.json').resolve()) if feedback else None),
                    retained_candidate=candidate, qualified=False, full_configured_gates_required=True,
                    repair_eligibility='Configured isolated workspace and source-bound native parity evidence required before apply_plan; this observation is not repair approval.')
    scope = skipped_open_scope(counts, decision, folder, reported_counts) if candidate else None
    if scope:
        decision['routing_step_scope'] = scope
    result = compact.RouteOutcome(counts, decision, candidate=candidate, geometry_feedback=geometry,
                                  scoped_skipped_opens=bool(scope))
    result.decision['geometry_feedback']['continue_search'] = not result.stop and not result.routing_step_clean
    if result.stop:
        result.decision['next_action'] = dict(kind=decision.get('action', 'inspect_evidence'),
            evidence=decision.get('evidence'), candidate=candidate,
            instruction='Inspect this retained candidate and diagnosis; use the configured repair workflow after its source/parity prerequisites pass.',
            qualified=False, full_configured_gates_required=True)
    return result


def best_line(run):
    """Summary line of the chosen step: board, step, halo, measured length and vias, and why it was chosen."""
    b = run['best']
    m = b.get('measure') or {}
    return 'BEST board %s step %s s %.3f k %.3f unrouted %d length %s mm vias %s box %s mm2 routed %s: %s' % (
        b['board'], run.get('best_step'), b['s'], b['k'], b['unrouted'], m.get('length_mm', 'n/a'),
        m.get('vias', 'n/a'), b.get('box_sum', 'n/a'), m.get('routed', 'n/a'), run.get('best_reason'))


def route_cmd(name, gnd_vias):
    cmd = ['bash', 'tools/placer/fr_job.sh', name]
    return ['env', 'GNDVIAS=1'] + cmd if gnd_vias else cmd


def _remote(board_dir, ins, results, cmd, cpus, log_path):
    env = dict(os.environ, REMOTE_MEM='8g', REMOTE_CPUS=str(cpus))
    args = ['tools/remote.sh', board_dir] + [x for f in ins for x in ('--in', f)] + ['--results', results, '--'] + cmd
    with open(log_path, 'w') as fh:
        rc = subprocess.run(args, cwd=REPO, env=env, stdout=fh, stderr=subprocess.STDOUT).returncode
    return rc, open(log_path).read()


def parser():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('prob')
    ap.add_argument('board')
    ap.add_argument('--board-dir', required=True, help='repo board folder for tools/remote.sh (read only)')
    ap.add_argument('--outdir', required=True)
    ap.add_argument('--size', type=float, nargs=2, required=True, metavar=('W', 'H'))
    ap.add_argument('--search', choices=['local', 'remote'], default='local', help='local: the search runs here '
                    '(default). remote: Hetzner, needs --wheel')
    ap.add_argument('--wheel', default='', help='numpy cp313 manylinux wheel for the remote search')
    ap.add_argument('--s0', type=float, default=4.0)
    ap.add_argument('--budget', type=float, default=2700.0, help='seconds (default 45 min)')
    ap.add_argument('--target', type=int, default=0)
    ap.add_argument('--routes', type=int, default=3, help='parallel Freerouting runs per step (pass: best run <= target)')
    ap.add_argument('--workers', type=int, default=resources.default_cpu())
    ap.add_argument('--epochs', type=int, default=20)
    ap.add_argument('--steps', type=int, default=12000)
    ap.add_argument('--seed', type=int, default=1)
    ap.add_argument('--retain-candidates', type=int, default=1, help='retain up to 8 alternatives; routes only the selected legal candidate')
    ap.add_argument('--seeded-policy', action='store_true', help='enforce fixed units and no swaps or turns, including legalizer turns')
    ap.add_argument('--max-displacement', type=float, default=None, help='optional rejecting displacement cap from the input seed (mm)')
    ap.add_argument('--feedback-max-mm', type=float, default=1.0, help='cumulative per-reference pin-escape soft spacing cap (mm)')
    ap.add_argument('--congestion-feedback', action='store_true', help='opt-in bounded ENCLOSED blocker spacing; requires clean attributed native evidence')
    ap.add_argument('--param', nargs='*', default=[])
    ap.add_argument('--scatter', type=int, metavar='SEED', help='start each search from seeded uniform places inside '
                    'the (virtual) board: for parts staged outside the outline')
    ap.add_argument('--gnd-vias', action='store_true', help='tools/gnd_pad_vias.py before Freerouting: Freerouting '
                    'leaves GND pads open when the GND plane is on an inner layer')
    ap.add_argument('--snapshots', metavar='DIR', help='after the run: viewer.html, frames.json, timelapse '
                    '(PNG frames, run.gif, run.mp4) and one routed render per step in DIR (scratch, not committed)')
    ap.add_argument('--router', choices=['freerouting', 'fastroute', 'iotroute'], default='fastroute',
                    help='fastroute: tools/fastroute_job.py on this computer (default). freerouting: 2.1.0 on Hetzner '
                    '(its timed-out runs lost most of the result, 2026-10-03; kept for old benchmarks only). '
                    'iotroute: tools/router/run.py on this computer; step score = DRC errors + unconnected + parity '
                    '+ board gate (placer/iotroute_step.py), never the router claim')
    ap.add_argument('--passes', type=int, default=40, help='router passes per step (fastroute; iotroute --iters)')
    ap.add_argument('--repair', action='store_true', help='iotroute only: a failed step with located DRC failures '
                    'runs the failure-driven repair (placer/repair.py) on its routed board; the step passes when the '
                    'repair reaches DRC 0/0/0 + gate at target')
    ap.add_argument('--repair-mode', choices=['reuse', 'local', 'full'], default='reuse', help='repair re-route: reuse '
                    '(run.py --reuse from the failed route: keep the copper of the nets the move does not touch, route the '
                    'rest; default), local (rip the failure region and the moved-part copper, lock the rest) or full')
    ap.add_argument('--repair-rank', choices=['term', 'hot'], default='term', help='repair proposal order: term '
                    '(failure term decrease; default) or hot (first the moves that take the most PathFinder history of '
                    'the failed route away from the unit pins, router congestion map; placer/congest.py)')
    ap.add_argument('--repair-routes', type=int, default=8, help='router runs per step for the repair (cap)')
    ap.add_argument('--repair-per-round', type=int, default=4, help='proposals routed per repair round')
    ap.add_argument('--read-args', default='', help='cli.py read arguments of PROB.json, one string (the repair reads '
                    'the problem again from each repaired board)')
    ap.add_argument('--diagnostic-budget', type=float, default=None,
                    help='seconds reserved for virtual diagnostics after real-outline failures')
    ap.add_argument('--optimizer', choices=['always', 'off', 'if-routed'], default='always')
    ap.add_argument('--route-args', default='', help='more arguments for tools/fastroute_job.py, one string '
                    '(for example "--layers F.Cu,In2.Cu,B.Cu --plane-nets GND,+3V3")')
    ap.add_argument('--virtual-first', action='store_true', help='old order: virtual (scaled) board first. Default: '
                    'the real outline first, at the largest halo that fits; the halo decreases only after a pass')
    ap.add_argument('--max-routes', type=int, default=0, help='hard cap on router runs in this call (0 = no cap): '
                    'when reached, later steps get no search and no route (fail fast, user rule 2026-10-11)')
    ap.add_argument('--k-cap', type=float, default=None, help='largest board scale of the halo phase (1: real '
                    'outline only, no growth); with --virtual-first')
    ap.add_argument('--shrink', type=float, default=0.85, help='halo scale factor after a pass')
    ap.add_argument('--tol', type=float, default=0.05, help='halo bisection stops at this relative gap')
    ap.add_argument('--rank', choices=compact.RANKS, default=None, help='result = the passing step with: length = '
                    'the shortest routed length (ties: fewer vias, smaller block box sum; needs --router iotroute, '
                    'its default), halo = the smallest halo (maximum compaction; default for the other routers)')
    ap.add_argument('--length-patience', type=int, default=compact.LENGTH_PATIENCE, metavar='K',
                    help='rank length: stop the halo shrink when K consecutive passing steps rank after the best '
                    'step so far (default %d, 0 = no stop; README "Rank by routed length")' % compact.LENGTH_PATIENCE)
    return ap


def main(argv=None):
    a = parser().parse_args(argv)
    if getattr(a, 'repair_rank', 'term') == 'hot':  # rank 'hot' reads the map of the failed route: run.py writes it
        os.environ['IOTROUTE_CONGESTION'] = '1'
    from placer import kicad_io
    if not math.isfinite(a.budget) or a.budget <= 0:
        raise ValueError('budget must be positive')
    if a.diagnostic_budget is not None and (not math.isfinite(a.diagnostic_budget) or a.diagnostic_budget < 0):
        raise ValueError('diagnostic budget must be finite and nonnegative')
    if not 1 <= a.retain_candidates <= 8:
        raise ValueError('retain-candidates must be 1..8')
    if not math.isfinite(a.feedback_max_mm) or not 0 <= a.feedback_max_mm <= 2:
        raise ValueError('feedback cap must be finite, 0..2mm')
    if a.max_displacement is not None and (not math.isfinite(a.max_displacement) or a.max_displacement <= 0):
        raise ValueError('displacement cap must be finite and positive')
    if a.seeded_policy:
        from placer.cli import parse_params
        p = parse_params(a.param)
        if a.scatter is not None or any(p.get(k, 0) for k in ('p_swap','p_rot','global','rotate','legal_rotate')):
            raise ValueError('seeded policy prohibits scatter, global placement, swaps and turns')
        a.param += ['p_swap=0','p_rot=0','legal_rotate=0']
    if a.max_displacement is not None:
        if not a.seeded_policy:
            raise ValueError('displacement cap requires seeded policy')
        a.param += ['max_displacement=%s' % a.max_displacement]
    if a.repair and a.router != 'iotroute':
        raise ValueError('--repair needs --router iotroute')
    if a.rank is None:
        a.rank = 'length' if a.router == 'iotroute' else 'halo'
    if a.rank == 'length' and a.router != 'iotroute':
        raise ValueError('--rank length needs --router iotroute (the only router step that measures the routed board)')
    if a.length_patience < 0:
        raise ValueError('--length-patience must be 0 or more')
    deadline = lean.deadline_after(a.budget)
    with open(a.prob) as problem_file:
        pr = json.load(problem_file)
    if pr.get('engineering'):
        from engineering_constraints import check_problem
        check_problem(pr)  # Source/coverage errors stop before search or routing.
    if os.path.isdir(a.outdir) and os.listdir(a.outdir):
        raise ValueError('compaction output directory must be fresh')
    os.makedirs(a.outdir, exist_ok=True)
    events = os.path.join(a.outdir, 'stages.jsonl')
    lean.atomic_json(os.path.join(a.outdir, 'input-manifest.json'),
                     dict(board=os.path.abspath(a.board), board_sha256=lean.digest(a.board),
                          problem_sha256=lean.digest(a.prob), configuration=vars(a), qualified=False,
                          sidecars={ext:lean.digest(os.path.splitext(a.board)[0]+ext)
                                    for ext in ('.kicad_pro','.kicad_dru') if os.path.isfile(os.path.splitext(a.board)[0]+ext)},
                          note='run attribution only; no cached result reuse or release qualification'))
    seed_receipt = None
    if a.router == 'fastroute' and (os.path.splitext(os.path.basename(a.board))[0] == 'BASE-PWR-B' or os.environ.get('ROUTE_BOARD') == 'BASE-PWR-B'):
        import fastroute_job
        import pcbnew
        import route_features
        seed_args = fastroute_job._parse_args([a.board, a.outdir] +
                    (['--gnd-vias'] if a.gnd_vias else []) + shlex.split(a.route_args))
        board_dir = os.path.join(REPO, 'hardware-design', 'boards', 'BASE-PWR-B')
        preflight_started = lean.now()
        native_started = False
        try:
            with resources.reserve(1, wait_s=min(30., max(0., deadline-lean.now())),
                                   events=os.path.join(a.outdir, 'admission.jsonl'), label='seed-preflight'):
                if lean.now() >= deadline:
                    raise subprocess.TimeoutExpired('seed-preflight', 0)
                native_started = True
                _, seed_receipt = mandatory_preflight.inspect(seed_args, board_dir, os.environ.get('ROUTE_BOARD', ''),
                                                             pcbnew.LoadBoard, lean.digest, route_features.ROOT)
                preflight_finished = lean.now()
                if preflight_finished >= deadline:
                    raise subprocess.TimeoutExpired('seed-preflight', 0)
        except (subprocess.TimeoutExpired, TimeoutError) as exc:
            cause = 'workflow_deadline' if isinstance(exc, subprocess.TimeoutExpired) else 'resource_admission_timeout'
            with open(events, 'a') as fh:
                fh.write(json.dumps(dict(stage='seed-preflight', status='timeout', cause=cause, started=preflight_started,
                         elapsed_s=lean.now()-preflight_started, blocking_native=native_started)) + '\n')
            if seed_receipt is not None:
                lean.atomic_json(os.path.join(a.outdir, 'seed-mandatory-preflight.json'), seed_receipt)
            lean.atomic_json(os.path.join(a.outdir, 'run.json'), dict(steps=[], best=None, qualified=False,
                             stop='seed preflight timeout', verdict='seed preflight timeout', cause=cause))
            print('VERDICT seed preflight timeout', flush=True)
            print('STOP seed preflight timeout', flush=True)
            raise SystemExit(124)
        with open(events, 'a') as fh:
            fh.write(json.dumps(dict(stage='seed-preflight', status='complete', started=preflight_started,
                     elapsed_s=preflight_finished-preflight_started, blocking_native=True)) + '\n')
        seed_path = os.path.join(a.outdir, 'seed-mandatory-preflight.json')
        lean.atomic_json(seed_path, seed_receipt)
        fatal = mandatory_preflight.locked_faults(seed_receipt, lean.digest(a.board),
                  seed_receipt['source_records'], seed_receipt, seed_receipt['policy_sources'])
        if fatal:
            lean.atomic_json(os.path.join(a.outdir, 'run.json'), dict(steps=[], best=None,
                             qualified=False, stop='immutable input mandatory rules',
                             verdict='immutable input mandatory rules', failure_receipt=seed_path,
                             immutable_faults=fatal, problem_sha256=lean.digest(a.prob)))
            print('VERDICT immutable input mandatory rules', flush=True)
            print('STOP immutable input mandatory rules', flush=True)
            raise SystemExit(5)
    def run_stage(cmd, stage, **kwargs):
        cpu = a.workers if stage == 'placement' else resources.default_cpu()
        if stage == 'routing' and a.router == 'iotroute':  # the router's real thread use, not the whole budget
            cpu = iotroute_step.router_cpu(full=resources.default_cpu())
        if stage == 'routing':
            args = shlex.split(a.route_args)
            for i, arg in enumerate(args):
                if arg == '--threads':
                    cpu = int(args[i+1]) or resources.default_cpu()
                elif arg.startswith('--threads='):
                    cpu = int(arg.split('=', 1)[1]) or resources.default_cpu()
        try:
            with resources.reserve(cpu, wait_s=min(30., max(0., deadline-lean.now())),
                                   events=os.path.join(a.outdir, 'admission.jsonl'), label=stage) as env:
                env['IOT_LEAN_DEADLINE'] = lean.encode_deadline(deadline)
                return lean.run_stage(cmd, stage=stage, event_file=events, deadline=deadline, env=env, **kwargs)
        except TimeoutError as e:
            raise subprocess.TimeoutExpired(cmd, 0) from e
    name = os.path.splitext(os.path.basename(a.board))[0]
    src = os.path.dirname(os.path.abspath(a.board))
    wheel = os.path.abspath(a.wheel) if a.wheel else ''

    def sdir(n):
        d = os.path.join(os.path.abspath(a.outdir), 'step-%d' % n)
        os.makedirs(d, exist_ok=True)
        return d

    # Route feature pin_escape_check (tools/route-features.json): the parts with boxed-in pins of the last routed
    # step (route-0/pin-escape.json of tools/fastroute_job.py) get halo_hint_mm more spacing in the next search.
    escape_hint = {}
    routes_done = [0]   # router runs started in this call (--max-routes)

    def audit_search(q, n, res):
        reports = []
        for c in res['candidates']:
            try:
                report = placement_audit.candidate_report(q, c, res.get('params', {}),
                                                         a.seeded_policy, a.max_displacement)
                if q.get('engineering'):
                    checked = check_problem(q,c['pose'])
                    report['engineering'] = checked
                    report['illegal'] += ['engineering:'+b['id'] for b in checked['blockers']]
            except (ValueError, TypeError):
                report = dict(illegal=['malformed placement evidence'], qualified=False)
            c['illegal'] = report['illegal']
            reports.append(report)
        lean.atomic_json(os.path.join(sdir(n), 'placement-audit.json'),
                         dict(board_sha256=lean.digest(a.board), problem_sha256=placement_audit.identity(q),
                              candidates=reports, retained=len(reports), qualified=False))
        # An illegal or timed-out alternative cannot win merely by having a lower score.
        res['candidates'].sort(key=placement_audit.candidate_key)
        return res

    def search(q, n):
        nonlocal deadline
        if q.get('engineering'):
            check_problem(q)  # In particular, a virtual outline cannot bypass the reviewed source.
        if a.max_routes and routes_done[0] >= a.max_routes:
            print('search step %d: skipped, router cap %d reached' % (n, a.max_routes), flush=True)
            return None
        # Virtual input changes the outline; use it only as a bounded diagnostic.
        outline = q['board']['outline']
        xs, ys = [v[0] for v in outline], [v[1] for v in outline]
        virtual = max(xs)-min(xs) > a.size[0]+1e-6 or max(ys)-min(ys) > a.size[1]+1e-6
        if virtual and a.diagnostic_budget is not None and not getattr(search, 'diagnostic_started', False):
            deadline = min(deadline, lean.now()+a.diagnostic_budget)
            search.diagnostic_started = True
        d = sdir(n)
        if escape_hint:
            q = copy.deepcopy(q)
            for u in q['units']:
                names = set(u.get('refs', [])) | {u.get('name', ''), u.get('ref', '')}
                extra = max([escape_hint.get(r, 0.0) for r in names] + [0.0])
                if extra:
                    for r in u['rects']:
                        r[4] += extra
        if a.scatter is not None:
            q = bench.scatter(q, a.scatter)
        json.dump(q, open(os.path.join(d, 'prob.json'), 'w'))
        if a.search == 'local':
            # The search uses a.workers processes: a many-core job, so it runs here (KiCad Python has numpy).
            res_path = os.path.join(d, 'search', 'res.json')
            os.makedirs(os.path.dirname(res_path), exist_ok=True)
            cmd = [sys.executable, os.path.join(REPO, 'tools', 'placer', 'cli.py'), 'run', os.path.join(d, 'prob.json'),
                   '-o', res_path, '--workers', str(a.workers), '--epochs', str(a.epochs), '--steps', str(a.steps),
                   '--seed', str(a.seed), '--top', str(a.retain_candidates)] + (['--param'] + a.param if a.param else [])
            with open(os.path.join(d, 'search.log'), 'w') as fh:
                rc = run_stage(cmd, 'placement', cwd=REPO, stdout=fh, stderr=subprocess.STDOUT).returncode
            if not os.path.exists(res_path):
                print('search step %d: no result (rc %d), see %s' % (n, rc, os.path.join(d, 'search.log')), flush=True)
                return None
            return audit_search(q, n, json.load(open(res_path)))
        cmd = ['bash', 'tools/placer/remote_run.sh', 'run', 'in/prob.json', '-o', 'out/res.json',
               '--workers', str(a.workers), '--epochs', str(a.epochs), '--steps', str(a.steps),
               '--seed', str(a.seed), '--top', str(a.retain_candidates)] + (['--param'] + a.param if a.param else [])
        if q.get('engineering'):
            cmd += ['--engineering-frozen-model-sha256',lean.digest(os.path.join(d,'prob.json'))]
        rc, _ = _remote(a.board_dir, [os.path.join(d, 'prob.json'), wheel], os.path.join(d, 'search'), cmd,
                        a.workers, os.path.join(d, 'search.log'))
        res_path = os.path.join(d, 'search', 'res.json')
        if not os.path.exists(res_path):
            print('search step %d: no result (rc %d), see %s' % (n, rc, os.path.join(d, 'search.log')), flush=True)
            return None
        return audit_search(q, n, json.load(open(res_path)))

    def write(q, pose, k, n):
        b = os.path.join(sdir(n), 'b')
        os.makedirs(b, exist_ok=True)
        for ext in ('.kicad_pro', '.kicad_dru', '.kicad_sch'):
            if os.path.exists(os.path.join(src, name + ext)):
                shutil.copy(os.path.join(src, name + ext), b)
        out = os.path.join(b, name + '.kicad_pcb')
        kicad_io.write_board(a.board, q, [tuple(p) for p in pose], out, outline_scale=k)
        return out

    routing_attempts = {}
    if a.router == 'iotroute':
        from placer import iotroute_step
        iotroute_board = iotroute_step.board_id(a.board_dir)
        iotroute_gate = iotroute_step.GateWorkspace(a.outdir, iotroute_board)

    def route(path, n):
        from placer.compact_cli import route_handoff
        d = sdir(n)
        if pr.get('engineering'):
            checked = engineering_route_check(pr,path,os.path.join(d,'engineering-pre-route.json'))
            if checked['status']!='passed':
                decision = dict(status='unverified', action='resolve_placement_requirements', qualified=False,
                    reason='Reviewed placement blocks routing: '+str(checked['blockers']),
                    evidence=os.path.join(d,'engineering-pre-route.json'))
                return route_handoff([NO_RESULT], decision, d)
        if a.max_routes and routes_done[0] >= a.max_routes:
            return route_handoff([NO_RESULT], dict(status='unverified', action='inspect_route_budget',
                reason='Router attempt cap reached; no further search/routing', qualified=False), d)
        if a.router == 'fastroute':
            import route_decision
            attempt_key = route_decision.retry_key(path,dict(passes=a.passes,optimizer=a.optimizer,
                route_args=a.route_args,gnd_vias=a.gnd_vias,router=a.router))
            if attempt_key in routing_attempts:
                prior = routing_attempts[attempt_key]
                decision = dict(prior,
                    status='unchanged_failed_attempt',action='inspect_prior_diagnosis',
                    reason='Identical source/rules/effort already failed in this loop; no blind reroute',
                    prior_decision=prior['evidence'])
                print('STUCK: unchanged failed routing input; inspect '+prior['evidence'],flush=True)
                result = route_handoff([NO_RESULT], decision, d)
                result.candidate = prior.get('retained_candidate')
                result.decision['retained_candidate'] = result.candidate
                result.decision['next_action']['candidate'] = result.candidate
                lean.atomic_json(os.path.join(d,'route-decision.json'), result.decision)
                return result
        routes_done[0] += 1
        b = os.path.dirname(path)
        ins = [os.path.join(b, name + ext) for ext in ('.kicad_pcb', '.kicad_pro', '.kicad_dru')
               if os.path.exists(os.path.join(b, name + ext))]

        if a.router == 'iotroute':
            # Plain counts, as the Freerouting path: a failed step bisects the halo, it does not stop the loop.
            counts = iotroute_step.route_step(path, d, iotroute_board, iotroute_gate, a.passes,
                                              shlex.split(a.route_args), run_stage)
            measure = iotroute_step.measure(d)
            if a.repair and 0 < counts[0] < NO_RESULT:
                from placer import repair
                routed = os.path.join(d, 'route-0', os.path.basename(path))
                rec = repair.run(iotroute_board, path, routed, os.path.join(d, 'repair'), a.repair_mode,
                                 a.repair_routes, a.repair_per_round, a.passes, a.seed,
                                 not a.seeded_policy, shlex.split(a.read_args), iotroute_gate,
                                 log=lambda m: print(m, flush=True), rank_mode=a.repair_rank)
                routes_done[0] += len(rec['attempts'])
                print('REPAIR step %d %s key %s board %s' % (n, 'PASS' if rec['passed'] else 'FAIL',
                      rec['best']['key'], rec['best']['routed']), flush=True)
                if repair.better(rec['best']['key'], rec['start']['key']):
                    best = rec['best']['key']
                    counts = [0 if rec['passed'] else (best[0] or best[1])]
                    measure = iotroute_step.measure_key(best, rec['best']['routed'], 'repair')
            return compact.Measured(counts, measure)

        if a.router == 'fastroute':
            # Fastroute runs here (many cores, user rule 2026-10-03); it is deterministic, so one run per step.
            # The count is the KiCad DRC unconnected count of the verified result (tools/fastroute_job.py).
            cmd = [sys.executable, os.path.join(REPO, 'tools', 'fastroute_job.py'), path, os.path.join(d, 'route-0'),
                   '--passes', str(a.passes), '--optimizer', a.optimizer, '--render'] + (['--gnd-vias'] if a.gnd_vias else []) + shlex.split(a.route_args)
            p = run_stage(cmd, 'routing', cwd=REPO, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
            with open(os.path.join(d, 'route-0.log'), 'w') as route_log:
                route_log.write(p.stdout)
            # Exit 3 (fastroute_job STUCK_RC, route feature fail_fast): routed with opens, UNROUTED line and triage written.
            if p.returncode not in (0, 3):
                receipt_path = os.path.join(d, 'route-0', 'mandatory-preflight.json')
                if seed_receipt is not None and os.path.isfile(receipt_path):
                    try:
                        with open(receipt_path) as fh:
                            receipt = json.load(fh)
                        current_policy = {p: lean.digest(p) for p in receipt['policy_sources']}
                        current_board = pcbnew.LoadBoard(path)
                        rows = mandatory_preflight.records(current_board) if current_board is not None else []
                        fatal = mandatory_preflight.locked_faults(receipt, lean.digest(path), rows,
                                                                seed_receipt, current_policy)
                        if fatal:
                            raise mandatory_preflight.ImmutableInputFailure(dict(receipt, faults=fatal), receipt_path)
                    except (OSError, ValueError, KeyError, TypeError):
                        pass  # invalid/stale evidence is an ordinary failed candidate
                decision = dict(status='unverified', action='inspect_evidence', qualified=False,
                    evidence=os.path.join(d,'route-decision.json'),
                    reason='Router/import/native check did not complete; inspect route-0.log', tool_exit=p.returncode)
                result = route_handoff([NO_RESULT], decision, d)
                lean.atomic_json(decision['evidence'], result.decision)
                routing_attempts[attempt_key] = result.decision
                return result
            decision = route_decision.observe_route(path,os.path.join(d,'route-0'))
            decision['evidence'] = os.path.join(d,'route-decision.json')
            decision['attempt_sha256'] = attempt_key
            print('ROUTE_DECISION '+decision['action']+'; '+decision['reason']+'; evidence='+decision['evidence'],flush=True)
            prior_hints = dict(escape_hint)
            hints, evidence = placement_audit.bounded_feedback(pr, os.path.join(d, 'route-0'),
                                                              lean.digest(path), escape_hint,
                                                              a.feedback_max_mm, a.congestion_feedback)
            escape_hint.clear()
            escape_hint.update(hints)
            lean.atomic_json(os.path.join(d, 'feedback.json'), evidence)
            # A step passes on 0 open signal connections and 0 DRC errors (the plane-net opens are counted apart).
            m = re.findall(r'^UNROUTED (\d+) GND_OPEN (\d+) ERRORS (\d+)', p.stdout, re.M)
            reported = dict(zip(('signal_open','ground_open','errors'), map(int,m[-1]))) if m else None
            score = reported['signal_open'] + reported['errors'] if reported else NO_RESULT
            result = route_handoff([score], decision, d, feedback=evidence, prior_hints=prior_hints,
                                   hints=hints, reported_counts=reported)
            lean.atomic_json(decision['evidence'], result.decision)
            if score or p.returncode == 3:
                routing_attempts[attempt_key] = result.decision
            return result

        def one(r):
            rc, text = _remote(a.board_dir, ins, os.path.join(d, 'route-%d' % r),
                               route_cmd(name, a.gnd_vias), 4, os.path.join(d, 'route-%d.log' % r))
            return parse_unrouted(text)
        with ThreadPoolExecutor(a.routes) as ex:
            return list(ex.map(one, range(a.routes)))

    run = compact.run_loop(pr, tuple(a.size), search, write, route, s0=a.s0,
                           budget=max(0., deadline-lean.now()), target=a.target,
                           shrink=a.shrink, tol=a.tol, log=lambda s: print(s, flush=True),
                           real_first=not a.virtual_first, diagnostic_budget=a.diagnostic_budget, k_cap=a.k_cap,
                           rank=a.rank, length_patience=a.length_patience if a.rank == 'length' else None)
    run['problem'] = pr
    run['size'] = list(a.size)
    json.dump(run, open(os.path.join(a.outdir, 'run.json'), 'w'))
    print('VERDICT', run['verdict'])
    print('STOP', run['stop'])
    if run['stop'] == 'immutable input mandatory rules':
        raise SystemExit(5)
    if run.get('next_action'):
        print('STUCK: inspect retained candidate; evidence='+str(run['next_action'].get('evidence')), flush=True)
        raise SystemExit(3)
    if run['best']:
        print(best_line(run), flush=True)
    if a.snapshots:
        from placer import movie, viewer
        rj = os.path.join(a.outdir, 'run.json')
        os.makedirs(a.snapshots, exist_ok=True)
        viewer.main([rj, os.path.join(a.snapshots, 'viewer.html'), '--frames-json',
                     os.path.join(a.snapshots, 'frames.json')])
        movie.main([rj, a.snapshots, '--routed', a.outdir])


if __name__ == '__main__':
    main()
