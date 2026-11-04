//! What a net can reach on the grid, and what walls it in.
use super::board::{GridBoard, NetGrids};
use super::mask::Mask;
use std::collections::{HashMap, VecDeque};

/// Breadth first over (layer, row, column): four neighbours on a layer, every free layer through a via site. Stops at the first
/// target cell. Returns whether it got there and the cells reached so far.
pub fn flood(grids: &NetGrids, seeds: &[Mask], target: Option<&[Mask]>) -> (bool, Vec<Mask>) {
    let free = &grids.free;
    let (nx, ny) = (free[0].nx(), free[0].ny());
    let mut seen: Vec<Mask> = seeds.iter().zip(free).map(|(s, f)| s.and(f)).collect();
    let mut queue = VecDeque::new();
    for (l, s) in seen.iter().enumerate() {
        queue.extend((0..ny).flat_map(|j| (0..nx).map(move |i| (l, j, i))).filter(|(_, j, i)| s.at(*j, *i)));
    }
    while let Some((l, j, i)) = queue.pop_front() {
        if target.is_some_and(|t| t[l].at(j, i)) {
            return (true, seen);
        }
        let neighbours = [(j.wrapping_sub(1), i), (j + 1, i), (j, i.wrapping_sub(1)), (j, i + 1)];
        for (jj, ii) in neighbours {
            if jj < ny && ii < nx && free[l].at(jj, ii) && !seen[l].at(jj, ii) {
                seen[l].set(jj, ii, true);
                queue.push_back((l, jj, ii));
            }
        }
        if grids.via_ok.at(j, i) {
            for m in 0..free.len() {
                if m != l && free[m].at(j, i) && !seen[m].at(j, i) {
                    seen[m].set(j, i, true);
                    queue.push_back((m, j, i));
                }
            }
        }
    }
    (false, seen)
}

/// Counts in first-seen order, so equal counts rank as collections.Counter ranks them.
#[derive(Default)]
pub struct Tally {
    order: Vec<(String, usize)>,
    index: HashMap<String, usize>,
}

impl Tally {
    pub fn add(&mut self, key: &str, count: usize) {
        match self.index.get(key) {
            Some(&at) => self.order[at].1 += count,
            None => {
                self.index.insert(key.to_string(), self.order.len());
                self.order.push((key.to_string(), count));
            }
        }
    }

    pub fn entries(&self) -> &[(String, usize)] {
        &self.order
    }

    pub fn most_common(&self, top: usize) -> Vec<String> {
        let mut ranked: Vec<&(String, usize)> = self.order.iter().collect();
        ranked.sort_by_key(|(_, count)| std::cmp::Reverse(*count));
        ranked.into_iter().take(top).map(|(key, _)| key.clone()).collect()
    }
}

/// How a blocking item is named in the report.
fn blocker_name(grid: &GridBoard, k: usize) -> String {
    let item = &grid.items[k];
    format!("{} {}", if item.net.is_empty() { "(no net)" } else { &item.net }, item.owner)
}

/// The obstacles on the edge of a reached region, as nets and parts, most cells first. An empty edge means an empty region: the
/// obstacles over the end itself.
pub fn blockers(grid: &GridBoard, reached: &[Mask], owners: &[Vec<i32>], top: usize) -> (Vec<String>, Vec<String>) {
    let mut cells = Tally::default();
    for (region, own) in reached.iter().zip(owners) {
        let mut edge = region.dilated();
        edge.cells.iter_mut().zip(&region.cells).for_each(|(e, r)| *e = *e && !*r);
        let picked = if edge.any() { &edge } else { region };
        for (at, _) in picked.cells.iter().enumerate().filter(|(_, c)| **c) {
            if own[at] >= 0 {
                cells.add(&blocker_name(grid, own[at] as usize), 1);
            }
        }
    }
    let (mut nets, mut parts) = (Tally::default(), Tally::default());
    for (key, count) in cells.entries() {
        let (net, owner) = key.split_once(' ').unwrap_or((key, ""));
        nets.add(net, *count);
        if let Some((part, _)) = owner.split_once('.') {
            parts.add(part, *count);
        }
    }
    (nets.most_common(top), parts.most_common(top))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::grid::mask::Window;

    fn window(n: i64) -> Window {
        Window { i0: 0, i1: n, j0: 0, j1: 1 }
    }

    fn grids(free: &[&[bool]], via: &[bool]) -> NetGrids {
        let n = free[0].len() as i64;
        let row = |r: &[bool]| Mask { window: window(n), cells: r.to_vec() };
        NetGrids { free: free.iter().map(|r| row(r)).collect(), via_ok: row(via), owners: Vec::new() }
    }

    fn seed(n: i64, cell: usize) -> Mask {
        let mut m = Mask::filled(window(n), false);
        m.cells[cell] = true;
        m
    }

    #[test]
    fn a_wall_stops_the_flood_and_a_via_goes_round_it() {
        let top = [true, true, false, true];
        let bottom = [true, true, true, true];
        let walled = grids(&[&top], &[false; 4]);
        let target = [seed(4, 3)];
        assert!(!flood(&walled, &[seed(4, 0)], Some(&target)).0);
        let two = grids(&[&top, &bottom], &[false, true, false, true]);
        let target = [seed(4, 3), Mask::filled(window(4), false)];
        assert!(flood(&two, &[seed(4, 0), Mask::filled(window(4), false)], Some(&target)).0);
    }

    #[test]
    fn with_no_target_the_flood_fills_the_region() {
        let g = grids(&[&[true, true, false, true]], &[false; 4]);
        assert_eq!(flood(&g, &[seed(4, 0)], None).1[0].count(), 2);
    }

    #[test]
    fn a_seed_on_a_blocked_cell_goes_nowhere() {
        let g = grids(&[&[false, true]], &[false; 2]);
        assert_eq!(flood(&g, &[seed(2, 0)], None).1[0].count(), 0);
    }

    #[test]
    fn ties_rank_in_first_seen_order() {
        let mut t = Tally::default();
        t.add("b", 2);
        t.add("a", 2);
        t.add("c", 5);
        t.add("a", 0);
        assert_eq!(t.most_common(2), ["c", "b"]);
    }
}
