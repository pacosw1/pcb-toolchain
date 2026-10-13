"""Apply sourced regional widths to new native proposal segments only.

This bounded geometry stage shares the ENV production policy. It keeps the
backend's centerlines, original copper, vias, placement and rules unchanged.
It does not make a failed/partial backend output complete, repair connectivity,
or replace current-path/native/thermal checks. Solvers still need construction
support for regional widths; proposal normalization cannot recover a missing path.
"""
import argparse
import json
from pathlib import Path
import re
import shutil

from env_routing_rules import applies, thermal_region, SOURCE
from placer.dru import _tree, _tokens
from .contracts import fingerprint, number, xy
from .native_candidate import copper_items
from .native_srj import digest, geometry_digest, source_set

ROOT = Path(__file__).resolve().parents[2]
SOURCE_FILES = (SOURCE, 'tools/env_routing_rules.py', 'tools/build-env-pcb.py',
                'hardware-design/boards/ENV-SENSE/current-paths.json',
                'hardware-design/boards/ENV-SENSE/SPEC.md')


def policy(source):
    """Compile the explicitly selected ENV policy against an exact native input."""
    import pcbnew as pcb
    source = Path(source).resolve()
    expected = {SOURCE: 'Gate rule: no track wider than 0.2 mm there.',
                'hardware-design/boards/ENV-SENSE/SPEC.md':
                    'pour on any layer on the island, in the neck or 2 mm below it, traces 0.15 mm'}
    for name, excerpt in expected.items():
        if excerpt not in ' '.join((ROOT/name).read_text().split()):
            raise ValueError('regional width source changed: '+name)
    inputs = source_set(source)
    project = json.loads(source.with_suffix('.kicad_pro').read_text())
    if project.get('meta', {}).get('filename') != 'ENV-SENSE.kicad_pro':
        raise ValueError('ENV policy requires its owned project identity')
    b = pcb.LoadBoard(str(source))
    region = thermal_region(b, pcb)
    minimum = number(project['board']['design_settings']['rules']['min_track_width'], 'native minimum', True)
    if minimum > region['preferred_width_mm']:
        raise ValueError('regional target conflicts with native track minimum')
    if inputs != source_set(source):
        raise ValueError('native input changed during policy compilation')
    return dict(schema='iot-lab.regional-widths.v1', board='ENV-SENSE', inputs=inputs,
                sources={name: digest(ROOT/name) for name in SOURCE_FILES}, regions=[region],
                min_width_mm=minimum, qualified=False,
                scope='shared segment-midpoint width policy; all other board checks remain required')


def verify_policy(spec, source):
    # Recompile from native geometry and the current sourced implementation.
    # Matching source hashes alone cannot authorize caller-edited rule values.
    if spec != policy(source):
        raise ValueError('regional policy geometry, widths, inputs or sources changed')


def normalize(source, backend, spec, out, *, completed):
    source, backend, out = Path(source).resolve(), Path(backend).resolve(), Path(out).resolve()
    verify_policy(spec, source)
    original_inputs = source_set(source); backend_sha = digest(backend)
    _, original = copper_items(source); text, items = copper_items(backend)
    added = set(items)-set(original)
    if set(original)-set(items) or geometry_digest(source) != geometry_digest(backend, added):
        raise ValueError('backend changed protected native content')
    replacements=[];changes=[]
    for uid in sorted(added):
        item=items[uid];a,b=item['span']
        if item['kind']=='via': continue
        if item['kind']!='segment':
            raise ValueError('regional width semantics for new arcs are not represented')
        form=_tree(_tokens(text[a:b]))[0]
        fields={v[0]:v[1:] for v in form[1:] if isinstance(v,list)}
        start,end=xy(list(map(float,fields['start']))),xy(list(map(float,fields['end'])))
        layer=fields['layer'][0];width=number(float(fields['width'][0]),'segment width',True)
        if width < spec['min_width_mm']:
            raise ValueError('backend segment violates native minimum')
        matches=[r for r in spec['regions'] if applies(r,start,end,layer)]
        if not matches:continue
        targets={r['preferred_width_mm'] for r in matches}
        if len(targets)!=1:
            raise ValueError('overlapping regional targets conflict')
        target=min(width,targets.pop())
        if width==target:continue
        revised,count=re.subn(r'\(width\s+[^()\s]+\)',f'(width {target:.9f})',text[a:b])
        if count!=1:raise ValueError('ambiguous native segment width')
        # Prove this operation changed only width on one new segment.
        revised_form=_tree(_tokens(revised))[0]
        strip=lambda f:[v for v in f if not(isinstance(v,list) and v[0]=='width')]
        if strip(form)!=strip(revised_form):raise ValueError('regional normalization changed geometry')
        replacements.append((a,b,revised))
        changes.append(dict(uuid=uid,net=item['net'],before_mm=width,after_mm=target,regions=[r['id'] for r in matches]))
    for a,b,revised in sorted(replacements,reverse=True):text=text[:a]+revised+text[b:]
    out.mkdir(parents=True,exist_ok=False);target=out/'proposal.kicad_pcb';target.write_text(text)
    for ext in ('.kicad_pro','.kicad_dru','.kicad_sch'):shutil.copy2(source.with_suffix(ext),target.with_suffix(ext))
    if (geometry_digest(target,added)!=geometry_digest(source) or source_set(source)!=original_inputs
            or digest(backend)!=backend_sha):raise ValueError('protected content or source changed')
    record=dict(schema='iot-lab.regional-proposal.v1',status='candidate' if completed else 'partial',qualified=False,
        changes=changes,added_items=sorted(added),policy_sha256=fingerprint(spec),
        source_files=original_inputs,backend_sha256=backend_sha,output_files=source_set(target),
        protected_geometry_sha256=geometry_digest(source),native_and_board_specific_gates_required=True,
        note='Width normalization preserves centerlines; it does not establish completeness or current capacity')
    (out/'record.json').write_text(json.dumps(record,indent=2))
    return record


def main():
    ap=argparse.ArgumentParser(description=__doc__);sub=ap.add_subparsers(dest='mode',required=True)
    p=sub.add_parser('export-env');p.add_argument('source');p.add_argument('output')
    n=sub.add_parser('normalize');n.add_argument('source');n.add_argument('backend');n.add_argument('policy');n.add_argument('output')
    # Explicit caller status; a partial remains partial regardless of geometry.
    n.add_argument('--completed',action='store_true')
    a=ap.parse_args()
    try:
        if a.mode=='export-env':
            result=policy(a.source)
            with Path(a.output).open('x') as f:json.dump(result,f,indent=2)
            print('PASS: sourced regional policy exported; complete board gates still required');return 0
        result=normalize(a.source,a.backend,json.loads(Path(a.policy).read_text()),a.output,completed=a.completed)
        print(('PASS' if a.completed else 'STUCK')+f': {len(result["changes"])} regional widths normalized; {result["status"]}; native gates required')
        return 0 if a.completed else 3
    except (ValueError,OSError,KeyError,TypeError,ImportError) as error:
        print('STUCK: '+str(error));return 3


if __name__=='__main__':raise SystemExit(main())
