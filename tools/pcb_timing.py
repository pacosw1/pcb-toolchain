"""Measured workflow boundaries. Overlapping stages are never added as wall time."""
import argparse
import contextlib
import datetime as dt
import json
import math
from pathlib import Path
import subprocess
import time
import uuid


CATEGORIES = ('startup', 'snapshot', 'preflight', 'kicad', 'export', 'validation', 'operation', 'cleanup', 'sealing', 'queue')


def number(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def timestamp(value):
    if number(value):
        return value
    if isinstance(value, str):
        try:
            parsed = dt.datetime.fromisoformat(value.replace('Z', '+00:00'))
            return parsed.timestamp() if parsed.tzinfo else None
        except ValueError:
            pass
    return None


def stage_category(stage):
    if stage in ('erc', 'drc'):
        return 'kicad'
    if stage.startswith('snapshot'):
        return 'snapshot'
    if stage in ('export', 'candidate-fab', 'fab-zip'):
        return 'export'
    if stage in ('preflight', 'gerber-runtime') or stage.startswith('probe:'):
        return 'preflight'
    if stage.startswith(('validate', 'board-semantic')):
        return 'validation'
    return 'operation'


class MeasuredSpan:
    """Start/end are sampled in the producing process; duration uses its clock."""
    def __init__(self, stage, category=None, producer='supervisor'):
        self.started_unix_s = time.time()
        self.started = time.monotonic()
        self.fields = dict(span_id=uuid.uuid4().hex, stage=stage,
                           category=category or stage_category(stage), producer=producer,
                           started_unix_s=self.started_unix_s)

    def end(self, status='passed', **data):
        duration = time.monotonic() - self.started
        return dict(self.fields, ended_unix_s=time.time(), duration_s=duration,
                    duration_source='producer_monotonic', status=status, **data)


@contextlib.contextmanager
def measured_stage(emit, stage, category=None, producer='operations'):
    span = MeasuredSpan(stage, category, producer)
    emit('stage.start', **span.fields)
    try:
        yield span
    except BaseException:
        emit('stage.end', **span.end('error'))
        raise
    else:
        emit('stage.end', **span.end())


def union_seconds(intervals):
    """Union of actual wall-clock boundaries; None means no usable intervals."""
    intervals = sorted((start, end) for start, end in intervals
                       if number(start) and number(end) and end >= start)
    if not intervals:
        return None
    total, left, right = 0.0, *intervals[0]
    for start, end in intervals[1:]:
        if start > right:
            total += right - left
            left, right = start, end
        else:
            right = max(right, end)
    return round(total + right - left, 6)


def live_stages(stages, now=None):
    now = time.time() if now is None else now
    rows = []
    for stage in stages:
        row = dict(stage)
        start, activity = row.get('started_unix_s'), row.get('last_activity_unix_s')
        row['elapsed_s'] = round(now - start, 3) if number(start) and now >= start else None
        row['last_activity_age_s'] = round(now - activity, 3) if number(activity) and now >= activity else None
        rows.append(row)
    return rows


class Timeline:
    STARTS = {'tool.start': 'tool', 'stage.start': 'stage'}
    ENDS = {'tool.exit': 'tool', 'stage.end': 'stage'}

    def __init__(self, submitted_at=None):
        self.submitted = timestamp(submitted_at)
        self.supervisor_started = None
        self.active = {}
        self.closed = {}
        self.issues = []

    def observe(self, row):
        kind = row.get('type')
        at = timestamp(row.get('source_time'))
        if at is None:
            at = timestamp(row.get('time'))
        if kind == 'run.start' and self.supervisor_started is None:
            self.supervisor_started = at
        family = self.STARTS.get(kind) or self.ENDS.get(kind)
        if family:
            stage = row.get('stage')
            if not isinstance(stage, str):
                return
            identity = row.get('span_id') or ':'.join((row.get('producer', 'legacy'), family, stage))
            if kind in self.STARTS:
                if identity in self.active or identity in self.closed:
                    self.issues.append('duplicate start: ' + identity)
                    return
                start = row.get('started_unix_s', at)
                self.active[identity] = dict(span_id=identity, stage=stage,
                    category=row.get('category', stage_category(stage)), started_unix_s=start,
                    last_activity_unix_s=at if at is not None else start)
            else:
                if identity in self.closed:
                    return  # Replayed producer events cannot inflate durations.
                span = self.active.pop(identity, None)
                if span is None:
                    self.issues.append('end without observed start: ' + identity)
                    span = dict(span_id=identity, stage=stage, category=row.get('category', stage_category(stage)),
                                started_unix_s=row.get('started_unix_s'))
                end, start = row.get('ended_unix_s', at), span.get('started_unix_s')
                duration = row.get('duration_s')
                source = row.get('duration_source', 'producer_monotonic') if number(duration) and duration >= 0 else None
                if source is None:
                    duration = end - start if number(start) and number(end) and end >= start else None
                    source = 'event_wall_clock' if duration is not None else 'unavailable'
                if number(start) and number(end) and end < start:
                    self.issues.append('wall clock moved backwards: ' + identity)
                span.update(ended_unix_s=end, duration_s=round(duration, 6) if duration is not None else None,
                            duration_source=source, status=row.get('status', 'passed' if row.get('code') == 0 else 'failed'))
                span.pop('last_activity_unix_s', None)
                self.closed[identity] = span
        elif kind in ('tool.output', 'stage.activity'):
            for identity, span in self.active.items():
                if (row.get('span_id') == identity or (not row.get('span_id') and row.get('stage') == span['stage'])) and at is not None:
                    span['last_activity_unix_s'] = at

    def summary(self, now=None, terminal=False):
        spans = list(self.closed.values())
        intervals = [(s.get('started_unix_s'), s.get('ended_unix_s')) for s in spans]
        categories = {name: dict(wall_s=union_seconds([(s.get('started_unix_s'), s.get('ended_unix_s'))
                       for s in spans if s['category'] == name]),
                       completed_spans=sum(s['category'] == name for s in spans))
                      for name in dict.fromkeys((*CATEGORIES, *(s['category'] for s in spans)))}
        startup = (self.supervisor_started - self.submitted if number(self.supervisor_started) and number(self.submitted)
                   and self.supervisor_started >= self.submitted else None)
        return dict(schema_version=1, supervisor_startup_s=round(startup, 6) if startup is not None else None,
                    supervisor_startup_clock='wall' if startup is not None else 'unavailable',
                    queue_wait_s=None, queue_reason='no queue admission boundary recorded',
                    busy_wall_s=union_seconds(intervals), categories=categories, spans=spans,
                    active_stages=[] if terminal else live_stages(self.active.values(), now),
                    incomplete_stages=list(self.active.values()) if terminal else [],
                    coverage='partial' if self.active or self.issues else 'recorded_boundaries' if spans else 'unavailable',
                    issues=list(self.issues), wall_accounting='union of boundaries; nested/concurrent stages are not added')


def from_events(rows, submitted_at=None, terminal=False):
    timeline = Timeline(submitted_at)
    for row in rows:
        timeline.observe(row)
    return timeline.summary(terminal=terminal)


def main(argv=None):
    parser = argparse.ArgumentParser(description='Run one measured workflow stage, preserving command output and exit status.')
    parser.add_argument('--events', type=Path, required=True)
    parser.add_argument('--stage', required=True)
    parser.add_argument('--category', default='operation')
    parser.add_argument('--producer', default='fabrication')
    parser.add_argument('command', nargs=argparse.REMAINDER)
    args = parser.parse_args(argv)
    command = args.command[1:] if args.command[:1] == ['--'] else args.command
    if not command:
        parser.error('a command is required')
    args.events.parent.mkdir(parents=True, exist_ok=True)
    def emit(kind, **data):
        with args.events.open('a') as stream:
            stream.write(json.dumps(dict(schema_version=1, time=dt.datetime.now(dt.timezone.utc).isoformat(), type=kind, **data)) + '\n')
    span = MeasuredSpan(args.stage, args.category, args.producer)
    emit('stage.start', **span.fields)
    try:
        result = subprocess.run(command, check=False)
    except BaseException:
        emit('stage.end', **span.end('error'))
        raise
    emit('stage.end', **span.end('passed' if result.returncode == 0 else 'failed', code=result.returncode))
    return result.returncode if result.returncode >= 0 else 128 - result.returncode


if __name__ == '__main__':
    raise SystemExit(main())
