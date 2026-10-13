"""Backend lifecycle faults must never admit candidate copper."""
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

from pcb_search.contracts import fingerprint
from pcb_search.native_srj import digest, source_set
from pcb_search.tracemaker import command, run


class TraceMakerTest(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup)
        root=Path(self.tmp.name);self.folder=root/'input';self.folder.mkdir()
        self.source=self.folder/'input.kicad_pcb'
        self.source.write_text('(kicad_pcb (version 20260101))')
        for ext in ('.kicad_pro','.kicad_dru','.kicad_sch'):
            self.source.with_suffix(ext).write_text('{}')
        self.srj={'obstacles':[{'width':2.0,'height':3.0}]}
        (self.folder/'srj.json').write_text(json.dumps(self.srj))
        manifest=dict(input_files=source_set(self.source),srj_sha256=fingerprint(self.srj),selected_nets=['X'])
        (self.folder/'record.json').write_text(json.dumps(manifest))
        self.binary=root/'engine';self.binary.write_text('pinned engine')
        self.out=root/'output'

    def invoke(self):
        return run(self.folder,self.out,binary=self.binary,expected_sha256=digest(self.binary),search_s=1,wall_s=2)

    def candidate(self,*args,**kwargs):
        (self.out/'backend.kicad_pcb').write_text('(kicad_pcb (version 20260101) '
            '(segment (start 0 0) (end 1 1) (width 0.25) (layer "F.Cu") (net "X") (uuid "added")))')
        return subprocess.CompletedProcess(args[0],0)

    def test_complete_scoped_proposal_is_still_unqualified(self):
        with patch('pcb_search.tracemaker.lean.run_stage',side_effect=self.candidate) as stage:
            r=self.invoke()
        self.assertEqual(r['status'],'candidate');self.assertFalse(r['qualified'])
        self.assertEqual(r['added'],1)
        self.assertIn('deadline',stage.call_args.kwargs)
        self.assertTrue((self.out/'selected/record.json').is_file())
        cmd=r['command']
        self.assertEqual(cmd[cmd.index('--component-rules')+1],'off')
        self.assertGreater(float(cmd[cmd.index('--vias-off-pads-below')+1]),3)

    def test_timeout_with_output_cannot_admit_candidate(self):
        def timeout(*args,**kwargs):
            self.candidate(*args,**kwargs)
            raise subprocess.TimeoutExpired(args[0],2)
        with patch('pcb_search.tracemaker.lean.run_stage',side_effect=timeout): r=self.invoke()
        self.assertEqual(r['status'],'timeout');self.assertFalse((self.out/'selected').exists())

    def test_nonzero_backend_with_output_cannot_admit_candidate(self):
        def fail(*args,**kwargs):
            self.candidate(*args,**kwargs)
            return subprocess.CompletedProcess(args[0],1)
        with patch('pcb_search.tracemaker.lean.run_stage',side_effect=fail): r=self.invoke()
        self.assertEqual(r['status'],'backend_error');self.assertFalse((self.out/'selected').exists())

    def test_protected_change_is_rejected_even_on_zero_exit(self):
        def change(*args,**kwargs):
            result=self.candidate(*args,**kwargs)
            p=self.out/'backend.kicad_pcb'
            p.write_text(p.read_text().replace('20260101','20260102'))
            return result
        with patch('pcb_search.tracemaker.lean.run_stage',side_effect=change): r=self.invoke()
        self.assertEqual(r['status'],'reject');self.assertIn('protected',r['reason'])

    def test_binary_mismatch_abstains_before_launch(self):
        with patch('pcb_search.tracemaker.lean.run_stage') as stage:
            with self.assertRaisesRegex(ValueError,'fingerprint'):
                run(self.folder,self.out,binary=self.binary,expected_sha256='0'*64,search_s=1,wall_s=2)
            stage.assert_not_called()

    def test_refingerprinted_model_change_is_not_accepted(self):
        def change(*args,**kwargs):
            result=self.candidate(*args,**kwargs)
            srj=self.srj|{'new':'field'}
            (self.folder/'srj.json').write_text(json.dumps(srj))
            p=self.folder/'record.json';m=json.loads(p.read_text());m['srj_sha256']=fingerprint(srj)
            p.write_text(json.dumps(m))
            return result
        with patch('pcb_search.tracemaker.lean.run_stage',side_effect=change): r=self.invoke()
        self.assertEqual(r['status'],'reject');self.assertIn('manifest changed',r['reason'])


if __name__=='__main__': unittest.main()
