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


def vector(x,y=0):return SimpleNamespace(x=x,y=y)


class Track:
    def __init__(self,layer):self.layer=layer
    def GetNetname(self):return 'P'
    def GetClass(self):return 'PCB_TRACK'
    def GetLayer(self):return self.layer
    def GetLayerName(self):return {0:'F.Cu',2:'B.Cu'}[self.layer]
    def GetStart(self):return vector(0)
    def GetEnd(self):return vector(1000000)
    def GetWidth(self):return 200000
    def HitTest(self,q):return q.y==0 and 0<=q.x<=1000000


class Via:
    def __init__(self,x,bottom=2):self.x=x;self.bottom=bottom
    def GetNetname(self):return 'P'
    def GetPosition(self):return vector(self.x)
    def TopLayer(self):return 0
    def BottomLayer(self):return self.bottom
    def GetViaType(self):return 4
    def GetDrillValue(self):return 300000
    def HitTest(self,q):return (q.x-self.x)**2+q.y**2<=300000**2


def native_like(tracks):
    p=SimpleNamespace(ToMM=lambda n:n/1000000.,FromMM=lambda n:round(n*1000000),PCB_VIA=Via,VECTOR2I=vector)
    b=SimpleNamespace(GetTracks=lambda:tracks,GetFootprints=lambda:[],Zones=lambda:[])
    return p,b


if __name__=='__main__':unittest.main()
