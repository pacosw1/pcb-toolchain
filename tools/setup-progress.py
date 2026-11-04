#!/usr/bin/env python3
"""Install the isolated, pinned TUI runtime outside tracked project files."""
import subprocess
import sys
import venv
from pathlib import Path
import progress

directory = progress.state_dir() / 'venv'
python = directory / 'bin/python'
if not python.exists():
    print('Preparing the Textual dashboard runtime...', flush=True)
    venv.EnvBuilder(with_pip=True).create(directory)
check = subprocess.run([str(python), '-c', 'import textual, textual_image, moderngl, trimesh; from importlib.metadata import version; assert textual.__version__ == "8.2.8"; assert version("textual-image") == "0.14.1"'], capture_output=True)
if check.returncode:
    subprocess.run([str(python), '-m', 'pip', 'install', 'textual==8.2.8', 'textual-image==0.14.1', 'moderngl==5.12.0', 'trimesh==5.1.0'], check=True)
print(str(python))
