#!/usr/bin/env python3
"""The search tests moved to tools/placer/core/tests/search.rs. Kept here: the problem test_placement_audit.py imports."""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from placer.test_cost import problem, square_board, unit  # noqa: E402


def two_units():
    # A fixed 1 x 1 at (5, 5); B 1 x 1 far away; one net between the centers.
    # Optimum: B next to A at the 0.5 mm gap, HPWL 1.5.
    return problem([unit('A', 5, 5, [[-.5, -.5, .5, .5, .5]], fixed=True),
                    unit('B', 15, 15, [[-.5, -.5, .5, .5, .5]])],
                   [{'name': 'N', 'weight': 1.0, 'pins': [[0, 0, 0, 0, 0], [1, 0, 0, 0, 0]]}],
                   board=square_board(20, edge=1.0))
