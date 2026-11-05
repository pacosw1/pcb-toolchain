// Optional observation around ordinary local dispatch; native processes inside jobs use the daemon's spool instead.
import fs from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("../..", import.meta.url));
export function liveCommand(
  command,
  spool,
  env = process.env,
  cwd = process.cwd(),
) {
  if (env.PCB_LIVE === "0" || env.PCB_LIVE_DIR) return { command, env: {} };
  let url = env.JOBD_URL;
  if (!url)
    for (let dir = cwd; ; dir = path.dirname(dir)) {
      const file = path.join(dir, ".pcb-toolchain.env");
      if (fs.existsSync(file)) {
        url = fs
          .readFileSync(file, "utf8")
          .split("\n")
          .find((l) => l.startsWith("JOBD_URL="))
          ?.slice(9);
        break;
      }
      if (dir === path.dirname(dir)) break;
    }
  const tokenFile =
    env.JOBD_TOKEN_FILE || path.join(os.homedir(), ".config/pcb-job/token");
  if (!url || (!env.JOBD_TOKEN && !fs.existsSync(tokenFile)))
    return { command, env: {} };
  const client = [
    path.join(root, "tools/pcb-job/client.ts"),
    path.join(root, "apps/job-daemon/src/client.ts"),
  ].find((f) => fs.existsSync(f));
  if (!client) return { command, env: {} };
  const state =
    env.XDG_STATE_HOME || path.join(env.HOME || os.homedir(), ".local/state");
  const folder = path.join(
    state,
    "pcb-live",
    path
      .basename(spool)
      .replace(/[^a-zA-Z0-9_.-]/g, "_")
      .slice(0, 48) +
      "-" +
      createHash("sha256")
        .update(path.resolve(spool))
        .digest("hex")
        .slice(0, 16),
  );
  return {
    command: [
      process.execPath,
      "--no-warnings",
      "--experimental-strip-types",
      client,
      "observe",
      folder,
      "--",
      ...command,
    ],
    env: {
      JOBD_URL: url,
      ...(env.JOBD_TOKEN ? {} : { JOBD_TOKEN_FILE: tokenFile }),
    },
  };
}
