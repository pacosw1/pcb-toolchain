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

// The tools the gate executes (D-129): tools/gate.mjs, the node modules it
// imports (transitively, inside tools/), the scripts it spawns with tool(NAME),
// and the python modules those scripts import or load by file name (inside
// tools/). Tests, viewers, routers, placers and seed builders change no
// committed verdict, so they are not inputs. A named file that is absent is
// still recorded (null hash) so a missing checker never looks unchanged.
const STDLIB_LIKE=/^(?:sys|os|re|json|math|time|datetime|pathlib|collections|itertools|functools|typing|dataclasses|subprocess|hashlib|shutil|tempfile|csv|io|struct|copy|heapq|bisect|random|logging|enum|textwrap|contextlib|glob|traceback|statistics|fractions|decimal|operator|string|unicodedata|array|numbers|abc|warnings|atexit|fnmatch|signal|threading|importlib|xml|concurrent|argparse|pcbnew|numpy|wx)$/;
// JS module dependencies: static import/export-from, side-effect imports and
// dynamic import(), with '...', "..." or `...` (no ${} interpolation). Whole-line
// and block comments are ignored. A dynamic import or tool() call whose argument
// is not such a literal cannot be resolved, so it throws (fails closed).
const QUOTED=String.raw`(?:'([^'\n]*)'|"([^"\n]*)"|\x60([^\x60$]*)\x60)`;
const stripComments=text=>text.replace(/\/\*[\s\S]*?\*\//g,'').replace(/^\s*\/\/.*$/gm,'');
const literal=m=>m[1] ?? m[2] ?? m[3];
function literalCalls(file,text,name) {
  const code=stripComments(text);const found=[];
  for(const m of code.matchAll(new RegExp(String.raw`(?<![\w$.])${name}\s*\(`,'g'))) {
    const arg=code.slice(m.index+m[0].length).match(new RegExp(String.raw`^\s*${QUOTED}\s*\)`));
    if(!arg) throw new Error(`gate tool ${file} calls ${name}() with a non-literal argument; cannot resolve its dependency`);
    found.push(literal(arg));
  }
  return found;
}
export function jsImports(file,text) {
  const code=stripComments(text);
  const specs=[...code.matchAll(new RegExp(String.raw`(?<![\w$.])(?:import|export)\b[^;'"\x60()]*?\bfrom\s*${QUOTED}`,'g'))].map(literal);
  for(const m of code.matchAll(new RegExp(String.raw`(?<![\w$.])import\s*${QUOTED}`,'g'))) specs.push(literal(m));
  return [...specs,...literalCalls(file,text,'import')];
}
export function gateTools(root, entries = [join(root,'tools/gate.mjs')]) {
  const tools=join(root,'tools');
  const inside=p=>{const rel=relative(tools,p);return rel && !rel.startsWith('..') && !rel.includes('\\') && !/(^|\/)(test_[^/]*\.py|[^/]*\.test\.(mjs|ts))$/.test(rel) && !rel.endsWith('.d.mts');};
  const files=new Set();const queue=[...entries];
  while(queue.length) {
    const file=resolve(queue.shift());
    if(files.has(file) || !inside(file)) continue;
    files.add(file);
    if(!existsSync(file)) continue;
    const text=readFileSync(file,'utf8');
    if(/\.(mjs|ts)$/.test(file)) {
      for(const spec of jsImports(file,text)) {
        if(spec.startsWith('node:')) continue;
        const target=resolve(dirname(file),spec);
        // Fail closed: a dependency the collector cannot hash must stop the gate, not vanish.
        if(!/^\.\.?\//.test(spec) || relative(tools,target).startsWith('..')) throw new Error(`gate tool ${relative(root,file)} imports unsupported module ${spec}; record it as a gate input`);
        queue.push(target);
      }
      for(const name of literalCalls(file,text,'tool')) queue.push(join(tools,name));
    } else if(file.endsWith('.py')) {
      for(const line of text.split('\n')) {
        if(/^\s*from\s+\./.test(line)) throw new Error(`gate tool ${relative(root,file)} uses a relative import; record it as a gate input`);
        const m=line.match(/^\s*(?:from\s+([\w.]+)\s+import\b|import\s+([\w.,\s]+?)\s*(?:#.*)?$)/);
        if(!m) continue;
        for(const name of (m[1] ? [m[1]] : m[2].split(',')).map(n=>n.trim().split(/\s+as\s+/)[0].split('.')[0])) {
          if(!name || STDLIB_LIKE.test(name)) continue;
          for(const candidate of [join(tools,`${name}.py`),join(tools,name,'__init__.py')]) if(existsSync(candidate)) queue.push(candidate);
        }
      }
      // Modules loaded by file name (importlib.util.spec_from_file_location(..., 'NAME.py')).
      for(const m of text.matchAll(/(['"])(\w+\.py)\1/g)) {const candidate=join(tools,m[2]);if(existsSync(candidate)) queue.push(candidate);}
    }
  }
  return [...files].sort();
}

/** The checks the gate runs: rule data beside gate.json turns on the placement check. Evidence readers must use this too. */
export function gateChecks(dir, checks) {
  return existsSync(join(dir,'placement-constraints.json')) && !checks?.placement ? {...checks,placement:'placement-constraints.json'} : checks;
}

export function gateInputs(root, board, configName = 'gate.json', environment = {}) {
  const dir = join(root,'hardware-design/boards',board);
  const config = join(dir,configName);
  const cfg = JSON.parse(readFileSync(config,'utf8'));
  cfg.checks = gateChecks(dir,cfg.checks);
  const project = resolve(dir,cfg.project);
  const files = new Set([config]);
  // cad-seal.json (tools/lib/cad-seal.ts) changes with each sealed write; it is no gate input, or a reseal would make evidence stale.
  // The release approval files (tools/lib/release-approval.mjs) are written after the gate run for the same reason.
  const add = p => { if (p.split('/').at(-1)==='cad-seal.json' || /^release-approval[.\w-]*$/.test(p.split('/').at(-1))) return; files.add(p); if (existsSync(p) && lstatSync(p).isSymbolicLink()) files.add(realpathSync(p)); };
  const native = p => /\.(kicad_(sch|pcb|pro|dru|sym|mod)|json)$/.test(p) || ['fp-lib-table','sym-lib-table'].includes(p.split('/').at(-1));
  for (const p of walkFiles(dirname(project),native)) add(p);
  for (const p of readdirSync(dir)) if (p.endsWith('.json') && !['gate-metrics.json','gate-waivers.json'].includes(p)) add(join(dir,p));
  const placement = join(dir,'placement-constraints.json');
  if (existsSync(placement)) for (const rule of JSON.parse(readFileSync(placement,'utf8')).rules ?? []) {
    if (typeof rule.source?.path !== 'string' || rule.source.path.startsWith('/') || rule.source.path.split(/[\\/]/).includes('..')) throw new Error('invalid placement source path');
    add(resolve(root,rule.source.path));
  }
  const preservedPolicy = join(dir,'preserved-usb-policy.json');
  if(existsSync(preservedPolicy)) for(const source of JSON.parse(readFileSync(preservedPolicy,'utf8')).sources ?? []) {
    if(typeof source.path !== 'string' || !source.path.startsWith('hardware-design/') || source.path.split('/').includes('..')) throw new Error('invalid preserved policy source path');
    add(join(root,source.path));
  }
  for (const ext of ['kicad_pcb','kicad_sch','kicad_pro','kicad_dru']) add(`${project}.${ext}`);
  // Checker rules may live outside the board folder and can name further
  // rules/sheets. Record declared file dependencies, including missing ones.
  const rules=Object.values(cfg.checks ?? {}).filter(value=>typeof value==='string').map(value=>resolve(dir,value));
  for (const key of ['exempt','return_planes']) if (typeof cfg.checks?.kicad_happy?.[key]==='string') rules.push(resolve(dir,cfg.checks.kicad_happy[key]));
  const readRules=new Set();
  for(let i=0;i<rules.length;i++) {
    const file=rules[i];add(file);
    if (!file.endsWith('.json') || readRules.has(file) || !existsSync(file)) continue;
    readRules.add(file);
    const references=[];
    const visit=value=>{
      if (typeof value==='string' && !/^[a-z]+:\/\//i.test(value) && /\.(?:json|kicad_sch|ibs|pdf)$/.test(value)) references.push(value);
      else if (Array.isArray(value)) value.forEach(visit);
      else if (value && typeof value==='object') Object.values(value).forEach(visit);
    };
    visit(JSON.parse(readFileSync(file,'utf8')));
    for(const value of references) {
      const expanded=value.replaceAll('${IOT_LAB}',root).replaceAll('${KIPRJMOD}',dirname(project));
      if (!expanded.includes('${')) rules.push(resolve(/^(?:hardware-design|tools)\//.test(expanded) ? root : dirname(file),expanded));
    }
  }
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
  for (const p of gateTools(root)) add(p);
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
    }
  }
  for(const repo of environment.repositories ?? []) for(const p of walkFiles(repo,p=>p.endsWith('.py'))) add(p);
  return {cfg, project, files:[...files].sort(), rules:[...new Set(rules)].sort()};
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
