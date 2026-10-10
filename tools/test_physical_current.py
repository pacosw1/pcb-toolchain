import unittest
from types import SimpleNamespace
import pcbtool


class PhysicalCurrentTests(unittest.TestCase):
    def graph(self,records):
        items=pcbtool.physical_conductors(records,lambda r:r['geometry'],lambda r:-r['amps'])
        return [(r['a'],r['b'],r['amps'],r['label']) for r in items]

    def test_duplicate_copper_uuid_or_label_cannot_double_area(self):
        r=dict(geometry=('F.Cu',(0,0),(1,0)),a='a',b='b',amps=1.,label='first')
        duplicate=dict(r,label='different UUID and diagnostic label')
        self.assertEqual(pcbtool.max_flow(self.graph([r,duplicate]),'a','b')[0],1.)

    def test_real_parallel_distinct_paths_preserved(self):
        records=[dict(geometry=g,a='a',b='b',amps=1.,label='same label') for g in
                 [('F.Cu',(0,0),(1,0)),('B.Cu',(0,0),(1,0))]]
        self.assertEqual(pcbtool.max_flow(self.graph(records),'a','b')[0],2.)

    def test_same_centerline_wider_union_only(self):
        a=dict(geometry=('F.Cu',(0,0),(1,0)),a='a',b='b',amps=1.,label='narrow')
        b=dict(a,amps=2.,label='wide')
        self.assertEqual(pcbtool.max_flow(self.graph([a,b]),'a','b')[0],2.)

    def test_duplicate_vias_conservative_drill_distinct_positions(self):
        vias=[dict(pos=(0,0),drill=.3),dict(pos=(0,0),drill=.4),dict(pos=(1,0),drill=.3)]
        result=pcbtool.physical_conductors(vias,lambda r:r['pos'],lambda r:r['drill'])
        self.assertEqual(result,[vias[0],vias[2]])
        self.assertEqual(len(vias),3)

    def test_actual_net_graph_ingestion_track_replays_and_real_layers(self):
        tracks=[Track(0),Track(0),Track(2)]
        p,b=native_like(tracks)
        edges,_=pcbtool.net_graph(p,b,'P',{'F.Cu':.035,'B.Cu':.035},20,.018)
        self.assertEqual(len(edges),2)
        self.assertEqual({e[0][0] for e in edges},{'F.Cu','B.Cu'})
        # The graph itself supplies one conductor for duplicate F.Cu tracks.
        amps=pcbtool.ipc_amps(.2,.035,20)
        self.assertAlmostEqual(pcbtool.max_flow(edges,('F.Cu',(0.,0.)),('F.Cu',(1.,0.)))[0],amps)

    def test_actual_net_graph_ingestion_coincident_via_and_span(self):
        tracks=[Track(0),Track(2),Via(0),Via(0),Via(1000000)]
        p,b=native_like(tracks)
        edges,_=pcbtool.net_graph(p,b,'P',{'F.Cu':.035,'B.Cu':.035},20,.018)
        via_nodes={node for e in edges for node in e[:2] if isinstance(node,tuple) and node[0]=='via'}
        self.assertEqual(len(via_nodes),2)
        # Same position with a different physical span must remain separate.
        tracks=[Track(0),Track(2),Via(0),Via(0,bottom=6)]
        p,b=native_like(tracks)
        edges,_=pcbtool.net_graph(p,b,'P',{'F.Cu':.035,'B.Cu':.035},20,.018)
        via_nodes={node for e in edges for node in e[:2] if isinstance(node,tuple) and node[0]=='via'}
        self.assertEqual(len(via_nodes),2)

    def test_actual_duplicate_via_cannot_uplift_barrel_area(self):
        pads=[Pad('A',0),Pad('B',2)]
        def capacity(vias):
            p,b=native_like(vias,pads)
            edges,_=pcbtool.net_graph(p,b,'P',{},10,.018)
            return pcbtool.pair_capacity(edges,'A.1','B.1',False)[0]
        self.assertAlmostEqual(capacity([Via(0)]),pcbtool.via_group_amps([.3]))
        self.assertEqual(capacity([Via(0)]),capacity([Via(0),Via(0)]))

    def test_distinct_parallel_via_area_is_preserved(self):
        pads=[Pad('A',0,radius=1000000),Pad('B',2,radius=1000000)]
        p,b=native_like([Via(0),Via(1000000)],pads)
        edges,_=pcbtool.net_graph(p,b,'P',{},10,.018)
        self.assertAlmostEqual(pcbtool.widest_path(edges,'A.1','B.1')[0],pcbtool.via_group_amps([.3,.3]))

    def test_actual_distinct_parallel_tracks_preserve_capacity(self):
        pads=[Pad('A',(0,2)),Pad('B',(0,2),x=1000000)]
        p,b=native_like([Track(0),Track(2)],pads)
        edges,_=pcbtool.net_graph(p,b,'P',{},10,.018)
        self.assertAlmostEqual(pcbtool.max_flow(edges,'A.1','B.1')[0],2*pcbtool.ipc_amps(.2))

    def test_blind_via_cannot_create_front_to_back_track_path(self):
        p,b=native_like([Track(0),Track(2),Via(0,bottom=6)])
        edges,_=pcbtool.net_graph(p,b,'P',{},10,.018)
        self.assertEqual(pcbtool.widest_path(edges,('F.Cu',(0.,0.)),('B.Cu',(0.,0.)))[0],0.)

    def test_blind_via_cannot_contact_back_only_pad(self):
        p,b=native_like([Via(0,bottom=6)],[Pad('A',0),Pad('B',2)])
        edges,_=pcbtool.net_graph(p,b,'P',{},10,.018)
        self.assertEqual(pcbtool.widest_path(edges,'A.1','B.1')[0],0.)

    def test_off_layer_via_cannot_split_track(self):
        p,b=native_like([Track(2),Via(500000,bottom=6)])
        edges,_=pcbtool.net_graph(p,b,'P',{},10,.018)
        self.assertEqual(len(edges),1)

    def test_same_width_branch_does_not_create_thermal_uplift(self):
        def capacities(tracks):
            p,b=native_like(tracks)
            edges,_=pcbtool.net_graph(p,b,'P',{},10,.018)
            return [e[2] for e in edges if e[3].startswith('F.Cu')]
        rail=Track(0,end=5000000)
        with_branch=[rail,Track(0,start=2500000,end=2500000,end_y=100000)]
        base=pcbtool.ipc_amps(.2)
        self.assertEqual(capacities([rail]),[base])
        self.assertTrue(all(a==base for a in capacities(with_branch)))

    def test_unproved_short_pad_neck_remains_finite_base_capacity(self):
        p,b=native_like([Track(0)],[Pad('A',0),Pad('B',0,x=1000000)])
        edges,_=pcbtool.net_graph(p,b,'P',{},10,.018)
        self.assertAlmostEqual(pcbtool.widest_path(edges,'A.1','B.1')[0],pcbtool.ipc_amps(.2))

    def test_width_report_does_not_assume_pad_is_cool(self):
        seg=dict(net='P',width=.2,start=(0,0),end=(.1,0),layer='F.Cu')
        pads=[dict(net='P',pos=(0,0),minor=.2)]
        report=pcbtool.width_report([seg],{'P':1.},pads)
        self.assertEqual(report['P']['necks'],0)
        self.assertEqual(len(report['P']['under']),1)

    def test_analytical_neck_formula_does_not_authorize_graph_uplift(self):
        self.assertGreater(pcbtool.neck_amps(.2,.035,.1),pcbtool.ipc_amps(.2))
        self.assertEqual(pcbtool.track_amps(.2,.035,10,(.1,.2)),pcbtool.ipc_amps(.2))


def vector(x,y=0):return SimpleNamespace(x=x,y=y)


class Track:
    def __init__(self,layer,start=0,end=1000000,end_y=0):self.layer=layer;self.start=start;self.end=end;self.end_y=end_y
    def GetNetname(self):return 'P'
    def GetClass(self):return 'PCB_TRACK'
    def GetLayer(self):return self.layer
    def GetLayerName(self):return {0:'F.Cu',2:'B.Cu'}[self.layer]
    def GetStart(self):return vector(self.start)
    def GetEnd(self):return vector(self.end,self.end_y)
    def GetWidth(self):return 200000
    def HitTest(self,q):return pcbtool.seg_dist((q.x,q.y),(self.start,0),(self.end,self.end_y))<.001


class Via:
    def __init__(self,x,bottom=2):self.x=x;self.bottom=bottom
    def GetNetname(self):return 'P'
    def GetPosition(self):return vector(self.x)
    def TopLayer(self):return 0
    def BottomLayer(self):return self.bottom
    def GetViaType(self):return 4
    def GetDrillValue(self):return 300000
    def IsOnLayer(self,layer):return layer in [0,4,6,2][:([0,4,6,2].index(self.bottom)+1)]
    def HitTest(self,q):return (q.x-self.x)**2+q.y**2<=300000**2


class Pad:
    def __init__(self,ref,layer,x=0,radius=1000):self.ref=ref;self.layer=layer;self.x=x;self.radius=radius
    def GetNumber(self):return '1'
    def GetNetname(self):return 'P'
    def IsOnLayer(self,layer):return layer in self.layer if isinstance(self.layer,tuple) else layer==self.layer
    def GetPosition(self):return vector(self.x)
    def HitTest(self,q):return (q.x-self.x)**2+q.y**2<=self.radius**2


def native_like(tracks,pads=()):
    p=SimpleNamespace(ToMM=lambda n:n/1000000.,FromMM=lambda n:round(n*1000000),PCB_VIA=Via,VECTOR2I=vector)
    names={0:'F.Cu',4:'In1.Cu',6:'In2.Cu',2:'B.Cu'}
    fps=[SimpleNamespace(Pads=lambda pad=pad:[pad],GetReference=lambda pad=pad:pad.ref) for pad in pads]
    b=SimpleNamespace(GetTracks=lambda:tracks,GetFootprints=lambda:fps,Zones=lambda:[],
                      GetLayerID=lambda name:next(k for k,v in names.items() if v==name),
                      GetEnabledLayers=lambda:SimpleNamespace(CuStack=lambda:list(names)))
    return p,b


if __name__=='__main__':unittest.main()
