//! Which single-unit moves the failure-driven repair routes next (tools/placer/README.md, "Failure-driven repair").
//!
//! The router is the judge; this part only proposes. Deterministic: no random state.
//!   failure  the failures of a route, the failure term and the candidate units
//!   search   legal places on the legalizer grid that lower a term
//!   corridor the units that wall in a failed IC pin
//!   decap    moves of single tied decaps in the loose problem (read with --decap-tie 0)
//!   rank     the order of the proposals
//!
//! tools/placer/repair.ts owns the loop: it routes the proposals and keeps a strictly better result.

pub mod cli;
pub mod corridor;
pub mod decap;
pub mod failure;
pub mod rank;
pub mod search;

use crate::congest::HistoryMap;
use crate::params::Params;
use crate::problem::Problem;
use failure::{Failure, candidates};
use rank::{Proposal, Tag, alternate, hot_order, interleave};
use search::{Scope, anywhere};
use serde::Serialize;

/// One round's question.
pub struct Request<'a> {
    pub problem: &'a Problem,
    /// The problem read with --decap-tie 0: single decaps may move too.
    pub loose: Option<&'a Problem>,
    pub fails: &'a [Failure],
    /// The --decap-tie distance of the problem, in mm.
    pub tie: f64,
    pub rotate: bool,
    pub escape: bool,
    /// The history of the present route: rank 'hot'.
    pub heat: Option<HistoryMap>,
}

/// One round's answer. `escape` is the part of `proposals` that opens a failed pin, in its own order.
#[derive(Debug, Serialize)]
pub struct Answer {
    pub candidates: Vec<String>,
    pub escape: Vec<Proposal>,
    pub proposals: Vec<Proposal>,
}

pub fn repair_proposals(req: &Request) -> crate::Result<Answer> {
    let pr = req.problem;
    let pose = pr.initial_pose();
    let main = Scope::new(pr, &pose, req.fails, req.rotate, Tag::Main);
    let mut props = search::proposals(&main, None, &anywhere)?;
    if let Some(loose) = req.loose {
        props.extend(decap::slides(pr, loose, req.fails, req.tie, req.rotate)?);
        props = interleave(props);
    }
    let mut esc = Vec::new();
    if req.escape {
        esc = corridor::proposals(&main, &anywhere)?;
        if let Some(loose) = req.loose {
            esc.extend(decap::escapes(pr, loose, req.fails, req.tie, req.rotate)?);
            esc = interleave(esc);
        }
    }
    let mut ordered = alternate(&esc, &props);
    if let Some(map) = &req.heat {
        ordered = hot_order(ordered, pr, req.loose, map);
    }
    let radius = Params::default().legal_radius;
    let names = candidates(pr, &pose, req.fails, radius).into_iter().map(|i| pr.units[i].name.clone()).collect();
    Ok(Answer { candidates: names, escape: esc, proposals: ordered })
}
