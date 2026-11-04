#!/usr/bin/env python3
"""Copy the tools/ tree of this pcb-toolchain release into a project, read-only, ignored by git.

  python3 bin/toolchain_sync.py PROJECT [--no-exclude]

The project tracks only its own scripts in tools/ (board builders, fab scripts). The pinned release supplies the
rest. After this, PROJECT/tools/... holds both, at the same paths as before the split, so file-relative tool code and
gate provenance (tools/<path> + sha256) do not change.

- PROJECT/tools/.toolchain-version holds "<version> <sha>"; same stamp and all files present = nothing to do.
- PROJECT/tools/.toolchain-files lists the copied files; a new version first removes the old list.
- A project file at a toolchain path is an error, unless its content is identical (then it is left alone).
- Copies are read-only: change a tool in the pcb-toolchain repo and release it, not here.
- Unless --no-exclude, the copied paths go into the git common dir info/exclude (one marked block).
Prints one line: PASS/FAIL.
"""
import hashlib
import os
import shutil
import stat
import subprocess
import sys

BEGIN, END = '# pcb-toolchain begin (bin/toolchain_sync.py)', '# pcb-toolchain end'


def digest(path):
    with open(path, 'rb') as f:
        return hashlib.sha256(f.read()).hexdigest()


def release_files(bundle):
    tools = os.path.join(bundle, 'tools')
    out = []
    for folder, dirs, files in os.walk(tools):
        dirs[:] = sorted(d for d in dirs if d != '__pycache__')
        for name in sorted(files):
            if name.endswith('.pyc'):
                continue
            out.append(os.path.relpath(os.path.join(folder, name), tools))
    return out


def exclude(project, rels):
    try:
        common = subprocess.run(['git', '-C', project, 'rev-parse', '--git-common-dir'], capture_output=True,
                                text=True, check=True).stdout.strip()
    except (OSError, subprocess.CalledProcessError):
        return 'no git'
    path = os.path.join(project, common, 'info', 'exclude')
    os.makedirs(os.path.dirname(path), exist_ok=True)
    text = open(path).read() if os.path.exists(path) else ''
    if BEGIN in text and END in text:
        head, rest = text.split(BEGIN, 1)
        text = head + rest.split(END, 1)[1].lstrip('\n')
    block = [BEGIN, '/tools/.toolchain-version', '/tools/.toolchain-files'] + ['/tools/' + r for r in rels] + [END]
    with open(path, 'w') as f:
        f.write(text.rstrip('\n') + ('\n' if text.strip() else '') + '\n'.join(block) + '\n')
    return 'excluded'


def main(argv):
    args = [a for a in argv if not a.startswith('--')]
    if len(args) != 1:
        print('usage: toolchain_sync.py PROJECT [--no-exclude]', file=sys.stderr)
        return 2
    project = os.path.realpath(args[0])
    bundle = os.path.dirname(os.path.dirname(os.path.realpath(__file__)))
    stamp_text = open(os.path.join(bundle, 'VERSION')).read().strip()
    tools = os.path.join(project, 'tools')
    stamp = os.path.join(tools, '.toolchain-version')
    listing = os.path.join(tools, '.toolchain-files')
    rels = release_files(bundle)
    if (os.path.exists(stamp) and open(stamp).read().strip() == stamp_text
            and all(os.path.exists(os.path.join(tools, r)) for r in rels)):
        return 0
    old = open(listing).read().split('\n') if os.path.exists(listing) else []
    for r in filter(None, old):
        p = os.path.join(tools, r)
        if os.path.lexists(p):
            os.chmod(p, stat.S_IWUSR | stat.S_IRUSR)
            os.remove(p)
    copied, kept = [], 0
    for r in rels:
        src, dst = os.path.join(bundle, 'tools', r), os.path.join(tools, r)
        if os.path.lexists(dst):
            if os.path.isfile(dst) and digest(dst) == digest(src):
                kept += 1
                continue
            print(f'FAIL: toolchain_sync: project file tools/{r} differs from pcb-toolchain {stamp_text}; '
                  'move it to the pcb-toolchain repo or rename it', file=sys.stderr)
            return 1
        os.makedirs(os.path.dirname(dst), exist_ok=True)
        shutil.copy2(src, dst)
        mode = os.stat(src).st_mode
        os.chmod(dst, stat.S_IRUSR | stat.S_IRGRP | stat.S_IROTH |
                 ((stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH) if mode & stat.S_IXUSR else 0))
        copied.append(r)
    with open(listing, 'w') as f:
        f.write('\n'.join(copied) + '\n')
    with open(stamp, 'w') as f:
        f.write(stamp_text + '\n')
    how = 'not excluded' if '--no-exclude' in argv else exclude(project, copied)
    print(f'PASS: toolchain_sync: pcb-toolchain {stamp_text} -> {tools} ({len(copied)} copied, {kept} identical, {how})',
          file=sys.stderr)
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
