import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,realpathSync,rmSync,symlinkSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {projectRoot,findProjectRoot,fileRoot} from './project-root.mjs';

test('project root order: explicit > IOT_LAB > cwd search > file-relative',t=>{
 const root=realpathSync(mkdtempSync(join(tmpdir(),'project-root-')));t.after(()=>rmSync(root,{recursive:true,force:true}));
 const deep=join(root,'hardware-design/boards/X');mkdirSync(deep,{recursive:true});
 assert.equal(projectRoot('/a',{IOT_LAB:'/b'},deep),'/a');
 assert.equal(projectRoot(undefined,{IOT_LAB:'/b'},deep),'/b');
 assert.equal(projectRoot(undefined,{},deep),root);
 assert.equal(findProjectRoot('/'),null);
 assert.equal(projectRoot(undefined,{},'/'),fileRoot);
});

test('the marker must be a folder, and a linked start climbs its real parents',t=>{
 const root=realpathSync(mkdtempSync(join(tmpdir(),'project-root-')));t.after(()=>rmSync(root,{recursive:true,force:true}));
 mkdirSync(join(root,'a/hardware-design'),{recursive:true});writeFileSync(join(root,'a/hardware-design/boards'),'');
 assert.equal(findProjectRoot(join(root,'a')),null);
 mkdirSync(join(root,'real/hardware-design/boards'),{recursive:true});mkdirSync(join(root,'real/sub'));
 symlinkSync(join(root,'real/sub'),join(root,'a/link'));
 assert.equal(findProjectRoot(join(root,'a/link')),join(root,'real'));
});
