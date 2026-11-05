import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { liveCommand } from "./live-command.mjs";
test("configured ordinary local dispatch observes, explicit opt-out and job-native dispatch do not wrap", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "live-command-"));
  try {
    const command = ["iotplace", "run", "problem.json"];
    const env = { JOBD_URL: "http://127.0.0.1:8793", JOBD_TOKEN: "fixture" };
    const on = liveCommand(command, path.join(root, "out"), env, root);
    assert.ok(on.command.includes("observe"));
    assert.deepEqual(on.command.slice(-3), command);
    assert.equal(on.env.JOBD_URL, env.JOBD_URL);
    for (const extra of [{ PCB_LIVE: "0" }, { PCB_LIVE_DIR: "/job/out" }])
      assert.deepEqual(
        liveCommand(command, "out", { ...env, ...extra }, root).command,
        command,
      );
    assert.deepEqual(liveCommand(command, "out", {}, root).command, command);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
