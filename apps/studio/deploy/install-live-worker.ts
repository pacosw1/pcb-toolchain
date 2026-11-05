#!/usr/bin/env node
// Install a per-project live worker as the current user's LaunchAgent.
import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';

const text = { type: 'string' } as const;
const { values } = parseArgs({ options: { project: text, 'project-id': text, url: text, 'token-file': text, worker: text, node: text } });
if (process.platform !== 'darwin') throw new Error('This installer requires macOS');
if (!values.project || !values['project-id'] || values['project-id'].includes('/') || !values.url || !values['token-file'] || !values.worker)
  throw new Error('requires --project, --project-id, --url, --token-file and --worker');
const project = fs.realpathSync(values.project), worker = fs.realpathSync(values.worker), token = fs.realpathSync(values['token-file']);
if (!fs.statSync(project).isDirectory() || !fs.statSync(worker).isFile() || !fs.statSync(token).isFile()) throw new Error('invalid project, worker or token');
const suffix = createHash('sha256').update(`${values['project-id']}\0${project}`).digest('hex').slice(0, 12);
const label = `com.pcbstudio.live.${suffix}`, home = os.homedir(), domain = `gui/${process.getuid!()}`;
const state = path.join(home, '.local/state/pcb-live', suffix + '.json'), logs = path.join(home, 'Library/Logs/pcbstudio');
const agents = path.join(home, 'Library/LaunchAgents'), dest = path.join(agents, label + '.plist');
fs.mkdirSync(logs, { recursive: true }); fs.mkdirSync(agents, { recursive: true });
const xml = (x: string): string => x.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
const argv = [values.node ?? process.execPath, '--no-warnings', '--experimental-strip-types', worker, '--project', project,
  '--project-id', values['project-id'], '--url', values.url, '--token-file', token, '--state-file', state, '--discover-worktrees'];
const log = path.join(logs, suffix + '.log');
const plist = `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict>
<key>Label</key><string>${xml(label)}</string><key>ProgramArguments</key><array>${argv.map(a => `<string>${xml(a)}</string>`).join('')}</array>
<key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>ThrottleInterval</key><integer>10</integer>
<key>StandardOutPath</key><string>${xml(log)}</string><key>StandardErrorPath</key><string>${xml(log)}</string></dict></plist>\n`;
const prior = fs.existsSync(dest) ? fs.readFileSync(dest) : null;
const service = `${domain}/${label}`;
const present = (): boolean => spawnSync('launchctl', ['print', service], { stdio: 'ignore' }).status === 0;
const remove = (): void => {
  if (!present()) return;
  if (spawnSync('launchctl', ['bootout', service], { stdio: 'ignore' }).status !== 0) throw new Error('Could not stop existing live worker');
  for (let n = 0; n < 100 && present(); n++) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
  if (present()) throw new Error('Existing live worker did not stop; configuration was not changed');
};
remove();
const tmp = dest + '.' + randomUUID() + '.tmp';
fs.writeFileSync(tmp, plist, { mode: 0o600 }); fs.renameSync(tmp, dest);
const result = spawnSync('launchctl', ['bootstrap', domain, dest], { stdio: 'inherit' });
if (result.status !== 0) {
  remove();
  if (prior) {
    fs.writeFileSync(dest, prior, { mode: 0o600 });
    const restored = spawnSync('launchctl', ['bootstrap', domain, dest], { stdio: 'ignore' });
    if (restored.status !== 0) throw new Error('Could not start live worker; previous plist restored but service restart failed');
  }
  else fs.rmSync(dest, { force: true });
  throw new Error('Could not start live worker; previous configuration restored');
}
console.log(`Installed ${label} for ${project}\nLog: ${log}`);
