//! route_plan ROUTE.json --copper F.Cu,B.Cu [--features a,b]
//!
//! Prints the normalized plan of a route.json as JSON, for tools that do not link the core. --copper is the copper layer
//! list of the board; --features, when given, is the list of known route feature names.
//! Exit 0 on a valid plan, 1 on an invalid one with the errors on stderr, 2 on a usage error.
use iotroute::plan;
use std::collections::BTreeSet;
use std::process::ExitCode;

const USAGE: &str = "usage: route_plan ROUTE.json --copper F.Cu,B.Cu [--features a,b]";

struct Options {
    route: String,
    copper: Vec<String>,
    features: Option<BTreeSet<String>>,
}

fn list(text: &str) -> impl Iterator<Item = String> + '_ {
    text.split(',').filter(|item| !item.is_empty()).map(str::to_string)
}

fn options(mut args: impl Iterator<Item = String>) -> Option<Options> {
    let (mut route, mut copper, mut features) = (None, None, None);
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--copper" => copper = Some(list(&args.next()?).collect()),
            "--features" => features = Some(list(&args.next()?).collect()),
            _ if route.is_none() && !arg.starts_with("--") => route = Some(arg),
            _ => return None,
        }
    }
    Some(Options { route: route?, copper: copper?, features })
}

fn run(options: &Options) -> Result<String, String> {
    let text = std::fs::read_to_string(&options.route).map_err(|e| format!("{}: {e}", options.route))?;
    let cfg = serde_json::from_str(&text).map_err(|e| format!("{}: {e}", options.route))?;
    let plan = plan::load(&cfg, &options.copper, options.features.as_ref())?;
    serde_json::to_string(&plan).map_err(|e| e.to_string())
}

fn main() -> ExitCode {
    let Some(options) = options(std::env::args().skip(1)) else {
        eprintln!("{USAGE}");
        return ExitCode::from(2);
    };
    match run(&options) {
        Ok(json) => {
            println!("{json}");
            ExitCode::SUCCESS
        }
        Err(error) => {
            eprintln!("route_plan: {error}");
            ExitCode::FAILURE
        }
    }
}
