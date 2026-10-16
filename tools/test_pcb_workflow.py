"""Transaction, evidence and board-context contracts; native proof is separate."""
import json
import os
from pathlib import Path
import shutil
import sys
import unittest
from unittest import mock

import pcb_operations as operations
import pcb_workflow as workflow
import test_pcb_cli as fixtures


BOARD = '''(kicad_pcb (version 20260101) (generator pcbnew)
 (net 1 "SIG") (gr_rect (start 0 0) (end 30 30) (layer "Edge.Cuts"))
 (footprint "Fixture:Pad" (layer "F.Cu") (at 10 10)
  (property "Reference" "J1" (at 0 0) (layer "F.SilkS"))
  (property "Value" "Pad" (at 0 2) (layer "F.Fab"))
  (property "MPN" "EXACT")
  (pad "1" smd rect (at 0 0) (size 1 1) (layers "F.Cu") (net 1 "SIG"))))'''


class WorkflowTests(unittest.TestCase):
    def setUp(self):
        self.fixture = fixtures.PcbCliTests()
        self.fixture.setUp()
        self.root, self.runs, self.board = self.fixture.root, self.fixture.runs, self.fixture.board
        # The native parser/identity helpers run unchanged; only the external
        # native executable and candidate writer are controlled fixture tools.
        source = Path(__file__).resolve().parent
        for directory in ('placer', 'pcb_search'):
            shutil.copytree(source / directory, self.root / 'tools' / directory,
                            ignore=shutil.ignore_patterns('__pycache__', 'node_modules'), dirs_exist_ok=True)
        # Keep the actual transitive Python parser dependencies together. A
        # partial hand-maintained copy hid required block/native-eco imports.
        for p in source.glob('*.py'):
            shutil.copyfile(p, self.root / 'tools' / p.name)
        shutil.copyfile(source / 'pcb_snapshot_inputs.mjs', self.root / 'tools/pcb_snapshot_inputs.mjs')
        for p in (source / 'lib').glob('*.mjs'):
            if p.name != 'env.mjs':
                shutil.copyfile(p, self.root / 'tools/lib' / p.name)
        (self.board / 'gate.json').write_text(json.dumps(dict(project='cad/X', stage='G3', checks=dict(erc=True, drc=True))))
        (self.board / 'cad/X.kicad_pcb').write_text(BOARD)
        (self.board / 'cad/X.kicad_pro').write_text('{}')
        (self.root / 'FOCUS.md').write_text('# FOCUS\n## Frozen\n## Done when\nworkflow verified\n')
        (self.root / 'tools/pcbtool.py').write_text('''import pathlib,sys
p=pathlib.Path(sys.argv[2]);p.write_text(p.read_text().replace('(at 10 10)', '(at 11 10)'))
print('candidate placement completed',flush=True)
''')
        self.spec = self.root / 'move.json'
        self.spec.write_text('{"J1":[11,10,0]}')
        self.env = dict(self.fixture.env, KICAD_PYTHON=sys.executable)

    def tearDown(self):
        self.fixture.tearDown()

    def candidate(self):
        response = self.fixture.cli('edit', 'X', '--kind', 'place', '--spec', str(self.spec), '--json', env=self.env)
        self.assertEqual(response.returncode, 0, response.stdout + response.stderr)
        result = json.loads(response.stdout.splitlines()[-1])
        self.assertTrue(result['candidate_verified'])
        self.assertTrue(result['identity_preserved'])
        return self.runs / result['run_id']

    def test_verified_candidate_stays_isolated_until_explicit_adoption(self):
        folder = self.candidate()
        target = self.board / 'cad/X.kicad_pcb'
        self.assertEqual(target.read_text(), BOARD)
        with mock.patch.dict(os.environ, self.env):
            receipt = operations.adopt(self.root, folder)
        self.assertNotEqual(receipt['before_sha256'], receipt['after_sha256'])
        self.assertIn('(at 11 10)', target.read_text())
        self.assertEqual((folder / 'backup/X.kicad_pcb').read_text(), BOARD)

    def test_source_or_evidence_mutation_prevents_adoption(self):
        folder = self.candidate()
        evidence = folder / 'gate/drc.json'
        original = evidence.read_bytes()
        evidence.write_text('{}')
        with self.assertRaisesRegex(ValueError, 'evidence changed'):
            operations.adopt(self.root, folder)
        evidence.write_bytes(original)
        (self.board / 'cad/X.kicad_sch').write_text('new source')
        with self.assertRaisesRegex(ValueError, 'canonical inputs changed'):
            operations.adopt(self.root, folder)

    def test_frozen_board_needs_current_named_defect(self):
        (self.root / 'FOCUS.md').write_text('# FOCUS\n## Frozen\n- X (current revision)\n## Done when\nfixed\n')
        folder = self.candidate()
        self.assertTrue(workflow.context(self.root, 'X')['frozen'])
        with self.assertRaisesRegex(ValueError, 'FOCUS.md freezes'):
            operations.adopt(self.root, folder)

    def test_concurrent_copper_edit_during_adoption_is_preserved(self):
        folder = self.candidate()
        target = self.board / 'cad/X.kicad_pcb'
        run = operations.subprocess.run

        def concurrent_edit(command, **kwargs):
            result = run(command, **kwargs)
            if '--verify' in command:
                target.write_text(BOARD[:-1] + '\n(segment (start 1 1) (end 2 1) (width 0.2) (layer "F.Cu") (net 1)))')
            return result

        with mock.patch.dict(os.environ, self.env), mock.patch.object(operations.subprocess, 'run', side_effect=concurrent_edit):
            with self.assertRaisesRegex(ValueError, 'canonical inputs changed during'):
                operations.adopt(self.root, folder)
        self.assertIn('(segment', target.read_text())
        self.assertFalse((folder / 'adoption.json').exists())

    def test_release_receipt_binds_actual_candidate_files(self):
        import pcb_evidence
        folder = self.root / 'release-proof'
        (folder / 'candidate/fab').mkdir(parents=True)
        (folder / 'operation').mkdir()
        (folder / 'run.json').write_text('{}')
        artifact = folder / 'candidate/fab/board.zip'
        artifact.write_bytes(b'actual fabrication outputs')
        (folder / 'operation/result.json').write_text(json.dumps(dict(artifact_directory=str(folder / 'candidate'))))
        (folder / 'result.json').write_text(json.dumps(dict(status='passed',cleanup=dict(complete=True),evidence_sha256=pcb_evidence.evidence_files(folder))))
        pcb_evidence.verify(folder)
        artifact.write_bytes(b'changed fabrication outputs')
        with self.assertRaisesRegex(ValueError, 'evidence changed'):
            pcb_evidence.verify(folder)

    def test_frozen_native_defect_can_be_fixed_when_dependents_were_blocked(self):
        import pcb_cli
        (self.root / 'FOCUS.md').write_text('# FOCUS\n## Frozen\n- X (current revision)\n## Done when\nfixed\n')
        (self.board / 'gate.json').write_text(json.dumps(dict(project='cad/X',checks=dict(
            erc=True,drc=True,paths='current-paths.json',viapads={},kicad_happy={},port_labels=True))))
        env = self.fixture.env
        response = self.fixture.cli('check','X','--json',env=dict(env,PCB_FIXTURE_PARITY='1'))
        self.assertEqual(response.returncode,1,response.stdout+response.stderr)
        baseline = self.runs / json.loads(response.stdout.splitlines()[-1])['run_id']
        findings = json.loads((baseline / 'gate/findings.json').read_text())
        self.assertFalse(findings['complete'])
        defect = next(f['id'] for f in findings['findings'] if f['rule']=='pad_net_mismatch')
        response = self.fixture.cli('edit','X','--kind','place','--spec',str(self.spec),'--json',env=env)
        self.assertEqual(response.returncode,0,response.stdout+response.stderr)
        folder = self.runs / json.loads(response.stdout.splitlines()[-1])['run_id']
        with mock.patch.dict(os.environ,env):
            receipt = operations.adopt(self.root,folder,defect,baseline)
        self.assertEqual(receipt['defect'],defect)

    def test_part_or_schematic_change_is_rejected_before_native_checks(self):
        writer = self.root / 'tools/pcbtool.py'
        writer.write_text(writer.read_text() +
                          "p.write_text(p.read_text().replace('EXACT','WRONG'))\n")
        response = self.fixture.cli('edit', 'X', '--kind', 'place', '--spec', str(self.spec), '--json', env=self.env)
        self.assertEqual(response.returncode, 1, response.stdout + response.stderr)
        final = json.loads(response.stdout.splitlines()[-1])
        self.assertFalse(final['identity_preserved'])
        self.assertIn('protected design', final['cause'])
        self.assertFalse((self.runs / final['run_id'] / 'gate').exists())
        self.assertEqual((self.board / 'cad/X.kicad_pcb').read_text(), BOARD)

    def test_snapshot_omits_unrelated_history_and_never_hardlinks_cad(self):
        unrelated = self.root / 'hardware-design/boards/Y/reports/old.kicad_pcb'
        unrelated.parent.mkdir(parents=True)
        unrelated.write_text('old run')
        history = self.root / 'hardware-design/registry/evidence/old.html'
        history.parent.mkdir(parents=True)
        history.write_text('old stock page')
        clone = self.root / '.gate/snapshot'
        clone.parent.mkdir(exist_ok=True)
        state = operations.snapshot(self.root, clone, 'X')
        self.assertNotIn(str(history.relative_to(self.root)), state['files'])
        self.assertFalse((clone / unrelated.relative_to(self.root)).exists())
        candidate = clone / 'hardware-design/boards/X/cad/X.kicad_pcb'
        candidate.write_text('changed copy')
        self.assertEqual((self.board / 'cad/X.kicad_pcb').read_text(), BOARD)

    def test_identity_allows_pose_and_copper_but_preserves_pad_net_and_outline(self):
        source = self.board / 'cad/X.kicad_pcb'
        other = self.root / 'other.kicad_pcb'
        other.write_text(BOARD.replace('(at 10 10)', '(at 11 10)'))
        self.assertEqual(operations.pcb_identity(source), operations.pcb_identity(other))
        for old, new in [('"EXACT"', '"WRONG"'), ('(net 1 "SIG"))))', '(net 2 "GND"))))'),
                         ('(end 30 30)', '(end 29 30)')]:
            other.write_text(BOARD.replace(old, new))
            self.assertNotEqual(operations.pcb_identity(source), operations.pcb_identity(other))

    def test_context_resolves_revision_owner_and_packet(self):
        alias = self.root / 'hardware-design/boards/X-B'
        alias.mkdir()
        (alias / 'gate.json').write_text(json.dumps(dict(project='../X/cad/X', checks=dict(erc=True,drc=True))))
        registry = self.root / 'hardware-design/registry'
        registry.mkdir(exist_ok=True)
        (registry / 'boards.json').write_text(json.dumps({'boards':[dict(id='X', directory='X', revisions=[dict(gate='X-B', spec='SPEC.md', id='B')])]}))
        info = workflow.context(self.root, 'X-B')
        self.assertEqual(info['revision']['owner'], 'X')
        self.assertEqual(info['project'], 'hardware-design/boards/X/cad/X')
        self.assertTrue(any(p['path']=='hardware-design/boards/X/STATUS.md' for p in info['source_files']))

    def test_snapshot_enumeration_uses_actual_global_library_dependencies(self):
        import subprocess
        config = self.root / 'config/10.0'
        config.mkdir(parents=True)
        library = self.root / 'custom-assets'
        library.mkdir()
        part = library / 'Pad.kicad_mod'
        part.write_text('(footprint "Pad")')
        (config / 'fp-lib-table').write_text('(fp_lib_table (lib (name "Fixture")(type "KiCad")(uri "'+str(library)+'")(options "")(descr "")))')
        helper = self.root / 'tools/pcb_snapshot_inputs.mjs'
        result = subprocess.run(['node',str(helper),str(self.root),'X'],env=self.env,capture_output=True,text=True,timeout=10)
        self.assertEqual(result.returncode,0,result.stderr)
        self.assertIn(str(part),json.loads(result.stdout))


if __name__ == '__main__':
    unittest.main()
