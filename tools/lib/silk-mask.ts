// Plot the board's mask openings with KiCad, including board and pad mask margins. Read-only.
// Custom solder-mask expansion rules are refused: KiCad's plot has not been shown to honor them.
// maskOpenings reads all plotted mask; padMaskOpenings isolates pad openings for silk clip.
import {copyFileSync,existsSync,mkdtempSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {basename,join} from 'node:path';
import {runDaemonJob} from './daemon-job.ts';
import {PINNED_IMAGE} from './env.mjs';
import {sha256File} from './json-file.ts';
import {parseCopper,QUADRANT_SEGMENTS} from './gerber.ts';
import {childForms} from './footprint-move.ts';
import {kids,parse} from './sexpr.ts';
import {Outline} from './copper-graph.ts';

export type MaskPlot = Record<'F'|'B',string>;
export type MaskExporter = (pcb:string,sidecars:string[])=>MaskPlot;
const chordErrors=new WeakMap<Outline,number>();
/** Maximum radial deficit of the actual parser's inscribed C/O aperture chords, in mm. */
export const maskChordError=(outlines:Outline[]):number=>Math.max(0,...outlines.map(shape=>chordErrors.get(shape)??0));
/** The copper parser does not preserve curved region edges. Never use those as a mask keep-out. */
export function parseMask(text:string):Outline[] {
 if(/G0?[23](?=[XYIJ*])/i.test(text.replace(/\s/g,'')))throw new Error('silk mask: curved Gerber interpolation is not supported safely');
 const inches=/%MOIN\*%/.test(text);
 let error=0;
 for(const match of text.matchAll(/%ADD\d+([CO]),([^*%]+)\*%/g)) {
  const dimensions=match[2]!.split('X').map(Number);
  if(dimensions.some(v=>!Number.isFinite(v)||v<0||v*(inches?25.4:1)>10))throw new Error('silk mask: curved aperture exceeds the supported 10 mm bound');
  const radius=(match[1]==='C'?dimensions[0]!:Math.min(...dimensions.slice(0,2)))*(inches?25.4:1)/2;
  error=Math.max(error,radius*(1-Math.cos(Math.PI/(4*QUADRANT_SEGMENTS))));
 }
 // Gerber is Y-up; KiCad board coordinates are Y-down. Keep the board origin (no auxiliary origin flag).
 return parseCopper(text).map(shape=>{const out=new Outline(shape.points.map(([x,y])=>[x,-y]));chordErrors.set(out,error);return out;});
}
function snapshots(files:string[]):string[] {return files.map(p=>existsSync(p)?sha256File(p):'');}
export function maskOpenings(pcb:string, exporter:MaskExporter=plotMask):Record<'F'|'B',Outline[]> {
 if(!pcb.endsWith('.kicad_pcb'))throw new Error('expected a .kicad_pcb file');
 const stem=pcb.slice(0,-'.kicad_pcb'.length),files=[pcb,stem+'.kicad_pro',stem+'.kicad_dru'];
 const before=snapshots(files);if(!before[0])throw new Error('mask plot board is missing');
 if(before[2] && /solder_mask_expansion/i.test(readFileSync(files[2]!,'utf8')))throw new Error('mask plot cannot verify custom solder-mask expansion rules');
 const result=exporter(pcb,files.slice(1).filter(existsSync));
 if(JSON.stringify(before)!==JSON.stringify(snapshots(files)))throw new Error('board or sidecars changed during mask plot');
 if(typeof result.F!=='string'||typeof result.B!=='string')throw new Error('mask plot did not return both sides');
 return {F:parseMask(result.F),B:parseMask(result.B)};
}
function plotMask(pcb:string,sidecars:string[]):MaskPlot {
 const name=basename(pcb,'.kicad_pcb');let result:MaskPlot|undefined;
 runDaemonJob({label:'KiCad solder-mask plot',inputs:[pcb,...sidecars],image:PINNED_IMAGE,timeoutS:300,cpus:1,memGb:2,
  command:['sh','-c','mkdir -p out/gerbers && kicad-cli pcb export gerbers --layers F.Mask,B.Mask --no-protel-ext --output out/gerbers "in/$1"','_',basename(pcb)]},out=>{
   const root=join(out,'gerbers');
   result={F:readFileSync(join(root,`${name}-F_Mask.gbr`),'utf8'),B:readFileSync(join(root,`${name}-B_Mask.gbr`),'utf8')};
  });
 if(!result)throw new Error('mask plot returned no result');return result;
}

/** Produce a plot-only board containing only pads and board/project settings; never save this over the source. */
export function padsOnlyBoard(text:string):string {
 const topKeep=new Set(['version','generator','generator_version','general','paper','title_block','layers','setup','net','footprint','embedded_fonts']);
 const fpDrop=new Set(['property','fp_text','fp_text_box','fp_line','fp_rect','fp_circle','fp_arc','fp_poly','fp_curve','fp_image','zone','group','model']);
 const spans=childForms(text);let out='',at=0;
 for(const span of spans){
  out+=text.slice(at,span.start);const raw=text.slice(span.start,span.end);at=span.end;
  if(!topKeep.has(span.kind))continue;
  if(span.kind!=='footprint'){out+=raw;continue;}
  let fp='',offset=0;
  for(const part of childForms(raw)){
   fp+=raw.slice(offset,part.start);const body=raw.slice(part.start,part.end);
   const layer=kids(parse(body),'layer')[0]?.[1];
   const maskGraphic=part.kind!=='pad' && (layer==='F.Mask' || layer==='B.Mask');
   if(!fpDrop.has(part.kind) && !part.kind.startsWith('fp_') && !maskGraphic)fp+=body;
   offset=part.end;
  }
  out+=fp+raw.slice(offset);
 }
 return out+text.slice(at);
}

/** Plot pads alone from a disposable board while retaining its project and design rules. */
export function padMaskOpenings(pcb:string,exporter:MaskExporter=plotMask):Record<'F'|'B',Outline[]> {
 if(!pcb.endsWith('.kicad_pcb'))throw new Error('expected a .kicad_pcb file');
 const stem=pcb.slice(0,-'.kicad_pcb'.length),files=[pcb,stem+'.kicad_pro',stem+'.kicad_dru'],before=snapshots(files);
 if(!before[0])throw new Error('mask plot board is missing');
 const folder=mkdtempSync(join(tmpdir(),'silk-pad-mask-'));
 try {
  const copy=join(folder,basename(pcb)),copyStem=copy.slice(0,-'.kicad_pcb'.length);
  writeFileSync(copy,padsOnlyBoard(readFileSync(pcb,'utf8')),{flag:'wx'});
  for(const [index,suffix] of [[1,'.kicad_pro'],[2,'.kicad_dru']] as const)if(before[index])copyFileSync(files[index]!,copyStem+suffix);
  const result=maskOpenings(copy,exporter);
  const root=parse(readFileSync(copy,'utf8'));
  const pads=kids(root,'footprint').flatMap(fp=>kids(fp,'pad'));
  for(const side of ['F','B'] as const) {
   const expected=pads.some(p=>{const layers=kids(p,'layers')[0]?.slice(1)??[];return layers.includes(side+'.Mask') || layers.includes('*.Mask');});
   if(expected && !result[side].length)throw new Error(`pad mask plot omitted all ${side} openings`);
  }
  if(JSON.stringify(before)!==JSON.stringify(snapshots(files)))throw new Error('board or sidecars changed during pad mask plot');
  return result;
 } finally {rmSync(folder,{recursive:true,force:true});}
}
