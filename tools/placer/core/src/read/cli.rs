//! `iotplace read BOARD.kicad_pcb --board-json DOC.json -o PROB.json [flags]`. A flag takes `--flag v ...` or `--flag=v`.

use super::options::{Members, Options, parse_domain, parse_edge, parse_in_box, parse_near};
use super::out::ProblemOut;
use super::read_problem;
use crate::geom::Rect;
use crate::kicad::doc::load_board;
use std::path::{Path, PathBuf};

/// The flags of one command line: each flag with the words after it.
pub struct Flags {
    pub positional: Vec<String>,
    values: Vec<(String, Vec<String>)>,
}

impl Flags {
    /// A word that starts with `-` and is no number ends the words of a flag. `switches` take no words.
    pub fn parse(argv: &[String], switches: &[&str]) -> Self {
        Self::scan(argv, switches, usize::MAX)
    }

    /// As `parse`, with one word per flag: positional words may follow a flag.
    pub fn parse_single(argv: &[String], switches: &[&str]) -> Self {
        Self::scan(argv, switches, 1)
    }

    fn scan(argv: &[String], switches: &[&str], words_per_flag: usize) -> Self {
        let mut flags = Self { positional: Vec::new(), values: Vec::new() };
        let mut open = false;
        for arg in argv {
            if arg.starts_with('-') && arg.parse::<f64>().is_err() {
                let (name, value) = arg.split_once('=').map_or((arg.as_str(), None), |(n, v)| (n, Some(v.to_string())));
                open = value.is_none() && !switches.contains(&name);
                flags.values.push((name.to_string(), value.into_iter().collect()));
            } else if open {
                if let Some((_, words)) = flags.values.last_mut() {
                    words.push(arg.clone());
                    open = words.len() < words_per_flag;
                }
            } else {
                flags.positional.push(arg.clone());
            }
        }
        flags
    }

    pub fn has(&self, name: &str) -> bool {
        self.values.iter().any(|(n, _)| n == name)
    }

    /// All the words of a flag, over every time it is given.
    pub fn list(&self, name: &str) -> Vec<String> {
        self.last(name).map_or(Vec::new(), <[String]>::to_vec)
    }

    fn last(&self, name: &str) -> Option<&[String]> {
        self.values.iter().rev().find(|(n, _)| n == name).map(|(_, v)| v.as_slice())
    }

    pub fn one(&self, name: &str) -> crate::Result<Option<&str>> {
        match self.last(name) {
            None => Ok(None),
            Some([v]) => Ok(Some(v)),
            Some([]) => Err(format!("{name} needs a value").into()),
            Some([_, rest @ ..]) => Err(format!("unexpected words after {name}: {}", rest.join(" ")).into()),
        }
    }

    pub fn number<T: std::str::FromStr>(&self, name: &str, default: T) -> crate::Result<T> {
        self.one(name)?.map_or(Ok(default), |v| v.parse().map_err(|_| format!("{name}: bad value {v}").into()))
    }

    fn rect(&self, name: &str) -> crate::Result<Option<Rect>> {
        let Some(words) = self.last(name) else { return Ok(None) };
        let v: Vec<f64> = words.iter().map(|w| w.parse()).collect::<Result<_, _>>().map_err(|_| format!("{name}: bad number"))?;
        match v[..] {
            [a, b, c, d] => Ok(Some(Rect::new(a, b, c, d))),
            _ => Err(format!("{name} takes 4 numbers").into()),
        }
    }

    pub fn path(&self, name: &str) -> crate::Result<PathBuf> {
        self.one(name)?.map(PathBuf::from).ok_or_else(|| format!("{name} is required").into())
    }
}

fn comma_list(value: Option<&str>, default: &str) -> Vec<String> {
    value.unwrap_or(default).split(',').filter(|x| !x.is_empty()).map(String::from).collect()
}

fn load_members(path: &str) -> crate::Result<Members> {
    let text = std::fs::read_to_string(path).map_err(|e| format!("{path}: {e}"))?;
    Ok(serde_json::from_str(&text)?)
}

/// The defaults of the command line, which differ from `Options::default` for the ties.
pub fn options(f: &Flags) -> crate::Result<Options> {
    let zone_ref = |x: &String| x.split_once('=').map(|(a, b)| (a.to_string(), b.to_string())).ok_or_else(|| format!("bad --zone-ref {x}: use ZONE=REF"));
    let domains: Vec<_> = f.list("--domain").iter().map(|d| parse_domain(d)).collect::<crate::Result<_>>()?;
    Ok(Options {
        fix: f.list("--fix"),
        skip: comma_list(f.one("--skip-net")?, "GND"),
        edge_dist: f.number("--edge-dist", 1.5)?,
        keepout_layers: f.list("--keepout-layer"),
        free_box: f.rect("--free-box")?,
        region_refs: f.list("--region-ref"),
        region_weight: f.number("--region-weight", 1.0)?,
        region_box: f.rect("--region-box")?,
        tie: f.number("--tie", 0.0)?,
        rigid_nets: comma_list(f.one("--rigid-net")?, "*SW*"),
        rigid_groups: f.list("--rigid-group").iter().map(|group| group.split(',').map(String::from).collect()).collect(),
        // A cluster is soft: a cap near its IC becomes rigid with it only when the flag says so.
        decap_tie: f.number("--decap-tie", if f.has("--auto-clusters") { 0.0 } else { 3.0 })?,
        keepout_zones: f.list("--keepout-zone"),
        edges: f.list("--edge").iter().map(|e| parse_edge(e)).collect::<crate::Result<_>>()?,
        zone_refs: f.list("--zone-ref").iter().map(zone_ref).collect::<Result<_, _>>()?,
        domains: (!domains.is_empty()).then_some(domains),
        via_nets: f.list("--via-net"),
        blocks: f.one("--blocks")?.map(load_members).transpose()?,
        w_block: f.number("--w-block", 4.0)?,
        w_comp: f.number("--w-comp", 1.0)?,
        tp_pins: f.has("--tp-pins"),
        in_boxes: f.list("--in-box").iter().map(|b| parse_in_box(b)).collect::<crate::Result<_>>()?,
        near: f.list("--near").iter().map(|n| parse_near(n)).collect::<crate::Result<_>>()?,
        auto_clusters: f.has("--auto-clusters").then(|| f.number("--w-clu", 1.0)).transpose()?,
        ..Options::default()
    })
}

fn summary(pr: &ProblemOut) {
    let movable = pr.units.iter().filter(|u| !u.fixed).count();
    let blocks = pr.units.iter().filter(|u| u.boxed.is_some()).count();
    println!("units {} (movable {movable}, blocks {blocks}), nets {}, keepouts {}", pr.units.len(), pr.nets.len(), pr.board.keepouts.len());
    if !pr.dru_ignored.is_empty() {
        println!("NOT MODELLED .kicad_dru rules (check them after placement): {}", pr.dru_ignored.join(", "));
    }
    let far: Vec<String> = pr.decaps.iter().filter(|d| d.2 > 1.0).map(|d| format!("{}-{} {:.2}", d.0, d.1, d.2)).collect();
    println!("decaps {} tied, {} over 1.0 mm (D-040): {}", pr.decaps.len(), far.len(), far.join(" "));
    for c in &pr.clusters {
        let ties: Vec<String> = c.ties.iter().map(|t| format!("{}: {}", t.rule, t.why)).collect();
        println!("cluster {}: {}", c.name, ties.join("; "));
    }
}

pub fn run(argv: &[String]) -> crate::Result<()> {
    let flags = Flags::parse(argv, &["--tp-pins", "--auto-clusters"]);
    let [board_file] = &flags.positional[..] else { return Err("usage: iotplace read BOARD.kicad_pcb --board-json DOC.json -o PROB.json".into()) };
    let board = load_board(&flags.path("--board-json")?)?;
    let output = flags.path("-o")?;
    let pr = read_problem(Path::new(board_file), &board, &options(&flags)?)?;
    std::fs::write(output, serde_json::to_string(&pr)?)?;
    summary(&pr);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::kicad::doc::Footprint;

    fn flags(words: &[&str]) -> Flags {
        let argv: Vec<String> = words.iter().map(|w| w.to_string()).collect();
        Flags::parse(&argv, &["--tp-pins"])
    }

    #[test]
    fn a_flag_takes_words_until_the_next_flag() {
        let f = flags(&["B.kicad_pcb", "--fix", "J1", "J2", "--tp-pins", "extra", "--skip-net=-15V,GND", "--free-box", "0", "-1", "2", "3"]);
        assert_eq!(f.positional, ["B.kicad_pcb", "extra"]);
        assert_eq!(f.list("--fix"), ["J1", "J2"]);
        assert!(f.has("--tp-pins"));
        assert_eq!(f.one("--skip-net").unwrap(), Some("-15V,GND"));
        assert_eq!(f.rect("--free-box").unwrap(), Some(Rect::new(0.0, -1.0, 2.0, 3.0)));
    }

    #[test]
    fn board_first_fix_marks_the_requested_footprint_fixed() {
        let f = flags(&["B.kicad_pcb", "--board-json", "B.json", "-o", "out.json", "--fix", "U1"]);
        let options = options(&f).unwrap();
        let footprint = Footprint { reference: "U1".into(), layer: "F.Cu".into(), ..Footprint::default() };
        let outline = [(0.0, 0.0), (10.0, 0.0), (10.0, 10.0), (0.0, 10.0)];
        assert!(super::super::parts::part_fixed(&footprint, Rect::new(4.0, 4.0, 6.0, 6.0), &outline, &options, &[]));
        assert!(!super::super::parts::part_fixed(&footprint, Rect::new(4.0, 4.0, 6.0, 6.0), &outline, &Options::default(), &[]));
    }

    #[test]
    fn the_defaults_are_the_command_line_ones() {
        let o = options(&flags(&[])).unwrap();
        assert_eq!((o.skip.as_slice(), o.rigid_nets.as_slice(), o.decap_tie, o.w_block, o.w_comp), (&["GND".to_string()][..], &["*SW*".to_string()][..], 3.0, 4.0, 1.0));
    }
}
