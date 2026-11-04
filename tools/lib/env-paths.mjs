import {join} from 'node:path';

// Pure path selection keeps the desktop and Linux CI on the installed native
// libraries. Overrides name real installations; no synthetic tables are made.
export function kiCadPaths(platform, home, env = {}) {
  const mac = platform === 'darwin';
  const app = env.KICAD_APP ?? (mac ? '/Applications/KiCad/KiCad.app/Contents' : '/usr');
  const configBase = env.KICAD_CONFIG_HOME ?? (mac ? join(home,'Library/Preferences/kicad') :
    join(env.XDG_CONFIG_HOME ?? join(home,'.config'),'kicad'));
  return {
    kicadApp:app,
    kicadCli:env.KICAD_CLI ?? (mac ? join(app,'MacOS/kicad-cli') : 'kicad-cli'),
    kicadPython:env.KICAD_PYTHON ?? (mac ? join(app,'Frameworks/Python.framework/Versions/Current/bin/python3') : 'python3'),
    kicadShared:env.KICAD_SHARED ?? (mac ? join(app,'SharedSupport') : '/usr/share/kicad'),
    kicadConfig:join(configBase,'10.0'),
  };
}
