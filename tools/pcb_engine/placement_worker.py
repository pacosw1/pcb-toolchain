"""Native Python scorer entrypoint: keep NumPy out of the CLI interpreter."""
import json
from pathlib import Path
import sys

from .backends import move_proposals
from .model import Finding
from .policy import JobPolicy
from .session import atomic_json


def main(argv=None):
    request, output = (argv or sys.argv[1:])
    value = json.loads(Path(request).read_text())
    policy = JobPolicy.parse(value['policy'], max(value['timeout_s'], value['policy']['routing']['timeout_s']))
    proposals = move_proposals(value['raw'], [Finding(**row) for row in value['findings']], policy)
    atomic_json(output, proposals)
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
