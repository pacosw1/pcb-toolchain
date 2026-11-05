// Write the release's source-bound file inventory without starting Python on the build Mac.
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const compareCodepoints = (a, b) => {
  const x = Array.from(a), y = Array.from(b)
  for (let i = 0; i < Math.min(x.length, y.length); i++) {
    const d = x[i].codePointAt(0) - y[i].codePointAt(0)
    if (d) return d
  }
  return x.length - y.length
}

export function writeBundleManifest(root, version, sourceSha) {
  const entries = []
  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (entry.isSymbolicLink() && fs.statSync(full).isDirectory()) continue
      else entries.push([path.relative(root, full).split(path.sep).join('/'), createHash('sha256').update(fs.readFileSync(full)).digest('hex')])
    }
  }
  walk(root)
  entries.sort(([a], [b]) => compareCodepoints(a, b))
  const manifest = { files: Object.fromEntries(entries), schema: 'pcb-toolchain.manifest.v1', source_sha: sourceSha, version }
  // Python's previous json.dump(indent=1, sort_keys=True) defaulted to ASCII escapes.
  const text = JSON.stringify(manifest, null, 1).replace(/[\u007f-\uffff]/g, c => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`)
  fs.writeFileSync(path.join(root, 'manifest.json'), text)
  return entries.length
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [root, version, sourceSha] = process.argv.slice(2)
  if (!root || !version || !sourceSha || process.argv.length !== 5) {
    console.error('usage: write-bundle-manifest.mjs ROOT VERSION SOURCE_SHA')
    process.exitCode = 2
  } else {
    try { console.log(`${writeBundleManifest(root, version, sourceSha)} files`) }
    catch (error) { console.error(`FAIL: bundle manifest: ${error.message}`); process.exitCode = 1 }
  }
}
