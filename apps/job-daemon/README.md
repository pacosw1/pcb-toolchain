# Job daemon

Runs placer and router jobs on the Linux box instead of the Mac, in the same containers as `tools/remote.sh`, with a
queue, a CPU budget, retries, and status and logs that do not depend on the client staying connected.

TypeScript on Node with no runtime dependencies: the host already has Node 24 and no Rust toolchain, the work is
I/O (spawn docker, stream files), and deploying is copying `src/`.

`tools/remote.sh` is **replaced, not wrapped**, for jobs that go through the daemon. It holds an SSH session for the
whole job, so it cannot outlive a client or recover. The job contract stays the same (`/job`, `in/`, `out/`,
`out/job.log`, `timeout -k 10`, the same file selection), so a command that works under `remote.sh` works here.
`remote.sh` is unchanged and keeps working.

## Client

```sh
export JOBD_URL=http://100.93.34.43:8793 JOBD_TOKEN_FILE=~/.config/pcb-job/token IOT_LAB=~/code/iot-lab
alias pcb-job='node --no-warnings /path/to/pcb-toolchain/apps/job-daemon/src/client.ts'

pcb-job run hardware-design/boards/X --in prob.json --cpus 8 --mem 8 --disk 10 --timeout 600 --results /tmp/x -- <command...>
pcb-job submit ...      # the same, prints the id and returns
pcb-job watch ID        # states on stderr, log on stdout; reconnects; exits with the job's code
pcb-job status [ID]     # a job, or the budget, the queue and why it waits
pcb-job list
pcb-job cancel ID
pcb-job results ID [DIR]
```

`run` and `watch` exit 0 on passed, the command's code on failed, 130 on cancelled, 3 if the daemon stayed unreachable
for 5 minutes (the job goes on). Results: `out/` of the last attempt, `job.json`, `events.jsonl`, and
`attempts/N/out/job.log` of earlier attempts.

The client ships what `remote.sh` ships, plus the evidence files named by `tools/driver-edges.json` and
`tools/edge-rates.json`, because `router/model.py` refuses to run without them.

Router jobs need two more inputs that the image does not have, given with `--in`: a Linux `iotroute` for `--bin`, and
a git checkout of kicad-happy at the commit pinned in `tools/lib/env.mjs`, as a tar unpacked by the job, with
`KICAD_HAPPY_DIR` set. `tools/router/route-dispatch.mjs` does this for `pcb route --router iotroute`; its header has the
rule for a daemon failure partway. The placer needs the numpy wheel, as in `tools/placer/README.md`.

## States

```
queued -> running -> passed
            |  |---> failed
            |  |---> cancelled
            v
         retrying -> running (next attempt) or cancelled
```

`queued` and `retrying` jobs cancel at once. A running job's container is killed and it ends at the next tick.

## Retry rule

The verdict comes from Docker's own state (`ExitCode`, `OOMKilled`) and the daemon's own record. No file in the job
folder takes part. If the container is gone, the job has no verdict: it is `infra`, never `passed`.

| How the attempt ended | Outcome | Retries |
| --- | --- | --- |
| Container exit 0 | `passed` | - |
| Exit 124, 137 at the time limit, or killed by the daemon at its deadline | `timeout` | No: `remote.sh`'s rule, fix the placement, do not wait longer |
| Out of memory at the job limit | `oom` | No: the same limit gives the same result |
| Over the disk limit, or exit 153 (a file hit `RLIMIT_FSIZE`) | `disk` | No |
| Any other non-zero exit, for example router 1 (DRC) or 2 (no verdict) | `command` | No, a tool's exit is a verdict, unless `--retry-exit CODE` names it |
| Image not on the host | `start` | No |
| Container gone with no state | `infra` | Yes |
| Exit 137 before the time limit (SIGKILL from outside), or 255 (Docker lost it) | `infra` | Yes |
| `docker run` error | `infra` | Yes |

A tool that really exits 255 is retried too, within `--retries`. Exit 0 is what the job's PID 1 reported, so a hostile
job can always claim success, as any process can. What it cannot do is turn a kill or a limit into a pass.

At most `--retries` retries (default 2), after 30, 60, 120 s. Each attempt starts from a fresh copy of the input. A
retry keeps its place in the queue. While Docker does not answer, nothing starts and no retry is used.

## Restart recovery

`jobs/<id>/job.json` is the record, written atomically before each side effect. Containers run detached, so a daemon
stop or crash does not touch them. The tick loop compares each record with its container and acts on the difference,
and that loop is also the only code path for a normal exit. So recovery is: load the records, tick. Running jobs are
picked up, jobs that ended meanwhile get their verdict from Docker, a lost container is `infra`, and queue order,
backoff times and deadlines carry over. The verdict is saved before the container is removed; the first tick after a
start removes any container left over from a crash in between.

Logs are files, so a client resumes from its byte offset.

## Hostile jobs

A job is treated as hostile: it owns `/job`, and the daemon runs as root.

- **Layout.** `attempts/N/` is root-owned and out of the job's reach. `work/` is `/job`. `out/` is a separate mount at
  `/job/out`, so the job cannot swap `out` for a symlink.
- **Reads.** The only job-writable file the daemon reads is `out/job.log`: opened once with `O_NOFOLLOW|O_NONBLOCK`,
  checked with `fstat`, read from that descriptor. A symlink or FIFO reads as empty.
- **Cleanup.** The daemon never walks or deletes job files itself. One loop, apart from the tick, removes the container
  and needs Docker to say it is missing; any other answer means stop and try later. Then a throw-away container with
  only the attempt folder mounted removes `work/`, and links and FIFOs in `out/`. Even wrong logic there cannot reach
  the host. Results answer 409 until that is done; `pcb-job run` waits for it.
- **Input.** Unpacked in the container as the job's uid, inside its limits. Root only lists the tar.
- **Time.** The `timeout` in the container runs as the job's uid, and `kill -STOP` freezes it. The real deadline is
  the daemon's: `timeoutS` + 10 s (`-k`) + 5 s (margin, a default to tune), from `startedAt` in the record.
- **Processes.** `--pids-limit` per job, `TasksMax` for the slice.
- **Disk.** See "Limits". `--ulimit fsize` caps each file exactly (it also stops sparse files). A watcher sums `work/`,
  `out/` and the container's writable layer every 5 s and kills the job over its `--disk` limit. A measurement is a
  clean, complete answer or none; three failures in a row kill the job (one is normal: `du` fails when a file vanishes
  mid-walk). `du` and root's `tar -t` run at `nice 19`, idle I/O class, with a time limit. Every tick, `statfs` on the
  data disk: below `JOBD_MIN_FREE_GB` all running jobs are killed. Admission needs the job's whole limit to fit above it.
- **Requests.** Limits on upload size, concurrent uploads and streams, connections, queue length and list length.
  Answers: 413, 503, 429. An upload holds its slot until its validation has ended; a client that leaves cancels it.

## Limits

There is no real disk quota. md4 is ext4 without the `quota` and `project` features, and adding them needs
`/var/lib/docker` unmounted, which stops everything on the box.

The per-job limit is not a hard bound. A job can get past it in two ways:

- **Between two checks** it can overshoot by what it writes in 5 s.
- **Unlinked files.** `du` cannot see a file that is deleted but still open. `--ulimit nofile` and `fsize` bound this
  per process only, because `RLIMIT_NOFILE` is per process: 1024 x `diskGb`, so 10 TB at the default. Per job that is
  also times `--pids-limit` (4096). That is more than the disk, so **this arithmetic gives no useful bound**.

The bound that holds is the host floor: running jobs die when free space on the data disk drops below
`JOBD_MIN_FREE_GB`, and that releases their unlinked files. It is checked every 2 s. Its margin is what the jobs can
write in that time, against 20 GB: this write rate has not been measured on md4. It kills every running job, also when
something else used the space, so one hostile job can end the others.

A hard per-job bound would need a loop-mounted filesystem per job. That is a larger change and is not done.

Inodes are not counted. A tree that `du` cannot measure in 30 s counts as a failed measurement.

## CPU budget and the shared host

The box is already fully claimed on paper: `ci-runners.slice` 20 CPUs and 40 GB, `agent-orchestrator.slice` 12 CPUs and
16 GB, 6 GB system. Jobs borrow what is idle, and four layers keep them from taking it from the others:

1. **Budget and queue.** Sum of running jobs' `--cpus` and `--mem` stays within the budget. Strict FIFO.
2. **Hard limits per job.** `docker run --cpus --memory --memory-swap`, no swap.
3. **`pcbjobs.slice`.** Top-level, `CPUWeight=10`, so CI and the orchestrator win when CPU is contended, with a hard
   ceiling for the sum. `--oom-score-adj 1000` makes jobs the kernel's first choice if the host runs out of memory.
4. **Admission on live pressure.** A job does not start while CPU PSI or free memory is outside the limits below,
   the same signals `servterm-resource-guard` reads. `pcb-job status` gives the reason in `hold`.

Known limit: the guard cuts CI's quota at 95 % host CPU, also when that load comes from jobs, down to its floor of 60 %
of 32 CPUs = 19.2 CPUs, about CI's static 20. Running jobs are not paused. If that hurts, lower `JOBD_CPU_BUDGET`.

## Defaults

| Env | Default | Source |
| --- | --- | --- |
| `JOBD_BIND` | 127.0.0.1 | 127.0.0.1, ::1 or 100.64.0.0/10 only, the rule of `tools/route_live.py`; anything else refuses to start |
| `JOBD_PORT` | 8793 | Free on the host |
| `JOBD_TOKEN_FILE`, `JOBD_DATA_DIR` | required | At least 32 characters: 128 bits as hex |
| `JOBD_IMAGES` | `iot-lab-route:10.0,iot-lab-route:10.0-fr241` | `remote.sh`; the first is the default |
| `JOBD_CPU_BUDGET` | 16 | **To tune.** Half of 32; leaves 16 of the 32 for the 12 + 20 others under contention, with the low weight |
| `JOBD_MEM_BUDGET_GB` | 16 | **To tune.** Host peak is unknown; admission checks live memory as well |
| `JOBD_CGROUP_PARENT` | none | `pcbjobs.slice` when deployed. No hyphen: systemd reads it as nesting |
| `JOBD_DEFAULT_CPUS`, `JOBD_DEFAULT_MEM_GB` | 8, 8 | **To tune.** Two jobs fit the budget. `placer/remote_run.sh` uses `REMOTE_MEM=8g` |
| `JOBD_DEFAULT_TIMEOUT_S` | 300 | `remote.sh` `REMOTE_TIMEOUT` |
| `JOBD_MAX_TIMEOUT_S` | 21600 | **To tune.** Stops a job from holding budget without end. Compaction's budget is 45 min |
| `JOBD_DEFAULT_RETRIES`, `JOBD_MAX_RETRIES` | 2, 5 | **To tune** |
| `JOBD_RETRY_BACKOFF_S` | 30 | **To tune.** Doubles per retry |
| `JOBD_CPU_PSI_MAX` | 5 | Guard: CI's quota recovers only below CPU PSI some avg10 = 5 |
| `JOBD_MEM_FLOOR_FRACTION` | 0.2 | Guard: CI's memory recovers only above 20 % available. Compared after subtracting the job's `--mem` |
| `JOBD_MIN_FREE_GB` | 20 | **To tune.** Refuses submits and holds starts below it |
| `JOBD_MAX_UPLOAD_MB` | 512 | **To tune.** `tools/` is 8 MB and the driver evidence 17 MB, before compression; boards and `--in` files add to that |
| `JOBD_RETAIN_DAYS` | 7 | **To tune.** `/srv/iot-lab-route/jobs` has grown to 314 folders with no cleanup |
| `JOBD_JOB_UID` | 1000 | `kicad` in the image; `remote.sh` chowns to the same. `none` for no `--user` and no chown |
| `JOBD_TICK_MS` | 2000 | **To tune** |
| `JOBD_PIDS_LIMIT` | 4096 | `TasksMax` of `agent-orchestrator.slice`. **To tune** |
| `JOBD_NOFILE` | 1024 | **To tune.** The usual Linux soft limit; placer and router ran under it, Freerouting has not |
| `JOBD_DEFAULT_DISK_GB`, `JOBD_MAX_DISK_GB` | 10, 50 | **To tune.** md4 has 1.1 TB free |
| `JOBD_DISK_CHECK_S` | 5 | **To tune.** Same period as the guard's sampling |
| `JOBD_MAX_QUEUED` | 64 | **To tune.** Queued inputs stay on disk, up to 512 MB each |
| `JOBD_MAX_UPLOADS` | 2 | **To tune.** Each holds a `tar -t` for up to 60 s |
| `JOBD_MAX_STREAMS` | 64 | **To tune.** Logs, events and results together |

Guard numbers: `internal/resourceguard/guard.go` in server-term. One start per tick, because PSI is a 10 s average.

Spec floors, below which a value would mean "no limit" or be refused: `cpus` 0.01 (the kernel's minimum quota, 1 ms per
100 ms); `timeoutS` 1 (`timeout 0` means none); `memGb` 0.0625 (to tune; Docker's minimum is 6 MiB and `--memory 0` means
unlimited); `diskGb` 0.01 (to tune). Non-finite values and non-numbers are refused.

## API

All routes need `Authorization: Bearer <token>`.

| Route | |
| --- | --- |
| `POST /jobs` | Body: gzip tar of the job folder. Header `x-job-spec`: base64 JSON `{command, image, cpus, memGb, diskGb, timeoutS, maxRetries, retryExitCodes, name}` |
| `GET /jobs?limit=N`, `GET /jobs/ID`, `GET /status` | Records (newest first, N in 1..500); budget and queue |
| `POST /jobs/ID/cancel` | |
| `GET /jobs/ID/log?attempt=N&offset=B&follow=1` | Raw log from byte B; ends when the attempt ends |
| `GET /jobs/ID/events?offset=B&follow=1` | NDJSON state log; ends at a terminal state |
| `GET /jobs/ID/results` | gzip tar; 409 until the job has ended and its cleanup is done |

Containers get `--network none`, no capabilities, `no-new-privileges`, and only the allowed images. The tar is refused
if an entry is absolute or has `..`.

## Test

```sh
npm ci && npm run typecheck && npm test   # fake jobs: every state and retry path, no Docker
test/e2e-host.sh [user@host]              # real containers, from a temp dir; installs nothing, leaves nothing
```

## Deploy

Nothing below has been applied. On the host, as root:

```sh
mkdir -p /opt/pcb-job-daemon /var/lib/docker/pcb-jobs     # data on md4: the root disk has 12 GB free
# copy apps/job-daemon/src to /opt/pcb-job-daemon/src
cp deploy/pcbjobs.slice deploy/pcb-job-daemon.service /etc/systemd/system/
cp deploy/pcb-job-daemon.env.example /etc/pcb-job-daemon.env && chmod 600 /etc/pcb-job-daemon.env
openssl rand -hex 32 > /etc/pcb-job-daemon.token && chmod 600 /etc/pcb-job-daemon.token
# /etc/nftables.conf, chain input, next to the other tailscale0 lines; the policy is drop:
#   iifname "tailscale0" tcp dport 8793 accept comment "pcb job daemon"
nft -c -f /etc/nftables.conf && nft -f /etc/nftables.conf
systemctl daemon-reload && systemctl enable --now pcb-job-daemon
```

Install the slice before the first job: without its unit file the weight and the ceiling do not apply (not tested;
the e2e script uses `system.slice` as the parent, so `pcbjobs.slice` itself has not run). On the Mac, copy the token to `~/.config/pcb-job/token` (mode 600) and set `JOBD_URL`.
