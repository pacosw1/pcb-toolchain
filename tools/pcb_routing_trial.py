"""Prepare one controlled solver invocation; final native acceptance stays upstream."""
import copy
from fractions import Fraction
import hashlib
import json
import math
import os
from pathlib import Path
import re
import shutil
import socket
import subprocess

import lean_workflow as lean
from pcb_workflow import board_config, python_native, sha


SCHEMA = 'iot-lab.routing-policy.v1'
EXECUTION = 'iot-lab.placement-outcome-execution.v1'
FIELDS = {'schema', 'layers', 'only_nets', 'passes', 'threads', 'timeout_s', 'optimizer', 'max_repairs'}


def validate(config, total_timeout_s):
    if not isinstance(config, dict) or set(config) != FIELDS or config.get('schema') != SCHEMA:
        raise ValueError('controlled routing requires exactly the routing-policy.v1 fields')
    for key in ('passes', 'threads', 'timeout_s'):
        if type(config[key]) is not int or config[key] <= 0:
            raise ValueError(key + ' must be a positive integer')
    if (type(total_timeout_s) not in (int, float) or not math.isfinite(total_timeout_s)
            or total_timeout_s <= 0 or config['timeout_s'] > total_timeout_s):
        raise ValueError('router timeout must fit the complete CLI deadline')
    if config['optimizer'] not in ('off', 'if-routed'):
        raise ValueError('controlled optimizer must be off or if-routed')
    if type(config['max_repairs']) is not int or config['max_repairs'] != 0:
        raise ValueError('this policy permits zero separate CLI repair operations')
    for key in ('layers', 'only_nets'):
        value = config[key]
        if (not isinstance(value, list) or not value or any(not isinstance(v, str) or not v for v in value)
                or len(set(value)) != len(value)):
            raise ValueError(key + ' requires a nonempty list of distinct exact names')
    if any(not re.fullmatch(r'(?:F|B|In(?:[1-9]|[12][0-9]|30))\.Cu', v) for v in config['layers']):
        raise ValueError('unsupported copper layer name')
    if any(any(c in v for c in ',*?[]\r\n\x00') for v in config['only_nets']):
        raise ValueError('only_nets must contain explicit comma-free net names, without macros')
    return copy.deepcopy(config)


def _executable(name):
    path = shutil.which(name)
    if not path:
        raise ValueError('controlled routing executable is unavailable: ' + str(name))
    return Path(path).resolve()


def _probe(command, env, probes):
    try:
        run = lean.run_stage(command, stage='routing-runtime-probe', deadline=lean.deadline_after(5),
                             env=env, text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    except subprocess.SubprocessError as error:
        raise ValueError('controlled routing runtime probe failed: ' + str(error)) from error
    text = (run.stdout + run.stderr).strip()
    probes.append(dict(command=command, returncode=run.returncode, output=text))
    if run.returncode or not text:
        raise ValueError('controlled routing version probe failed: ' + str(command))
    return text


def _cgroups():
    """Read enforceable limits when exposed; never infer them from host CPU count."""
    result = {}
    cpu = Path('/sys/fs/cgroup/cpu.max')
    if cpu.is_file():
        quota, period = cpu.read_text().split()
        result['cpus'] = Fraction(int(quota), int(period)) if quota != 'max' else None
    else:
        quota = Path('/sys/fs/cgroup/cpu/cpu.cfs_quota_us')
        period = Path('/sys/fs/cgroup/cpu/cpu.cfs_period_us')
        if quota.is_file() and period.is_file():
            amount = int(quota.read_text())
            result['cpus'] = Fraction(amount, int(period.read_text())) if amount > 0 else None
    memory = Path('/sys/fs/cgroup/memory.max')
    if memory.is_file():
        raw = memory.read_text().strip()
        result['memory_bytes'] = int(raw) if raw != 'max' else None
    else:
        memory = Path('/sys/fs/cgroup/memory/memory.limit_in_bytes')
        if memory.is_file():
            amount = int(memory.read_text())
            result['memory_bytes'] = amount if amount > 0 else None
    if hasattr(os, 'sched_getaffinity'):
        result['affinity_cpus'] = len(os.sched_getaffinity(0))
    return result


def execution_context():
    name = os.environ.get('PCB_EXECUTION_CONTEXT')
    if not name:
        raise ValueError('controlled routing needs the host-recorded Docker inspect context')
    path = Path(name).absolute()
    if not path.is_file() or path.is_symlink():
        raise ValueError('execution context must be an original regular inspect receipt')
    raw = path.read_bytes()
    value = json.loads(raw)
    if isinstance(value, list):
        if len(value) != 1:
            raise ValueError('execution context must identify exactly one running container')
        value = value[0]
    if not isinstance(value, dict) or not re.fullmatch(r'[0-9a-f]{64}', value.get('Id', '')):
        raise ValueError('execution context is not an original container inspect response')
    image = value.get('Image', '')
    if not re.fullmatch(r'sha256:[0-9a-f]{64}', image):
        raise ValueError('execution context lacks the immutable actual image identity')
    if value.get('Config', {}).get('Hostname') != socket.gethostname():
        raise ValueError('execution context belongs to another container hostname')
    mounts = []
    for mount in value.get('Mounts', []):
        target = Path(mount.get('Destination', '/__missing__'))
        if target == path or target in path.parents:
            mounts.append((len(target.parts), mount))
    if not mounts or max(mounts, key=lambda row: row[0])[1].get('RW') is not False:
        raise ValueError('original execution context must be mounted read-only')
    host = value.get('HostConfig', {})
    if host.get('NetworkMode') != 'none':
        raise ValueError('controlled routing requires the recorded network-none runner')
    nano, memory = host.get('NanoCpus'), host.get('Memory')
    if type(nano) is not int or nano <= 0 or type(memory) is not int or memory <= 0:
        raise ValueError('actual runner must enforce explicit CPU and memory limits')
    cpus = Fraction(nano, 1000000000)
    observed = _cgroups()
    if observed.get('cpus', cpus) != cpus or observed.get('memory_bytes', memory) != memory:
        raise ValueError('actual cgroup limits differ from the host inspect receipt')
    if observed.get('affinity_cpus', float(cpus)) < cpus:
        raise ValueError('actual CPU affinity is narrower than the recorded quota')
    return dict(path=path, raw=raw, image_id=image, container_id=value['Id'],
                cpus=float(cpus), memory_bytes=memory,
                observed_cgroup={k: float(v) if isinstance(v, Fraction) else v for k, v in observed.items()})


def _board(root, native, board):
    if board:
        _, _, project = board_config(root, board)
        if project.with_suffix('.kicad_pcb') != native:
            raise ValueError('controlled route input differs from the configured board')
        return board
    found = []
    for path in (root / 'hardware-design/boards').glob('*/gate.json'):
        if board_config(root, path.parent.name)[2].with_suffix('.kicad_pcb') == native:
            found.append(path.parent.name)
    if len(found) != 1:
        raise ValueError('controlled route requires one authoritative configured board binding')
    return found[0]


def validate_gate(root, board):
    """Run the existing pure gate validator before any expensive admission."""
    root = Path(root).resolve()
    config = root / 'hardware-design/boards' / board / 'gate.json'
    core = root / 'tools/lib/gate-core.mjs'
    node = _executable(os.environ.get('NODE', 'node'))
    before = {str(path): sha(path) for path in (config, core, node)}
    program = ('import {readFileSync} from "node:fs"; import {validateConfig} from '
        + json.dumps(core.as_uri()) + ';'
        'const cfg=JSON.parse(readFileSync(process.argv[1],"utf8"));'
        'const stage=cfg?.stage??"G4"; const errors=validateConfig(cfg);'
        'if(!["G4","G5"].includes(stage))errors.push("controlled routing requires a G4 or G5 gate");'
        'process.stdout.write(JSON.stringify({stage,errors}));process.exit(errors.length?1:0);')
    try:
        run = lean.run_stage([str(node), '--input-type=module', '-e', program, str(config)],
            stage='routing-gate-admission', deadline=lean.deadline_after(5),
            cwd=root, env=dict(os.environ), text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        verdict = json.loads(run.stdout)
    except (OSError, ValueError, subprocess.SubprocessError) as error:
        raise ValueError('controlled routing gate admission failed: ' + str(error)) from error
    errors = verdict.get('errors') if isinstance(verdict, dict) else None
    if (not isinstance(errors, list) or any(not isinstance(item, str) for item in errors)
            or verdict.get('stage') not in ('G4', 'G5') or run.returncode or errors):
        detail = '; '.join(errors) if isinstance(errors, list) and all(isinstance(item, str) for item in errors) else run.stderr.strip()
        raise ValueError('controlled routing gate configuration rejected: ' + (detail or 'invalid validator result'))
    if any(sha(path) != digest for path, digest in before.items()):
        raise ValueError('gate configuration or validator changed during admission')
    return dict(stage=verdict['stage'], inputs=before)


_gate_admission = validate_gate


def _features(root, board):
    value = json.loads((root / 'tools/route-features.json').read_text())['features']
    overrides = board_config(root, board)[1].get('route_features', {})
    for name, changes in overrides.items():
        value.setdefault(name, {}).update(changes)
    return value


def prepare(root, native, output, config, total_timeout_s, *, board=None):
    root, native, output = Path(root).resolve(), Path(native).resolve(), Path(output).resolve()
    config = validate(config, total_timeout_s)
    if not native.is_relative_to(root) or not native.is_file():
        raise ValueError('solver input must be the isolated workspace native PCB')
    if output.exists():
        raise ValueError('solver output must be a fresh directory')
    board = _board(root, native, board)
    gate = _gate_admission(root, board)
    if os.environ.get('ROUTE_FEATURES') or os.environ.get('ROUTE_FEATURES_FILE'):
        raise ValueError('external route feature overrides are unsupported in controlled trials')
    if os.environ.get('ROUTE_BOARD', board) not in ('', board):
        raise ValueError('route environment belongs to another board')
    if any(os.environ.get(key) for key in ('PYTHONHOME', 'LD_PRELOAD', 'LD_LIBRARY_PATH', 'DYLD_LIBRARY_PATH')):
        raise ValueError('external runtime loader overrides are unsupported in controlled trials')
    context = execution_context()
    if config['threads'] > context['cpus']:
        raise ValueError('router threads exceed the actual container CPU quota')
    python = _executable(python_native())
    router = _executable(os.environ.get('FASTROUTE_BIN') or os.path.expanduser('~/opt/fastroute/fastroute-0.1.7-macos-arm64/fastroute'))
    kicad = _executable(os.environ.get('KICAD_CLI', 'kicad-cli'))
    script = root / 'tools/fastroute_job.py'
    if not script.is_file():
        raise ValueError('existing fastroute job producer is missing from the snapshot')
    features = _features(root, board)
    inputs = {str(path): sha(path) for path in (script, root/'tools/route_features.py', root/'tools/route_rule_coverage.py', root/'tools/route-features.json',
              root/'hardware-design/boards'/board/'gate.json', Path(__file__).resolve(), python, router, kicad)}
    inputs.update(gate['inputs'])
    for extension in ('.kicad_pcb', '.kicad_sch', '.kicad_pro', '.kicad_dru'):
        path = native.with_suffix(extension)
        if not path.is_file():
            raise ValueError('controlled routing requires the exact four native sidecars')
        inputs[str(path)] = sha(path)
    env = dict(os.environ, IOT_LAB=str(root), ROUTE_BOARD=board, FASTROUTE_BIN=str(router),
               KICAD_CLI=str(kicad), KICAD_PYTHON=str(python), KICAD_PY=str(python),
               PYTHONPATH=str(root/'tools'), IOT_CPU_BUDGET=str(math.floor(context['cpus'])),
               IOT_RESOURCE_CPU=str(config['threads']),
               IOT_MEMORY_BUDGET_GIB=str(context['memory_bytes'] / 1073741824),
               IOT_JOB_MEMORY_GIB=str(context['memory_bytes'] / 1073741824))
    probes = []
    versions = {name: _probe([str(path), '--version'], env, probes)
                for name, path in (('python', python), ('router', router), ('kicad', kicad))}
    quality = env.get('FASTROUTE_QUALITY_MANIFEST')
    if quality:
        path = Path(quality).resolve()
        if not path.is_file():
            raise ValueError('selected quality backend manifest is unavailable')
        inputs[str(path)] = sha(path)
        env['FASTROUTE_QUALITY_MANIFEST'] = str(path)
    command = [str(python), str(script), str(native), str(output), '--preflight',
               '--skip-net', '', '--plane-nets', '', '--only-nets', ','.join(config['only_nets']),
               '--layers', ','.join(config['layers']), '--passes', str(config['passes']),
               '--threads', str(config['threads']), '--max-time', str(config['timeout_s']),
               '--optimizer', config['optimizer'], '--snapshot-interval-s', '0']
    output.parent.mkdir(parents=True, exist_ok=True)
    receipt = output.parent / 'execution-policy.json'
    original = output.parent / 'execution-context.json'
    if receipt.exists() or original.exists():
        raise ValueError('controlled execution receipts must be new')
    original.write_bytes(context['raw'])
    source_context_sha256 = hashlib.sha256(context['raw']).hexdigest()
    rules = features.get('routing_rules', {})
    policy = dict(schema=EXECUTION, command=command,
        runtime=dict(image_id=context['image_id'], tools={name:dict(version=versions[name], sha256=sha(path))
                     for name, path in (('python', python), ('router', router), ('kicad', kicad))}),
        resources=dict(cpus=context['cpus'], memory_bytes=context['memory_bytes'], threads=config['threads']),
        effort=dict(timeout_s=total_timeout_s, router_timeout_s=config['timeout_s'], passes=config['passes'],
                    max_repairs=0, optimizer=config['optimizer'],
                    max_repairs_scope='separate CLI repair operations only',
                    internal_repair_iterations=rules.get('repair_iterations', 2) if rules.get('on') else 0,
                    feature_policy=features),
        execution_context=dict(path='operation/'+original.name, sha256=source_context_sha256,
            container_id=context['container_id'], observed_cgroup=context['observed_cgroup'],
            attribution='host Docker inspect matched to running hostname and exposed cgroup limits'),
        gate_admission=dict(stage=gate['stage'], validator='gate-core.validateConfig'),
        inputs=inputs, environment={key:env.get(key) for key in
            ('ROUTE_BOARD','ROUTE_FEATURES','ROUTE_FEATURES_FILE','FASTROUTE_BIN','FASTROUTE_QUALITY_MANIFEST',
             'KICAD_CLI','KICAD_PYTHON','PYTHONPATH','IOT_CPU_BUDGET','IOT_RESOURCE_CPU',
             'IOT_MEMORY_BUDGET_GIB','IOT_JOB_MEMORY_GIB')},
        controls=dict(status='prepared', effective_configuration_verified=False), qualified=False)
    lean.atomic_json(output.parent/'runtime-probes.json', probes)
    lean.atomic_json(receipt, policy)
    return dict(command=command, env=env, policy=policy, policy_path=str(receipt),
                output=str(output), native=str(native), config=config,
                context_path=str(context['path']), context_sha256=source_context_sha256)


def finalize(prepared, *, returncode):
    """Cross-check actual controls; a routed result still requires the full gate."""
    output = Path(prepared['output'])
    policy = copy.deepcopy(prepared['policy'])
    for name, digest in policy['inputs'].items():
        if not Path(name).is_file() or sha(name) != digest:
            raise ValueError('controlled routing input/tool changed: ' + name)
    if sha(prepared['context_path']) != prepared['context_sha256']:
        raise ValueError('original host execution context changed during routing')
    copied_context = Path(prepared['policy_path']).with_name('execution-context.json')
    if not copied_context.is_file() or sha(copied_context) != prepared['context_sha256']:
        raise ValueError('retained original execution context differs from the host receipt')
    path = output / 'input-manifest.json'
    if not path.is_file():
        if returncode == 0:
            raise ValueError('successful router did not record its effective input configuration')
        policy['controls'].update(status='incomplete', effective_configuration_verified=False, tool_exit=returncode)
        lean.atomic_json(prepared['policy_path'], policy)
        return dict(status='failed', controls_verified=False, candidate=None,
                    cause='router did not record its effective input configuration')
    actual = json.loads(path.read_text())
    config = prepared['config']
    expected = dict(board=prepared['native'], outdir=prepared['output'], passes=config['passes'],
        layers=','.join(config['layers']), only_nets=','.join(config['only_nets']),
        threads=config['threads'], max_time=config['timeout_s'], optimizer=config['optimizer'],
        preflight=True, skip_net='', plane_nets='', gnd_vias=False, route_planes=False,
        unlock_nets='', set=[], neck_um=0)
    if any(actual.get('configuration', {}).get(key) != value for key, value in expected.items()):
        raise ValueError('router effective configuration differs from the controlled policy')
    if actual.get('board_sha256') != policy['inputs'][prepared['native']]:
        raise ValueError('router operated on another placement input')
    if actual.get('router_sha256') != policy['runtime']['tools']['router']['sha256']:
        raise ValueError('router binary differs from the recorded runtime')
    features = {key:value for key,value in actual.get('features', {}).items() if key != '_board_dir'}
    if features != policy['effort']['feature_policy']:
        raise ValueError('actual route features differ from the source-bound policy')
    configurations = sorted(output.glob('effective-configuration*.json'))
    blocked = []
    for coverage_path in sorted(output.glob('rule-coverage*.json')):
        coverage = json.loads(coverage_path.read_text())
        if coverage.get('status') == 'blocked' and coverage.get('solver_launch_allowed') is False:
            for name, digest in coverage.get('inputs', {}).items():
                if (sha(name) if Path(name).is_file() else None) != digest:
                    raise ValueError('rule coverage input changed after admission: ' + name)
            blocked.append(dict(path=str(coverage_path), sha256=sha(coverage_path), cause=coverage.get('cause')))
    if blocked:
        if returncode == 0:
            raise ValueError('solver success contradicts blocked rule coverage')
        policy['controls'].update(status='blocked', effective_configuration_verified=False, tool_exit=returncode,
            rule_coverage=blocked, solver_launched=bool(configurations))
        lean.atomic_json(prepared['policy_path'], policy)
        return dict(status='failed', controls_verified=False, candidate=None, qualified=False,
                    cause='router rule coverage blocked before solver: ' + '; '.join(str(x['cause']) for x in blocked),
                    rule_coverage=blocked, solver_launched=bool(configurations))
    if not configurations:
        if returncode == 0:
            raise ValueError('successful solver lacks actual backend worker-cap evidence')
        policy['controls'].update(status='incomplete', effective_configuration_verified=False, tool_exit=returncode)
        lean.atomic_json(prepared['policy_path'], policy)
        return dict(status='failed', controls_verified=False, candidate=None,
                    cause='no observed backend invocation/worker caps; inspect retained failure evidence')
    for path in configurations:
        value = json.loads(path.read_text())
        if any(value.get('configuration', {}).get(key) != item for key,item in expected.items()):
            raise ValueError('a router stage changed the controlled configuration')
        resources = value.get('backend_resources', {})
        if any(resources.get(key) != config['threads'] for key in
               ('global_rayon_threads', 'autorouter_workers', 'optimizer_workers')):
            raise ValueError('actual router worker caps differ from the controlled policy')
        binding = value.get('rule_coverage', {})
        coverage_path = Path(binding.get('path', ''))
        if (coverage_path.parent != output or not coverage_path.is_file()
                or sha(coverage_path) != binding.get('sha256')):
            raise ValueError('router stage lacks sealed rule-coverage admission')
        coverage = json.loads(coverage_path.read_text())
        if coverage.get('status') != 'passed' or coverage.get('solver_launch_allowed') is not True:
            raise ValueError('router stage ran without passing rule coverage')
        dsn = coverage.get('dsn', {})
        if not Path(dsn.get('path', '')).is_file() or sha(dsn['path']) != dsn.get('sha256') or dsn.get('sha256') != value.get('dsn_sha256'):
            raise ValueError('rule coverage differs from actual router model')
        command = value.get('command', [])
        if (not isinstance(command, list) or command.count('-de') != 1
                or command.index('-de') + 1 >= len(command) or command[command.index('-de') + 1] != dsn['path']):
            raise ValueError('router command does not use its admitted model')
        for name, digest in coverage.get('inputs', {}).items():
            if (sha(name) if Path(name).is_file() else None) != digest:
                raise ValueError('router rule-coverage input changed: ' + name)
    outcome_path = output/'outcome.json'
    outcome = json.loads(outcome_path.read_text()) if outcome_path.is_file() else None
    candidate = output/'routed.kicad_pcb'
    if returncode == 0 and (not isinstance(outcome, dict) or outcome.get('status') != 'complete'):
        raise ValueError('successful router lacks a complete candidate outcome')
    if outcome and outcome.get('status') in ('complete','stuck'):
        if not candidate.is_file() or outcome.get('board_sha256') != sha(candidate) or outcome.get('optimizer') != config['optimizer']:
            raise ValueError('router outcome is not bound to the actual candidate/optimizer')
    phase_path = output/'stages.jsonl'
    phases = [json.loads(line) for line in phase_path.read_text().splitlines() if line.strip()] if phase_path.is_file() else []
    repairs = [row for row in phases if any(word in str(row.get('stage','')).lower() for word in ('repair','thermal'))]
    policy['controls'].update(status='observed', effective_configuration_verified=True, tool_exit=returncode,
        effective_configurations={path.name:sha(path) for path in configurations},
        input_manifest_sha256=sha(output/'input-manifest.json'),
        outcome=outcome, native_repair_phases=repairs if phase_path.is_file() else None)
    lean.atomic_json(prepared['policy_path'], policy)
    status = 'passed' if returncode == 0 else 'failed'
    cause = ('actual effective controls match; full candidate gate remains required' if returncode == 0 else
             'router exited ' + str(returncode) + '; outcome=' + str((outcome or {}).get('status', 'unknown')))
    return dict(status=status, cause=cause,
                controls_verified=True,
                candidate=str(candidate) if outcome and outcome.get('status') in ('complete','stuck') else None,
                outcome=outcome, qualified=False, native_gate_required=True)
