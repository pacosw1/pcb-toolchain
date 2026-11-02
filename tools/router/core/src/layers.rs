//! Layer negotiation of one-layer nets (tools/router/DESIGN.md 5b, 2026-11-02).
//!
//! A one-layer net can never change layer: its DRU via_count budget is 0 (the locked input vias counted), or (RP-001)
//! no return via can ever lie within the radius of one of its vias (isolation pair value: POE-ETHERNET POE nets keep
//! 3 mm from every ground via, the radius is 1.0 mm). Before this, the A* chose the layer of each join from the cell
//! costs alone, so the layer was never priced as one resource: POE-ETHERNET /POE_V1N and /POE_V2N cross near J1 and
//! stood off to iteration 80 (reports/2026-11-01-isolation.md, item 1).
//!
//! Now such a net, when every fixed item of it (pads, locked copper) has copper on 2 or more of its routable layers,
//! chooses its layer as a whole: route_one_layer routes it once on each candidate layer (all joins on that layer) and
//! keeps the layer with the lowest A* cost x (1 + layer history). The layer history is PathFinder history of that
//! choice: every iteration that ends with the net in conflict adds --hist to the layer its copper is on (layer_hist),
//! so a net that keeps losing on one layer moves to the other as a whole, and can move back in a later iteration.
//! Ties keep the lower routable layer (deterministic). A net with no single-layer route on any candidate layer is
//! routed as before (one layer per join, through-hole pads join the layers).
use super::*;

impl<'a> Ctx<'a> {
    /// The routable copper layers a one-layer net chooses from (2 or more), else None (the net routes as before).
    pub(crate) fn layer_choice(&self, net: usize) -> Option<Vec<usize>> {
        let n = &self.bd.nets[net];
        if n.plane || self.bd.twin_of(net).is_some() {
            return None;
        }
        let no_budget = n.max_vias.map_or(false, |m| m.floor() as i64 <= n.in_vias as i64);
        let ni = net as i32;
        let no_return = self.bd.gnd >= 0 && !self.bd.gnds.contains(&ni) && !self.bd.noret.contains(&ni) && !self.ret_reachable(net);
        if !no_budget && !no_return {
            return None;
        }
        let items: Vec<u8> = self.bd.shapes.iter()
            .filter(|s| s.alive && s.net == ni && s.owner < 0 && s.kind != Kind::Spoke)
            .map(|s| s.layers)
            .collect();
        if items.len() < 2 {
            return None;
        }
        let cands: Vec<usize> = self.bd.routable.iter().cloned()
            .filter(|&l| n.layers & (1 << l) != 0 && items.iter().all(|&m| m & (1 << l) != 0))
            .collect();
        if cands.len() >= 2 { Some(cands) } else { None }
    }

    /// Layer history of `net` on routable layer index r (0 before any conflict).
    pub(crate) fn lhist_of(&self, net: usize, r: usize) -> f32 {
        self.gr.lhist.get(net * self.gr.nr + r).copied().unwrap_or(0.0)
    }

    /// End of an iteration: each one-layer net in `involved` (in conflict in the audit) gets history `h` on the layers
    /// its routed tracks are on.
    pub(crate) fn layer_hist(&mut self, involved: &[usize], h: f32) {
        if h <= 0.0 {
            return;
        }
        let nr = self.gr.nr;
        for &net in involved {
            if self.layer_choice(net).is_none() {
                continue;
            }
            let on: u8 = self.bd.shapes.iter()
                .filter(|s| s.alive && s.owner == net as i32 && s.net == net as i32 && s.kind == Kind::Track)
                .fold(0, |m, s| m | s.layers);
            if self.gr.lhist.len() < self.bd.nets.len() * nr {
                self.gr.lhist.resize(self.bd.nets.len() * nr, 0.0);
            }
            for (r, &l) in self.bd.routable.iter().enumerate() {
                if on & (1 << l) != 0 {
                    self.gr.lhist[net * nr + r] += h;
                }
            }
        }
    }
}

/// Route one-layer net `net` on each candidate copper layer in `cands` (Ctx::layer_choice) and keep the cheapest:
/// a route that joins every component first, then the lowest A* cost x (1 + layer history; history off in the length
/// recovery), ties to the earlier layer. A wall found on one layer proves nothing for the net (ctx.dead is kept as it
/// was before the tries). No layer joins the net: it is routed with all its layers, as before.
pub(crate) fn route_one_layer(ctx: &mut Ctx, net: usize, cands: &[usize]) -> NetResult {
    let mask0 = ctx.bd.nets[net].layers;
    let dead0 = ctx.dead[net].clone();
    // (open, price, its live copper, result)
    let mut best: Option<(bool, f64, Vec<usize>, NetResult)> = None;
    for &l in cands {
        let r = ctx.bd.routable.iter().position(|&x| x == l).unwrap();
        ctx.bd.nets[net].layers = 1 << l;
        ctx.ret_soft = false;
        ctx.neck.clear();
        ctx.stub_cost = Default::default();
        ctx.lfloor.clear();
        ctx.leaf_necks = false;
        let first = ctx.bd.shapes.len();
        let res = route_net_inner(ctx, net);
        ctx.dead[net] = dead0.clone();
        let open = res.hard_fail.is_some() || res.limit;
        let price = res.cost * (1.0 + if ctx.recover { 0.0 } else { ctx.lhist_of(net, r) as f64 });
        let ids: Vec<usize> = (first..ctx.bd.shapes.len()).filter(|&i| ctx.bd.shapes[i].alive && ctx.bd.shapes[i].owner == net as i32).collect();
        if best.as_ref().map_or(true, |b| (open, price) < (b.0, b.1)) {
            best = Some((open, price, ids, res));
        }
    }
    ctx.bd.nets[net].layers = mask0;
    // the copper of the last try is live: replace it by the chosen one
    for s in ctx.bd.shapes.iter_mut() {
        if s.alive && s.owner == net as i32 {
            s.alive = false;
        }
    }
    let (open, _, ids, res) = best.unwrap();
    if open {
        ctx.neck.clear();
        ctx.stub_cost = Default::default();
        ctx.lfloor.clear();
        ctx.leaf_necks = false;
        ctx.ret_soft = false;
        return route_net_inner(ctx, net);
    }
    for i in ids {
        ctx.bd.shapes[i].alive = true;
    }
    res
}
