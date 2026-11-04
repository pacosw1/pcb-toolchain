"""Import a router snapshot into an isolated visualization file. Run with KiCad Python."""
import sys
import pcbnew

board = pcbnew.LoadBoard(sys.argv[1])
if not pcbnew.ImportSpecctraSES(board, sys.argv[2]):
    raise SystemExit('Cannot import routing snapshot')
# Avoid showing obsolete filled copper underneath new candidate routes.
for zone in board.Zones():
    zone.UnFill()
pcbnew.SaveBoard(sys.argv[3], board)
