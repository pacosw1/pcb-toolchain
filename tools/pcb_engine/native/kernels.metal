#include <metal_stdlib>
using namespace metal;
// Exact integer HPWL: int32 half-unit coordinates, int64 sum.
kernel void hpwl(device const int2* xy [[buffer(0)]],
                 device const uint* pins [[buffer(1)]],
                 device const uint* offsets [[buffer(2)]],
                 device long* scores [[buffer(3)]],
                 constant uint4& dims [[buffer(4)]], uint candidate [[thread_position_in_grid]]) {
    if (candidate >= dims.x) return;
    long total = 0;
    for (uint net = 0; net < dims.z; ++net) {
        int2 lo = int2(INT_MAX), hi = int2(INT_MIN);
        for (uint j = offsets[net]; j < offsets[net+1]; ++j) {
            int2 p = xy[candidate*dims.y + pins[j]];
            lo = min(lo,p); hi = max(hi,p);
        }
        if (offsets[net] != offsets[net+1]) total += (long(hi.x)-long(lo.x))+(long(hi.y)-long(lo.y));
    }
    scores[candidate] = total;
}
kernel void congestion(device const uint4* segments [[buffer(0)]],
                       device uint* counts [[buffer(1)]],
                       constant uint4& dims [[buffer(2)]], uint i [[thread_position_in_grid]]) {
    if (i >= dims.x*dims.y) return;
    uint x=i%dims.x, y=i/dims.x, count=0;
    for (uint j=0;j<dims.z;++j) {
        uint4 s=segments[j];
        count += x>=min(s.x,s.z) && x<=max(s.x,s.z) && y>=min(s.y,s.w) && y<=max(s.y,s.w);
    }
    counts[i]=count;
}
kernel void field(device const uint* previous [[buffer(0)]],
                  device uint* next [[buffer(1)]],
                  device const uint* blocked [[buffer(2)]],
                  constant uint4& dims [[buffer(3)]], uint i [[thread_position_in_grid]]) {
    uint plane=dims.x*dims.y, size=plane*dims.z;
    if (i>=size) return;
    if (blocked[i]) { next[i]=1000000000; return; }
    uint x=i%dims.x,y=i/dims.x%dims.y,best=previous[i];
    if (x>0) best=min(best,previous[i-1]+1);
    if (x+1<dims.x) best=min(best,previous[i+1]+1);
    if (y>0) best=min(best,previous[i-dims.x]+1);
    if (y+1<dims.y) best=min(best,previous[i+dims.x]+1);
    if (i>=plane) best=min(best,previous[i-plane]+1);
    if (i+plane<size) best=min(best,previous[i+plane]+1);
    next[i]=best;
}
