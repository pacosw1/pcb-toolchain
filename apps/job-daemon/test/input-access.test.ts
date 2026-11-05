import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { prepareInputArchive } from "../src/manager.ts";
test(
  "non-root job group can read its input, other groups cannot, and links are refused",
  { skip: process.getuid?.() !== 0 },
  () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "job-input-access-"));
    fs.chmodSync(root, 0o755);
    try {
      const file = path.join(root, "input.tar.gz");
      fs.writeFileSync(file, "fixture", { mode: 0o600 });
      prepareInputArchive(file, 65534);
      assert.equal(fs.statSync(file).mode & 0o777, 0o640);
      assert.equal(fs.statSync(file).gid, 65534);
      const read = (gid: number) =>
        spawnSync(
          process.execPath,
          [
            "-e",
            "process.stdout.write(require('fs').readFileSync(process.argv[1]))",
            file,
          ],
          { uid: 65534, gid, encoding: "utf8" },
        );
      assert.equal(read(65534).stdout, "fixture");
      assert.notEqual(read(65533).status, 0);
      fs.symlinkSync(file, path.join(root, "symlink"));
      assert.throws(() =>
        prepareInputArchive(path.join(root, "symlink"), 65534),
      );
      fs.linkSync(file, path.join(root, "hardlink"));
      assert.throws(() => prepareInputArchive(file, 65534), /unsafe/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  },
);
