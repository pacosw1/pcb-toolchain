from pathlib import Path
import unittest
import sys
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from placer import placement_audit as audit


class PlacementAuditTest(unittest.TestCase):
    def test_many_moves_cannot_accumulate_beyond_seed_radius(self):
        import random
        from placer import anneal, cost
        from placer.test_anneal import two_units
        pr=two_units(); p=dict(p_swap=0,p_rot=0,max_displacement=1.)
        ev=cost.Evaluator(pr,p); mover=anneal.Mover(pr,ev,p); rng=random.Random(1)
        for _ in range(1000):
            moves,_=mover.propose(rng,3)
            ev.propose(moves); ev.commit()
            self.assertLessEqual(((ev.X[1]-pr['units'][1]['x'])**2+(ev.Y[1]-pr['units'][1]['y'])**2)**.5,1.+1e-9)

    def test_legalizer_cannot_rotate_seeded_part_to_escape_illegality(self):
        from placer import anneal, cost
        from placer.test_cost import problem as make_problem, unit
        pr=make_problem([unit('WIDE',1.5,6,[[-2,-.5,2,.5,0]])], [],
                        board=dict(outline=[[0,0],[3,0],[3,12],[0,12]],keepouts=[],edge_clearance=0))
        p=dict(mask_cell=.25,legal_step=.25,legal_radius=1,legal_passes=1)
        strict=cost.Evaluator(pr,p)
        self.assertEqual(anneal.legalize(strict,dict(p,legal_rotate=0)),[0])
        self.assertEqual(strict.R[0],0)
        legacy=cost.Evaluator(pr,p)
        self.assertEqual(anneal.legalize(legacy,dict(p,legal_rotate=1)),[])
        self.assertIn(legacy.R[0],(1,3))

    def test_rank_ties_and_no_variance_do_not_invent_correlation(self):
        self.assertEqual(audit.spearman([1,2,3],[3,2,1]),-1.)
        self.assertEqual(audit.spearman([1,1,3],[2,2,4]),1.)
        self.assertIsNone(audit.spearman([1,1,1],[1,2,3]))
        self.assertIsNone(audit.spearman([1,2],[1,2]))


if __name__ == '__main__':
    unittest.main()
