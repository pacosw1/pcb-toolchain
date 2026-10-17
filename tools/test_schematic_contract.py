"""Functional mutations use real native identity/review readers and isolated CAD.

CPU tests replace the KiCad export process and the PDF page-count boundary
(the synthetic PDF has one page). The small fixture export reads current placed
values, fields and attached labels independently of the functional contract;
these tests make no native-runtime or original-PDF-inspection claim. The public
native-proof fixture builder installs neither boundary replacement.
"""
import copy
from decimal import Decimal
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest import mock
import xml.etree.ElementTree as ET

import design_contract
import part_evidence
import pq_cadlib as cad
import schematic_contract as contract
from test_part_evidence import make_fixture


class QuantityTests(unittest.TestCase):
    def test_equivalent_units_and_resistor_notation_are_exact(self):
        for text in ('1uF','1000nF','0.001mF','1µF'):
            self.assertEqual(contract.canonical_value(text,'F'),(Decimal('0.000001'),'F'))
        for text in ('4k7','4.7kOhm','4700Ohm','4700Ω'):
            self.assertEqual(contract.canonical_value(text,'Ohm'),(Decimal(4700),'Ohm'))
        self.assertEqual(contract.canonical_value('4R7','Ohm')[0],Decimal('4.7'))
        for value in ('1W','nan','1bogus'):
            with self.subTest(value=value),self.assertRaises(ValueError):contract.canonical_value(value,'F')
        for value in (True,False,float('nan'),float('inf')):
            with self.subTest(value=value),self.assertRaises(ValueError):contract.number(value)


class SchematicContractTests(unittest.TestCase):
    def setUp(self,fixture_root=None,mock_export=True):
        if fixture_root is None:
            self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup)
            self.root=Path(self.tmp.name).resolve()
        else:
            self.root=Path(fixture_root).resolve();self.root.mkdir(parents=True,exist_ok=False)
        self.board='PART-FIXTURE'
        self.part_manifest=make_fixture(self.root)
        self.folder=self.root/'hardware-design/boards'/self.board
        self.schematic=self.folder/'fixture.kicad_sch';self.pcb=self.folder/'fixture.kicad_pcb'
        self.seq=0
        self.change_property(self.schematic,'symbol','J1','Value','1uF')
        self.change_property(self.pcb,'footprint','J1','Value','1uF')
        self.change_property(self.schematic,'symbol','J1','Operating_Mode','low')
        self.spec=self.folder/'SPEC.md'
        self.spec.write_text(self.spec.read_text()+'\nSynthetic functional fixture: J1 nominal1uF exactly; low mode only.\n'
            'The /A rail permits0..0.1A; J1,J2 each require0..0.02A in low mode. These are test facts, not production ratings.\n')
        parts=json.loads(self.part_manifest.read_text())
        def update(item):
            if isinstance(item,dict):
                if item.get('path')==self.spec.relative_to(self.root).as_posix():item['sha256']=contract.sha(self.spec)
                for child in item.values():update(child)
            elif isinstance(item,list):
                for child in item:update(child)
        update(parts);parts['review']['facts_sha256']=part_evidence.facts_digest(parts)
        self.part_manifest.write_text(json.dumps(parts))
        self.source=dict(path=self.spec.relative_to(self.root).as_posix(),sha256=contract.sha(self.spec),section='Synthetic functional fixture')
        self.path=self.folder/'schematic-functional.json';self.design_path=self.folder/'design-contract.json'
        requirement_ids=['REQ-VALUE','REQ-PINS','REQ-POPULATION','REQ-MODE','REQ-BUDGET']
        design=dict(schema=design_contract.SCHEMA,identity=dict(design_id=self.board,board=self.board,revision='synthetic-1'),
            current_stage='schematic',architecture=None,test_plans=[],failure_conditions=[],unknowns=[],production={},
            requirements=[dict(id=i,statement='Synthetic fixture assertion '+i,
                source=self.source,verification_stage='schematic',acceptance=dict(kind='review',criterion='exact native fixture assertion',source=self.source))
                for i in requirement_ids],checks=[dict(id='CHECK-FUNCTION',kind='schematic',stage='schematic',
                    path=self.path.relative_to(self.root).as_posix(),requirements=requirement_ids)])
        self.design_path.write_text(json.dumps(design))
        self.value=dict(schema=contract.SCHEMA,board=self.board,project='hardware-design/boards/PART-FIXTURE/fixture',
            design_contract=self.bound(self.design_path),part_review=self.bound(self.part_manifest),
            population_source=dict(path='hardware-design/boards/PART-FIXTURE/variants.json',exists=False,sha256=None),
            assertions=[
                dict(id='NOMINAL',kind='value',requirement='REQ-VALUE',source=self.source,reference='J1',mpn='SYNTHETIC-TP',
                    expected=self.interval(1,1,'uF'),conditions=[dict(mode='MODE',value='low')]),
                dict(id='PIN',kind='pin_net',requirement='REQ-PINS',source=self.source,reference='J1',pin='1',pin_name='P',net='/A'),
                dict(id='FIT',kind='population',requirement='REQ-POPULATION',source=self.source,reference='J2',dnp=False,in_bom=True,fits=['DEFAULT']),
                dict(id='MODE',kind='mode',requirement='REQ-MODE',source=self.source,reference='J1',field='Operating_Mode',allowed=['low'],variant='DEFAULT'),
                dict(id='RAIL',kind='budget',requirement='REQ-BUDGET',source=self.source,net='/A',variant='DEFAULT',limit=self.interval(0,.1,'A'),
                    loads=[dict(reference=ref,demand=self.interval(0,20,'mA'),reviewed_demand=dict(budget='rail'),
                        conditions=[dict(mode='MODE',value='low')]) for ref in ('J1','J2')],
                    exclusions=[],conditions=[dict(mode='MODE',value='low')])])
        self.save()
        if mock_export:
            pages=mock.patch.object(part_evidence,'pdf_pages',return_value=1)
            pages.start();self.addCleanup(pages.stop)
            patch=mock.patch.object(contract,'export_native',side_effect=self.fixture_export)
            self.export=patch.start();self.addCleanup(patch.stop)

    def bound(self,path):return dict(path=path.relative_to(self.root).as_posix(),sha256=contract.sha(path))
    def interval(self,lo,hi,unit):return dict(min=lo,max=hi,unit=unit,source=copy.deepcopy(self.source))
    def save(self,review=True):
        if review:
            self.value['review']=dict(verdict='passed',reviewer='synthetic independent test reviewer',reviewed_at_utc='2026-10-16T00:00:00Z',
                facts_sha256=part_evidence.facts_digest(self.value),evidence=copy.deepcopy(self.source))
        self.path.write_text(json.dumps(self.value))

    def check(self):
        self.seq+=1
        return contract.check_contract(self.root,self.board,self.path,self.root/('report-%d.json'%self.seq))

    def change_property(self,path,kind,ref,name,value):
        tree=cad.parse(path.read_text())
        node=next(row for row in cad.items(tree,kind) if any(p[1:3]==['Reference',ref] for p in cad.items(row,'property')))
        prop=next((p for p in cad.items(node,'property') if p[1]==name),None)
        if prop is None:node.append([cad.Atom('property'),name,value,
            [cad.Atom('at'),cad.Atom('0'),cad.Atom('0'),cad.Atom('0')],
            [cad.Atom('effects'),[cad.Atom('font'),[cad.Atom('size'),cad.Atom('1'),cad.Atom('1')]],[cad.Atom('hide'),cad.Atom('yes')]]])
        else:prop[2]=value
        path.write_text(cad.dump(tree))

    def fixture_export(self,schematic,artifacts):
        tree=cad.parse(schematic.read_text());root=ET.Element('export');comps=ET.SubElement(root,'components');nets=ET.SubElement(root,'nets')
        labels={tuple(cad.item(row,'at')[1:3]):row[1] for row in cad.items(tree,'label')}
        grouped={}
        for row in cad.items(tree,'symbol'):
            fields={p[1]:p[2] for p in cad.items(row,'property')};ref=fields['Reference']
            comp=ET.SubElement(comps,'comp',ref=ref);ET.SubElement(comp,'value').text=fields['Value']
            field_nodes=ET.SubElement(comp,'fields')
            for name,value in fields.items():ET.SubElement(field_nodes,'field',name=name).text=value
            net='/'+labels[tuple(cad.item(row,'at')[1:3])];grouped.setdefault(net,[]).append(ref)
        for net,refs in grouped.items():
            node=ET.SubElement(nets,'net',name=net)
            for ref in refs:ET.SubElement(node,'node',ref=ref,pin='1',pinfunction='P')
        raw=ET.tostring(root,encoding='unicode');path=artifacts/'native-netlist.xml';path.write_text(raw)
        return contract.parse_export(raw),{str(path):contract.sha(path)},{}

    def test_complete_source_bound_contract_passes_only_declared_functions(self):
        report=self.check();self.assertEqual(report['status'],'passed',report['blockers'])
        self.assertEqual(len(report['requirement_results']),5)
        self.assertEqual(report['coverage']['passed_assertions'],5)
        self.assertFalse(report['qualified']);self.assertFalse(report['native_export_cache']['hit'])
        self.assertFalse(report['native_export_cache']['reusable'])
        rail=next(row for row in report['assertions'] if row['id']=='RAIL')
        self.assertEqual(rail['actual']['max'],'0.040')
        self.assertEqual(rail['covered_references'],['J1','J2'])

    def test_wrong_actual_value_and_equivalent_notation(self):
        for path,kind in ((self.schematic,'symbol'),(self.pcb,'footprint')):
            self.change_property(path,kind,'J1','Value','1000nF')
        self.assertEqual(self.check()['status'],'passed')
        for path,kind in ((self.schematic,'symbol'),(self.pcb,'footprint')):
            self.change_property(path,kind,'J1','Value','10uF')
        report=self.check();self.assertEqual(report['status'],'blocked')
        self.assertEqual(report['requirement_results']['REQ-VALUE']['status'],'blocked')

    def test_schematic_pcb_value_disagreement_fails_independently(self):
        self.change_property(self.schematic,'symbol','J1','Value','10uF')
        report=self.check();self.assertTrue(any('schematic/PCB nominal' in r.get('cause','') for r in report['assertions']))

    def test_wrong_schematic_pin_net_rejected_even_when_native_pcb_matches_part_review(self):
        tree=cad.parse(self.schematic.read_text());cad.items(tree,'label')[0][1]='B';self.schematic.write_text(cad.dump(tree))
        report=self.check();self.assertEqual(report['status'],'blocked')
        self.assertIn('actual schematic/PCB connected pin differs',report['blockers'][0]['detail'])

    def test_native_dnp_mutation_is_not_hidden_by_unchanged_contract(self):
        # This case isolates the new population assertion from the existing
        # optional part-review budget (which would independently catch J2).
        parts=json.loads(self.part_manifest.read_text());parts['budgets']=[]
        parts['review']['facts_sha256']=part_evidence.facts_digest(parts);self.part_manifest.write_text(json.dumps(parts))
        self.value['part_review']=self.bound(self.part_manifest);self.save()
        tree=cad.parse(self.schematic.read_text())
        row=next(row for row in cad.items(tree,'symbol') if any(p[1:3]==['Reference','J2'] for p in cad.items(row,'property')))
        cad.item(row,'dnp')[1]=cad.Atom('yes');self.schematic.write_text(cad.dump(tree))
        tree=cad.parse(self.pcb.read_text());row=cad.items(tree,'footprint')[1]
        row.append([cad.Atom('attr'),cad.Atom('smd'),cad.Atom('dnp')]);self.pcb.write_text(cad.dump(tree))
        report=self.check();self.assertEqual(report['status'],'blocked')
        self.assertTrue(any('population differs' in r.get('cause','') for r in report['assertions']),report)

    def test_wrong_native_mode_blocks_values_and_budgets_requiring_that_condition(self):
        self.change_property(self.schematic,'symbol','J1','Operating_Mode','high')
        report=self.check();self.assertEqual(report['status'],'blocked')
        for identifier in ('REQ-MODE','REQ-VALUE','REQ-BUDGET'):
            self.assertEqual(report['requirement_results'][identifier]['status'],'blocked')

    def test_aggregate_loads_and_complete_native_branch_coverage_are_required(self):
        rail=self.value['assertions'][-1]
        rail['limit']=self.interval(0,30,'mA')
        self.save();report=self.check();self.assertEqual(report['requirement_results']['REQ-BUDGET']['status'],'blocked')
        rail['loads'].pop();self.save();report=self.check()
        self.assertTrue(any('coverage' in r.get('cause','') for r in report['assertions']))

    def test_local_load_budget_cannot_understate_independently_reviewed_current_demands(self):
        rail=self.value['assertions'][-1]
        for load in rail['loads']:load['demand']=self.interval(0,1,'mA')
        rail['limit']=self.interval(0,3,'mA')
        design=json.loads(self.design_path.read_text())
        design['requirements'][-1]['acceptance']=dict(kind='interval',**self.interval(0,3,'mA'))
        self.design_path.write_text(json.dumps(design));self.value['design_contract']=self.bound(self.design_path);self.save()
        report=self.check();self.assertEqual(report['requirement_results']['REQ-BUDGET']['status'],'blocked')
        self.assertTrue(any('exact reviewed part-use demand' in row.get('cause','') for row in report['assertions']))

    def test_missing_or_wrong_reviewed_demand_binding_is_not_a_budget_pass(self):
        load=self.value['assertions'][-1]['loads'][0]
        for selector in (None,dict(budget='unknown'),dict(budget='rail',rating='supply')):
            if selector is None:load.pop('reviewed_demand',None)
            else:load['reviewed_demand']=selector
            self.save();report=self.check()
            self.assertEqual(report['requirement_results']['REQ-BUDGET']['status'],'blocked')

    def test_non_load_classification_cannot_erase_a_scoped_reviewed_positive_load(self):
        rail=self.value['assertions'][-1];rail['loads'].pop()
        rail['exclusions']=[dict(reference='J2',reason='synthetic incorrect passive classification',source=self.source)]
        rail['limit']=self.interval(0,30,'mA');self.save();report=self.check()
        self.assertEqual(report['requirement_results']['REQ-BUDGET']['status'],'blocked')
        self.assertTrue(any('positive reviewed load' in row.get('cause','') for row in report['assertions']))

    def test_lower_rating_selector_cannot_override_an_existing_reviewed_net_budget(self):
        parts=json.loads(self.part_manifest.read_text())
        for part in parts['parts'][:2]:
            pdf={key:part['datasheets'][0][key] for key in ('path','sha256','page')}
            part['ratings'].append(dict(id='other-current',quantity='current',limit=dict(min=0,max=.1,unit='A',source=pdf),
                required=self.interval(0,.001,'A'),conditions=[]))
        parts['review']['facts_sha256']=part_evidence.facts_digest(parts);self.part_manifest.write_text(json.dumps(parts))
        self.value['part_review']=self.bound(self.part_manifest)
        for load in self.value['assertions'][-1]['loads']:
            load.update(reviewed_demand=dict(rating='other-current'),demand=self.interval(0,1,'mA'))
        self.save();report=self.check();self.assertEqual(report['requirement_results']['REQ-BUDGET']['status'],'blocked')
        self.assertTrue(any('another scoped reviewed net demand' in row.get('cause','') for row in report['assertions']))

    def test_actual_part_rating_required_current_can_bind_a_load(self):
        parts=json.loads(self.part_manifest.read_text())
        for part in parts['parts'][:2]:
            pdf={key:part['datasheets'][0][key] for key in ('path','sha256','page')}
            part['ratings'].append(dict(id='load-current',quantity='current',
                limit=dict(min=0,max=.1,unit='A',source=pdf),required=self.interval(0,.02,'A'),conditions=[]))
        parts['review']['facts_sha256']=part_evidence.facts_digest(parts);self.part_manifest.write_text(json.dumps(parts))
        self.value['part_review']=self.bound(self.part_manifest)
        for load in self.value['assertions'][-1]['loads']:load['reviewed_demand']=dict(rating='load-current')
        self.save();report=self.check();self.assertEqual(report['status'],'passed',report['blockers'])
        rail=next(row for row in report['assertions'] if row['id']=='RAIL')
        self.assertEqual([row['rating'] for row in rail['reviewed_demand_bindings']],['load-current','load-current'])

    def test_native_export_only_adapter_has_explicit_narrow_scope_without_pdf_checks(self):
        import schematic_contract_smoke as smoke
        artifacts=self.root/'export-only'
        with mock.patch.object(part_evidence,'pdf_pages',side_effect=AssertionError('PDF not required')):
            report=smoke.export_observation(self.schematic,artifacts)
        self.assertEqual(report['status'],'observed');self.assertFalse(report['qualified'])
        self.assertEqual(contract.number(report['actual_nominal']['value']),Decimal('0.000001'))
        self.assertIn('no reviewed-part or functional-contract verdict',report['scope'])

    def test_native_proof_junit_never_hides_unexecuted_or_integrity_failed_cases(self):
        import schematic_contract_smoke as smoke
        result=dict(export_only=True,status='failed',scope='native export only',cases=[],cause='missing native exporter',elapsed_s=.1)
        smoke.write_junit(self.root,result);suite=ET.parse(self.root/'junit.xml').getroot()
        self.assertEqual(suite.attrib['failures'],'2');self.assertEqual(suite.attrib['skipped'],'0')
        result['cases']=[dict(case=name,status='passed') for name in ('actual_native_export_is_parsed','actual_wrong_native_value_is_detected')]
        smoke.write_junit(self.root,result);suite=ET.parse(self.root/'junit.xml').getroot()
        self.assertEqual(suite.attrib['failures'],'1')

    def test_cli_output_writes_full_report_and_prints_only_bound_pointer(self):
        output=self.root/'terminal-report.json'
        report=dict(schema=contract.RESULT,status='passed',board=self.board,qualified=False,blockers=[],inputs={'source':'x'*100000})
        arguments=['check',self.board,'--root',str(self.root),'--contract',str(self.path),'--json']
        with mock.patch.object(contract,'check_contract',return_value=report),mock.patch('sys.stdout',new_callable=io.StringIO) as stream:
            self.assertEqual(contract.main(arguments+['--output',str(output)]),0)
            terminal=json.loads(stream.getvalue())
        self.assertLess(len(json.dumps(terminal)),1000)
        self.assertEqual(terminal['report'],dict(path=str(output),sha256=contract.sha(output)))
        self.assertEqual(json.loads(output.read_text()),report)
        with mock.patch.object(contract,'check_contract',return_value=report),mock.patch('sys.stdout',new_callable=io.StringIO) as stream:
            self.assertEqual(contract.main(arguments),0)
            self.assertEqual(json.loads(stream.getvalue()),report)

    def test_no_implicit_tolerance_wrong_dimension_boolean_or_nonfinite(self):
        expected=self.value['assertions'][0]['expected']
        for changes in (dict(unit='W'),dict(min=True),dict(max=float('inf')),dict(min='1')):
            original=copy.deepcopy(expected);expected.update(changes);self.save()
            report=self.check();self.assertEqual(report['status'],'blocked',changes)
            expected.clear();expected.update(original)

    def test_stale_review_source_and_unknown_requirement_fail_before_export(self):
        self.value['assertions'][0]['mpn']='WRONG';self.save(review=False)
        self.assertEqual(self.check()['status'],'blocked');self.export.assert_not_called()
        self.value['assertions'][0]['requirement']='NOT-A-REQUIREMENT';self.save()
        self.assertEqual(self.check()['status'],'blocked');self.export.assert_not_called()

    def test_variant_absence_is_bound_and_unknown_overrides_fail_closed(self):
        (self.folder/'variants.json').write_text('{}')
        self.assertEqual(self.check()['status'],'blocked');self.export.assert_not_called()
        (self.folder/'variants.json').unlink();self.value['assertions'][0]['tolerance']=.5;self.save()
        self.assertEqual(self.check()['status'],'blocked')

    def test_export_side_source_mutation_is_detected_before_any_pass(self):
        original=self.fixture_export
        def changed(*args):
            result=original(*args);self.schematic.write_text(self.schematic.read_text()+'\n');return result
        self.export.side_effect=changed
        report=self.check();self.assertEqual(report['status'],'blocked')
        self.assertIn('changed during verification',report['blockers'][-1]['detail'])

    def test_dependency_closure_and_assertion_order_are_deterministic(self):
        self.value['assertions'].reverse();self.save()
        self.assertEqual(self.check()['status'],'passed')
        files=contract.dependency_files(self.root,self.path)
        for path in (self.design_path,self.part_manifest,self.spec,self.schematic,self.pcb):
            self.assertIn(path.relative_to(self.root).as_posix(),files)
        self.assertIn('hardware-design/registry/datasheets/SYNTHETIC-TP.pdf',files)

    def test_named_design_numeric_acceptance_cannot_be_relaxed_by_local_assertion(self):
        design=json.loads(self.design_path.read_text())
        design['requirements'][0]['acceptance']=dict(kind='interval',**self.interval(0,100,'nF'))
        self.design_path.write_text(json.dumps(design));self.value['design_contract']=self.bound(self.design_path);self.save()
        report=self.check()
        self.assertEqual(report['requirement_results']['REQ-VALUE']['status'],'blocked')
        self.assertTrue(any('named design requirement' in row.get('cause','') for row in report['assertions']))

    def test_numeric_requirement_cannot_be_satisfied_by_an_unrelated_mode(self):
        design=json.loads(self.design_path.read_text())
        design['requirements'][3]['acceptance']=dict(kind='interval',**self.interval(0,1,'A'))
        self.design_path.write_text(json.dumps(design));self.value['design_contract']=self.bound(self.design_path);self.save()
        report=self.check();self.assertEqual(report['requirement_results']['REQ-MODE']['status'],'blocked')

    def test_wrong_design_board_and_invalid_original_pdf_page_fail_closed(self):
        design=json.loads(self.design_path.read_text());design['identity']['board']='OTHER'
        self.design_path.write_text(json.dumps(design));self.value['design_contract']=self.bound(self.design_path);self.save()
        self.assertEqual(self.check()['status'],'blocked');self.export.assert_not_called()
        design['identity']['board']=self.board;self.design_path.write_text(json.dumps(design))
        self.value['design_contract']=self.bound(self.design_path)
        pdf=self.root/'hardware-design/registry/datasheets/SYNTHETIC-TP.pdf'
        self.value['assertions'][0]['expected']['source']=dict(path=pdf.relative_to(self.root).as_posix(),sha256=contract.sha(pdf),page=2)
        self.save();self.assertEqual(self.check()['status'],'blocked')


def make_functional_fixture(root):
    """Build synthetic inputs with the native exporter and PDF boundary unmocked."""
    fixture=SchematicContractTests()
    fixture.setUp(fixture_root=root,mock_export=False)
    return dict(board=fixture.board,contract=fixture.path,design_contract=fixture.design_path,
                part_review=fixture.part_manifest,schematic=fixture.schematic,pcb=fixture.pcb)


class FixtureBoundaryTests(unittest.TestCase):
    def test_native_proof_builder_installs_no_export_or_pdf_page_count_stubs(self):
        with tempfile.TemporaryDirectory() as folder:
            # Fail before any replacement starts if the native builder enters
            # the CPU-only branch, including a future accidental PDF stub.
            with mock.patch.object(mock.patch,'object',side_effect=AssertionError('native proof must not patch a boundary')):
                fixture=make_functional_fixture(Path(folder)/'native-source')
            self.assertTrue(fixture['schematic'].is_file())
            self.assertTrue(fixture['part_review'].is_file())


if __name__=='__main__':unittest.main()
