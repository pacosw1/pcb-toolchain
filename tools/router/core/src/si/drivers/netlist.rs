//! The schematic netlist: `kicad-cli sch export netlist`, in KiCad's S-expression form so kicad::sexpr can read it.
use crate::kicad::sexpr::{self, Node as Form};
use crate::si::source::kicad_cli;
use std::collections::BTreeMap;
use std::path::Path;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

const EXPORT_TIMEOUT: Duration = Duration::from_secs(30);
const POLL: Duration = Duration::from_millis(20);

/// One pin on a net.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Node {
    pub part: String,
    pub pin: String,
    pub name: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Netlist {
    /// Reference -> MPN, else value.
    pub comps: BTreeMap<String, String>,
    pub values: BTreeMap<String, String>,
    /// In netlist order.
    pub nets: Vec<(String, Vec<Node>)>,
}

impl Netlist {
    pub fn net(&self, name: &str) -> Option<&[Node]> {
        self.nets.iter().find(|(n, _)| n == name).map(|(_, nodes)| nodes.as_slice())
    }

    /// The nets of a part with the pin on each: its pins in netlist order.
    pub fn pins_of<'a>(&'a self, part: &'a str) -> impl Iterator<Item = (&'a Node, &'a str)> {
        self.nets.iter().flat_map(move |(net, nodes)| nodes.iter().filter(move |n| n.part == part).map(move |n| (n, net.as_str())))
    }
}

/// The pin name of a netlist node: KiCad 10 writes pinfunction as NAME_NUMBER.
pub fn pin_name(pin: &str, function: &str) -> String {
    let name = function.strip_suffix(pin).and_then(|f| f.strip_suffix('_')).unwrap_or(function);
    if name.is_empty() { pin.to_string() } else { name.to_string() }
}

/// Every form with this head below `form`, in file order.
fn all<'a>(form: &'a Form, head: &'a str, out: &mut Vec<&'a Form>) {
    for item in form.items() {
        if item.is(head) {
            out.push(item);
        }
        all(item, head, out);
    }
}

fn comp_fields(comp: &Form) -> Option<String> {
    let mut fields = Vec::new();
    all(comp, "field", &mut fields);
    let mpn = fields.iter().rev().find(|f| f.value("name") == Some("MPN"))?;
    mpn.items().iter().skip(1).find_map(Form::atom).map(|t| t.trim().to_string()).filter(|t| !t.is_empty())
}

/// {comps, values, nets} from the text of a kicadsexpr netlist.
pub fn parse_netlist(text: &str) -> Result<Netlist, String> {
    let top = sexpr::parse(text)?;
    let root = top.first().ok_or("an empty netlist")?;
    let mut out = Netlist::default();
    let (mut comps, mut nets) = (Vec::new(), Vec::new());
    all(root, "comp", &mut comps);
    all(root, "net", &mut nets);
    for comp in comps {
        let reference = comp.value("ref").unwrap_or("").to_string();
        let value = comp.value("value").unwrap_or("").trim().to_string();
        out.comps.insert(reference.clone(), comp_fields(comp).unwrap_or_else(|| value.clone()));
        out.values.insert(reference, value);
    }
    for net in nets {
        let nodes = net.children("node").map(|node| {
            let pin = node.value("pin").unwrap_or("").to_string();
            Node { part: node.value("ref").unwrap_or("").to_string(), name: pin_name(&pin, node.value("pinfunction").unwrap_or("")), pin }
        });
        out.nets.push((net.value("name").unwrap_or("").to_string(), nodes.collect()));
    }
    Ok(out)
}

fn wait_for(child: &mut std::process::Child) -> Result<std::process::ExitStatus, String> {
    let deadline = Instant::now() + EXPORT_TIMEOUT;
    loop {
        if let Some(status) = child.try_wait().map_err(|e| e.to_string())? {
            return Ok(status);
        }
        if Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            return Err(format!("driver-netlist-export ran past {} s", EXPORT_TIMEOUT.as_secs()));
        }
        std::thread::sleep(POLL);
    }
}

/// Runs kicad-cli on the schematic and parses the netlist.
pub fn export_netlist(schematic: &Path) -> Result<Netlist, String> {
    if !schematic.is_file() {
        return Err(format!("no schematic {} (needed for the net drivers)", schematic.display()));
    }
    let folder = std::env::temp_dir().join(format!("si-netlist-{}", std::process::id()));
    std::fs::create_dir_all(&folder).map_err(|e| format!("{}: {e}", folder.display()))?;
    let out = folder.join("net.txt");
    let log = std::fs::File::create(folder.join("log.txt")).map_err(|e| e.to_string())?;
    let run = Command::new(kicad_cli()).args(["sch", "export", "netlist", "--format", "kicadsexpr", "-o"]).arg(&out).arg(schematic)
        .stdin(Stdio::null()).stdout(Stdio::null()).stderr(log).spawn().map_err(|e| format!("kicad-cli: {e}"))
        .and_then(|mut child| wait_for(&mut child));
    let text = std::fs::read_to_string(&out);
    let detail = std::fs::read_to_string(folder.join("log.txt")).unwrap_or_default();
    let _ = std::fs::remove_dir_all(&folder);
    match (run?.success(), text) {
        (true, Ok(text)) => parse_netlist(&text),
        _ => Err(format!("kicad-cli netlist export failed for {}: {}", schematic.display(), detail.trim().chars().rev().take(300).collect::<Vec<_>>().into_iter().rev().collect::<String>())),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const TEXT: &str = r#"(export (version "E")
  (components
    (comp (ref "U1") (value "X") (fields (field (name "Footprint") "a") (field (name "MPN") "  TPS1  ")))
    (comp (ref "R1") (value " 10k ") (fields (field (name "MPN")))))
  (nets
    (net (code "1") (name "/A") (class "Default")
      (node (ref "U1") (pin "3") (pinfunction "OUT_3") (pintype "output"))
      (node (ref "R1") (pin "1") (pintype "passive")))))
"#;

    #[test]
    fn the_part_is_its_mpn_else_its_value() {
        let n = parse_netlist(TEXT).unwrap();
        assert_eq!(n.comps["U1"], "TPS1");
        assert_eq!(n.comps["R1"], "10k");
        assert_eq!(n.values["R1"], "10k");
    }

    #[test]
    fn a_node_takes_its_function_without_the_number() {
        let n = parse_netlist(TEXT).unwrap();
        assert_eq!(n.net("/A").unwrap()[0], Node { part: "U1".to_string(), pin: "3".to_string(), name: "OUT".to_string() });
        assert_eq!(n.net("/A").unwrap()[1].name, "1");
    }

    #[test]
    fn pin_names_follow_kicad_10() {
        assert_eq!(pin_name("3", "OUT_3"), "OUT");
        assert_eq!(pin_name("3", "OUT"), "OUT");
        assert_eq!(pin_name("3", ""), "3");
    }
}
