//! Gerber polygon operations using the pinned GEOS C API (the same engine as Shapely 2.0.7).
use serde::Deserialize;
use std::{ffi::{c_char,c_int,c_void,CStr,CString}, io::{self,Read}};
type Ptr=*mut c_void;
type Init=unsafe extern "C" fn()->Ptr;
type Finish=unsafe extern "C" fn(Ptr);
type Version=unsafe extern "C" fn()->*const c_char;
type Reader=unsafe extern "C" fn(Ptr)->Ptr;
type ReadWkt=unsafe extern "C" fn(Ptr,Ptr,*const c_char)->Ptr;
type Destroy=unsafe extern "C" fn(Ptr,Ptr);
type Unary=unsafe extern "C" fn(Ptr,Ptr)->Ptr;
type Binary=unsafe extern "C" fn(Ptr,Ptr,Ptr)->Ptr;
type Buffer=unsafe extern "C" fn(Ptr,Ptr,f64,c_int)->Ptr;
type Area=unsafe extern "C" fn(Ptr,Ptr,*mut f64)->c_int;
type IsValid=unsafe extern "C" fn(Ptr,Ptr)->i8;
type Collection=unsafe extern "C" fn(Ptr,c_int,*mut Ptr,u32)->Ptr;
#[derive(Deserialize)] struct Poly { outer:Vec<[f64;2]>, #[serde(default)] holes:Vec<Vec<[f64;2]>> }
#[derive(Deserialize)] struct Stroke { points:Vec<[f64;2]>, width:f64 }
#[derive(Deserialize)] struct Request { operation:String, a:Vec<Poly>, #[serde(default)] b:Vec<Poly>, #[serde(default)] a_strokes:Vec<Stroke>, #[serde(default)] b_strokes:Vec<Stroke>, #[serde(default)] offset:f64 }
struct Api { handle:Ptr, ctx:Ptr, finish:Finish, reader:Ptr, reader_destroy:Destroy, read:ReadWkt, destroy:Destroy, unary:Unary, intersection:Binary, buffer:Buffer, area:Area, valid:IsValid, collection:Collection }
impl Api {
 unsafe fn load(path:&str)->Result<Self,String> {
  let path=CString::new(path).map_err(|e|e.to_string())?;
  let h=unsafe{libc::dlopen(path.as_ptr(),libc::RTLD_NOW|libc::RTLD_LOCAL)};
  if h.is_null(){return Err("could not load pinned GEOS library".into())}
  macro_rules! symbol {($name:literal,$t:ty)=>{{ let p=unsafe{libc::dlsym(h,concat!($name,"\0").as_ptr().cast())}; if p.is_null(){unsafe{libc::dlclose(h)};return Err(concat!("missing GEOS symbol ",$name).into());} unsafe{std::mem::transmute::<Ptr,$t>(p)} }};}
  let version:Version=symbol!("GEOSversion",Version);
  let ver=unsafe{CStr::from_ptr(version())}.to_string_lossy();
  if !ver.starts_with("3.11.4-CAPI-1.17.4") {unsafe{libc::dlclose(h)};return Err(format!("unexpected GEOS version {ver}"));}
  let init:Init=symbol!("GEOS_init_r",Init); let finish:Finish=symbol!("GEOS_finish_r",Finish);
  let new_reader:Reader=symbol!("GEOSWKTReader_create_r",Reader);
  let reader_destroy=symbol!("GEOSWKTReader_destroy_r",Destroy);
  let read=symbol!("GEOSWKTReader_read_r",ReadWkt);let destroy=symbol!("GEOSGeom_destroy_r",Destroy);
  let unary=symbol!("GEOSUnaryUnion_r",Unary);let intersection=symbol!("GEOSIntersection_r",Binary);
  let buffer=symbol!("GEOSBuffer_r",Buffer);let area=symbol!("GEOSArea_r",Area);let valid=symbol!("GEOSisValid_r",IsValid);
  let collection=symbol!("GEOSGeom_createCollection_r",Collection);
  let ctx=unsafe{init()};if ctx.is_null(){unsafe{libc::dlclose(h)};return Err("GEOS context failed".into())}
  let reader=unsafe{new_reader(ctx)};if reader.is_null(){unsafe{finish(ctx);libc::dlclose(h)};return Err("GEOS reader failed".into())}
  Ok(Self{handle:h,ctx,finish,reader,reader_destroy,read,destroy,unary,intersection,buffer,area,valid,collection})
 }
 fn read(&self,wkt:String)->Result<Ptr,String>{ let w=CString::new(wkt).map_err(|e|e.to_string())?;let p=unsafe{(self.read)(self.ctx,self.reader,w.as_ptr())};if p.is_null(){Err("GEOS WKT parse failed".into())}else{Ok(p)} }
 fn make(&self,polys:&[Poly],strokes:&[Stroke])->Result<Ptr,String>{
  let mut items:Vec<Ptr>=Vec::new();
  let build=(||->Result<(),String>{
   for p in polys {let mut rings=vec![ring(&p.outer)?];for h in &p.holes{rings.push(ring(h)?)};let mut shape=self.read(format!("POLYGON ({})",rings.join(",")))?;let valid=unsafe{(self.valid)(self.ctx,shape)};if valid==0 {let fixed=unsafe{(self.buffer)(self.ctx,shape,0.0,24)};unsafe{(self.destroy)(self.ctx,shape)};if fixed.is_null(){return Err("GEOS polygon repair failed".into())}shape=fixed;}else if valid!=1 {unsafe{(self.destroy)(self.ctx,shape)};return Err("GEOS validity check failed".into())}items.push(shape);}
   for s in strokes {if s.points.len()<2 || !s.width.is_finite() || s.width<=0.0{return Err("invalid stroke".into())}let line=self.read(format!("LINESTRING ({})",points(&s.points)?))?;let shape=unsafe{(self.buffer)(self.ctx,line,s.width/2.0,24)};unsafe{(self.destroy)(self.ctx,line)};if shape.is_null(){return Err("GEOS stroke buffer failed".into())}items.push(shape);}
   Ok(())
  })();
  if let Err(e)=build {for p in items {unsafe{(self.destroy)(self.ctx,p)}};return Err(e)}
  let group=unsafe{(self.collection)(self.ctx,7,items.as_mut_ptr(),items.len() as u32)};
  if group.is_null(){for p in items {unsafe{(self.destroy)(self.ctx,p)}};return Err("GEOS collection failed".into())}
  let out=unsafe{(self.unary)(self.ctx,group)};unsafe{(self.destroy)(self.ctx,group)};
  if out.is_null(){Err("GEOS union failed".into())}else{Ok(out)}
 }
}
impl Drop for Api {fn drop(&mut self){unsafe{(self.reader_destroy)(self.ctx,self.reader);(self.finish)(self.ctx);libc::dlclose(self.handle);}}}
fn points(p:&[[f64;2]])->Result<String,String>{if p.iter().flatten().any(|v|!v.is_finite()){return Err("nonfinite coordinate".into())}Ok(p.iter().map(|v|format!("{} {}",v[0],v[1])).collect::<Vec<_>>().join(","))}
fn ring(p:&[[f64;2]])->Result<String,String>{if p.len()<3{return Err("invalid polygon ring".into())}let mut q=p.to_vec();if q.first()!=q.last(){q.push(q[0]);}Ok(format!("({})",points(&q)?))}
fn execute(req:Request,path:&str)->Result<f64,String>{
 let api=unsafe{Api::load(path)}?;let a=api.make(&req.a,&req.a_strokes)?;let b=match api.make(&req.b,&req.b_strokes){Ok(v)=>v,Err(e)=>{unsafe{(api.destroy)(api.ctx,a)};return Err(e)}};
 let clip=match req.operation.as_str(){"intersection"=>b,"buffer_intersection"=>{let v=unsafe{(api.buffer)(api.ctx,b,req.offset,16)};unsafe{(api.destroy)(api.ctx,b)};v},_=>{unsafe{(api.destroy)(api.ctx,a);(api.destroy)(api.ctx,b)};return Err("unknown operation".into())}};
 if clip.is_null(){unsafe{(api.destroy)(api.ctx,a)};return Err("GEOS buffer failed".into())}
 let result=unsafe{(api.intersection)(api.ctx,a,clip)};unsafe{(api.destroy)(api.ctx,a);(api.destroy)(api.ctx,clip)};
 if result.is_null(){return Err("GEOS intersection failed".into())}let mut area=0.0;let ok=unsafe{(api.area)(api.ctx,result,&mut area)};unsafe{(api.destroy)(api.ctx,result)};
 if ok==0 || !area.is_finite() || area<0.0 {Err("GEOS area failed".into())}else{Ok(area)}
}
pub fn cli()->i32 {
 let mut input=String::new();
 let r=io::stdin().read_to_string(&mut input).map_err(|e|e.to_string()).and_then(|_| {
  let json:serde_json::Value=serde_json::from_str(&input).map_err(|e|e.to_string())?;
  let path=std::env::var("GERBER_GEOS_LIBRARY").map_err(|_|"GERBER_GEOS_LIBRARY is required".to_string())?;
  if json.is_array() {
   let requests:Vec<Request>=serde_json::from_value(json).map_err(|e|e.to_string())?;
   let results=requests.into_iter().map(|req|execute(req,&path)).collect::<Result<Vec<_>,_>>()?;
   serde_json::to_string(&serde_json::json!({"areas_mm2":results})).map_err(|e|e.to_string())
  } else {
   let request:Request=serde_json::from_value(json).map_err(|e|e.to_string())?;
   serde_json::to_string(&serde_json::json!({"area_mm2":execute(request,&path)?})).map_err(|e|e.to_string())
  }
 });
 match r{Ok(json)=>{println!("{json}");0},Err(e)=>{eprintln!("FAIL GEOS: {e}");1}}
}

#[cfg(test)] mod tests {
 use super::*;
 #[test] fn pinned_geos_matches_threshold_fixtures() {
  let Ok(path)=std::env::var("GERBER_GEOS_LIBRARY") else {return};
  for (x,want) in [(1.148901,9.98999999999973e-7),(1.1489,9.999999999998907e-7),(1.148899,1.0010000000000305e-6)] {
   let poly=|outer| Poly{outer,holes:vec![]};
   let req=Request{operation:"buffer_intersection".into(),a:vec![poly(vec![[x,0.1],[x+0.002,0.1],[x+0.002,0.101],[x,0.101]])],b:vec![poly(vec![[0.,0.],[1.,0.],[1.,1.],[0.,1.]])],a_strokes:vec![],b_strokes:vec![],offset:0.1499};
   let actual=execute(req,&path).unwrap();assert!((actual-want).abs()<1e-15,"{actual} vs {want}");
  }
 }
}
