import test from 'node:test';
import assert from 'node:assert/strict';
import {kiCadPaths} from './env-paths.mjs';

test('desktop defaults retain the installed Mac KiCad application and versioned config',()=>{
 const paths=kiCadPaths('darwin','/Users/test');
 assert.equal(paths.kicadCli,'/Applications/KiCad/KiCad.app/Contents/MacOS/kicad-cli');
 assert.equal(paths.kicadPython,'/Applications/KiCad/KiCad.app/Contents/Frameworks/Python.framework/Versions/Current/bin/python3');
 assert.equal(paths.kicadShared,'/Applications/KiCad/KiCad.app/Contents/SharedSupport');
 assert.equal(paths.kicadConfig,'/Users/test/Library/Preferences/kicad/10.0');
});
test('Linux defaults use native command lookup, installed libraries, and XDG config',()=>{
 const paths=kiCadPaths('linux','/home/test',{XDG_CONFIG_HOME:'/run/user/config'});
 assert.equal(paths.kicadCli,'kicad-cli');assert.equal(paths.kicadPython,'python3');
 assert.equal(paths.kicadShared,'/usr/share/kicad');assert.equal(paths.kicadConfig,'/run/user/config/kicad/10.0');
 assert.equal(kiCadPaths('linux','/home/test').kicadConfig,'/home/test/.config/kicad/10.0');
});
test('explicit native tools, library roots and KiCad config base override platform defaults',()=>{
 const paths=kiCadPaths('linux','/home/test',{KICAD_CLI:'/opt/native/cli',KICAD_PYTHON:'/opt/native/python',KICAD_SHARED:'/opt/native/share',KICAD_CONFIG_HOME:'/run/kicad',XDG_CONFIG_HOME:'/unused'});
 assert.equal(paths.kicadCli,'/opt/native/cli');assert.equal(paths.kicadPython,'/opt/native/python');
 assert.equal(paths.kicadShared,'/opt/native/share');assert.equal(paths.kicadConfig,'/run/kicad/10.0');
});
