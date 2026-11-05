# Route coverage in Rust

The native thermal receipts of old routing records. Fastroute, which wrote the
hole, project and DSN proofs, was removed on 2026-11-05; those proofs went with it.
`tools/lib/outcome-thermal.ts` calls this binary to revalidate sealed placement
outcomes, so old records stay checkable. Nothing writes new receipts: a receipt
needs `ZONE_FILLER.Fill`'s result, which only pcbnew reports.

Build with `cargo build --locked --manifest-path tools/route-coverage/Cargo.toml -j 2`.
The `route-coverage` binary accepts an operation and a JSON request file (or
stdin), and prints JSON. Operations: `admit`, `validate-capability`, `discharge`.
