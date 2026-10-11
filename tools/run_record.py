#!/usr/bin/env python3
"""One run record per routing job (W5, CIP #805): OUTDIR/run.jsonl, one JSON line per action; standard library only.

Record: {"t": ISO time, "elapsed_s": seconds since the job start (null when unknown), "stage": job stage,
         "action": what was done, "inputs": what it used, "evidence": file or line it can be checked against,
         "result": what came out, "why": the reason in one sentence}

Writers (append): tools/lean_workflow.run_stage (one record per stage end, next to stages.jsonl),
tools/fastroute_job.py (the configuration and feature flags at start, each routing_rules stage decision: keepout,
lock, via cost, escape belt, hot loop), and sync() at job end. sync(OUTDIR) derives the records that no live writer
owns from the files the job already writes, without duplicates: progress.jsonl (stage start/end), run.log (the
router's pass lines: pass, open, violations, rip-ups; checkpoints; stop; skipped items; diagnosis), report.json
(the router's end-of-run reason per failed connection), open-triage.json (the triage), outcome.json and stall.json
(the STUCK/complete exit). So `python3 tools/run_record.py OUTDIR` (or tools/route_status.py --log OUTDIR) prints
the complete action log in order, with the why of each action, for a running job or a finished one.
"""
import datetime as dt
import json
import os
import re
import sys
import time

FILE = 'run.jsonl'
KEYS = ('t', 'elapsed_s', 'stage', 'action', 'inputs', 'evidence', 'result', 'why')
_RUN = {}   # outdir -> t0 (set by start(); the live writers use it for elapsed_s)

PASS = re.compile(r'^\s*([\d.]+)\s+\w+\s+Auto-routing pass #(\d+) was completed in ([\d.]+) seconds with score ([\d.]+) '
                  r'\((\d+) unrouted and (\d+) violations?\)(?: \(routed (\d+), failed (\d+), ripped (\d+)\))?')
CHECKPOINT = re.compile(r'^\s*([\d.]+)\s+\w+\s+checkpoint: best board so far \((\d+) unrouted, (\d+) violations?\) written to \'([^\']+)\'')
STOP = re.compile(r'^\s*([\d.]+)\s+\w+\s+stop requested: (.*)')
STAGE_DONE = re.compile(r'^\s*([\d.]+)\s+\w+\s+Auto-routing stage completed: started with (\d+) unrouted nets, completed in ([\d.]+) seconds, '
                        r'final score: ([\d.]+) \((\d+) unrouted and (\d+) violations?\)')
SKIPPED = re.compile(r'^\s*([\d.]+)\s+\w+\s+(\d+) item\(s\) cannot be routed even on the board as loaded \(([^)]*)\); they were skipped after their (\w+) failure')
DIAG = re.compile(r'^\s*([\d.]+)\s+\w+\s+diagnosis of (\d+) unrouted connections in ([\d.]+) s: (\d+) routable alone \(congestion\), '
                  r'(\d+) not routable on the loaded board \(blocked\), (\d+) in ignored net classes')
FANOUT = re.compile(r'^\s*([\d.]+)\s+\w+\s+Fanout stage completed: (\d+) passes, completed in ([\d.]+) seconds')


def path(outdir):
    return outdir if outdir.endswith('.jsonl') else os.path.join(outdir, FILE)


def start(outdir, t0=None):
    """Bind the job clock of OUTDIR (default: the t0 of progress.jsonl, else now) for the live writers."""
    _RUN[os.path.abspath(outdir)] = t0 if t0 is not None else _t0(outdir) or time.time()
    return _RUN[os.path.abspath(outdir)]


def _t0(outdir):
    p = os.path.join(outdir, 'progress.jsonl')
    try:
        first = open(p).readline()
        return float(json.loads(first)['t0'])
    except (OSError, ValueError, KeyError, TypeError):
        return None


def elapsed(outdir):
    t0 = _RUN.get(os.path.abspath(outdir)) or _t0(outdir)
    return round(time.time() - t0, 1) if t0 else None


def record(stage, action, inputs=None, evidence=None, result=None, why='', elapsed_s=None, t=None):
    """One record in key order; every key present."""
    return dict(t=t or dt.datetime.now().isoformat(timespec='seconds'), elapsed_s=elapsed_s, stage=stage, action=action,
                inputs=inputs, evidence=evidence, result=result, why=why)


def append(outdir, stage, action, inputs=None, evidence=None, result=None, why='', elapsed_s=None, t=None):
    """Append one record to OUTDIR/run.jsonl (elapsed_s from the job clock when not given); returns the record."""
    if elapsed_s is None and t is None:
        elapsed_s = elapsed(outdir)
    rec = record(stage, action, inputs, evidence, result, why, elapsed_s, t)
    with open(path(outdir), 'a') as f:
        f.write(json.dumps(rec) + '\n')
    return rec


def read(outdir):
    try:
        return [json.loads(l) for l in open(path(outdir)) if l.strip()]
    except OSError:
        return []


# ------------------------------------------------------------------ the router's log and report

def parse_log_line(line, offset=0.0):
    """One record for a Fastroute log line that is an action (pass, checkpoint, stop, stage end, skipped items,
    diagnosis, fanout), else None. offset: job elapsed_s at the router start (the log clock is router-relative)."""
    m = PASS.match(line)
    if m:
        t, n, s, score, open_, viol, routed, failed, ripped = m.groups()
        res = {'pass': int(n), 'open': int(open_), 'violations': int(viol), 'seconds': float(s), 'score': float(score)}
        if routed is not None:
            res.update(routed=int(routed), failed=int(failed), ripups=int(ripped))
        return record('route', 'pass', evidence=line.strip(), result=res, elapsed_s=round(offset + float(t), 1),
                      why=f'autorouter pass {n}: {open_} open, {viol} violations, {ripped or 0} rip-ups')
    m = CHECKPOINT.match(line)
    if m:
        t, open_, viol, ses = m.groups()
        return record('route', 'checkpoint', evidence=ses, result={'open': int(open_), 'violations': int(viol)},
                      elapsed_s=round(offset + float(t), 1), why='lowest open count so far: best board written')
    m = STOP.match(line)
    if m:
        return record('route', 'stop', evidence=line.strip(), result={'reason': m.group(2).strip()},
                      elapsed_s=round(offset + float(m.group(1)), 1), why='the job asked the router to stop (stall or deadline)')
    m = STAGE_DONE.match(line)
    if m:
        t, start_open, s, score, open_, viol = m.groups()
        return record('route', 'router end', evidence=line.strip(),
                      result={'open': int(open_), 'violations': int(viol), 'seconds': float(s), 'score': float(score), 'started_open': int(start_open)},
                      elapsed_s=round(offset + float(t), 1), why=f'autorouting stage over: {start_open} -> {open_} open')
    m = SKIPPED.match(line)
    if m:
        t, n, cause, nth = m.groups()
        return record('route', 'skip', evidence=line.strip(), result={'items': int(n)}, elapsed_s=round(offset + float(t), 1),
                      why=f'{n} items {cause}; skipped after their {nth} failure')
    m = DIAG.match(line)
    if m:
        t, n, s, cong, blocked, ign = m.groups()
        return record('route', 'diagnosis', evidence=line.strip(),
                      result={'open': int(n), 'congestion': int(cong), 'blocked': int(blocked), 'ignored': int(ign), 'seconds': float(s)},
                      elapsed_s=round(offset + float(t), 1),
                      why=f'{cong} open connections are routable alone (congestion), {blocked} are blocked on the loaded board')
    m = FANOUT.match(line)
    if m:
        t, n, s = m.groups()
        return record('route', 'fanout', evidence=line.strip(), result={'passes': int(n), 'seconds': float(s)},
                      elapsed_s=round(offset + float(t), 1), why='SMD fanout before autorouting')
    return None


def parse_log(text, offset=0.0):
    return [r for r in (parse_log_line(l, offset) for l in text.splitlines()) if r]


def reasons(report, elapsed_s=None):
    """One record per failed connection of a Fastroute report.json: the router's own reason (diagnosis class and the
    text of the connection routed alone)."""
    out = []
    for u in report.get('unrouted') or []:
        d = u.get('diagnosis') or {}
        alone = d.get('from_alone') or d.get('to_alone') or {}
        ends = {}
        for k in ('from', 'to'):
            e = u.get(k) or {}
            ends[k] = f"{e.get('component', '')}.{e.get('pin', '')}" if e.get('kind') == 'pin' else e.get('kind', '?')
        cls = d.get('class', 'unknown')
        why = {'blocked': 'no path exists on the loaded board (pins, keepouts or fixed wiring)',
               'congestion': 'routable alone; other copper took the space',
               'ignored': 'its net class is ignored'}.get(cls, 'the router gave no class')
        out.append(record('route', 'open', inputs={'net': u.get('net'), **ends, 'length_mm': u.get('length_mm')},
                          evidence='report.json unrouted[]',
                          result={'class': cls, 'router_text': alone.get('details', ''),
                                  'passes_failed': [c.get('pass') for c in d.get('in_context') or []]},
                          elapsed_s=elapsed_s, why=f'{cls}: {why}'))
    return out


# ------------------------------------------------------------------ derive from the job's files

def _load(outdir, name):
    try:
        return json.load(open(os.path.join(outdir, name)))
    except (OSError, ValueError):
        return None


def _rows(outdir, name):
    try:
        return [json.loads(l) for l in open(os.path.join(outdir, name)) if l.strip()]
    except (OSError, ValueError):
        return []


def _key(r):
    res = r.get('result') if isinstance(r.get('result'), dict) else {}
    inp = r.get('inputs') if isinstance(r.get('inputs'), dict) else {}
    return (r.get('stage'), r.get('action'), res.get('pass'), inp.get('net'), inp.get('from'), inp.get('to'),
            r.get('evidence') if r.get('action') in ('pass', 'checkpoint', 'stop', 'router end', 'skip', 'diagnosis', 'fanout') else None)


def derive(outdir):
    """All records that the job's files imply, in job order (no file is changed)."""
    out = []
    eff = _load(outdir, 'effective-configuration.json') or _load(outdir, 'input-manifest.json')
    if eff:
        feat = eff.get('features') or {}
        on = sorted(k for k, v in feat.items() if isinstance(v, dict) and v.get('on'))
        out.append(record('job', 'configure', inputs=eff.get('configuration'), evidence='effective-configuration.json',
                          result={'features_on': on, 'command': eff.get('command')}, elapsed_s=0.0,
                          why='the inputs and feature flags bound at the job start'))
    progress = _rows(outdir, 'progress.jsonl')
    route_t0 = None
    for p in progress:
        st = p.get('stage', '')
        if p.get('pass') is not None:
            continue
        if st.startswith('route') and st.endswith(' start') and route_t0 is None:
            route_t0 = p.get('elapsed_s') or 0.0
        out.append(record(st.split(' ')[0], st, evidence='progress.jsonl', elapsed_s=p.get('elapsed_s'), t=p.get('t'),
                          result={k: p.get(k) for k in ('open', 'best_open', 'vias', 'eta_s') if p.get(k) is not None} or None,
                          why='stage boundary of the job'))
    try:
        log = open(os.path.join(outdir, 'run.log'), errors='replace').read()
    except OSError:
        log = ''
    out += parse_log(log, route_t0 or 0.0)
    report = _load(outdir, 'report.json')
    if report:
        end = next((p.get('elapsed_s') for p in progress if p.get('stage', '').startswith('route') and p.get('stage', '').endswith(' end')), None)
        out += reasons(report, end)
    for s in _rows(outdir, 'stages.jsonl'):
        out.append(record(s.get('stage'), 'stage ' + str(s.get('status')), inputs={'command': s.get('command')}, evidence='stages.jsonl',
                          result={k: s.get(k) for k in ('returncode', 'wall_s', 'cause') if k in s},
                          why='owned subprocess stage of the job' if s.get('status') == 'complete' else f"stage {s.get('status')}: {s.get('cause')}"))
    tri = _load(outdir, 'open-triage.json')
    if tri:
        t_end = next((p.get('elapsed_s') for p in progress if p.get('stage') == 'triage end'), None)
        out.append(record('triage', 'triage', evidence='open-triage.json', elapsed_s=t_end,
                          result={k: tri.get(k) for k in ('open', 'enclosed', 'router_miss', 'unknown')},
                          why='each open signal connection classed as ENCLOSED (no legal path) or ROUTER_MISS'))
        for c in tri.get('connections') or []:
            out.append(record('triage', 'open', inputs={'net': c.get('net'), 'from': c.get('a'), 'to': c.get('b')}, evidence='open-triage.json',
                              result={'class': c.get('class'), 'blockers': c.get('blockers')}, elapsed_s=t_end,
                              why='no legal path on the clearance grid' if c.get('class') == 'ENCLOSED' else 'a path exists; the router missed it'))
    stall = _load(outdir, 'stall.json')
    if stall and stall.get('stopped'):
        out.append(record('route', 'stall stop', evidence='stall.json', result=stall,
                          elapsed_s=round(stall['seconds'] - (_t0(outdir) or stall['seconds']), 1) if stall.get('seconds') else None,
                          why=f"{stall.get('stall_passes')} passes without a lower open count: fail fast"))
    outcome = _load(outdir, 'outcome.json')
    if outcome:
        last = progress[-1].get('elapsed_s') if progress else None
        status = outcome.get('status')
        out.append(record('job', 'exit ' + str(status).upper(), evidence='outcome.json', elapsed_s=last,
                          result={k: outcome.get(k) for k in ('signal_open', 'ground_open', 'errors', 'returncode', 'qualified')},
                          why=outcome.get('note') or f'job {status}'))
    return out


def sync(outdir):
    """Append to run.jsonl every derived record that is not there yet; returns the number appended."""
    have = {_key(r) for r in read(outdir)}
    n = 0
    for r in derive(outdir):
        if _key(r) in have:
            continue
        have.add(_key(r))
        with open(path(outdir), 'a') as f:
            f.write(json.dumps(r) + '\n')
        n += 1
    return n


def ordered(records):
    """Records in job order: by elapsed_s where known, file order otherwise (stable)."""
    last = [0.0]
    def k(ir):
        i, r = ir
        e = r.get('elapsed_s')
        if e is None:
            e = last[0]
        else:
            last[0] = e
        return (e, i)
    return [r for _, r in sorted(enumerate(records), key=k)]


def fmt(r):
    e = r.get('elapsed_s')
    es = f'{e:7.1f}s' if isinstance(e, (int, float)) else '      -s'
    res = r.get('result')
    rs = ''
    if isinstance(res, dict):
        rs = ' '.join(f'{k}={v}' for k, v in res.items() if not isinstance(v, (dict, list)) and k != 'command')
    elif res is not None:
        rs = str(res)
    inp = r.get('inputs')
    ins = inp.get('net', '') if isinstance(inp, dict) else ''
    head = f"{es} {r.get('stage', '')}: {r.get('action', '')}"
    if ins:
        head += f' {ins}'
    return f"{head}  [{rs}]  -- {r.get('why', '')}" if rs else f"{head}  -- {r.get('why', '')}"


def log_lines(outdir, do_sync=True):
    if do_sync and os.path.isdir(outdir):
        sync(outdir)
    return [fmt(r) for r in ordered(read(outdir))]


def main(argv=None):
    import argparse
    ap = argparse.ArgumentParser(description='print the action log of a routing job (OUTDIR/run.jsonl)')
    ap.add_argument('outdir')
    ap.add_argument('--no-sync', action='store_true', help='print run.jsonl as is (no records derived from the other files)')
    a = ap.parse_args(argv)
    for l in log_lines(a.outdir, not a.no_sync):
        print(l)
    return 0


if __name__ == '__main__':
    sys.exit(main())
