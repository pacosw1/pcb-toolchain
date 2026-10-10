import {existsSync, readFileSync, readdirSync, statSync, realpathSync, lstatSync, readlinkSync} from 'node:fs';
import {resolve, dirname, relative, join} from 'node:path';
import {createHash} from 'node:crypto';

const digest = v => createHash('sha256').update(v).digest('hex');
export function walkFiles(dir, accept = () => true) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, {withFileTypes: true}).flatMap(e => {
    const p = join(dir,e.name);
    if (e.isDirectory()) return e.name.startsWith('.') || ['fab','render','reports','node_modules','__pycache__'].includes(e.name) ? [] : walkFiles(p,accept);
    return accept(p) ? [p] : [];
  });
}

// Conservative dependency closure: complete project CAD/local libraries, gate
// data, shared library assets named in the project, and all executable tools.
// A changed shared tool invalidates every gate rather than guessing its imports.
export function gateInputs(root, board, configName = 'gate.json', environment = {}) {
  const dir = join(root,'hardware-design/boards',board);
  const config = join(dir,configName);
  const cfg = JSON.parse(readFileSync(config,'utf8'));
  const project = resolve(dir,cfg.project);
  const files = new Set([config]);
  const add = p => { files.add(p); if (existsSync(p) && lstatSync(p).isSymbolicLink()) files.add(realpathSync(p)); };
  const native = p => /\.(kicad_(sch|pcb|pro|dru|sym|mod)|json)$/.test(p) || ['fp-lib-table','sym-lib-table'].includes(p.split('/').at(-1));
  for (const p of walkFiles(dirname(project),native)) add(p);
  for (const p of readdirSync(dir)) if (p.endsWith('.json') && !['gate-metrics.json','gate-waivers.json'].includes(p)) add(join(dir,p));
  const preservedPolicy = join(dir,'preserved-usb-policy.json');
  if(existsSync(preservedPolicy)) for(const source of JSON.parse(readFileSync(preservedPolicy,'utf8')).sources ?? []) {
    if(typeof source.path !== 'string' || !source.path.startsWith('hardware-design/') || source.path.split('/').includes('..')) throw new Error('invalid preserved policy source path');
    add(join(root,source.path));
  }
  for (const ext of ['kicad_pcb','kicad_sch','kicad_pro','kicad_dru']) add(`${project}.${ext}`);
  const sheets=[...files].filter(p=>p.endsWith('.kicad_sch'));const visited=new Set();
  for(let i=0;i<sheets.length;i++) {
    const sheet=sheets[i];if(visited.has(sheet) || !existsSync(sheet)) continue;
    visited.add(sheet);
    for(const m of readFileSync(sheet,'utf8').matchAll(/\(property "(?:Sheetfile|Sheet file)" "((?:\\.|[^"\\])*)"/g)) {
      const name=JSON.parse('"'+m[1]+'"');
      const path=resolve(dirname(sheet),name.replaceAll('${KIPRJMOD}',dirname(project)));
      add(path);sheets.push(path);
    }
  }
  const text = [...files].filter(p=>existsSync(p)).map(p=>readFileSync(p,'utf8')).join('\n');
  const codes = new Set(text.match(/\bC\d+\b/g) ?? []);
  for (const code of codes) {
    for (const p of walkFiles(join(root,'hardware-design/registry/cad-assets',code))) add(p);
    add(join(root,'hardware-design/blocks/iot-lab.pretty',`${code}.kicad_mod`));
  }
  // Include additional custom library URIs even when they have no C-number.
  for (const table of ['sym-lib-table','fp-lib-table']) for(const p of [join(dirname(project),table),...(environment.configDir ? [join(environment.configDir,table)] : [])]) {
    if (!existsSync(p)) continue;
    add(p);
    for (const [,name,uri] of readFileSync(p,'utf8').matchAll(/\(lib \(name "([^"]+)"\).*?\(uri "([^"]+)"\)/g)) {
      if(!text.includes(`"${name}:`)) continue;
      let expanded=uri.replaceAll('${KIPRJMOD}',dirname(project)).replaceAll('${IOT_LAB}',root);
      for(const [key,value] of Object.entries(environment.variables ?? {})) expanded=expanded.replaceAll('${'+key+'}',value);
      if (expanded.includes('${')) continue; // stock libraries recorded by tool versions below
      const target=resolve(dirname(project),expanded);
      if (existsSync(target) && statSync(target).isDirectory()) {
        // A footprint directory can hold thousands of unrelated library parts.
        // KiCad loads the named .kicad_mod files; record those exact dependencies.
        const escaped=name.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
        const refs=new Set([...text.matchAll(new RegExp(`"${escaped}:([^"\\n]+)"`,'g'))].map(m=>m[1]));
        for(const ref of refs) add(join(target,`${ref}.kicad_mod`));
      } else add(target);
    }
  }
  add(join(root,'hardware-design/registry/courtyard-bodies.json'));
  for (const p of walkFiles(join(root,'tools'), p=>/\.(mjs|py|sh|java)$/.test(p) || p.endsWith('/hooks/pre-commit'))) add(p);
  add(join(root,'tools/route-features.json'));
  // Pin escape ratings change the current-capacity result even though their
  // JSON is not executable code. Record absence as well as changed ratings.
  for (const data of ['edge-rates.json','driver-edges.json','pin-ratings.json']) {
    const path=join(root,'tools',data);add(path);
    if(!existsSync(path)) continue;
    const table=JSON.parse(readFileSync(path,'utf8'));
    for(const evidence of table.evidence_files ?? []) {
      if(typeof evidence.path!=='string' || !/^hardware-design\/registry\/(datasheets|ibis)\//.test(evidence.path) || evidence.path.includes('..') || evidence.path.includes('\\')) throw new Error('invalid driver evidence path');
      add(join(root,evidence.path));
      if(evidence.path.endsWith('.pdf')) add(join(root,evidence.path+'.source.json'));
    }
    // Models are executable timing inputs even if their evidence list omits
    // them. Keep absent originals/parser/receipts in the fingerprint as null;
    // missing evidence must never look like unchanged successful validation.
    for(const part of Object.values(table.parts ?? {})) if(part.ibis) {
      const file=part.ibis.file;
      if(typeof file!=='string' || !file.startsWith('hardware-design/registry/ibis/') || !file.endsWith('.ibs') || file.includes('..') || file.includes('\\')) throw new Error('invalid driver IBIS path');
      add(join(root,file));add(join(root,file+'.source.json'));
      add(join(root,'tools/ibis_ramp.py'));
    }
  }
  for(const repo of environment.repositories ?? []) for(const p of walkFiles(repo,p=>p.endsWith('.py'))) add(p);
  return {cfg, project, files:[...files].sort()};
}

export function fingerprint(root, files, versions = {}, externalRoots = {}) {
  const inputs = files.map(p => {
    let path=relative(root,p).split('\\').join('/');
    for(const [name,base] of Object.entries(externalRoots)) if(p===base || p.startsWith(base+'/')) path=`external/${name}/${relative(base,p)}`;
    if (!existsSync(p)) return {path,sha256:null};
    return {path,sha256:digest(readFileSync(p)),...(lstatSync(p).isSymbolicLink() ? {link:readlinkSync(p)} : {})};
  }).sort((a,b)=>a.path.localeCompare(b.path));
  const tools=Object.fromEntries(Object.entries(versions).sort(([a],[b])=>a.localeCompare(b)));
  return {input_sha256:digest(JSON.stringify({inputs,tools})),inputs,tools};
}
