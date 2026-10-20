"""Strict job policy: no implicit movement or expanded routing authority."""
from __future__ import annotations
from dataclasses import asdict, dataclass, field
import math
import sys
import json
from pathlib import Path
import re


SCHEMA = 'iot-lab.engine-policy.v1'


def validate_policy(raw, total_timeout_s):
    return JobPolicy.parse(raw, total_timeout_s).to_dict()


def dependencies(root, normalized_policy):
    """Current inference inputs only; historical training artifacts are lineage."""
    from .model import file_digest
    root = Path(root).resolve()
    ranking = normalized_policy.get('ranking')
    if not ranking:
        return []
    found = set()

    def bind(name):
        path = (root / name).resolve()
        if not path.is_relative_to(root) or not path.is_file():
            raise ValueError('engine model dependency is missing or outside checkout: ' + str(name))
        found.add(str(path.relative_to(root)))
        return path

    model = bind(ranking['model_path'])
    if file_digest(model) != ranking['model_sha256']:
        raise ValueError('engine model file SHA256 differs from policy')
    metadata = json.loads(model.read_text())
    for name in metadata.get('feature_contract', {}).get('implementation_sha256', {}):
        bind(name)
    if ranking.get('package_path'):
        package = (root / ranking['package_path']).resolve()
        if not package.is_relative_to(root) or not package.is_dir():
            raise ValueError('Core ML package missing or outside checkout')
        for path in package.rglob('*'):
            if path.is_file():
                bind(str(path.relative_to(root)))
        bind(str(package.with_suffix('.registry.json').relative_to(root)))
    return sorted(found)


@dataclass(frozen=True)
class MovementPolicy:
    refs: tuple[str, ...] = ()
    max_displacement_mm: float = 0.0
    step_mm: float = 0.5


@dataclass(frozen=True)
class JobPolicy:
    routing: dict
    max_attempts: int = 1
    movement: MovementPolicy = field(default_factory=MovementPolicy)
    compute: str = 'auto'
    runtime: str = field(default_factory=lambda: 'native' if sys.platform == 'darwin' else 'container')
    ranking: dict | None = None

    @classmethod
    def parse(cls, value, timeout_s):
        from pcb_routing_trial import validate
        if isinstance(value, cls):
            value = value.to_dict()
        if not isinstance(value, dict) or value.get('schema') != SCHEMA:
            raise ValueError('integrated routing requires engine-policy.v1')
        if set(value) - {'schema', 'routing', 'max_attempts', 'movement', 'compute', 'runtime', 'ranking'}:
            raise ValueError('unknown engine policy field')
        routing = validate(value.get('routing'), timeout_s)
        attempts = value.get('max_attempts', 1)
        if type(attempts) is not int or not 1 <= attempts <= 128:
            raise ValueError('max_attempts must be an integer between 1 and 128')
        movement = value.get('movement', {})
        if not isinstance(movement, dict) or set(movement) - {'refs', 'max_displacement_mm', 'step_mm'}:
            raise ValueError('unknown movement policy field')
        refs = movement.get('refs', [])
        if (not isinstance(refs, list) or any(not isinstance(ref, str) or not ref for ref in refs)
                or len(set(refs)) != len(refs)):
            raise ValueError('movement.refs must be distinct explicit references')
        radius, step = movement.get('max_displacement_mm', 0), movement.get('step_mm', .5)
        if any(type(v) not in (int, float) or not math.isfinite(v) for v in (radius, step)):
            raise ValueError('movement distances must be finite numbers')
        if radius < 0 or step <= 0 or (refs and (radius <= 0 or step > radius)) or (not refs and radius):
            raise ValueError('movement requires explicit refs, positive radius, and a bounded positive step')
        compute = value.get('compute', 'auto')
        if compute not in ('auto', 'cpu', 'metal'):
            raise ValueError('compute must be auto, cpu, or metal')
        runtime = value.get('runtime', 'native' if sys.platform == 'darwin' else 'container')
        if runtime not in ('native', 'container'):
            raise ValueError('runtime must be native or container')
        ranking = value.get('ranking')
        if ranking is not None:
            if (not isinstance(ranking, dict) or set(ranking) -
                    {'model_path', 'model_sha256', 'package_path', 'compute_units', 'allow_experimental'}):
                raise ValueError('unknown engine ranking field')
            for key in ('model_path', 'package_path'):
                name = ranking.get(key)
                if key == 'package_path' and name is None:
                    continue
                if not isinstance(name, str) or not name or Path(name).is_absolute() or '..' in Path(name).parts:
                    raise ValueError('ranking paths must be repository-relative')
            if not re.fullmatch('[0-9a-f]{64}', ranking.get('model_sha256', '')):
                raise ValueError('ranking requires a model file SHA256')
            if type(ranking.get('allow_experimental', False)) is not bool:
                raise ValueError('allow_experimental must be boolean')
            units = ranking.get('compute_units', 'cpuAndNeuralEngine')
            if units not in ('cpuOnly', 'cpuAndGPU', 'cpuAndNeuralEngine', 'all'):
                raise ValueError('unsupported Core ML compute unit policy')
            ranking = dict(ranking, compute_units=units, allow_experimental=ranking.get('allow_experimental', False))
        return cls(routing, attempts, MovementPolicy(tuple(refs), float(radius), float(step)), compute, runtime, ranking)

    def to_dict(self):
        result = asdict(self)
        result['schema'] = SCHEMA
        result['movement']['refs'] = list(self.movement.refs)
        return result
