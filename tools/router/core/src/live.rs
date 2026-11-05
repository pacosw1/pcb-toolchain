//! Optional observation. Append-only geometry deltas survive reconnects; failures disable only this writer.
use super::{Board, Ctx, Geo, Kind};
use serde_json::{Value, json};
use std::{cell::RefCell, collections::BTreeMap, fs::File, io::Write, time::Instant};
thread_local! { static LIVE: RefCell<Option<Live>> = const { RefCell::new(None) }; }
struct Live {
    file: File,
    _spool: Option<iotroute::live_spool::Spool>,
    copper: BTreeMap<String, Value>,
    pass: usize,
    last: Instant,
    serial: u64,
    bytes: usize,
    disabled: bool,
}
fn with(f: impl FnOnce(&mut Live)) {
    LIVE.with(|l| {
        if let Some(l) = l.borrow_mut().as_mut() {
            f(l)
        }
    });
}
impl Live {
    fn emit(&mut self, kind: &str, data: Value) {
        if self.disabled {
            return;
        }
        if let Ok(mut bytes) = serde_json::to_vec(&json!({"kind":kind,"data":data,"timeMs":iotroute::live_spool::now_ms()})) {
            bytes.push(b'\n');
            self.bytes += bytes.len();
            if self.bytes > 512 * 1024 * 1024
                || self
                    .file
                    .write_all(&bytes)
                    .and_then(|_| self.file.flush())
                    .is_err()
            {
                self.disabled = true;
                eprintln!("live observation stopped: output limit or write failure");
            }
        }
    }
}
pub fn init() {
    LIVE.with(|l| {
        let args:Vec<_>=std::env::args().collect();
        let spool=if std::env::var("PCB_LIVE_EVENTS").is_err() && std::env::var("PCB_LIVE_DIR").is_ok() && !std::env::var("PCB_LIVE").is_ok_and(|v|v=="0") {args.get(1).and_then(|m|std::fs::read(m).ok().and_then(|bytes|iotroute::live_spool::Spool::from_environment(std::path::Path::new(m),&bytes,"routing",args.get(2)?.into())))}else{None};
        *l.borrow_mut() = std::env::var("PCB_LIVE_EVENTS")
            .ok().or_else(||spool.as_ref().map(|s|s.raw.to_string_lossy().into_owned()))
            .and_then(|p| {
                std::fs::OpenOptions::new()
                    .write(true)
                    .create_new(true)
                    .open(p)
                    .ok()
            })
            .map(|file| Live {
                file, _spool:spool,
                copper: BTreeMap::new(),
                pass: 0,
                last: Instant::now(),
                serial: 0,
                bytes: 0,
                disabled: false,
            });
    });
}
pub fn pass(n: usize) {
    with(|l| {
        l.pass = n;
        l.emit(
            "checkpoint",
            json!({"label":format!("Pass {n}"),"best":false}),
        );
    });
}
pub fn snapshot(b: &Board) {
    with(|l| {
        let mut next = BTreeMap::new();
        let mut counts = BTreeMap::<String, usize>::new();
        for s in b
            .shapes
            .iter()
            .filter(|s| s.alive && matches!(s.kind, Kind::Track | Kind::Via))
        {
            let Some(net) = b.nets.get(s.net as usize) else {
                continue;
            };
            let key = format!(
                "{}:{:?}:{}:{}:{}",
                s.net,
                s.geo,
                s.layers,
                s.drill,
                s.owner < 0
            );
            let count = counts.entry(key.clone()).or_default();
            let id = format!("{key}:{}", *count);
            *count += 1;
            let layers: Vec<_> = b
                .layer_names
                .iter()
                .enumerate()
                .filter(|(i, _)| s.layers & (1 << i) != 0)
                .map(|(_, n)| n)
                .collect();
            let v = match (s.kind, s.geo) {
                (Kind::Track, Geo::Seg(ax, ay, bx, by, hw)) => {
                    json!({"id":id,"net":net.name,"layer":layers.first(),"a":[ax,ay],"b":[bx,by],"width":hw*2.,"locked":s.owner<0})
                }
                (Kind::Via, Geo::Circ(x, y, r)) => {
                    json!({"id":id,"net":net.name,"at":[x,y],"diameter":r*2.,"drill":s.drill,"layers":layers,"locked":s.owner<0})
                }
                _ => continue,
            };
            next.insert(id, v);
        }
        let mut at = vec![];
        let mut av = vec![];
        let mut rt = vec![];
        let mut rv = vec![];
        for (id, v) in &l.copper {
            if !next.contains_key(id) {
                if v.get("a").is_some() {
                    rt.push(id.clone())
                } else {
                    rv.push(id.clone())
                }
            }
        }
        for (id, v) in &next {
            if !l.copper.contains_key(id) {
                if v.get("a").is_some() {
                    at.push(v.clone())
                } else {
                    av.push(v.clone())
                }
            }
        }
        if !at.is_empty() || !av.is_empty() || !rt.is_empty() || !rv.is_empty() {
            l.emit(
                "route.delta",
                json!({"addTracks":at,"addVias":av,"removeTracks":rt,"removeVias":rv}),
            );
        }
        l.copper = next;
    });
}
pub fn activity(ctx: &Ctx, net: usize, action: &str, path: &[usize]) {
    with(|l| {
        let points: Vec<_> = path
            .iter()
            .take(20000)
            .map(|&i| {
                let (_, y, x) = ctx.gr.cell(i);
                let (x, y) = ctx.gr.xy(x, y);
                [x, y]
            })
            .collect();
        l.emit(
            "route.activity",
            json!({"net":ctx.bd.nets[net].name,"pass":l.pass,"action":action,"path":points}),
        );
    });
}
pub fn frontier(ctx: &Ctx, net: usize, cell: usize) {
    let due = LIVE.with(|l| {
        l.borrow()
            .as_ref()
            .is_some_and(|l| !l.disabled && l.last.elapsed().as_millis() >= 100)
    });
    if !due {
        return;
    }
    let mut path = vec![];
    let mut at = cell;
    for _ in 0..20000 {
        path.push(at);
        let prev = ctx.gr.from[at];
        if prev == u32::MAX {
            break;
        }
        at = prev as usize;
    }
    path.reverse();
    activity(ctx, net, "searching", &path);
    with(|l| l.last = Instant::now());
}
pub fn failure(ctx: &Ctx, net: usize, reason: &str, path: &[usize]) {
    with(|l| {
        let points: Vec<_> = path
            .iter()
            .take(20000)
            .map(|&i| {
                let (_, y, x) = ctx.gr.cell(i);
                let (x, y) = ctx.gr.xy(x, y);
                [x, y]
            })
            .collect();
        let boxes: Vec<_> = ctx
            .bd
            .shapes
            .iter()
            .filter(|s| s.alive && s.net == net as i32)
            .map(|s| s.geo.bbox())
            .collect();
        let region = boxes
            .iter()
            .fold(None, |v: Option<[f64; 4]>, &(a, b, c, d)| {
                Some(match v {
                    None => [a, b, c, d],
                    Some(r) => [r[0].min(a), r[1].min(b), r[2].max(c), r[3].max(d)],
                })
            })
            .unwrap_or([ctx.bd.edge.0, ctx.bd.edge.1, ctx.bd.edge.2, ctx.bd.edge.3]);
        // Nearby copper is inspection context, not a claim that a particular item caused an exhaustive failure.
        let blockers:Vec<_>=ctx.bd.shapes.iter().enumerate().filter(|(_,s)|s.alive&&s.net!=net as i32).filter_map(|(i,s)|{
        let (a,b,c,d)=s.geo.bbox();if c<region[0]-1.||a>region[2]+1.||d<region[1]-1.||b>region[3]+1.{return None}
        Some(json!({"id":format!("shape-{i}"),"net":ctx.bd.nets.get(s.net as usize).map(|n|n.name.as_str()).unwrap_or(""),"region":[a,b,c,d]}))
    }).take(500).collect();
        l.serial += 1;
        l.emit("route.failure",json!({"id":format!("failure-{}",l.serial),"net":ctx.bd.nets[net].name,"reason":reason,"rule":"Nearby copper shown for inspection; causal blocker not isolated","region":region,"blockers":blockers,"rejectedPath":points}));
    });
}
/// Proven clearance conflicts from the solver's exact audit, unlike contextual search-failure overlays.
pub fn conflicts(ctx: &Ctx, audit: &super::Audit) {
    with(|l| {
        for &(a, b) in audit.pair_ids.iter().take(64) {
            let (a, b) = (&ctx.bd.shapes[a as usize], &ctx.bd.shapes[b as usize]);
            let (x0, y0, x1, y1) = a.geo.bbox();
            let (u0, v0, u1, v1) = b.geo.bbox();
            let net = ctx
                .bd
                .nets
                .get(a.net as usize)
                .map(|n| n.name.as_str())
                .unwrap_or("");
            let other = ctx
                .bd
                .nets
                .get(b.net as usize)
                .map(|n| n.name.as_str())
                .unwrap_or("");
            l.serial += 1;
            l.emit("route.failure",json!({"id":format!("audit-{}",l.serial),"net":net,"reason":"Exact audit: copper conflict", "rule":"Solver clearance audit", "region":[x0.min(u0),y0.min(v0),x1.max(u1),y1.max(v1)],"rejectedPath":[],"blockers":[{"id":format!("audit-{}-a",l.serial),"net":net,"region":[x0,y0,x1,y1]},{"id":format!("audit-{}-b",l.serial),"net":other,"region":[u0,v0,u1,v1]}]}));
        }
    });
}
