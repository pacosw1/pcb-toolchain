"""Unit tests of tools/router/run.py (no KiCad, no cargo): binary freshness, lock nets, pads, DRC counts, output."""
import json
import os
import subprocess
import sys
import tempfile
import time
import unittest
from types import SimpleNamespace

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import run  # noqa: E402


def core_tree(d):
    os.makedirs(os.path.join(d, 'src'))
    open(os.path.join(d, 'Cargo.toml'), 'w').write('[package]\nname = "iotroute"\n')
    open(os.path.join(d, 'src', 'main.rs'), 'w').write('fn main() {}\n')
    return d


class Binary(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.core = core_tree(os.path.join(self.tmp.name, 'core'))

    def tearDown(self):
        self.tmp.cleanup()

    def test_sources_sha_follows_bytes_and_names(self):
        a = run.sources_sha(self.core)
        open(os.path.join(self.core, 'src', 'main.rs'), 'a').write('// x\n')
        b = run.sources_sha(self.core)
        self.assertNotEqual(a, b)
        os.rename(os.path.join(self.core, 'src', 'main.rs'), os.path.join(self.core, 'src', 'lib.rs'))
        self.assertNotEqual(b, run.sources_sha(self.core))

    def test_explicit_bin_older_than_a_source_fails(self):
        exe = os.path.join(self.tmp.name, 'iotroute')
        open(exe, 'w').write('#!/bin/sh\n')
        os.chmod(exe, 0o755)
        now = time.time()
        os.utime(exe, (now - 100, now - 100))
        os.utime(os.path.join(self.core, 'src', 'main.rs'), (now, now))
        with self.assertRaisesRegex(run.StepError, 'older than its source src/main.rs'):
            run.check_explicit_bin(exe, self.core)
        os.utime(exe, (now + 1, now + 1))
        self.assertEqual(run.check_explicit_bin(exe, self.core), exe)

    def test_cache_builds_once_per_source_hash(self):
        calls = []

        def fake_build(cmd, env, **kw):
            calls.append(env['CARGO_TARGET_DIR'])
            os.makedirs(os.path.join(env['CARGO_TARGET_DIR'], 'release'), exist_ok=True)
            open(os.path.join(env['CARGO_TARGET_DIR'], 'release', 'iotroute'), 'w').write('bin')
            return SimpleNamespace(returncode=0, stdout='ok')
        old = os.environ.get('IOTROUTE_CACHE')
        os.environ['IOTROUTE_CACHE'] = os.path.join(self.tmp.name, 'cache')
        try:
            exe, src, how = run.find_or_build(self.core, build=fake_build)
            self.assertEqual(how, 'built')
            self.assertIn(src, exe)
            self.assertEqual(run.find_or_build(self.core, build=fake_build)[2], 'cache')
            self.assertEqual(len(calls), 1)
            open(os.path.join(self.core, 'src', 'main.rs'), 'a').write('// changed\n')
            exe2, src2, how2 = run.find_or_build(self.core, build=fake_build)
            self.assertEqual((how2, len(calls)), ('built', 2))
            self.assertNotEqual(src, src2)
        finally:
            if old is None:
                del os.environ['IOTROUTE_CACHE']
            else:
                os.environ['IOTROUTE_CACHE'] = old

    def test_failed_build_is_a_step_error_and_writes_no_stamp(self):
        os.environ['IOTROUTE_CACHE'] = os.path.join(self.tmp.name, 'cache')
        try:
            with self.assertRaises(run.StepError):
                run.find_or_build(self.core, build=lambda cmd, env, **kw: SimpleNamespace(returncode=101, stdout='e'))
            d = run.cache_dir(run.sources_sha(self.core))
            self.assertFalse(os.path.exists(os.path.join(d, 'sources.sha256')))
        finally:
            del os.environ['IOTROUTE_CACHE']


class Lock(unittest.TestCase):
    def test_lock_nets_are_pairs_and_via_count_zero(self):
        model = {'pairs': [{'p': '/USB_DP', 'n': '/USB_DN'}],
                 'nets': {'/OSC_IN': {'limits': {'via_count': 0.0}}, '/RMII': {'limits': {'via_count': 4.0}},
                          'VDD': {'limits': {'amps': 1.0}}, '/X': {'limits': {}}}}
        self.assertEqual(run.lock_nets(model), {'/USB_DP', '/USB_DN', '/OSC_IN'})

    def test_pad_mismatch_only_for_lock_nets(self):
        src = {('U1', '1'): (10.0, 10.0, '/A'), ('U1', '2'): (11.0, 10.0, '/B'), ('R1', '1'): (5.0, 5.0, '/A')}
        dst = {('U1', '1'): (10.0, 10.0, '/A'), ('U1', '2'): (20.0, 10.0, '/B')}
        self.assertEqual(run.pad_mismatch(src, dst, {'/A'}), ['R1.1 /A'])
        self.assertEqual(run.pad_mismatch(src, dst, {'/B'}), ['U1.2 /B'])
        self.assertEqual(run.pad_mismatch(src, dict(src), {'/A', '/B'}), [])


class Files(unittest.TestCase):
    def test_sidecars_named_after_out_and_conflict_stops(self):
        with tempfile.TemporaryDirectory() as t:
            src = os.path.join(t, 'a')
            os.makedirs(src)
            for n in ('B.kicad_pcb', 'B.kicad_pro', 'B.kicad_dru', 'fp-lib-table'):
                open(os.path.join(src, n), 'w').write(n)
            out = os.path.join(t, 'o', 'routed.kicad_pcb')
            os.makedirs(os.path.dirname(out))
            placed = run.place_sidecars(os.path.join(src, 'B.kicad_pcb'), out)
            self.assertEqual(sorted(os.listdir(os.path.dirname(out))), ['fp-lib-table', 'routed.kicad_dru', 'routed.kicad_pro'])
            self.assertEqual(open(placed['.kicad_pro']).read(), 'B.kicad_pro')
            open(placed['.kicad_pro'], 'w').write('defaults')   # what pcbnew SaveBoard does
            self.assertTrue(run.restore_pro(os.path.join(src, 'B.kicad_pcb'), out))
            self.assertFalse(run.restore_pro(os.path.join(src, 'B.kicad_pcb'), out))
            self.assertEqual(open(placed['.kicad_pro']).read(), 'B.kicad_pro')
            open(placed['.kicad_dru'], 'w').write('other rules')
            with self.assertRaisesRegex(run.StepError, 'differs'):
                run.place_sidecars(os.path.join(src, 'B.kicad_pcb'), out)

    def test_hierarchical_sub_sheets_are_copied(self):
        # v8: BASE-PWR-C: the root sheet alone gave parity 80 on the copy (sub-sheets ETH, PWR-24V missing)
        with tempfile.TemporaryDirectory() as t:
            src = os.path.join(t, 'a')
            os.makedirs(src)
            for n in ('B.kicad_pcb', 'B.kicad_pro', 'B.kicad_sch', 'ETH.kicad_sch', 'PWR-24V.kicad_sch'):
                open(os.path.join(src, n), 'w').write(n)
            out = os.path.join(t, 'o', 'routed.kicad_pcb')
            os.makedirs(os.path.dirname(out))
            run.place_sidecars(os.path.join(src, 'B.kicad_pcb'), out)
            self.assertEqual(sorted(os.listdir(os.path.dirname(out))),
                             ['ETH.kicad_sch', 'PWR-24V.kicad_sch', 'routed.kicad_pro', 'routed.kicad_sch'])

    def test_sub_sheets_in_subfolders_are_copied_recursively(self):
        # v9: INPUT-4D2A / FW-IO keep their sub-sheets in blocks/; a sub-sheet may name another one next to itself
        sheet = '(sheet (property "Sheetfile" "%s"))'
        with tempfile.TemporaryDirectory() as t:
            src = os.path.join(t, 'a')
            os.makedirs(os.path.join(src, 'blocks', 'deep'))
            files = {'B.kicad_pcb': '', 'B.kicad_pro': 'pro', 'B.kicad_sch': sheet % 'blocks/X.kicad_sch',
                     'blocks/X.kicad_sch': sheet % 'deep/Y.kicad_sch', 'blocks/deep/Y.kicad_sch': 'y',
                     'blocks/unused.kicad_sch': 'unused'}
            for n, c in files.items():
                open(os.path.join(src, n), 'w').write(c)
            out = os.path.join(t, 'o', 'routed.kicad_pcb')
            os.makedirs(os.path.dirname(out))
            run.place_sidecars(os.path.join(src, 'B.kicad_pcb'), out)
            got = sorted(os.path.relpath(os.path.join(r, f), os.path.dirname(out))
                         for r, _, fs in os.walk(os.path.dirname(out)) for f in fs)
            self.assertEqual(got, ['blocks/X.kicad_sch', 'blocks/deep/Y.kicad_sch', 'routed.kicad_pro', 'routed.kicad_sch'])
            self.assertEqual(open(os.path.join(os.path.dirname(out), 'blocks', 'deep', 'Y.kicad_sch')).read(), 'y')


class Output(unittest.TestCase):
    def test_drc_counts_errors_only(self):
        rep = {'violations': [{'type': 'clearance', 'severity': 'error'}, {'type': 'silk_overlap', 'severity': 'warning'},
                              {'type': 'starved_thermal', 'severity': 'error'}, {'type': 'clearance', 'severity': 'error'}],
               'unconnected_items': [{}, {}], 'schematic_parity': [{}]}
        self.assertEqual(run.drc_counts(rep), (3, 2, 1, {'clearance': 2, 'starved_thermal': 1}))

    def test_route_claim_parsed_but_not_the_verdict(self):
        text = 'iter 1: ...\nROUTE PASS converged true iters 11 tracks 1334 vias 248 failed 0 notes 17 52 s -> x.json\n'
        self.assertEqual(run.parse_route_line(text), dict(status='PASS', converged=True, iters=11, tracks=1334,
                                                          vias=248, failed=0))
        self.assertIsNone(run.parse_route_line('thread panicked'))
        stalled = 'ROUTE FAIL converged false iters 9 tracks 3 vias 1 failed 2 notes 4 stop stall-passes 6 s -> x.json\n'
        self.assertEqual(run.parse_route_line(stalled), dict(status='FAIL', converged=False, iters=9, tracks=3, vias=1,
                                                             failed=2, stop='stall-passes'))

    def test_seed_stall_and_checkpoint_reach_the_core_only_when_asked(self):
        seen = []
        old = run.step
        run.step = lambda cmd, log: (seen.append(cmd), (0, ''))[1]
        try:
            with tempfile.TemporaryDirectory() as d:
                for a in (SimpleNamespace(iters=80, max_time=None), SimpleNamespace(iters=80, max_time=None, seed=None, stall_passes=None, checkpoint=False),
                          SimpleNamespace(iters=80, max_time=None, seed=0, stall_passes=12, checkpoint=True)):
                    with self.assertRaises(run.StepError):  # the fake core writes no route.json
                        run.route_attempt(a, 'exe', 'm.json', 'in.kicad_pcb', 'src', 'out', d)
                self.assertEqual(seen[0], ['exe', 'm.json', os.path.join(d, 'route.json'), '--iters', '80'])
                self.assertEqual(seen[1], seen[0])
                self.assertEqual(seen[2][5:], ['--seed', '0', '--stall-passes', '12', '--checkpoint', os.path.join(d, 'checkpoint.json'),
                                               '--source-sha', run.sources_sha()])
        finally:
            run.step = old

    def test_core_writes_the_congestion_map_next_to_route_json(self):
        seen = []
        old = run.step
        run.step = lambda cmd, log: (seen.append(cmd), (0, ''))[1]
        try:
            with tempfile.TemporaryDirectory() as d:
                with self.assertRaises(run.StepError):  # default: no map
                    run.route_attempt(SimpleNamespace(iters=80, max_time=None), 'exe', 'm.json', 'in.kicad_pcb', 'src', 'out', d)
                self.assertNotIn('--congestion', seen[0])
                with self.assertRaises(run.StepError):  # the fake core writes no route.json
                    run.route_attempt(SimpleNamespace(iters=80, max_time=None, congestion=True), 'exe', 'm.json', 'in.kicad_pcb', 'src', 'out', d)
                cmd = seen[1]
                self.assertEqual(cmd[:5], ['exe', 'm.json', os.path.join(d, 'route.json'), '--iters', '80'])
                self.assertEqual(cmd[cmd.index('--congestion') + 1], os.path.join(d, 'congestion.json'))
                self.assertEqual(cmd[cmd.index('--cong-free') + 1], '1')
        finally:
            run.step = old

    def test_summary_line(self):
        rec = dict(status='FAIL', drc_errors=1, unconnected=0, parity=0, tracks=10, vias=2, seconds=61.4)
        self.assertEqual(run.summary_line(rec), 'FAIL 1 0 0 10 2 61')
        self.assertEqual(run.summary_line(dict(status='ERROR', seconds=0.2, cause='x')), 'ERROR 0 x')

    def test_existing_out_is_refused_and_not_written(self):
        with tempfile.TemporaryDirectory() as t:
            out = os.path.join(t, 'X.kicad_pcb')
            open(out, 'w').write('keep')
            p = subprocess.run([sys.executable, run.__file__, 'NET-CORE', out, '--json'], capture_output=True, text=True)
            self.assertEqual(p.returncode, 2, p.stdout + p.stderr)
            line, rec = p.stdout.splitlines()
            self.assertTrue(line.startswith('ERROR '))
            self.assertEqual(json.loads(rec)['status'], 'ERROR')
            self.assertEqual(open(out).read(), 'keep')
            self.assertEqual(os.listdir(t), ['X.kicad_pcb'])



KPY = run.python_native()
NET_CORE = os.path.join(run.ROOT, 'hardware-design', 'boards', 'NET-CORE', 'cad', 'NET-CORE', 'NET-CORE.kicad_pcb')


class RefGate(unittest.TestCase):
    """Gate scope of the reference rule (2026-11-02): run.py reads the net of each D-124c reference FAIL line of the
    gate's own si_planes.py output (formats of tools/si_planes.py d124c_reference_failures); other lines are not nets."""

    def test_fail_lines_name_their_net(self):
        lines = {
            'FAIL unknown-driver B.Cu /ETH_CT: 1 of 1 crossings need an edge time (longest run 1.5 mm at (121.8, 113.8))': '/ETH_CT',
            'FAIL detour F.Cu /SPI_SCK: 1 of 2 crossings with a return detour > 13.4 mm or no reference path': '/SPI_SCK',
            'FAIL domain-cross F.Cu /AI1: 0.6 mm over ISO_0V (domain GND)': '/AI1',
            'FAIL fast-crossing F.Cu /ETH_TXP: 1 crossings, longest 0.40 mm at (1.0, 2.0)': '/ETH_TXP',
        }
        for ln, net in lines.items():
            self.assertEqual(run.PLANES_FAIL.match(ln).group(1), net, ln)
        for ln in ('FAIL no-domain /X: no pad in a ground zone outline; set "domains" or "exempt"',
                   'WARN D-124d-proposed unknown-driver B.Cu /ETH_CT: report-only', '0 reference-plane failures'):
            self.assertIsNone(run.PLANES_FAIL.match(ln), ln)

    def test_no_soft_net_means_no_round(self):
        with tempfile.TemporaryDirectory() as d:
            m = os.path.join(d, 'model.json')
            json.dump({'nets': {'A': {'ref_domain': 'GND', 'ref_soft': False}}}, open(m, 'w'))
            self.assertEqual(run.ref_gate_rounds(None, None, None, m, None, None, None, d, d)['rounds'], [])


class Reuse(unittest.TestCase):
    def test_moved_refs_by_position_turn_and_side(self):
        prev = {'C1': (100, 200, 0, 0), 'C2': (100, 200, 900, 0), 'U1': (5000, 5000, 0, 0), 'R1': (0, 0, 0, 0)}
        new = {'C1': (150, 200, 0, 0), 'C2': (100, 200, 0, 0), 'U1': (505000, 5000, 0, 0), 'R1': (0, 0, 0, 31)}
        self.assertEqual(run.moved_refs(prev, new), ['C2', 'R1', 'U1'])   # C1 moved 50 nm: under the 100 nm tolerance
        with self.assertRaisesRegex(run.StepError, 'other parts: C9'):
            run.moved_refs(prev, dict(new, C9=(0, 0, 0, 0)))

    def test_drc_nets_from_errors_and_unconnected_items(self):
        rep = {'violations': [{'severity': 'error', 'items': [{'description': 'Track [/A] on F.Cu'}, {'description': 'Pad 1 [GND] of C1'}]},
                              {'severity': 'warning', 'items': [{'description': 'Track [/W] on F.Cu'}]}],
               'unconnected_items': [{'items': [{'description': 'Pad 3 [/NAND_WP] of U6 on F.Cu'}, {'description': 'Pad 15 [/NAND_WP] of U1'}]}]}
        self.assertEqual(run.drc_nets(rep), {'/A', 'GND', '/NAND_WP'})

    def test_fallback_keeps_the_better_attempt_and_a_tie_keeps_the_full_route(self):
        reuse = dict(drc_errors=0, unconnected=1, parity=0, claim=dict(failed=1))
        full = dict(drc_errors=0, unconnected=0, parity=0, claim=dict(failed=0))
        self.assertTrue(run.better_attempt(full, reuse))
        self.assertFalse(run.better_attempt(reuse, full))
        same = dict(reuse)
        self.assertFalse(run.better_attempt(reuse, same) or run.better_attempt(same, reuse))   # tie: run() takes full
        fewer_failed = dict(drc_errors=0, unconnected=1, parity=0, claim=dict(failed=0))
        self.assertTrue(run.better_attempt(fewer_failed, reuse))

    def test_reuse_options(self):
        a = run.parser().parse_args(['NET-CORE', 'o.kicad_pcb', '--reuse', 'p.kicad_pcb'])
        self.assertEqual((a.reuse, a.reuse_fallback), ('p.kicad_pcb', 'full'))
        self.assertIsNone(run.parser().parse_args(['NET-CORE', 'o.kicad_pcb']).reuse)


class Determinism(unittest.TestCase):
    """v9: the same input gives byte-identical files (v8b: ESP32-CORE, same copper, GND vias in another order)."""

    def kpy(self, code):
        p = subprocess.run([KPY, '-c', code], capture_output=True, text=True, cwd=os.path.dirname(run.__file__))
        self.assertEqual(p.returncode, 0, p.stderr[-2000:])
        return p.stdout

    def test_locked_input_is_byte_identical_and_keeps_the_source_kiids(self):
        with tempfile.TemporaryDirectory() as t:
            out = self.kpy(f"""
import run, pcbnew
nets = {{'/USB0_DP', '/USB0_DN', '/ETH_TXP', '/ETH_TXN'}}
for d in ('a', 'b'):
    run.make_locked_input({NET_CORE!r}, {NET_CORE!r}, nets, {t!r} + '/' + d + '/NET-CORE.kicad_pcb')
src = sorted(x.m_Uuid.AsString() for x in pcbnew.LoadBoard({NET_CORE!r}).GetTracks() if x.GetNetname() in nets)
cp = sorted(x.m_Uuid.AsString() for x in pcbnew.LoadBoard({t!r} + '/a/NET-CORE.kicad_pcb').GetTracks())
print(len(src), src == cp)
""")
            self.assertTrue(out.strip().endswith('True'), out)
            self.assertEqual(open(os.path.join(t, 'a', 'NET-CORE.kicad_pcb'), 'rb').read(),
                             open(os.path.join(t, 'b', 'NET-CORE.kicad_pcb'), 'rb').read())

    def test_write_gives_a_byte_identical_board(self):
        with tempfile.TemporaryDirectory() as t:
            self.kpy(f"""
import pcbnew
b = pcbnew.BOARD()
b.Save({t!r} + '/T.kicad_pcb')
""")
            open(os.path.join(t, 'T.kicad_pro'), 'w').write('{}')
            res = {'tracks': [{'net': '', 'layer': 'F.Cu', 'a': [10 + i, 10], 'b': [10 + i, 20], 'w': 0.2} for i in range(12)],
                   'vias': [{'net': '', 'x': 30 + i, 'y': 30, 'd': 0.6, 'drill': 0.3} for i in range(6)]}
            json.dump(res, open(os.path.join(t, 'r.json'), 'w'))
            exe = run.find_or_build()[0]
            for d in ('a', 'b'):
                subprocess.run([exe, 'write', os.path.join(t, 'T.kicad_pcb'), os.path.join(t, 'r.json'), os.path.join(t, d)],
                               capture_output=True, text=True)
            self.assertEqual(open(os.path.join(t, 'a', 'T.kicad_pcb'), 'rb').read(),
                             open(os.path.join(t, 'b', 'T.kicad_pcb'), 'rb').read())


if __name__ == '__main__':
    unittest.main()
