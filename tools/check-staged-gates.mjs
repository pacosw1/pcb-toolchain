#!/usr/bin/env node
import {execFileSync} from 'node:child_process';
import {checkStaged} from './lib/staged-gates.mjs';
try {
  const root=execFileSync('git',['rev-parse','--show-toplevel'],{encoding:'utf8'}).trim();
  checkStaged(root);
} catch(e) {console.error(`staged gate failed: ${e.message}`);process.exitCode=1;}
