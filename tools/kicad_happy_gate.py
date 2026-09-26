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
      [--rules GP-001,RP-001,DC-002,UC-001] [--min-severity warning]
      [--exempt RULE:NET ...] [--exempt-file EXEMPT.json]

An exemption drops a finding when its rule matches and the finding names
that net. The file is a JSON list of {"rule", "net" or "ref", "reason"};
a "ref" entry drops findings of the rule that name that component. The
reason is required. An exemption that matches no finding is stale: it prints
"STALE exempt ..." and gives exit 2, so exemptions cannot rot.

Exit codes: 0 no matching findings, 1 one or more matching findings,
2 tool error (missing/unpinned clone, bad board path, analyzer crash,
bad or stale exemption).
"""
import argparse
import json
import os
import shutil
import subprocess
import sys
import tempfile

PINNED_COMMIT = "a6bba1a"
# VP-001 is left out: kicad-happy a6bba1a reads the KiCad 10 tenting format as untented.
# pcbtool.py viapads (with --allow for datasheet vias) is the via-in-pad gate.
DEFAULT_RULES = ["GP-001", "RP-001", "DC-002", "UC-001"]
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


def parse_exempt_args(items):
    """Pure: --exempt RULE:NET values to exemption entries."""
    out = []
    for item in items:
        rule, _, net = item.partition(":")
        if not rule.strip() or not net.strip():
            raise ValueError(f"--exempt {item!r}: use RULE:NET")
        out.append({"rule": rule.strip(), "net": net.strip(), "reason": "--exempt on the command line"})
    return out


def load_exempt_file(doc):
    """Pure: check the parsed JSON of an --exempt-file. Each entry needs rule, reason and one of net, ref."""
    if not isinstance(doc, list):
        raise ValueError("exempt file must be a JSON list")
    for i, e in enumerate(doc):
        if not isinstance(e, dict) or set(e) - {"rule", "net", "ref", "reason"}:
            raise ValueError(f"exempt entry {i}: use only the keys rule, net, ref, reason")
        if ("net" in e) == ("ref" in e):
            raise ValueError(f"exempt entry {i}: give exactly one of net, ref")
        for k in ("rule", "net" if "net" in e else "ref", "reason"):
            if not isinstance(e.get(k), str) or not e[k].strip():
                raise ValueError(f"exempt entry {i}: {k} is required")
    return doc


def finding_nets(f):
    """Pure: the net names that one finding names."""
    nets = list(f.get("nets") or [])
    if f.get("net"):
        nets.append(f["net"])
    return nets


def finding_refs(f):
    """Pure: the component references that one finding names."""
    refs = list(f.get("components") or [])
    if f.get("component"):
        refs.append(f["component"])
    return refs


def exempt_target(e):
    """Pure: the net or the ref that one exemption names."""
    return e["net"] if "net" in e else e["ref"]


def apply_exemptions(findings, exempts):
    """Pure: (kept findings, stale exemptions). A finding is dropped when an exemption has its rule
    and one of its nets (a net entry) or one of its components (a ref entry)."""
    def names(f, e):
        return e["net"] in finding_nets(f) if "net" in e else e["ref"] in finding_refs(f)

    used, kept = set(), []
    for f in findings:
        hits = [i for i, e in enumerate(exempts) if e["rule"] == f.get("rule_id") and names(f, e)]
        used.update(hits)
        if not hits:
            kept.append(f)
    return kept, [e for i, e in enumerate(exempts) if i not in used]


def evaluate(all_findings, rule_ids, min_severity, exempts):
    """Pure: (report lines, exit code) for the merged findings."""
    kept, stale = apply_exemptions(filter_findings(all_findings, rule_ids, min_severity), exempts)
    lines = [format_finding(f) for f in kept]
    lines += [f"STALE exempt {e['rule']} {exempt_target(e)}: no finding matched ({e['reason']})" for e in stale]
    lines.append(f"{len(kept)} kicad-happy findings (rules {','.join(rule_ids)})")
    return lines, 2 if stale else (1 if kept else 0)


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
    parser.add_argument(
        "--exempt",
        action="append",
        default=[],
        metavar="RULE:NET",
        help="Drop findings of RULE that name NET (repeatable)",
    )
    parser.add_argument(
        "--exempt-file",
        help='JSON list of {"rule", "net" or "ref", "reason"} exemptions',
    )
    args = parser.parse_args(argv)

    try:
        exempts = parse_exempt_args(args.exempt)
        if args.exempt_file:
            with open(args.exempt_file) as fh:
                exempts += load_exempt_file(json.load(fh))
    except (ValueError, OSError) as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 2

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

    lines, code = evaluate(all_findings, rule_ids, args.min_severity, exempts)
    for line in lines:
        print(line)
    return code


if __name__ == "__main__":
    sys.exit(main())
