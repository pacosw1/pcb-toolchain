// Evidence lookups of tools/build-bom-verified.mjs: the JLC snapshot and the datasheets of one C-number.
// A file counts for a part only when its own content or its source record names that part; a file name alone does not.
import {existsSync, readFileSync, readdirSync} from 'node:fs';
import {join, relative} from 'node:path';

const read = path => { try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; } };
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const push = (map, key, value) => map.set(key, [...(map.get(key) ?? []), value]);

/** C-number -> every <C>.json under evidence/<day>/ at any depth, oldest first (day, then path). */
function snapshotFiles(evidence) {
  const found = new Map();
  const walk = dir => {
    for (const entry of readdirSync(dir, {withFileTypes: true})) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile() && /^C\d+\.json$/.test(entry.name)) push(found, entry.name.slice(0, -'.json'.length), path);
    }
  };
  if (existsSync(evidence)) walk(evidence);
  for (const paths of found.values()) paths.sort((a, b) => (relative(evidence, a) < relative(evidence, b) ? -1 : 1));
  return found;
}

/** The C-numbers a datasheet names: by its file name and by its source record. Null when the source record is unreadable. */
function claims(datasheets, name) {
  const ids = new Set();
  const byName = /_(C\d+)\.pdf$/.exec(name);
  if (byName) ids.add(byName[1]);
  const sidecar = join(datasheets, `${name}.source.json`);
  if (!existsSync(sidecar)) return ids;
  const source = read(sidecar);
  if (!isObject(source)) return null;
  if (typeof source.catalog_url === 'string') ids.add(source.catalog_url.split(/[?#]/)[0].split('/').filter(Boolean).at(-1));
  if (typeof source.catalog_snapshot === 'string') ids.add(source.catalog_snapshot.split('/').at(-1).replace(/\.json$/, ''));
  return ids;
}

/** C-number -> the datasheets proven to be for it: all names of the file agree on that one C-number. Sorted by file name. */
function datasheetFiles(datasheets) {
  const found = new Map();
  if (!existsSync(datasheets)) return found;
  for (const name of readdirSync(datasheets).filter(file => file.endsWith('.pdf')).sort()) {
    const ids = claims(datasheets, name);
    if (ids !== null && ids.size === 1) push(found, [...ids][0], join(datasheets, name));
  }
  return found;
}

export function evidenceLookup(evidence, datasheets) {
  const snapshots = snapshotFiles(evidence), sheets = datasheetFiles(datasheets);
  return {
    /** The newest snapshot file of C whose purchase_record is for C, else null. */
    snapshot(code) {
      for (const path of [...(snapshots.get(code) ?? [])].reverse()) {
        const record = read(path)?.purchase_record;
        if (isObject(record) && record.componentCode === code) return path;
      }
      return null;
    },
    datasheets: code => sheets.get(code) ?? [],
  };
}
