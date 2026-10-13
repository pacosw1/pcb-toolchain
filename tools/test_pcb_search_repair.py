"""Regression from the rejected ENV-SENSE /V_GAS native route, CIP 839."""
import copy
import unittest

from pcb_search.capacity import route_crossings
from pcb_search.contracts import fingerprint
from pcb_search.repair import prune_crossing_excursion


def crossing_case():
    def trace(tid,net,points,width):
        return dict(pcb_trace_id=tid,connection_name=net,
                    route=[dict(route_type='wire',x=x,y=y,layer='bottom',width=width) for x,y in points])
    # Actual retained SCL and failed V_GAS waypoint coordinates, not a clearance
    # threshold. The physical conflict was independently reported by KiCad.
    fixed=trace('134c5847-3003-48df-952f-b47d37bac1f3','/SCL',
                [(118.8453,122.5076),(115.5582,119.2204)],.15)
    new=trace('/V_GAS_mst1_0','/V_GAS',[(115.73646838518003,122.50776751596503),
              (117.8413322766497,120.95757653371493),(116.15356072650107,121.72155178294548)],.25)
    srj=dict(traces=[fixed],connections=[dict(name='/V_GAS',pointsToConnect=[new['route'][0],new['route'][-1]])])
    proposal=dict(status='geometry_reject',qualified=False,input_sha256=fingerprint(srj),output=dict(traces=[fixed,new]))
    return srj,proposal


class LocalRepairTests(unittest.TestCase):
    def test_native_failure_repaired_without_rerouting_or_changing_protected_copper(self):
        srj,p=crossing_case();before=copy.deepcopy(p)
        self.assertEqual(len(route_crossings(srj,p['output']['traces'])),2)
        r=prune_crossing_excursion(srj,p,budget_s=.5)
        self.assertEqual(r['status'],'candidate')
        self.assertEqual(len(r['repair']['edits']),1)
        self.assertEqual(r['output']['traces'][0],srj['traces'][0])
        self.assertFalse(route_crossings(srj,r['output']['traces']))
        self.assertEqual(p,before)
        self.assertFalse(r['qualified']);self.assertTrue(r['native_validation_required'])

    def test_terminals_width_changes_and_layer_changes_are_not_shortcut(self):
        for kind in ('terminal','width','layer','via'):
            srj,p=crossing_case();mid=p['output']['traces'][1]['route'][1]
            if kind=='terminal':srj['connections'][0]['pointsToConnect'].append(mid)
            elif kind=='width':mid['width']=.15
            elif kind=='layer':mid['layer']='top'
            else:mid.update(route_type='via',from_layer='bottom',to_layer='top')
            p['input_sha256']=fingerprint(srj)
            r=prune_crossing_excursion(srj,p,budget_s=.5)
            self.assertEqual(r['status'],'geometry_reject')
            self.assertFalse(r['repair']['edits'])

    def test_exhausted_effort_does_not_accept_partial_repair(self):
        srj,p=crossing_case();r=prune_crossing_excursion(srj,p,budget_s=1e-12)
        self.assertEqual(r['status'],'geometry_reject')
        self.assertFalse(r['qualified'])


if __name__=='__main__':
    unittest.main()
