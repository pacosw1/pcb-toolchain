"""Private owned-stage bootstrap: never execute work before broker release."""
import fcntl
import json
import os
import sys


def main():
    release = int(sys.argv[1])
    errors = int(sys.argv[2])
    os.set_inheritable(errors,False)
    mappings = json.loads(sys.argv[3])
    command = sys.argv[4:]
    try:
        approved = os.read(release, 1) == b'G'
    finally:
        os.close(release)
    if not approved:
        return 125
    # SCM_RIGHTS changes descriptor numbers. Preserve explicitly passed caller
    # numbers without overwriting another source in a cycle.
    lower = max([63,release,errors]+[fd for pair in mappings for fd in pair])+1
    protected = fcntl.fcntl(errors,fcntl.F_DUPFD,lower)
    os.close(errors)
    errors=protected
    os.set_inheritable(errors,False)
    lower=protected+1
    copies = [(target, fcntl.fcntl(source, fcntl.F_DUPFD, lower)) for target, source in mappings]
    for target, copied in copies:
        os.dup2(copied, target, inheritable=True)
    for _, copied in copies:
        os.close(copied)
    targets = {target for target, _ in mappings}
    for _, source in mappings:
        if source not in targets:
            os.close(source)
    try:
        os.execvpe(command[0], command, os.environ)
    except OSError as error:
        os.write(errors,json.dumps(dict(type=type(error).__name__,message=str(error))).encode()[:4096])
        return 127


if __name__ == '__main__':
    sys.exit(main())
