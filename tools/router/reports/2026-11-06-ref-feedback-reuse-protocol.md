# Scoped reference-feedback reuse protocol (#1412)

No host activity or real-board execution starts until the #1399 owner confirms
all five preregistered trials and timing collection have finished. Local source
inspection and unit tests are preparation, not performance evidence. Do not
change the #1399 inputs, harness, driver, executable or saved records.

## Implementation and control

Pin the implementation commit, complete source archive/tree hash, Linux release
binary hash, Rust compiler, Node runtime and existing native image before the
first board invocation. Use one compiled binary for both primary modes. The
existing reference cost schedule, numeric rules, seed and maximum passes stay
unchanged. No canonical CAD, stock, gate or exemption edits are authorized.

Default `iotroute run` remains a full feedback reroute. `--ref-reuse` enables an
internal copper seed only after verifying the exact input and the named model
reference-cost raise/hardening. All other raw model values must match. This
loads retained copper through the existing negotiable-owner reuse mechanism;
it does not restore a search tree, cached objective, history field or native
approval from the old model. The old pass count is only the existing reuse
engine's present-cost starting hint.

The scoped core uses `--reuse-recover changed`: length recovery is limited to
nets actually routed in this attempt, rather than extending to nearby untouched
nets. Scope may expand through the existing real conflict/return/pour repairs.
Retained copper is not fixed. Core, writer, fresh native DRC/connectivity/parity
and the reference screen must all pass before selection. Otherwise run the
ordinary full fallback under the updated model and retain both attempts' logs.
Input/model mutation during an attempt is an error, not a reusable result.
The ordinary next reference screen, final native checks and configured gate
remain in force. The option does not combine with public `--reuse` or sprints.

## Predetermined board sequence

Run sequentially in isolated scratch projects on Hetzner after host release:

| Order | Case | Existing policy / input |
|---:|---|---|
| 1 | ESP32-CORE B full control | 2 CPUs, 8 GiB, seed 0, 80 passes; frozen #1399 PCB `b6b97508...` at iot-lab `a545d5e1`; existing calibration has no experiment wall cap and uses the daemon's operational ceiling |
| 2 | Same ESP32 input with `--ref-reuse` | Same binary, resources, rules and work limit; only the feedback-reuse option differs |
| 3 | NET-CORE regression with the option | Frozen #1395 input `9109c27c...`, preserving 229 locked copper objects; 1 CPU, 8 GiB, 80 passes, existing 600 s native routing budget / 660 s outer timeout; no `--lock-from` |
| 4 | ENV-SENSE regression with the option | Frozen #1389 input `6abb00a0...`; 2 CPUs, 8 GiB, seed 0, 80 passes, existing 90 s native / 120 s job policy and unchanged semantic hooks |

These are one primary before/after pair plus two regressions, not another
portfolio benchmark. Existing #1399 single measurements and #1395/#1389
acceptance receipts provide context, not substitute fresh acceptance of the
new executable. Do not add seeds, repeat failed trials, raise budgets or clear
shared caches to obtain a preferred result. A setup refusal before any routing
is recorded separately from a routing attempt.

## Acceptance, measurements and stop

ESP32 must retain native DRC/opens/parity 0/0/0 and planes 0. Report every fresh
configured count and the five existing stale RP-001 exemptions separately;
official gate failure is not board acceptance. NET-CORE requires the complete
fresh configured gate. ENV requires the complete fresh gate, unchanged semantic
hooks and the known `7c4dd481...` accepted bytes, or an explicit investigation of
any difference. Reject additional errors; do not edit or waive them.

Capture operation wall time and cumulative cgroup CPU, disjoint owned-child
wall/CPU, preparation and verification costs, every scoped/full attempt and
fallback reason, route quality, exact model/input/seed/source fingerprints,
native/gate receipts and terminal child/container cleanup. Preserve fixed and
locked geometry, project/rule/evidence hashes and the original sources. Do not
add overlapping child wall intervals or nested CPU scopes.

If the scoped result loses verified quality, fails acceptance, or provides no
useful saving, leave it off and report that result. No numeric improvement
threshold or default enablement is preregistered. A negative result is valid;
no broader search algorithm or automatic rule relaxation follows from it.

## Launcher correction before the scoped comparison

The first full control reproduced the exact historical native candidate, with
native 0/0/0 and the completed reference screen clean. Four separate configured
checkers then refused because the test launcher omitted the project-root
`bin/iotroute-linux-x86_64` alias used by the existing board-JSON helper. The
binary was present at `/bench/bin` and through `IOTROUTE_BIN`; this was a runtime
path omission, not a routing or rule failure. The failed checker receipts remain
retained, with null metrics kept as errors.

Before any scoped run, restore the same runtime aliases as the original harness
in all owned copies and run one fresh gate-only check on the identical control
candidate. Do not reroute the control. Record that gate's cost separately; the
original whole-harness timing includes incomplete checks and is not a valid
fully verified end-to-end baseline. Compare the disjoint native-stage wall and
CPU directly between modes, and show configured checking cost separately.
No rules, sources, resource limits, seeds, work limits or acceptance exceptions
change. An independent container-absence check also corrects the controller's
case-sensitive matching of Docker's lower-case `no such object` message.

## Preservation failure and corrected revision pending

The pinned scoped prototype passed the named native and reference checks and
improved track length/via count, but it failed the stronger untouched-copper
audit. Native integer-coordinate exports confirm one-nanometre differences on
15 unrelated nets. An earlier round-to-nearest JSON comparison was withdrawn:
the writer actually truncates toward zero. Both audits and the failed result
are retained. Locked input objects remain unchanged.

The cause is the existing seed loader's default JSON float parsing. The local
correction preserves each seed decimal's original double bits using RawValue
and the standard float parser; the model parser and numeric rules do not change.
Scoped reuse also falls back when width-rewriting rules are present, because
that separate numeric path has not earned a preservation claim.

A corrected same-binary ESP32 pair has been requested from the coordinator;
it has not started. If authorized, pin a new source/binary before that pair,
retain the original failed preservation outcome, and use the exact native
integer-coordinate auditor. No additional seed, budget increase, tolerance,
exemption change or acceptance exception is proposed. The option stays off
until corrected preservation and the required native regressions are verified.
