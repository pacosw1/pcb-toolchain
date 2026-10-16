import {createHash} from 'node:crypto';
import {existsSync, readFileSync, statSync} from 'node:fs';
import {join, resolve} from 'node:path';

const unique = values => [...new Set(values)].sort();
const finite = value => typeof value === 'number' && Number.isFinite(value);
const read = file => JSON.parse(readFileSync(file,'utf8'));
const coordinate = (pos, unit) => pos && finite(pos.x) && finite(pos.y) ? {x:pos.x,y:pos.y,...(unit ? {unit} : {})} : undefined;
function finish(finding, identities = []) {
  const {stage,rule,refs,nets,location,message} = finding;
  const identity = identities.length ? unique(identities) : refs?.length || nets?.length || location ? {refs,nets,location} : message;
  return {id:createHash('sha256').update(JSON.stringify({stage,rule,identity})).digest('hex').slice(0,24),...finding};
}
function entities(text) {
  const refs = unique([...text.matchAll(/\b([A-Z]{1,5}\d+[A-Za-z]?)\b/g)].map(m=>m[1]));
  const nets = unique([...text.matchAll(/\[([^\]\n]+)\]/g)].map(m=>m[1]));
  return {...(refs.length ? {refs} : {}),...(nets.length ? {nets} : {})};
}
function measurements(text) {
  const values = {};
  const compared = text.match(/(-?\d+(?:\.\d+)?)\s*(mm|A|ns|ohm|Ω)\s*(<|>|<=|>=|≤|≥)\s*(-?\d+(?:\.\d+)?)\s*\2\b/);
  if (compared) {
    values.measured={value:Number(compared[1]),unit:compared[2]};
    values.required={value:Number(compared[4]),unit:compared[2]};
    values.comparison=compared[3];
  }
  const actual = text.match(/\bactual\s+(-?\d+(?:\.\d+)?)\s*(mm|A|ns|ohm|Ω)/i);
  if (actual) values.measured={value:Number(actual[1]),unit:actual[2]};
  const clearance = text.match(/\b(clearance|track width|hole clearance)\s+(-?\d+(?:\.\d+)?)\s*(mm)\b/i);
  if (actual && clearance) values.required={name:clearance[1],value:Number(clearance[2]),unit:clearance[3]};
  const source = text.match(/\b(netclass|rule)\s+'([^']+)'/i);
  if (source) values.source={kind:source[1].toLowerCase(),name:source[2]};
  return values;
}

export function nativeFindings(report, stage) {
  const groups = stage === 'erc' ? report.sheets.flatMap((sheet,i) => [{items:sheet.violations,pointer:`/sheets/${i}/violations`,kind:'erc',sheet:sheet.path}]) :
    ['violations','schematic_parity','unconnected_items'].map(kind => ({items:report[kind],pointer:`/${kind}`,kind}));
  return groups.flatMap(group => (group.items ?? []).map((row,index) => {
    const items = Array.isArray(row.items) ? row.items : [];
    const descriptions = items.map(item=>item.description ?? '').join('\n');
    const refs = unique(items.flatMap(item => item.ref ? [item.ref] : [...(item.description ?? '').matchAll(/\b(?:of|Footprint|Symbol)\s+([A-Z]{1,5}\d+[A-Za-z]?)\b/g)].map(m=>m[1])));
    const nets = unique(items.flatMap(item => item.net ? [item.net] : [...(item.description ?? '').matchAll(/\[([^\]\n]+)\]/g)].map(m=>m[1])));
    const positions = items.map(item=>coordinate(item.pos,report.coordinate_units)).filter(Boolean);
    const pads=items.flatMap(item=>{
      const pad=(item.description ?? '').match(/\bPad\s+(\S+)\s.*\bof\s+([A-Z]{1,5}\d+[A-Za-z]?)\b/);
      return pad ? [{ref:pad[2],pad:pad[1]}] : [];
    });
    const message = row.description ?? row.message ?? row.type ?? `${stage} ${group.kind} entry`;
    const identities = items.map(item=>item.uuid).filter(value=>typeof value==='string');
    const data = {stage,rule:row.type ?? group.kind,severity:row.severity ?? 'error',message,
      evidence:{path:`${stage}.json`,pointer:`${group.pointer}/${index}`},
      ...(refs.length ? {refs} : {}),...(nets.length ? {nets} : {}),
      ...(pads.length ? {pads} : {}),
      ...(positions.length ? {location:positions[0],locations:positions} : {}),
      ...(group.sheet ? {sheet:group.sheet} : {}),...measurements(message),
      ...Object.fromEntries(['measured','required','source'].filter(key=>key in row).map(key=>[key,row[key]]))};
    if (items.length) data.items=items.map(item=>({
      ...(item.uuid ? {uuid:item.uuid} : {}),...(item.description ? {description:item.description} : {}),
      ...(coordinate(item.pos,report.coordinate_units) ? {location:coordinate(item.pos,report.coordinate_units)} : {})}));
    // A description is retained verbatim; refs/nets come only from explicit
    // native fields or native item phrases, never guessed from free prose.
    return finish(data,identities.length ? identities : descriptions ? [descriptions] : []);
  }));
}

export function logFindings(text, stage) {
  const rows=[];
  for (const [index,line] of text.split(/\r?\n/).entries()) {
    const match=line.match(/^\s*(FAIL|WARN|LOW|MISSING|STALE)\s+(.+)$/);
    if (!match) continue;
    const [,status,message]=match;
    let rule=stage;
    const named=message.match(/^([A-Z]{2,4}-\d+|[a-z][\w-]+)\s/);
    if (stage === 'planes' || stage === 'kicad_happy') rule=named?.[1] ?? stage;
    if (stage === 'viapads' && message.startsWith('via in pad ')) rule='via-in-pad';
    if (stage === 'paths') rule=status === 'MISSING' ? 'supply-coverage' : 'current-capacity';
    if (status === 'STALE') rule='stale-exemption';
    const found=entities(message);
    const pads=[...message.matchAll(/\b([A-Z]{1,5}\d+[A-Za-z]?)\.([A-Za-z0-9]+)\b/g)].map(m=>({ref:m[1],pad:m[2]}));
    const plane=message.match(/\b(F\.Cu|B\.Cu|In\d+\.Cu)\s+([^\s:]+):?/);
    const path=stage === 'paths' ? message.match(/^(\S+)\s/) : null;
    const explicit=[...message.matchAll(/\bnet\s+['"]?([^\s:'"]+)/g)].map(m=>m[1]);
    const nets=unique([...(found.nets ?? []),...(plane ? [plane[2]] : []),...(path ? [path[1]] : []),...explicit]);
    const at=message.match(/\bat\s*\((-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?)\)(?:\s*(mm))?/);
    rows.push(finish({stage,rule,severity:status === 'WARN' ? 'warning' : 'error',message,...found,
      ...(pads.length ? {pads} : {}),
      ...(nets.length ? {nets} : {}),...(plane ? {layer:plane[1]} : {}),
      ...(at ? {location:{x:Number(at[1]),y:Number(at[2]),...(at[3] ? {unit:at[3]} : {})}} : {}),
      ...measurements(message),evidence:{path:`${stage}.log`,line:index+1}}));
  }
  return rows;
}

export function loadFindingsBaseline(path, board, project) {
  const file=statSync(resolve(path)).isDirectory() ? join(resolve(path),'findings.json') : resolve(path);
  const doc=read(file);
  if (doc.schema_version !== 1 || doc.board !== board || doc.project !== project || !Array.isArray(doc.findings) ||
      doc.inputs_valid === false ||
      doc.findings.some(row=>!row || typeof row.id!=='string' || typeof row.stage!=='string') ||
      new Set(doc.findings.map(row=>row.id)).size !== doc.findings.length) throw new Error('findings baseline has incompatible identity or schema');
  return {path:file,findings:doc.findings};
}

export function findingsDocument({board,project,evidenceDir,checks,baseline,preflightErrors=[],inputsValid=true,inputSha256}) {
  let findings=[];
  for (const [stage,check] of Object.entries(checks)) {
    if (check.status === 'blocked' || check.status === 'error') {
      findings.push(finish({stage,rule:check.status === 'blocked' ? 'dependency-blocked' : 'tool-error',severity:'error',message:check.cause,
        evidence:{path:existsSync(join(evidenceDir,`${stage}.log`)) ? `${stage}.log` : 'events.jsonl'}}));
    } else if (['erc','drc'].includes(stage)) {
      findings.push(...nativeFindings(read(join(evidenceDir,`${stage}.json`)),stage));
    } else if (existsSync(join(evidenceDir,`${stage}.log`))) findings.push(...logFindings(readFileSync(join(evidenceDir,`${stage}.log`),'utf8'),stage));
  }
  for (const message of preflightErrors) findings.push(finish({stage:'preflight',rule:'preflight',severity:'error',message,evidence:{path:'events.jsonl'}}));
  // Multiple repeated log lines describing one issue share one stable ID.
  findings=[...new Map(findings.map(row=>[row.id,row])).values()];
  const completed=inputsValid ? Object.entries(checks).filter(([,check])=>['passed','failed'].includes(check.status)).map(([stage])=>stage) : [];
  const doc={schema_version:1,board,project,inputs_valid:inputsValid,...(inputSha256 ? {input_sha256:inputSha256} : {}),
    complete:inputsValid && preflightErrors.length===0 && completed.length===Object.keys(checks).length,completed_checks:completed,findings};
  if (baseline) {
    const current=new Set(findings.map(row=>row.id)),previous=new Set(baseline.findings.map(row=>row.id));
    doc.delta={baseline:baseline.path,new:findings.filter(row=>!previous.has(row.id)),unchanged:findings.filter(row=>previous.has(row.id)),
      resolved:baseline.findings.filter(row=>!current.has(row.id) && completed.includes(row.stage)),
      unverified:baseline.findings.filter(row=>!current.has(row.id) && !completed.includes(row.stage))};
  }
  return doc;
}
