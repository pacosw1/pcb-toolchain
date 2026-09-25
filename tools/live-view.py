#!/usr/bin/env python3
"""Live view of a KiCad board or schematic in a Ghostty/kitty terminal pane.

Usage: python3 tools/live-view.py FILE [--mode pcb2d|pcb3d|sch] [--width PX]

It checks the file modification time once per second. When the file changes, it
exports a PNG with kicad-cli and draws it with the kitty graphics protocol.
Run it in a split pane next to Claude Code. Stop it with Ctrl-C.
"""
import argparse, base64, os, shutil, subprocess, sys, tempfile, time

KICAD_CLI = shutil.which("kicad-cli") or "/Applications/KiCad/KiCad.app/Contents/MacOS/kicad-cli"
PCB_LAYERS = "Edge.Cuts,F.Cu,B.Cu,F.Silkscreen,F.Courtyard"


def svg_to_png(svg, out_dir, width):
    # macOS Quick Look converts SVG to PNG with no extra install.
    subprocess.run(["qlmanage", "-t", "-s", str(width), "-o", out_dir, svg],
                   check=True, capture_output=True)
    return os.path.join(out_dir, os.path.basename(svg) + ".png")


def export(path, mode, out_dir, width):
    if mode == "pcb3d":
        png = os.path.join(out_dir, "view.png")
        subprocess.run([KICAD_CLI, "pcb", "render", path, "-o", png, "--side", "top",
                        "--width", str(width), "--height", str(int(width * 0.75)),
                        "--quality", "basic"], check=True, capture_output=True)
        return png
    if mode == "pcb2d":
        svg = os.path.join(out_dir, "view.svg")
        subprocess.run([KICAD_CLI, "pcb", "export", "svg", path, "-o", svg, "--layers", PCB_LAYERS,
                        "--mode-single", "--fit-page-to-board", "--exclude-drawing-sheet"],
                       check=True, capture_output=True)
        return svg_to_png(svg, out_dir, width)
    subprocess.run([KICAD_CLI, "sch", "export", "svg", path, "-o", out_dir, "--exclude-drawing-sheet"],
                   check=True, capture_output=True)
    svg = os.path.join(out_dir, os.path.splitext(os.path.basename(path))[0] + ".svg")
    return svg_to_png(svg, out_dir, width)


def draw(png):
    data = base64.standard_b64encode(open(png, "rb").read())
    out = sys.stdout.buffer
    out.write(b"\x1b[2J\x1b[H\x1b_Ga=d\x1b\\")  # clear the screen and old images
    for i in range(0, len(data), 4096):
        chunk = data[i:i + 4096]
        more = 1 if i + 4096 < len(data) else 0
        head = f"a=T,f=100,m={more}" if i == 0 else f"m={more}"
        out.write(b"\x1b_G" + head.encode() + b";" + chunk + b"\x1b\\")
    out.flush()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("file")
    ap.add_argument("--mode", choices=["pcb2d", "pcb3d", "sch"])
    ap.add_argument("--width", type=int, default=1400)
    a = ap.parse_args()
    mode = a.mode or ("sch" if a.file.endswith(".kicad_sch") else "pcb2d")
    out_dir = tempfile.mkdtemp(prefix="live-view-")
    last = None
    while True:
        try:
            m = os.stat(a.file).st_mtime
            if m != last:
                last = m
                time.sleep(0.5)  # let the writer finish the save
                draw(export(a.file, mode, out_dir, a.width))
                print(f"\n{os.path.basename(a.file)}  {mode}  {time.strftime('%H:%M:%S')}", flush=True)
        except subprocess.CalledProcessError as e:
            print(f"export failed: {e.stderr.decode(errors='replace')[:300]}", flush=True)
        except KeyboardInterrupt:
            return
        time.sleep(1)


if __name__ == "__main__":
    main()
