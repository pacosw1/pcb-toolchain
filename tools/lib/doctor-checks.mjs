import {accessSync,constants,realpathSync} from 'node:fs';
import {resolve,join} from 'node:path';
export function hookCheck(root,configured) {
  if (!configured) return {ok:false,detail:'not configured'};
  const hook=join(resolve(root,configured),'pre-commit');
  try {
    accessSync(hook,constants.X_OK);
    const expected=join(root,'tools/hooks/pre-commit');
    return {ok:realpathSync(hook)===realpathSync(expected),detail:hook};
  } catch {return {ok:false,detail:`missing or not executable: ${hook}`};}
}
