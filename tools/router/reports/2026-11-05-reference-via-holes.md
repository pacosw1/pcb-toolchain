# Local reference-plane holes from vias (#1325)

This increment closes the local clearance blind spot reported in task comment
5269. A checked track could pass outside the generic `--plane-clr` envelope but
inside the reference copper removed by a new via. The static reference fill was
correct for the input board; it could not include holes made by later routing.
The final native planes gate rejected such outputs, but the core had no useful
conflict to negotiate. No historical NET-CORE run was repeated.

## Change

The core now derives a conservative local via setback for each declared adjacent
plane from existing model data: zone clearance, thermal gap, via-specific
zone/DRU clearance, class/net/board clearance, and a full zone minimum-width
margin. Maxima across the adjacent plane deliberately trade search freedom for
conservative local clearance. These are source-bound values, not new electrical
requirements or a tuned magic distance. The generic CLI clearance cannot lower
them.

The same bound is applied in both directions: a track against an existing via,
and a candidate via against an existing checked track. Spatial query radii grow
with the bound, so an item outside the old search neighborhood is not missed.
Routed conflicts retain their item IDs for negotiation; fixed conflicts stay
hard. Own-net, domain and layer scopes remain distinct.

```text
model zones + declared adjacent plane
                |
                v
immutable per-layer local setback
                |
                v
live track <--> via conflict in spatial indexes
                |
                +--> rip up via: hole disappears with the live shape
```

Live holes are not put in the immutable reference-fill cache. No schema change,
new Python, gate relaxation or canonical board edit is included.

This is a conservative **local antipad guard**, not an exact dynamic zone filler.
It does not establish whole-plane connectivity after cuts, reconstruct arbitrary
merged voids or disconnected islands, or model tracks on mixed reference layers.
It may reject a route that a more exact solver could accept. Native refill and
the complete configured planes gate remain authoritative. Do not describe this
increment as full support for every dynamic reference-plane topology.

## Reproduction and verification

The unit regression fails on the previous code at the assertion that a track
must detect a routed via's local plane hole. It then passes with the patch in
both insertion orders. Other assertions cover removal on rip-up, fixed copper,
soft reference nets, own-net passage, domain/layer scope, via-specific DRU values
rather than track values, unrelated planes, thermal gaps, and minimum widths.
The synthetic dimensions in these tests are probes, not board requirements.

An independent native test,
`routed_vias_cut_reference_beyond_generic_plane_clearance`, runs on a 20 mm
four-layer geometry fixture. Its reference sample starts inside native GND fill;
after two OTHER vias are inserted, KiCad's own saved fill excludes the sample.
The point is outside the old generic clearance envelope. A remote control point
remains over reference copper. The test uses native zone refill and the pinned
IPC reader, rather than this patch's hole calculation. The isolated-via fixture
is geometry evidence, not a complete electrical acceptance board.

Validation on the rebased implementation commit
`d0c0207bfddf251027fe80923f6f69ff5275f888` (base `d7ea605`, including PR52's
separate rule-admission guard):

| Check | Result |
| --- | --- |
| Full macOS Rust suite | 919 passed, 2 existing ignores |
| Linux native geometry probe, pinned nightly | PASS, 14.46 s, actual KiCad execution |
| Frozen ENV-SENSE daemon job | `20261105-193405-0aa9c6`, PASS, one attempt, retries 0 |
| Native DRC / unconnected / parity | 0 / 0 / 0 |
| Fresh configured gate | PASS |
| Both existing board semantic hooks | PASS |
| ENV accepted output | 177 tracks, 20 vias, 262.0 mm; byte-identical to prior accepted fixture output |
| Owned operation stages | 4, all cleanup confirmed |
| Independent daemon status / container | passed, trimmed, container absent |

The native geometry probe uses a network-isolated container limited to two CPUs
and 4 GiB. The ENV proof uses two CPUs, 4 GiB and a 120-second daemon limit. Its
53.354-second operation is a correctness observation, not a speedup claim. Cargo
includes environment-guarded native tests; the separate Linux result above proves
that the new native probe actually ran. Full-board benchmarks stay on Hetzner;
the tiny regression fixture is a test, not a benchmark suite.

ENV-SENSE has no adjacent-plane rule, so its proof checks non-regression and the
complete acceptance path. The native four-layer probe and targeted regressions
establish the reference-hole behavior. This is not a claim that a new real
four-layer board has passed its complete gate.

## Artifact bindings

| Artifact | SHA-256 |
| --- | --- |
| Frozen ENV source PCB | `6abb00a0a30cd3f02d6e96a0cb326e16c1f050b735e5ed43770dcbf653844ae7` |
| ENV output PCB | `7c4dd481c5454a055da4b956124c984cae450a17547d81c3abe5092b31316da3` |
| Tested rebased Linux router | `e3bce471e6473fe1994ededae4eec6da806928bdbfcdbfd5edb43710fc7fce0b` |
| Full native evidence archive | `1975a821acca2e162bb9d8b03724d018f9edf182c485c9b055fe802e91faad4e` |

Evidence, before/after regression logs, full-suite logs and the tested binary are
retained in the session's durable `artifacts/router-plane-holes-1325/` directory.
The native archive includes both pre-rebase and rebased probe logs, job receipts,
full gate and semantic outputs, binary binding, and independent cleanup checks.
No production deployment or canonical candidate adoption is part of this PR.
GND copper preservation during partial reuse is a separate next fix.
