"""CPU patches for Cypress 743b07c (run inside the container before Placer.py). Each replace must hit once."""
import sys
def sub(path, old, new):
    t = open(path).read()
    if t.count(old) != 1:
        sys.exit('patch miss in %s: %r' % (path, old[:60]))
    open(path, 'w').write(t.replace(old, new))
D = '/Cypress/install/dreamplace/'
# 1. fixed nodes: the movable-macro mask is indexed with fixed node ids (no Cypress benchmark has a fixed node)
sub(D + 'PlaceDB.py', 'self.movable_macro_mask[self.top_nodes_idx]',
    'self.movable_macro_mask[self.top_nodes_idx[self.top_nodes_idx < self.num_movable_nodes]]')
sub(D + 'PlaceDB.py', 'self.movable_macro_mask[self.btm_nodes_idx]',
    'self.movable_macro_mask[self.btm_nodes_idx[self.btm_nodes_idx < self.num_movable_nodes]]')
# 2. CPU pin_pos: the module omits theta/num_physical_nodes/h/w; the CPU backward gets GPU-only arguments.
P = D + 'ops/pin_pos/pin_pos.py'
sub(P, """            return PinPosFunction.apply(pos, self.pin_offset_x,
                                        self.pin_offset_y, self.pin2node_map,
                                        self.flat_node2pin_map,
                                        self.flat_node2pin_start_map,
                                        self.num_physical_nodes)""",
    """            return PinPosFunction.apply(pos, self.pin_offset_x,
                                        self.pin_offset_y, self.theta, self.pin2node_map,
                                        self.flat_node2pin_map,
                                        self.flat_node2pin_start_map,
                                        self.num_physical_nodes, self.h, self.w)""")
t = open(P).read()
i = t.index('def backward(ctx, grad_pin_pos)')
j = t.index('ctx.num_physical_nodes)', i) + len('ctx.num_physical_nodes)')
seg = t[i:j]
new = seg.replace('''        output = func(''', '''        if not grad_pin_pos.is_cuda:
            output = func(grad_pin_pos.contiguous(), ctx.pos, ctx.pin_offset_x,
                          ctx.pin_offset_y, ctx.pin2node_map, ctx.flat_node2pin_map,
                          ctx.flat_node2pin_start_map, ctx.num_physical_nodes)
        else:
          output = func(''', 1)
open(P, 'w').write(t[:i] + new + t[j:])
# 3. CPU net_crossing: the C++ op has no pin_side argument (one-sided crossing; all our parts are on top).
sub(D + 'ops/net_crossing/net_crossing.py',
    'net_crossing_cpp.forward(pos.view(pos.numel()), flat_netpin, netpin_start, net_mask, pin_side, _lambda, _mu, _sigma)',
    'net_crossing_cpp.forward(pos.view(pos.numel()), flat_netpin, netpin_start, net_mask, _lambda, _mu, _sigma)')
print('patched')
