#!/usr/bin/env python3
"""Write the physical stackup into a board file (KiCad Board Setup > Physical Stackup), as text.

  python3 tools/set_stackup.py BOARD.kicad_pcb [--outer-prepreg 0.2104] [--thickness 1.6]
  python3 tools/set_stackup.py BOARD.kicad_pcb --dielectrics 0.2104,0.4,0.2028,0.4,0.2104
        explicit dielectric thicknesses from the top (one per gap): prepreg / core alternate from the outside (outer
        ones JLC 7628 prepreg Er 4.4, cores FR4 Er 4.6, inner prepregs 7628 Er 4.4), e.g. JLC06161H-7628 (D-142).

The copper layer count comes from the (layers ...) list of the board. Dielectrics alternate prepreg / core from the
outside: the two outer ones are JLC 7628 prepreg (--outer-prepreg, Er 4.4, as JLC04161H-7628 and the 7628 6-layer
build); the inner ones share the rest of --thickness. Copper 0.035 mm outer, 0.0152 mm inner; mask 0.01 mm.
kicad-happy (GP-001, RP-001) reads the reference layer of each signal layer from this list. With no list, or with a
4-layer list on a 6-layer board, it takes the wrong layer as the reference and reports false plane gaps.
CONFIRM the dielectric thicknesses with the stackup that JLCPCB shows for the order before an impedance claim.
The pcbnew Python API in KiCad 10.0.6 does not expose BOARD_STACKUP, so the file is edited as text.
"""
import argparse
import re


def block(names, outer_pp, thickness, dielectrics=None):
    n = len(names)
    cu = [0.035 if i in (0, n - 1) else 0.0152 for i in range(n)]
    if dielectrics is not None:
        if len(dielectrics) != n - 1:
            raise ValueError(f'{len(dielectrics)} dielectrics for {n} copper layers (need {n - 1})')
        diel = []
        for k, th in enumerate(dielectrics):
            core = k % 2 == 1          # from the outside: prepreg, core, prepreg, ...
            diel.append((th, 'core', 'FR4', 4.6) if core else (th, 'prepreg', '7628', 4.4))
        return _text(names, cu, diel), diel
    inner_count = n - 3
    rest = thickness - sum(cu) - 0.02 - 2 * outer_pp
    inner_t = round(rest / inner_count, 4) if inner_count > 0 else 0
    if n == 2:
        diel = [(round(thickness - sum(cu) - 0.02, 4), 'core', 'FR4', 4.6)]
    else:
        diel = []
        for k in range(n - 1):
            if k in (0, n - 2):
                diel.append((outer_pp, 'prepreg', '7628', 4.4))
            else:
                diel.append((inner_t, 'core' if k % 2 else 'prepreg', 'FR4', 4.6))
    return _text(names, cu, diel), diel


def _text(names, cu, diel):
    n = len(names)
    out = ['\t\t(stackup',
           '\t\t\t(layer "F.SilkS"\n\t\t\t\t(type "Top Silk Screen")\n\t\t\t)',
           '\t\t\t(layer "F.Paste"\n\t\t\t\t(type "Top Solder Paste")\n\t\t\t)',
           '\t\t\t(layer "F.Mask"\n\t\t\t\t(type "Top Solder Mask")\n\t\t\t\t(thickness 0.01)\n\t\t\t\t(material "LPI")\n\t\t\t\t(epsilon_r 3.8)\n\t\t\t\t(loss_tangent 0)\n\t\t\t)']
    for i, name in enumerate(names):
        out.append(f'\t\t\t(layer "{name}"\n\t\t\t\t(type "copper")\n\t\t\t\t(thickness {cu[i]})\n\t\t\t)')
        if i < n - 1:
            t, kind, mat, er = diel[i]
            out.append(f'\t\t\t(layer "dielectric {i + 1}"\n\t\t\t\t(type "{kind}")\n\t\t\t\t(thickness {t})\n'
                       f'\t\t\t\t(material "{mat}")\n\t\t\t\t(epsilon_r {er})\n\t\t\t\t(loss_tangent 0.02)\n\t\t\t)')
    out += ['\t\t\t(layer "B.Mask"\n\t\t\t\t(type "Bottom Solder Mask")\n\t\t\t\t(thickness 0.01)\n\t\t\t\t(material "LPI")\n\t\t\t\t(epsilon_r 3.8)\n\t\t\t\t(loss_tangent 0)\n\t\t\t)',
            '\t\t\t(layer "B.Paste"\n\t\t\t\t(type "Bottom Solder Paste")\n\t\t\t)',
            '\t\t\t(layer "B.SilkS"\n\t\t\t\t(type "Bottom Silk Screen")\n\t\t\t)',
            '\t\t\t(copper_finish "ENIG")\n\t\t\t(dielectric_constraints no)', '\t\t)']
    return '\n'.join(out)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('board')
    ap.add_argument('--outer-prepreg', type=float, default=0.2104)
    ap.add_argument('--thickness', type=float, default=1.6)
    ap.add_argument('--dielectrics', default='', help='comma list of dielectric thicknesses (mm) from the top')
    a = ap.parse_args()
    s = open(a.board).read()
    layers = s[s.index('\n\t(layers'):s.index('\n\t)', s.index('\n\t(layers'))]
    names = re.findall(r'"((?:F|B|In\d+)\.Cu)"\s+(?:signal|power|mixed|jumper)', layers)
    order = {'F.Cu': -1, 'B.Cu': 99}
    names.sort(key=lambda x: order.get(x, int(x[2:-3]) if x.startswith('In') else 0))
    dl = [float(x) for x in a.dielectrics.split(',')] if a.dielectrics else None
    text, diel = block(names, a.outer_prepreg, a.thickness, dl)
    if '\n\t\t(stackup' in s:
        i = s.index('\n\t\t(stackup')
        depth, j = 0, i + 1
        while True:
            c = s[j]
            depth += (c == '(') - (c == ')')
            j += 1
            if depth == 0:
                break
        s = s[:i + 1] + text.lstrip('\n') + s[j:]
    else:
        k = s.index('\n\t(setup') + len('\n\t(setup')
        s = s[:k] + '\n' + text + s[k:]
    open(a.board, 'w').write(s)
    print(f'set_stackup: {len(names)} copper layers {" ".join(names)}; dielectrics (mm): '
          + ' '.join(f'{t}' for t, *_ in diel))


if __name__ == '__main__':
    main()
