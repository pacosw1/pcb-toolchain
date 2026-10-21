"""Guard native copper preservation and scoped proposal extraction."""
import copy
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest

from pcb_search.contracts import fingerprint
from pcb_search.native_srj import geometry_digest, netclass_rules, selected_route_proposal, source_set


class NativeContracts(unittest.TestCase):
    def test_netclass_values_are_explicit_and_composite_classes_abstain(self):
        p = {'net_settings': {'classes': [dict(name='PWR', track_width=.25,
               clearance=.15, via_diameter=.6, via_drill=.3)]}}
        self.assertEqual(netclass_rules(p, {'PWR'})['PWR']['track_width'], .25)
        with self.assertRaises(ValueError):
            netclass_rules(p, {'PWR,Default'})
        del p['net_settings']['classes'][0]['via_drill']
        with self.assertRaises(KeyError):
            netclass_rules(p, {'PWR'})

    def test_only_new_requested_net_copper_is_projected_and_originals_restored(self):
        old = dict(pcb_trace_id='old', connection_name='GND', route=[])
        new = dict(pcb_trace_id='new', connection_name='A', route=[])
        s = dict(traces=[old]); r = dict(status='model_mismatch', qualified=False,
            input_sha256=fingerprint(s), changed_fields=['preserved trace:old'],
            output=dict(traces=[dict(old, route=[{'x': 5}]), new]))
        saved = copy.deepcopy(r)
        p = selected_route_proposal(s, r, ['A'])
        self.assertEqual(p['output']['traces'], [old, new])
        self.assertEqual(r, saved)
        self.assertFalse(p['qualified'])
        self.assertTrue(p['native_validation_required'])
        r['changed_fields'] = ['obstacles']
        with self.assertRaises(ValueError):
            selected_route_proposal(s, r, ['A'])
        r['changed_fields'] = []; r['output']['traces'][-1]['connection_name'] = 'B'
        with self.assertRaises(ValueError):
            selected_route_proposal(s, r, ['A'])

    def test_geometry_hash_detects_changes_to_placement_rules_and_retained_copper(self):
        root = '(kicad_pcb (version 1) (footprint "R" (at 1 2) (uuid "f")) (segment (width .25) (uuid "t")))'
        with tempfile.TemporaryDirectory() as d:
            a, b = Path(d)/'a', Path(d)/'b'; a.write_text(root)
            b.write_text(root[:-1] + '(segment (width .15) (uuid "new")))')
            self.assertEqual(geometry_digest(a), geometry_digest(b, ['new']))
            for change in (root.replace('(at 1 2)', '(at 2 2)'), root.replace('.25', '.15'),
                           root[:-1] + '(setup (clearance .1)))'):
                b.write_text(change)
                self.assertNotEqual(geometry_digest(a), geometry_digest(b))
            with self.assertRaises(ValueError):
                geometry_digest(a, ['f'])

    @unittest.skipUnless(os.environ.get('PCB_NATIVE_FIXTURE'), 'explicit isolated native ENV fixture required')
    def test_hole_clearance_does_not_falsely_seal_sensor_escape(self):
        from pcb_search.capacity import terminal_conflicts
        board = Path(os.environ['PCB_NATIVE_FIXTURE']).resolve()
        project = json.loads(board.with_suffix('.kicad_pro').read_text())
        with tempfile.TemporaryDirectory() as directory:
            folder = Path(directory)/'input'
            p = subprocess.run([sys.executable, '-m', 'pcb_search.native_srj', 'export', str(board),
                                str(folder), '--net', '/SCL'], capture_output=True, text=True, timeout=15)
            self.assertEqual(p.returncode, 0, p.stdout+p.stderr)
            srj = json.loads((folder/'srj.json').read_text())
            self.assertFalse(terminal_conflicts(srj))
            self.assertEqual(srj['minTraceToHoleEdgeClearance'],
                             project['board']['design_settings']['rules']['min_hole_clearance'])
            self.assertEqual(srj['defaultObstacleMargin'],
                             max(c['clearance'] for c in project['net_settings']['classes']))

    @unittest.skipUnless(os.environ.get('PCB_NATIVE_FIXTURE'), 'explicit isolated native fixture required')
    def test_reuse_native_via_without_duplicate_and_reject_bad_reference(self):
        source = Path(os.environ['PCB_NATIVE_FIXTURE']).resolve()
        before = source_set(source)
        setup = '''import pcbnew as p,sys,json
b=p.LoadBoard(sys.argv[1]);items=list(b.GetTracks())
v=next(t for t in items if type(t) is p.PCB_VIA and t.GetNetname()=='/SDA')
v.SetLocked(True);p.SaveBoard(sys.argv[2],b)
print(json.dumps(dict(uid=v.m_Uuid.AsString(),x=p.ToMM(v.GetPosition().x),y=p.ToMM(v.GetPosition().y))))
'''
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory); board = root/'source.kicad_pcb'
            for ext in ('.kicad_pro', '.kicad_dru', '.kicad_sch'):
                shutil.copy2(source.with_suffix(ext), board.with_suffix(ext))
            p = subprocess.run([sys.executable, '-c', setup, str(source), str(board)],
                               capture_output=True, text=True, timeout=15)
            self.assertEqual(p.returncode, 0, p.stdout+p.stderr)
            via = json.loads(p.stdout)
            frozen = root/'frozen'
            p = subprocess.run([sys.executable, '-m', 'pcb_search.native_srj', 'export',
                                str(board), str(frozen), '--net', '/SDA'], capture_output=True, text=True, timeout=15)
            self.assertEqual(p.returncode, 0, p.stdout+p.stderr)
            srj = json.loads((frozen/'srj.json').read_text())
            old = next(t['route'][0] for t in srj['traces'] if t['pcb_trace_id']==via['uid'])
            wire = lambda x, layer: dict(route_type='wire', x=x, y=via['y'], layer=layer, width=srj['minTraceWidth'])
            transition = dict(old, reuse_via_id=via['uid'])
            route = [wire(via['x']-.1, 'top'), wire(via['x'], 'top'), transition,
                     wire(via['x']+.1, 'bottom')]
            response = dict(status='candidate', qualified=False, input_sha256=fingerprint(srj),
                output=dict(srj, traces=srj['traces']+[dict(pcb_trace_id='reuse-probe', connection_name='/SDA', route=route)]))
            for name, field, value in [('wrong-id', 'reuse_via_id', 'missing'),
                                       ('wrong-size', 'via_diameter', old['via_diameter']+.1),
                                       ('valid', 'reuse_via_id', via['uid'])]:
                trial = copy.deepcopy(response); trial['output']['traces'][-1]['route'][2][field] = value
                path = root/(name+'.json'); path.write_text(json.dumps(trial)); dest = root/name
                p = subprocess.run([sys.executable, '-m', 'pcb_search.native_srj', 'import',
                                    str(frozen), str(path), str(dest)], capture_output=True, text=True, timeout=15)
                self.assertEqual(p.returncode, 0 if name=='valid' else 3, p.stdout+p.stderr)
                if name != 'valid':
                    self.assertIn('reused via does not match original native copper', p.stdout)
                    self.assertFalse(dest.exists())
                else:
                    record = json.loads((dest/'record.json').read_text())
                    self.assertEqual(record['added'], 2)  # two stubs, zero vias
                    self.assertEqual(record['reused_via_ids'], [via['uid']])
                    self.assertEqual(record['protected_geometry_sha256'], geometry_digest(frozen/'input.kicad_pcb'))
        self.assertEqual(source_set(source), before)

    @unittest.skipUnless(os.environ.get('PCB_NATIVE_FIXTURE'), 'explicit isolated native fixture required')
    def test_retained_via_connects_layers_but_same_net_alone_does_not(self):
        # Two SMD pads on opposite layers join through retained tracks and one
        # via; a third same-net pad is physically isolated. Unlocking/removing
        # that via must split the first two pads again before the router runs.
        source = Path(os.environ['PCB_NATIVE_FIXTURE']).resolve()
        fixture = '''import pcbnew as p,sys
b=p.BOARD();b.SetCopperLayerCount(2)
n=p.NETINFO_ITEM(b,'A');b.Add(n)
v=lambda x,y:p.VECTOR2I(p.FromMM(x),p.FromMM(y))
for ref,x,y,layer in [('R1',5,5,p.F_Cu),('R2',9,5,p.B_Cu),('R3',5,9,p.F_Cu)]:
 f=p.FOOTPRINT(b);f.SetReference(ref);f.SetLayer(layer);f.SetPosition(v(x,y));b.Add(f)
 a=p.PAD(f);a.SetNumber('1');a.SetAttribute(p.PAD_ATTRIB_SMD);a.SetShape(p.PAD_SHAPE_RECT)
 a.SetSize(v(.6,.6));a.SetPosition(v(x,y));ls=p.LSET();ls.AddLayer(layer);a.SetLayerSet(ls);a.SetNet(n);f.Add(a)
for x0,x1,layer in [(5,7,p.F_Cu),(7,9,p.B_Cu)]:
 t=p.PCB_TRACK(b);t.SetStart(v(x0,5));t.SetEnd(v(x1,5));t.SetLayer(layer)
 t.SetWidth(p.FromMM(.2));t.SetNet(n);t.SetLocked(True);b.Add(t)
t=p.PCB_VIA(b);t.SetPosition(v(7,5));t.SetLayerPair(p.F_Cu,p.B_Cu)
t.SetWidth(p.FromMM(.6));t.SetDrill(p.FromMM(.3));t.SetNet(n);t.SetLocked(sys.argv[2]=='keep');b.Add(t)
e=p.PCB_SHAPE(b);e.SetShape(p.SHAPE_T_RECT);e.SetLayer(p.Edge_Cuts)
e.SetStart(v(0,0));e.SetEnd(v(15,15));e.SetWidth(p.FromMM(.05));b.Add(e)
p.SaveBoard(sys.argv[1],b)
'''
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for variant in ('keep', 'remove'):
                with self.subTest(variant=variant):
                    board = root/(variant+'.kicad_pcb')
                    for ext in ('.kicad_pro', '.kicad_dru', '.kicad_sch'):
                        shutil.copy2(source.with_suffix(ext), board.with_suffix(ext))
                    p = subprocess.run([sys.executable, '-c', fixture, str(board), variant],
                                       capture_output=True, text=True, timeout=15)
                    self.assertEqual(p.returncode, 0, p.stdout+p.stderr)
                    out = root/(variant+'-export')
                    p = subprocess.run([sys.executable, '-m', 'pcb_search.native_srj', 'export',
                                        str(board), str(out), '--net', 'A'],
                                       capture_output=True, text=True, timeout=15)
                    self.assertEqual(p.returncode, 0, p.stdout+p.stderr)
                    srj = json.loads((out/'srj.json').read_text())
                    connection = srj['connections'][0]
                    self.assertEqual(len(connection['pointsToConnect']), 3)
                    groups = [[label.split(':')[0] for label in group]
                              for group in connection['externallyConnectedPointIds']]
                    self.assertEqual(groups, [['R1.1', 'R2.1']] if variant=='keep' else [])
                    vias = [p for trace in srj['traces'] for p in trace['route'] if p['route_type']=='via']
                    self.assertEqual(len(vias), 1 if variant=='keep' else 0)
                    if vias:
                        self.assertEqual(vias[0], dict(route_type='via', x=7, y=5,
                            from_layer='top', to_layer='bottom', layers=['top', 'bottom'],
                            via_diameter=.6, via_hole_diameter=.3))

    @unittest.skipUnless(os.environ.get('PCB_NATIVE_FIXTURE'), 'explicit isolated native ENV fixture required')
    def test_retained_selected_copper_is_not_removed_and_native_groups_are_exported(self):
        board = Path(os.environ['PCB_NATIVE_FIXTURE']).resolve()
        before = source_set(board)
        with tempfile.TemporaryDirectory() as directory:
            folder = Path(directory) / 'retained'
            run = subprocess.run([sys.executable, '-m', 'pcb_search.native_srj', 'export', str(board),
                str(folder), '--net', '/V_GAS', '--retain-selected-copper'],
                capture_output=True, text=True, timeout=20)
            self.assertEqual(run.returncode, 0, run.stdout+run.stderr)
            receipt = json.loads((folder / 'record.json').read_text())
            model = json.loads((folder / 'srj.json').read_text())
            self.assertEqual(receipt['copper_policy'], 'retain')
            self.assertEqual(receipt['removed_items'], [])
            self.assertEqual(geometry_digest(board), geometry_digest(folder / 'input.kicad_pcb'))
            self.assertTrue(any(t['connection_name'] == '/V_GAS' for t in model['traces']))
            self.assertTrue(model['connections'][0]['externallyConnectedPointIds'])
        self.assertEqual(before, source_set(board))

    @unittest.skipUnless(os.environ.get('PCB_NATIVE_FIXTURE'), 'explicit isolated native ENV fixture required')
    def test_native_selected_net_round_trip_keeps_every_other_item(self):
        import pcbnew as pcb
        board = Path(os.environ['PCB_NATIVE_FIXTURE']).resolve()
        before = source_set(board)
        with tempfile.TemporaryDirectory() as directory:
            folder, dest = Path(directory)/'input', Path(directory)/'output'
            def native_command(*args):
                p = subprocess.run([sys.executable, '-m', 'pcb_search.native_srj', *map(str,args)],
                                   capture_output=True, text=True, timeout=15)
                self.assertEqual(p.returncode, 0, p.stdout + p.stderr)
            native_command('export', board, folder, '--net', '/V_GAS')
            self.assertTrue(json.loads((folder/'record.json').read_text())['removed_items'])
            srj = json.loads((folder/'srj.json').read_text())
            native = pcb.LoadBoard(str(board)); source_tracks = list(native.GetTracks())
            restored = []
            for t in source_tracks:
                if t.GetNetname() != '/V_GAS' or t.IsLocked():
                    continue
                self.assertIs(type(t), pcb.PCB_TRACK)
                restored.append(dict(type='pcb_trace', pcb_trace_id=t.m_Uuid.AsString(),
                    connection_name='/V_GAS', route=[dict(route_type='wire', x=pcb.ToMM(q.x),
                    y=pcb.ToMM(q.y), layer={pcb.F_Cu:'top',pcb.B_Cu:'bottom'}[t.GetLayer()],
                    width=pcb.ToMM(t.GetWidth())) for q in (t.GetStart(),t.GetEnd())]))
            response = dict(status='candidate', qualified=False, input_sha256=fingerprint(srj),
                            output=dict(srj, traces=srj['traces']+restored))
            path = Path(directory)/'proposal.json'; path.write_text(json.dumps(response))
            native_command('import', folder, path, dest)
            imported = json.loads((dest/'record.json').read_text())
            self.assertEqual(imported['added'], len(restored))
            self.assertEqual(imported['protected_geometry_sha256'], geometry_digest(folder/'input.kicad_pcb'))
            self.assertEqual(before, source_set(board))
            after = pcb.LoadBoard(str(dest/'candidate.kicad_pcb'))
            def copper(b):
                return sorted((t.GetNetname(),t.GetLayer(),t.GetWidth(),tuple(t.GetStart()),tuple(t.GetEnd()))
                              for t in b.GetTracks() if type(t) is pcb.PCB_TRACK)
            self.assertEqual(copper(native), copper(after))


if __name__ == '__main__':
    unittest.main()
