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
import math
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
    root_sch = os.path.splitext(pcb)[0] + ".kicad_sch"
    sch = root_sch if os.path.isfile(root_sch) else (
        os.path.join(board_dir, schs[0]) if len(schs) == 1 else None
    )
    return pcb, sch


def run_analyzer(happy_dir, script_rel, script_args, out_path):
    """Run one pinned kicad-happy script and return its parsed JSON output."""
    script = os.path.join(happy_dir, script_rel)
    cmd = [sys.executable, script] + script_args + ["-o", out_path]
    proc = subprocess.run(cmd, capture_output=True, text=True)
    if proc.returncode != 0:
        raise RuntimeError(f"{script_rel} failed (exit {proc.returncode}): {proc.stderr.strip()[:500]}")
    if not os.path.exists(out_path):
        raise RuntimeError(
            f"{script_rel} produced no output (exit {proc.returncode}): "
            f"{proc.stderr.strip()[:500]}"
        )
    with open(out_path) as fh:
        doc = json.load(fh)
    if (not isinstance(doc, dict) or doc.get("error") or doc.get("errors")
            or not isinstance(doc.get("findings"), list)
            or any(not isinstance(f, dict) for f in doc["findings"])):
        raise RuntimeError(f"{script_rel} produced an incomplete or error report")
    return doc


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


def mark_ground_vias(pcb_doc, grounds):
    """Mark the vias of the named ground nets as GND in the analyze_pcb JSON.

    kicad-happy a6bba1a finds ground vias by net name only (GND, *GND, 0V), so RP-001 misses a
    domain ground such as FIELD_0V. A name in grounds that is not a board net is an error.
    Returns the number of vias marked."""
    names = {str(k): v for k, v in (pcb_doc.get("nets") or {}).items()}
    missing = set(grounds) - set(names.values())
    if missing:
        raise ValueError(f"--ground: no such net on the board: {sorted(missing)}")
    n = 0
    for via in (pcb_doc.get("vias") or {}).get("vias", []):
        if grounds and names.get(str(via.get("net"))) in grounds:
            via["net_name"] = "GND"
            n += 1
    return n


def take_exempt_transitions(pcb_doc, nets):
    """Take the layer transitions of the RP-001-exempt nets out of the analyze_pcb JSON.

    kicad-happy a6bba1a stops RP-001 after 20 nets, so a board with more flagged nets hides the rest.
    For each exempt net with a via that has no ground via within 1.0 mm (the kicad-happy radius for
    dielectrics up to 0.5 mm), the transition is removed and an RP-001 finding is returned for it, so the
    exemption still matches. A stitched exempt net stays in the input: its exemption goes stale.
    Ground vias: net_name GND (mark_ground_vias) or a net named GND, *GND or 0V, as kicad-happy."""
    if not nets:
        return []
    names = {str(k): v for k, v in (pcb_doc.get("nets") or {}).items()}
    def is_gnd(v):
        n = v.get("net_name") or names.get(str(v.get("net")), "")
        return n.upper().endswith("GND") or n.upper() == "0V"
    gnd = [(v.get("x", 0), v.get("y", 0)) for v in (pcb_doc.get("vias") or {}).get("vias", []) if is_gnd(v)]
    keep, found = [], []
    for t in pcb_doc.get("layer_transitions", []):
        open_vias = [q for q in t.get("via_positions", [])
                     if not any(math.dist((q.get("x", 0), q.get("y", 0)), g) <= 1.0 for g in gnd)]
        if t.get("net") in nets and open_vias:
            found.append({"rule_id": "RP-001", "severity": "warning", "nets": [t["net"]],
                          "title": f"Missing stitching via at layer transition: {t['net']} (checked by the gate)"})
        else:
            keep.append(t)
    pcb_doc["layer_transitions"] = keep
    return found


def _pad_distance(p, x, y):
    """Distance from (x, y) to the copper of a pad: circle, oval (capsule) or rectangle."""
    a = math.radians(p.get("angle") or 0)
    dx, dy = x - p["abs_x"], y - p["abs_y"]
    lx, ly = dx * math.cos(a) - dy * math.sin(a), dx * math.sin(a) + dy * math.cos(a)
    hw, hh = p.get("width", 0) / 2.0, p.get("height", 0) / 2.0
    if p.get("shape") in ("circle", "oval"):
        r = min(hw, hh)
        return math.hypot(max(abs(lx) - (hw - r), 0), max(abs(ly) - (hh - r), 0)) - r
    return math.hypot(max(abs(lx) - hw, 0), max(abs(ly) - hh, 0))


def credit_own_holes(pcb_doc, samples, pads):
    """GP-001: count a missed sample inside the antipad of its own net's hole as covered.

    kicad-happy a6bba1a credits the antipad of a via (KH-392) but not of a through-hole pad, so a track
    that ends in its own TH pad (a battery clip, a connector pin) reads as a plane gap. A missed sample
    is covered when it is within the clearance of a TH pad or via of the same net. The clearance is the
    largest zone clearance or the net class clearance of the net, whichever is larger. A miss at the hole
    of another net or in a plane void stays a gap. samples are the analyze_pcb --gp001-debug samples;
    pads are extract_footprints() pads. The return_path_continuity entries are updated in place
    (removed at 95 % or more, as kicad-happy). Returns [(net, old_pct, new_pct)] for each changed net."""
    names = {str(k): v for k, v in (pcb_doc.get("nets") or {}).items()}
    zone_c = max([z.get("clearance") or 0 for z in pcb_doc.get("zones") or []] + [0.2])
    class_c, default_c = {}, 0.0
    for nc in pcb_doc.get("net_classes") or []:
        if nc.get("name") == "Default":
            default_c = nc.get("clearance") or 0
        for n in nc.get("nets") or []:
            class_c[n] = nc.get("clearance") or 0
    holes = {}
    for p in pads:
        if p.get("type") == "thru_hole" and p.get("net_name"):
            holes.setdefault(p["net_name"], []).append(p)
    for v in (pcb_doc.get("vias") or {}).get("vias", []):
        n = v.get("net_name") or names.get(str(v.get("net")), "")
        holes.setdefault(n, []).append({"shape": "circle", "abs_x": v["x"], "abs_y": v["y"],
                                        "width": v.get("size", 0), "height": v.get("size", 0)})
    changed, keep = [], []
    for e in pcb_doc.get("return_path_continuity") or []:
        net = e.get("net")
        c = max(zone_c, class_c.get(net, default_c))
        own = [s for s in samples if s.get("net") == net]
        gaps = [s for s in own if not s.get("hit")
                and not any(_pad_distance(h, s["x"], s["y"]) <= c + 1e-9 for h in holes.get(net, []))]
        if not own or len(gaps) == len(own) - e.get("samples_with_reference_plane", 0):
            keep.append(e)
            continue
        pct = round((1 - len(gaps) / len(own)) * 100, 1)
        changed.append((net, e.get("reference_plane_coverage_pct"), pct))
        if pct < 95:
            e.update(samples_with_reference_plane=len(own) - len(gaps), reference_plane_coverage_pct=pct)
            keep.append(e)
    pcb_doc["return_path_continuity"] = keep
    return changed


def load_pads(happy_dir, pcb):
    """Return the pads of all footprints (absolute position, size, type, net), parsed by the pinned
    kicad-happy clone, so the pad geometry agrees with its analysis."""
    scripts = os.path.join(happy_dir, "skills", "kicad", "scripts")
    sys.path.insert(0, scripts)
    try:
        import sexp_parser
        import analyze_pcb
        fps = analyze_pcb.extract_footprints(sexp_parser.parse_file(pcb))
    finally:
        sys.path.remove(scripts)
    return [p for f in fps for p in f.get("pads", [])]


def run_gate(happy_dir, pcb, sch, tmp_dir, grounds=(), exempt_rp_nets=()):
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
    # --gp001-debug writes gp001_debug.json next to the board, so analyze_pcb reads a copy in tmp_dir.
    board_dir = os.path.join(tmp_dir, "board")
    os.makedirs(board_dir)
    stem = os.path.splitext(pcb)[0]
    for ext in (".kicad_pcb", ".kicad_pro", ".kicad_dru"):
        if os.path.exists(stem + ext):
            shutil.copy(stem + ext, board_dir)
    pcb_copy = os.path.join(board_dir, os.path.basename(pcb))
    pcb_args = [pcb_copy, "--full", "--gp001-debug"]
    if sch_out:
        pcb_args += ["--schematic", sch_out]
    pcb_doc = run_analyzer(happy_dir, "skills/kicad/scripts/analyze_pcb.py", pcb_args, pcb_out)
    all_findings += load_findings(pcb_doc)
    if grounds:
        mark_ground_vias(pcb_doc, grounds)
    all_findings += take_exempt_transitions(pcb_doc, set(exempt_rp_nets))
    debug_path = os.path.join(board_dir, "gp001_debug.json")
    if not os.path.exists(debug_path):
        raise RuntimeError("analyze_pcb.py --gp001-debug wrote no gp001_debug.json")
    with open(debug_path) as fh:
        samples = json.load(fh).get("samples", [])
    for net, old, new in credit_own_holes(pcb_doc, samples, load_pads(happy_dir, pcb)):
        print(f"GP-001 own-hole antipad credit: {net} {old}% -> {new}%", file=sys.stderr)
    with open(pcb_out, "w") as fh:
        json.dump(pcb_doc, fh)

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
    parser.add_argument("--result", help="Write a completion report only after every analyzer succeeds")
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
    parser.add_argument(
        "--ground",
        action="append",
        default=[],
        metavar="NET",
        help="Count the vias of NET as ground vias for RP-001 (repeatable; for FIELD_0V and similar)",
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
        rp_nets = {e["net"] for e in exempts if e.get("rule") == "RP-001" and e.get("net")}
        all_findings = run_gate(happy_dir, pcb, sch, tmp_dir, args.ground, rp_nets)
    except (RuntimeError, ValueError, OSError) as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 2
    finally:
        shutil.rmtree(tmp_dir, ignore_errors=True)

    lines, code = evaluate(all_findings, rule_ids, args.min_severity, exempts)
    if args.result:
        kept, stale = apply_exemptions(filter_findings(all_findings, rule_ids, args.min_severity), exempts)
        with open(args.result, "w") as fh:
            json.dump({"schema_version": 1, "completed": True, "findings": len(kept),
                       "stale_exemptions": len(stale), "exit": code}, fh)
    for line in lines:
        print(line)
    return code


if __name__ == "__main__":
    sys.exit(main())
