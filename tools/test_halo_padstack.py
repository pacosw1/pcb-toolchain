"""Halo export must remain readable by the independent copper-integrity guard."""
import unittest
from test_fastroute_phases import load_job
import import_replay_guard as guard


class HaloTest(unittest.TestCase):
    def test_two_and_four_layer_halos_keep_drill_and_span(self):
        job = load_job()
        for layers in [('F.Cu','B.Cu'), ('F.Cu','In1.Cu','In2.Cu','B.Cu')]:
            last = len(layers)-1
            name = f'Via[0-{last}]_600:300_um'
            shapes = '\n'.join(f'      (shape (circle {layer} 600))' for layer in layers)
            dsn = f'''(pcb test (unit um) (resolution um 10)
 (structure (via "{name}"))
 (library
    (padstack "{name}"
{shapes}
    )
 )
 (wiring))'''
            expanded = job.big_signal_via(dsn, 1.8, [])
            halo = f'Via[0-{last}]_1800:300_um'
            expanded = expanded.replace('(wiring)', f'(wiring (via "{halo}" 1000 2000 (net N)))')
            record = next(iter(guard.records(expanded)))
            self.assertEqual(record[4], 300000)
            self.assertEqual(dict(record[3]), {layer:1800000 for layer in layers})
            with self.assertRaisesRegex(ValueError, 'already exists'):
                job.big_signal_via(expanded, 1.8, [])


if __name__ == '__main__':
    unittest.main()
