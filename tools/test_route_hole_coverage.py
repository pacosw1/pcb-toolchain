import copy
from decimal import Decimal
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


if __name__=='__main__':unittest.main()
