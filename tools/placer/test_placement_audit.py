import json
from pathlib import Path
import tempfile
import unittest
import sys
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from placer import placement_audit as audit


def problem():
    return dict(units=[dict(name='LOCK',refs=['J1'],fixed=True,x=0.,y=0.),
                       dict(name='MOVE',refs=['R1'],fixed=False,x=5.,y=5.)],board={'fixed_copper':[1]},
                decaps=[],domain_areas=[],dru_ignored=['native required'])


class PlacementAuditTest(unittest.TestCase):
    def test_illegal_lower_cost_alternative_cannot_win(self):
        candidates=[dict(illegal=['keepout'],cost=-100),dict(illegal=[],cost=10),
                    dict(illegal=[],cost=0,timeout=True)]
        self.assertEqual(sorted(candidates,key=audit.candidate_key)[0]['cost'],10)

    def test_seeded_exchange_is_rejected_even_without_rotation(self):
        pr=problem(); pr['units'][0]['fixed']=False
        c=dict(pose=[[5,5,0],[0,0,0]],illegal=[],components={})
        self.assertTrue(any('swapped' in f for f in audit.candidate_report(pr,c,dict(legal_rotate=0),True)['illegal']))
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

    def test_fixed_rotation_displacement_and_timeout_reject(self):
        c=dict(pose=[[1,0,0],[7,5,1]],prelegal_pose=[[0,0,0],[6,5,0]],components={},illegal=[],timeout=True)
        r=audit.candidate_report(problem(),c,dict(p_swap=0,p_rot=0,legal_rotate=0),True,1.)
        self.assertTrue(any('fixed' in x for x in r['illegal']))
        self.assertTrue(any('turn' in x for x in r['illegal']))
        self.assertTrue(any('cap' in x for x in r['illegal']))
        self.assertIn('incomplete placement',r['illegal'])
        self.assertEqual(r['legalizer_movement'][1]['displacement_mm'],1.)
        self.assertFalse(r['qualified'])

    def test_clean_pose_preserves_every_constraint_attribution(self):
        c=dict(pose=[[0,0,0],[5.5,5,0]],components={'hpwl':10},illegal=[])
        r=audit.candidate_report(problem(),c,dict(p_swap=0,p_rot=0,legal_rotate=0),True,1.)
        self.assertEqual(r['illegal'],[])
        self.assertEqual(r['constraints']['fixed_copper_items'],1)
        self.assertEqual(r['constraints']['unsupported'],['native required'])
        self.assertIsNone(r['legalizer_movement'])
        self.assertNotEqual(r['candidate_sha256'],audit.candidate_report(problem(),dict(c,pose=[[0,0,0],[6,5,0]]),{},False)['candidate_sha256'])

    def test_rank_ties_and_no_variance_do_not_invent_correlation(self):
        self.assertEqual(audit.spearman([1,2,3],[3,2,1]),-1.)
        self.assertEqual(audit.spearman([1,1,3],[2,2,4]),1.)
        self.assertIsNone(audit.spearman([1,1,1],[1,2,3]))
        self.assertIsNone(audit.spearman([1,2],[1,2]))

    def test_feedback_is_scoped_bounded_and_never_teaches_fixed_units(self):
        with tempfile.TemporaryDirectory() as td:
            d=Path(td)
            (d/'routed.kicad_pcb').write_text('result')
            (d/'input-manifest.json').write_text(json.dumps(dict(board_sha256='source')))
            (d/'outcome.json').write_text(json.dumps(dict(status='complete',errors=0,board_sha256=audit.digest(d/'routed.kicad_pcb'))))
            (d/'pin-escape.json').write_text(json.dumps(dict(halo_hint={'J1':10,'R1':10,'UNKNOWN':10})))
            hints={}
            for _ in range(10):
                hints,e=audit.bounded_feedback(problem(),d,'source',hints,1.)
            self.assertEqual(hints,{'R1':1.})
            self.assertTrue(e['accepted'])
            unchanged,e=audit.bounded_feedback(problem(),d,'other',hints,1.)
            self.assertEqual(unchanged,hints); self.assertFalse(e['accepted'])
            (d/'routed.kicad_pcb').write_text('stale')
            self.assertFalse(audit.bounded_feedback(problem(),d,'source',{},1.)[1]['accepted'])

    def test_congestion_is_opt_in_and_only_enclosed_not_router_misses(self):
        with tempfile.TemporaryDirectory() as td:
            d=Path(td); (d/'routed.kicad_pcb').write_text('result')
            (d/'input-manifest.json').write_text(json.dumps(dict(board_sha256='source')))
            (d/'outcome.json').write_text(json.dumps(dict(status='complete',errors=0,board_sha256=audit.digest(d/'routed.kicad_pcb'))))
            (d/'open-triage.json').write_text(json.dumps(dict(connections=[dict(class_='ROUTER_MISS')]
                                                           +[{'class':'ENCLOSED','blocking_parts':['R1','J1']}])) )
            self.assertEqual(audit.bounded_feedback(problem(),d,'source',{},1.)[0],{})
            self.assertEqual(audit.bounded_feedback(problem(),d,'source',{},1.,True)[0],{'R1':.25})


if __name__ == '__main__':
    unittest.main()
