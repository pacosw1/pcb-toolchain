// Original datasheets declared by native symbol instances in the resolved sheet dependency closure.
import { basename } from 'node:path';
import { isFile, joinPath, textOf } from './py-path.ts';
import { forms, type SExpr, type SList } from './sexpr.ts';

export function schematicDatasheets(root: string, dependencies: Iterable<string>): string[] {
  const files = new Set<string>();
  const isProperty = (item: SExpr): item is SList => Array.isArray(item) && item.length > 2
    && item[0] === 'property' && item[1] === 'Datasheet' && typeof item[2] === 'string' && !!item[2];
  for (const sheet of new Set(dependencies)) {
    if (!sheet.endsWith('.kicad_sch')) continue;
    const top = forms(textOf(sheet))[0] as SList;
    for (const symbol of top.slice(1).filter((item): item is SList => Array.isArray(item) && item[0] === 'symbol')) {
      for (const property of symbol.filter(isProperty)) {
        const file = joinPath(root, 'hardware-design/registry/datasheets', basename(property[2] as string));
        if (isFile(file)) files.add(file);
      }
    }
  }
  return [...files];
}
