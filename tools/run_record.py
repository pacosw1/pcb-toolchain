#!/usr/bin/env python3
"""One run record per routing job (W5, CIP #805): OUTDIR/run.jsonl, one JSON line per action; standard library only.

Record: {"t": ISO time, "elapsed_s": seconds since the job start (null when unknown), "stage": job stage,
         "action": what was done, "inputs": what it used, "evidence": file or line it can be checked against,
         "result": what came out, "why": the reason in one sentence}

Writers (append): tools/lean_workflow.run_stage (one record per stage end, next to stages.jsonl),
tools/fastroute_job.py (the configuration and feature flags at start, each routing_rules stage decision: keepout,
lock, via cost, escape belt, hot loop), and sync() at job end. sync(OUTDIR) derives the records that no live writer
owns from the files the job already writes, without duplicates: progress.jsonl (stage start/end), every routing
stage's run{sfx}.log and optimize{sfx}.log (the router's pass lines: pass, open, violations, rip-ups; checkpoints;
stop; skipped items; diagnosis), report{sfx}.json (the router's end-of-run reason per failed connection) and
stall{sfx}.json, open-triage.json (the triage), outcome.json (the STUCK/complete exit). A routing stage is 'route' plus
the suffix fastroute_job.py gives its files ('' for the final stage, '-fast' for tag fast); each stage's router-relative
log clock is offset by that stage's own 'route{sfx} start' row (optimize{sfx}.log: its 'route{sfx} end' row, where
the optimizer starts), and its records carry the stage name and the attempt (count of its start rows).
JSONL files are read with read_jsonl: an incomplete last line (a write in progress) is skipped, the rows before it kept. So `python3 tools/run_record.py OUTDIR` (or tools/route_status.py --log OUTDIR) prints
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


def clock(outdir):
    """The job's t0 (start() binding, else progress.jsonl, else now)."""
    return _RUN.get(os.path.abspath(outdir)) or _t0(outdir) or time.time()


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


def read_jsonl(p):
    """The rows of a JSONL file; [] when it does not exist. An unparsable LAST line is an append in progress and is
    skipped (the rows before it are kept); an unparsable line before the last one is corruption: ValueError."""
    try:
        lines = [l for l in open(p, errors='replace').read().split('\n') if l.strip()]
    except OSError:
        return []
    out = []
    for i, l in enumerate(lines):
        try:
            out.append(json.loads(l))
        except ValueError as e:
            if i == len(lines) - 1:
                break
            raise ValueError(f'{p}: line {i + 1} is not JSON: {e}') from e
    return out


def read(outdir):
    return read_jsonl(path(outdir))


# ------------------------------------------------------------------ the router's log and report

def parse_log_line(line, offset=0.0, stage='route', inputs=None):
    """One record for a Fastroute log line that is an action (pass, checkpoint, stop, stage end, skipped items,
    diagnosis, fanout), else None. offset: job elapsed_s at the router start (the log clock is router-relative).
    stage: the routing stage that wrote the log; inputs: its identity (attempt, log file)."""
    r = _parse_log_line(line, offset)
    if r is not None:
        r['stage'] = stage
        if inputs:
            r['inputs'] = dict(inputs)
    return r


def _parse_log_line(line, offset):
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


def parse_log(text, offset=0.0, stage='route', inputs=None):
    return [r for r in (parse_log_line(l, offset, stage, inputs) for l in text.splitlines()) if r]


def reasons(report, elapsed_s=None, stage='route', evidence='report.json', attempt=None):
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
               'ignored': 'its net class is ignored'}.get(cls, 'the router gave no class; the cause is unknown')
        inp = {'net': u.get('net'), **ends, 'length_mm': u.get('length_mm')}
        if attempt is not None:
            inp['attempt'] = attempt
        out.append(record(stage, 'open', inputs=inp, evidence=f'{evidence} unrouted[]',
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
    return read_jsonl(os.path.join(outdir, name))


STAGE_FILE = re.compile(r'^(?:run|optimize|report|stall)(-[^/]+)?\.(?:log|json)$')


def _sfx(name):
    m = STAGE_FILE.match(name)
    return m.group(1) or '' if m else None


def route_stages(outdir, progress):
    """Every routing stage of the job with its own clock and files, in start order:
    [{'stage': 'route'+sfx, 'sfx', 'attempt': number of its start rows, 'start_s', 'end_s': elapsed_s of its LAST
    start/end rows (its files hold the last attempt: fastroute_job.py rewrites them), 'files': {kind: name}}].
    Stages come from the progress start rows and from the stage files on disk (a stage whose rows are missing still
    has its files read, with an unknown clock)."""
    st = {}
    for p in progress:
        name = p.get('stage') or ''
        m = re.match(r'^route(\S*) (start|end)$', name)
        if not m:
            continue
        s = st.setdefault(m.group(1), dict(attempt=0, start_s=None, end_s=None))
        if m.group(2) == 'start':
            s.update(attempt=s['attempt'] + 1, start_s=p.get('elapsed_s'), end_s=None)
        else:
            s['end_s'] = p.get('elapsed_s')
    try:
        names = sorted(os.listdir(outdir))
    except OSError:
        names = []
    for n in names:
        sfx = _sfx(n)
        if sfx is not None and not n.startswith('run.json'):
            st.setdefault(sfx, dict(attempt=None, start_s=None, end_s=None))
    out = []
    for sfx, s in st.items():
        files = {k: f'{k}{sfx}.{ext}' for k, ext in (('run', 'log'), ('optimize', 'log'), ('report', 'json'), ('stall', 'json'))
                 if os.path.isfile(os.path.join(outdir, f'{k}{sfx}.{ext}'))}
        out.append(dict(stage='route' + sfx, sfx=sfx, files=files, **s))
    out.sort(key=lambda s: (s['start_s'] is None, s['start_s'] or 0.0, s['sfx']))
    return out


def _text(outdir, name):
    try:
        return open(os.path.join(outdir, name), errors='replace').read()
    except OSError:
        return ''


def _key(r):
    res = r.get('result') if isinstance(r.get('result'), dict) else {}
    inp = r.get('inputs') if isinstance(r.get('inputs'), dict) else {}
    return (r.get('stage'), r.get('action'), res.get('pass'), inp.get('net'), inp.get('from'), inp.get('to'),
            r.get('evidence') if r.get('action') in ('pass', 'checkpoint', 'stop', 'router end', 'skip', 'diagnosis', 'fanout') else None)


TRIAGE_WHY = {'ENCLOSED': 'no legal path on the clearance grid', 'ROUTER_MISS': 'a path exists; the router missed it'}


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
    for p in progress:
        st = p.get('stage', '')
        if p.get('pass') is not None:
            continue
        out.append(record(st.split(' ')[0], st, evidence='progress.jsonl', elapsed_s=p.get('elapsed_s'), t=p.get('t'),
                          result={k: p.get(k) for k in ('open', 'best_open', 'vias', 'eta_s') if p.get(k) is not None} or None,
                          why='stage boundary of the job'))
    for s in route_stages(outdir, progress):
        stage, f = s['stage'], s['files']
        ident = {'attempt': s['attempt']}
        passes = []
        if 'run' in f:
            # an unknown clock (no start row) gives router-relative times; the record says so in its inputs
            passes = parse_log(_text(outdir, f['run']), s['start_s'] or 0.0, stage,
                               dict(ident, log=f['run'], clock='stage start' if s['start_s'] is not None else 'unknown'))
            out += passes
        if not any(r['action'] == 'pass' for r in passes):
            # no pass in the log (missing or cut): the live watcher's pass rows of this stage are the evidence
            for p in progress:
                if p.get('stage') == stage and p.get('pass') is not None:
                    out.append(record(stage, 'pass', inputs=dict(ident, log='progress.jsonl'), evidence='progress.jsonl',
                                      result={'pass': p.get('pass'), 'open': p.get('open')}, elapsed_s=p.get('elapsed_s'),
                                      t=p.get('t'), why=f"autorouter pass {p.get('pass')}: {p.get('open')} open (live watcher)"))
        if 'optimize' in f:
            out += parse_log(_text(outdir, f['optimize']), s['end_s'] or 0.0, 'optimize' + s['sfx'],
                             dict(ident, log=f['optimize'], clock='route end' if s['end_s'] is not None else 'unknown'))
        report = _load(outdir, f['report']) if 'report' in f else None
        if report:
            out += reasons(report, s['end_s'], stage, f['report'], s['attempt'])
        stall = _load(outdir, f['stall']) if 'stall' in f else None
        if stall and stall.get('stopped'):
            t0 = _t0(outdir)
            out.append(record(stage, 'stall stop', inputs=ident, evidence=f['stall'], result=stall,
                              elapsed_s=round(stall['seconds'] - t0, 1) if stall.get('seconds') and t0 else s['end_s'],
                              why=f"{stall.get('stall_passes')} passes without a lower open count: fail fast"))
    for s in _rows(outdir, 'stages.jsonl'):
        out.append(record(s.get('stage'), 'stage ' + str(s.get('status')), inputs={'command': s.get('command')}, evidence='stages.jsonl',
                          result={k: s.get(k) for k in ('returncode', 'wall_s', 'cause') if k in s},
                          why='owned subprocess stage of the job' if s.get('status') == 'complete' else f"stage {s.get('status')}: {s.get('cause')}"))
    tri = _load(outdir, 'open-triage.json')
    if tri:
        t_end = next((p.get('elapsed_s') for p in progress if p.get('stage') == 'triage end'), None)
        out.append(record('triage', 'triage', evidence='open-triage.json', elapsed_s=t_end,
                          result={k: tri.get(k) for k in ('open', 'enclosed', 'router_miss', 'unknown')},
                          why='each open signal connection classed as ENCLOSED (no legal path), ROUTER_MISS (a path exists) '
                              'or UNKNOWN (the cause is unknown)'))
        for c in tri.get('connections') or []:
            out.append(record('triage', 'open', inputs={'net': c.get('net'), 'from': c.get('a'), 'to': c.get('b')}, evidence='open-triage.json',
                              result={'class': c.get('class'), 'blockers': c.get('blockers')}, elapsed_s=t_end,
                              why=TRIAGE_WHY.get(c.get('class'), f"{c.get('class') or 'no class'}: the cause is unknown; "
                                                 'the triage did not establish whether a legal path exists')))
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


def view(outdir):
    """run.jsonl plus the derived records not in it yet, nothing written (the live web view reads this)."""
    rows = read(outdir)
    have = {_key(r) for r in rows}
    return rows + [r for r in derive(outdir) if _key(r) not in have]


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
