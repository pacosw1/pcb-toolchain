// Convert the placer's existing completed epoch history into source-bound, read-only replay frames.
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const hash = (b: Buffer): string => createHash('sha256').update(b).digest('hex');
const inside = (root: string, p: string): boolean => p.startsWith(root + path.sep);
const read = (p: string): Buffer => {
  const stat = fs.statSync(p);
  if (!stat.isFile() || stat.size > 20 * 1024 * 1024) throw new Error('placement input is too large');
  return fs.readFileSync(p);
};
type Unit = { refs: string[]; x: number; y: number };
type Entry = { epoch: number; cost: number; pose: number[][] };
export function placementHistory(root: string, cwd: string, outdir: string, step: string, observedBoard?: string): { board: string; sha: string; frames: Buffer[] } {
  root = fs.realpathSync(root); cwd = fs.realpathSync(cwd);
  if (cwd !== root && !inside(root, cwd)) throw new Error('placement working directory escapes project');
  const manifest = JSON.parse(read(path.join(outdir, 'input-manifest.json')).toString()) as { board: string; board_sha256: string; problem_sha256: string; configuration: { prob: string } };
  if (!manifest.configuration || typeof manifest.configuration.prob !== 'string' || typeof manifest.board !== 'string' || !/^[0-9a-f]{64}$/.test(manifest.board_sha256) || !/^[0-9a-f]{64}$/.test(manifest.problem_sha256)) throw new Error('invalid placement manifest');
  const board = fs.realpathSync(path.resolve(cwd, manifest.board)), problem = fs.realpathSync(path.resolve(cwd, manifest.configuration.prob));
  const external = observedBoard ? fs.realpathSync(observedBoard) : null;
  const scratch = external === board ? path.dirname(board) : null;
  if ((!inside(root, board) && !scratch) || (!inside(root, problem) && !(scratch && inside(scratch, problem)))) throw new Error('placement inputs escape project');
  const boardBytes = read(board), problemBytes = read(problem);
  if (hash(boardBytes) !== manifest.board_sha256 || hash(problemBytes) !== manifest.problem_sha256) throw new Error('placement inputs no longer match manifest');
  const source = JSON.parse(problemBytes.toString()) as { board_file?: unknown; units: Unit[] };
  if (typeof source.board_file !== 'string' || fs.realpathSync(path.resolve(cwd, source.board_file)) !== board) throw new Error('placement problem does not identify the input board');
  const stepProblem = JSON.parse(read(path.join(step, 'prob.json')).toString()) as { units: Unit[] };
  const result = JSON.parse(read(path.join(step, 'search/res.json')).toString()) as { history: Entry[] };
  if (!Array.isArray(source.units) || source.units.length > 100_000 || !Array.isArray(stepProblem.units) || stepProblem.units.length !== source.units.length || !Array.isArray(result.history) || result.history.length > 5000) throw new Error('invalid placement history');
  const units = source.units.map((u, i) => {
    if (!Array.isArray(u.refs) || !u.refs.every(x => typeof x === 'string') || !Number.isFinite(u.x) || !Number.isFinite(u.y) || JSON.stringify(u.refs) !== JSON.stringify(stepProblem.units[i]?.refs)) throw new Error('placement unit mismatch');
    return { refs: u.refs, origin: [u.x, u.y] };
  });
  const frames = result.history.map(entry => {
    if (!Number.isSafeInteger(entry.epoch) || !Number.isFinite(entry.cost) || !Array.isArray(entry.pose) || entry.pose.length !== units.length) throw new Error('invalid placement epoch');
    const placed = units.map((u, i) => {
      const p = entry.pose[i];
      if (!Array.isArray(p) || p.length < 3 || !Number.isFinite(p[0]) || !Number.isFinite(p[1]) || !Number.isInteger(p[2]) || p[2] < 0 || p[2] > 3) throw new Error('invalid placement pose');
      return { ...u, position: [p[0], p[1]], turn: p[2] };
    });
    return Buffer.from(JSON.stringify({ schema: 'iot-lab.placement-preview.v1', board_sha256: manifest.board_sha256, epoch: entry.epoch, epochs: result.history.length, cost: entry.cost, units: placed }));
  });
  return { board, sha: manifest.board_sha256, frames };
}
