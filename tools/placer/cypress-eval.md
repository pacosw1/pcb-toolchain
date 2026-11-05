# NVlabs Cypress on RELAY-4 (evaluation, 2026-09-27)

Cypress: github.com/NVlabs/Cypress, Apache-2.0, commit 743b07c (2026-03-03). ISPD 2025 PCB placer on DREAMPlace.
All compute ran on Hetzner in containers named `iot-lab-cypress-*` (12 CPUs) and in `tools/remote.sh` route jobs.
No design went to an external service.

## 1. Build (CPU only)

The Cypress Dockerfile needs the NVIDIA PyTorch image (CUDA) and a private SSH clone. Thus I used a CPU Dockerfile:
`tools/placer/cypress/Dockerfile.cpu` (Python 3.9 bookworm, torch 1.10.0+cpu, torchvision 0.11.1+cpu, numpy < 1.24).

```sh
# on the box, in /srv/iot-lab-cypress: src/ = git clone --recursive --depth 1 https://github.com/NVlabs/Cypress.git
docker build --cpuset-cpus 0-11 -f Dockerfile.cpu -t iot-lab-cypress:cpu .
```

Build faults fixed (in this order): bullseye security mirror 404 (moved to bookworm); Boost graph/regex missing;
`libfl-dev` missing (FlexLexer.h); `torchvision` missing at run time. Build time about 10 min. Result: build OK.

The CPU path of Cypress is not maintained. Three run-time faults need a patch (`tools/placer/cypress/patch.py`,
applied by `run.sh` inside the container before each run):

1. `PlaceDB.update_side_info` indexes the movable-macro mask with fixed node ids: IndexError when the design has a
   fixed node. None of the 20 Cypress benchmarks has a fixed node (all `NumTerminals : 0`).
2. `ops/pin_pos`: the module calls the CPU function without `theta`, `h`, `w`; the CPU backward gets GPU-only
   arguments. The CPU C++ op has no rotation: **the CPU build cannot rotate parts.** Rotation stays off.
3. `ops/net_crossing`: the Python call passes `pin_side`; the CPU C++ op has no such argument (one-sided crossing).

## 2. Input format and conversion

Cypress reads Bookshelf only (`.aux .nodes .nets .pl .scl`). `pcb-util/kicad_converter.py` reads only its own
KiCad 7 dataset boards (FpPoly shapes, pads as points). Converter: `tools/placer/cypress_io.py` (test:
`test_cypress_io.py`). It reads a `cli.py read` problem, so the units, fixed parts, outline and keepouts are the
same as in benchmark B.

```sh
B=<bench dir>   # O3-RELAY-4/ (signal tracks stripped), relay-prob3.json (cli.py read), relay-scr3.json (scramble seed 7)
python3 tools/placer/cypress_io.py to-bs $B/relay-prob3.json $B/relay-scr3.json bs --name relay4
#   nodes 55 (terminals 8), die 1000 x 865  (0.1 mm grid; 47 movable units, 6 fixed units, 2 keepout boxes)
docker run --rm --name iot-lab-cypress-relay4 --cpus 12 -e OMP_NUM_THREADS=12 -v $PWD:/work iot-lab-cypress:cpu \
  sh /work/run.sh /work/relay4.json          # tools/placer/cypress/{run.sh,patch.py,relay4.json}
python3 tools/placer/cypress_io.py from-bs $B/relay-prob3.json bs/relay4.aux results/relay4/relay4.gp.pl -o res.json
python3 tools/placer/cli.py write $B/O3-RELAY-4/RELAY-4.kicad_pcb $B/relay-prob3.json res.json --outdir C09
```

Dry run (the scramble start pose through the same chain): pose error 1e-4 mm, HPWL 3117 (the same as the placer).

## 3. Rule gaps (what Cypress cannot express)

| Our rule | In Cypress |
|---|---|
| Board outline polygon | Rectangle (rows) only. RELAY-4 is a rectangle. |
| Keepout rule areas (holes) | Fixed rectangular blockage only (a circle becomes its box). |
| MAINS_K* 3.0 mm net-class clearance, 8 mm mains/SELV domain (.kicad_dru), 9.65 mm mains-to-hole rule | None. One uniform `macro_halo` for all nodes. |
| Edge anchors (`--edge`) | None. A part is fixed or free. |
| Rigid block with its own keepout rect | One node = the box of all rects; the concave free space is lost. |
| Kept copper (FIELD_GND tracks/vias) | None. |
| Pad clearance rects, courtyard shapes | Node box only. |
| Rotation | GPU only (see 1.2). Off on this box. |

## 4. Run and legality

`relay4.json`: 1 stage, 1000 iterations, Nesterov, weighted-average WL, density weight 8e-3, gamma 0.132,
macro halo 2 (0.2 mm), `random_center_init_flag 0` (starts from the scramble), seed 1000.
The first config (bins 256, stop_overflow 0.07, net_crossing_weight 0) diverged to NaN at iteration 211 and
Cypress skipped legalization ("placement failed"). A sweep of 36 configs (learning rate 2.5e-4 / 1e-3 / 1e-2,
bins 64 / 128 / 256, stop_overflow 0.07 / 0.15, net_crossing_weight 0 / 1e-4; about 3 s each) gave 9 NaN failures.
I took the config with the lowest Cypress HPWL (its own metric, not a routing result): #09 = lr 2.5e-4, bins 256,
stop_overflow 0.07, net_crossing_weight 1e-4. Cypress HPWL 796 mm (pin centres), 257 iterations, 0.1 s legalization.

| Placement | Our HPWL (proxy) | Units illegal (our rules) | Node-box overlaps | DRC errors before routing |
|---|---|---|---|---|
| S scramble start | 3117 | 41 | - | 950 |
| Cypress #09 | 877 | 9 | 0 | 363 (clearance 179, mask bridge 130, hole clearance 32, thermal 20, creepage 2) |
| P placer v3 | 1233 | 0 | - | 316 |
| O original | 1109 | 0 | - | 0-1 after routing |

## 5. Routing score (benchmark B v3 set-up)

Signal tracks stripped, FIELD_GND copper kept, FIELD_GND pad vias (`GNDVIAS=1`), 5 Freerouting runs of 3.5 min,
a score job (removed 2026-11-05) through `tools/remote.sh` (3 + 2 jobs, 4 CPUs each). O, S and P are from bench v3.

| Board | Unrouted per run | Median | Signal subset | DRC errors after routing |
|---|---|---|---|---|
| O original | 8 / 6 / 8 / 7 / 8 | 8 | 6-8 | 0 |
| S scramble | 139 / 138 / 129 / 133 / 130 | 133 | 108-119 | 2-14 |
| P placer v3 | 147 / 141 / 142 / 141 / 152 | 142 | 113-124 | 3-10 |
| Cypress #09 | 39 / 36 / 38 / 35 / 40 | 38 | 35-40 | 26 each (clearance 24, creepage 2) |

Runs 4 and 5 were stopped by a SIGTERM from outside the job (18:43) and ran again at 18:46 with the same inputs.
The open connections of Cypress are on 24V_SW (11), 24V_IN (4-6), MAINS_* and COIL* nets. The 26 errors after
routing are the same in all runs: they come from the placement (mains clearance and creepage), not from the router.

## 6. Result

- Cypress (CPU, no rotation, 3 patches) gets RELAY-4 from 142 (our placer v3, median) to 38 unrouted, from the
  same scrambled start. It is still far from O (8). Its HPWL (877) is lower than O (1109): it packs too tightly for
  the mains rules.
- It does not know our rules. After Cypress, 9 units are illegal under our rules. The routed board has 24
  clearance and 2 creepage errors in all 5 runs. A Cypress placement cannot be used on a board without our legalizer.
- Its crossing term was not the cause of the gain: net_crossing_weight 0 and 1e-4 gave similar HPWL in the sweep.
  The gain comes from the analytical global placement (wirelength + density, Nesterov), which moves all parts at once.
- Recommendation: use Cypress as a baseline and as a global-placement seed. Next experiment: Cypress pose ->
  our legalizer (domain gaps, keepouts, edge anchors) -> short low-temperature anneal -> the same 5-run score.
  Do not import its code: the CPU path needs patches, rotation needs CUDA, and the input is Bookshelf only.
