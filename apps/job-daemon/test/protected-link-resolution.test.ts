import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resolveManifestLinks } from '../src/protected-link-resolution.ts';
import type { ManifestNode } from '../src/protected-link-resolution.ts';

const sha = 'a'.repeat(64);
test('resolves in-root KiCad-style relative links and binds the final bytes', () => {
  const nodes: ManifestNode[] = [
    { path: 'registry/assets/pad.kicad_mod', kind: 'file', sha256: sha },
    { path: 'blocks/lib/pad.kicad_mod', kind: 'link', target: '../../registry/assets/pad.kicad_mod' },
    { path: 'assets', kind: 'link', target: 'registry/assets' },
    { path: 'selected', kind: 'link', target: 'assets/pad.kicad_mod' },
  ];
  const links = resolveManifestLinks(nodes);
  assert.deepEqual(links.find(x => x.path === 'blocks/lib/pad.kicad_mod'), {
    path: 'blocks/lib/pad.kicad_mod', target: '../../registry/assets/pad.kicad_mod',
    resolvedPath: 'registry/assets/pad.kicad_mod', resolvedKind: 'file', sha256: sha,
  });
  assert.equal(links.find(x => x.path === 'selected')?.sha256, sha);
});
test('rejects escaping, cycles, absent targets and nodes hiding directories', () => {
  for (const nodes of [
    [{ path: 'a', kind: 'link', target: '../outside' }],
    [{ path: 'a', kind: 'link', target: 'b' }, { path: 'b', kind: 'link', target: 'a' }],
    [{ path: 'a', kind: 'link', target: 'missing' }],
    [{ path: 'a', kind: 'file', sha256: sha }, { path: 'a/b', kind: 'file', sha256: sha }],
  ] as ManifestNode[][]) assert.throws(() => resolveManifestLinks(nodes));
});
