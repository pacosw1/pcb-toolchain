#!/usr/bin/env python3
"""Gate a board on a fixed set of kicad-happy rule IDs.

kicad-happy (MIT, https://github.com/aklofas/kicad-happy) is a schematic /
PCB / EMC analyzer. Its scripts exit 0 even on internal errors, so this
wrapper checks their JSON output itself and turns matching findings into a
non-zero exit code.

It runs three pinned kicad-happy scripts, in this order:
  1. analyze_schematic.py  -- needed for UC-001 (VBUS decoupling), which is
     schematic-only and never appears in the PCB or EMC output.
  2. analyze_pcb.py --full -- needed for VP-001 (via in pad) and to feed
     return-path data to the EMC analyzer.
  3. analyze_emc.py        -- needed for GP-001 (ground-plane coverage) and
     RP-001 (return-path via at a layer change).
Findings from all three are merged, then filtered to the allowed rule IDs.
Every other kicad-happy rule (KO-001, SU-001, VM-001, PM-002, CC-002,
XT-001, ...) is ignored: those were evaluated and found false on our boards.

Usage:
  python3 tools/kicad_happy_gate.py BOARD_DIR_OR_PCB \\
      [--rules GP-001,RP-001,VP-001,DC-002,UC-001] [--min-severity warning]

Exit codes: 0 no matching findings, 1 one or more matching findings,
2 tool error (missing/unpinned clone, bad board path, analyzer crash).
"""
import argparse
import json
import os
import shutil
import subprocess
import sys
import tempfile

PINNED_COMMIT = "a6bba1a"
DEFAULT_RULES = ["GP-001", "RP-001", "VP-001", "DC-002", "UC-001"]
SEVERITY_ORDER = ["info", "warning", "error", "critical"]


def resolve_happy_dir():
    return os.environ.get("KICAD_HAPPY_DIR") or os.path.expanduser(
        "~/Documents/GitHub/kicad-happy"
    )


def check_pinned(happy_dir):
    """Return an error message if happy_dir is missing or not pinned, else None."""
    if not os.path.isdir(happy_dir):
        return (
            f"kicad-happy clone not found at {happy_dir}. "
            "Set KICAD_HAPPY_DIR or clone it there."
        )
    try:
        out = subprocess.run(
            ["git", "-C", happy_dir, "rev-parse", "HEAD"],
            capture_output=True,
            text=True,
            check=True,
        ).stdout.strip()
    except (subprocess.CalledProcessError, OSError) as exc:
        return f"kicad-happy at {happy_dir} is not a git repository: {exc}"
    if not out.startswith(PINNED_COMMIT):
        return (
            f"kicad-happy at {happy_dir} is at commit {out[:12]}, "
            f"not the pinned commit {PINNED_COMMIT}."
        )
    return None


def resolve_board(board_dir_or_pcb):
    """Return (pcb_path, sch_path) for a .kicad_pcb file or a board directory.

    sch_path is None when no single .kicad_sch sits beside the board.
    """
    path = os.path.abspath(board_dir_or_pcb)
    if os.path.isfile(path) and path.endswith(".kicad_pcb"):
        pcb = path
        board_dir = os.path.dirname(path)
    elif os.path.isdir(path):
        board_dir = path
        pcbs = sorted(f for f in os.listdir(path) if f.endswith(".kicad_pcb"))
        if len(pcbs) != 1:
            raise ValueError(
                f"Expected exactly one .kicad_pcb in {path}, found {len(pcbs)}."
            )
        pcb = os.path.join(path, pcbs[0])
    else:
        raise ValueError(f"{board_dir_or_pcb} is not a .kicad_pcb file or a directory.")

    schs = sorted(f for f in os.listdir(board_dir) if f.endswith(".kicad_sch"))
    sch = os.path.join(board_dir, schs[0]) if len(schs) == 1 else None
    return pcb, sch


def run_analyzer(happy_dir, script_rel, script_args, out_path):
    """Run one pinned kicad-happy script and return its parsed JSON output."""
    script = os.path.join(happy_dir, script_rel)
    cmd = [sys.executable, script] + script_args + ["-o", out_path]
    proc = subprocess.run(cmd, capture_output=True, text=True)
    if not os.path.exists(out_path):
        raise RuntimeError(
            f"{script_rel} produced no output (exit {proc.returncode}): "
            f"{proc.stderr.strip()[:500]}"
        )
    with open(out_path) as fh:
        return json.load(fh)


def load_findings(doc):
    """Pure: pull the flat findings list out of one analyzer's JSON document."""
    if not isinstance(doc, dict):
        return []
    return doc.get("findings", []) or []


def filter_findings(findings, rule_ids, min_severity=None):
    """Pure: keep findings whose rule_id is allowed and severity clears the floor."""
    allowed = set(rule_ids)
    min_rank = SEVERITY_ORDER.index(min_severity) if min_severity else -1
    kept = []
    for f in findings:
        if f.get("rule_id") not in allowed:
            continue
        sev = f.get("severity", "info")
        rank = SEVERITY_ORDER.index(sev) if sev in SEVERITY_ORDER else 0
        if rank < min_rank:
            continue
        kept.append(f)
    return kept


def format_finding(f):
    """Pure: one report line for a kept finding."""
    msg = f.get("summary") or f.get("description") or ""
    return f"FAIL {f.get('rule_id')} {msg}"


def run_gate(happy_dir, pcb, sch, tmp_dir):
    """Run the three analyzers and return their merged raw findings."""
    all_findings = []
    sch_out = None
    if sch:
        sch_out = os.path.join(tmp_dir, "sch.json")
        sch_doc = run_analyzer(
            happy_dir, "skills/kicad/scripts/analyze_schematic.py", [sch], sch_out
        )
        all_findings += load_findings(sch_doc)

    pcb_out = os.path.join(tmp_dir, "pcb.json")
    pcb_args = [pcb, "--full"]
    if sch_out:
        pcb_args += ["--schematic", sch_out]
    pcb_doc = run_analyzer(happy_dir, "skills/kicad/scripts/analyze_pcb.py", pcb_args, pcb_out)
    all_findings += load_findings(pcb_doc)

    emc_out = os.path.join(tmp_dir, "emc.json")
    emc_args = ["--pcb", pcb_out]
    if sch_out:
        emc_args += ["--schematic", sch_out]
    emc_doc = run_analyzer(happy_dir, "skills/emc/scripts/analyze_emc.py", emc_args, emc_out)
    all_findings += load_findings(emc_doc)

    return all_findings


def main(argv=None):
    parser = argparse.ArgumentParser(
        description="Gate a KiCad board on a fixed set of pinned kicad-happy rule IDs."
    )
    parser.add_argument("board", help="Path to a .kicad_pcb file or a board directory")
    parser.add_argument(
        "--rules",
        default=",".join(DEFAULT_RULES),
        help="Comma-separated rule IDs to gate on (default: %(default)s)",
    )
    parser.add_argument(
        "--min-severity",
        choices=SEVERITY_ORDER,
        default=None,
        help="Drop findings below this severity (default: keep all severities)",
    )
    args = parser.parse_args(argv)

    happy_dir = resolve_happy_dir()
    err = check_pinned(happy_dir)
    if err:
        print(f"ERROR: {err}", file=sys.stderr)
        return 2

    try:
        pcb, sch = resolve_board(args.board)
    except ValueError as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 2

    rule_ids = [r.strip() for r in args.rules.split(",") if r.strip()]

    tmp_dir = tempfile.mkdtemp(prefix="kicad_happy_gate_")
    try:
        all_findings = run_gate(happy_dir, pcb, sch, tmp_dir)
    except (RuntimeError, json.JSONDecodeError) as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 2
    finally:
        shutil.rmtree(tmp_dir, ignore_errors=True)

    kept = filter_findings(all_findings, rule_ids, args.min_severity)
    for f in kept:
        print(format_finding(f))
    print(f"{len(kept)} kicad-happy findings (rules {','.join(rule_ids)})")
    return 1 if kept else 0


if __name__ == "__main__":
    sys.exit(main())
