import copy
from decimal import Decimal
import hashlib
import json
from pathlib import Path
import tempfile
import unittest

import route_hole_coverage as coverage


def native():
    return '''(kicad_pcb (version 20260101)
      (layers (0 "F.Cu" signal) (31 "B.Cu" signal))
      (footprint "TERM" (layer "F.Cu") (at 100 100 0)
        (property "Reference" "J1")
        (pad "1" thru_hole circle (at -1.75 0) (size 2.1 2.1)
          (drill 1.399997) (layers "*.Cu" "*.Mask") (net "/POWER")))
      (footprint "TERM" (layer "F.Cu") (at 110 100 180)
        (property "Reference" "J2")
        (pad "1" thru_hole circle (at -1.75 0 180) (size 2.1 2.1)
          (drill 1.399997) (layers "*.Cu" "*.Mask") (net "/POWER")))
      (footprint "MOUNT" (layer "F.Cu") (at 120 100)
        (property "Reference" "H1")
        (pad "" np_thru_hole circle (at 0 0) (size 3.2 3.2)
          (drill 3.2) (layers "*.Cu" "*.Mask"))))'''


def dsn():
    # Real KiCad10 export syntax, with only the irrelevant outlines omitted.
    return '''(pcb "fixture"
      (parser (string_quote ")) (resolution um 10) (unit um)
      (structure (layer F.Cu (type signal)) (layer B.Cu (type power)))
      (placement (component "TERM"
        (place J1 100000 -100000 front 0 (PN connector))
        (place J2 110000 -100000 front 180 (PN connector))))
      (library (image "TERM" (pin Round[A]Pad_2100.000000_um 1 -1750 0))
        (padstack Round[A]Pad_2100.000000_um
          (shape (circle F.Cu 2100)) (shape (circle B.Cu 2100)) (attach off)))
      (network (net /POWER (pins J1-1 J2-1)) (net /LED_A (pins R2-2 D3-1))))'''


class HoleCoverageTests(unittest.TestCase):
    def setUp(self):
        temp=tempfile.TemporaryDirectory();self.addCleanup(temp.cleanup)
        self.path=Path(temp.name)/'fixture.kicad_pcb';self.path.write_text(native())
        self.pads=coverage.native_pth_pads(self.path)

    def check(self,model=None,pads=None,**options):
        return coverage.inspect(dsn() if model is None else model,
            pads=self.pads if pads is None else pads,active_nets=options.pop('active_nets',['/LED_A']),
            layers=options.pop('layers',['F.Cu']),required_mm=options.pop('required_mm','0.28'),
            clearance_floor_mm=options.pop('clearance_floor_mm','0.2'),**options)

    def blocked(self,result):
        self.assertEqual(result['status'],'blocked',result)
        self.assertTrue(result['cause']);self.assertFalse(result['qualified'])

    def test_native_collector_keeps_every_pth_and_exact_rotated_geometry(self):
        self.assertEqual(len(self.pads),2)
        self.assertEqual([(p['reference'],p['pad']) for p in self.pads],[('J1','1'),('J2','1')])
        self.assertEqual(self.pads[0]['position_mm'],['98.25','100'])
        self.assertEqual(self.pads[1]['position_mm'],['111.75','100'])
        self.assertEqual(self.pads[0]['drill_mm'],['1.399997']*2)
        self.assertEqual(self.pads[0]['layers'],['F.Cu','B.Cu'])

    def test_actual_circular_obstacles_contain_expanded_other_net_drills(self):
        result=self.check()
        self.assertEqual(result['status'],'covered',result)
        self.assertFalse(result['qualified']);self.assertEqual(len(result['covered_pads']),2)
        self.assertEqual(result['covered_pads'][0]['native_drill_radius_mm'],'0.6999985')
        self.assertEqual(result['covered_pads'][0]['containment_slack_radius_mm'],'0.0700015')

    def test_containment_uses_squared_displacement_without_rounding(self):
        pads=copy.deepcopy(self.pads[:1])
        pads[0]['drill_mm']=['1.4']*2
        model=dsn().replace('1 -1750 0','1 -1708 -56')
        # 0.042**2+0.056**2 == 0.07**2, exactly tangent.
        self.assertEqual(self.check(model,pads,clearance_floor_mm='0')['status'],'covered')
        self.blocked(self.check(model.replace('-1708 -56','-1707.999999 -56'),pads,clearance_floor_mm='0'))
        self.blocked(self.check(dsn().replace('(circle F.Cu 2100)','(circle F.Cu 1900)'),pads,
            clearance_floor_mm='0'))

    def test_only_verified_floor_is_credited_with_exact_boundary(self):
        pads=copy.deepcopy(self.pads[:1]);pads[0]['size_mm']=['0.6']*2;pads[0]['drill_mm']=['0.3']*2
        model=dsn().replace('(circle F.Cu 2100)','(circle F.Cu 600)')
        result=self.check(model,pads,clearance_floor_mm='0.13')
        self.assertEqual(result['status'],'covered',result)
        proof=result['covered_pads'][0]
        self.assertEqual(Decimal(proof['containment_slack_radius_mm']),Decimal('-0.13'))
        self.assertEqual(proof['credited_clearance_mm'],'0.13')
        self.assertEqual(Decimal(proof['effective_containment_slack_mm']),0)
        self.blocked(self.check(model,pads,clearance_floor_mm='0.129999999999'))

    def test_six_repeated_physical_drills_bind_actual_export_aliases_not_one_pad_number(self):
        # Actual KiCad10 CELLULAR/PWR export pattern: six thermal PTHs and
        # intervening SMD EP share number9; the EP consumes the @3 suffix.
        pads=[];pins=[];members=[]
        coordinates=[(-1.3,-.65),(-1.3,.65),(0,-.65),(0,0),(0,.65),(1.3,-.65),(1.3,.65)]
        for index,(x,y) in enumerate(coordinates):
            smd=index==3;name='9'+('@'+str(index) if index else '')
            geometry='smd rect' if smd else 'thru_hole circle'
            size='3.1 2.4' if smd else '0.6 0.6'
            drill='' if smd else '(drill 0.3)'
            pads.append(f'(pad "9" {geometry} (at {x} {y} 180) (size {size}) {drill} (layers "*.Cu") (net "GND") (uuid "physical-{index}"))')
            pins.append(f'(pin Round[A]Pad_600_um {name} {x*1000:g} {-y*1000:g})')
            members.append('U1-'+name)
        self.path.write_text('(kicad_pcb (layers (0 "F.Cu" signal) (31 "B.Cu" signal)) '
            '(footprint "EP" (layer "F.Cu") (at 100 100 180) (property "Reference" "U1") '+''.join(pads)+'))')
        native_pads=coverage.native_pth_pads(self.path)
        self.assertEqual(len(native_pads),6)
        self.assertEqual(len({p['identity'] for p in native_pads}),6)
        self.assertEqual([p['export_pin'] for p in native_pads],['9','9@1','9@2','9@4','9@5','9@6'])
        model='''(pcb fixture (resolution um 10) (unit um)
          (structure (layer F.Cu (type signal)) (layer B.Cu (type power)))
          (placement (component EP (place U1 100000 -100000 front 180)))
          (library (image EP '''+''.join(pins)+''')
          (padstack Round[A]Pad_600_um (shape (circle F.Cu 600))))
          (network (net GND (pins '''+' '.join(members)+''')) (net /LED_A (pins D1-1 R1-1))))'''
        result=self.check(model,native_pads)
        self.assertEqual(result['status'],'covered',result)
        self.assertEqual(len(result['covered_pads']),6)
        self.assertEqual(len({p['dsn_pin'] for p in result['covered_pads']}),6)
        for changed in (model.replace('U1-9@5','U1-MISSING'),
                model.replace('9@5 1300 650','9@5 1301 650'),
                model.replace('9@5 1300 650','9@5 -1300 650')):
            self.blocked(self.check(changed,native_pads))
        forged=copy.deepcopy(native_pads);forged[1]['identity']=forged[0]['identity']
        self.blocked(self.check(model,forged))
        forged=copy.deepcopy(native_pads);forged[1]['export_pin']=forged[0]['export_pin']
        self.blocked(self.check(model,forged))
        legacy=[{k:v for k,v in p.items() if k not in coverage.PHYSICAL_FIELDS} for p in native_pads]
        self.blocked(self.check(model,legacy))

    def test_true_rectangle_uses_composed_rotation_and_exact_inscribed_disk(self):
        self.path.write_text(native().replace('(at 100 100 0)','(at 100 100 90)',1)
            .replace('thru_hole circle (at -1.75 0) (size 2.1 2.1)',
                     'thru_hole rect (at -1.75 0 180) (size 3 2)',1))
        pads=coverage.native_pth_pads(self.path)[:1]
        self.assertEqual(pads[0]['position_mm'],['100','101.75'])
        model=dsn().replace('front 0','front 90',1).replace(
            '(pin Round[A]Pad_2100.000000_um 1 -1750 0)',
            '(pin Round[A]Pad_2100.000000_um (rotate 90) 1 -1750 0)').replace(
            '(circle F.Cu 2100)','(rect F.Cu -1500 -1000 1500 1000)')
        result=self.check(model,pads)
        self.assertEqual(result['status'],'covered',result)
        self.assertEqual(result['covered_pads'][0]['dsn_rotation_deg'],180)
        self.blocked(self.check(model.replace('(rotate 90)','(rotate 0)'),pads))
        self.blocked(self.check(model.replace('-1500 -1000 1500 1000','-1499 -1000 1500 1000'),pads))
        pads[0]['size_mm']=['1.6','2'];pads[0]['drill_mm']=['1.2']*2
        model=model.replace('-1500 -1000 1500 1000','-800 -1000 800 1000')
        self.assertEqual(self.check(model,pads,clearance_floor_mm='0.08')['status'],'covered')
        self.blocked(self.check(model,pads,clearance_floor_mm='0.079999999999'))
        self.path.write_text(native().replace('thru_hole circle (at -1.75 0) (size 2.1 2.1)',
            'thru_hole rect (at -1.75 0) (size 2.1 2.1) (chamfer_ratio 0.2)',1))
        with self.assertRaises(ValueError):coverage.native_pth_pads(self.path)

    def test_empty_missing_same_net_and_invalid_clearance_are_not_proofs(self):
        for pads in ([],None):
            self.blocked(coverage.inspect(dsn(),pads=pads,active_nets=['/LED_A'],layers=['F.Cu'],
                required_mm='0.28',clearance_floor_mm='0.2'))
        self.blocked(self.check(active_nets=['/POWER']))
        for field in ('required_mm','clearance_floor_mm'):
            for value in ('nan','Infinity','-0.001',True):
                with self.subTest(field=field,value=value):self.blocked(self.check(**{field:value}))

    def test_native_slots_offsets_custom_and_mirrored_pth_fail_instead_of_disappearing(self):
        variants=(native().replace('(drill 1.399997)','(drill oval 1.399997 1.8)',1),
            native().replace('(drill 1.399997)','(drill 1.399997 (offset 0.1 0))',1),
            native().replace('thru_hole circle','thru_hole oval',1),
            native().replace('(size 2.1 2.1)','(size 2.1 2.1) (offset 0.1 0)',1),
            native().replace('(layer "F.Cu")','(layer "B.Cu")',1),
            native().replace('(at 100 100 0)','(at 100 100 45)',1),
            native().replace('thru_hole circle','unknown_hole circle',1))
        for text in variants:
            with self.subTest(native=text):
                self.path.write_text(text)
                with self.assertRaises(ValueError):coverage.native_pth_pads(self.path)

    def test_physical_ids_and_numbered_aliases_cannot_hide_conflicting_native_membership(self):
        duplicate='''(pad "1" thru_hole circle (at 1.75 0) (size 2.1 2.1)
          (drill 1.399997) (layers "*.Cu") (net "/WRONG") (uuid "other"))'''
        self.path.write_text(native().replace('(property "Reference" "J1")',
            '(property "Reference" "J1") '+duplicate,1))
        with self.assertRaises(ValueError):coverage.native_pth_pads(self.path)
        pads=copy.deepcopy(self.pads)
        pads[0]['rotation_deg']='45'
        self.blocked(self.check(pads=pads))
        pads=copy.deepcopy(self.pads);pads[0]['layers'].append('Unknown.Cu')
        self.blocked(self.check(pads=pads))
        pads=copy.deepcopy(self.pads);pads[0]['export_pin']='1@0'
        self.blocked(self.check(pads=pads))

    def test_legacy_unique_circular_source_rows_remain_usable_without_physical_aliases(self):
        pads=[{k:v for k,v in p.items() if k not in coverage.PHYSICAL_FIELDS} for p in self.pads]
        result=self.check(pads=pads,clearance_floor_mm='0')
        self.assertEqual(result['status'],'covered',result)
        self.assertEqual(len(result['covered_pads']),2)

    def test_model_identity_pose_mirror_membership_and_duplicates_fail_closed(self):
        variants=(dsn().replace('(place J1','(place J9',1),
            dsn().replace('J1 100000','J1 100001',1),
            dsn().replace('front 0','front 90',1),dsn().replace('front 0','back 0',1),
            dsn().replace('(pins J1-1 J2-1)','(pins J2-1)'),
            dsn().replace('(net /LED_A (pins R2-2 D3-1))','(net /LED_A (pins R2-2 D3-1 J1-1))'),
            dsn().replace('(pin Round[A]Pad_2100.000000_um 1 -1750 0)',
                '(pin Round[A]Pad_2100.000000_um 1 -1750 0) (pin Round[A]Pad_2100.000000_um 1 0 0)'),
            dsn().replace('(place J1 100000','(place J1 100000 -100000 front 0) (place J1 100000',1))
        for model in variants:
            with self.subTest(model=model):self.blocked(self.check(model))

    def test_only_declared_single_layer_circle_with_exact_unambiguous_units_can_cover(self):
        variants=(dsn().replace('(unit um)','(unit cm)'),dsn().replace('(unit um)','(unit um) (unit mm)'),
            dsn().replace('(type power)','(type signal)'),
            dsn().replace('(circle F.Cu 2100)','(circle B.Cu 2100)'),
            dsn().replace('(circle F.Cu 2100)','(rect F.Cu -1050 -1050 1050 1050)'),
            dsn().replace('(circle F.Cu 2100)','(circle F.Cu 2100 1 0)'),
            dsn().replace('(shape (circle F.Cu 2100))','(shape (circle F.Cu 2100)) (shape (circle F.Cu 2100))'),
            dsn().replace('(circle F.Cu 2100)','(circle F.Cu nan)'),dsn()[:-1])
        for model in variants:
            with self.subTest(model=model):self.blocked(self.check(model))
        self.blocked(self.check(layers=['F.Cu','B.Cu']))

    def test_importer_resolution_units_cannot_disagree_with_the_geometry_interpretation(self):
        # The backend reads its effective unit from resolution, ignoring the
        # separate unit declaration. Contradictory scopes must never cover.
        for replacement in ('(resolution mm 10)','(resolution unknown 10)','',
                '(resolution um 10) (resolution um 10)','(resolution um 0)',
                '(resolution um -1)','(resolution um 1.5)','(resolution um 2147483648)'):
            with self.subTest(resolution=replacement):
                self.blocked(self.check(dsn().replace('(resolution um 10)',replacement)))

    def test_importer_name_aliases_cannot_hide_different_actual_pad_geometry(self):
        model=dsn().replace('(attach off)))','(attach off)) (padstack Round[A]Pad_2100.123_um (shape (circle F.Cu 100))))')
        self.blocked(self.check(model))
        model=dsn().replace('(library (image "TERM"','(library (image "TERM::1" (pin Round[A]Pad_2100.000000_um 1 0 0)) (image "TERM"')
        self.blocked(self.check(model))
        model=dsn().replace('(library ',
            '(library (padstack round[a]pad_2100.000000_um (shape (circle F.Cu 100))) ',1)
        self.blocked(self.check(model))


class DrilledCoverageTests(unittest.TestCase):
    """Native circle/oval + real exporter pin, keepout and via descriptors."""
    def setUp(self):
        temp=tempfile.TemporaryDirectory();self.addCleanup(temp.cleanup)
        self.path=Path(temp.name)/'fixture.kicad_pcb'
        extra='''(footprint "USB" (layer "F.Cu") (at 130 100 90)
          (property "Reference" "J3")
          (pad "7" thru_hole rect (at 1 2 180) (size 1.1 1.9)
            (drill oval 0.6 1.3) (layers "*.Cu") (net "GND") (uuid slot1))
          (pad "7" thru_hole rect (at -1 2 180) (size 1.1 1.9)
            (drill oval 0.6 1.3) (layers "*.Cu") (net "GND") (uuid slot2)))
          (via (at 140 100) (size 0.6) (drill 0.3)
            (layers "F.Cu" "B.Cu") (net "GND") (uuid via1))'''
        self.native=native()[:-1]+extra+')';self.path.write_text(self.native)
        self.model=dsn().replace('''(place J2 110000 -100000 front 180 (PN connector))))''',
            '''(place J2 110000 -100000 front 180 (PN connector)))
              (component MOUNT (place H1 120000 -100000 front 0))
              (component USB (place J3 130000 -100000 front 90)))''').replace(
            '(library (image "TERM"', '''(library
              (image MOUNT (keepout "" (circle F.Cu 3760)))
              (image USB (pin OVAL (rotate 90) 7 1000 -2000)
                (pin OVAL (rotate 90) 7@1 -1000 -2000))
              (padstack OVAL (shape (rect F.Cu -550 -950 550 950)))
              (padstack "Via[0-1]_600:300_um" (shape (circle F.Cu 600))
                (shape (circle B.Cu 600)))
              (image "TERM"''').replace(
            '(network (net /POWER', '(network (net GND (pins J3-7 J3-7@1)) (net /POWER')
        self.model=self.model[:-1]+'''(wiring
          (via "Via[0-1]_600:300_um" 140000 -100000 (net GND) (type fix))))'''
        self.model=self.model.replace('(structure ',
            '(structure (boundary (path pcb 0 0 0 200000 0 200000 -200000 0 -200000 0 0)) ',1)
        self.holes=coverage.native_drilled_geometry(self.path)
        # Protocol fixtures exercise the real binder and actual file hashes;
        # these bytes do not claim a native-tested production executable.
        import backend_quality
        self.binary=self.path.parent/'backend';self.binary.write_bytes(b'unit fixture binary')
        self.native_evidence=self.path.parent/'native-evidence.json';self.native_evidence.write_bytes(b'{"fixture":true}')
        digest=lambda p:hashlib.sha256(p.read_bytes()).hexdigest()
        manifest=dict(schema=1,upstream_commit=backend_quality.UPSTREAM,
            cargo_lock_sha256=backend_quality.LOCK,patch_sha256=digest(backend_quality.PATCH),
            binary_sha256=digest(self.binary),native_validation=dict(status='passed',
                evidence=[dict(path=str(self.native_evidence),sha256=digest(self.native_evidence))]))
        self.manifest=self.path.parent/'backend-manifest.json';self.manifest.write_text(json.dumps(manifest))
        self.policy=backend_quality.bind(self.binary,self.manifest)
        self.command=[str(self.binary),'--quality-first']

    def check(self,model=None,holes=None,**options):
        return coverage.inspect_drilled(self.model if model is None else model,
            holes=self.holes if holes is None else holes,active_nets=options.pop('active_nets',['/LED_A']),
            layers=options.pop('layers',['F.Cu']),required_mm=options.pop('required_mm','0.28'),
            clearance_floor_mm=options.pop('clearance_floor_mm','0.2'),
            backend_command=options.pop('backend_command',self.command),
            backend_policy=options.pop('backend_policy',self.policy),**options)

    def blocked(self,result):
        self.assertEqual(result['status'],'blocked',result)
        self.assertFalse(result['qualified']);self.assertTrue(result['cause'])

    def test_complete_inventory_keeps_pth_npth_slots_and_retained_via(self):
        self.assertEqual(len(self.holes),6)
        self.assertTrue(all(h['supported'] for h in self.holes),self.holes)
        self.assertEqual([h['kind'] for h in self.holes],['pth','pth','npth','pth','pth','via'])
        slots=[h for h in self.holes if h.get('reference')=='J3']
        self.assertEqual([h['export_pin'] for h in slots],['7','7@1'])
        self.assertEqual([h['position_mm'] for h in slots],[['132','99'],['132','101']])
        self.assertEqual(slots[0]['rotation_deg'],'180')
        self.assertEqual(slots[0]['drill_mm'],['0.6','1.3'])
        result=self.check();self.assertEqual(result['status'],'covered',result)
        self.assertEqual(result['native_hole_count'],6)
        self.assertEqual(len({h['identity'] for h in result['covered_holes']}),6)
        npth=next(h for h in result['covered_holes'] if h['kind']=='npth')
        self.assertEqual(npth['credited_clearance_mm'],'0')

    def test_slot_capsule_and_rectangle_proofs_use_exact_boundary_and_rotation(self):
        slots=[h for h in self.holes if h.get('reference')=='J3']
        # Remove instantiated via so this test isolates slot containment.
        model=self.model[:self.model.index('(wiring')]+')'
        result=self.check(model,slots,clearance_floor_mm='0.03')
        self.assertEqual(result['status'],'covered',result)
        self.blocked(self.check(model,slots,clearance_floor_mm='0.029999999999999'))
        self.blocked(self.check(model.replace('(rotate 90)','(rotate 0)'),slots))
        self.blocked(self.check(model.replace('-550 -950 550 950','-549 -950 550 950'),slots))
        self.blocked(self.check(model.replace('7@1 -1000 -2000','7@1 -1001 -2000'),slots))
        self.blocked(self.check(model.replace('J3-7@1','J3-wrong'),slots))
        self.path.write_text(self.native.replace('(size 1.1 1.9)','(size 1.2 2)',2).replace('thru_hole oval','thru_hole rect',2))
        rects=[h for h in coverage.native_drilled_geometry(self.path) if h.get('reference')=='J3']
        rect_model=model.replace('(rect F.Cu -550 -950 550 950)','(rect F.Cu -600 -1000 600 1000)')
        self.assertEqual(self.check(rect_model,rects,clearance_floor_mm='0')['status'],'covered')
        self.blocked(self.check(rect_model,rects,required_mm='0.300000000001',clearance_floor_mm='0'))

    def test_npth_requires_actual_wire_keepout_without_pin_clearance_credit(self):
        npth=next(h for h in self.holes if h['kind']=='npth')
        self.assertEqual(npth['net'],'')
        self.blocked(self.check(self.model.replace('(circle F.Cu 3760)','(circle F.Cu 3759.999999999)'),
            clearance_floor_mm='100'))
        self.blocked(self.check(self.model.replace('(keepout ""','(via_keepout ""')))
        self.blocked(self.check(self.model.replace('(circle F.Cu 3760)','(circle F.Cu 3760 1 0)')))
        self.blocked(self.check(self.model.replace('(keepout "" (circle F.Cu 3760))','')))
        self.assertEqual(self.check(self.model.replace('(keepout ""','(wire_keepout ""'))['status'],'covered')

    def test_oval_ideal_capsule_never_claims_actual_integer_backend_coverage(self):
        self.path.write_text(self.native.replace('(pad "7" thru_hole rect','(pad "7" thru_hole oval'))
        holes=coverage.native_drilled_geometry(self.path)
        self.assertTrue(all(h['supported'] for h in holes))
        model=self.model.replace('(rect F.Cu -550 -950 550 950)','(path F.Cu 1100 0 -400 0 400)')
        result=self.check(model,holes)
        self.blocked(result);self.assertIn('integer-octagon',result['cause'])

    def test_exact_grid_and_actual_policy_bindings_are_required_for_positive_geometry(self):
        good=self.check();self.assertEqual(good['status'],'covered',good)
        self.assertIn(str(self.binary),good['inputs']);self.assertIn(str(self.manifest.resolve()),good['inputs'])
        self.assertIn(str(self.native_evidence),good['inputs'])
        for policy in (None,{'mode':'legacy-unverified'},dict(self.policy,binary_sha256='0'*64)):
            self.blocked(self.check(backend_policy=policy))
        self.blocked(self.check(backend_command=[str(self.binary)]))
        self.blocked(self.check(clearance_floor_mm='0.200000001'))
        self.blocked(self.check(self.model.replace('(circle F.Cu 3760)','(circle F.Cu 3760.000001)')))
        self.path.write_text(self.native.replace('(via (at 140 100)','(via (at 140.000001 100)'))
        holes=coverage.native_drilled_geometry(self.path)
        self.blocked(self.check(self.model.replace('140000 -100000 (net GND)','140000.001 -100000 (net GND)'),holes))
        self.blocked(self.check(self.model.replace('200000','700000')))
        self.binary.write_bytes(b'changed binary');self.blocked(self.check())
        self.binary.write_bytes(b'unit fixture binary')
        self.native_evidence.write_bytes(b'changed native evidence');self.blocked(self.check())

    def test_npth_offset_position_uses_footprint_transform_and_multiplicity(self):
        self.path.write_text(self.native.replace('(at 120 100)','(at 120 100 90)').replace(
            'np_thru_hole circle (at 0 0)','np_thru_hole circle (at 1 2)'))
        holes=coverage.native_drilled_geometry(self.path)
        npth=next(h for h in holes if h['kind']=='npth')
        self.assertEqual(npth['position_mm'],['122','99'])
        model=self.model.replace('H1 120000 -100000 front 0','H1 120000 -100000 front 90').replace(
            '(circle F.Cu 3760)','(circle F.Cu 3760 1000 -2000)')
        self.assertEqual(self.check(model,holes)['status'],'covered')
        self.blocked(self.check(model.replace('3760 1000 -2000','3760 1000 2000'),holes))

    def test_via_requires_exact_fixed_physical_instance_net_and_copper(self):
        for old,new in (
                ('140000 -100000 (net GND)','140001 -100000 (net GND)'),
                ('140000 -100000 (net GND)','140000 -100000 (net /POWER)'),
                ('(type fix)','(type route)'),
                ('(circle F.Cu 600)','(circle F.Cu 601)'),
                ('(via "Via[0-1]_600:300_um" 140000 -100000 (net GND) (type fix))','')):
            with self.subTest(change=new):self.blocked(self.check(self.model.replace(old,new)))
        via=[h for h in self.holes if h['kind']=='via']
        model=self.model
        # Pin/NPTH obstacles may remain; every instantiated via must be bound.
        self.assertEqual(self.check(model,via,clearance_floor_mm='0.13')['status'],'covered')
        self.blocked(self.check(model,via,clearance_floor_mm='0.129999999999'))
        self.blocked(self.check(model,[],clearance_floor_mm='0.2'))

    def test_unknown_native_drills_are_retained_and_block_instead_of_vanishing(self):
        variants=(self.native.replace('(drill 3.2)','(drill oval 3.2 3.4)'),
            self.native.replace('(drill oval 0.6 1.3)','(drill oval 0.6 1.3 (offset 0.1 0))',1),
            self.native.replace('(layer "F.Cu") (at 130','(layer "B.Cu") (at 130'),
            self.native.replace('(via (at','(via blind (at'),
            self.native.replace('(size 0.6) (drill 0.3)','(size 0.6) (drill 0.3) (padstack custom)'),
            self.native.replace('(drill oval 0.6 1.3)','',1))
        for text in variants:
            with self.subTest(native=text):
                self.path.write_text(text);holes=coverage.native_drilled_geometry(self.path)
                self.assertEqual(len(holes),6)
                self.assertTrue(any(not h['supported'] for h in holes),holes)
                self.blocked(self.check(holes=holes))

    def test_same_net_holes_and_ambiguous_multiplicity_never_get_obstacle_credit(self):
        self.blocked(self.check(active_nets=['/LED_A','GND']))
        self.blocked(self.check(active_nets=['/LED_A','/POWER']))
        holes=copy.deepcopy(self.holes);holes[-1]['identity']=holes[0]['identity'];self.blocked(self.check(holes=holes))
        holes=copy.deepcopy(self.holes);holes[-1]['supported']=1;self.blocked(self.check(holes=holes))
        duplicate='(via "Via[0-1]_600:300_um" 140000 -100000 (net GND) (type fix))'
        self.blocked(self.check(self.model.replace(duplicate,duplicate+duplicate)))
        self.blocked(self.check(self.model.replace('(keepout "" (circle F.Cu 3760))',
            '(keepout "" (circle F.Cu 3760)) (keepout "" (circle F.Cu 3760))')))

    def test_project_native_same_net_scope_still_binds_all_instances_and_never_exempts_npth(self):
        result=self.check(active_nets=['GND'],clearance_floor_mm='0',applicability='kicad10_project_track')
        self.assertEqual(result['status'],'covered',result)
        self.assertEqual(len(result['covered_holes']),6)
        excluded=[r for r in result['covered_holes'] if r['disposition']=='native_not_applicable']
        self.assertEqual({r['identity'] for r in excluded},{'slot1','slot2','via1'})
        self.assertTrue(all(r['credited_clearance_mm']=='0' and r['applicability_source'] for r in excluded))
        self.blocked(self.check(self.model.replace('140000 -100000 (net GND)','140001 -100000 (net GND)'),
            active_nets=['GND'],applicability='kicad10_project_track'))
        self.blocked(self.check(self.model.replace('(circle F.Cu 3760)','(circle F.Cu 3200)'),
            active_nets=['GND'],applicability='kicad10_project_track'))
        self.blocked(self.check(active_nets=['GND','/LED_A'],applicability='kicad10_project_track'))
        self.blocked(self.check(applicability='assume_exempt'))

    def test_custom_pth_minimum_does_not_expand_npth_or_via_requirement(self):
        # The .36 custom PTH minimum fits every plated pad, but exceeds the
        # NPTH's .28 keepout margin and the via's .35 copper+clearance margin.
        self.blocked(self.check(required_mm='.36'))
        result=self.check(required_mm='.36',applicability='custom_pth_track')
        self.assertEqual(result['status'],'covered',result)
        self.assertEqual(result['native_hole_count'],6)
        for row in result['covered_holes']:
            if row['kind']=='pth':
                self.assertEqual(row['disposition'],'covered')
                self.assertEqual(row['required_mm'],'0.36')
            else:
                self.assertEqual(row['disposition'],'custom_not_applicable')
                self.assertEqual(row['required_mm'],'0')
                self.assertEqual(row['credited_clearance_mm'],'0')
        # Project applicability is separate: NPTH keeps the actual project
        # minimum, and cannot inherit the custom PTH scope's exclusion.
        self.blocked(self.check(required_mm='.36',applicability='kicad10_project_track'))
        self.blocked(self.check(required_mm='.4500000000001',applicability='custom_pth_track'))

    def test_custom_non_pth_exclusion_keeps_every_physical_binding_and_backend_proof(self):
        options=dict(required_mm='.36',applicability='custom_pth_track')
        via='(via "Via[0-1]_600:300_um" 140000 -100000 (net GND) (type fix))'
        for old,new in (
                ('(keepout "" (circle F.Cu 3760))',''),
                ('(circle F.Cu 3760)','(circle F.Cu 3199)'),
                ('(circle F.Cu 3760)','(circle F.Cu 3760 1 0)'),
                ('(circle F.Cu 3760)','(circle F.Cu 3760.000001)'),
                ('140000 -100000 (net GND)','140001 -100000 (net GND)'),
                ('(circle F.Cu 600)','(circle F.Cu 601)'),
                (via,''), (via,via+via)):
            with self.subTest(change=new):
                self.blocked(self.check(self.model.replace(old,new),**options))
        self.blocked(self.check(holes=self.holes[:-1],**options))
        holes=copy.deepcopy(self.holes);holes[-1]['identity']=holes[0]['identity']
        self.blocked(self.check(holes=holes,**options))
        holes=copy.deepcopy(self.holes);holes[2]['supported']=False;holes[2]['cause']='unknown NPTH'
        self.blocked(self.check(holes=holes,**options))
        self.blocked(self.check(backend_policy=None,**options))

    def test_custom_pth_same_net_remains_blocked_but_non_pth_via_stays_bound(self):
        self.blocked(self.check(active_nets=['/POWER'],applicability='custom_pth_track'))
        self.blocked(self.check(active_nets=['GND'],applicability='custom_pth_track'))
        self.path.write_text(self.native.replace(
            '(layers "F.Cu" "B.Cu") (net "GND") (uuid via1)',
            '(layers "F.Cu" "B.Cu") (net "/LED_A") (uuid via1)'))
        holes=coverage.native_drilled_geometry(self.path)
        model=self.model.replace('140000 -100000 (net GND)','140000 -100000 (net /LED_A)')
        result=self.check(model,holes,applicability='custom_pth_track')
        self.assertEqual(result['status'],'covered',result)
        via=next(r for r in result['covered_holes'] if r['kind']=='via')
        self.assertEqual(via['disposition'],'custom_not_applicable')
        self.assertNotIn('applicability_source',via)
        self.blocked(self.check(model.replace('140000 -100000 (net /LED_A)',
            '140001 -100000 (net /LED_A)'),holes,applicability='custom_pth_track'))

    def test_mutated_native_slot_changes_inventory_and_cannot_reuse_old_export(self):
        self.path.write_text(self.native.replace('(at 1 2 180)','(at 1.001 2 180)',1))
        changed=coverage.native_drilled_geometry(self.path)
        self.assertNotEqual(changed,self.holes)
        before=next(h for h in self.holes if h['identity']=='slot1')
        after=next(h for h in changed if h['identity']=='slot1')
        self.assertNotEqual(before['native_form_sha256'],after['native_form_sha256'])
        self.blocked(self.check(holes=changed))

    def test_malformed_units_layers_inventory_and_numerics_fail_closed(self):
        for model in (self.model.replace('(resolution um 10)','(resolution mm 10)'),
                self.model.replace('(type power)','(type signal)'),
                self.model.replace('(rect F.Cu -550 -950 550 950)','(path F.Cu 1100 1 -400 -1 400)'),
                self.model.replace('(circle F.Cu 600)','(circle F.Cu NaN)'),
                self.model.replace('(network ','(network (net gnd (pins X-1)) '),
                self.model.replace('J3-7 J3-7@1','J3-7 j3-7 J3-7@1')):
            self.blocked(self.check(model))
        self.blocked(coverage.inspect_drilled(self.model,holes=None,active_nets=['/LED_A'],layers=['F.Cu'],required_mm='.28',clearance_floor_mm='.2'))
        for key,value in [('required_mm',True),('clearance_floor_mm','nan'),('required_mm','-.1')]:
            self.blocked(self.check(**{key:value}))


if __name__=='__main__':unittest.main()
