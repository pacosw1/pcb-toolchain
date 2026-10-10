"""Native per-layer record API proof; no fill, routing or qualification."""
import hashlib
import json
import os
from pathlib import Path
import unittest

import mandatory_preflight as preflight

ROOT = Path(os.environ['VIA_RECORD_OUTPUT_ROOT']) if os.environ.get('VIA_RECORD_OUTPUT_ROOT') else None
SOURCE = Path(os.environ['VIA_RECORD_INPUT_BOARD']) if os.environ.get('VIA_RECORD_INPUT_BOARD') else None


@unittest.skipUnless(ROOT is not None and SOURCE is not None,
                     'native fixture requires VIA_RECORD_OUTPUT_ROOT and VIA_RECORD_INPUT_BOARD')
class NativeViaRecordTests(unittest.TestCase):
    def record_oracle(self, board, via, row):
        expected={board.GetLayerName(layer):via.GetWidth(layer)
                  for layer in board.GetEnabledLayers().CuStack() if via.IsOnLayer(layer)}
        self.assertEqual(row['via_diameters'],expected)
        self.assertEqual(row['width'],via.GetWidth(via.TopLayer()))
        self.assertEqual(row['span'],[via.TopLayer(),via.BottomLayer()])
        self.assertEqual(row['drill'],via.GetDrillValue())
        self.assertEqual(row['uuid'],via.m_Uuid.AsString())
        self.assertEqual(row['geometry'],[[via.GetPosition().x,via.GetPosition().y]])
        self.assertTrue(row['via'])

    def test_saved_asymmetric_through_blind_and_buried_padstacks(self):
        import pcbnew as p
        board=p.BOARD();board.SetCopperLayerCount(4)
        net=p.NETINFO_ITEM(board,'/FIXTURE');board.Add(net)
        stacks=[('through',p.VIATYPE_THROUGH,(p.F_Cu,p.B_Cu),
                 {p.F_Cu:600000,p.In1_Cu:500000,p.In2_Cu:550000,p.B_Cu:700000}),
                ('blind',p.VIATYPE_BLIND,(p.F_Cu,p.In1_Cu),{p.F_Cu:650000,p.In1_Cu:500000}),
                ('buried',p.VIATYPE_BURIED,(p.In1_Cu,p.In2_Cu),{p.In1_Cu:500000,p.In2_Cu:550000})]
        expected={}
        for i,(name,kind,span,widths) in enumerate(stacks):
            via=p.PCB_VIA(board);via.SetViaType(kind);via.SetLayerPair(*span)
            via.SetPosition(p.VECTOR2I(p.FromMM(5+i*2),p.FromMM(5)))
            via.SetNet(net);via.SetDrill(300000);via.SetLocked(True)
            via.Padstack().SetMode(p.PADSTACK.MODE_CUSTOM)
            for layer,width in widths.items():via.SetWidth(layer,width)
            board.Add(via)
            expected[via.m_Uuid.AsString()]={board.GetLayerName(layer):width for layer,width in widths.items()}
        path=ROOT/(self._testMethodName+'.kicad_pcb');p.SaveBoard(str(path),board)
        loaded=p.LoadBoard(str(path));rows=preflight.records(loaded)
        self.assertEqual(len(rows),3)
        by_id={v.m_Uuid.AsString():v for v in loaded.GetTracks()}
        for row in rows:
            self.record_oracle(loaded,by_id[row['uuid']],row)
            self.assertEqual(row['via_diameters'],expected[row['uuid']])
        (ROOT/(self._testMethodName+'.json')).write_text(json.dumps(dict(
            saved_board_sha256=hashlib.sha256(path.read_bytes()).hexdigest(),rows=rows,
            scope='native saved/reloaded via padstack API; synthetic unqualified board'),indent=2)+'\n')

    def test_exact_five_copied_usb_vbus_vias(self):
        import pcbnew as p
        before=hashlib.sha256(SOURCE.read_bytes()).hexdigest()
        board=p.LoadBoard(str(SOURCE));rows=preflight.records(board)
        vias=[v for v in board.GetTracks() if v.GetClass()=='PCB_VIA' and ('USB' in v.GetNetname() or 'VBUS' in v.GetNetname())]
        expected={'44e09bdc-84bf-47d5-8363-07574b0835e3','785bf176-1d13-40c5-9038-f938315f3529',
                  '944ea9be-61a3-45cf-8363-8c5e4d97b1eb','f2f3e075-bcff-4be4-ba8b-8dbef869bd21',
                  'ae741541-3be7-4872-b447-17a44922ae13'}
        self.assertEqual({v.m_Uuid.AsString() for v in vias},expected)
        records={r['uuid']:r for r in rows};selected=[]
        for via in vias:
            row=records[via.m_Uuid.AsString()];self.record_oracle(board,via,row)
            self.assertEqual(set(row['via_diameters'].values()),{600000})
            self.assertEqual(row['drill'],300000);self.assertTrue(row['locked']);selected.append(row)
            fault=dict(uuid=row['uuid'],net=row['net'],layer=row['layer'],source_locked=True,
                       preservation='locked or retained by this invocation')
            receipt=dict(board_sha256=before,qualified=False,policy_sources={'project':'hash'},
                         board_identity={'source_project':'project'},preserved_pair_profile=None,
                         routed_nets=[],unlock_nets='',source_records=[row],faults=[fault])
            self.assertEqual(preflight.locked_faults(receipt,before,[row],receipt,receipt['policy_sources']),[])
        self.assertEqual(hashlib.sha256(SOURCE.read_bytes()).hexdigest(),before)
        (ROOT/(self._testMethodName+'.json')).write_text(json.dumps(dict(source_sha256=before,
            rows=selected,scope='read-only five copied frozen native vias; no CAD or qualification change'),indent=2)+'\n')


if __name__=='__main__':
    ROOT.mkdir(parents=True,exist_ok=False)
    unittest.main()
