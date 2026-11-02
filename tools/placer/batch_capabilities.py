"""Torch-independent, fail-closed objective/schedule checks for batch placement.

Optional device availability never permits dropping a scalar objective term.
Cost evaluation is schedule-independent; search is geometric only.
"""


def check_cost(problem, params):
    for key in ('w_x', 'w_row', 'pin_demand', 'w_esc', 'esc_hard', 'w_mst'):
        if params.get(key):
            raise ValueError('batch: %s = %s is not supported (use the scalar path)' % (key, params[key]))
    if any(u.get('in_box') for u in problem.get('units', ())):
        raise ValueError('batch: region boxes (in_box, cli.py read --in-box) are not supported (use the scalar path)')
    if problem.get('via_nets'):
        raise ValueError('batch: via nets (via room term) are not supported (use the scalar path)')


def check_search(problem, params):
    check_cost(problem, params)
    if params.get('max_displacement'):
        raise ValueError('batch: cumulative displacement caps are not supported (use the scalar path)')
    if params.get('schedule', 'geometric') != 'geometric':
        raise ValueError('batch: only the geometric schedule is supported (use the scalar path)')
