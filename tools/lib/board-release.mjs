// The release recipe of a board: the "release" key of its gate.json (gate.pending.json when the board has no
// gate.json yet). {maker, fab, check?, config?, check_json?, revision?, copper?, variants?, inputs?, pre_checks?,
// post_export?, board_checks?}. Paths are relative to the project root. No dependencies, so that
// tools/release-recipe.mjs runs alone.
import {readFileSync,existsSync} from 'node:fs';
import {join} from 'node:path';

const BOARD=/^[A-Z0-9][A-Z0-9-]*$/;
export function gateConfigPath(root,board) {
 if(!BOARD.test(board??''))throw new Error('board required');
 const dir=join(root,'hardware-design/boards',board);
 return ['gate.json','gate.pending.json'].map(n=>join(dir,n)).find(existsSync)??null;
}
export function releaseRecipe(root,board) {
 if(!BOARD.test(board??''))return null;
 const path=gateConfigPath(root,board);
 return path?JSON.parse(readFileSync(path,'utf8')).release??null:null;
}
export function requireRelease(root,board) {
 const recipe=releaseRecipe(root,board);
 if(!(recipe && typeof recipe==='object' && typeof recipe.maker==='string' && typeof recipe.fab==='string'))
  throw new Error(`unsupported board: ${board} has no "release" entry ({"maker": "tools/make-x-fab.sh", "fab": DIR, ...}) in hardware-design/boards/${board}/gate.json or gate.pending.json`);
 return recipe;
}
