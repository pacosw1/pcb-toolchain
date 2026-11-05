//! Dinic max-flow on integer capacities, and the residual reach a min cut is read from.
use std::collections::VecDeque;

/// A capacity no flow reaches.
pub const INFINITE: i64 = 1 << 30;

const UNSEEN: i32 = -1;
const DEAD_END: i32 = -2;

/// Edges in the order they were added: the search tries them in that order, so the flow found is the same on every run.
#[derive(Default)]
pub struct Network {
    from: Vec<usize>,
    to: Vec<usize>,
    capacity: Vec<i64>,
}

/// A solved network. Arc 2k is edge k, arc 2k + 1 its residual twin.
pub struct Solved {
    pub flow: i64,
    head: Vec<usize>,
    capacity: Vec<i64>,
    /// The arcs out of node n are `arcs[start[n]..start[n + 1]]`.
    start: Vec<usize>,
    arcs: Vec<usize>,
}

impl Network {
    pub fn add(&mut self, from: usize, to: usize, capacity: i64) {
        self.from.push(from);
        self.to.push(to);
        self.capacity.push(capacity);
    }

    pub fn solve(self, nodes: usize, source: usize, sink: usize) -> Solved {
        let (mut head, mut capacity, mut tail) = (Vec::new(), Vec::new(), Vec::new());
        for k in 0..self.from.len() {
            head.extend([self.to[k], self.from[k]]);
            tail.extend([self.from[k], self.to[k]]);
            capacity.extend([self.capacity[k], 0]);
        }
        let mut start = vec![0; nodes + 1];
        tail.iter().for_each(|&node| start[node + 1] += 1);
        (0..nodes).for_each(|node| start[node + 1] += start[node]);
        let (mut slot, mut arcs) = (start.clone(), vec![0; tail.len()]);
        for (arc, &node) in tail.iter().enumerate() {
            arcs[slot[node]] = arc;
            slot[node] += 1;
        }
        let mut solved = Solved { flow: 0, head, capacity, start, arcs };
        while let Some(mut level) = solved.levels(source, sink, nodes) {
            solved.blocking_flow(source, sink, &mut level);
        }
        solved
    }
}

impl Solved {
    fn out(&self, node: usize) -> &[usize] {
        &self.arcs[self.start[node]..self.start[node + 1]]
    }

    /// Breadth-first levels in the residual graph; None once the sink is out of reach.
    fn levels(&self, source: usize, sink: usize, nodes: usize) -> Option<Vec<i32>> {
        let mut level = vec![UNSEEN; nodes];
        level[source] = 0;
        let mut queue = VecDeque::from([source]);
        while let Some(node) = queue.pop_front() {
            for &arc in self.out(node) {
                let next = self.head[arc];
                if self.capacity[arc] > 0 && level[next] < 0 {
                    level[next] = level[node] + 1;
                    queue.push_back(next);
                }
            }
        }
        (level[sink] >= 0).then_some(level)
    }

    /// The next arc on from `node` one level up, its pointer left there.
    fn advance(&self, node: usize, level: &[i32], next: &mut [usize]) -> Option<usize> {
        while next[node] < self.start[node + 1] {
            let arc = self.arcs[next[node]];
            if self.capacity[arc] > 0 && level[self.head[arc]] == level[node] + 1 {
                return Some(arc);
            }
            next[node] += 1;
        }
        None
    }

    fn blocking_flow(&mut self, source: usize, sink: usize, level: &mut [i32]) {
        let mut next = self.start.clone();
        loop {
            let (mut stack, mut path) = (vec![source], Vec::new());
            while let Some(&node) = stack.last().filter(|node| **node != sink) {
                if let Some(arc) = self.advance(node, level, &mut next) {
                    stack.push(self.head[arc]);
                    path.push(arc);
                } else {
                    level[node] = DEAD_END;
                    stack.pop();
                    path.pop();
                }
            }
            if stack.is_empty() {
                return;
            }
            let pushed = path.iter().map(|&arc| self.capacity[arc]).min().expect("a path from source to sink has arcs");
            for &arc in &path {
                self.capacity[arc] -= pushed;
                self.capacity[arc ^ 1] += pushed;
            }
            self.flow += pushed;
        }
    }

    /// The heads of the edges out of `node` that are full.
    pub fn full_edges(&self, node: usize) -> impl Iterator<Item = usize> + '_ {
        self.out(node).iter().filter(|&&arc| arc % 2 == 0 && self.capacity[arc] == 0).map(|&arc| self.head[arc])
    }

    /// The nodes the residual graph reaches from `source`: the source side of the min cut nearest it, the same for every max-flow.
    pub fn reachable(&self, source: usize) -> Vec<bool> {
        let mut seen = vec![false; self.start.len() - 1];
        seen[source] = true;
        let mut queue = VecDeque::from([source]);
        while let Some(node) = queue.pop_front() {
            for &arc in self.out(node) {
                if self.capacity[arc] > 0 && !seen[self.head[arc]] {
                    seen[self.head[arc]] = true;
                    queue.push_back(self.head[arc]);
                }
            }
        }
        seen
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A diamond: 0 -> 1, 2 -> 3, with room for 1 through node 1 and 2 through node 2.
    fn diamond() -> Solved {
        let mut network = Network::default();
        for (from, to, capacity) in [(0, 1, 3), (0, 2, 2), (1, 3, 1), (2, 3, 2)] {
            network.add(from, to, capacity);
        }
        network.solve(4, 0, 3)
    }

    #[test]
    fn the_flow_is_the_min_cut() {
        assert_eq!(diamond().flow, 3);
    }

    #[test]
    fn the_source_side_stops_at_the_full_edges() {
        assert_eq!(diamond().reachable(0), vec![true, true, false, false]);
    }

    #[test]
    fn full_edges_name_their_heads() {
        assert_eq!(diamond().full_edges(0).collect::<Vec<_>>(), vec![2]);
        assert_eq!(diamond().full_edges(1).collect::<Vec<_>>(), vec![3]);
    }

    #[test]
    fn a_detour_through_a_residual_edge_is_found() {
        // 1 -> 4 first takes the only way out of 2: the second unit has to push it back.
        let mut network = Network::default();
        for (from, to) in [(0, 1), (0, 2), (1, 3), (1, 4), (2, 3), (3, 5), (4, 5)] {
            network.add(from, to, 1);
        }
        assert_eq!(network.solve(6, 0, 5).flow, 2);
    }

    #[test]
    fn no_way_through_is_no_flow() {
        let mut network = Network::default();
        network.add(0, 1, INFINITE);
        assert_eq!(network.solve(3, 0, 2).flow, 0);
    }
}
