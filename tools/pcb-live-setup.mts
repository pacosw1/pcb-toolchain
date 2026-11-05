#!/usr/bin/env node
// Register a project's Git worktrees for one coordinator without replacing unrelated settings.
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { coordinatorUrl } from './pcb-live-worker.mts';

const opt = { type: 'string' } as const;
const { values: v } = parseArgs({ options: { project: opt, 'project-id': opt, url: opt, 'token-file': opt, 'cli-path': opt, config: opt } });
if (!v.project || !v['project-id'] || v['project-id'].includes('/') || !v.url || !v['token-file'])
  throw new Error('requires --project DIR --project-id ID --url ORIGIN --token-file FILE');
const root = fs.realpathSync(v.project), common = execFileSync('git', ['-C', root, 'rev-parse', '--git-common-dir'], { encoding: 'utf8', timeout: 5000 }).trim();
const gitDir = fs.realpathSync(path.resolve(root, common));
const tokenFile = fs.realpathSync(v['token-file']);
const tokenStat = fs.statSync(tokenFile);
if (!tokenStat.isFile() || (tokenStat.mode & 0o077) !== 0 || fs.readFileSync(tokenFile, 'utf8').trim().length < 32)
  throw new Error('token must be a private owner-only file containing at least 32 characters');
const dest = path.resolve(v.config ?? process.env.PCB_LIVE_CONFIG ?? path.join(os.homedir(), '.config/pcb-live/config.json'));
const current = fs.existsSync(dest) ? JSON.parse(fs.readFileSync(dest, 'utf8')) as Record<string, unknown> : {};
if (current.projects !== undefined && (!current.projects || typeof current.projects !== 'object' || Array.isArray(current.projects))) throw new Error('invalid projects mapping');
const projects = { ...(current.projects as Record<string, string> | undefined) };
if (projects[gitDir] && projects[gitDir] !== v['project-id']) throw new Error('Git repository is already registered with a different project ID');
const url = coordinatorUrl(v.url);
if (Object.keys(projects).length && ((current.url && current.url !== url) || (current.tokenFile && fs.realpathSync(String(current.tokenFile).replace(/^~(?=\/)/, os.homedir())) !== tokenFile)))
  throw new Error('existing projects use a different coordinator or token; configuration was not changed');
projects[gitDir] = v['project-id'];
const next = { ...current, url, tokenFile, cliPath: v['cli-path'] ?? current.cliPath ?? path.join(os.homedir(), '.local/bin/pcb'), projects };
fs.mkdirSync(path.dirname(dest), { recursive: true, mode: 0o700 });
const temp = dest + '.' + randomUUID() + '.tmp', fd = fs.openSync(temp, 'wx', 0o600);
try { fs.writeFileSync(fd, JSON.stringify(next, null, 2) + '\n'); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
fs.renameSync(temp, dest);
console.log(`Registered ${gitDir} as ${v['project-id']} for ${url}`);
