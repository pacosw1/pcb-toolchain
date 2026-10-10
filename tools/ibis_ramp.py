#!/usr/bin/env python3
"""Source-bound IBIS ramp and static V-I screening (D-124c).

IBIS7.2 [Ramp] defines a20–80% loaded swing, package excluded/C_comp included.
Original vendor bytes stay unchanged; corner omissions and load/PVT remain explicit.
"""
import hashlib
import json
import math
import re
import sys
from pathlib import Path

SUFFIX={'T':1e12,'G':1e9,'M':1e6,'k':1e3,'m':1e-3,'u':1e-6,'n':1e-9,'p':1e-12,'f':1e-15}
CORNERS=('typ','min','max')
_cache={}
class IbisError(ValueError):pass

def number(text):
    text=text.strip()
    if text.upper()=='NA':return None
    m=re.fullmatch(r'([-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?)([TGMkmunpf]?)([A-Za-z]*)',text)
    if not m:raise IbisError('invalid IBIS number: '+text)
    if m[3] not in ('','V','A','F','H','s','ohm','ohms','Ohm','Ohms'):raise IbisError('unsupported IBIS unit: '+text)
    value=float(m[1])*SUFFIX.get(m[2],1)
    if not math.isfinite(value):raise IbisError('nonfinite IBIS number: '+text)
    return value

def triple(words):
    if len(words)!=3:raise IbisError('expected typ/min/max triple')
    return [number(x) for x in words]

def parse(lines):
    models={};pins={};selectors={};model=comp=None;section='';selector=None
    for raw in lines:
        line=raw.split('|',1)[0].strip()
        if not line:continue
        head=re.match(r'\[([^\]]+)\]\s*(.*)',line)
        if head:
            section,arg=head[1].strip().lower(),head[2].strip()
            if section=='component':
                comp=arg;model=None
                if comp in pins:raise IbisError('duplicate component: '+comp)
                pins[comp]={}
            elif section=='model':
                key=arg.lower()
                if key in models:raise IbisError('duplicate model: '+arg)
                model={'name':arg,'type':None,'c_comp':None,'ramp':{},'vi':{},'pullup_ref':None,'r_load':50.0,'r_load_default':True,'voltage_range':None,'temperature_range':None}
                models[key]=model
            elif section=='model selector':
                selector=arg.lower()
                if selector in selectors:raise IbisError('duplicate selector: '+arg)
                selectors[selector]=[]
            elif section in ('voltage range','temperature range','pullup reference') and model is not None:
                key='pullup_ref' if section=='pullup reference' else section.replace(' ','_')
                if model[key] is not None:raise IbisError('duplicate '+section)
                model[key]=triple(arg.split())
            elif section in ('pulldown','pullup') and model is not None:
                if section in model['vi']:raise IbisError('duplicate V-I table')
                model['vi'][section]=[]
            elif section=='end':model=None
            continue
        words=line.split()
        if section=='pin' and comp is not None:
            if len(words)<3:raise IbisError('malformed pin')
            if words[0] in pins[comp]:raise IbisError('duplicate component pin')
            pins[comp][words[0]]=(words[1],words[2])
        elif section=='model selector':selectors[selector].append(words[0].lower())
        elif section=='model' and model is not None:
            if words[0].lower()=='model_type':model['type']=words[1]
            elif words[0].lower()=='c_comp':
                model['c_comp']=triple(words[1:])
                if any(v is not None and v<0 for v in model['c_comp']):raise IbisError('negative C_comp')
        elif section in ('pulldown','pullup') and model is not None:
            if len(words)!=4:raise IbisError('malformed V-I row')
            v=number(words[0]);currents=triple(words[1:])
            if v is None or currents[0] is None:raise IbisError('missing V-I voltage or typical current')
            rows=model['vi'][section]
            if rows and v<=rows[-1][0]:raise IbisError('V-I voltages must strictly increase')
            rows.append((v,currents))
        elif section=='ramp' and model is not None:
            key=words[0].lower()
            if key in ('dv/dt_r','dv/dt_f'):
                if len(words)!=4:raise IbisError('malformed ramp triple')
                vals=[]
                for word in words[1:]:
                    if word.upper()=='NA':vals.append(None);continue
                    parts=word.split('/')
                    if len(parts)!=2:raise IbisError('ramp requires explicit dV/dt fraction')
                    dv,dt=map(number,parts)
                    if dv is None or dt is None or dv<=0 or dt<=0:raise IbisError('nonpositive ramp dV/dt')
                    vals.append((dv,dt))
                if vals[0] is None:raise IbisError('typical ramp missing')
                if key[-1] in model['ramp']:raise IbisError('duplicate ramp edge')
                model['ramp'][key[-1]]=vals
            else:
                match=re.fullmatch(r'r_load\s*=\s*(\S+)',line,re.I)
                if match:
                    load=number(match[1])
                    if load is None or load<=0:raise IbisError('nonpositive R_load')
                    model['r_load']=load;model['r_load_default']=False
    return {'models':models,'pins':pins,'selectors':selectors}

def load(path,expected_sha256=None):
    path=Path(path).resolve();data=path.read_bytes();sha=hashlib.sha256(data).hexdigest()
    if expected_sha256 is not None and sha!=expected_sha256:raise IbisError('IBIS source hash mismatch: '+str(path))
    key=(str(path),sha)
    if key not in _cache:
        result=parse(data.decode('utf-8',errors='replace').splitlines())
        result.update(source_sha256=sha,source_path=str(path),decoding='UTF-8 replacement for parsing; original bytes retained')
        _cache[key]=result
    return _cache[key]

def ramp_edges(model,corners=CORNERS):
    if not corners or any(c not in CORNERS for c in corners):raise IbisError('invalid corner selection')
    out={'r_load_ohm':model.get('r_load',50.0),'r_load_default':model.get('r_load_default',True),'voltage_range':model.get('voltage_range'),'temperature_range':model.get('temperature_range'),'model_type':model.get('type'),'missing_corners':{}}
    for edge in ('r','f'):
        vals=model['ramp'].get(edge)
        if not vals:raise IbisError('no ramp '+edge)
        available=[(vals[CORNERS.index(c)][1],c,vals[CORNERS.index(c)][0]) for c in corners if vals[CORNERS.index(c)] is not None]
        if not available:raise IbisError('all requested corners unavailable')
        dt,corner,dv=min(available)
        out.update({f't{edge}_ns':dt*1e9,f'corner_{edge}':corner,f'dv_{edge}_v':dv})
        out['missing_corners'][edge]=[c for c in CORNERS if vals[CORNERS.index(c)] is None]
    return out


def vi_avg_current(rows,corner,v_lo,v_hi):
    """Mean magnitude on a covered interval; no extrapolation or invented NA corner."""
    if corner not in CORNERS:raise IbisError('invalid corner')
    if not all(math.isfinite(v) for v in (v_lo,v_hi)) or not 0<=v_lo<v_hi:raise IbisError('invalid V-I interval')
    index=CORNERS.index(corner)
    if len(rows)<2 or rows[0][0]>v_lo or rows[-1][0]<v_hi:raise IbisError('V-I interval not covered')
    if any(not math.isfinite(v) for v,_ in rows) or any(a[0]>=b[0] for a,b in zip(rows,rows[1:])):raise IbisError('invalid V-I voltages')
    def at(x):
        for (a,ca),(b,cb) in zip(rows,rows[1:]):
            if a<=x<=b:
                ya,yb=ca[index],cb[index]
                if ya is None or yb is None:raise IbisError('missing V-I corner '+corner)
                if not math.isfinite(ya) or not math.isfinite(yb):raise IbisError('nonfinite V-I current')
                return ya+(yb-ya)*(x-a)/(b-a)
        raise IbisError('V-I interval not covered')
    xs=[v_lo]+[v for v,_ in rows if v_lo<v<v_hi]+[v_hi]
    ys=[at(x) for x in xs]
    if any(y==0 for y in ys) or min(ys)<0<max(ys):raise IbisError('zero or changing V-I current sign')
    result=sum((abs(a)+abs(b))*.5*(v-u) for u,v,a,b in zip(xs,xs[1:],ys,ys[1:]))/(v_hi-v_lo)
    if not math.isfinite(result) or result<=0:raise IbisError('invalid mean V-I current')
    return result

def vi_edges(model,c_f,swing_v=None,open_drain=False,corners=CORNERS,i_limit_a=None):
    """Conditional C*0.8*swing/mean-current estimate; static V-I is not a timing guarantee.

    D-124c uses ground-relative pulldown and supply-relative pullup coordinates.
    Arithmetic mean current omits turn-on/dynamic/package effects. Available
    corners remain explicit; absent corners never inherit typical values.
    """
    if not math.isfinite(c_f) or c_f<=0:raise IbisError('invalid load capacitance')
    if not corners or any(c not in CORNERS for c in corners):raise IbisError('invalid corner selection')
    if i_limit_a is not None and (not math.isfinite(i_limit_a) or i_limit_a<=0):raise IbisError('invalid series current limit')
    if swing_v is not None and (not math.isfinite(swing_v) or swing_v<=0):raise IbisError('invalid swing')
    kind=(model.get('type') or '').lower()
    if kind not in ('output','i/o','3-state','open_drain','open_sink','open_source'):raise IbisError('model is not an output')
    if open_drain and swing_v is None:raise IbisError('open drain needs pull-up voltage')
    out={'qualified_fastest_bound':False,'method':'conditional static V-I arithmetic-mean current','missing_corners':{},'voltage_range':model.get('voltage_range'),'temperature_range':model.get('temperature_range'),'c_f':c_f}
    for edge,table in (('f','pulldown'),('r','pullup')):
        if edge=='r' and open_drain:continue
        rows=model.get('vi',{}).get(table)
        if not rows:raise IbisError('no '+table+' V-I table')
        available=[];missing=[]
        for corner in corners:
            idx=CORNERS.index(corner);ref=model.get('pullup_ref') or model.get('voltage_range')
            v=swing_v if open_drain else (ref[idx] if ref else swing_v)
            if v is None or any(currents[idx] is None for _,currents in rows):missing.append(corner);continue
            if not math.isfinite(v) or v<=0:raise IbisError('invalid reference voltage')
            i=vi_avg_current(rows,corner,.1*v,.9*v)
            if i_limit_a is not None:i=min(i,i_limit_a)
            t=c_f*.8*v/i*1e9
            if not math.isfinite(t) or t<=0:raise IbisError('invalid V-I estimate')
            available.append((t,corner,i,v))
        if not available:raise IbisError('all V-I corners unavailable')
        t,corner,i,v=min(available)
        out.update({f't{edge}_ns':t,f'corner_{edge}':corner,f'i_{edge}':i,f'v_{edge}':v})
        out['missing_corners'][edge]=missing
    return out

def main(argv=None):
    """python tools/ibis_ramp.py FILE.ibs MODEL: source-bound screening JSON."""
    args=sys.argv[1:] if argv is None else argv
    if len(args)!=2:
        print('usage: python tools/ibis_ramp.py FILE.ibs MODEL',file=sys.stderr)
        return 2
    try:
        parsed=load(args[0]);model=parsed['models'].get(args[1].lower())
        if model is None:raise IbisError('model not found: '+args[1])
        result=dict(qualified_fastest_bound=False,kind='ibis_ramp_screen',
                    source_path=parsed['source_path'],source_sha256=parsed['source_sha256'],
                    model=model,edge_screen=ramp_edges(model) if model['ramp'] else None,
                    reason='characterized source model; actual board load/package/PVT applicability unproved')
        print(json.dumps(result,sort_keys=True,allow_nan=False))
        return 0
    except (IbisError,OSError,UnicodeError) as error:
        print(str(error),file=sys.stderr)
        return 1


if __name__=='__main__':raise SystemExit(main())
