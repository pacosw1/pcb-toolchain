// Provenance of the Python-free Gerber checker. The daemon reports its image
// tag, not the resolved image digest; do not describe that tag as an attestation.
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {existsSync, readFileSync, realpathSync} from 'node:fs';
import {isAbsolute, join, relative, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {fileRoot, kicadCli, PINNED_IMAGE} from './env.mjs';

const sha = file => createHash('sha256').update(readFileSync(file)).digest('hex');
const executable = value => isAbsolute(value) ? realpathSync(value) : realpathSync(execFileSync('/usr/bin/which',[value],{encoding:'utf8',timeout:10000}).trim());

export function gerberRuntime({node = process.execPath, cli = kicadCli, toolchain = process.env.PCB_TOOLCHAIN_ROOT || fileRoot} = {}) {
 const nodePath = executable(node), cliPath = executable(cli);
 const reader = realpathSync(join(toolchain,'bin','iotroute-linux-x86_64'));
 const pin = readFileSync(join(toolchain,'tools/router/core/proto/PIN'),'utf8').match(/at commit ([0-9a-f]{40})/)?.[1];
 if (!pin) throw new Error('pinned KiCad API commit is unavailable');
 const nodeVersion = execFileSync(nodePath,['--version'],{encoding:'utf8',timeout:10000}).trim();
 const cliVersion = execFileSync(cliPath,['--version'],{encoding:'utf8',timeout:10000}).trim();
 if (!nodeVersion || !cliVersion.startsWith('10.')) throw new Error('required Node or KiCad 10 runtime is unavailable');
 return {schema:'iot-lab.gerber-runtime.v2',node:{version:nodeVersion,sha256:sha(nodePath)},
  kicad:{version:cliVersion,sha256:sha(cliPath)},reader:{sha256:sha(reader),kicad_commit:pin,image_tag:PINNED_IMAGE,image_identity:'unattested'}};
}

/** Reconstruct the exact source bindings recorded by a successful checker invocation. */
export function gerberInputs(root, board, zip, toolchain = process.env.PCB_TOOLCHAIN_ROOT || fileRoot) {
 if (!/^[A-Z0-9][A-Z0-9-]*$(?![\s\S])/.test(board)) throw new Error('invalid Gerber board ID');
 const boards=resolve(root,'hardware-design/boards'), folder=join(boards,board);
 const config=JSON.parse(readFileSync(join(folder,'gate.json'),'utf8'));
 if(typeof config.project!=='string'||!config.project) throw new Error('Gerber board project missing');
 const stem=resolve(folder,config.project), rel=relative(realpathSync(boards),realpathSync(stem+'.kicad_pcb'));
 if(!rel || rel==='..' || rel.startsWith('../') || isAbsolute(rel)) throw new Error('Gerber board project escapes registry');
 const hashIf=file=>existsSync(file)?sha(file):'';
 const inputs={schema:'iot-lab.gerber-inputs.v1',board,pcb:hashIf(stem+'.kicad_pcb'),project:hashIf(stem+'.kicad_pro'),
  rules:hashIf(stem+'.kicad_dru'),schematic:hashIf(stem+'.kicad_sch'),gerber:hashIf(zip),reader:hashIf(join(toolchain,'bin','iotroute-linux-x86_64'))};
 if(!inputs.pcb||!inputs.schematic||!inputs.gerber||!inputs.reader) throw new Error('a required Gerber input or board reader is missing');
 return inputs;
}

if (process.argv[1] && realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url))) {
 try { console.log(JSON.stringify(gerberRuntime())); }
 catch (error) { console.error(`FAIL: Gerber runtime: ${error.message}`); process.exitCode = 2; }
}
