"""RP-001 scope of the gate: the nets whose layer changes the gate never checks for a return via.

The router applies the RP-001 return-via obligation in exactly the scope of the gate (tools/kicad_happy_gate.py + the
pinned kicad-happy a6bba1a), never stricter (lead decision 2026-11-02). The gate drops a net from RP-001 in two places,
both by net name (plus the schematic power rails):

1. kicad-happy skills/kicad/scripts/analyze_pcb.py analyze_layer_transitions (line 3925): a net with
   `is_power_net_name(name, power_rails) or is_ground_name(name)` gets no layer_transitions entry
   (kicad_utils.py lines 1052 and 1135). power_rails = the schematic power rails (analyze_pcb.py lines 6567-6574,
   `_power_rails_from_schematic`: statistics.power_rails of analyze_schematic.py), because the gate passes the
   schematic (tools/kicad_happy_gate.py run_gate, lines 407-429; resolve_board, line 87, picks <board>.kicad_sch).
2. kicad-happy skills/emc/scripts/emc_rules.py check_layer_transition_stitching (lines 3898-3901): a transition whose
   net has `_is_power_or_ground(net_name)` (line 65) is skipped.

This script runs those functions of the pinned clone itself (no copied list). kicad-happy needs Python 3.10+, the KiCad
Python is 3.9, so iotroute model runs this file with env PYTHON_MODERN, else python3, as the gate does.

Usage: python3.1x rpscope.py BOARD.kicad_pcb < names.json  ->  JSON {"schematic", "power_rails", "skip"} on stdout.
"""
import json
import os
import sys
import tempfile

TOOLS = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def main(argv):
    pcb = argv[1]
    names = json.load(sys.stdin)
    sys.path.insert(0, TOOLS)
    import kicad_happy_gate as khg
    happy = khg.resolve_happy_dir()
    err = khg.check_pinned(happy)
    if err:
        raise SystemExit(err)
    _, sch = khg.resolve_board(pcb)
    rails = set()
    if sch:
        with tempfile.TemporaryDirectory() as d:
            doc = khg.run_analyzer(happy, 'skills/kicad/scripts/analyze_schematic.py', [sch], os.path.join(d, 'sch.json'))
        rails = {r['name'] for r in (doc.get('statistics') or {}).get('power_rails', []) if isinstance(r, dict) and r.get('name')}
    sys.path.insert(0, os.path.join(happy, 'skills', 'kicad', 'scripts'))
    sys.path.insert(0, os.path.join(happy, 'skills', 'emc', 'scripts'))
    import kicad_utils
    import emc_rules
    skip = sorted(n for n in names if kicad_utils.is_power_net_name(n, rails or None) or kicad_utils.is_ground_name(n)
                  or emc_rules._is_power_or_ground(n))
    json.dump({'schematic': sch, 'power_rails': sorted(rails), 'skip': skip}, sys.stdout)
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv))
