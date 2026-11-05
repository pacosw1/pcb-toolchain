//! Optional, non-authoritative epoch previews. Failures never affect placement.
use crate::problem::{Pose, Problem};
use serde::Serialize;
use sha2::{Digest,Sha256};
use std::io::Write;
use std::sync::Mutex;
use std::path::{Path,PathBuf};
use std::sync::atomic::{AtomicU64,Ordering};

const MAX_BOARD:u64=128*1024*1024;
const MAX_PREVIEW:usize=4*1024*1024;
static SERIAL:AtomicU64=AtomicU64::new(0);

#[derive(Serialize)]
struct Unit {name:String, refs:Vec<String>, origin:[f64;2], position:[f64;2], turn:u8}
#[derive(Serialize)]
struct Frame<'a> {schema:&'static str, board_path:&'a str, board_sha256:&'a str, model_sha256:&'a str, model_id:&'a str,
    rules_id:&'a str, attempt_id:&'a str, epoch:usize, epochs:usize, cost:f64, units:Vec<Unit>}

pub struct LivePreview {output:PathBuf, board_path:String, board_sha256:String, model_sha256:String, model_id:String,
    rules_id:String, attempt_id:String, units:Vec<(String,Vec<String>,[f64;2])>,
    fixed:Vec<bool>, stream:Mutex<Option<std::fs::File>>}

fn temporary(path:&Path) -> crate::Result<PathBuf> {
    let dir=path.parent().ok_or("preview parent missing")?;
    let id=SERIAL.fetch_add(1,Ordering::Relaxed);
    Ok(dir.join(format!(".iotplace-preview-{}-{id}.tmp",std::process::id())))
}
fn write_new(path:&Path, bytes:&[u8]) -> crate::Result<()> {
    let mut out=std::fs::OpenOptions::new().write(true).create_new(true).open(path)?;
    out.write_all(bytes)?; out.sync_all()?; Ok(())
}
fn hash(bytes:&[u8])->String {format!("{:x}",Sha256::digest(bytes))}
fn identity(name:&str)->crate::Result<String> {
    let value=std::env::var(name)?;
    if value.is_empty() || value.len()>256 || value.chars().any(char::is_control) {return Err("invalid preview identity".into());}
    Ok(value)
}
impl LivePreview {
    /// The board bytes are read and verified once before search; no source path is re-read later.
    pub fn from_environment(problem:&Problem,input:&Path,input_bytes:&[u8])->Option<Self> {
        Self::prepare(problem,input,input_bytes).ok()
    }
    fn prepare(problem:&Problem,input:&Path,input_bytes:&[u8])->crate::Result<Self> {
        let output=PathBuf::from(std::env::var("IOTPLACE_LIVE_FILE")?);
        let parent=output.parent().ok_or("preview directory missing")?.canonicalize()?;
        if parent.to_str().is_none_or(|s| s.chars().any(char::is_control)) {return Err("invalid preview directory".into());}
        let name=output.file_name().ok_or("preview filename missing")?;
        let output=parent.join(name);
        if name != "live-place.json" {return Err("unexpected preview filename".into());}
        let board=PathBuf::from(std::env::var("IOTPLACE_LIVE_BOARD")?).canonicalize()?;
        let expected=identity("IOTPLACE_LIVE_BOARD_SHA256")?;
        if expected.len()!=64 || !expected.bytes().all(|b|b.is_ascii_digit()||(b'a'..=b'f').contains(&b)) {return Err("invalid board digest".into());}
        let model_sha256=identity("IOTPLACE_LIVE_MODEL_SHA256")?;
        if model_sha256.len()!=64 || !model_sha256.bytes().all(|b|b.is_ascii_digit()||(b'a'..=b'f').contains(&b)) || hash(input_bytes)!=model_sha256 {
            return Err("preview model digest mismatch".into());
        }
        let value:serde_json::Value=serde_json::from_slice(input_bytes)?;
        let source=value["board_file"].as_str().ok_or("model board identity missing")?;
        if Path::new(source).canonicalize()? != board {return Err("model and preview board differ".into());}
        let rows=value["units"].as_array().ok_or("model units missing")?;
        if rows.len()!=problem.units.len() || rows.iter().zip(&problem.units).any(|(r,u)| {
            r["name"].as_str()!=Some(&u.name) || r["refs"]!=serde_json::json!(u.refs) ||
            r["x"].as_f64()!=Some(u.x) || r["y"].as_f64()!=Some(u.y)
        }) {return Err("preview model changed".into());}
        let (model_id,rules_id,attempt_id)=(identity("IOTPLACE_LIVE_MODEL_ID")?,identity("IOTPLACE_LIVE_RULES_ID")?,identity("IOTPLACE_LIVE_ATTEMPT_ID")?);
        if std::fs::metadata(&board)?.len()>MAX_BOARD {return Err("preview board exceeds limit".into());}
        let bytes=std::fs::read(&board)?;
        if bytes.len() as u64>MAX_BOARD || hash(&bytes)!=expected {return Err("preview board digest mismatch".into());}
        let base=parent.join("live-place-base.kicad_pcb");
        if board == output || board == base || input.canonicalize()? == output || input.canonicalize()? == base {
            return Err("preview path overlaps an input".into());
        }
        if std::fs::symlink_metadata(&base).is_ok_and(|m| m.file_type().is_symlink()) {return Err("preview base must not be a symlink".into());}
        if base.exists() {
            if std::fs::metadata(&base)?.len()>MAX_BOARD || hash(&std::fs::read(&base)?)!=expected {return Err("preview base differs".into());}
        } else {
            let temp=temporary(&base)?;
            let result=(|| -> crate::Result<()> {write_new(&temp,&bytes)?;std::fs::hard_link(&temp,&base)?;Ok(())})();
            let _=std::fs::remove_file(&temp); result?;
        }
        let units=problem.units.iter().map(|u|(u.name.clone(),u.refs.clone(),[u.x,u.y])).collect();
        Ok(Self {output,board_path:base.to_str().ok_or("non-UTF8 preview path")?.to_owned(),board_sha256:expected, model_sha256,
            model_id,rules_id,attempt_id,units, fixed:problem.units.iter().map(|u|u.fixed).collect(),
            stream:Mutex::new(std::env::var("PCB_LIVE_EVENTS").ok().and_then(|p| std::fs::OpenOptions::new().write(true).create_new(true).open(p).ok()))})
    }
    /// Append durable samples; an observer failure disables only observation.
    pub fn sample(&self, worker:usize, epoch:usize, step:usize, accepted:usize, rejected:usize,
        cost:f64, current:&Pose, best_cost:f64, best:&Pose) {
        let Ok(mut stream) = self.stream.lock() else { return };
        let Some(out) = stream.as_mut() else { return };
        if out.metadata().map_or(true, |m| m.len() > 512*1024*1024) { *stream=None; return; }
        let units = |pose:&Pose| self.units.iter().zip(pose).zip(&self.fixed).map(|(((name,refs,origin),&(x,y,turn)),fixed)|
            serde_json::json!({"name":name,"refs":refs,"origin":origin,"position":[x,y],"turn":turn,"locked":fixed})).collect::<Vec<_>>();
        let frame=serde_json::json!({"kind":"placement.sample","attemptId":self.attempt_id,"baseSha256":self.board_sha256,
            "worker":worker,"epoch":epoch,"step":step,"accepted":accepted,"rejected":rejected,
            "currentCost":cost,"bestCost":best_cost,"bestScope":"epoch","current":units(current),"best":units(best)});
        let result=(|| -> crate::Result<()> {let mut bytes=serde_json::to_vec(&frame)?;if bytes.len()>MAX_PREVIEW{return Err("live frame exceeds limit".into())}bytes.push(b'\n');out.write_all(&bytes)?;out.flush()?;Ok(())})();
        if result.is_err() { *stream=None; }
    }
    pub fn publish(&self,epoch:usize,epochs:usize,cost:f64,pose:&Pose) {
        let _=self.write(epoch,epochs,cost,pose);
    }
    fn write(&self,epoch:usize,epochs:usize,cost:f64,pose:&Pose)->crate::Result<()> {
        if pose.len()!=self.units.len() || !cost.is_finite() || pose.iter().any(|(x,y,r)|!x.is_finite()||!y.is_finite()||*r>3) {return Err("invalid preview pose".into());}
        let base=Path::new(&self.board_path);
        if std::fs::symlink_metadata(base)?.file_type().is_symlink() || std::fs::metadata(base)?.len()>MAX_BOARD ||
            hash(&std::fs::read(base)?)!=self.board_sha256 {return Err("preview base changed".into());}
        let units=self.units.iter().zip(pose).map(|((name,refs,origin),&(x,y,turn))|Unit {
            name:name.clone(),refs:refs.clone(),origin:*origin,position:[x,y],turn}).collect();
        let frame=Frame {schema:"iot-lab.placement-preview.v1",board_path:&self.board_path,board_sha256:&self.board_sha256,model_sha256:&self.model_sha256,
            model_id:&self.model_id,rules_id:&self.rules_id,attempt_id:&self.attempt_id,epoch,epochs,cost,units};
        let bytes=serde_json::to_vec(&frame)?;
        if bytes.len()>MAX_PREVIEW {return Err("preview exceeds limit".into());}
        let temp=temporary(&self.output)?;
        let result=(|| -> crate::Result<()> {write_new(&temp,&bytes)?;std::fs::rename(&temp,&self.output)?;Ok(())})();
        let _=std::fs::remove_file(&temp); result
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn changed_base_prevents_frame_update() {
        let root=std::env::temp_dir().join(format!("iotplace-live-base-{}",std::process::id()));
        std::fs::create_dir_all(&root).unwrap();
        let base=root.join("live-place-base.kicad_pcb");std::fs::write(&base,b"first").unwrap();
        let live=LivePreview {output:root.join("live-place.json"),board_path:base.to_str().unwrap().into(),
            board_sha256:hash(b"first"),model_sha256:"a".repeat(64),model_id:"m".into(),rules_id:"r".into(),
            attempt_id:"a".into(),units:vec![("U1".into(),vec!["U1".into()],[1.0,2.0])],fixed:vec![false],stream:Mutex::new(None)};
        live.write(1,2,1.0,&vec![(1.0,2.0,0)]).unwrap();
        let before=std::fs::read(&live.output).unwrap();
        std::fs::write(&base,b"changed").unwrap();
        live.publish(2,2,0.0,&vec![(3.0,4.0,0)]);
        assert_eq!(std::fs::read(&live.output).unwrap(),before);
        std::fs::remove_dir_all(root).unwrap();
    }
}
