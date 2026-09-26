#!/usr/bin/env python3
"""Advisory reference-plane void check, using KiCadRoutingTools check_impedance.

KiCadRoutingTools (MIT, https://github.com/drandyhaas/KiCadRoutingTools) has
routers and placers; this wrapper calls ONLY its read-only check_impedance
analysis. It never runs a router, a placer, or any script that adds tracks
or vias, and it never writes back to the board.

check_impedance reports every place a trace's reference plane has a gap
("void") or a copper split ("split") under it. A void run under ~0.3 mm is
usually just an antipad and not worth a note; this wrapper keeps only void
crossings of 1.0 mm or longer (kind == "void"), one line per crossing,
grouped by net. Split crossings are a different mechanism (a plane cut, not
a void) and are never counted, no matter how long.

This check is advisory only: it always exits 0. Use it as a cross-check
against tools/si_planes.py, not as a pass/fail gate.

Usage:
  python3 tools/krt_planes_advisory.py BOARD.kicad_pcb [--min-length-mm 1.0]

Exit codes: 0 always (advisory), 2 on tool error (missing/unpinned clone,
missing venv, bad board path, or the analysis script itself failing).
"""
import argparse
import json
import os
import shutil
import subprocess
import sys
import tempfile

PINNED_COMMIT = "46c90458"
MIN_VOID_MM = 1.0


def resolve_krt_dir():
    return os.environ.get("KRT_DIR") or os.path.expanduser(
        "~/Documents/GitHub/KiCadRoutingTools"
    )


def check_pinned(krt_dir):
    """Return an error message if krt_dir is missing or not pinned, else None."""
    if not os.path.isdir(krt_dir):
        return (
            f"KiCadRoutingTools clone not found at {krt_dir}. "
            "Set KRT_DIR or clone it there."
        )
    try:
        out = subprocess.run(
            ["git", "-C", krt_dir, "rev-parse", "HEAD"],
            capture_output=True,
            text=True,
            check=True,
        ).stdout.strip()
    except (subprocess.CalledProcessError, OSError) as exc:
        return f"KiCadRoutingTools at {krt_dir} is not a git repository: {exc}"
    if not out.startswith(PINNED_COMMIT):
        return (
            f"KiCadRoutingTools at {krt_dir} is at commit {out[:12]}, "
            f"not the pinned commit {PINNED_COMMIT}."
        )
    return None


def venv_python(krt_dir):
    for name in ("python3", "python"):
        candidate = os.path.join(krt_dir, ".venv", "bin", name)
        if os.path.exists(candidate):
            return candidate
    return None


def run_check_impedance(krt_dir, board_pcb, out_path):
    """Run check_impedance.py (read-only) and return its parsed JSON report."""
    py = venv_python(krt_dir)
    if not py:
        raise RuntimeError(
            f"KiCadRoutingTools venv not found at {krt_dir}/.venv "
            "(needs numpy, scipy, shapely, Pillow)."
        )
    script = os.path.join(krt_dir, "py_tools", "check_impedance.py")
    cmd = [py, script, board_pcb, "--json", out_path, "--exit-zero"]
    proc = subprocess.run(cmd, capture_output=True, text=True)
    if not os.path.exists(out_path):
        raise RuntimeError(
            f"check_impedance.py produced no output (exit {proc.returncode}): "
            f"{proc.stderr.strip()[:500]}"
        )
    with open(out_path) as fh:
        return json.load(fh)


def void_crossings(report, min_length_mm=MIN_VOID_MM):
    """Pure: reference-plane void crossings >= min_length_mm, one dict per crossing.

    Split crossings (plane cuts) are never included, regardless of length;
    only kind == "void" (a gap in the plane) counts.
    """
    result = []
    for net in report.get("nets", []) or []:
        net_name = net.get("net_name")
        for c in net.get("crossing_detail", []) or []:
            if c.get("kind") != "void":
                continue
            if c.get("length_mm", 0) < min_length_mm:
                continue
            result.append({"net": net_name, **c})
    return result


def format_crossing(c):
    """Pure: one report line for a void crossing."""
    return (
        f"{c['net']}: {c['length_mm']:.3f} mm void at "
        f"({c.get('x')}, {c.get('y')}) {c.get('layer')} / {c.get('ref_layer')}"
    )


def main(argv=None):
    parser = argparse.ArgumentParser(
        description=(
            "Advisory cross-check for reference-plane voids under routed traces "
            "(KiCadRoutingTools check_impedance). Read-only; never routes or places."
        )
    )
    parser.add_argument("board", help="Path to a routed .kicad_pcb file")
    parser.add_argument("--min-length-mm", type=float, default=MIN_VOID_MM)
    args = parser.parse_args(argv)

    krt_dir = resolve_krt_dir()
    err = check_pinned(krt_dir)
    if err:
        print(f"ERROR: {err}", file=sys.stderr)
        return 2

    board = os.path.abspath(args.board)
    if not os.path.isfile(board):
        print(f"ERROR: {board} is not a file.", file=sys.stderr)
        return 2

    tmp_dir = tempfile.mkdtemp(prefix="krt_planes_advisory_")
    out_path = os.path.join(tmp_dir, "impedance.json")
    try:
        report = run_check_impedance(krt_dir, board, out_path)
    except (RuntimeError, json.JSONDecodeError) as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 2
    finally:
        shutil.rmtree(tmp_dir, ignore_errors=True)

    crossings = void_crossings(report, args.min_length_mm)
    for c in crossings:
        print(format_crossing(c))
    print(
        f"{len(crossings)} reference-plane void crossings >= "
        f"{args.min_length_mm:.1f} mm"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
