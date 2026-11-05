//! The grid as a flow network. Cell capacity 1 by node splitting (a track occupies a cell), 4-neighbour moves per layer, a via joins
//! the same cell on two layers (its larger footprint on the neighbours is not charged). Each escaping net is one unit from its own
//! super-source; the sink is the region's boundary ring.
use super::dinic::{INFINITE, Network, Solved};
use super::raster::{FREE, Frame, Raster};

/// Who may use the routing layers.
pub struct Access {
    /// Per routing layer: only the nets of `--in2-nets` enter it.
    pub restricted: Vec<bool>,
    /// Per net: it may enter a restricted layer.
    pub in2: Vec<bool>,
}

/// The network of a region and what its nodes stand for.
pub struct Graph<'g> {
    frame: Frame,
    raster: &'g Raster,
    access: Access,
    nets: usize,
    /// Per layer and net, the cells within a net's own cells and their 8 neighbours. Pad access: a straight or diagonal stub of
    /// <= 1.41 pitch; it absorbs the grid alignment of fine-pitch pins; stubs are not checked for crossing.
    near: Vec<Vec<Vec<bool>>>,
}

fn near_own(frame: &Frame, state: &[i32], nets: usize) -> Vec<Vec<bool>> {
    let mut near = vec![vec![false; frame.cells()]; nets];
    for (j, i) in frame.rows() {
        let net = state[frame.at(j, i)];
        if net < 0 {
            continue;
        }
        for jj in j.saturating_sub(1)..(j + 2).min(frame.ny) {
            for ii in i.saturating_sub(1)..(i + 2).min(frame.nx) {
                near[net as usize][frame.at(jj, ii)] = true;
            }
        }
    }
    near
}

impl<'g> Graph<'g> {
    pub fn new(frame: Frame, raster: &'g Raster, access: Access) -> Graph<'g> {
        let nets = access.in2.len();
        let near = raster.states.iter().map(|state| near_own(&frame, state, nets)).collect();
        Graph { frame, raster, access, nets, near }
    }

    fn layers(&self) -> usize {
        self.raster.states.len()
    }

    /// Of the cells, the in-node at 2c and the out-node at 2c + 1, then the source, the sink and each net's super-source.
    fn cell_nodes(&self) -> usize {
        2 * self.layers() * self.frame.cells()
    }

    fn source(&self) -> usize {
        self.cell_nodes()
    }

    fn sink(&self) -> usize {
        self.cell_nodes() + 1
    }

    fn net_source(&self, net: usize) -> usize {
        self.cell_nodes() + 2 + net
    }

    fn cell(&self, layer: usize, cell: usize) -> usize {
        layer * self.frame.cells() + cell
    }

    fn free(&self, layer: usize, cell: usize) -> bool {
        self.raster.states[layer][cell] == FREE
    }

    /// A free cell next to the net's own, where a stub can land.
    fn accessible(&self, layer: usize, net: usize, cell: usize) -> bool {
        self.near[layer][net][cell] && self.free(layer, cell)
    }

    /// No escaping net's copper in the way of a via.
    fn via_open(&self, cell: usize) -> bool {
        !self.raster.via_blocked[cell] && self.raster.via_nets[cell] == 0
    }

    /// The same, for a via of `net`: its own copper does not count.
    fn via_open_to(&self, net: usize, cell: usize) -> bool {
        let r = self.raster;
        !r.via_blocked[cell] && (r.via_nets[cell] == 0 || (r.via_nets[cell] == 1 && r.via_last[cell] == net as i32))
    }

    fn add_layer(&self, network: &mut Network, layer: usize) {
        let (frame, sink) = (self.frame, self.sink());
        let free_cells: Vec<usize> = (0..frame.cells()).filter(|&c| self.free(layer, c)).collect();
        for &cell in &free_cells {
            let node = self.cell(layer, cell);
            network.add(2 * node, 2 * node + 1, 1);
        }
        let across = frame.rows().filter(|&(_, i)| i + 1 < frame.nx).map(|(j, i)| (frame.at(j, i), frame.at(j, i + 1)));
        let down = frame.rows().filter(|&(j, _)| j + 1 < frame.ny).map(|(j, i)| (frame.at(j, i), frame.at(j + 1, i)));
        for moves in [across.collect::<Vec<_>>(), down.collect()] {
            let open: Vec<(usize, usize)> = moves.into_iter().filter(|&(a, b)| self.free(layer, a) && self.free(layer, b)).map(|(a, b)| (self.cell(layer, a), self.cell(layer, b))).collect();
            open.iter().for_each(|&(a, b)| network.add(2 * a + 1, 2 * b, INFINITE));
            open.iter().for_each(|&(a, b)| network.add(2 * b + 1, 2 * a, INFINITE));
        }
        for (j, i) in frame.rows().filter(|&(j, i)| frame.on_ring(j, i) && self.free(layer, frame.at(j, i))) {
            network.add(2 * self.cell(layer, frame.at(j, i)) + 1, sink, INFINITE);
        }
    }

    fn add_vias(&self, network: &mut Network) {
        let layers = self.layers();
        for from in 0..layers {
            for to in (0..layers).filter(|&to| to != from) {
                if self.access.restricted[to] && !self.access.restricted[from] {
                    continue;
                }
                for cell in (0..self.frame.cells()).filter(|&c| self.free(from, c) && self.free(to, c) && self.via_open(c)) {
                    network.add(2 * self.cell(from, cell) + 1, 2 * self.cell(to, cell), INFINITE);
                }
            }
        }
    }

    fn add_net(&self, network: &mut Network, net: usize) {
        let (frame, node) = (self.frame, self.net_source(net));
        network.add(self.source(), node, 1);
        let allowed: Vec<usize> = (0..self.layers()).filter(|&l| !self.access.restricted[l] || self.access.in2[net]).collect();
        let mut touch = vec![false; frame.cells()];
        let mut reaches_ring = false;
        for layer in 0..self.layers() {
            let private = |cell: usize| self.raster.states[layer][cell] == net as i32;
            for cell in 0..frame.cells() {
                touch[cell] |= private(cell) || self.accessible(layer, net, cell);
            }
            if allowed.contains(&layer) {
                for cell in (0..frame.cells()).filter(|&c| self.accessible(layer, net, c)) {
                    network.add(node, 2 * self.cell(layer, cell), INFINITE);
                }
                reaches_ring |= frame.rows().any(|(j, i)| private(frame.at(j, i)) && frame.on_ring(j, i));
            }
        }
        for &layer in &allowed {
            for cell in (0..frame.cells()).filter(|&c| touch[c] && self.via_open_to(net, c) && self.free(layer, c)) {
                network.add(node, 2 * self.cell(layer, cell), INFINITE);
            }
        }
        if reaches_ring {
            network.add(node, self.sink(), INFINITE);
        }
    }

    pub fn solve(&self) -> Solved {
        let mut network = Network::default();
        (0..self.layers()).for_each(|layer| self.add_layer(&mut network, layer));
        self.add_vias(&mut network);
        (0..self.nets).for_each(|net| self.add_net(&mut network, net));
        network.solve(self.cell_nodes() + 2 + self.nets, self.source(), self.sink())
    }

    /// The net indices that got their unit: the source's edge to them is full.
    pub fn served(&self, solved: &Solved) -> Vec<bool> {
        let mut served = vec![false; self.nets];
        solved.full_edges(self.source()).for_each(|node| served[node - self.net_source(0)] = true);
        served
    }

    /// Cells whose capacity is the cut: free, in-node on the source side, out-node not, as (layer, row, column).
    pub fn cut_cells(&self, seen: &[bool]) -> Vec<(usize, usize, usize)> {
        let mut cells = Vec::new();
        for layer in 0..self.layers() {
            for (j, i) in self.frame.rows() {
                let (cell, node) = (self.frame.at(j, i), self.cell(layer, self.frame.at(j, i)));
                if self.free(layer, cell) && seen[2 * node] && !seen[2 * node + 1] {
                    cells.push((layer, j, i));
                }
            }
        }
        cells
    }

    /// Nets whose source is on the source side of the min cut: they share the bottleneck.
    pub fn contested(&self, seen: &[bool]) -> Vec<usize> {
        (0..self.nets).filter(|&net| seen[self.net_source(net)]).collect()
    }

    pub fn source_node(&self) -> usize {
        self.source()
    }

    /// The cells round a net's own that are not its own, row by row: where a boxed-in source met its blockers.
    pub fn rim(&self, layer: usize, net: usize) -> impl Iterator<Item = usize> + '_ {
        (0..self.frame.cells()).filter(move |&cell| self.near[layer][net][cell] && self.raster.states[layer][cell] != net as i32)
    }
}
