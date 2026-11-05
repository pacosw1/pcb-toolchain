# Verified block reuse

`tools/blocks.ts` uses existing discovery and native binding tools. Qualification
is an executable evidence check, recorded separately from CAD and `facts.json`.

| Derived level | Required evidence | Scope |
| --- | --- | --- |
| 0, draft | Discovery, native inventory, binding, or a stale receipt | No qualification |
| 1, gate verified | Exact native binding; successful source ERC/DRC/parity; fresh target board gate; complete sourced applicability and parts reviews | One block revision in one exact target instance |
| 2, bench validated | Level 1 plus attributed raw measurements against an approved, sourced bench plan | The recorded hardware serial and measured conditions/tests |

Historical `facts.level` remains a declaration. It cannot grant either derived
level. Receipts do not approve copper reuse, another board, modified placement,
different parts, manufacturing release, purchasing, or unmeasured operating ranges.

## Commands

These commands are also callable through the `pcb blocks` command family.

```sh
node --experimental-strip-types tools/blocks.ts inventory BASE-PWR
node --experimental-strip-types tools/blocks.ts inventory ENV-SENSE
node --experimental-strip-types tools/blocks.ts find 'power switch'
node --experimental-strip-types tools/blocks.ts reuse BLOCK
node --experimental-strip-types tools/blocks.ts bind BLOCK path/to/target.kicad_pcb --instance /SHEET_UUID > .gate/binding.json
node --experimental-strip-types tools/blocks.ts native BLOCK --output .gate/block-native/NEW-RUN
tools/pcb check BOARD --fresh --detach --json
node --experimental-strip-types tools/blocks.ts qualify BLOCK --binding .gate/binding.json --evidence .gate/block-evidence.json --output .gate/qualification.json
node --experimental-strip-types tools/blocks.ts status .gate/qualification.json
node --experimental-strip-types tools/blocks.ts reuse BLOCK --receipt .gate/qualification.json
```

Create parent directories before shell redirection. The example identifiers and
paths are placeholders. `native` requires a new output directory outside the
block source. It uses `KICAD_CLI` or the standard macOS KiCad executable. Its
default total deadline is 600 seconds, override with `--timeout`. It prints stage
starts and honest liveness to stderr, retains native JSON and logs, and owns its
process family for timeout/interruption cleanup. Its JSON result names the exact
source hash, executable hash/version, commands, exits, and cleanup results.

The target run must have finished successfully with confirmed cleanup. Required
native and electrical checks must all be enabled and complete. Its full native
input provenance and ERC/DRC artifacts must still match. A fresh run, including
explicit `--fresh`, is eligible; incremental cache hits, ratchets, alternate
configuration, and tracked-metrics write modes cannot qualify a block.

`status` returns level 0 when source, native binding, target, an evidence file,
or the verifier changes. A dependency previously recorded as missing appearing
also invalidates the receipt. `reuse --receipt` verifies the receipt and reports
its exact target scope. Ordinary discovery remains unqualified.

## Applicability evidence

`--evidence` is an attributed review manifest with this shape. Paths resolve
relative to the manifest; artifacts require the SHA-256 of their original bytes.
`binding_sha256` is `fingerprint(binding)` of `lib/fingerprint.ts`, SHA-256 of JSON
with sorted keys and compact separators, not the pretty-printed file hash.

```json
{
  "schema": "iot-lab.block-evidence.v1",
  "binding_sha256": "SHA256_OF_CANONICAL_BINDING",
  "source_native": "block-native/NEW-RUN/result.json",
  "target_run": "cli/run-EXACT",
  "external_roots": {
    "kicad": "/Applications/KiCad/KiCad.app/Contents/SharedSupport"
  },
  "unsupported": [],
  "reviews": {
    "operating_limits": {
      "VIN": {
        "target_conditions": "Actual voltage, load, transients, temperature and domain",
        "verdict": "pass",
        "reviewer": "Responsible reviewer",
        "reviewed_at": "2026-10-15T12:00:00Z",
        "evidence": {"path": "review.md", "sha256": "SHA256", "locator": "VIN applicability"}
      }
    },
    "layout_rules": {
      "0": {
        "verdict": "pass",
        "reviewer": "Responsible reviewer",
        "reviewed_at": "2026-10-15T12:00:00Z",
        "evidence": {"path": "review.md", "sha256": "SHA256", "locator": "Layout rule 0"}
      }
    },
    "stackup_and_rules": {"verdict": "pass", "reviewer": "Reviewer", "reviewed_at": "2026-10-15T12:00:00Z", "evidence": {"path": "review.md", "sha256": "SHA256", "locator": "Stackup"}},
    "boundary_and_returns": {"verdict": "pass", "reviewer": "Reviewer", "reviewed_at": "2026-10-15T12:00:00Z", "evidence": {"path": "review.md", "sha256": "SHA256", "locator": "Boundary copper, keepouts and returns"}},
    "ground_and_isolation": {"verdict": "pass", "reviewer": "Reviewer", "reviewed_at": "2026-10-15T12:00:00Z", "evidence": {"path": "review.md", "sha256": "SHA256", "locator": "Ground and isolation domains"}},
    "open_items": {}
  },
  "parts": {
    "U1": {
      "mpn": "EXACT_MPN",
      "lcsc": "C123",
      "datasheet": {"path": "manufacturer.pdf", "sha256": "SHA256"},
      "jlc_assembly": {"path": "C123.api.json", "sha256": "SHA256"},
      "pinout_and_land_pattern": {"verdict": "pass", "reviewer": "Reviewer", "reviewed_at": "2026-10-15T12:00:00Z", "evidence": {"path": "review.md", "sha256": "SHA256", "locator": "Exact pinout, ratings and land pattern"}}
    }
  }
}
```

Cover every block port with explicit target conditions and every layout rule by
zero-based index. Include attributed resolution of every declared open item.
The exact native pad/net/part/footprint/side mapping is checked by the existing
binding verifier; reviewer text cannot bypass an identity or rigid-placement
mismatch. Unsupported requirements fail qualification.

Each native source reference needs exact MPN/LCSC evidence, a manufacturer
datasheet with its intact `.source.json` hash/URL/fetch timestamp, a dated JLCPCB
assembly catalog/API snapshot with matching MPN/C-number and positive stock,
and a sourced pinout/land-pattern/ratings review. LCSC shop stock alone fails.
Stock is dated evidence and is not reserved; recheck it at review/layout/order
gates. Every review requires a timestamp with timezone, a reviewer, a pass
verdict, and an artifact with an exact page/section/record locator.

Supply `external_roots` for every `external/NAME/...` entry present in the target
gate provenance, including configuration or pinned-tool repositories as needed.
The verifier hashes the actual current files at those roots.

## Bench evidence

Pass `--bench MEASURED.json` only when actual assembled hardware was measured.
The applicability manifest must contain `bench_plan: {"path": "plan.json",
"sha256": "..."}`. The plan requires schema `iot-lab.block-bench-plan.v1`, the
exact `binding_sha256`, `approved_by`, `approved_at`, and distinct `tests`.
Each test requires `id`, `requirement`, `unit`, numeric `min`/`max`, and a
`source` artifact with its criterion's locator. Limits come from that source.

The measurement record requires schema `iot-lab.block-bench.v1`, exact
`binding_sha256`, `operator`, `measured_at`, `board_serial`, `instruments`, and
`raw_data`. Each instrument has a unique `id` and sourced
`calibration_evidence`; `raw_data` is a hashed CSV artifact with columns:

```text
test_id,value,unit,instrument_id
```

The raw data must cover all approved tests exactly once, use the named
instruments and units, contain finite values within sourced limits, and follow
plan approval. Missing, failed, changed or unattributed measurements cannot
produce level 2. Automated fixtures use synthetic data clearly marked as
fixtures; no repository board has been promoted by those tests.

## Ship-set inventory, 2026-10-15

Read-only `inventory` inspected native PCB paths and hierarchical schematic
sheet UUIDs/files on the frozen projects in their `gate.json` configurations.
It did not infer reuse from matching values, MPNs or visual appearance.

| Board/native instance | Native sheet reference | Current-library binding |
| --- | --- | --- |
| BASE-PWR `/00da59b5-2f1a-5a9c-b489-0835371d10ee` | PSW-SLOT3V3, `blocks/PSW-TPS2553.kicad_sch` | Symbol identities differ |
| BASE-PWR `/268591dd-cc71-48bc-af66-8eeab66e9ae4` | PSW-VBUS, same native sheet file | Symbol identities differ |
| BASE-PWR `/2765d315-e432-503f-8778-b127d46b274e` | PSW-QWIIC, same native sheet file | Symbol identities differ |
| BASE-PWR `/f5b59328-6ee0-5bd5-b1fa-4edd1907b53b` | PSW-CHG5V, same native sheet file | Symbol identities differ |
| BASE-PWR `/9f22f7f0-8ab8-506b-8a39-b9cd36f710eb` | IF-RS485, `blocks/IF-RS485.kicad_sch` | Symbol identities differ |
| BASE-PWR `/61aa36b0-2329-5115-a126-92dbeaf3a945` | IF-BKP-LINK-ESD, `blocks/IF-BKP-LINK-ESD.kicad_sch` | Exact symbol identities match; target placement is no longer rigid |
| ENV-SENSE | Flat native footprint paths | No authoritative reused block instance |

Inspected PCB SHA-256 values: BASE-PWR
`9ad6ca309673271353064d83e0f2ce46018e3e2219df1402257197685bad1976`;
ENV-SENSE `b4bb4a9d759a5d6b9425127ca1a378b48f97e2c8b0b69cf0fa4d221bf2bce0f4`.
The executable inventory records native sheet and configuration hashes too.
These are identity/qualification gaps, not claims that the frozen board fails
its release gate. All block facts and board CAD remain unchanged. No gate or
bench level is granted by this inventory.

Verification: `node --experimental-strip-types --no-warnings --test tools/lib/block-qualification.test.ts
tools/lib/block-reuse.test.ts tools/lib/block-bindings.test.ts`. Fixtures cover native binding
rejection, complete qualification, receipt freshness, source changes, missing
reviews/artifacts, unsupported requirements, cache rejection, owned native
invocation and attributed bench data.
