"""Stateful PCB search. Algorithms propose; independent gates establish evidence."""

from .model import BoardState, Candidate, Finding, Outcome, RuleContext
from .policy import JobPolicy

__all__ = ['BoardState', 'Candidate', 'Finding', 'Outcome', 'RuleContext', 'JobPolicy']


def run_engine(*args, **kwargs):
    from .search import run_engine as run
    return run(*args, **kwargs)
