#!/usr/bin/env node
import {inspectPackets,loadBoardRegistry} from './lib/board-packets.mjs';
import {projectRoot} from './lib/project-root.mjs';
const root=projectRoot();
try {
 const result=inspectPackets(root,loadBoardRegistry(root));
 console.log(JSON.stringify(result,null,2));process.exitCode=result.ok?0:1;
} catch(error){console.error(`packet checker: ${error.message}`);process.exitCode=2;}
