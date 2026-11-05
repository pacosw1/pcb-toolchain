//! Admit only new requested-net copper from a native backend's board.
//!
//! Every original form must stay identical. Added copper is a proposal that still needs native DRC, refill and the
//! board's own gates.

use std::collections::BTreeSet;
use std::fs;
use std::path::Path;

use serde_json::{Value, json};

use super::board::Board;
use super::copper::Copper;
use super::digest::{copy_sidecars, file_sha256, geometry_digest, source_set};
use crate::error::{Result, invalid};
use crate::pyjson::indented;

fn check_nets(nets: &[String]) -> Result<()> {
    let unique = nets.iter().collect::<BTreeSet<_>>().len() == nets.len();
    if nets.is_empty() || !unique || nets.iter().any(String::is_empty) {
        return invalid("explicit unique net names required");
    }
    Ok(())
}

/// Remove `spans` from `text`. They must not overlap.
pub fn cut_spans(text: &str, mut spans: Vec<std::ops::Range<usize>>) -> String {
    spans.sort_by_key(|span| std::cmp::Reverse(span.start));
    let mut result = text.to_string();
    for span in spans {
        result.replace_range(span, "");
    }
    result
}

pub fn scope_native(source: &Path, candidate: &Path, out: &Path, nets: &[String]) -> Result<Value> {
    let (source, candidate, out) = (fs::canonicalize(source)?, fs::canonicalize(candidate)?, std::path::absolute(out)?);
    check_nets(nets)?;
    let sources = source_set(&source)?;
    let candidate_sha = file_sha256(&candidate)?;
    let (before, after) = (Board::read(&source)?, Board::read(&candidate)?);
    let (original, items) = (Copper::read(&before)?.ids(), Copper::read(&after)?);
    let added: BTreeSet<String> = items.ids().difference(&original).cloned().collect();
    let protected = geometry_digest(&before, &BTreeSet::new())?;
    if !original.is_subset(&items.ids()) || protected != geometry_digest(&after, &added)? {
        return invalid("backend changed protected native board content");
    }
    let (retained, discarded): (BTreeSet<String>, BTreeSet<String>) = added.iter().cloned()
        .partition(|id| items.get(id).is_some_and(|item| nets.contains(&item.net)));
    if retained.is_empty() {
        return invalid("backend proposed no new copper on requested nets");
    }
    let spans = discarded.iter().filter_map(|id| items.get(id)).map(|item| item.form.span.clone()).collect();
    let scoped = cut_spans(&after.text, spans);

    fs::create_dir(&out)?;
    let target = out.join("candidate.kicad_pcb");
    fs::write(&target, &scoped)?;
    copy_sidecars(&source, &target)?;
    let unchanged = sources == source_set(&source)? && candidate_sha == file_sha256(&candidate)?
        && protected == geometry_digest(&Board::from_text(scoped)?, &retained)?;
    if !unchanged {
        return invalid("source changed or protected geometry differs after scoping");
    }
    let record = json!({
        "schema": "iot-lab.native-candidate.v1", "status": "candidate", "qualified": false, "sources": sources,
        "backend_output_sha256": candidate_sha, "selected_nets": nets, "added_items": retained,
        "discarded_items": discarded, "protected_geometry_sha256": protected, "output_files": source_set(&target)?,
        "native_and_board_specific_gates_required": true,
    });
    fs::write(out.join("record.json"), indented(&record)?)?;
    Ok(record)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn spans_are_cut_from_the_end_so_earlier_ones_stay_valid() {
        assert_eq!(cut_spans("a(b)c(d)e", vec![1..4, 5..8]), "ace");
    }

    #[test]
    fn nets_must_be_named_once() {
        assert!(check_nets(&[]).is_err());
        assert!(check_nets(&["A".into(), "A".into()]).is_err());
        assert!(check_nets(&["A".into(), "B".into()]).is_ok());
    }
}
