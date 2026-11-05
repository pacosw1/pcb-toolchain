// Plot the board's mask openings with KiCad, including board and pad mask margins. Read-only.
// Custom solder-mask expansion rules are refused: KiCad's plot has not been shown to honor them.
// This is the complete plotted mask, including non-pad openings; it is not yet a replacement for silk clip.
import {existsSync,readFileSync} from 'node:fs';
import {basename,join} from 'node:path';
import {runDaemonJob} from './daemon-job.ts';
import {PINNED_IMAGE} from './env.mjs';
import {sha256File} from './json-file.ts';
import {parseCopper} from './gerber.ts';
import type {Outline} from './copper-graph.ts';

export type MaskPlot = Record<'F'|'B',string>;
export type MaskExporter = (pcb:string,sidecars:string[])=>MaskPlot;
function snapshots(files:string[]):string[] {return files.map(p=>existsSync(p)?sha256File(p):'');}
export function maskOpenings(pcb:string, exporter:MaskExporter=plotMask):Record<'F'|'B',Outline[]> {
 if(!pcb.endsWith('.kicad_pcb'))throw new Error('expected a .kicad_pcb file');
 const stem=pcb.slice(0,-'.kicad_pcb'.length),files=[pcb,stem+'.kicad_pro',stem+'.kicad_dru'];
 const before=snapshots(files);if(!before[0])throw new Error('mask plot board is missing');
 if(before[2] && /solder_mask_expansion/i.test(readFileSync(files[2]!,'utf8')))throw new Error('mask plot cannot verify custom solder-mask expansion rules');
 const result=exporter(pcb,files.slice(1).filter(existsSync));
 if(JSON.stringify(before)!==JSON.stringify(snapshots(files)))throw new Error('board or sidecars changed during mask plot');
 if(typeof result.F!=='string'||typeof result.B!=='string')throw new Error('mask plot did not return both sides');
 return {F:parseCopper(result.F),B:parseCopper(result.B)};
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
