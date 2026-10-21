// Persistent bounded JSON-lines compute worker. No board mutation or acceptance authority.
#import <Foundation/Foundation.h>
#import <Metal/Metal.h>
#ifdef PCB_COREML
#import "coreml.hpp"
#endif
#include <algorithm>
#include <chrono>
#include <cmath>
#include <iostream>
#include <stdexcept>
#include <string>
#include <vector>

static constexpr uint32_t INF=1000000000, MAX_CELLS=1048576, MAX_VALUES=4194304;
static constexpr size_t MAX_BYTES=128*1024*1024;
using Clock=std::chrono::steady_clock;
static double ms(Clock::time_point begin) {
    return std::chrono::duration<double,std::milli>(Clock::now()-begin).count();
}
static void require(bool value,const char* message) { if(!value) throw std::runtime_error(message); }
static NSArray* array(id value) {
    require([value isKindOfClass:[NSArray class]],"expected array"); return value;
}
static uint32_t integer(id value,uint32_t low,uint32_t high) {
    require([value isKindOfClass:[NSNumber class]],"expected integer");
    require(CFGetTypeID((__bridge CFTypeRef)value)!=CFBooleanGetTypeID(),"boolean is not an integer");
    double d=[value doubleValue];
    require(std::isfinite(d)&&d>=low&&d<=high&&std::floor(d)==d,"integer outside bounds");
    return (uint32_t)d;
}
// Coordinates lie on a 0.5 grid; they are held exactly as int32 half-units.
static int32_t half(id value) {
    require([value isKindOfClass:[NSNumber class]],"expected number");
    require(CFGetTypeID((__bridge CFTypeRef)value)!=CFBooleanGetTypeID(),"boolean is not a coordinate");
    double d=[value doubleValue]; require(std::isfinite(d)&&std::abs(d)<=1e9,"coordinate outside bounds");
    require(std::floor(2*d)==2*d,"coordinate is not on the 0.5 grid");
    return (int32_t)(2*d);
}
template<typename T> static NSArray* numbers(const std::vector<T>& values) {
    NSMutableArray* out=[NSMutableArray arrayWithCapacity:values.size()];
    for(T value:values) [out addObject:@(value)];
    return out;
}

@interface Compute : NSObject
@property(nonatomic,strong) id<MTLDevice> device;
@property(nonatomic,strong) id<MTLCommandQueue> queue;
@property(nonatomic,strong) NSMutableDictionary<NSString*,id<MTLComputePipelineState>>* pipelines;
@property(nonatomic,strong) NSMutableArray<id<MTLBuffer>>* buffers;
@property(nonatomic,strong) NSMutableDictionary<NSString*,NSDictionary*>* snapshots;
@property(nonatomic) NSUInteger snapshotBytes;
@property(nonatomic,copy) NSString* unavailable;
@property(nonatomic) double compilationMs;
- (instancetype)initWithShader:(NSString*)path;
- (NSDictionary*)request:(NSDictionary*)request;
@end

@implementation Compute
- (instancetype)initWithShader:(NSString*)path {
    if((self=[super init])) {
        self.pipelines=[NSMutableDictionary dictionary]; self.buffers=[NSMutableArray array];
        self.snapshots=[NSMutableDictionary dictionary];
        auto start=Clock::now(); self.device=MTLCreateSystemDefaultDevice();
        if(!self.device) { self.unavailable=@"No Metal device"; return self; }
        NSError* error=nil;
        NSString* source=[NSString stringWithContentsOfFile:path encoding:NSUTF8StringEncoding error:&error];
        id<MTLLibrary> library=source?[self.device newLibraryWithSource:source options:nil error:&error]:nil;
        if(!library) { self.unavailable=error.localizedDescription?:@"Metal shader compilation failed"; return self; }
        for(NSString* name in @[@"hpwl",@"congestion",@"field"]) {
            id<MTLComputePipelineState> pipeline=[self.device newComputePipelineStateWithFunction:[library newFunctionWithName:name] error:&error];
            if(!pipeline) { self.unavailable=error.localizedDescription; return self; }
            self.pipelines[name]=pipeline;
        }
        self.queue=[self.device newCommandQueue];
        if(!self.queue) self.unavailable=@"Metal command queue allocation failed";
        self.compilationMs=ms(start);
    }
    return self;
}
- (id<MTLBuffer>)buffer:(NSUInteger)slot length:(NSUInteger)length {
    length=std::max<NSUInteger>(length,4);
    require(length<=MAX_BYTES,"buffer exceeds allocation budget");
    while(self.buffers.count<=slot) {
        id<MTLBuffer> empty=[self.device newBufferWithLength:4 options:MTLResourceStorageModeShared];
        require(empty!=nil,"Metal buffer allocation failed"); [self.buffers addObject:empty];
    }
    NSUInteger total=length;
    for(NSUInteger i=0;i<self.buffers.count;i++) if(i!=slot) total+=self.buffers[i].length;
    require(total<=MAX_BYTES,"resident buffers exceed allocation budget");
    id<MTLBuffer> result=self.buffers[slot];
    if(result.length<length) {
        result=[self.device newBufferWithLength:length options:MTLResourceStorageModeShared];
        require(result!=nil,"Metal buffer allocation failed"); self.buffers[slot]=result;
    }
    return result;
}
- (void)dispatch:(NSString*)name count:(NSUInteger)count buffers:(NSArray*)buffers dims:(const uint32_t*)dims command:(id<MTLCommandBuffer>)command {
    id<MTLComputeCommandEncoder> encoder=[command computeCommandEncoder];
    require(encoder!=nil,"Metal encoder allocation failed");
    id<MTLComputePipelineState> pipeline=self.pipelines[name];
    [encoder setComputePipelineState:pipeline];
    for(NSUInteger i=0;i<buffers.count;i++) [encoder setBuffer:buffers[i] offset:0 atIndex:i];
    [encoder setBytes:dims length:sizeof(uint32_t)*4 atIndex:buffers.count];
    NSUInteger threads=std::min<NSUInteger>(256,pipeline.maxTotalThreadsPerThreadgroup);
    [encoder dispatchThreads:MTLSizeMake(count,1,1) threadsPerThreadgroup:MTLSizeMake(threads,1,1)];
    [encoder endEncoding];
}
- (double)finish:(id<MTLCommandBuffer>)command {
    [command commit]; [command waitUntilCompleted];
    if(command.status!=MTLCommandBufferStatusCompleted)
        throw std::runtime_error((command.error.localizedDescription?:@"Metal command failed").UTF8String);
    return (command.GPUEndTime-command.GPUStartTime)*1000;
}
- (NSDictionary*)request:(NSDictionary*)r {
    auto start=Clock::now();
    NSString* op=r[@"op"];
    require([op isKindOfClass:[NSString class]],"op must be string");
    if([op isEqual:@"snapshot.put"]) {
        NSString* key=r[@"snapshot_id"];
        require([key isKindOfClass:[NSString class]]&&key.length==64,"snapshot identity required");
        require([r[@"snapshot_data"] isKindOfClass:[NSDictionary class]],"snapshot data required");
        require([@[@"placement_hpwl",@"congestion",@"cost_field"] containsObject:r[@"snapshot_op"]],"unsupported snapshot operation");
        NSDictionary* snapshot=@{@"op":r[@"snapshot_op"],@"revision":r[@"revision"],@"data":r[@"snapshot_data"]};
        NSDictionary* existing=self.snapshots[key];
        if(existing) require([existing isEqual:snapshot],"immutable snapshot identity collision");
        else {
            NSUInteger bytes=[NSJSONSerialization dataWithJSONObject:snapshot options:0 error:nil].length;
            require(self.snapshots.count<8&&self.snapshotBytes+bytes<=16*1024*1024,"snapshot cache budget exceeded");
            self.snapshots[key]=snapshot;self.snapshotBytes+=bytes;
        }
        return @{@"ok":@YES,@"result":@{@"snapshot_id":key},
                 @"metrics":@{@"backend":@"cpu",@"dispatches":@0,@"snapshot_bytes":@(self.snapshotBytes)}};
    }
    if(r[@"snapshot_id"]) {
        NSDictionary* snapshot=self.snapshots[r[@"snapshot_id"]];
        require(snapshot&&[snapshot[@"revision"] isEqual:r[@"revision"]]&&[snapshot[@"op"] isEqual:op],"snapshot operation or revision mismatch");
        NSMutableDictionary* merged=[snapshot[@"data"] mutableCopy];
        [merged addEntriesFromDictionary:r];r=merged;
    }
#ifdef PCB_COREML
    if([op hasPrefix:@"coreml."]) return pcb_coreml_request(r);
#endif
    if([op isEqual:@"capabilities"]) {
        return @{@"ok":@YES,@"result":@{
            @"metal_available":@(self.queue!=nil&&self.unavailable==nil),
            @"device":self.device.name?:@"none",@"cpu_available":@YES,
            @"coreml_available":
#ifdef PCB_COREML
                @YES,
#else
                @NO,
#endif
            @"max_resident_bytes":@(MAX_BYTES),@"max_grid_cells":@(MAX_CELLS),
            @"compilation_ms":@(self.compilationMs)},
            @"metrics":@{@"backend":@"cpu",@"dispatches":@0,@"fallback_reason":self.unavailable?:[NSNull null]}};
    }
    NSString* requested=r[@"backend"]?:@"auto";
    require([@[@"cpu",@"metal",@"auto"] containsObject:requested],"invalid backend");
    bool gpu=[requested isEqual:@"metal"]&&self.queue&&self.unavailable==nil;
    NSString* fallback=(![requested isEqual:@"cpu"]&&!gpu)?self.unavailable:nil;
    if([requested isEqual:@"auto"]&&self.queue&&self.unavailable==nil)
        fallback=@"automatic Metal selection awaits end-to-end workload calibration";
    NSUInteger dispatches=0; double gpuMs=0;
    NSDictionary* result=nil;
    if([op isEqual:@"placement_hpwl"]) {
        NSArray* candidates=array(r[@"candidates"]); NSArray* nets=array(r[@"nets"]);
        require(candidates.count>0,"empty candidates");
        require(nets.count<=MAX_VALUES,"net count exceeds budget");
        NSUInteger pinCount=array(candidates[0]).count;
        require(pinCount>0&&pinCount<=MAX_VALUES&&candidates.count<=MAX_VALUES/(2*pinCount),"candidate allocation exceeds budget");
        NSUInteger candidateCount=candidates.count;
        std::vector<int32_t> xy; std::vector<uint32_t> pins,offsets{0};
        for(NSArray* candidateValue in candidates) {
            NSArray* candidate=array(candidateValue); require(candidate.count==pinCount,"candidate pin counts differ");
            for(id pairValue in candidate) {
                NSArray* pair=array(pairValue); require(pair.count==2,"positions must be XY pairs");
                xy.push_back(half(pair[0]));xy.push_back(half(pair[1]));
            }
        }
        if(r[@"candidate_deltas"]) {
            NSArray* deltas=array(r[@"candidate_deltas"]);
            require(candidates.count==1&&deltas.count>0&&deltas.count<=MAX_VALUES/(2*pinCount),"sparse proposals exceed budget");
            candidateCount=deltas.count;
            const std::vector<int32_t> base=xy;
            xy.resize(candidateCount*pinCount*2);
            for(NSUInteger c=0;c<candidateCount;c++) {
                std::copy(base.begin(),base.end(),xy.begin()+c*pinCount*2);
                std::vector<bool> seen(pinCount,false);
                for(id entryValue in array(deltas[c])) {
                    NSArray* entry=array(entryValue);require(entry.count==3,"delta requires pin and XY displacement");
                    uint32_t pin=integer(entry[0],0,(uint32_t)pinCount-1);
                    require(!seen[pin],"duplicate delta pin");seen[pin]=true;
                    size_t index=(c*pinCount+pin)*2;
                    int64_t nx=(int64_t)xy[index]+half(entry[1]),ny=(int64_t)xy[index+1]+half(entry[2]);
                    require(std::llabs(nx)<=2000000000&&std::llabs(ny)<=2000000000,"delta coordinate exceeds bounds");
                    xy[index]=(int32_t)nx;xy[index+1]=(int32_t)ny;
                }
            }
        }
        for(id netValue in nets) {
            NSArray* net=array(netValue);
            require(pins.size()+net.count<=MAX_VALUES,"net allocation exceeds budget");
            for(id value in net) pins.push_back(integer(value,0,(uint32_t)pinCount-1));
            offsets.push_back((uint32_t)pins.size());
        }
        require(nets.count<=MAX_VALUES,"net count exceeds budget");
        require((uint64_t)candidateCount*(pins.size()+nets.count)<=100000000,"placement work exceeds budget");
        std::vector<int64_t> scores(candidateCount,0);
        if(gpu) {
            id<MTLBuffer> p=[self buffer:0 length:xy.size()*4],n=[self buffer:1 length:pins.size()*4],
                o=[self buffer:2 length:offsets.size()*4],s=[self buffer:3 length:scores.size()*8];
            memcpy(p.contents,xy.data(),xy.size()*4); memcpy(n.contents,pins.data(),pins.size()*4); memcpy(o.contents,offsets.data(),offsets.size()*4);
            uint32_t dims[4]={(uint32_t)candidateCount,(uint32_t)pinCount,(uint32_t)nets.count,0};
            id<MTLCommandBuffer> command=[self.queue commandBuffer];
            [self dispatch:@"hpwl" count:candidateCount buffers:@[p,n,o,s] dims:dims command:command];
            gpuMs+=[self finish:command];dispatches++;
            memcpy(scores.data(),s.contents,scores.size()*8);
        } else {
            for(NSUInteger c=0;c<candidateCount;c++) for(NSUInteger n=0;n<nets.count;n++) {
                int32_t loX=INT32_MAX,loY=INT32_MAX,hiX=INT32_MIN,hiY=INT32_MIN;
                for(uint32_t j=offsets[n];j<offsets[n+1];j++) {
                    size_t index=(c*pinCount+pins[j])*2;
                    loX=std::min(loX,xy[index]);hiX=std::max(hiX,xy[index]);
                    loY=std::min(loY,xy[index+1]);hiY=std::max(hiY,xy[index+1]);
                }
                if(offsets[n]!=offsets[n+1]) scores[c]+=((int64_t)hiX-loX)+((int64_t)hiY-loY);
            }
        }
        NSMutableArray* exact=[NSMutableArray arrayWithCapacity:scores.size()];
        for(int64_t total:scores) [exact addObject:total%2==0?@(total/2):@((double)total/2)];
        result=@{@"scores":exact,@"primitive":@"hpwl",@"complete_objective":@NO};
    } else if([op isEqual:@"congestion"]||[op isEqual:@"cost_field"]) {
        uint32_t w=integer(r[@"width"],1,MAX_CELLS),h=integer(r[@"height"],1,MAX_CELLS),
            layers=r[@"layers"]?integer(r[@"layers"],1,64):1;
        require((uint64_t)w*h*layers<=MAX_CELLS,"grid allocation exceeds budget");
        uint32_t size=w*h*layers,plane=w*h;
        std::vector<uint32_t> values(size,0);
        if([op isEqual:@"congestion"]) {
            require(layers==1,"congestion supports one layer per request");
            NSArray* segments=array(r[@"segments"]);
            require(segments.count<=MAX_CELLS&&(uint64_t)size*segments.count<=100000000,"congestion work exceeds budget");
            std::vector<uint32_t> segs;
            for(id item in segments) {
                NSArray* s=array(item);require(s.count==4,"segment needs four coordinates");
                for(NSUInteger j=0;j<4;j++) segs.push_back(integer(s[j],0,(j%2?h:w)-1));
            }
            if(gpu) {
                id<MTLBuffer> s=[self buffer:0 length:segs.size()*4],v=[self buffer:1 length:size*4];
                memcpy(s.contents,segs.data(),segs.size()*4);
                uint32_t dims[4]={w,h,(uint32_t)segments.count,0};
                id<MTLCommandBuffer> command=[self.queue commandBuffer];
                [self dispatch:@"congestion" count:size buffers:@[s,v] dims:dims command:command];
                gpuMs+=[self finish:command];dispatches++;memcpy(values.data(),v.contents,size*4);
            } else {
                for(size_t j=0;j<segs.size();j+=4)
                    for(uint32_t y=std::min(segs[j+1],segs[j+3]);y<=std::max(segs[j+1],segs[j+3]);y++)
                        for(uint32_t x=std::min(segs[j],segs[j+2]);x<=std::max(segs[j],segs[j+2]);x++) values[y*w+x]++;
            }
            result=@{@"counts":numbers(values),@"primitive":@"bounding_box_demand"};
        } else {
            uint32_t sweeps=r[@"max_sweeps"]?integer(r[@"max_sweeps"],1,4096):std::min(size,4096u);
            require((uint64_t)size*sweeps<=100000000,"field work exceeds budget");
            std::fill(values.begin(),values.end(),INF);
            std::vector<uint32_t> blocked(size,0),next(size,INF);
            NSArray* blockIndices=array(r[@"blocked"]),*targets=array(r[@"targets"]);
            require(blockIndices.count<=size&&targets.count<=size,"too many grid indices");
            for(id i in blockIndices) blocked[integer(i,0,size-1)]=1;
            for(id i in targets) {uint32_t index=integer(i,0,size-1);if(!blocked[index]) values[index]=0;}
            bool converged=false;uint32_t performed=0;
            if(gpu) {
                id<MTLBuffer> a=[self buffer:0 length:size*4],b=[self buffer:1 length:size*4],blocks=[self buffer:2 length:size*4];
                memcpy(a.contents,values.data(),size*4);memcpy(blocks.contents,blocked.data(),size*4);
                uint32_t dims[4]={w,h,layers,0};
                while(performed<sweeps&&!converged) {
                    uint32_t count=std::min(32u,sweeps-performed);
                    id<MTLCommandBuffer> command=[self.queue commandBuffer];
                    for(uint32_t j=0;j<count;j++) {
                        [self dispatch:@"field" count:size buffers:@[a,b,blocks] dims:dims command:command];
                        id<MTLBuffer> tmp=a;a=b;b=tmp;
                    }
                    gpuMs+=[self finish:command];dispatches+=count;performed+=count;
                    converged=memcmp(a.contents,b.contents,size*4)==0;
                }
                memcpy(values.data(),a.contents,size*4);
            } else {
                // Unit weights admit linear-time BFS. Compare Metal against a
                // competent CPU algorithm, not a deliberately scalar GPU sweep.
                std::vector<uint32_t> queue;queue.reserve(size);
                for(uint32_t i=0;i<size;i++) if(values[i]==0)queue.push_back(i);
                uint32_t maximum=0;
                for(size_t head=0;head<queue.size();head++) {
                    uint32_t i=queue[head];
                    if(values[i]>=sweeps)continue;
                    uint32_t x=i%w,y=i/w%h;
                    auto visit=[&](uint32_t j) {
                        if(!blocked[j]&&values[j]==INF) {
                            values[j]=values[i]+1;maximum=values[j];queue.push_back(j);
                        }
                    };
                    if(x)visit(i-1);if(x+1<w)visit(i+1);
                    if(y)visit(i-w);if(y+1<h)visit(i+w);
                    if(i>=plane)visit(i-plane);if(i+plane<size)visit(i+plane);
                }
                performed=std::min(maximum+1,sweeps);converged=maximum<sweeps;
            }
            result=@{@"distances":numbers(values),@"converged":@(converged),@"sweeps":@(performed),
                     @"guidance_only":@YES,@"unreachable_value":@(INF)};
        }
    } else throw std::runtime_error("unknown compute operation");
    NSUInteger resident=0;for(id<MTLBuffer> buffer in self.buffers)resident+=buffer.length;
    return @{@"ok":@YES,@"result":result,
             @"metrics":@{@"backend":gpu?@"metal":@"cpu",@"dispatches":@(dispatches),
                          @"gpu_ms":@(gpuMs),@"worker_ms":@(ms(start)),@"resident_bytes":@(resident),
                          @"snapshot_reused":@(r[@"snapshot_id"]!=nil),@"snapshot_bytes":@(self.snapshotBytes),
                          @"fallback_reason":fallback?:[NSNull null]}};
}
@end

int main(int argc,char** argv) {
    @autoreleasepool {
        if(argc!=2) return 2;
        Compute* compute=[[Compute alloc]initWithShader:[NSString stringWithUTF8String:argv[1]]];
        std::string line;
        while(std::getline(std::cin,line)) {
            @autoreleasepool {
                NSDictionary* request=nil;NSMutableDictionary* response=nil;
                try {
                    require(line.size()<=64*1024*1024,"request exceeds byte budget");
                    NSData* data=[NSData dataWithBytes:line.data() length:line.size()];
                    id decoded=[NSJSONSerialization JSONObjectWithData:data options:0 error:nil];
                    require([decoded isKindOfClass:[NSDictionary class]],"request must be JSON object");
                    request=decoded;
                    require([request[@"id"] isKindOfClass:[NSString class]]&&[request[@"revision"] isKindOfClass:[NSString class]],"request identity required");
                    response=[[compute request:request] mutableCopy];
                } catch(const std::exception& e) {
                    response=[@{@"ok":@NO,@"error":[NSString stringWithUTF8String:e.what()]} mutableCopy];
                }
                response[@"id"]=request[@"id"]?:[NSNull null];
                response[@"revision"]=request[@"revision"]?:[NSNull null];
                NSData* encoded=[NSJSONSerialization dataWithJSONObject:response options:0 error:nil];
                if(!encoded) encoded=[@"{\"ok\":false,\"error\":\"response serialization failed\"}" dataUsingEncoding:NSUTF8StringEncoding];
                std::cout.write((const char*)encoded.bytes,encoded.length);std::cout<<std::endl;
            }
        }
    }
    return 0;
}
