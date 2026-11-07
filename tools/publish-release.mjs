#!/usr/bin/env node
// Publish one release stage: rename a directory to DESTINATION without replacing any existing entry.
//
//   node tools/publish-release.mjs STAGE DESTINATION
//
// Node has no RENAME_NOREPLACE (Linux) or RENAME_EXCL (macOS), so two steps do that work:
//   1. mkdir DESTINATION. It is exclusive, also for a file or a dangling link. EEXIST: refuse. Racing publishers
//      are decided here, and an empty directory that already exists is refused like any other entry.
//   2. rename STAGE over that empty directory. POSIX makes this atomic, and refuses a directory that is not empty, so
//      no interleaving can replace a published candidate or nest into one.
// Between the steps a reader sees an empty directory, which is the one state the single rename did not have. Every
// reader needs release-manifest.json, so it is blocked there. A crash between the steps leaves that empty directory and
// the whole stage: nothing is lost and publishing stays refused until a person runs rmdir DESTINATION, which
// cannot remove a published candidate.
import {lstatSync, mkdirSync, readdirSync, renameSync, rmdirSync, statSync} from 'node:fs';
import {eprint, pyRepr} from './lib/py-compat.mjs';

const TEXT = {ENOENT: 'No such file or directory', EEXIST: 'File exists', ENOTDIR: 'Not a directory', EISDIR: 'Is a directory',
  ENOTEMPTY: 'Directory not empty', EINVAL: 'Invalid argument', EXDEV: 'Cross-device link', EACCES: 'Permission denied',
  EPERM: 'Operation not permitted', EROFS: 'Read-only file system', ENOSPC: 'No space left on device'};
const failure = (e, path) => `[Errno ${-e.errno}] ${TEXT[e.code] ?? e.code}: ${pyRepr(path)}`;

// A crash between mkdir and rename leaves an empty destination that is not a published candidate. Only an
// empty directory old enough that no publisher can still be between its two steps is reclaimed.
const STALE_PUBLISH_MS = 5000;
function reclaimStaleEmpty(destination) {
  try {
    const state = lstatSync(destination);
    if (!state.isDirectory() || Date.now() - state.mtimeMs < STALE_PUBLISH_MS) return false;
    if (readdirSync(destination).length) return false;
    rmdirSync(destination);
    return true;
  } catch { return false; }
}

function publish(source, destination) {
  if (!lstatSync(source).isDirectory()) throw new Error(failure({errno: -20, code: 'ENOTDIR'}, source));
  try { mkdirSync(destination); }
  catch (error) {
    if (error.code !== 'EEXIST' || !reclaimStaleEmpty(destination)) throw error;
    mkdirSync(destination);
  }
  try { renameSync(source, destination); } catch (error) {
    try { rmdirSync(destination); } catch { /* no longer an empty claim of ours: it stays */ }
    throw error;
  }
}

function main([source, destination]) {
  if (destination === undefined) {
    throw new Error(source === undefined ? "publish() missing 2 required positional arguments: 'source' and 'destination'"
      : "publish() missing 1 required positional argument: 'destination'");
  }
  try { publish(source, destination); } catch (error) {
    throw error.code ? new Error(failure(error, destination)) : error;
  }
}

try { main(process.argv.slice(2)); } catch (error) {
  eprint('FAIL: release publication: ' + error.message);
  process.exitCode = 1;
}
