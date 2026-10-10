import copy
import unittest
from unittest import mock
import import_replay_guard as guard


class ReplayGuardTests(unittest.TestCase):
    def setUp(self):
        self.geometry=('segment','P','F.Cu',200000,((1000,2000),(3000,2000)))
        self.source={'old':dict(geometry=self.geometry,policy=['segment',['locked','yes']])}
        self.after=copy.deepcopy(self.source)
        self.after['new']=dict(geometry=self.geometry,policy=['segment',['locked','no']])
        self.dsn={self.geometry:['route']};self.ses={self.geometry:['protect']}

    def plan(self,**kw):
        args=dict(before=self.source,after=self.after,preserved={'old'},dsn=self.dsn,ses=self.ses)
        args.update(kw);return guard.removal_plan(**args)

    def test_exact_explicit_source_route_protected_replay(self):
        self.assertEqual(self.plan()[0]['retained_uuid'],'old')
        self.assertEqual(self.plan()[0]['dsn_modes'],['route'])

    def test_repeated_protected_ses_copies_removed(self):
        self.after['new2']=copy.deepcopy(self.after['new'])
        self.assertEqual(len(self.plan(ses={self.geometry:['protect','protect']})),2)

    def test_source_duplicates_retained_without_replay(self):
        source=dict(self.source,old2=copy.deepcopy(self.source['old']))
        self.assertEqual(self.plan(before=source,after=copy.deepcopy(source),preserved=set(source)),[])
        with self.assertRaisesRegex(ValueError,'ambiguous'):
            self.plan(before=source,after=dict(self.after,old2=source['old2']),preserved=set(source))

    def test_missing_or_altered_source_policy_rejected(self):
        for change in ('missing','policy','geometry'):
            after=copy.deepcopy(self.after)
            if change=='missing':del after['old']
            elif change=='policy':after['old']['policy'].append(['tented','yes'])
            else:after['old']['geometry']=('changed',)
            with self.assertRaisesRegex(ValueError,'missing/altered'):self.plan(after=after)

    def test_unlock_source_not_eligible(self):
        with self.assertRaisesRegex(ValueError,'outside preserved'):self.plan(preserved=set())

    def test_unlocked_duplicate_source_still_ambiguous(self):
        source=dict(self.source,old2=copy.deepcopy(self.source['old']))
        with self.assertRaisesRegex(ValueError,'ambiguous'):
            self.plan(before=source,after=dict(self.after,old2=source['old2']))

    def test_absent_provenance_and_unprotected_reject(self):
        for kw in ({'dsn':{}},{'ses':{}},{'ses':{self.geometry:['route']}},
                   {'ses':{self.geometry:['unspecified']}},{'dsn':{self.geometry:['unknown']}}):
            with self.assertRaises(ValueError):self.plan(**kw)

    def test_multiplicity_reject_and_new_new_without_source_reject(self):
        with self.assertRaises(ValueError):self.plan(ses={self.geometry:['protect','protect']})
        after={'x':copy.deepcopy(self.after['new']),'y':copy.deepcopy(self.after['new'])}
        with self.assertRaisesRegex(ValueError,'new-new'):self.plan(before={},after=after,preserved=set())

    def test_net_layer_width_position_difference_is_not_removed(self):
        for index,replacement in ((1,'Q'),(2,'B.Cu'),(3,200001),(4,((1001,2000),(3000,2000)))):
            after=copy.deepcopy(self.after);g=list(self.geometry);g[index]=replacement
            after['new']['geometry']=tuple(g)
            self.assertEqual(self.plan(after=after),[])

    def test_planner_is_immutable(self):
        frozen=copy.deepcopy((self.source,self.after,self.dsn,self.ses))
        self.plan();self.assertEqual(frozen,(self.source,self.after,self.dsn,self.ses))

    def test_via_full_width_drill_span_identity(self):
        geom=('via','P',(1000,2000),(('B.Cu',600000),('F.Cu',600000)),300000,'F.Cu','B.Cu',4)
        old={'old':dict(geometry=geom,policy=['via'])};after=dict(old,new=dict(geometry=geom,policy=['new']))
        self.assertEqual(len(guard.removal_plan(old,after,{'old'},{geom:['fix']},{geom:['protect']})),1)
        for index,value in ((3,(('B.Cu',599999),('F.Cu',600000))),(4,300001),(6,'In2.Cu')):
            g=list(geom);g[index]=value;after['new']['geometry']=tuple(g)
            self.assertEqual(guard.removal_plan(old,after,{'old'},{geom:['fix']},{geom:['protect']}),[])

    def test_declared_units_polyline_reverse_and_quoted_net(self):
        dsn='(resolution um 10)(unit um)(library)(wiring (wire (path F.Cu .2 1 -2 2 -2 3 -2)(net "P A")(type route)))'
        ses='(routes(resolution um 10)(library_out)(network_out(net "P A"(wire(path F.Cu 2 30 -20 20 -20 10 -20)(type protect)))))'
        a=guard.records(dsn);b=guard.records(ses,True)
        self.assertEqual(set(a),set(b));self.assertEqual(len(a),2)

    def test_via_padstack_shape_checked(self):
        dsn='(resolution um 10)(unit um)(library(padstack "Via[0-1]_600:300_um"(shape(circle F.Cu 600))(shape(circle B.Cu 600))))(wiring(via "Via[0-1]_600:300_um" 1 -2(net P)(type fix)))'
        self.assertEqual(len(guard.records(dsn)),1)
        with self.assertRaises(ValueError):guard.records(dsn.replace('circle B.Cu 600','circle B.Cu 599'))
        with self.assertRaises(ValueError):guard.records(dsn.replace('um)','mm)',1))
        for replacement in ('(resolution mm 10)','(resolution um 0)','(resolution um 3)',''):
            with self.assertRaises(ValueError):guard.records(dsn.replace('(resolution um 10)',replacement))

    def test_preserved_arc_approximated_export_rejects(self):
        source={'old':dict(geometry=('unsupported','old'),policy=['arc'])}
        after=dict(source,new=self.after['new'])
        with self.assertRaisesRegex(ValueError,'arc replay not proved'):
            self.plan(before=source,after=after)

    def test_transaction_uses_owned_native_delete_then_verifies(self):
        class Item:
            def __init__(self,uid):self.m_Uuid=mock.Mock(AsString=lambda:uid)
        items=[Item('old'),Item('new')]
        board=mock.Mock(GetTracks=lambda:items)
        with mock.patch.object(guard,'records',side_effect=[self.dsn,self.ses]), \
             mock.patch.object(guard,'snapshot',side_effect=[self.after,self.source]), \
             mock.patch.object(guard.Path,'read_text',return_value=''):
            self.assertEqual(guard.restore(board,self.source,{'old'},'d','s','p')[0]['removed_uuid'],'new')
        board.Delete.assert_called_once_with(items[1]);board.Remove.assert_not_called()

    def test_rejected_transaction_never_deletes_any_candidate(self):
        board=mock.Mock()
        with mock.patch.object(guard,'records',side_effect=[self.dsn,{self.geometry:['route']}]), \
             mock.patch.object(guard,'snapshot',return_value=self.after), \
             mock.patch.object(guard.Path,'read_text',return_value=''):
            with self.assertRaisesRegex(ValueError,'unprotected'):
                guard.restore(board,self.source,{'old'},'d','s','p')
        board.Delete.assert_not_called();board.GetTracks.assert_not_called()


if __name__=='__main__':unittest.main()
