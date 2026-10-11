# Reuse existing blocks before generating another layout

CIP #833, first implementation slice. The library already contains 20 native KiCad
blocks (all declare level 0 at the inspected revision), schematic/PCB extraction,
a viewer, and rigid placement/copper support. This adds retrieval and a review
dossier; it does not insert a block into a board or promote its validation level.

```sh
python3 tools/blocks.py find 'USB'
python3 tools/blocks.py find 'buck' --mpn AP63203WU-7
python3 tools/blocks.py reuse BUCK-3V3-AP63203 > proposal.json
python3 tools/blocks.py reuse BUCK-3V3-AP63203 --expect-sha256 HASH_FROM_PROPOSAL
```

Search returns why each candidate matched. MPN and footprint filters are exact;
text search also finds references in port notes, so a hit is not a part selection.
Reuse exports actual parts/footprints, port limits, sourced layout rules, unresolved
issues and historical gate notes. It fingerprints local CAD, rules, metadata and
library tables, ignoring GUI state. A changed source rejects an expected fingerprint.
Referenced external libraries/datasheets are not covered by that local fingerprint;
check those dependencies before target validation. Native KiCad remains authoritative.

For each reuse, review the dossier against target operating requirements, pin/net
mapping, stackup, layer mapping, isolation, returns, keepouts and mating access.
Retain the intended internal geometry, but verify boundary connections and shared
return paths in the assembled target. Run target electrical and native gates.
Historical success, library level and matching MPNs do not authorize target acceptance.
The next slice should bind a reviewed target mapping and evidence to this proposal
before integrating automatic insertion; no new generic CAD importer is needed yet.

## Small ML tasks and available data

`block-reuse-data.json` pins inspected public sources and representative records.
EasyGerber has 287 metadata records at that revision, but only 279 matching raw
PCB files and five raw schematics. PCBench's tree has 1,182 metadata paths while
its README describes 164 boards. Neither count is a clean, independent sample count.
The sampled PoE revisions have missing original file paths and no source commit;
keep those unknown instead of manufacturing provenance. Metadata licenses are claims
to verify against original design files, not an automatic corpus approval.

Use the existing block library as a reviewed seed vocabulary, not 20 independent
positive performance labels. Start with one narrowly useful task:

| Task | Input and label | Cheapest baseline | Adoption evidence |
|---|---|---|---|
| Block retrieval reranker | Query/parts/net neighborhood; reviewed relevant/irrelevant pair | Current token + exact-part search | Better held-out retrieval with fewer review steps |
| Circuit-role classifier | Pin/net graph and part attributes; reviewed power/protection/interface role | Keyword/part-family rules, then a small linear/tree model | Precision/recall by role on unseen design families; abstain on uncertain cases |
| Repair-action ranker | Recorded blocker/escape diagnostics; measured outcome of local repair | Existing deterministic diagnosis | Less total time to qualified board, including feature/inference cost |

Finished board geometry is useful for representation and retrieval, but does not
label whether a different placement or repair works. Collect those outcome labels
from normal #833 runs, including failures, explicit unknowns and timeouts. Never
label an unobserved net closed. Fix #824 augmentation/label defects before reusing
the old surrogate pipeline. No model is trained or enabled by these commands.

Before training, validate each source's raw CAD and constraints, resolve provenance,
deduplicate forks/revisions and split by design family (PoE M and M1 stay together).
Keep validation separate from the final test set. Start with a small reviewed slice;
expand only when its learning curve shows that more data can improve the decision.
Public designs with missing rules are not examples of electrically qualified routing.

Verification: `python3 tools/test_block_reuse.py` and `python3 tools/test_blocks.py`.
