// Produce a 3D export from an immutable board snapshot on the reporting host.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface ModelInput { root: string; boardPath: string; boardSha: string; bytes: Buffer; maxBytes: number; executable?: string }
export async function exportModel(input: ModelInput): Promise<{ bytes: Buffer; warning: string | null }> {
  if (!/^[0-9a-f]{64}$/.test(input.boardSha) || createHash('sha256').update(input.bytes).digest('hex') !== input.boardSha) throw new Error('board snapshot hash mismatch');
  const root = fs.realpathSync(input.root);
  if (path.isAbsolute(input.boardPath) || input.boardPath.split(/[\\/]/).some(p => p === '..' || !p)) throw new Error('invalid board path');
  const projectDir = fs.realpathSync(path.dirname(path.resolve(root, input.boardPath)));
  if (!projectDir.startsWith(root + path.sep)) throw new Error('board directory is outside project');
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'pcb-live-model-'));
  try {
    const board = path.join(temp, 'snapshot.kicad_pcb'), out = path.join(temp, 'board.glb');
    fs.writeFileSync(board, input.bytes, { mode: 0o600 });
    const mac = '/Applications/KiCad/KiCad.app/Contents/MacOS/kicad-cli';
    const exe = input.executable ?? process.env.PCBSTUDIO_KICAD_CLI ?? (fs.existsSync(mac) ? mac : 'kicad-cli');
    const args = ['pcb', 'export', 'glb', '--force', '--subst-models', '--include-tracks', '--include-pads', '--include-zones', '--include-silkscreen', '--include-soldermask', '--no-dnp', '-D', `IOT_LAB=${root}`, '-D', `KIPRJMOD=${projectDir}`, '-o', out, board];
    const log = await new Promise<string>((resolve, reject) => {
      const child = spawn(exe, args, { cwd: projectDir, stdio: ['ignore', 'pipe', 'pipe'] });
      let output = ''; const collect = (data: Buffer): void => { output = (output + data.toString()).slice(-32_000); };
      child.stdout.on('data', collect); child.stderr.on('data', collect);
      const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('3D export timed out')); }, 600_000);
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.once('close', code => { clearTimeout(timer); if (code === 0) resolve(output); else reject(new Error(`3D export failed: ${output.slice(-500)}`)); });
    });
    const st = fs.statSync(out);
    if (!st.isFile() || st.size < 12 || st.size > input.maxBytes) throw new Error('3D model is empty or exceeds the coordinator upload limit');
    const bytes = fs.readFileSync(out);
    if (bytes.toString('ascii', 0, 4) !== 'glTF') throw new Error('invalid 3D model');
    const warnings = log.split(/\r?\n/).filter(line => /not found|could not/i.test(line)).slice(0, 5).join('; ');
    return { bytes, warning: warnings.slice(0, 1000) || null };
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
}
