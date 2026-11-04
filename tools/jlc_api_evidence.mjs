#!/usr/bin/env node
// Save JLC parts-API evidence per C-number (read only: no login, no cart), the format the schematic generators read:
// registry/evidence/<date>/<C>.api.json = {fetched_at_utc, source_url, request, response_sha256, record}.
// Usage: node tools/jlc_api_evidence.mjs C123 C456 ...   (existing files are kept)
import {createHash} from 'node:crypto';
import {mkdirSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {SystemExit, cli, get, globNames, jsonDumps, jsonLoads, lexists, osError, print, pyStr, run, today, truthy, utcNow} from './lib/py-compat.mjs';
import {projectRoot} from './lib/project-root.mjs';

const EV = join(projectRoot(), 'hardware-design/registry/evidence');
const URL = 'https://jlcpcb.com/api/overseas-pcb-order/v1/shoppingCart/smtGood/selectSmtComponentList';
const or = (value, otherwise) => truthy(value) ? value : otherwise;

cli(() => {
  const day = today();
  for (const c of process.argv.slice(2)) {
    if (globNames(EV).some(folder => lexists(join(EV, folder, c + '.api.json')))) { print(`${c}: kept`); continue; }
    const request = new Map([['keyword', c], ['currentPage', 1], ['pageSize', 10]]);
    const raw = run('curl', ['-s', '-f', '-m', '30', '-X', 'POST', URL, '-H', 'Content-Type: application/json', '-d', jsonDumps(request)], {check: true}).stdout;
    const list = or(get(or(get(or(get(jsonLoads(raw), 'data'), new Map()), 'componentPageInfo'), new Map()), 'list'), []);
    const record = list.find(r => get(r, 'componentCode') === c);
    if (record === undefined) throw new SystemExit(1, `${c}: not in the JLC parts API`);
    mkdirSync(join(EV, day), {recursive: true});
    const out = new Map([['fetched_at_utc', utcNow()], ['source_url', URL], ['request', request],
      ['response_sha256', createHash('sha256').update(raw).digest('hex')], ['record', record]]);
    const path = join(EV, day, c + '.api.json');
    try { writeFileSync(path, jsonDumps(out, 1)); } catch (error) { throw osError(error, path); }
    print(`${c}: ${pyStr(get(record, 'componentModelEn'))} stock ${pyStr(get(record, 'stockCount'))} ${pyStr(get(record, 'componentLibraryType'))}`);
  }
});
