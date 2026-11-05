//! Simultaneous pin escape as a vertex-disjoint max-flow (W18, 2026-10-11, CIP #831 item 2 "ready-to-route").
//!
//! Modes: --parts (per-part, the mode for blocks), no option (whole board: every footprint with >= 8 pads, per part), --region
//! (pooled: a net's pads in the region are one source, so a net may leave from its other pad; not suitable for blocks, it hides pin
//! conflicts at one part).
//!
//! Question: can all pins of a block leave it AT THE SAME TIME? The per-pad escape check of `grid` asks it per pad, so pins that
//! compete for the same exits all pass there (BASE-PWR-B U19: 0 boxed-in pads, 1-3 nets open after every router run).
//!
//! Method: escape routing as network flow (Yan and Chen, "A network flow based approach for escape routing" / the BGA escape routing
//! literature, e.g. Yan, Wong, "Correctly modeling the diagonal capacity in escape routing"; Fang et al., "A network-flow-based RDL
//! routing algorithm"). Each net that must leave the region is one unit of demand; the routing space is a grid, cell capacity 1 by
//! node splitting (a track occupies a cell); Dinic max-flow. All demand escapes at once iff max-flow == demand. A min cut (cells
//! reachable from the source in the residual graph whose out-node is not) is where the competing nets run out of room.
//!
//! Grid and rules (read from the .kicad_pro next to the board and its .kicad_dru when present):
//! - pitch = track width + clearance of the net class; the smallest pitch among the escaping nets (printed). Wider nets on that grid
//!   are optimistic (they occupy one cell; the class width is the router default, not a DRC minimum, and routers neck down at pads).
//!   Obstacles grow by the smallest clearance to any escaping net; so a net class whose clearances differ (for example POE or MAINS
//!   .kicad_dru rules) is also checked alone on its own pitch and clearances.
//! - a cell is blocked for track centres within clearance(item, net) + half track width of other nets' pads, tracks, vias and NPTH
//!   holes (hole clearance); within half track width of a no-track rule area (KiCad keepout semantics: no clearance); within edge
//!   clearance + half track width of the board edge (min_copper_edge_clearance, else 0.3 mm). Zones are not obstacles (pours refill
//!   round tracks).
//! - escaping nets: a net's own copper (pads, tracks, vias) in the region is merged into its super-source (capacity 1); cells within
//!   its halo (clearance to the other escaping nets + half track width) are its own if no other net claims them, else blocked.
//! - 4-neighbour moves per layer, no 45-degree moves. A via (layer change) is allowed at a cell where a via of the class diameter plus
//!   clearance clears other nets' copper on every copper layer (through-hole) and the edge.
//! - router neck: within the pad's long dimension of a source pad (distance from the pad copper), tracks may be the neck width:
//!   obstacles there grow by clearance + half the neck width. Distance source: the D-124c pin-escape allowance (tools/pin-ratings.json
//!   "about", tools/pcbtool.py width_report: a track piece that starts on a pad and is no longer than the pad's long dimension is part
//!   of the pad). The neck zone is the union over all source pads of the part (any net's track there may neck). The grid pitch stays
//!   the class pitch.
//! - --in2-nets: In2.Cu is added for those nets only; flow enters In2.Cu only from their sources (no other net can reach it), and may
//!   leave it by via.
//! - sources: non-plane nets with a pad centre inside the region and another pad outside it or on another part (--only-nets restricts
//!   this); one unit each, all its pads in the region merged (region mode). Sinks: free cells on the region boundary ring (and a net
//!   whose own copper already reaches it).
//! - per-part mode (--parts, or whole board = every footprint with >= 8 pads, plus with --only-nets every footprint with a pad of
//!   those nets): the part's region = courtyard bbox grown by --escape-mm; sources are that part's pads only (the net's pads on other
//!   parts block the other escaping nets).
//!
//! Output: one line per region "PIN_ESCAPE PASS|FAIL region ... demand D flow F unescaped [...] cut [...]", then
//! "PIN_ESCAPE_SUMMARY ...". The unescaped nets are one valid choice of the losers (max-flow is not unique); "contested" lists every
//! net whose source is on the source side of the min cut (they share the bottleneck). Exit 1 on any FAIL.
mod check;
pub mod cli;
mod dinic;
mod items;
mod network;
mod raster;
mod report;
mod rules;
#[cfg(test)]
mod tests;
