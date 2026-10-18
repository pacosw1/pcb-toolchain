import copy
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

    def test_containment_uses_squared_displacement_without_rounding_or_clearance_rescue(self):
        pads=copy.deepcopy(self.pads[:1])
        pads[0]['drill_mm']=['1.4']*2
        model=dsn().replace('1 -1750 0','1 -1708 -56')
        # 0.042**2+0.056**2 == 0.07**2, exactly tangent.
        self.assertEqual(self.check(model,pads)['status'],'covered')
        self.blocked(self.check(model.replace('-1708 -56','-1707.999999 -56'),pads))
        self.blocked(self.check(dsn().replace('(circle F.Cu 2100)','(circle F.Cu 1900)'),pads,
            clearance_floor_mm='100'))

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
