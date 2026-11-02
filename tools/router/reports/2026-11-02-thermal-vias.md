# Thermal via arrays in exposed pads (2026-11-02)

Branch `claude/router-thermal-vias` (from main 24469ea8). Result: **PASS**.

## 1. Need

FW-IO layout review 2026-11-02 row L4: the LM5164 (U4) exposed pad got 1 router via. LM5164 SNVSAU4A section 10.1
items 4 and 10 (p.23) ask for "an array of heat-sinking vias" from the exposed pad to the inner ground planes. The
router placed one via per pad on the gate viapads allow list (core v6 `fixed_vip_vias`).

## 2. Design

Input: optional board file `thermal-vias.json`:

```json
{"pads": {"U4.9": {"long": 2, "short": 2, "pitch_long": 1.27, "pitch_short": 1.10,
                   "drill": 0.3, "diameter": 0.6, "source": "..."}}}
```

- `long` / `short`: vias along the pad's long / short side. The array is centred on the pad. This form does not
  depend on the footprint rotation.
- model.py `thermal_via_spec` refuses (SystemExit, nothing guessed) when:
  - a key or the source is missing;
  - the pad is not an SMD pad of a plane net;
  - the pad is not on gate.json `viapads.allow` (the gate would fail each via);
  - the pad rotation is not a multiple of 90 degrees, or the pad has an offset;
  - drill, diameter or annular ring is below the board setup, the net class via or the DRU via rules of the net;
  - pitch minus drill is below the hole-to-hole rule (board minimum and DRU rules with no condition);
  - a via disc is not inside the pad copper (KiCad `PAD::HitTest`, 32 rim points).
- Output: pad `thermal_vias` {vias (exact centres), d, drill, long, short, pitch, source}. With no file, the model
  is byte-identical to main (checked on NET-CORE, INPUT-4D2A and FW-IO with the file removed).
- Core: `fixed_vip_vias` places each spec via at its exact place, before routing. The via is fixed copper of the
  pad's net (owner -1, after `base0`, so it goes into route.json with role `plane`):
  - The memoized fixed-copper verdicts, the audit, hole-to-hole and the pour model (`pour.rs` reads every live
    shape) see it as any fixed via. It blocks other nets as any via does.
  - Each via is a GND return site (`gnd_fixed`).
  - A spec via that the fixed copper does not allow stays a note ("thermal vias: ... (input)"). It is never moved.
  - The plane fan-out finds the vias in the allowed pad and adds no via.
- Gate: no change. `tools/pcbtool.py viapads` accepts any number of vias in an allowed pad.

## 3. FW-IO U4.9 numbers (thermal-vias.json `source`)

- Count: Figure 28, p.25 ("Thermal vias under LM5164 PAD") shows a 2 x 4 via grid under the package. 2 x 2 of these
  vias are inside the EP copper. The outer two columns are in the top-side pour next to the EP, not in the pad, and
  this feature does not place them.
- Pitch: scaled from the figure raster (`pdfimages`, 1004 x 721 px). Scale reference: the 1.27 mm pin pitch, which is
  36.3 px.
  - Long side: 37.0 px. The vias sit on the pin columns, so the pitch is 1.27 mm.
  - Short side: 31.5 px = 1.10 mm.
  - Cross-check: the EP in the figure is 88 x 69 px = 3.08 x 2.41 mm (footprint EP 3.2 x 2.5 mm).
- Drill / diameter: the datasheet gives no dimensions. We used the board standard via, 0.3 / 0.6 mm (GND is in
  net class PWR; Default is the same). This meets the JLC standard via.
- Fit check:
  - The via edges are 0.93 mm (long side) and 0.85 mm (short side) from the EP centre. The EP half sizes are 1.6 mm
    and 1.25 mm.
  - Hole gap 0.80 mm. The DRU hole-to-hole minimum is 0.25 mm.
- AP63203 (U2): TSOT26, no exposed pad (AP63203.pdf p.1). No entry.

## 4. Results

Commands: `run.py BOARD OUT --lock-from <committed board>`. Gate = `node tools/gate.mjs BOARD --fresh` in a clean
24469ea8 worktree with the routed board copied in. Core binary sources sha256 bbbe3f8e (final sources).

| Board | run.py | Vias in U4.9 | Gate --fresh |
| --- | --- | --- | --- |
| FW-IO with thermal-vias.json | PASS 0 / 0 / 0, 673 tracks, 150 vias, 1248.6 mm, converged it 8, 71-74 s | 4 at (171.285 / 172.385, 134.03 / 135.30), 0.6 / 0.3: equals the spec. GND vias within 2.0 mm of the EP centre: 4 (review: 1) | PASS, all counts 0 |
| FW-IO without the file | PASS 0 / 0 / 0, 673 tracks, 147 vias, 1248.6 mm | 1 (EP centre, as main) | not run (= main) |
| NET-CORE (committed hand placement) | PASS 0 / 0 / 0, 264 vias | no spec | PASS, all counts 0 |
| INPUT-4D2A | PASS 0 / 0 / 0, 156 vias | no spec | kicad_happy 10 = the 10 committed RP-001 exemptions STALE (findings 0, as on main, reports/2026-11-02-ref-gate-scope.md); with an empty exemption file: PASS |

- FW-IO with and without the file: the track lists are byte-identical. The only difference is the 4 array vias
  against the 1 centre via. Two runs with the file gave a byte-identical route.json and board.
- No regression: the main binary (sources 0c9ca75e) on the model.json of each branch run gives a byte-identical
  route.json for NET-CORE, INPUT-4D2A and FW-IO without the file.
- Tests:
  - cargo: 82 pass. New: `tests_v4::thermal_via_array_is_fixed_copper_of_the_pad_net` and
    `tests_model::thermal_vias_are_read`.
  - Python (KiCad Python, test_model / test_run / test_pairrules / test_iso_board): 48 pass. New: `ThermalVias`, 3
    tests (array orientation and centring, no file means no key, 6 refusals).

## 5. Open items (not changed here)

- Order step (G5): the 4 vias are in an SMD paste pad. Choose at order time: tented, or JLC epoxy-filled and capped
  (POFV). Open vias wick solder from the EP. No fab setting is changed here.
- Figure 28 also has 2 x 2 vias next to the EP in the top pour (outside the pad). They are GND stitching, not pad
  vias. The router places them only when a requirement names them.
- The committed FW-IO board still has 1 EP via. This task does not change committed board files. A re-route of FW-IO
  with this branch gives the 4-via board.
