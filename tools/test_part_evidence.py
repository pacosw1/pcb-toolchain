"""Native part-use and PDF cache contracts; all approved fixtures are synthetic."""
import contextlib
import copy
import importlib.util
import io
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

import native_workflow_smoke as smoke
import part_evidence as evidence
import part_native as native
import pq_cadlib as cad

REPO = Path(__file__).resolve().parent.parent


def synthetic_pdf(path, include_escape=False):
    """Real one-page PDF containing clearly labeled synthetic test limits."""
    content = (b'BT /F1 12 Tf 40 700 Td (SYNTHETIC TEST FIXTURE - NOT A MANUFACTURER DATASHEET) Tj '
               b'0 -20 Td (TP: 0 to 5 V; net current budget: 0.1 A.) Tj '
               b'0 -20 Td (Applicable ambient temperature: -40 to 85 degC.) Tj '
               b'0 -20 Td (J1.1 to J2.1 pad-center distance: maximum 11 mm.) Tj ET')
    if include_escape:
        content = content[:-2] + (
            b'0 -20 Td (J1.1 and J2.1 require a native-minimum-width escape screen.) Tj '
            b'0 -20 Td (Fixture policy: 0.2 mm minimum track; 0.2 mm default clearance.) Tj '
            b'0 -20 Td (Screen: F.Cu/B.Cu, 0.05 mm grid, 2 mm local reach.) Tj '
            b'0 -20 Td (Escape: beyond pad box plus 0.3 mm, or a legal via site.) Tj '
            b'0 -20 Td (A bounded model only; fresh native validation remains required.) Tj ET')
    objects = [b'<< /Type /Catalog /Pages 2 0 R >>', b'<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
        b'<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
        b'<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
        b'<< /Length ' + str(len(content)).encode() + b' >>\nstream\n' + content + b'\nendstream']
    data, offsets = b'%PDF-1.4\n', [0]
    for index, obj in enumerate(objects, 1):
        offsets.append(len(data)); data += str(index).encode() + b' 0 obj\n' + obj + b'\nendobj\n'
    start = len(data)
    data += b'xref\n0 6\n0000000000 65535 f \n' + b''.join(('%010d 00000 n \n' % offset).encode() for offset in offsets[1:])
    data += b'trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n' + str(start).encode() + b'\n%%EOF\n'
    path.parent.mkdir(parents=True, exist_ok=True); path.write_bytes(data)


def make_fixture(root, native_generator=None, include_escape=False):
    """Shared fixture for actual pcbnew/placement integration on the native image.

    Pass native_workflow_smoke.generate as native_generator on a KiCad runtime;
    ordinary CPU tests use equivalent small native text without pcbnew.
    """
    root = Path(root)
    folder = root / 'hardware-design/boards/PART-FIXTURE'
    folder.mkdir(parents=True)
    (folder / 'gate.json').write_text('{"project":"fixture","checks":{"erc":true,"drc":true}}\n')
    if native_generator:
        generated = folder / 'generated'
        native_generator(generated)
        for path in generated.iterdir():
            shutil.move(str(path), folder / path.name)
        generated.rmdir()
    else:
        (folder / 'fixture.kicad_sch').write_text(smoke.schematic())
        forms = ['(kicad_pcb (version 20250114) (generator "pcbnew") (general (thickness 1.6))',
                 '(layers (0 "F.Cu" signal) (31 "B.Cu" signal)) (net 1 "/A") (net 2 "/B")']
        for index in range(4):
            ref, net = 'J' + str(index + 1), '/A' if index < 2 else '/B'
            x, y = 5 + index % 2 * 10, 5 + index // 2 * 10
            forms.append(f'''(footprint "Smoke:TP" (layer "F.Cu") (at {x} {y} 0)
              (property "Reference" "{ref}") (property "Value" "TP") (path "/{smoke.uid(ref)}")
              (pad "1" smd rect (at 0 0) (size 0.8 0.8) (layers "F.Cu" "F.Paste" "F.Mask")
                (net {1 if net=='/A' else 2} "{net}")))''')
        forms.append(')'); (folder / 'fixture.kicad_pcb').write_text('\n'.join(forms))
    for suffix in ('kicad_sch', 'kicad_pcb'):
        path = folder / ('fixture.' + suffix)
        tree = cad.parse(path.read_text())
        kind = 'symbol' if suffix == 'kicad_sch' else 'footprint'
        for placed in cad.items(tree, kind):
            props = {row[1]: row[2] for row in cad.items(placed, 'property')}
            if 'Reference' not in props:
                continue
            ref = props['Reference']
            for name, value in (('MPN', 'SYNTHETIC-TP'), ('LCSC', 'C90000' + ref[1:])):
                placed.append([cad.Atom('property'), name, value,
                    [cad.Atom('at'), cad.Atom('0'), cad.Atom('0'), cad.Atom('0')],
                    [cad.Atom('effects'), [cad.Atom('font'), [cad.Atom('size'), cad.Atom('1'), cad.Atom('1')]],
                     [cad.Atom('hide'), cad.Atom('yes')]]])
        path.write_text(cad.dump(tree) + '\n')
    if native_generator:
        import pcbnew
        path = folder / 'fixture.kicad_pcb'
        canonical = pcbnew.LoadBoard(str(path))
        pcbnew.SaveBoard(str(path), canonical)
    (folder / 'SPEC.md').write_text('Synthetic fixture only. Required 3.0 to 3.6 V, 20 to 30 degC, 0.02 A per TP.\n'
        + ('J1.1 and J2.1 require the sourced bounded native-minimum-width escape screen before routing.\n' if include_escape else ''))
    review_dir = root / 'hardware-design/registry/part-reviews'
    review_dir.mkdir(parents=True)
    review_doc = review_dir / 'SYNTHETIC-REVIEW.md'
    review_doc.write_text('Synthetic test review only. No manufacturer or production qualification. All TP pin/pad maps and fixture conditions checked.\n')
    pdf = root / 'hardware-design/registry/datasheets/SYNTHETIC-TP.pdf'
    synthetic_pdf(pdf,include_escape=include_escape)
    def source(path, **extra):
        return dict(path=path.relative_to(root).as_posix(), sha256=evidence.sha(path), **extra)
    pdf_source = source(pdf, page=1)
    spec_source = source(folder / 'SPEC.md', section='Synthetic fixture conditions')
    def value(lo, hi, unit, source_value):
        return dict(min=lo, max=hi, unit=unit, source=copy.deepcopy(source_value))
    snapshot = native.read_board(root, 'PART-FIXTURE')
    parts = []
    for ref, actual in snapshot['parts'].items():
        parts.append(dict(reference=ref, mpn=actual['mpn'], lcsc=actual['lcsc'], manufacturer='Synthetic fixture',
            package=dict(name='Synthetic one-pad TP', variant='SYNTHETIC-TP'),
            datasheets=[dict(pdf_source, document_id='SYNTHETIC TEST FIXTURE', revision='1')],
            native={**{key: actual[key] for key in ('symbol_sha256', 'pin_map', 'footprint', 'footprint_sha256', 'land_geometry_sha256', 'pad_net_map')},
                    'non_electrical_pads': []},
            ratings=[dict(id='supply', quantity='voltage', limit=value(0, 5, 'V', pdf_source),
                required=value(3.0, 3.6, 'V', spec_source), conditions=[dict(quantity='ambient_temperature',
                    valid=value(-40, 85, 'degC', pdf_source), required=value(20, 30, 'degC', spec_source))])],
            layout_constraints=[], assembly_dependencies=[], unresolved=[]))
    parts[0]['layout_constraints'] = [dict(id='fixture-distance', kind='pin_distance', source=pdf_source,
        a=dict(ref='J1', pad='1'), b=dict(ref='J2', pad='1'), metric='pad_center_euclidean', max_mm=11)]
    if include_escape:
        parts[0]['layout_constraints'].append(dict(id='fixture-critical-escape',kind='escape',source=pdf_source,
            refs=['J1','J2'],pads=[dict(ref=ref,pad='1') for ref in ('J1','J2')],metric='native_minimum_track_escape'))
    manifest = dict(schema=evidence.MANIFEST, board='PART-FIXTURE', revision='synthetic-1',
        project=snapshot['project'], spec=spec_source, parts=parts, budgets=[dict(id='rail', net='/A',
        limit=value(0, 0.1, 'A', pdf_source), loads=[dict(reference=ref, required=value(0, .02, 'A', spec_source)) for ref in ('J1','J2')], exclusions=[])])
    manifest['review'] = dict(verdict='passed', reviewer='synthetic-test-fixture', reviewed_at_utc='2026-10-16T00:00:00Z',
        facts_sha256=evidence.facts_digest(manifest), evidence=source(review_doc, section='Synthetic test review'))
    path = review_dir / 'PART-FIXTURE.json'
    path.write_text(json.dumps(manifest, indent=2) + '\n')
    return path


def real_copy_proof(repo, output):
    """Observe real ENV assets and reject mutations in an isolated copy.

    The review deliberately remains pending: this proves stale/mismatch handling,
    never electrical selection or the completeness of the existing board packet.
    Sourced voltage numbers are DS13012 Rev7 page13 and ENV SPEC section2.
    """
    repo, output = Path(repo).resolve(), Path(output).resolve()
    output.mkdir(parents=True, exist_ok=False)
    root = output / 'source'
    snapshot = native.read_board(repo, 'ENV-SENSE')
    names = set(snapshot['native_inputs']) | {'hardware-design/boards/ENV-SENSE/SPEC.md',
        'hardware-design/registry/boards.json', 'hardware-design/registry/datasheets/ISM330DHCXTR_C2655101.pdf',
        'hardware-design/registry/datasheets/ISM330DHCXTR_C2655101.pdf.source.json'}
    originals = {name: evidence.sha(repo/name) for name in names}
    for name in names:
        target = root/name; target.parent.mkdir(parents=True,exist_ok=True); shutil.copyfile(repo/name,target)
    def source(name, **extra):
        return dict(path=name, sha256=evidence.sha(root/name), **extra)
    spec = source('hardware-design/boards/ENV-SENSE/SPEC.md',section='2. Interface: 3.3 V supply')
    pdf = source('hardware-design/registry/datasheets/ISM330DHCXTR_C2655101.pdf',page=13)
    actual = snapshot['parts']['U1']
    review = root/'hardware-design/registry/part-reviews/PENDING-OBSERVATION.md'; review.parent.mkdir(parents=True)
    review.write_text('PENDING engineering review. Native asset observation and negative mutation test only. '
                      'No production review, selection, current stock or qualification is established.\n')
    part = dict(reference='U1',mpn=actual['mpn'],lcsc=actual['lcsc'],manufacturer='STMicroelectronics',
        package=dict(name='LGA-14L',variant='2.5 x 3.0 x 0.83 mm typical (document page1)'),
        datasheets=[dict(pdf,document_id='DS13012',revision='7, November 2020')],
        native={**{k:actual[k] for k in ('symbol_sha256','pin_map','footprint','footprint_sha256','land_geometry_sha256','pad_net_map')},'non_electrical_pads':[]},
        ratings=[dict(id='vdd',quantity='voltage',limit=dict(min=1.71,max=3.6,unit='V',source=pdf),
                      required=dict(min=3.3,max=3.3,unit='V',source=spec),conditions=[])],
        layout_constraints=[],assembly_dependencies=[],unresolved=['Full conditions, layout, complete assembly and all other native parts remain unreviewed.'])
    manifest=dict(schema=evidence.MANIFEST,board='ENV-SENSE',revision='A',project=snapshot['project'],spec=spec,parts=[part],budgets=[])
    manifest['review']=dict(verdict='pending',reviewer='pending-native-observation',reviewed_at_utc='2026-10-16T00:00:00Z',
                           facts_sha256=evidence.facts_digest(manifest),evidence=source(review.relative_to(root).as_posix(),section='PENDING observation'))
    path=review.with_name('ENV-SENSE.json'); path.write_text(json.dumps(manifest,indent=2)+'\n')
    reports={}
    def verify(label, required):
        report=evidence.verify_manifest(root,'ENV-SENSE',path)
        codes={b['code'] for b in report['blockers']}
        if report['status']=='passed' or not set(required)<=codes:
            raise AssertionError(dict(label=label,required=required,blockers=report['blockers']))
        evidence.atomic_json(output/(label+'.json'),report); reports[label]=dict(status=report['status'],codes=sorted(codes))
    verify('pending-observation',['review_pending','unreviewed_native_parts'])
    sch=root/(snapshot['project']+'.kicad_sch'); original=sch.read_bytes(); tree=cad.parse(sch.read_text())
    lib_id=next(cad.item(s,'lib_id')[1] for s in cad.items(tree,'symbol') if any(p[1:3]==['Reference','U1'] for p in cad.items(s,'property')))
    library=next(s for s in cad.items(cad.item(tree,'lib_symbols'),'symbol') if s[1]==lib_id)
    cad.item(next(cad.walk(library,'pin')),'name')[1]='DELIBERATE-WRONG-PIN'
    sch.write_text(cad.dump(tree)); verify('pin-mutation',['pin_map_mismatch']); sch.write_bytes(original)
    pcb=root/(snapshot['project']+'.kicad_pcb'); original=pcb.read_bytes(); tree=cad.parse(pcb.read_text())
    footprint=next(fp for fp in cad.items(tree,'footprint') if any(p[1:3]==['Reference','U1'] for p in cad.items(fp,'property')))
    cad.item(cad.items(footprint,'pad')[0],'size')[1]=cad.Atom('0.01')
    pcb.write_text(cad.dump(tree)); verify('land-mutation',['land_geometry_mismatch']); pcb.write_bytes(original)
    manifest['parts'][0]['ratings'][0]['required']['max']=4.0  # Deliberately invalid test demand, never a reviewed board requirement.
    manifest['review']['facts_sha256']=evidence.facts_digest(manifest); path.write_text(json.dumps(manifest))
    verify('rating-mutation',['rating_exceeded'])
    unchanged=all(evidence.sha(repo/name)==value for name,value in originals.items())
    if not unchanged: raise AssertionError('shipping input changed during copy-only proof')
    result=dict(status='passed',scope='real_board_copy_negative_part_evidence',qualified=False,
                shipping_inputs=originals,shipping_unchanged=True,physical_parts=len(snapshot['parts']),
                fitted_parts=sum(p['required'] for p in snapshot['parts'].values()),observed_reference='U1',
                reports=reports,limits=['The real review remains pending. No production selection, stock, native ERC/DRC or qualification verdict is established.'])
    evidence.atomic_json(output/'summary.json',result)
    return result


class PartContractTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(); self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.manifest = make_fixture(self.root)
        patch = mock.patch.object(evidence, 'pdf_pages', return_value=1)
        patch.start(); self.addCleanup(patch.stop)

    def verify(self):
        return evidence.verify_manifest(self.root, 'PART-FIXTURE', self.manifest)

    def change(self, change, reviewed=False):
        value = json.loads(self.manifest.read_text()); change(value)
        if reviewed:
            value['review']['facts_sha256'] = evidence.facts_digest(value)
        self.manifest.write_text(json.dumps(value)); return value

    def codes(self, result):
        return {value['code'] for value in result['blockers']}

    def test_exact_synthetic_part_contract_passes_without_stock_or_qualification(self):
        result = self.verify()
        self.assertEqual(result['status'], 'passed', result['blockers'])
        self.assertEqual(len(result['checked_ratings']), 4)
        self.assertEqual(result['checked_budgets'][0]['total'], .04)
        self.assertFalse(result['qualified']); self.assertFalse(result['stock_current'])

    def test_changed_pin_name_blocks_even_with_same_number(self):
        path = self.root / 'hardware-design/boards/PART-FIXTURE/fixture.kicad_sch'
        tree = cad.parse(path.read_text())
        library = cad.item(tree, 'lib_symbols')
        pin = next(cad.walk(library, 'pin')); cad.item(pin, 'name')[1] = 'WRONG'
        path.write_text(cad.dump(tree))
        self.assertIn('pin_map_mismatch', self.codes(self.verify()))

    def test_matching_review_hashes_cannot_approve_unspecified_actual_pin_types(self):
        path=self.root/'hardware-design/boards/PART-FIXTURE/fixture.kicad_sch'
        tree=cad.parse(path.read_text());pin=next(cad.walk(cad.item(tree,'lib_symbols'),'pin'))
        pin[1]=cad.Atom('unspecified');path.write_text(cad.dump(tree))
        actual=native.read_board(self.root,'PART-FIXTURE')
        value=json.loads(self.manifest.read_text())
        for part in value['parts']:
            ref=part['reference']
            for field in ('symbol_sha256','pin_map'):
                part['native'][field]=copy.deepcopy(actual['parts'][ref][field])
        value['review']['facts_sha256']=evidence.facts_digest(value);self.manifest.write_text(json.dumps(value))
        checked=self.verify();self.assertEqual(checked['status'],'blocked')
        self.assertEqual(self.codes(checked),{'unspecified_pin_type'})
        self.assertEqual({row['reference'] for row in checked['blockers']},{part['reference'] for part in value['parts']})
        planned=evidence.verify_selection(self.root,'PART-FIXTURE',self.manifest)
        self.assertEqual(planned['status'],'passed',planned['blockers'])
        self.assertFalse(planned['native_verified']);self.assertEqual(planned['bindings'],{})

    def test_changed_installed_land_geometry_blocks(self):
        path = self.root / 'hardware-design/boards/PART-FIXTURE/fixture.kicad_pcb'
        tree = cad.parse(path.read_text()); pad = next(cad.walk(tree, 'pad')); cad.item(pad, 'size')[1] = '0.1'
        path.write_text(cad.dump(tree))
        self.assertIn('land_geometry_mismatch', self.codes(self.verify()))

    def test_native_mpn_mismatch_blocks(self):
        path = self.root / 'hardware-design/boards/PART-FIXTURE/fixture.kicad_pcb'
        path.write_text(path.read_text().replace('SYNTHETIC-TP', 'WRONG-MPN', 1))
        self.assertIn('native_identity_mismatch', self.codes(self.verify()))

    def test_partial_planned_native_declaration_cannot_certify_installed_assets(self):
        self.change(lambda v:v['parts'][0].update(native={}),True)
        result=self.verify()
        self.assertNotEqual(result['status'],'passed')
        self.assertIn('native_asset_mismatch',self.codes(result));self.assertIn('pin_pad_coverage',self.codes(result))

    def test_unmatched_fitted_footprint_and_bom_mismatch_are_blocked(self):
        path = self.root / 'hardware-design/boards/PART-FIXTURE/fixture.kicad_pcb'
        tree = cad.parse(path.read_text()); footprint = cad.items(tree, 'footprint')[0]
        extra = copy.deepcopy(footprint); next(p for p in cad.items(extra,'property') if p[1]=='Reference')[2]='J99'
        tree.append(extra); path.write_text(cad.dump(tree))
        self.assertIn('native_unmatched_footprint', self.codes(self.verify()))
        tree.remove(extra); footprint.append([cad.Atom('attr'),cad.Atom('exclude_from_bom')]); path.write_text(cad.dump(tree))
        self.assertIn('native_identity_mismatch', self.codes(self.verify()))

    def test_rating_and_applicability_conditions_are_enforced(self):
        self.change(lambda v: v['parts'][0]['ratings'][0]['required'].update(max=6), True)
        self.assertIn('rating_exceeded', self.codes(self.verify()))
        self.change(lambda v: v['parts'][0]['ratings'][0]['conditions'][0]['required'].update(max=100), True)
        self.assertIn('rating_conditions', self.codes(self.verify()))

    def test_limit_edit_without_fresh_review_is_stale(self):
        self.change(lambda v: v['parts'][0]['ratings'][0]['limit'].update(max=500))
        self.assertIn('stale_review', self.codes(self.verify()))

    def test_unknown_units_and_missing_conditions_do_not_pass(self):
        self.change(lambda v: v['parts'][0]['ratings'][0]['required'].update(unit='mV'), True)
        self.assertIn('rating_exceeded', self.codes(self.verify()))
        self.change(lambda v: v['parts'][0]['ratings'][0].pop('conditions'), True)
        self.assertIn('invalid_part_evidence', self.codes(self.verify()))

    def test_changed_pdf_review_and_spec_are_stale(self):
        path = self.root / 'hardware-design/registry/datasheets/SYNTHETIC-TP.pdf'
        path.write_bytes(path.read_bytes() + b'\nchanged original\n')
        self.assertIn('stale_source', self.codes(self.verify()))

    def test_out_of_range_page_is_blocked(self):
        self.change(lambda v: v['parts'][0]['datasheets'][0].update(page=2), True)
        self.assertIn('invalid_part_evidence', self.codes(self.verify()))

    def test_uncovered_native_parts_and_unresolved_items_block(self):
        self.change(lambda v: v['parts'].pop(), True)
        self.assertIn('unreviewed_native_parts', self.codes(self.verify()))
        self.change(lambda v: v['parts'][0]['unresolved'].append('not reviewed'), True)
        self.assertIn('unresolved_part_use', self.codes(self.verify()))

    def test_budget_checks_complete_actual_net_and_worst_case_sum(self):
        self.change(lambda v: v['budgets'][0]['loads'][0]['required'].update(max=.2), True)
        self.assertIn('budget_exceeded', self.codes(self.verify()))
        self.change(lambda v: v['budgets'][0]['loads'].pop(), True)
        self.assertIn('budget_exceeded', self.codes(self.verify()))

    def test_dependency_closure_includes_native_pdf_spec_and_review(self):
        files = evidence.dependency_files(self.root, self.manifest)
        self.assertIn('hardware-design/registry/datasheets/SYNTHETIC-TP.pdf', files)
        self.assertIn('hardware-design/registry/part-reviews/SYNTHETIC-REVIEW.md', files)
        self.assertIn('hardware-design/boards/PART-FIXTURE/fixture.kicad_pcb', files)

    def test_pose_changes_do_not_invalidate_part_assets(self):
        path = self.root / 'hardware-design/boards/PART-FIXTURE/fixture.kicad_pcb'
        tree = cad.parse(path.read_text()); fp = cad.items(tree, 'footprint')[0]
        cad.item(fp, 'at')[1:3] = ['6', '5']; path.write_text(cad.dump(tree))
        self.assertEqual(self.verify()['status'], 'passed')

    def test_manifest_never_promotes_pending_or_missing_evidence(self):
        self.change(lambda v: v['review'].update(verdict='pending'))
        self.assertIn('review_pending', self.codes(self.verify()))
        self.manifest.unlink()
        self.assertEqual(evidence.status_board(self.root, 'PART-FIXTURE')['status'], 'blocked')

    def shared_profile(self):
        value = json.loads(self.manifest.read_text())
        part = value['parts'][0]
        profile = copy.deepcopy({k: v for k, v in part.items() if k != 'reference'})
        profile['schema'] = evidence.PROFILE
        profile['native'].pop('pad_net_map')
        use = dict(pad_net_map=part['native']['pad_net_map'], required={}, conditions={}, refs={'PEER': 'J2'})
        for rating in profile['ratings']:
            use['required'][rating['id']] = rating.pop('required')
            use['conditions'][rating['id']] = {c['quantity']: c.pop('required') for c in rating['conditions']}
        profile['layout_constraints'][0]['a']['ref'] = '$SELF'
        profile['layout_constraints'][0]['b']['ref'] = '$PEER'
        profile['review'] = copy.deepcopy(value['review'])
        profile['review']['facts_sha256'] = evidence.facts_digest(profile)
        target = self.manifest.parent / 'SYNTHETIC-TP-C900001.json'
        target.write_text(json.dumps(profile))
        value['parts'][0] = dict(reference='J1', profile=dict(path=target.relative_to(self.root).as_posix(), sha256=evidence.sha(target)), use=use)
        value['review']['facts_sha256'] = evidence.facts_digest(value)
        self.manifest.write_text(json.dumps(value))
        return target

    def test_shared_static_profile_reuses_across_boards_with_board_owned_demands(self):
        profile = self.shared_profile()
        first = self.verify()
        self.assertEqual(first['status'], 'passed', first['blockers'])
        self.assertEqual(first['constraints']['rules'][0]['b']['ref'], 'J2')
        old = 'hardware-design/boards/PART-FIXTURE/'
        new = 'hardware-design/boards/SECOND-FIXTURE/'
        shutil.copytree(self.root / old, self.root / new)
        value = json.loads(self.manifest.read_text().replace(old, new))
        value['board'] = 'SECOND-FIXTURE'
        value['review']['facts_sha256'] = evidence.facts_digest(value)
        second_path = self.manifest.with_name('SECOND-FIXTURE.json'); second_path.write_text(json.dumps(value))
        second = evidence.verify_manifest(self.root, 'SECOND-FIXTURE', second_path)
        self.assertEqual(second['status'], 'passed', second['blockers'])
        self.assertEqual(second['profiles'], first['profiles'])
        self.assertIn(profile.relative_to(self.root).as_posix(), evidence.dependency_files(self.root, second_path))

    def test_shared_profile_changes_and_incomplete_use_fail_closed(self):
        profile = self.shared_profile()
        value = json.loads(profile.read_text()); value['ratings'][0]['limit']['max'] = 100
        profile.write_text(json.dumps(value))
        self.assertIn('stale_source', self.codes(self.verify()))
        self.change(lambda v: v['parts'][0]['profile'].update(sha256=evidence.sha(profile)), True)
        self.assertIn('stale_profile_review', self.codes(self.verify()))
        value['review']['facts_sha256'] = evidence.facts_digest(value); profile.write_text(json.dumps(value))
        self.change(lambda v: v['parts'][0]['profile'].update(sha256=evidence.sha(profile)), True)
        self.change(lambda v: v['parts'][0]['use']['conditions'].clear(), True)
        self.assertIn('invalid_part_evidence', self.codes(self.verify()))

    def test_same_profile_can_supply_two_instances_without_rule_id_collision(self):
        self.shared_profile()
        for suffix in ('kicad_sch','kicad_pcb'):
            path=self.root/('hardware-design/boards/PART-FIXTURE/fixture.'+suffix)
            path.write_text(path.read_text().replace('C900002','C900001'))
        def change(value):
            value['parts'][1]=copy.deepcopy(value['parts'][0]); value['parts'][1]['reference']='J2'
            value['parts'][1]['use']['refs']['PEER']='J1'
        self.change(change,True)
        result=self.verify()
        self.assertEqual(result['status'],'passed',result['blockers'])
        self.assertEqual({r['id'] for r in result['constraints']['rules']},{'J1:fixture-distance','J2:fixture-distance'})
        self.assertEqual({v['source_rule_id'] for v in result['constraint_origins'].values()},{'fixture-distance'})

    def test_board_use_cannot_override_profile_limits_or_borrow_another_spec(self):
        self.shared_profile()
        self.change(lambda v: v['parts'][0]['use'].update(limit=500), True)
        self.assertIn('invalid_part_evidence', self.codes(self.verify()))
        self.change(lambda v: v['parts'][0]['use'].pop('limit'), True)
        other = self.root / 'hardware-design/boards/OTHER/SPEC.md'; other.parent.mkdir(); other.write_text('Unrelated board demand')
        self.change(lambda v: v['parts'][0]['use']['required']['supply'].update(source=dict(path=other.relative_to(self.root).as_posix(), sha256=evidence.sha(other), section='Unrelated')), True)
        self.assertIn('use_conditions_owner', self.codes(self.verify()))

    def test_unsupported_lifecycle_claim_cannot_be_added_to_manifest(self):
        self.change(lambda v: v.update(qualified=True), True)
        self.assertIn('invalid_manifest', self.codes(self.verify()))

    def test_schema_examples_are_pending_and_profile_hash_is_exact(self):
        folder=REPO/'hardware-design/registry/part-reviews'
        profile_path=folder/'examples/SYNTHETIC.profile.example.json'
        profile=json.loads(profile_path.read_text()); use=json.loads((folder/'examples/SYNTHETIC.part-use.example.json').read_text())
        self.assertEqual(profile['review']['verdict'],'pending'); self.assertEqual(use['review']['verdict'],'pending')
        self.assertEqual(use['parts'][0]['profile']['sha256'],evidence.sha(profile_path))
        self.assertEqual(profile['review']['facts_sha256'],evidence.facts_digest(profile))
        self.assertEqual(use['review']['facts_sha256'],evidence.facts_digest(use))
        for name,example in [('part-profile.schema.json',profile),('part-use.schema.json',use)]:
            schema=json.loads((folder/name).read_text())
            self.assertEqual(example['schema'],schema['properties']['schema']['const'])
            self.assertTrue(set(schema['required'])<=set(example))

    def test_cli_runtime_failure_preserves_original_cause_in_output(self):
        output = self.root / 'operation/result.json'
        with contextlib.redirect_stdout(io.StringIO()), mock.patch.object(sys, 'argv', ['part_evidence.py', 'inspect', str(self.root/'missing.pdf'), '--output', str(output), '--json']):
            code = evidence.main()
        result = json.loads(output.read_text())
        self.assertEqual(code, 1); self.assertFalse(result['qualified'])
        self.assertIn('missing.pdf', result['blockers'][0]['detail'])


class SelectionContractTests(unittest.TestCase):
    """Pre-CAD review reuses source/rating checks without consulting native CAD."""
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup)
        self.root=Path(self.tmp.name);self.manifest=make_fixture(self.root)
        self.value=json.loads(self.manifest.read_text())
        self.pdf=self.root/self.value['parts'][0]['datasheets'][0]['path']
        for path in (self.root/'hardware-design/boards/PART-FIXTURE').iterdir():
            if path.name!='SPEC.md':path.unlink()
        self.real_pdf_pages=evidence.pdf_pages
        pages=mock.patch.object(evidence,'pdf_pages',return_value=1);pages.start();self.addCleanup(pages.stop)
        reader=mock.patch.object(native,'read_board',side_effect=AssertionError('selection must not inspect native CAD'))
        self.reader=reader.start();self.addCleanup(reader.stop)

    def write(self,value,reviewed=True):
        if reviewed:value['review']['facts_sha256']=evidence.facts_digest(value)
        self.manifest.write_text(json.dumps(value));return value

    def verify(self,output=None):return evidence.verify_selection(self.root,'PART-FIXTURE',self.manifest,output)

    def codes(self,result):return {row['code'] for row in result['blockers']}

    def partial_profile(self):
        self.write(copy.deepcopy(self.value));profile=PartContractTests.shared_profile(self)
        static=json.loads(profile.read_text());static['native']={};static['review']['facts_sha256']=evidence.facts_digest(static)
        profile.write_text(json.dumps(static))
        value=json.loads(self.manifest.read_text());value['parts'][0]['profile']['sha256']=evidence.sha(profile)
        value['parts'][0]['use'].pop('pad_net_map');value['budgets']=[]
        for part in value['parts'][1:]:part['native']={}
        self.write(value);return profile,value

    def test_reviewed_selection_passes_without_any_cad_and_retains_source_closure(self):
        output=self.root/'selection-report.json';result=self.verify(output)
        self.assertEqual(result['status'],'passed',result['blockers']);self.reader.assert_not_called()
        self.assertEqual(result['scope'],'reviewed_part_selection');self.assertEqual(set(result['selections']),{'J1','J2','J3','J4'})
        self.assertEqual(result['bindings'],{});self.assertEqual(result['native_inputs'],{})
        for flag in ('native_verified','cad_verified','connectivity_verified','layout_verified','stock_verified','stock_current','qualified','release_approved'):
            self.assertIs(result[flag],False,flag)
        self.assertEqual(result['checked_budgets'][0]['scope'],'declared_planned_net_only')
        self.assertEqual(json.loads(output.read_text()),result)
        self.assertEqual(result['inputs'][self.manifest.relative_to(self.root).as_posix()],evidence.sha(self.manifest))
        self.assertEqual(result['inputs'][self.pdf.relative_to(self.root).as_posix()],evidence.sha(self.pdf))
        self.assertFalse(any(name.endswith(('.kicad_pcb','.kicad_sch','gate.json')) for name in result['inputs']))
        closure=evidence.dependency_files(self.root,self.manifest,include_native=False)
        self.assertEqual(set(closure),set(result['inputs']));self.reader.assert_not_called()

    def test_no_planned_assets_are_needed_for_applicability_but_budgets_need_planned_nets(self):
        value=copy.deepcopy(self.value)
        for part in value['parts']:part['native']={}
        self.write(value);result=self.verify()
        self.assertIn('planned_budget_scope',self.codes(result))
        value['budgets']=[];self.write(value);result=self.verify()
        self.assertEqual(result['status'],'passed',result['blockers'])
        self.assertEqual(result['selections']['J1']['planned_native'],{});self.reader.assert_not_called()
        self.partial_profile();result=self.verify()
        self.assertEqual(result['status'],'passed',result['blockers'])

    def test_underspecified_rating_conditions_identity_and_unresolved_items_block(self):
        cases=[('invalid_part_evidence',lambda v:v['parts'][0]['ratings'][0].pop('conditions')),
               ('invalid_part_evidence',lambda v:v['parts'][0]['ratings'][0]['required'].pop('unit')),
               ('rating_exceeded',lambda v:v['parts'][0]['ratings'][0]['required'].update(max=6)),
               ('rating_conditions',lambda v:v['parts'][0]['ratings'][0]['conditions'][0]['required'].update(max=100)),
               ('part_identity',lambda v:v['parts'][0].update(mpn='')),
               ('package_identity',lambda v:v['parts'][0]['package'].update(variant='')),
               ('unresolved_part_use',lambda v:v['parts'][0]['unresolved'].append('maximum duty cycle not reviewed'))]
        for expected,mutate in cases:
            with self.subTest(expected=expected):
                value=copy.deepcopy(self.value);mutate(value);self.write(value)
                result=self.verify();self.assertNotEqual(result['status'],'passed');self.assertIn(expected,self.codes(result))
                if expected=='unresolved_part_use':self.assertIn('maximum duty cycle',str(result['blockers']))
        self.reader.assert_not_called()

    def test_board_ownership_review_and_changed_original_source_are_enforced_before_cad(self):
        for expected,mutate,reviewed in [
                ('manifest_identity',lambda v:v.update(board='ANOTHER-DESIGN'),True),
                ('manifest_identity',lambda v:v.update(project='hardware-design/boards/ANOTHER-DESIGN/project'),True),
                ('review_pending',lambda v:v['review'].update(verdict='pending'),False),
                ('stale_review',lambda v:v['parts'][0]['ratings'][0]['limit'].update(max=8),False)]:
            with self.subTest(expected=expected):
                value=copy.deepcopy(self.value);mutate(value);self.write(value,reviewed)
                self.assertIn(expected,self.codes(self.verify()))
        self.write(copy.deepcopy(self.value));self.pdf.write_bytes(self.pdf.read_bytes()+b'\nchanged original\n')
        self.assertEqual(self.verify()['status'],'stale');self.assertIn('stale_source',self.codes(self.verify()))

    def test_demand_cannot_borrow_an_unrelated_boards_requirement(self):
        other=self.root/'hardware-design/boards/OTHER/SPEC.md';other.parent.mkdir();other.write_text('Unrelated board requirement')
        value=copy.deepcopy(self.value)
        value['parts'][0]['ratings'][0]['required']['source']=dict(path=other.relative_to(self.root).as_posix(),sha256=evidence.sha(other),section='Other board')
        self.write(value);self.assertIn('use_conditions_owner',self.codes(self.verify()))

    def test_actual_pdfinfo_descriptor_is_bound_and_binary_change_invalidates_observation(self):
        binary=self.root/'fixture-pdfinfo'
        binary.write_text('#!'+sys.executable+'\nimport sys\nprint("fixture pdfinfo 1" if "-v" in sys.argv else "Pages: 1")\n')
        binary.chmod(0o755)
        with mock.patch.dict(os.environ,{'PDFINFO':str(binary)}),mock.patch.object(evidence,'pdf_pages',wraps=self.real_pdf_pages):
            result=self.verify()
        self.assertEqual(result['status'],'passed',result['blockers'])
        self.assertEqual(result['tool_inputs'][str(binary.resolve())],evidence.sha(binary))
        import design_contract
        observation=dict(schema=design_contract.REPORT,inputs={str(self.root/k):v for k,v in result['inputs'].items()},tool_inputs=result['tool_inputs'])
        self.assertTrue(design_contract.current_assessment(observation))
        binary.write_text(binary.read_text()+'# changed binary at the same path\n')
        self.assertFalse(design_contract.current_assessment(observation))

    def test_structural_schemas_allow_early_partial_declarations_without_native_approval(self):
        profile,value=self.partial_profile()
        folder=REPO/'hardware-design/registry/part-reviews'
        for name,instance in [('part-use.schema.json',value),('part-profile.schema.json',json.loads(profile.read_text()))]:
            schema=json.loads((folder/name).read_text())
            self.assertFalse(schema['$defs']['native'].get('required'))
            self.assertNotIn('pad_net_map',schema['$defs']['use']['required'])
            if importlib.util.find_spec('jsonschema'):
                import jsonschema
                jsonschema.Draft202012Validator(schema).validate(instance)
        result=self.verify();self.assertEqual(result['status'],'passed',result['blockers']);self.assertFalse(result['cad_verified'])

    def test_shared_profile_reuse_keeps_exact_review_conditions_and_hashes_without_cad(self):
        profile=PartContractTests.shared_profile(self)
        result=self.verify();self.assertEqual(result['status'],'passed',result['blockers'])
        key=profile.relative_to(self.root).as_posix();self.assertEqual(result['profiles'][key],evidence.sha(profile))
        self.assertIn(key,evidence.dependency_files(self.root,self.manifest,include_native=False))
        value=json.loads(self.manifest.read_text());value['parts'][0]['use']['conditions'].clear();self.write(value)
        self.assertIn('invalid_part_evidence',self.codes(self.verify()))
        self.write(copy.deepcopy(self.value));profile=PartContractTests.shared_profile(self)
        static=json.loads(profile.read_text());static['ratings'][0]['limit']['max']=8;profile.write_text(json.dumps(static))
        value=json.loads(self.manifest.read_text());value['parts'][0]['profile']['sha256']=evidence.sha(profile);self.write(value)
        self.assertIn('stale_profile_review',self.codes(self.verify()));self.reader.assert_not_called()

    def test_selection_cli_retains_full_report_and_prints_compact_receipt(self):
        output=self.root/'operation/report.json';stdout=io.StringIO()
        with contextlib.redirect_stdout(stdout),mock.patch.object(sys,'argv',['part_evidence.py','selection','PART-FIXTURE',
                '--manifest',str(self.manifest),'--root',str(self.root),'--output',str(output),'--json']):
            code=evidence.main()
        self.assertEqual(code,0);receipt=json.loads(stdout.getvalue());full=json.loads(output.read_text())
        self.assertEqual(receipt['scope'],'reviewed_part_selection');self.assertNotIn('inputs',receipt)
        self.assertTrue(full['inputs']);self.assertFalse(full['cad_verified'])
        self.assertEqual(receipt['report'],dict(path=str(output.resolve()),sha256=evidence.sha(output)))


class StockObservationTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(); self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        make_fixture(self.root)
        for suffix in ('kicad_sch','kicad_pcb'):
            path=self.root/('hardware-design/boards/PART-FIXTURE/fixture.'+suffix)
            path.write_text(path.read_text().replace('C900002','C900001').replace('C900004','C900003'))
        (self.root/'hardware-design/boards/PART-FIXTURE/variants.json').write_text(json.dumps(dict(variants=['full','small'],
            fit={'J1':['full'],'J2':['full'],'J3':['full','small'],'J4':['full','small']})))
        snapshot = native.read_board(self.root, 'PART-FIXTURE')
        self.candidate = self.root / 'candidate'; self.candidate.mkdir()
        gate = self.candidate / 'fab/gate-evidence.json'; gate.parent.mkdir()
        gate.write_text(json.dumps(dict(board='PART-FIXTURE', input_sha256='a'*64,
            result=dict(provenance=dict(inputs=[dict(path=k, sha256=v) for k,v in snapshot['native_inputs'].items()])))))
        self.manifest = self.candidate / 'release-manifest.json'
        self.manifest.write_text(json.dumps(dict(schema_version=1, scope='cad_fabrication_candidate', board='PART-FIXTURE',
            input_sha256='a'*64, artifacts={'fab/gate-evidence.json': evidence.sha(gate)},
            assembly=dict(populations={'full': {'references': {'J1': 'C900001', 'J2': 'C900001', 'J3': 'C900003','J4':'C900003'}}, 'small': {'references': {'J3': 'C900003','J4':'C900003'}}}))))
        self.receipts = self.root / 'receipts'
        self.called = 0

    def runner(self, command, **kwargs):
        self.called += 1
        self.assertEqual(command[-2:], ['--boards', '3'])
        self.receipts.mkdir()
        day = evidence.dt.datetime.now(evidence.dt.timezone.utc).date().isoformat()
        receipt = dict(schema_version=1, board='PART-FIXTURE', candidate_sha256=evidence.sha(self.manifest),
            source_url='https://jlcpcb.com/api/overseas-pcb-order/v1/shoppingCart/smtGood/selectSmtComponentList',
            order_day_utc=day, boards=3, parts={})
        for code, required in [('C900001', 6), ('C900003', 6)]:
            target = self.receipts / (code + '.json')
            target.write_text(json.dumps({'data': {'componentPageInfo': {'list': [dict(componentCode=code, stockCount=required, componentModelEn='SYNTHETIC-TP')]}}}))
            receipt['parts'][code] = dict(required=required, fetched_at_utc=day+'T00:00:00+00:00', response=target.name, response_sha256=evidence.sha(target))
        self.mutate(receipt)
        (self.receipts / 'stock.json').write_text(json.dumps(receipt))
        return subprocess.CompletedProcess(command, 0)

    def mutate(self, receipt):
        pass

    def observe(self, **kwargs):
        return evidence.stock_board(self.root, kwargs.get('board', 'PART-FIXTURE'), self.candidate,
                                    kwargs.get('boards', 3), self.receipts, self.runner)

    def test_exact_observation_retains_original_responses_and_is_not_engineering_approval(self):
        result = self.observe()
        self.assertEqual(result['status'], 'observed', result['blockers'])
        self.assertTrue(result['stock_current']); self.assertFalse(result['qualified']); self.assertFalse(result['release_approved'])
        self.assertEqual(result['observations']['C900001']['required'], 6)
        self.assertEqual(result['inputs'][str((self.receipts/'C900001.json').resolve())],evidence.sha(self.receipts/'C900001.json'))
        self.assertEqual(result['inputs'][str((self.receipts/'stock.json').resolve())],evidence.sha(self.receipts/'stock.json'))

    def test_unknown_board_candidate_mismatch_and_invalid_quantity_never_query(self):
        for options in [dict(board='UNKNOWN'), dict(boards=0), dict(boards=True)]:
            self.assertEqual(self.observe(**options)['status'], 'blocked')
        value = json.loads(self.manifest.read_text()); value['board'] = 'OTHER'; self.manifest.write_text(json.dumps(value))
        self.assertEqual(self.observe()['status'], 'blocked'); self.assertEqual(self.called, 0)

    def test_stale_day_quantity_and_candidate_binding_are_rejected(self):
        for change in [lambda r: r.update(order_day_utc='2000-01-01'), lambda r: r.update(boards=2),
                       lambda r: r.update(candidate_sha256='0'*64), lambda r: r['parts']['C900001'].update(required=3),
                       lambda r: r['parts']['C900001'].update(response_sha256='0'*64)]:
            self.mutate = change
            result = self.observe()
            self.assertEqual(result['status'], 'blocked', result)
            shutil.rmtree(self.receipts)

    def test_existing_receipts_are_preserved_without_query(self):
        self.receipts.mkdir(); (self.receipts/'original').write_text('keep')
        self.assertEqual(self.observe()['status'], 'blocked')
        self.assertEqual(self.called, 0); self.assertEqual((self.receipts/'original').read_text(), 'keep')

    def test_changed_native_board_does_not_query_candidate_stock(self):
        native_board = self.root / 'hardware-design/boards/PART-FIXTURE/fixture.kicad_pcb'
        native_board.write_text(native_board.read_text()+'\n')
        self.assertEqual(self.observe()['status'], 'blocked'); self.assertEqual(self.called, 0)

    def test_wrong_exact_mpn_even_with_correct_code_and_stock_is_blocked(self):
        def wrong(receipt):
            path=self.receipts/'C900001.json'; value=json.loads(path.read_text())
            value['data']['componentPageInfo']['list'][0]['componentModelEn']='WRONG-MPN'
            path.write_text(json.dumps(value)); receipt['parts']['C900001']['response_sha256']=evidence.sha(path)
        self.mutate=wrong
        self.assertEqual(self.observe()['status'],'blocked')

    def test_omitted_fitted_ref_wrong_variant_and_wrong_lcsc_never_query(self):
        original=self.manifest.read_text()
        for mutate in [lambda v:v['assembly']['populations']['full']['references'].pop('J4'),
                       lambda v:v['assembly']['populations'].pop('small'),
                       lambda v:v['assembly']['populations']['full']['references'].update(J1='C999')]:
            value=json.loads(original);mutate(value);self.manifest.write_text(json.dumps(value))
            self.assertEqual(self.observe()['status'],'blocked')
        self.assertEqual(self.called,0)

    def test_malformed_variant_policy_and_fitted_ref_exclusion_never_query(self):
        path=self.root/'hardware-design/boards/PART-FIXTURE/variants.json'; original=path.read_text()
        for fit in ['full',[],['UNKNOWN'],['full','full']]:
            value=json.loads(original);value['fit']['J1']=fit;path.write_text(json.dumps(value))
            self.assertEqual(self.observe()['status'],'blocked')
        self.assertEqual(self.called,0)

    def default_population(self):
        policy=self.root/'hardware-design/boards/PART-FIXTURE/variants.json'; policy.unlink()
        value=json.loads(self.manifest.read_text())
        value['assembly']['populations']={'DEFAULT':value['assembly']['populations']['full']}
        self.manifest.write_text(json.dumps(value))
        return policy

    def test_absent_population_policy_is_bound_and_appearing_policy_expires_stock(self):
        policy=self.default_population(); result=self.observe()
        self.assertEqual(result['status'],'observed',result['blockers'])
        self.assertEqual(result['population_source'],dict(path=str(policy.resolve()),exists=False,sha256=None))
        self.assertTrue(evidence.stock_population_current(result))
        policy.write_text('{"variants":["NEW"],"fit":{}}')
        self.assertFalse(evidence.stock_population_current(result))
        with self.assertRaisesRegex(ValueError,'appeared'):
            evidence.verify_population_source(result)

    def test_population_policy_appearing_during_query_blocks_acceptance(self):
        policy=self.default_population()
        self.mutate=lambda receipt:policy.write_text('{"variants":["NEW"],"fit":{}}')
        result=self.observe()
        self.assertEqual(result['status'],'blocked'); self.assertFalse(result['stock_current'])
        self.assertIn('appeared',result['blockers'][0]['detail'])

    def test_missing_or_malformed_population_binding_never_claims_current(self):
        self.assertFalse(evidence.stock_population_current({}))
        result=self.observe(); self.assertTrue(evidence.stock_population_current(result))
        result['population_source']['sha256']=None
        self.assertFalse(evidence.stock_population_current(result))


class PdfCacheTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(); self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name); self.pdf = self.root / 'document.pdf'; synthetic_pdf(self.pdf)
        self.call_log = self.root / 'extractor-calls.jsonl'
        self.commands = {}
        scripts = {'pdfinfo': "print('Pages: 2')", 'pdftotext': "sys.stdout.write('FIRST PAGE\\fSECOND PAGE\\f')",
                   'pdftoppm': "Path(sys.argv[-1]+'.png').write_bytes(b'fixture PNG '+json.dumps(sys.argv[1:]).encode())"}
        for name, body in scripts.items():
            path = self.root / name
            path.write_text('#!' + sys.executable + '\nimport json,sys\nfrom pathlib import Path\n'
                'if sys.argv[1:] == ["-v"]:\n print("synthetic extractor v1"); sys.exit(0)\n'
                'with Path('+repr(str(self.call_log))+').open("a") as log:\n'
                ' log.write(json.dumps({"tool":'+repr(name)+',"args":sys.argv[1:]})+"\\n")\n' + body + '\n')
            path.chmod(0o755); self.commands[name] = str(path)

    def inspect(self, **options):
        with contextlib.redirect_stderr(io.StringIO()):
            return evidence.inspect_pdf(self.pdf, self.root / 'cache', extractors=self.commands, **options)

    def content_calls(self, name):
        # Version probes still bind the current executable descriptor; these
        # count only real PDF reads/extractions/renders by the fake processes.
        return [row['args'] for row in map(json.loads,self.call_log.read_text().splitlines()) if row['tool']==name]

    def test_cold_warm_pages_and_identical_pdf_different_path(self):
        first = self.inspect(); second = self.inspect()
        self.assertFalse(first['cache_hit']); self.assertTrue(second['cache_hit'])
        self.assertEqual(first['receipt']['page_count'], 2)
        self.assertFalse(first['receipt']['reviewed'])
        self.assertEqual((Path(first['cache_directory'])/'pages/0002.txt').read_text(), 'SECOND PAGE')
        self.assertIn(str((Path(first['cache_directory'])/'pages/0002.txt').resolve()),first['inputs'])
        self.assertEqual(first['tool_inputs'][str(Path(self.commands['pdftotext']).resolve())],evidence.sha(self.commands['pdftotext']))
        other = self.root/'same-bytes.pdf'; shutil.copyfile(self.pdf, other)
        self.assertTrue(evidence.inspect_pdf(other, self.root/'cache', extractors=self.commands)['cache_hit'])

    def test_pdf_extractor_executable_and_options_change_cache_key(self):
        first = self.inspect()
        self.pdf.write_bytes(self.pdf.read_bytes() + b'\nchanged\n')
        changed = self.inspect(); self.assertNotEqual(first['cache_key'], changed['cache_key'])
        path = Path(self.commands['pdftotext']); path.write_text(path.read_text() + '# changed executable same version\n')
        tool_changed = self.inspect(); self.assertNotEqual(changed['cache_key'], tool_changed['cache_key'])
        rendered = self.inspect(render_pages=[1]); self.assertNotEqual(tool_changed['cache_key'], rendered['cache_key'])
        self.assertIn('renders/0001.png', rendered['receipt']['artifacts'])

    def test_corrupt_cached_text_forces_extraction(self):
        first = self.inspect(); (Path(first['cache_directory'])/'pages/0001.txt').write_text('corrupted')
        second = self.inspect(); self.assertFalse(second['cache_hit'])
        self.assertEqual((Path(second['cache_directory'])/'pages/0001.txt').read_text(), 'FIRST PAGE')

    def test_new_render_pages_and_dpi_reuse_text_without_reading_pdf_again(self):
        first=self.inspect();one=self.inspect(render_pages=[1]);two=self.inspect(render_pages=[2],dpi=288)
        self.assertFalse(first['text_cache_hit'])
        renderer=Path(self.commands['pdftoppm']);renderer.write_text(renderer.read_text()+'# changed renderer; same version\n')
        three=self.inspect(render_pages=[2],dpi=288)
        self.assertEqual(len({row['cache_key'] for row in (first,one,two,three)}),4)
        for row,page,dpi in ((one,1,144),(two,2,288),(three,2,288)):
            self.assertFalse(row['cache_hit']);self.assertTrue(row['text_cache_hit'])
            self.assertEqual(row['receipt']['schema'],1)
            self.assertEqual(row['receipt']['options']['render_pages'],[page])
            self.assertEqual(row['receipt']['options']['dpi'],dpi)
            self.assertIn('renders/%04d.png'%page,row['receipt']['artifacts'])
            self.assertEqual((Path(row['cache_directory'])/'pages/0002.txt').read_text(),'SECOND PAGE')
        self.assertEqual(len(self.content_calls('pdftotext')),1)
        self.assertEqual(len(self.content_calls('pdfinfo')),1)
        renders=self.content_calls('pdftoppm');self.assertEqual(len(renders),3)
        for args,page,dpi in zip(renders,('1','2','2'),('144','288','288')):
            self.assertEqual(args[args.index('-f')+1],page)
            self.assertEqual(args[args.index('-l')+1],page)
            self.assertEqual(args[args.index('-r')+1],dpi)

    def test_changed_text_or_page_count_tool_cannot_reuse_extracted_text(self):
        first=self.inspect()
        text=Path(self.commands['pdftotext']);text.write_text(text.read_text().replace('FIRST PAGE','UPDATED FIRST PAGE'))
        second=self.inspect(render_pages=[1]);self.assertFalse(second['text_cache_hit'])
        self.assertNotEqual(first['cache_key'],second['cache_key'])
        self.assertEqual((Path(second['cache_directory'])/'pages/0001.txt').read_text(),'UPDATED FIRST PAGE')
        info=Path(self.commands['pdfinfo']);info.write_text(info.read_text()+'# changed executable; same version\n')
        third=self.inspect(render_pages=[2]);self.assertFalse(third['text_cache_hit'])
        self.assertEqual(len(self.content_calls('pdftotext')),3)
        self.assertEqual(len(self.content_calls('pdfinfo')),3)

    def test_corrupt_text_entry_is_not_copied_into_a_new_render_request(self):
        first=self.inspect()
        text=Path(first['text_cache_directory'])/'pages'
        for number,options in ((2,dict(render_pages=[2])),(1,dict(render_pages=[1],dpi=288))):
            if number==2:(text/'0002.txt').write_text('corrupted second canonical page')
            else:(text/'0001.txt').unlink()
            self.assertEqual((Path(first['cache_directory'])/'pages/0002.txt').read_text(),'SECOND PAGE')
            rendered=self.inspect(**options);self.assertFalse(rendered['text_cache_hit'])
            for page,expected in ((1,'FIRST PAGE'),(2,'SECOND PAGE')):
                self.assertEqual((Path(rendered['cache_directory'])/('pages/%04d.txt'%page)).read_text(),expected)
        self.assertEqual(len(self.content_calls('pdftotext')),3)
        self.assertEqual(len(self.content_calls('pdfinfo')),3)

    def test_legacy_v1_full_receipt_hit_seeds_text_for_later_render_reuse(self):
        first=self.inspect();folder=Path(first['cache_directory'])
        # Keep exactly the original full-request v1 receipt and page artifacts;
        # remove all new text-cache state, as on an upgrade from existing data.
        keys=('schema','pdf_sha256','tools','options','key','scope','page_count','reviewed','artifacts')
        receipt={key:first['receipt'][key] for key in keys}
        raw=evidence.part_native.encoded(receipt)+b'\n';(folder/'receipt.json').write_bytes(raw)
        (folder/'receipt.sha256').write_text(evidence.part_native.digest(raw)+'\n')
        shutil.rmtree(self.root/'cache/text')
        existing=self.inspect();self.assertTrue(existing['cache_hit'])
        self.assertEqual(existing['receipt'],receipt)
        rendered=self.inspect(render_pages=[1],dpi=288)
        self.assertFalse(rendered['cache_hit']);self.assertTrue(rendered['text_cache_hit'])
        self.assertEqual(len(self.content_calls('pdftotext')),1)
        self.assertEqual(len(self.content_calls('pdfinfo')),1)
        self.assertEqual(len(self.content_calls('pdftoppm')),1)

    def test_inspect_cli_output_keeps_full_report_and_prints_compact_bound_receipt(self):
        output=self.root/'inspection/report.json';stdout=io.StringIO()
        arguments=['part_evidence.py','inspect',str(self.pdf),'--cache',str(self.root/'cache'),'--json']
        environment={name.upper():path for name,path in self.commands.items()}
        with mock.patch.dict(os.environ,environment),contextlib.redirect_stderr(io.StringIO()):
            with contextlib.redirect_stdout(stdout),mock.patch.object(sys,'argv',arguments+['--output',str(output)]):
                self.assertEqual(evidence.main(),0)
            terminal=json.loads(stdout.getvalue());full=json.loads(output.read_text())
            self.assertEqual(terminal['scope'],'pdf_inspection');self.assertEqual(terminal['status'],'inspected')
            self.assertFalse(terminal['qualified']);self.assertNotIn('inputs',terminal)
            self.assertNotIn('receipt',terminal)
            self.assertTrue(full['inputs']);self.assertEqual(full['receipt']['page_count'],2)
            self.assertEqual(terminal['report'],dict(path=str(output.resolve()),sha256=evidence.sha(output)))
            stdout=io.StringIO()
            with contextlib.redirect_stdout(stdout),mock.patch.object(sys,'argv',arguments):
                self.assertEqual(evidence.main(),0)
            self.assertTrue(json.loads(stdout.getvalue())['inputs'])

    def test_rewritten_receipt_with_wrong_identity_cannot_reuse_key(self):
        first=self.inspect(); folder=Path(first['cache_directory'])
        value=json.loads((folder/'receipt.json').read_text()); value['pdf_sha256']='0'*64
        raw=evidence.part_native.encoded(value)+b'\n'; (folder/'receipt.json').write_bytes(raw)
        (folder/'receipt.sha256').write_text(evidence.part_native.digest(raw)+'\n')
        second=self.inspect(); self.assertFalse(second['cache_hit'])
        self.assertEqual(second['receipt']['pdf_sha256'],evidence.sha(self.pdf))

    def test_non_pdf_and_invalid_page_never_publish(self):
        self.pdf.write_text('not PDF')
        with self.assertRaises(ValueError): self.inspect()
        synthetic_pdf(self.pdf)
        with self.assertRaises(ValueError): self.inspect(render_pages=[3])


if __name__ == '__main__':
    unittest.main(verbosity=2)
