//! gnd_pad_vias BOARD.kicad_pcb OUT.kicad_pcb [--net GND] [--skip U1,U10.3] [--r 1.0] [--width 0.4] [--via DIA DRILL]
//!              [--clearance 0.2] [--pth-hole 0.45] [--only REF.PAD,...] [--in-pad]
//!
//! A plane via next to each SMD pad of a net; see iotroute::gnd_pad_vias. Reads through a KiCad API server (env KICAD_API_CLI) and
//! saves through KiCad 10 (env KICAD_CLI). The last two lines say what was done; exit 0 also when pads are left: DRC decides.
use iotroute::gnd_pad_vias::{Options, run, summary};
use iotroute::tool_args::{Args, list};
use std::path::Path;
use std::process::ExitCode;

const USAGE: &str = "usage: gnd_pad_vias BOARD OUT [--net GND] [--skip LIST] [--r MM] [--width MM] [--via DIA DRILL] [--clearance MM] [--pth-hole MM] [--only LIST] [--in-pad]";

fn options(args: &mut Args) -> Result<(String, String, Options), String> {
    let mut o = Options::default();
    let mut paths = Vec::new();
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--net" => o.net = args.value(&arg)?,
            "--skip" => o.skip = list(&args.value(&arg)?).collect(),
            "--only" => o.only = list(&args.value(&arg)?).collect(),
            "--r" => o.radius = args.number(&arg)?,
            "--width" => o.width = args.number(&arg)?,
            "--via" => o.via = (args.number(&arg)?, args.number(&arg)?),
            "--clearance" => o.clearance = args.number(&arg)?,
            "--pth-hole" => o.pth_hole = args.number(&arg)?,
            "--in-pad" => o.in_pad = true,
            other if other.starts_with("--") => return Err(format!("unknown option {other}")),
            _ => paths.push(arg),
        }
    }
    let [board, out] = <[String; 2]>::try_from(paths).map_err(|_| "two paths wanted".to_string())?;
    Ok((board, out, o))
}

fn main() -> ExitCode {
    let (board, out, o) = match options(&mut Args::from_env()) {
        Ok(parsed) => parsed,
        Err(e) => {
            eprintln!("{e}\n{USAGE}");
            return ExitCode::from(2);
        }
    };
    match run(Path::new(&board), Path::new(&out), &o) {
        Ok(plan) => {
            summary(&plan, &o.net).iter().for_each(|line| println!("{line}"));
            ExitCode::SUCCESS
        }
        Err(e) => {
            eprintln!("gnd_pad_vias: {e}");
            ExitCode::from(1)
        }
    }
}
