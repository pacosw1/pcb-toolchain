The five board pipelines export exploratory fabrication files. Each output directory
contains `EXPLORATORY`, including files generated directly by its `make-*-fab.sh`.
Gate and Gerber failures return nonzero while retaining exploratory output for review.
Producer output is redirected to the pipeline log so `tee` or `tail` cannot hide its
exit status. BASE-PWR-B's placement search may retain its best incomplete candidate;
that development behavior cannot qualify a release.

To validate an existing board without rebuilding or routing it:

```sh
sh tools/fab-workflow.sh BASE-PWR-B release
```

Supported boards: CELLULAR, AC-24V, ENV-SENSE, FIELD-24V-BUS, BASE-PWR-B.
The command runs board-specific checks and a fresh gate at all configured targets,
without ratchet waivers. A failure stops before export. Successful checks allow an
export into a temporary directory, followed by Gerber netcheck and a current-input
evidence check. Any failure removes the temporary candidate. Only full success
publishes a new `release-<UTC timestamp>` directory beside `fab`, with `VERIFIED`,
the gate evidence and renders. `FAB_RELEASE_OUT` selects another new destination;
an existing destination is never intentionally replaced. Existing exploratory
files and render reports are preserved by the release command.

`VERIFIED` means the automated fabrication checks passed for the recorded input
set. It does not establish G5/G6 completion, assembly availability, a qualified BOM,
measured behavior, or purchasing/upload/installation authorization. Review the
board packet and current stock evidence at the applicable release/order gate.
