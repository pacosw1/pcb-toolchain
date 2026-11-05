# Ordinary live dispatch (#1339)

The dispatch and observer paths now connect ordinary placement/routing jobs to
the existing Studio journal. Router and placer search algorithms are unchanged.
Local CLI upload runs outside jobs; job-local capture is Rust and uses the
existing output mount. Network isolation and non-root execution remain enabled.

## Isolated Hetzner evidence

Only ENV-SENSE copies were exercised. Production services and canonical boards
were not changed by this increment.

| Path | Daemon job | Result | Recorded events |
| --- | --- | --- | --- |
| `remote.sh` + ordinary placer entry point | `20261105-182215-ccbfcb` | Native exit 0; two legal candidates | 328 |
| Ordinary route dispatcher | `20261105-182222-34fb04` | DRC/open/parity 0/0/0; 283 tracks, 24 vias | 58 |

Neither command invoked `pcb-live-run.mts`. Both ran as UID/GID 1000 in the
existing pinned nightly image, with two CPUs and 4 GiB per job. Placement used
16 epochs and 300,000 steps per worker; routing used six passes and a 90-second
core bound. Recorded outcomes remain `verified: false`.

The first job (`20261105-181855-acf5e4`) failed before search because the
non-root container could not read its root-owned mode-0600 input archive.
The coordinator-approved fix grants only job-group read access after descriptor
checks. A dropped-UID test confirms access for that group, rejection for another
group, and refusal of symlink/hardlink inputs. No root-job workaround was used.

The outer `pcb context`/`next` preflight separately reports the existing missing
`ENV-SENSE/BOM-VERIFIED.csv`. That packet check was not bypassed or fabricated.
The evidence above exercises ordinary dispatch and the native route gate, not
outer candidate adoption or full board qualification.

Targeted checks cover default/opt-out selection, source mapping without frozen
model mutation, native output equality, completion records, job/attempt IDs,
restart/idempotency, failed delivery, partial frames, forged verification
rejection, link safety, local command exit preservation and release closure.

An actual `PCB_LIVE=0` remote placement run produced identical placement history
and candidates to the observed run, and created no additional live recording.
Wall/finish timing fields were excluded from the comparison.
