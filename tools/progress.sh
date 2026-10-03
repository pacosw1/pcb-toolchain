#!/bin/zsh
# Interactive dashboard: tools/progress.sh --watch
ROOT=${0:A:h:h}
if (( ${@[(Ie)--watch]} || ${@[(Ie)--stage]} )); then
  python3 "$ROOT/tools/setup-progress.py" || exit $?
fi
GIT_DIR=$(git -C "$ROOT" rev-parse --absolute-git-dir)
PYTHON="$GIT_DIR/board-progress/venv/bin/python"
[[ -x "$PYTHON" ]] || PYTHON=python3
exec "$PYTHON" "$ROOT/tools/progress.py" "$@"
