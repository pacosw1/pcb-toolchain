//! JSON-in/JSON-out adapter for route jobs, which have no Node runtime.
use route_coverage::{
    Result,
    board::Iotroute,
    evidence, thermal,
};
use serde_json::Value;
use std::{
    io::{self, Read},
    path::Path,
    process::ExitCode,
};
fn path<'a>(v: &'a Value, key: &str) -> Result<&'a Path> {
    Ok(Path::new(v[key].as_str().ok_or(format!("missing {key}"))?))
}
fn run(operation: &str, v: Value) -> Result<Value> {
    let validator = thermal::Validator::new(
        Iotroute,
        std::env::current_exe().map_err(|e| e.to_string())?,
    );
    match operation{
        "admit"=>validator.admit(path(&v,"source")?,path(&v,"base")?,v["enabled"]==true,&thermal::nets(&v["selected_nets"])?,path(&v,"initial_fill_receipt")?,path(&v,"initial_drc_receipt")?),
        "validate-capability"=>validator.validate_capability(&v["capability"],path(&v,"source")?,path(&v,"base")?,&thermal::nets(&v["selected_nets"])?,v.get("required_count")),
        "discharge"=>validator.discharge(&v["capability"],path(&v,"candidate")?,path(&v,"fill_receipt")?,path(&v,"drc_receipt")?),
        _=>Err("usage: route-coverage admit|validate-capability|discharge [request.json]; otherwise reads stdin".into())
    }
}
fn main() -> ExitCode {
    let mut args = std::env::args().skip(1);
    let op = args.next().unwrap_or_default();
    let result = (|| -> Result<Value> {
        let text = if let Some(file) = args.next() {
            std::fs::read_to_string(file).map_err(|e| e.to_string())?
        } else {
            let mut text = String::new();
            io::stdin()
                .read_to_string(&mut text)
                .map_err(|e| e.to_string())?;
            text
        };
        if args.next().is_some() {
            return Err("unexpected argument".into());
        }
        run(&op, evidence::parse(&text)?)
    })();
    match result {
        Ok(v) => {
            println!("{}", serde_json::to_string(&v).unwrap());
            ExitCode::SUCCESS
        }
        Err(e) => {
            eprintln!("FAIL: route-coverage: {e}");
            ExitCode::from(2)
        }
    }
}
