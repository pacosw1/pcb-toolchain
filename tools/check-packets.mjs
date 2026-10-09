#!/usr/bin/env node
import {fileURLToPath} from 'node:url';
import {inspectPackets,loadBoardRegistry} from './lib/board-packets.mjs';
const root=fileURLToPath(new URL('..',import.meta.url));
try {
 const result=inspectPackets(root,loadBoardRegistry(root));
 console.log(JSON.stringify(result,null,2));process.exitCode=result.ok?0:1;
} catch(error){console.error(`packet checker: ${error.message}`);process.exitCode=2;}
